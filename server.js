const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors());

// Parse raw body for proxying (handles POST payloads up to 10MB)
app.use('/proxy', express.raw({ type: '*/*', limit: '10mb' }));

// Helper to resolve relative URLs to absolute URLs
function resolveUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch (e) {
    return url;
  }
}

// Rewrite HTML references
function rewriteHtml(html, baseUrl, proxyBase) {
  // 1. Rewrite attributes like href, src, action
  const attrRegex = /(href|src|action)\s*=\s*(['"])(.*?)\2/gi;
  let rewritten = html.replace(attrRegex, (match, attr, quote, val) => {
    if (
      !val ||
      val.startsWith('data:') ||
      val.startsWith('blob:') ||
      val.startsWith('javascript:') ||
      val.startsWith('#') ||
      val.startsWith('mailto:') ||
      val.startsWith(proxyBase)
    ) {
      return match;
    }
    const absUrl = resolveUrl(val, baseUrl);
    return `${attr}=${quote}${proxyBase}${absUrl}${quote}`;
  });

  // 2. Rewrite srcset attributes
  const srcsetRegex = /srcset\s*=\s*(['"])(.*?)\1/gi;
  rewritten = rewritten.replace(srcsetRegex, (match, quote, val) => {
    if (!val) return match;
    const parts = val.split(',').map(part => {
      const trimmed = part.trim();
      const firstSpace = trimmed.indexOf(' ');
      if (firstSpace === -1) {
        return `${proxyBase}${resolveUrl(trimmed, baseUrl)}`;
      }
      const url = trimmed.substring(0, firstSpace);
      const descriptor = trimmed.substring(firstSpace);
      return `${proxyBase}${resolveUrl(url, baseUrl)}${descriptor}`;
    });
    return `srcset=${quote}${parts.join(', ')}${quote}`;
  });

  // 3. Inject Client-side Interceptor Script
  const interceptorScript = `
<script data-proxy="1">
(function(){
  const proxyBase = ${JSON.stringify(proxyBase)};
  const baseUrl = ${JSON.stringify(baseUrl)};

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
</script>
`;

  // Inject script right after <head> or at the beginning
  const headIndex = rewritten.toLowerCase().indexOf('<head>');
  if (headIndex !== -1) {
    const insertPos = headIndex + 6;
    rewritten = rewritten.substring(0, insertPos) + interceptorScript + rewritten.substring(insertPos);
  } else {
    rewritten = interceptorScript + rewritten;
  }

  return rewritten;
}

// Rewrite CSS url(...) references
function rewriteCss(css, baseUrl, proxyBase) {
  return css.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi, (match, url) => {
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(proxyBase)) {
      return match;
    }
    const absUrl = resolveUrl(url, baseUrl);
    return `url("${proxyBase}${absUrl}")`;
  });
}

// Proxy Endpoint
app.all('/proxy/:targetUrl(*)', async (req, res) => {
  const targetUrl = req.url.substring('/proxy/'.length);

  if (!targetUrl) {
    return res.status(400).send('Error: Target URL is missing.');
  }

  try {
    const targetUrlObj = new URL(targetUrl);
    
    // Copy incoming headers and update details
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!key.startsWith('cf-') && !key.startsWith('x-forwarded')) {
        headers[key] = value;
      }
    }
    headers['host'] = targetUrlObj.host;
    headers['origin'] = targetUrlObj.origin;
    headers['referer'] = targetUrl;

    const fetchOptions = {
      method: req.method,
      headers: headers,
      redirect: 'follow',
    };

    // Include request body for POST/PUT requests
    if (!['GET', 'HEAD'].includes(req.method) && req.body && req.body.length > 0) {
      fetchOptions.body = req.body;
    }

    const response = await fetch(targetUrl, fetchOptions);
    
    // Set headers
    res.status(response.status);
    
    // Forward response headers with CORS corrections
    response.headers.forEach((value, key) => {
      // Remove framing/csp block restrictions
      if (
        ![
          'content-security-policy',
          'content-security-policy-report-only',
          'x-frame-options',
          'strict-transport-security',
          'cross-origin-opener-policy',
          'cross-origin-resource-policy',
        ].includes(key.toLowerCase())
      ) {
        res.setHeader(key, value);
      }
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    const contentType = response.headers.get('content-type') || '';
    const proxyBase = `${req.protocol}://${req.get('host')}/proxy/`;

    // Process Text responses (HTML and CSS) for Link Rewriting
    if (contentType.includes('text/html')) {
      const htmlText = await response.text();
      const rewrittenHtml = rewriteHtml(htmlText, targetUrl, proxyBase);
      res.send(rewrittenHtml);
    } else if (contentType.includes('text/css')) {
      const cssText = await response.text();
      const rewrittenCss = rewriteCss(cssText, targetUrl, proxyBase);
      res.send(rewrittenCss);
    } else {
      // Stream binary responses (images, videos, js, fonts) directly
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.send(buffer);
    }
  } catch (err) {
    console.error('Proxy Error:', err.message);
    res.status(502).send(`Proxy Error: Failed to fetch "${targetUrl}". Details: ${err.message}`);
  }
});

// Serve built frontend assets
const distPath = path.join(__dirname, 'frontend', 'dist');
app.use(express.static(distPath));

// Fallback all non-proxy/non-static routing requests to the React SPA index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/proxy/')) return next();
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Premium Browser Proxy Hub is running at http://localhost:${PORT}`);
});
