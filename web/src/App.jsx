import React, { useEffect, useState } from 'react';
import { AssetBrowserPanel } from './components/AssetBrowserPanel.jsx';
import { StoryBrowserPanel } from './components/StoryBrowserPanel.jsx';
import { ViewportPane } from './components/ViewportPane.jsx';
import { viewerEngine } from './engine/ViewerEngine.js';

export function App() {
  const [snap, setSnap] = useState(() => viewerEngine.getSnapshot());
  const [catalog, setCatalog] = useState(null);

  useEffect(() => {
    const unsub = viewerEngine.subscribe((nextSnap) => {
      setSnap({ ...nextSnap });
    });
    fetch('/api/catalog')
      .then((r) => r.json())
      .then((data) => setCatalog(data))
      .catch((e) => console.warn('Failed to fetch catalog:', e));

    // Support URL query parameter ?script= or ?tab=story for direct story deep-linking
    const params = new URLSearchParams(window.location.search);
    if (params.get('script') || window.location.pathname.endsWith('story.html') || params.get('tab') === 'story') {
      viewerEngine.setMode('story');
      const customScript = params.get('script');
      if (customScript) {
        viewerEngine.loadStoryFromUrl(customScript, customScript.split('/').pop(), params.get('autoplay') !== '0');
      }
    }

    const onKeyDown = (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (viewerEngine.mode === 'story') {
          viewerEngine.setStoryPlaying(!viewerEngine.storyPlaying);
        } else {
          viewerEngine.setAssetPlaying(!viewerEngine.assetPlaying);
        }
      } else if (e.code === 'ArrowRight' && viewerEngine.mode === 'story') {
        viewerEngine.seekStory(viewerEngine.storyTime + 1, viewerEngine.storyPlaying);
      } else if (e.code === 'ArrowLeft' && viewerEngine.mode === 'story') {
        viewerEngine.seekStory(viewerEngine.storyTime - 1, viewerEngine.storyPlaying);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unsub();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const activeTab = snap.mode; // 'asset' | 'story'

  return (
    <div className="app-shell">
      {/* Top Multi-Tab Navigation Bar */}
      <header className="top-navbar">
        <div className="brand-group">
          <div className="brand-logo">G</div>
          <span className="brand-title">Gakumas ADV Studio</span>
          <span className="brand-badge">WASM Direct</span>
        </div>

        <nav className="top-tabs" aria-label="Main Tabs">
          <button
            id="tab-asset"
            type="button"
            className={`top-tab-btn ${activeTab === 'asset' ? 'active' : ''}`}
            onClick={() => viewerEngine.setMode('asset')}
          >
            <span>🧍 资产浏览器</span>
            <span className="top-tab-sub">人物建模 · 动作 · 服饰</span>
          </button>
          <button
            id="tab-story"
            type="button"
            className={`top-tab-btn ${activeTab === 'story' ? 'active' : ''}`}
            onClick={() => viewerEngine.setMode('story')}
          >
            <span>🎬 剧情浏览器</span>
            <span className="top-tab-sub">TXT脚本 · 舞台渲染</span>
          </button>
        </nav>

        <div className="top-actions">
          {activeTab === 'asset' && (
            <>
              <button
                type="button"
                className="btn"
                title="全身镜头"
                onClick={() => viewerEngine.setAssetCameraPreset('full')}
              >
                全身
              </button>
              <button
                type="button"
                className="btn"
                title="半身镜头"
                onClick={() => viewerEngine.setAssetCameraPreset('bust')}
              >
                半身
              </button>
              <button
                type="button"
                className="btn"
                title="面部特写"
                onClick={() => viewerEngine.setAssetCameraPreset('face')}
              >
                面部特写
              </button>
            </>
          )}
          <button
            type="button"
            className={`btn ${snap.useBloom ? 'active' : ''}`}
            onClick={() => viewerEngine.setUseBloom(!snap.useBloom)}
          >
            ✨ Bloom: {snap.useBloom ? 'ON' : 'OFF'}
          </button>
        </div>
      </header>

      {/* Main Left-Right Split Workspace */}
      <div className="main-split">
        <aside className="left-pane">
          {activeTab === 'asset' ? (
            <AssetBrowserPanel
              catalog={catalog}
              onCatalogUpdate={setCatalog}
              snap={snap}
            />
          ) : (
            <StoryBrowserPanel catalog={catalog} snap={snap} />
          )}
        </aside>

        <main className="right-pane">
          <ViewportPane snap={snap} />
        </main>
      </div>
    </div>
  );
}
