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
        var reqInit={
          method:input.method,
          headers:input.headers,
          credentials:input.credentials,
          cache:input.cache,
          redirect:input.redirect,
          referrer:input.referrer,
          integrity:input.integrity,
          signal:input.signal
        };
        if(input.method!=='GET'&&input.method!=='HEAD'){
          try{
            reqInit.body=input.clone().body;
          }catch(_e){}
        }
        input=new Request(newUrl,reqInit);
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
        // Render a gorgeous browser-in-browser UI landing page
        return new Response(getBrowserUI(workerBase), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // ── 2.5) Proxy wrapper UI check ──
      // If path is "browser" followed by target URL, render the browser frame wrapper
      if (rawPath.startsWith('browser/')) {
        const actualTarget = rawPath.substring('browser/'.length) + url.search + url.hash;
        return new Response(getBrowserFrame(workerBase, actualTarget), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // ── 3) 프록시 실행 ──
      return await proxyFetch(targetUrl, request, workerBase);

    } catch (err) {
      return text(`Worker error: ${err.stack || err.message}`, 500);
    }
  },
};

// ── Browser UI HTML Template ───────────────────────────────────────
function getBrowserUI(workerBase) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nebula Browser Portal</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0f0c20 0%, #15102a 50%, #06040a 100%);
      --accent: linear-gradient(90deg, #ff007f, #7f00ff);
      --accent-glow: rgba(127, 0, 255, 0.4);
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.08);
      --text: #ffffff;
      --text-muted: #8b85a3;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-gradient);
      color: var(--text);
      font-family: 'Outfit', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow-x: hidden;
    }
    /* Background decorative blobs */
    .blob {
      position: absolute;
      width: 500px;
      height: 500px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(127,0,255,0.15) 0%, rgba(0,0,0,0) 70%);
      top: -100px;
      left: -100px;
      z-index: 0;
      animation: float 20s infinite alternate;
    }
    .blob2 {
      position: absolute;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,0,127,0.1) 0%, rgba(0,0,0,0) 70%);
      bottom: -150px;
      right: -150px;
      z-index: 0;
      animation: float 25s infinite alternate-reverse;
    }
    @keyframes float {
      0% { transform: translate(0, 0) scale(1); }
      100% { transform: translate(50px, 50px) scale(1.1); }
    }

    .container {
      position: relative;
      z-index: 1;
      width: 90%;
      max-width: 800px;
      text-align: center;
      padding: 40px 20px;
    }
    h1 {
      font-size: 3.5rem;
      font-weight: 800;
      margin-bottom: 15px;
      background: linear-gradient(90deg, #ff007f, #b500ff, #00d2ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -1px;
      animation: titleGlow 6s infinite alternate;
    }
    p.desc {
      font-size: 1.1rem;
      color: var(--text-muted);
      margin-bottom: 40px;
      font-weight: 300;
    }
    
    /* Modern Search / Address Bar */
    .search-box {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 8px 8px 8px 24px;
      display: flex;
      align-items: center;
      backdrop-filter: blur(20px);
      box-shadow: 0 20px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1);
      transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      margin-bottom: 40px;
    }
    .search-box:focus-within {
      border-color: #7f00ff;
      box-shadow: 0 0 30px var(--accent-glow), 0 20px 40px rgba(0,0,0,0.5);
      transform: translateY(-2px);
    }
    .search-box input {
      background: transparent;
      border: none;
      outline: none;
      color: #fff;
      font-size: 1.1rem;
      flex-grow: 1;
      font-family: inherit;
      padding-right: 15px;
    }
    .search-box input::placeholder {
      color: #56506d;
    }
    .search-box button {
      background: var(--accent);
      border: none;
      border-radius: 16px;
      color: white;
      font-size: 1rem;
      font-weight: 600;
      padding: 14px 28px;
      cursor: pointer;
      font-family: inherit;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .search-box button:hover {
      transform: scale(1.02);
      box-shadow: 0 5px 15px rgba(255, 0, 127, 0.4);
    }
    .search-box button:active {
      transform: scale(0.98);
    }

    /* Quick Links */
    .quick-links {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 16px;
      margin-top: 20px;
    }
    .link-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 20px 15px;
      cursor: pointer;
      backdrop-filter: blur(10px);
      transition: all 0.3s ease;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: inherit;
    }
    .link-card:hover {
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(255, 255, 255, 0.2);
      transform: translateY(-5px);
      box-shadow: 0 10px 20px rgba(0,0,0,0.3);
    }
    .link-icon {
      font-size: 1.8rem;
    }
    .link-name {
      font-size: 0.9rem;
      font-weight: 600;
    }

    /* Footer instructions */
    .footer {
      margin-top: 60px;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .footer code {
      background: rgba(255,255,255,0.05);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      color: #ff007f;
    }
  </style>
</head>
<body>
  <div class="blob"></div>
  <div class="blob2"></div>

  <div class="container">
    <h1>NEBULA PROXY</h1>
    <p class="desc">학교/회사 방화벽 및 URL 차단을 우회하는 개인 전용 고성능 웹 브라우저 허브</p>

    <div class="search-box">
      <input type="text" id="urlInput" placeholder="접속할 웹사이트 주소 또는 검색어 입력 (예: https://google.com)" autofocus>
      <button onclick="goProxy()">접속하기</button>
    </div>

    <div class="quick-links">
      <a href="javascript:void(0)" onclick="goLink('https://youtube.com')" class="link-card">
        <span class="link-icon">❤️</span>
        <span class="link-name">YouTube</span>
      </a>
      <a href="javascript:void(0)" onclick="goLink('https://google.com')" class="link-card">
        <span class="link-icon">🔍</span>
        <span class="link-name">Google</span>
      </a>
      <a href="javascript:void(0)" onclick="goLink('https://wikipedia.org')" class="link-card">
        <span class="link-icon">📚</span>
        <span class="link-name">Wikipedia</span>
      </a>
      <a href="javascript:void(0)" onclick="goLink('https://github.com')" class="link-card">
        <span class="link-icon">🐙</span>
        <span class="link-name">GitHub</span>
      </a>
    </div>

    <div class="footer">
      직접 주소창 이동: <code>\${workerBase}/[접속할주소]</code> 또는 <code>\${workerBase}/browser/[접속할주소]</code>
    </div>
  </div>

  <script>
    const input = document.getElementById('urlInput');
    input.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        goProxy();
      }
    });

    function cleanUrl(url) {
      url = url.trim();
      if (!url) return '';
      if (!/^https?:\\/\\//i.test(url)) {
        if (url.includes('.') && !url.includes(' ')) {
          url = 'https://' + url;
        } else {
          url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
        }
      }
      return url;
    }

    function goProxy() {
      const target = cleanUrl(input.value);
      if (target) {
        window.location.href = '${workerBase}/browser/' + target;
      }
    }

    function goLink(url) {
      window.location.href = '${workerBase}/browser/' + url;
    }
  </script>
