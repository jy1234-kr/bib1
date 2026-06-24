import React, { useState } from 'react';
import TabBar from './components/TabBar';
import NavigationBar from './components/NavigationBar';
import BrowserFrame from './components/BrowserFrame';

// Helper to format URL
function formatUrl(val) {
  const trimmed = val.trim();
  if (!trimmed) return '';
  
  // YouTube specific formats
  if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
    // Return direct URL so frame can parse it
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  // General URL formatting
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  
  if (trimmed.includes('.') && !trimmed.includes(' ')) {
    return `https://${trimmed}`;
  }
  
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

// Get Domain or Name for Tab Title
function getDisplayTitle(url) {
  if (!url) return '새 탭';
  try {
    const parsed = new URL(url);
    let hostname = parsed.hostname;
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    return hostname;
  } catch (e) {
    return url;
  }
}

// Get appropriate favicon emoji/indicator
function getFavicon(url) {
  if (!url) return '🌐';
  if (url.includes('google.com')) return '🔍';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return '🎥';
  if (url.includes('wikipedia.org')) return '📚';
  if (url.includes('github.com')) return '🐙';
  return '📄';
}

export default function App() {
  const [tabs, setTabs] = useState([
    {
      id: '1',
      title: '새 탭',
      url: '',
      history: [],
      historyIndex: -1,
      loading: false,
      favicon: '🌐',
      reloadKey: 0,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState('1');

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // Helper to update active tab properties
  const updateActiveTab = (updates) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabId ? { ...t, ...updates } : t))
    );
  };

  const handleSelectTab = (id) => {
    setActiveTabId(id);
  };

  const handleCloseTab = (id) => {
    if (tabs.length === 1) return;
    const tabIndex = tabs.findIndex((t) => t.id === id);
    const newTabs = tabs.filter((t) => t.id !== id);
    setTabs(newTabs);

    if (activeTabId === id) {
      // Focus on adjacent tab
      const nextActiveIndex = Math.max(0, tabIndex - 1);
      setActiveTabId(newTabs[nextActiveIndex].id);
    }
  };

  const handleNewTab = (url = '') => {
    const newId = Date.now().toString();
    const formatted = url ? formatUrl(url) : '';
    const newTab = {
      id: newId,
      title: formatted ? getDisplayTitle(formatted) : '새 탭',
      url: formatted,
      history: formatted ? [formatted] : [],
      historyIndex: formatted ? 0 : -1,
      loading: false,
      favicon: getFavicon(formatted),
      reloadKey: 0,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  };

  const handleNavigate = (inputUrl) => {
    const formatted = formatUrl(inputUrl);
    const newHistory = [...activeTab.history.slice(0, activeTab.historyIndex + 1), formatted];
    
    updateActiveTab({
      url: formatted,
      title: getDisplayTitle(formatted),
      favicon: getFavicon(formatted),
      history: newHistory,
      historyIndex: newHistory.length - 1,
    });
  };

  const handleUrlChange = (newUrl) => {
    // If navigating inside iframe, update state (prevent double additions if already matching)
    if (activeTab.url === newUrl) return;

    const newHistory = [...activeTab.history.slice(0, activeTab.historyIndex + 1), newUrl];
    updateActiveTab({
      url: newUrl,
      title: getDisplayTitle(newUrl),
      favicon: getFavicon(newUrl),
      history: newHistory,
      historyIndex: newHistory.length - 1,
    });
  };

  const handleBack = () => {
    if (activeTab.historyIndex > 0) {
      const newIndex = activeTab.historyIndex - 1;
      const targetUrl = activeTab.history[newIndex];
      updateActiveTab({
        url: targetUrl,
        title: getDisplayTitle(targetUrl),
        favicon: getFavicon(targetUrl),
        historyIndex: newIndex,
      });
    }
  };

  const handleForward = () => {
    if (activeTab.historyIndex < activeTab.history.length - 1) {
      const newIndex = activeTab.historyIndex + 1;
      const targetUrl = activeTab.history[newIndex];
      updateActiveTab({
        url: targetUrl,
        title: getDisplayTitle(targetUrl),
        favicon: getFavicon(targetUrl),
        historyIndex: newIndex,
      });
    }
  };

  const handleReload = () => {
    updateActiveTab({ reloadKey: activeTab.reloadKey + 1 });
  };

  const handleGoHome = () => {
    updateActiveTab({
      url: '',
      title: '새 탭',
      favicon: '🌐',
      history: [],
      historyIndex: -1,
      loading: false,
    });
  };

  return (
    <div style={styles.appContainer}>
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onNewTab={() => handleNewTab()}
      />
      <NavigationBar
        tab={activeTab}
        onNavigate={handleNavigate}
        onBack={handleBack}
        onForward={handleForward}
        onReload={handleReload}
        onGoHome={handleGoHome}
      />
      <div style={styles.frameContainer}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              ...styles.frameWrapper,
              display: tab.id === activeTabId ? 'block' : 'none',
            }}
          >
            <BrowserFrame
              key={`${tab.id}-${tab.reloadKey}`}
              tab={tab}
              onUrlChange={handleUrlChange}
              onLoadStart={() => updateActiveTab({ loading: true })}
              onLoadEnd={() => updateActiveTab({ loading: false })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  appContainer: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    background: '#090712',
    overflow: 'hidden',
  },
  frameContainer: {
    flexGrow: 1,
    position: 'relative',
    background: '#090712',
  },
  frameWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
  },
};
