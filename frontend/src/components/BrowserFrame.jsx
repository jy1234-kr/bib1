import React, { useRef, useEffect } from 'react';

// Extract YouTube Video ID from standard YouTube links
function getYouTubeId(url) {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

export default function BrowserFrame({ tab, onUrlChange, onLoadStart, onLoadEnd }) {
  const iframeRef = useRef(null);

  const ytId = getYouTubeId(tab.url);
  const isYouTube = !!ytId;

  // Compute the src for the iframe
  let frameSrc = '';
  if (tab.url) {
    if (isYouTube) {
      // Use YouTube Embed directly for performance and anti-frame bypassing
      frameSrc = `https://www.youtube.com/embed/${ytId}?autoplay=1&enablejsapi=1&rel=0`;
    } else {
      // Proxy normal requests through backend
      frameSrc = `${window.location.origin}/proxy/${tab.url}`;
    }
  }

  // Poll same-origin iframe's URL to track navigation/clicks
  useEffect(() => {
    if (isYouTube || !tab.url) return;

    const interval = setInterval(() => {
      try {
        const iframe = iframeRef.current;
        if (iframe && iframe.contentWindow) {
          const currentHref = iframe.contentWindow.location.href;
          const proxyPrefix = `${window.location.origin}/proxy/`;
          
          if (currentHref.startsWith(proxyPrefix)) {
            const actualUrl = currentHref.substring(proxyPrefix.length);
            if (actualUrl && actualUrl !== tab.url) {
              onUrlChange(actualUrl);
            }
          }
        }
      } catch (err) {
        // Cross-origin exception might occur if the frame navigated outside proxy (rare but handled)
      }
    }, 500);

    return () => clearInterval(interval);
  }, [tab.url, isYouTube, onUrlChange]);

  // Handle iframe load completion
  const handleLoad = () => {
    onLoadEnd();
    
    // Attempt to set Tab title from the frame's HTML title if accessible
    try {
      const iframe = iframeRef.current;
      if (iframe && iframe.contentWindow && iframe.contentWindow.document) {
        const docTitle = iframe.contentWindow.document.title;
        if (docTitle && docTitle !== tab.title) {
          // You could bubble this title up to update the tab name
        }
      }
    } catch (e) {
      // Cross-origin safe block
    }
  };

  // Trigger loading state when src changes
  useEffect(() => {
    if (tab.url) {
      onLoadStart();
    }
  }, [tab.url]);

  if (!tab.url) {
    return (
      <div style={styles.homeContainer}>
        <div className="decor-blob decor-blob-1"></div>
        <div className="decor-blob decor-blob-2"></div>
        
        <div style={styles.homeCard} className="glass">
          <h1 style={styles.homeTitle}>NEBULA PORTAL</h1>
          <p style={styles.homeSubtitle}>개인 전용 웹 브라우저 & 프록시</p>
          <div style={styles.quickStartGrid}>
            <div style={styles.quickCard} className="glass-interactive" onClick={() => onUrlChange('https://google.com')}>
              <span style={styles.quickIcon}>🔍</span>
              <h3>Google</h3>
              <p>웹 검색 및 탐색</p>
            </div>
            <div style={styles.quickCard} className="glass-interactive" onClick={() => onUrlChange('https://youtube.com')}>
              <span style={styles.quickIcon}>🎥</span>
              <h3>YouTube</h3>
              <p>동영상 직접 스트리밍</p>
            </div>
            <div style={styles.quickCard} className="glass-interactive" onClick={() => onUrlChange('https://wikipedia.org')}>
              <span style={styles.quickIcon}>📚</span>
              <h3>Wikipedia</h3>
              <p>다국어 온라인 백과사전</p>
            </div>
            <div style={styles.quickCard} className="glass-interactive" onClick={() => onUrlChange('https://github.com')}>
              <span style={styles.quickIcon}>🐙</span>
              <h3>GitHub</h3>
              <p>개발자 코드 호스팅 플랫폼</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <iframe
        ref={iframeRef}
        src={frameSrc}
        onLoad={handleLoad}
        style={styles.iframe}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-presentation"
      />
    </div>
  );
}

const styles = {
  container: {
    width: '100%',
    height: '100%',
    position: 'relative',
    background: '#fff',
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
    background: '#fff',
    display: 'block',
  },
  homeContainer: {
    flexGrow: 1,
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
    padding: '24px',
  },
  homeCard: {
    maxWidth: '800px',
    width: '100%',
    padding: '48px 32px',
    borderRadius: '24px',
    textAlign: 'center',
    boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
  },
  homeTitle: {
    fontSize: '3rem',
    fontWeight: '800',
    background: 'linear-gradient(90deg, #ff007f, #7f00ff, #00d2ff)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    letterSpacing: '-1px',
    marginBottom: '8px',
  },
  homeSubtitle: {
    color: '#8b85a3',
    fontSize: '1.1rem',
    fontWeight: '300',
    marginBottom: '40px',
  },
  quickStartGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '20px',
  },
  quickCard: {
    padding: '24px 16px',
    borderRadius: '16px',
    cursor: 'pointer',
    textAlign: 'center',
  },
  quickIcon: {
    fontSize: '2.5rem',
    display: 'block',
    marginBottom: '12px',
  },
};
