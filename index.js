// index.js — Cloudflare Workers 리버스 프록시 v3 (Wrangler v3 / ESM)
// ──────────────────────────────────────────────────────────────
// YouTube 등 SPA 사이트의 검색·API 호출까지 완전 프록시
// ──────────────────────────────────────────────────────────────

// ── HTML 속성 재작성 핸들러 ──────────────────────────────────
class AttributeRewriter {
  constructor(attr, workerBase, targetOrigin) {
    this.attr = attr;
    this.wb = workerBase;
    this.to = targetOrigin;
  }
  element(el) {
    const v = el.getAttribute(this.attr);
    if (!v || v.startsWith('data:') || v.startsWith('blob:') ||
        v.startsWith('javascript:') || v.startsWith('#') ||
        v.startsWith(this.wb)) return;
    el.setAttribute(this.attr, this.rewrite(v));
  }
  rewrite(u) {
    if (/^https?:\/\//i.test(u)) return this.wb + '/' + u;
    if (u.startsWith('//'))      return this.wb + '/https:' + u;
    if (u.startsWith('/'))       return this.wb + '/' + this.to + u;
    return this.wb + '/' + this.to + '/' + u;
  }
}

// ── <head>에 인터셉터 스크립트 주입 ─────────────────────────
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
    return `<script data-proxy="1">
(function(){
  var W="${this.wb}",T="${this.to}";

  // ── navigator.onLine 강제 true ──
  try{Object.defineProperty(navigator,'onLine',{get:function(){return true},configurable:true})}catch(e){}

  // ── URL 변환 ──
  function rw(u){
    if(!u||typeof u!=='string') return u;
    if(u.startsWith(W)||u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('javascript:')||u.startsWith('#')) return u;
    if(/^https?:\\/\\//i.test(u)) return W+'/'+u;
    if(u.startsWith('//')) return W+'/https:'+u;
    if(u.startsWith('/')) return W+'/'+T+u;
    return W+'/'+T+'/'+u;
  }

  // 어떤 형태의 URL이든 문자열로 변환 후 재작성
  function rwAny(u){
    if(typeof u==='string') return rw(u);
    if(u instanceof URL) return rw(u.href);
    if(u instanceof Request) return u; // Request는 별도 처리
    return u;
  }

  // ── fetch 인터셉트 ──
  var _fetch=window.fetch;
  window.fetch=function(input,init){
    try{
      if(typeof input==='string'){
        input=rw(input);
      }else if(input instanceof URL){
        input=rw(input.href);
      }else if(input instanceof Request){
        var newUrl=rw(input.url);
        // Request를 복제하면서 URL만 변경 (body 보존)
        input=new Request(newUrl,{
          method:input.method,
          headers:input.headers,
          body:input.body,
          mode:input.mode==='navigate'?'same-origin':input.mode,
          credentials:input.credentials,
          cache:input.cache,
          redirect:input.redirect,
          referrer:input.referrer,
          integrity:input.integrity,
          signal:input.signal
        });
      }
    }catch(e){console.warn('[proxy] fetch rewrite error:',e)}
    return _fetch.call(this,input,init);
  };

  // ── XMLHttpRequest 인터셉트 ──
  var _xhrOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){
    if(arguments.length>=2){
      try{arguments[1]=rw(arguments[1]+'');}catch(e){}
    }
    return _xhrOpen.apply(this,arguments);
  };

  // ── navigator.sendBeacon 인터셉트 ──
  if(navigator.sendBeacon){
    var _beacon=navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon=function(url,data){
      return _beacon(rw(url),data);
    };
  }

  // ── EventSource 인터셉트 ──
  if(window.EventSource){
    var _ES=window.EventSource;
    window.EventSource=function(url,cfg){
      return new _ES(rw(url),cfg);
    };
    window.EventSource.prototype=_ES.prototype;
  }

  // ── ServiceWorker 차단 ──
  if(navigator.serviceWorker){
    try{
      navigator.serviceWorker.register=function(){return Promise.reject()};
      navigator.serviceWorker.getRegistrations=function(){return Promise.resolve([])};
    }catch(e){}
  }

  // ── window.open 인터셉트 ──
  var _open=window.open;
  window.open=function(){
    if(arguments.length>=1&&typeof arguments[0]==='string'){
      arguments[0]=rw(arguments[0]);
    }
    return _open.apply(this,arguments);
  };

  // ── History pushState/replaceState 인터셉트 ──
  var _push=history.pushState, _repl=history.replaceState;
  function fixHistoryUrl(url){
    if(!url||typeof url!=='string') return url;
    // /로 시작하는 경로를 /target_origin/path로 변환
    if(url.startsWith('/')&&!url.startsWith('/'+T)&&!/^https?:\\/\\//i.test(url.substring(1))){
      return '/'+T+url;
    }
    return url;
  }
  history.pushState=function(s,t,u){return _push.call(this,s,t,fixHistoryUrl(u))};
  history.replaceState=function(s,t,u){return _repl.call(this,s,t,fixHistoryUrl(u))};

  // ── WebSocket 인터셉트 (wss:// → 프록시 불가이므로 직접 연결 허용) ──
  // WebSocket은 프록시할 수 없으므로 그대로 둠

  // ── online/offline 이벤트 억제 ──
  window.addEventListener('offline',function(e){e.stopImmediatePropagation()},true);

  console.log('[proxy] interceptors installed for',T);
})();
</script>`;
  }
}

