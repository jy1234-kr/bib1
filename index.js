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
  constructor(attributeName, workerBase) {
    this.attributeName = attributeName;
    this.workerBase = workerBase;
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
    const workerBase = `${url.protocol}//${url.host}`;
    const path = url.pathname.substring(1);
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }



    // -----------------------------------------------------------------
    // 1️⃣  KV handling – saving and redirecting short URLs.
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
    
    // -----------------------------------------------------------------
    // 2️⃣  Direct proxying – the path itself is the target URL.
    // -----------------------------------------------------------------
    let targetUrl = kvTarget || (path ? decodeURIComponent(path) : null);

    // Guard against empty path.
    if (!targetUrl) {
      return new Response('Usage:\n  /save?short=key&url=target   – store a short URL\n  /key                               – fetch via short URL\n  /https://example.com               – proxy arbitrary URL', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Basic validation – must start with http(s).
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      return new Response('Target URL must start with http:// or https://', { status: 400 });
    }

    try {
      return await proxyRequest(targetUrl, request, env, workerBase);
    } catch (e) {
      return new Response(`Error fetching URL: ${e.message}`, { status: 500 });
    }
  },
};

/**
 * Performs the actual fetch to the target URL, rewrites HTML
 * if needed,
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
      .on('a', new AttributeRewriter('href', workerBase))
      .on('img', new AttributeRewriter('src', workerBase))
      .on('link', new AttributeRewriter('href', workerBase))
      .on('script', new AttributeRewriter('src', workerBase));
    // No need for a separate handlers loop; workerBase is already embedded.
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