</body>
</html>`;
}

function getBrowserFrame(workerBase, targetUrl) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nebula Frame Browser</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0b0914;
      color: #fff;
      font-family: 'Outfit', sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    /* Modern Glassmorphic Address Bar / Nav */
    .nav-bar {
      display: flex;
      align-items: center;
      background: rgba(15, 12, 32, 0.95);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding: 10px 16px;
      gap: 12px;
      backdrop-filter: blur(10px);
      z-index: 100;
    }
    .btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      color: #fff;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 1rem;
      transition: all 0.2s;
    }
    .btn:hover {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .address-bar-container {
      flex-grow: 1;
      display: flex;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 2px 6px 2px 14px;
      align-items: center;
      transition: all 0.3s;
    }
    .address-bar-container:focus-within {
      background: rgba(255, 255, 255, 0.06);
      border-color: #7f00ff;
      box-shadow: 0 0 10px rgba(127, 0, 255, 0.3);
    }
    .address-bar-container input {
      background: transparent;
      border: none;
      outline: none;
      color: #fff;
      font-family: inherit;
      font-size: 0.95rem;
      width: 100%;
    }
    .address-bar-container button {
      background: linear-gradient(90deg, #ff007f, #7f00ff);
      border: none;
      border-radius: 8px;
      color: white;
      padding: 6px 16px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.85rem;
      transition: transform 0.1s;
    }
    .address-bar-container button:active {
      transform: scale(0.95);
    }
    /* Full Screen Iframe Container */
    .frame-container {
      flex-grow: 1;
      position: relative;
      background: #fff;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #fff;
    }
  </style>
</head>
<body>

  <div class="nav-bar">
    <button class="btn" onclick="goHome()" title="홈으로">🏠</button>
    <button class="btn" onclick="back()" title="뒤로가기">◀</button>
    <button class="btn" onclick="forward()" title="앞으로가기">▶</button>
    <button class="btn" onclick="reload()" title="새로고침">🔄</button>
    
    <div class="address-bar-container">
      <input type="text" id="frameUrlInput" value="\${targetUrl}">
      <button onclick="navigateFrame()">이동</button>
    </div>
  </div>

  <div class="frame-container">
    <iframe id="proxyFrame" src="\${workerBase}/\${targetUrl}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
  </div>

  <script>
    const iframe = document.getElementById('proxyFrame');
    const input = document.getElementById('frameUrlInput');

    input.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        navigateFrame();
      }
    });

    function cleanUrl(url) {
      url = url.trim();
      if (!url) return '';
      if (!/^https?:\\/\\//i.test(url)) {
        if (url.includes('.') && !url.includes(' ')) {
          url = 'https://' + url;
        } else {
          url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
        }
      }
      return url;
    }

    function navigateFrame() {
      const dest = cleanUrl(input.value);
      if (dest) {
        // Change browser URL so bookmarks/reloads work
        window.history.pushState({}, '', '\${workerBase}/browser/' + dest);
        iframe.src = '\${workerBase}/' + dest;
      }
    }

    function goHome() {
      window.location.href = '\${workerBase}/';
    }

    function reload() {
      iframe.contentWindow.location.reload();
    }

    function back() {
      try {
        iframe.contentWindow.history.back();
      } catch(e) {
        // Fallback if cross-origin rules kick in (though same-origin in proxy)
        window.history.back();
      }
    }

    function forward() {
      try {
        iframe.contentWindow.history.forward();
      } catch(e) {
        window.history.forward();
      }
    }

    // Periodically sync the address bar value with iframe's current path if possible
    setInterval(function() {
      try {
        const frameUrl = iframe.contentWindow.location.href;
        if (frameUrl.includes('\${workerBase}/')) {
          const actualPath = frameUrl.substring(frameUrl.indexOf('\${workerBase}/') + '\${workerBase}/'.length);
          if (actualPath && !actualPath.startsWith('browser/')) {
            input.value = actualPath;
            window.history.replaceState({}, '', '\${workerBase}/browser/' + actualPath);
          }
        }
      } catch(e) {
        // Silent block for cross-origin (in case a redirect escaped proxy)
      }
    }, 1000);
  </script>
</body>
</html>`;
}

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
