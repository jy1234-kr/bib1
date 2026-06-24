# 🌐 Browser inside a Browser (웹 브라우저 안의 브라우저)

이 프로젝트는 웹 안에서 작동하는 가상 웹 브라우저 허브입니다. React 기반의 미려한 다크 모드/글래스모피즘 인터페이스와 강력한 CORS/X-Frame-Options/CSP 우회 프록시 백엔드가 통합되어 작동합니다.

---

## 주요 기능 (Features)

1. **React 기반 UI (Premium Glassmorphic Dark Mode)**
   - 현대적이고 고급스러운 다크 테마 디자인 및 부드러운 전환 효과 적용.
   - 모바일 대응 및 반응형 크기 조절 완벽 지원.

2. **멀티 탭 기능 (Multi-tab system)**
   - 탭 추가(＋), 전환, 닫기 기능.
   - 각 탭마다 독립적인 주소 이동 이력(Navigation History) 관리.

3. **주소창 & 네비게이션 컨트롤 (Address Bar & Controls)**
   - 뒤로가기(◀), 앞으로가기(▶), 새로고침(🔄), 홈(🏠) 기능 완벽 제어.
   - 주소 입력창 및 이동 상태를 알려주는 상단 글로우 프로그레스 바(Loader).

4. **강력한 백엔드 프록시 (Proxy Bypass & Rewriting)**
   - **X-Frame-Options & CSP 우회**: 프레임 격리 정책 및 사이트 보안 규정을 헤더 단에서 즉각 해제하여 iframe 로드 보장.
   - **링크 리라이팅 (HTML/CSS URL Rewrite)**: 페이지 내부의 모든 상대/절대 링크(`href`, `src`, `form action`, `srcset` 등)와 CSS `url(...)` 경로를 자동으로 프록시 경로(`/proxy/...`)로 변환하여 내부 브라우저 내에서 지속 탐색 가능.
   - **쿠키 및 세션 보존**: 클라이언트의 쿠키를 백엔드로 중계하고 `Set-Cookie`를 브라우저에 전달하여 세션 상태 지속 제공.
   - **클라이언트 사이드 인터셉터**: 프록시된 HTML에 스크립트를 주입하여 비동기 `fetch`, `XMLHttpRequest`, `history.pushState`, `window.open` 호출을 자동으로 인터셉트 및 우회 처리.

5. **유튜브 스마트 탐색 (YouTube Smart Auto-Embed)**
   - 주소창에 `youtube.com` 또는 `youtu.be` 형태의 URL 입력 감지 시, 비디오 ID를 자동 추출하여 YouTube Embed iframe으로 즉각 변환 로드.
   - 유튜브 자체의 Iframe 차단 정책을 완벽하게 우회하고 전체화면 재생(Fullscreen Allow) 및 고속 미디어 렌더링 지원.

---

## 파일 구조 (File Structure)

```
/
├── wrangler.toml         # Cloudflare Workers 설정 파일 (정적 에셋 연동)
├── package.json          # 프로젝트 전체 명령어 스크립트 및 Node 백엔드 디펜던시
├── index.js              # Cloudflare Workers 프록시 엔트리 코드 (HTMLRewriter 적용)
├── server.js             # Node.js Express 프록시 & 정적 에셋 서빙 백엔드
├── README.md             # 프로젝트 통합 매뉴얼 (본 문서)
└── frontend/             # React Vite 프론트엔드 프로젝트
    ├── package.json      # React 앱 디펜던시
    ├── index.html        # SPA 템플릿
    ├── vite.config.js    # 빌드 구성
    └── src/
        ├── main.jsx      # 리액트 진입점
        ├── index.css     # 공통 프리미엄 테마 및 키프레임 애니메이션 정의
        ├── App.jsx       # 탭 관리 및 전역 상태 관리 로직
        └── components/
            ├── TabBar.jsx         # 탭 네비게이터바 컴포넌트
            ├── NavigationBar.jsx  # 주소창 및 뒤로/앞으로가기 컨트롤러 컴포넌트
            └── BrowserFrame.jsx   # Iframe 처리기, 유튜브 판별 및 URL 동기화 컴포넌트
```

---

## 시작하기 (Getting Started)

### 1. 로컬 개발 환경 실행 (Node.js Express + React)

Node.js (v18 이상 권장) 환경에서 매우 간단하게 빌드 및 전체 로컬 실행이 가능합니다.

```bash
# 1. 루트 경로에서 통합 패키지 설치
npm run install:all

# 2. React 빌드 및 Express 서버 구동 (통합 실행)
npm run dev
```

서버 구동 완료 후 브라우저에서 **`http://localhost:3000`**에 접속하시면 완성된 브라우저를 만나보실 수 있습니다.

### 2. Cloudflare Workers 배포

Cloudflare Workers 환경으로 배포하고 에셋까지 연동하려면 Wrangler CLI를 이용해 한 번에 배포할 수 있습니다.

```bash
# 1. 프론트엔드 프로덕션 빌드 생성
cd frontend
npm run build
cd ..

# 2. Wrangler를 이용해 배포 (로그인 필요)
npx wrangler deploy
```

`wrangler.toml`에 정의된 `[assets]` 설정에 의해 `./frontend/dist` 디렉터리의 React 정적 파일들이 Cloudflare Edge로 전송되어 주소 `/proxy/`를 제외한 모든 에셋이 고속 로드됩니다.

---

## 프로젝트 Zip 압축 패키징 방법

프로젝트 전체를 압축하여 파일로 내보내거나 이전하고자 할 경우 아래 가이드라인을 따르십시오:

1. 빌드 아티팩트 및 로컬 의존성 디렉터리(`node_modules`, `dist`, `.wrangler`)를 제외하고 압축해야 용량이 가볍고 에러가 없습니다.
2. 아래 명령어로 압축 파일(ZIP)을 만들거나 파일 관리자를 통해 다음 목록을 포함하여 압축하십시오:
   - **포함할 목록**: `frontend/src/`, `frontend/package.json`, `frontend/vite.config.js`, `frontend/index.html`, `server.js`, `index.js`, `wrangler.toml`, `package.json`, `README.md`
   - **제외할 목록**: `node_modules/`, `frontend/node_modules/`, `frontend/dist/`, `.git/`, `.wrangler/`
