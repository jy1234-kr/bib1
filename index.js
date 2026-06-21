// index.js — Cloudflare Workers 리버스 프록시 (Wrangler v3 / ESM)
// ──────────────────────────────────────────────────────────────
// 기능 요약:
//   1. /https://example.com  → 해당 URL을 대신 fetch하여 반환
//   2. HTMLRewriter로 a[href], img[src], link[href], script[src] 재작성
//   3. CORS 허용 + CSP 제거
//   4. KV 기반 단축 URL (/save?short=yt&url=https://youtube.com → /yt)
// ──────────────────────────────────────────────────────────────

// ── HTMLRewriter용 핸들러 ──────────────────────────────────────
class AttributeRewriter {
  /**
   * @param {string} attr  - 재작성할 속성명 (href 또는 src)
   * @param {string} workerBase - 워커 origin (예: https://bib.mintube.workers.dev)
   * @param {string} targetOrigin - 프록시 대상 origin (예: https://example.com)
   */
  constructor(attr, workerBase, targetOrigin) {
    this.attr = attr;
    this.workerBase = workerBase;
    this.targetOrigin = targetOrigin;
  }

  element(el) {
    const val = el.getAttribute(this.attr);
    if (!val) return;

    // 이미 워커 도메인을 경유하는 링크는 건드리지 않음
    if (val.startsWith(this.workerBase)) return;

    // ① 절대 URL (http:// 또는 https://)
    if (/^https?:\/\//i.test(val)) {
      el.setAttribute(this.attr, `${this.workerBase}/${val}`);
      return;
    }

    // ② 프로토콜-상대 URL (//cdn.example.com/...)
    if (val.startsWith('//')) {
      el.setAttribute(this.attr, `${this.workerBase}/https:${val}`);
      return;
    }

    // ③ 루트-상대 URL (/path/to/resource)
    if (val.startsWith('/')) {
      el.setAttribute(this.attr, `${this.workerBase}/${this.targetOrigin}${val}`);
      return;
    }

    // ④ 상대 URL (path/to/resource) — 타깃 origin 기준으로 변환
    el.setAttribute(this.attr, `${this.workerBase}/${this.targetOrigin}/${val}`);
  }
}

// ── 메인 핸들러 ───────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const workerBase = url.origin;            // https://bib.mintube.workers.dev
      const path = url.pathname.substring(1);   // 첫 번째 '/' 제거

      // ── CORS 프리플라이트 ──
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
          },
        });
      }

      // ── 1) 단축 URL 저장: /save?short=yt&url=https://youtube.com ──
      if (path === 'save') {
        const short = url.searchParams.get('short');
        const target = url.searchParams.get('url');
        if (!short || !target) {
          return new Response(
            'Missing "short" or "url" query parameter.\n' +
            'Usage: /save?short=yt&url=https://youtube.com',
            { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
          );
        }
        await env.MY_KV.put(short, target);
        return new Response(
          `✅ Saved: "${short}" → ${target}`,
          { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        );
      }

      // ── 2) 타깃 URL 결정 ──
      let targetUrl = null;

      // path가 http(s)로 시작하면 직접 프록시
      if (/^https?:\/\//i.test(path)) {
        // pathname + search + hash 까지 온전히 복원
        targetUrl = url.pathname.substring(1) + url.search + url.hash;
      } else if (path) {
        // KV에서 단축어 조회
        const kvVal = await env.MY_KV.get(path);
        if (kvVal) {
          targetUrl = kvVal;
        }
      }

      // 아무것도 매칭되지 않으면 사용법 안내
      if (!targetUrl) {
        return new Response(
          '🔀 Cloudflare Workers Reverse Proxy\n\n' +
          'Usage:\n' +
          '  /<full URL>                        — proxy any URL\n' +
          '  /save?short=<key>&url=<target>     — save a short URL\n' +
          '  /<key>                             — use a saved short URL\n\n' +
          'Examples:\n' +
          '  /https://example.com\n' +
          '  /save?short=yt&url=https://youtube.com\n' +
          '  /yt\n',
          { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        );
      }

      // ── 3) 프록시 요청 실행 ──
      return await proxyFetch(targetUrl, request, workerBase);

    } catch (err) {
      return new Response(`Worker error: ${err.stack || err.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  },
};

// ── 프록시 fetch 함수 ─────────────────────────────────────────
async function proxyFetch(targetUrl, originalReq, workerBase) {
  // GET/HEAD 요청에는 body를 보내면 안 됨
  const hasBody = !['GET', 'HEAD'].includes(originalReq.method);

  const resp = await fetch(targetUrl, {
    method: originalReq.method,
    headers: originalReq.headers,
    body: hasBody ? originalReq.body : undefined,
    redirect: 'follow',
  });

  // ── 응답 헤더 복사 & 조정 ──
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.delete('Content-Security-Policy');
  headers.delete('Content-Security-Policy-Report-Only');
  headers.delete('X-Frame-Options');

  // ── HTML이면 HTMLRewriter 적용 ──
  const ct = headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    const targetOrigin = new URL(targetUrl).origin;

    const rewriter = new HTMLRewriter()
      .on('a[href]',     new AttributeRewriter('href', workerBase, targetOrigin))
      .on('img[src]',    new AttributeRewriter('src',  workerBase, targetOrigin))
      .on('link[href]',  new AttributeRewriter('href', workerBase, targetOrigin))
      .on('script[src]', new AttributeRewriter('src',  workerBase, targetOrigin));

    return rewriter.transform(
      new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers }),
    );
  }

  // HTML이 아니면 그대로 전달
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}
