// index.js — Cloudflare Workers 리버스 프록시 (Wrangler v3 / ESM)
// ──────────────────────────────────────────────────────────────
// 기능:
//   1. /https://example.com  → 해당 URL을 대신 fetch하여 반환
//   2. HTMLRewriter로 HTML 속성 재작성 + JS fetch/XHR 인터셉트 주입
//   3. CORS 허용 + CSP 제거
//   4. KV 기반 단축 URL
//   5. 리다이렉트 Location 헤더 재작성
// ──────────────────────────────────────────────────────────────

// ── HTMLRewriter 핸들러: 속성 재작성 ──────────────────────────
class AttributeRewriter {
  constructor(attr, workerBase, targetOrigin) {
    this.attr = attr;
    this.workerBase = workerBase;
    this.targetOrigin = targetOrigin;
  }

  element(el) {
    const val = el.getAttribute(this.attr);
    if (!val || val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#')) return;
    if (val.startsWith(this.workerBase)) return;

    // ① 절대 URL
    if (/^https?:\/\//i.test(val)) {
      el.setAttribute(this.attr, `${this.workerBase}/${val}`);
      return;
    }
    // ② 프로토콜-상대 URL
    if (val.startsWith('//')) {
      el.setAttribute(this.attr, `${this.workerBase}/https:${val}`);
      return;
    }
    // ③ 루트-상대 URL
    if (val.startsWith('/')) {
      el.setAttribute(this.attr, `${this.workerBase}/${this.targetOrigin}${val}`);
      return;
    }
    // ④ 상대 URL
    el.setAttribute(this.attr, `${this.workerBase}/${this.targetOrigin}/${val}`);
  }
}

// ── HTMLRewriter 핸들러: <head>에 인터셉터 스크립트 주입 ──────
class HeadInjector {
  constructor(workerBase, targetOrigin) {
    this.workerBase = workerBase;
    this.targetOrigin = targetOrigin;
    this.injected = false;
  }

  element(el) {
    if (this.injected) return;
    this.injected = true;

    // 브라우저에서 실행될 스크립트: fetch, XHR, ServiceWorker 인터셉트
    const script = `<script>
(function() {
  var W = "${this.workerBase}";
  var T = "${this.targetOrigin}";

  // URL을 프록시 경유 URL로 변환
  function rewriteUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith(W)) return u;
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:')) return u;
    // 절대 URL
    if (/^https?:\\/\\//i.test(u)) return W + '/' + u;
    // 프로토콜-상대
    if (u.startsWith('//')) return W + '/https:' + u;
    // 루트-상대
    if (u.startsWith('/')) return W + '/' + T + u;
    // 상대
    return W + '/' + T + '/' + u;
  }

  // ── fetch 인터셉트 ──
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = rewriteUrl(input);
    } else if (input instanceof Request) {
      input = new Request(rewriteUrl(input.url), input);
    }
    return origFetch.call(this, input, init);
  };

  // ── XMLHttpRequest 인터셉트 ──
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    arguments[1] = rewriteUrl(url);
    return origOpen.apply(this, arguments);
  };

  // ── ServiceWorker 차단 (프록시에서 SW는 동작 불가) ──
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function() {
      return Promise.resolve();
    };
  }

  // ── window.open 인터셉트 ──
  var origOpen2 = window.open;
  window.open = function(url) {
    arguments[0] = rewriteUrl(url);
    return origOpen2.apply(this, arguments);
  };

  // ── History API 인터셉트 (pushState/replaceState) ──
  var origPush = history.pushState;
  var origReplace = history.replaceState;
  history.pushState = function(state, title, url) {
    if (url && typeof url === 'string' && url.startsWith('/') && !url.startsWith(W)) {
      url = '/' + T + url;
    }
    return origPush.call(this, state, title, url);
  };
  history.replaceState = function(state, title, url) {
    if (url && typeof url === 'string' && url.startsWith('/') && !url.startsWith(W)) {
      url = '/' + T + url;
    }
    return origReplace.call(this, state, title, url);
  };
})();
</script>`;

    el.prepend(script, { html: true });
  }
}

// ── 메인 핸들러 ───────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const workerBase = url.origin;
      // pathname에서 첫 '/' 제거 + search + hash 복원
      const rawPath = url.pathname.substring(1);

