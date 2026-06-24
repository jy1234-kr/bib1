// index.js — Cloudflare Workers Reverse Proxy (ESM)
// ──────────────────────────────────────────────────────────────

class AttributeRewriter {
  constructor(attr, workerBase, targetOrigin) {
    this.attr = attr;
    this.wb = workerBase;
    this.to = targetOrigin;
  }
  element(el) {
    const v = el.getAttribute(this.attr);
    if (
      !v ||
      v.startsWith('data:') ||
      v.startsWith('blob:') ||
      v.startsWith('javascript:') ||
      v.startsWith('#') ||
      v.startsWith('mailto:') ||
      v.startsWith(this.wb)
    ) {
      return;
    }
    el.setAttribute(this.attr, this.rewrite(v));
  }
  rewrite(u) {
    if (/^https?:\/\//i.test(u)) return this.wb + '/proxy/' + u;
    if (u.startsWith('//')) return this.wb + '/proxy/https:' + u;
    if (u.startsWith('/')) return this.wb + '/proxy/' + this.to + u;
    return this.wb + '/proxy/' + this.to + '/' + u;
  }
}

class HeadInjector {
  constructor(workerBase, targetOrigin) {
    this.wb = workerBase;
    this.to = targetOrigin;
    this.done = false;
  }
  element(el) {
    if (this.done) return;
    this.done = true;
    el.prepend(this.buildScript(), { html: true });
  }
  buildScript() {
    const proxyBase = `${this.wb}/proxy/`;
    return `<script data-proxy="1">
(function(){
  const proxyBase = ${JSON.stringify(proxyBase)};
  const baseUrl = ${JSON.stringify(this.to)};

  function rw(u) {
    if (!u || typeof u !== 'string') return u;
    if (
      u.startsWith(proxyBase) ||
      u.startsWith('data:') ||
      u.startsWith('blob:') ||
      u.startsWith('javascript:') ||
      u.startsWith('#') ||
      u.startsWith('mailto:')
    ) {
      return u;
    }
    try {
      const absUrl = new URL(u, baseUrl).href;
      return proxyBase + absUrl;
    } catch(e) {
      return u;
    }
  }

  // Intercept fetch
  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = rw(input);
    } else if (input instanceof URL) {
      input = rw(input.href);
    } else if (input instanceof Request) {
      const newUrl = rw(input.url);
      input = new Request(newUrl, input);
    }
    return _fetch.call(this, input, init);
  };

  // Intercept XMLHttpRequest
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    if (arguments.length >= 2) {
      arguments[1] = rw(arguments[1] + '');
    }
    return _open.apply(this, arguments);
  };

  // Intercept window.open
  const _wopen = window.open;
  window.open = function() {
    if (arguments.length >= 1 && typeof arguments[0] === 'string') {
      arguments[0] = rw(arguments[0]);
    }
    return _wopen.apply(this, arguments);
  };

  // Intercept History API
  const _push = history.pushState;
  const _repl = history.replaceState;
  function fixHistoryUrl(url) {
    if (!url || typeof url !== 'string') return url;
    try {
      const absUrl = new URL(url, baseUrl).href;
      return proxyBase + absUrl;
    } catch(e) {
      return url;
    }
  }
  history.pushState = function(s, t, u) { return _push.call(this, s, t, fixHistoryUrl(u)); };
  history.replaceState = function(s, t, u) { return _repl.call(this, s, t, fixHistoryUrl(u)); };
  
  // Disable ServiceWorker
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function() { return Promise.reject(); };
  }
})();
</script>`;
  }
}

class MetaCSPRemover {
  element(el) {
    const equiv = (el.getAttribute('http-equiv') || '').toLowerCase();
    if (equiv === 'content-security-policy') {
      el.remove();
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const workerBase = url.origin;
      const path = url.pathname;

      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return cors204();
      }

      if (path === '/favicon.ico') {
        return new Response(null, { status: 204 });
      }

      // Check if this is a proxy request
      if (path.startsWith('/proxy/')) {
        const targetUrl = url.pathname.substring('/proxy/'.length) + url.search + url.hash;
        if (!targetUrl) {
          return new Response('Target URL missing', { status: 400 });
        }
        return await proxyFetch(targetUrl, request, workerBase);
      }

      // Default fallback: if ASSETS binding exists, it will serve static files automatically.
      // Otherwise, return a message to run locally or configure assets.
      return new Response(
        `Nebula Proxy Worker: Running. To load UI, make sure to configure wrangler assets or deploy with a frontend build.`,
        {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }
      );
    } catch (err) {
      return new Response(`Worker error: ${err.stack || err.message}`, { status: 500 });
    }
  },
};