// ── 메타 태그/base 태그 처리 ────────────────────────────────
class MetaCSPRemover {
  element(el) {
    const equiv = (el.getAttribute('http-equiv') || '').toLowerCase();
    if (equiv === 'content-security-policy') {
      el.remove();
    }
  }
}

// ── 메인 핸들러 ───────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const workerBase = url.origin;
      const rawPath = url.pathname.substring(1);

      // ── CORS 프리플라이트 ──
      if (request.method === 'OPTIONS') {
        return cors204();
      }

      // ── favicon.ico 무시 ──
      if (rawPath === 'favicon.ico') {
        return new Response(null, { status: 204 });
      }

      // ── 1) 단축 URL 저장 ──
      if (rawPath === 'save') {
        const short = url.searchParams.get('short');
        const target = url.searchParams.get('url');
        if (!short || !target) {
          return text('Missing "short" or "url" param.\nUsage: /save?short=yt&url=https://youtube.com', 400);
        }
        await env.MY_KV.put(short, target);
        return text(`✅ Saved: "${short}" → ${target}`);
      }

      // ── 2) 타깃 URL 결정 ──
      let targetUrl = null;

      if (/^https?:\/\//i.test(rawPath)) {
        // 직접 프록시 — pathname + search + hash 전부 포함
        targetUrl = rawPath + url.search + url.hash;
      } else if (rawPath) {
        // KV 단축어 조회
        const kv = await env.MY_KV.get(rawPath);
        if (kv) targetUrl = kv;
      }

      if (!targetUrl) {
        return text(
          '🔀 Reverse Proxy\n\n' +
          'Usage:\n' +
          '  /https://example.com         — proxy a URL\n' +
          '  /save?short=key&url=target   — save short URL\n' +
          '  /key                         — use saved short URL\n'
        );
      }

      // ── 3) 프록시 실행 ──
      return await proxyFetch(targetUrl, request, workerBase);

    } catch (err) {
      return text(`Worker error: ${err.stack || err.message}`, 500);
    }
  },
};

