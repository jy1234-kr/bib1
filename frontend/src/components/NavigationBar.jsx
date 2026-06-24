import React, { useState, useEffect } from 'react';

export default function NavigationBar({
  tab,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onGoHome,
}) {
  const [inputVal, setInputVal] = useState(tab.url || '');

  useEffect(() => {
    setInputVal(tab.url || '');
  }, [tab.url]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (inputVal.trim()) {
      onNavigate(inputVal.trim());
    }
  };

  const hasBack = tab.historyIndex > 0;
  const hasForward = tab.historyIndex < tab.history.length - 1;

  return (
    <div style={styles.container}>
      {/* Loading Progress Bar */}
      {tab.loading && (
        <div style={styles.progressBar}>
          <div style={styles.progressFill} />
        </div>
      )}

      <div style={styles.navRow}>
        {/* Navigation Buttons */}
        <div style={styles.buttonGroup}>
          <button
            onClick={onGoHome}
            style={styles.navBtn}
            title="홈"
          >
            🏠
          </button>
          <button
            onClick={onBack}
            disabled={!hasBack}
            style={{
              ...styles.navBtn,
              ...(hasBack ? {} : styles.disabledBtn),
            }}
            title="뒤로 가기"
          >
            ◀
          </button>
          <button
            onClick={onForward}
            disabled={!hasForward}
            style={{
              ...styles.navBtn,
              ...(hasForward ? {} : styles.disabledBtn),
            }}
            title="앞으로 가기"
          >
            ▶
          </button>
          <button
            onClick={onReload}
            style={styles.navBtn}
            title="새로고침"
          >
            🔄
          </button>
        </div>

        {/* Address Bar */}
        <form onSubmit={handleSubmit} style={styles.addressBarForm}>
          <div style={styles.addressInputContainer}>
            <span style={styles.securityIcon}>
              {tab.url ? '🔒' : '🔍'}
            </span>
            <input
              type="text"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder="검색어 또는 URL 주소를 입력하세요 (예: google.com)"
              style={styles.addressInput}
            />
            {inputVal && (
              <button
                type="button"
                onClick={() => setInputVal('')}
                style={styles.clearBtn}
              >
                ×
              </button>
            )}
            <button type="submit" style={styles.goBtn}>
              이동
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const styles = {
  container: {
    background: 'rgba(15, 12, 30, 0.95)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    padding: '10px 16px',
    position: 'relative',
  },
  progressBar: {
    position: 'absolute',
    bottom: '-2px',
    left: 0,
    right: 0,
    height: '2px',
    background: 'rgba(255,255,255,0.05)',
    overflow: 'hidden',
    zIndex: 10,
  },
  progressFill: {
    height: '100%',
    width: '30%',
    background: 'linear-gradient(90deg, #ff007f, #7f00ff, #00d2ff)',
    boxShadow: '0 0 8px #ff007f',
    animation: 'loading-flow 1.5s infinite ease-in-out',
  },
  navRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  buttonGroup: {
    display: 'flex',
    gap: '6px',
  },
  navBtn: {
    background: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '8px',
    color: '#fff',
    width: '36px',
    height: '36px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: '0.9rem',
    transition: 'all 0.2s ease',
  },
  disabledBtn: {
    opacity: 0.3,
    cursor: 'not-allowed',
  },
  addressBarForm: {
    flexGrow: 1,
  },
  addressInputContainer: {
    display: 'flex',
    alignItems: 'center',
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '12px',
    padding: '2px 4px 2px 12px',
    transition: 'all 0.3s ease',
  },
  securityIcon: {
    fontSize: '0.85rem',
    marginRight: '8px',
    opacity: 0.6,
  },
  addressInput: {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: '#fff',
    fontSize: '0.9rem',
    flexGrow: 1,
    height: '32px',
    fontFamily: 'inherit',
  },
  clearBtn: {
    background: 'transparent',
    border: 'none',
    color: '#8b85a3',
    fontSize: '1.2rem',
    cursor: 'pointer',
    padding: '0 8px',
    display: 'flex',
    alignItems: 'center',
  },
  goBtn: {
    background: 'linear-gradient(90deg, #ff007f, #7f00ff)',
    border: 'none',
    borderRadius: '8px',
    color: '#white',
    padding: '6px 16px',
    cursor: 'pointer',
    fontWeight: '600',
    fontSize: '0.85rem',
    transition: 'transform 0.1s, box-shadow 0.2s',
  },
};
