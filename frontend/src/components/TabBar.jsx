import React from 'react';

export default function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onNewTab }) {
  return (
    <div style={styles.container}>
      <div style={styles.tabList}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              style={{
                ...styles.tab,
                ...(isActive ? styles.activeTab : styles.inactiveTab),
              }}
            >
              <span style={styles.favicon}>{tab.favicon || '🌐'}</span>
              <span style={styles.title}>{tab.title || '새 탭'}</span>
              
              {tab.loading && (
                <div style={styles.spinner} />
              )}
              
              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  style={styles.closeBtn}
                >
                  ×
                </button>
              )}
              {isActive && <div style={styles.activeIndicator} />}
            </div>
          );
        })}
      </div>
      <button onClick={onNewTab} style={styles.newTabBtn} title="새 탭 열기">
        ＋
      </button>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    background: 'rgba(10, 8, 22, 0.9)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    padding: '8px 12px 0 12px',
    gap: '8px',
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  tabList: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '4px',
    overflowX: 'auto',
    flexGrow: 1,
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 16px',
    borderTopLeftRadius: '10px',
    borderTopRightRadius: '10px',
    fontSize: '0.85rem',
    fontWeight: '500',
    cursor: 'pointer',
    position: 'relative',
    minWidth: '120px',
    maxWidth: '180px',
    gap: '8px',
    transition: 'all 0.2s ease',
    userSelect: 'none',
    border: '1px solid transparent',
    borderBottom: 'none',
  },
  activeTab: {
    background: 'rgba(255, 255, 255, 0.05)',
    borderLeft: '1px solid rgba(255, 255, 255, 0.08)',
    borderRight: '1px solid rgba(255, 255, 255, 0.08)',
    borderTop: '1px solid rgba(255, 255, 255, 0.12)',
    color: '#fff',
  },
  inactiveTab: {
    background: 'rgba(0, 0, 0, 0.2)',
    color: '#8b85a3',
  },
  favicon: {
    fontSize: '0.95rem',
    display: 'flex',
    alignItems: 'center',
  },
  title: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flexGrow: 1,
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    fontSize: '1rem',
    cursor: 'pointer',
    padding: '0 4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    lineHeight: '1',
    opacity: 0.6,
    transition: 'opacity 0.2s',
  },
  spinner: {
    width: '10px',
    height: '10px',
    border: '2px solid rgba(255, 255, 255, 0.2)',
    borderTop: '2px solid #ff007f',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  activeIndicator: {
    position: 'absolute',
    bottom: 0,
    left: '12px',
    right: '12px',
    height: '2px',
    background: 'linear-gradient(90deg, #ff007f, #7f00ff)',
    borderRadius: '2px',
  },
  newTabBtn: {
    background: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '8px',
    color: '#fff',
    width: '32px',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: '1rem',
    marginBottom: '4px',
    transition: 'background 0.2s, border-color 0.2s',
  },
};