      // ── CORS 프리플라이트 ──
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400',
          },
        });
      }

      // ── 1) 단축 URL 저장 ──
      if (rawPath === 'save') {
        const short = url.searchParams.get('short');
        const target = url.searchParams.get('url');
        if (!short || !target) {
          return textResponse('Missing "short" or "url" parameter.\nUsage: /save?short=yt&url=https://youtube.com', 400);
        }
        await env.MY_KV.put(short, target);
        return textResponse(`✅ Saved: "${short}" → ${target}`);
      }

      // ── 2) 타깃 URL 결정 ──
      let targetUrl = null;

      if (/^https?:\/\//i.test(rawPath)) {
        // 직접 프록시: /https://example.com/path?q=1
        targetUrl = rawPath + url.search + url.hash;
      } else if (rawPath) {
        // KV 단축어 조회
        const kvVal = await env.MY_KV.get(rawPath);
        if (kvVal) targetUrl = kvVal;
      }

      if (!targetUrl) {
        return textResponse(
          '🔀 Reverse Proxy\n\n' +
          'Usage:\n' +
          '  /https://example.com         — proxy a URL\n' +
          '  /save?short=key&url=target   — save short URL\n' +
          '  /key                         — use saved short URL\n',
        );
      }

      // ── 3) 프록시 실행 ──
      return await proxyFetch(targetUrl, request, workerBase);

    } catch (err) {
      return textResponse(`Worker error: ${err.stack || err.message}`, 500);
    }
  },
};

// ── 헬퍼: 텍스트 응답 ─────────────────────────────────────────
function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// ── 프록시 fetch ──────────────────────────────────────────────
async function proxyFetch(targetUrl, originalReq, workerBase) {
  const hasBody = !['GET', 'HEAD'].includes(originalReq.method);

  // 요청 헤더 복사 & 조정
  const reqHeaders = new Headers(originalReq.headers);
  // Host 헤더를 타깃에 맞게 변경
  const targetUrlObj = new URL(targetUrl);
  reqHeaders.set('Host', targetUrlObj.host);
  // Referer/Origin도 타깃 도메인으로 위장
  reqHeaders.set('Referer', targetUrl);
  reqHeaders.set('Origin', targetUrlObj.origin);
  // 쿠키 전달을 위해 그대로 유지

  const resp = await fetch(targetUrl, {
    method: originalReq.method,
    headers: reqHeaders,
    body: hasBody ? originalReq.body : undefined,
    redirect: 'manual',  // 리다이렉트를 직접 처리하여 Location 재작성
  });

  // ── 응답 헤더 복사 & 조정 ──
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', '*');
  headers.delete('Content-Security-Policy');
  headers.delete('Content-Security-Policy-Report-Only');
  headers.delete('X-Frame-Options');
  headers.delete('Strict-Transport-Security');

  // ── 리다이렉트 처리: Location 헤더 재작성 ──
  if ([301, 302, 303, 307, 308].includes(resp.status)) {
    const location = resp.headers.get('Location');
    if (location) {
      let newLocation;
      if (/^https?:\/\//i.test(location)) {
        newLocation = `${workerBase}/${location}`;
      } else if (location.startsWith('/')) {
        newLocation = `${workerBase}/${targetUrlObj.origin}${location}`;
      } else {
        newLocation = `${workerBase}/${location}`;
      }
      headers.set('Location', newLocation);
    }
    return new Response(null, { status: resp.status, headers });
  }

  // ── HTML이면 HTMLRewriter 적용 ──
  const ct = headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    const targetOrigin = targetUrlObj.origin;

    const rewriter = new HTMLRewriter()
      // <head>에 fetch/XHR 인터셉터 주입
      .on('head', new HeadInjector(workerBase, targetOrigin))
      // 주요 태그 속성 재작성
      .on('a[href]', new AttributeRewriter('href', workerBase, targetOrigin))
      .on('img[src]', new AttributeRewriter('src', workerBase, targetOrigin))
      .on('link[href]', new AttributeRewriter('href', workerBase, targetOrigin))
      .on('script[src]', new AttributeRewriter('src', workerBase, targetOrigin))
      .on('form[action]', new AttributeRewriter('action', workerBase, targetOrigin))
      .on('video[src]', new AttributeRewriter('src', workerBase, targetOrigin))
      .on('audio[src]', new AttributeRewriter('src', workerBase, targetOrigin))
      .on('source[src]', new AttributeRewriter('src', workerBase, targetOrigin))
      .on('iframe[src]', new AttributeRewriter('src', workerBase, targetOrigin))
      .on('embed[src]', new AttributeRewriter('src', workerBase, targetOrigin))
      .on('object[data]', new AttributeRewriter('data', workerBase, targetOrigin))
      .on('input[src]', new AttributeRewriter('src', workerBase, targetOrigin))
      .on('image[href]', new AttributeRewriter('href', workerBase, targetOrigin))
      .on('use[href]', new AttributeRewriter('href', workerBase, targetOrigin));

    return rewriter.transform(
      new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers }),
    );
  }

  // HTML이 아닌 응답은 그대로 전달
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}
