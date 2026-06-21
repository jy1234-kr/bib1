// index.js - Cloudflare Workers reverse proxy with HTML rewriting and KV short URLs
// ------------------------------------------------------------
// This script is written for Wrangler v3 (ESM syntax).
// It provides:
// 1. Proxying arbitrary URLs passed after the worker domain.
//    Example: https://myworker.example.workers.dev/https://blocked.com
// 2. HTMLRewriter that rewrites resource URLs (href/src) so that
//    relative/absolute links continue to work through the worker.
// 3. CORS handling – adds Access-Control-Allow-Origin: * and removes
//    restrictive CSP headers.
// 4. KV‑based short‑URL storage (env.MY_KV). Use /save?short=yt&url=...
//    and then access via https://myworker.example.workers.dev/yt
// ------------------------------------------------------------

/**
 * Helper class to rewrite a specific attribute (e.g., href, src).
 * It prefixes the worker’s own URL to any relative link and rewrites
 * absolute links that point to the original target so they route through
 * the worker again.
 */
class AttributeRewriter {
  /**
   * @param {string} attributeName – attribute to rewrite ("href" or "src").
   */
  constructor(attributeName) {
    this.attributeName = attributeName;
  }

  /**
   * Called for each element that matches the selector registered with
   * HTMLRewriter (e.g., 'a', 'img').
   * @param {Element} element
   */
  element(element) {
    const original = element.getAttribute(this.attributeName);
    if (!original) return;

    // If the URL already starts with the worker domain, leave it untouched.
    const workerBase = this.workerBase; // injected before usage
    if (original.startsWith(workerBase)) {
      return;
    }

    // Absolute URLs (http/https) – rewrite to go through the worker.
    if (original.startsWith('http://') || original.startsWith('https://')) {
      const rewritten = `${workerBase}/${original}`;
      element.setAttribute(this.attributeName, rewritten);
      return;
    }

    // Protocol‑relative URLs (//example.com)
    if (original.startsWith('//')) {
      const rewritten = `${workerBase}/https:${original}`;
      element.setAttribute(this.attributeName, rewritten);
      return;
    }

    // Relative URLs – simply prefix with the worker base.
    // Ensure we do not produce a duplicate slash.
    const slash = original.startsWith('/') ? '' : '/';
    const rewritten = `${workerBase}${slash}${original}`;
    element.setAttribute(this.attributeName, rewritten);
  }
}

/**
 * Main fetch event handler.
 * @param {Request} request
 * @param {Object} env – environment bindings (e.g., MY_KV).
 * @param {Object} ctx – context (not used here).
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.slice(1); // remove leading '/'
    const workerBase = `${url.origin}`; // e.g., https://myworker.workers.dev

    // -----------------------------------------------------------------
    // 1️⃣  Short‑URL handling (/save?short=...&url=... and /{short})
    // -----------------------------------------------------------------
    if (path.startsWith('save') && request.method === 'GET') {
      const short = url.searchParams.get('short');
      const target = url.searchParams.get('url');
      if (!short || !target) {
        return new Response('Missing "short" or "url" query parameters.', { status: 400 });
      }
      // Store in KV with a reasonable TTL (optional). Here we store permanently.
      await env.MY_KV.put(short, target);
      return new Response(`Saved short URL \"${short}\" → ${target}`);
    }

    // If the path matches a key in KV, treat it as a short URL.
    const kvTarget = await env.MY_KV.get(path);
    if (kvTarget) {
      // Recursively handle the fetched URL as if the user requested it directly.
      return await proxyRequest(kvTarget, request, env, workerBase);
    }

    // -----------------------------------------------------------------
    // 2️⃣  Direct proxying – the path itself is the target URL.
    // -----------------------------------------------------------------
    // Guard against empty path.
    if (!path) {
      return new Response('Usage:\n  /save?short=key&url=target   – store a short URL\n  /key                               – fetch via short URL\n  /https://example.com               – proxy arbitrary URL', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // The user is expected to URL‑encode the target URL after the first slash.
    // Decode it to obtain the real URL.
    let targetUrl;
    try {
      targetUrl = decodeURIComponent(path);
    } catch (e) {
      return new Response('Failed to decode target URL.', { status: 400 });
    }
    // Basic validation – must start with http(s).
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      return new Response('Target URL must start with http:// or https://', { status: 400 });
    }

    return await proxyRequest(targetUrl, request, env, workerBase);
  },
};

/**
 * Performs the actual fetch to the target URL, rewrites HTML if needed,
 * and adjusts response headers.
 * @param {string} targetUrl
 * @param {Request} originalRequest
 * @param {Object} env
 * @param {string} workerBase – e.g., https://myworker.workers.dev
 */
async function proxyRequest(targetUrl, originalRequest, env, workerBase) {
  // Preserve the original method and body (except for OPTIONS which we handle later).
  const init = {
    method: originalRequest.method,
    headers: originalRequest.headers,
    redirect: 'manual',
    body: originalRequest.body,
  };

  const fetched = await fetch(targetUrl, init);

  // Clone the response so we can modify headers safely.
  const responseHeaders = new Headers(fetched.headers);

  // ---------------------------------------------------------------
  // CORS & CSP handling
  // ---------------------------------------------------------------
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  // Remove any existing CSP header to avoid blocking the page.
  responseHeaders.delete('Content-Security-Policy');
  responseHeaders.delete('Content-Security-Policy-Report-Only');

  // ---------------------------------------------------------------
  // HTML rewriting – only for responses that declare HTML content.
  // ---------------------------------------------------------------
  const contentType = responseHeaders.get('content-type') || '';
  if (contentType.includes('text/html')) {
    // Re‑use the AttributeRewriter for the four element types.
    const rewriter = new HTMLRewriter()
      .on('a', new AttributeRewriter('href'))
      .on('img', new AttributeRewriter('src'))
      .on('link', new AttributeRewriter('href'))
      .on('script', new AttributeRewriter('src'));

    // Pass workerBase to each rewriter instance via a property.
    // (HTMLRewriter will call the same instance for every element.)
    rewriter.handlers.forEach(h => (h.handler.workerBase = workerBase));

    const rewritten = rewriter.transform(fetched);
    return new Response(rewritten.body, {
      status: fetched.status,
      statusText: fetched.statusText,
      headers: responseHeaders,
    });
  }

  // For non‑HTML responses, just forward the body with adjusted headers.
  return new Response(fetched.body, {
    status: fetched.status,
    statusText: fetched.statusText,
    headers: responseHeaders,
  });
}