function cors204() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

async function proxyFetch(targetUrl, originalReq, workerBase) {
  const method = originalReq.method;
  const hasBody = !['GET', 'HEAD'].includes(method);
  const tgt = new URL(targetUrl);

  const h = new Headers(originalReq.headers);
  h.set('Host', tgt.host);
  h.set('Origin', tgt.origin);
  h.set('Referer', targetUrl);
  
  // Strip Cloudflare/Forwarding headers
  h.delete('cf-connecting-ip');
  h.delete('cf-ipcountry');
  h.delete('cf-ray');
  h.delete('cf-visitor');
  h.delete('x-forwarded-for');
  h.delete('x-forwarded-proto');

  let resp;
  try {
    resp = await fetch(targetUrl, {
      method,
      headers: h,
      body: hasBody ? originalReq.body : undefined,
      redirect: 'follow',
    });
  } catch (fetchErr) {
    return new Response(`Fetch failed: ${fetchErr.message}`, { status: 502 });
  }

  const rh = new Headers(resp.headers);
  rh.set('Access-Control-Allow-Origin', '*');
  rh.set('Access-Control-Expose-Headers', '*');
  rh.delete('Content-Security-Policy');
  rh.delete('Content-Security-Policy-Report-Only');
  rh.delete('X-Frame-Options');
  rh.delete('Strict-Transport-Security');
  rh.delete('Cross-Origin-Opener-Policy');
  rh.delete('Cross-Origin-Embedder-Policy');
  rh.delete('Cross-Origin-Resource-Policy');
  rh.delete('Permissions-Policy');

  const ct = rh.get('content-type') || '';
  if (ct.includes('text/html')) {
    const origin = tgt.origin;
    const rw = new HTMLRewriter()
      .on('head', new HeadInjector(workerBase, origin))
      .on('meta', new MetaCSPRemover())
      .on('a[href]', new AttributeRewriter('href', workerBase, origin))
      .on('img[src]', new AttributeRewriter('src', workerBase, origin))
      .on('img[srcset]', {
        element(el) {
          const ss = el.getAttribute('srcset');
          if (ss) {
            const rewritten = ss.replace(/(https?:\/\/[^\s,]+)/g, workerBase + '/proxy/$1');
            el.setAttribute('srcset', rewritten);
          }
        },
      })
      .on('link[href]', new AttributeRewriter('href', workerBase, origin))
      .on('script[src]', new AttributeRewriter('src', workerBase, origin))
      .on('form[action]', new AttributeRewriter('action', workerBase, origin))
      .on('video[src]', new AttributeRewriter('src', workerBase, origin))
      .on('video[poster]', new AttributeRewriter('poster', workerBase, origin))
      .on('audio[src]', new AttributeRewriter('src', workerBase, origin))
      .on('source[src]', new AttributeRewriter('src', workerBase, origin))
      .on('source[srcset]', {
        element(el) {
          const ss = el.getAttribute('srcset');
          if (ss) {
            const rewritten = ss.replace(/(https?:\/\/[^\s,]+)/g, workerBase + '/proxy/$1');
            el.setAttribute('srcset', rewritten);
          }
        },
      })
      .on('iframe[src]', new AttributeRewriter('src', workerBase, origin))
      .on('embed[src]', new AttributeRewriter('src', workerBase, origin))
      .on('object[data]', new AttributeRewriter('data', workerBase, origin))
      .on('input[src]', new AttributeRewriter('src', workerBase, origin))
      .on('image[href]', new AttributeRewriter('href', workerBase, origin))
      .on('use[href]', new AttributeRewriter('href', workerBase, origin))
      .on('use[xlink\\:href]', new AttributeRewriter('xlink:href', workerBase, origin));

    return rw.transform(
      new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: rh })
    );
  }

  if (ct.includes('text/css')) {
    let css = await resp.text();
    css = css.replace(/url\(\s*['"]?(https?:\/\/[^'"\)]+)['"]?\s*\)/gi, (m, u) => {
      if (u.startsWith(workerBase)) return m;
      return `url(${workerBase}/proxy/${u})`;
    });
    return new Response(css, { status: resp.status, statusText: resp.statusText, headers: rh });
  }

  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: rh });
}