// ── 헬퍼 ──────────────────────────────────────────────────────
function text(t, s = 200) {
  return new Response(t, { status: s, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
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

// ── 프록시 fetch ──────────────────────────────────────────────
async function proxyFetch(targetUrl, originalReq, workerBase) {
  const method = originalReq.method;
  const hasBody = !['GET', 'HEAD'].includes(method);
  const tgt = new URL(targetUrl);

  // ── 요청 헤더 구성 ──
  const h = new Headers(originalReq.headers);
  h.set('Host', tgt.host);
  h.set('Origin', tgt.origin);
  h.set('Referer', targetUrl);
  // 프록시 관련 헤더 제거
  h.delete('cf-connecting-ip');
  h.delete('cf-ipcountry');
  h.delete('cf-ray');
  h.delete('cf-visitor');
  h.delete('x-forwarded-for');
  h.delete('x-forwarded-proto');

  // ── fetch (리다이렉트 자동 추적) ──
  let resp;
  try {
    resp = await fetch(targetUrl, {
      method,
      headers: h,
      body: hasBody ? originalReq.body : undefined,
      redirect: 'follow',   // 리다이렉트를 런타임이 자동 추적
    });
  } catch (fetchErr) {
    return text(`Fetch failed: ${fetchErr.message}`, 502);
  }

  // ── 응답 헤더 정리 ──
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

  // ── HTML이면 재작성 ──
  const ct = rh.get('content-type') || '';
  if (ct.includes('text/html')) {
    const origin = tgt.origin;
    const rw = new HTMLRewriter()
      .on('head',             new HeadInjector(workerBase, origin))
      .on('meta',             new MetaCSPRemover())
      .on('a[href]',          new AttributeRewriter('href',   workerBase, origin))
      .on('img[src]',         new AttributeRewriter('src',    workerBase, origin))
      .on('img[srcset]',      { element(el) {
        const ss = el.getAttribute('srcset');
        if (ss) {
          const rewritten = ss.replace(/(https?:\/\/[^\s,]+)/g, workerBase + '/$1');
          el.setAttribute('srcset', rewritten);
        }
      }})
      .on('link[href]',       new AttributeRewriter('href',   workerBase, origin))
      .on('script[src]',      new AttributeRewriter('src',    workerBase, origin))
      .on('form[action]',     new AttributeRewriter('action', workerBase, origin))
      .on('video[src]',       new AttributeRewriter('src',    workerBase, origin))
      .on('video[poster]',    new AttributeRewriter('poster', workerBase, origin))
      .on('audio[src]',       new AttributeRewriter('src',    workerBase, origin))
      .on('source[src]',      new AttributeRewriter('src',    workerBase, origin))
      .on('source[srcset]',   { element(el) {
        const ss = el.getAttribute('srcset');
        if (ss) {
          const rewritten = ss.replace(/(https?:\/\/[^\s,]+)/g, workerBase + '/$1');
          el.setAttribute('srcset', rewritten);
        }
      }})
      .on('iframe[src]',      new AttributeRewriter('src',    workerBase, origin))
      .on('embed[src]',       new AttributeRewriter('src',    workerBase, origin))
      .on('object[data]',     new AttributeRewriter('data',   workerBase, origin))
      .on('input[src]',       new AttributeRewriter('src',    workerBase, origin))
      .on('image[href]',      new AttributeRewriter('href',   workerBase, origin))
      .on('use[href]',        new AttributeRewriter('href',   workerBase, origin))
      .on('use[xlink\\:href]',new AttributeRewriter('xlink:href', workerBase, origin));

    return rw.transform(
      new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: rh })
    );
  }

  // ── CSS 내 url() 재작성 ──
  if (ct.includes('text/css')) {
    let css = await resp.text();
    // url(https://...) → url(workerBase/https://...)
    css = css.replace(/url\(\s*['"]?(https?:\/\/[^'"\)]+)['"]?\s*\)/gi, (m, u) => {
      if (u.startsWith(workerBase)) return m;
      return `url(${workerBase}/${u})`;
    });
    return new Response(css, { status: resp.status, statusText: resp.statusText, headers: rh });
  }

  // 그 외 응답은 그대로 전달
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: rh });
}
