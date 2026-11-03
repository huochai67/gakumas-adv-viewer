import React, { useEffect, useMemo, useRef, useState } from 'react';
import { viewerEngine } from '../engine/ViewerEngine.js';

export function StoryBrowserPanel({ catalog, snap }) {
  const [dialogueSearch, setDialogueSearch] = useState('');
  const [showRawModal, setShowRawModal] = useState(false);
  const [rawScriptInput, setRawScriptInput] = useState('');
  const fileInputRef = useRef(null);
  const activeRowRef = useRef(null);

  const scripts = catalog?.scripts || [];
  const dialogues = snap.storyDialogueList || [];

  // Identify the currently active dialogue line index based on snap.storyTime
  const activeDialogueIdx = useMemo(() => {
    const t = snap.storyTime || 0;
    let found = -1;
    for (let i = 0; i < dialogues.length; i++) {
      const d = dialogues[i];
      if (t >= d.t && t <= d.t + d.dur + 0.25) {
        found = d.index;
      } else if (d.t <= t) {
        found = d.index;
      }
    }
    return found;
  }, [dialogues, snap.storyTime]);

  useEffect(() => {
    if (snap.storyPlaying && activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeDialogueIdx, snap.storyPlaying]);

  const filteredDialogues = useMemo(() => {
    if (!dialogueSearch.trim()) return dialogues;
    const q = dialogueSearch.toLowerCase();
    return dialogues.filter(
      (d) =>
        d.text.toLowerCase().includes(q) ||
        d.speaker.toLowerCase().includes(q) ||
        (d.voice && d.voice.toLowerCase().includes(q)),
    );
  }, [dialogues, dialogueSearch]);

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await viewerEngine.loadStoryFromText(text, file.name, true);
    e.target.value = '';
  };

  const handleApplyPastedScript = async () => {
    if (!rawScriptInput.trim()) return;
    setShowRawModal(false);
    await viewerEngine.loadStoryFromText(rawScriptInput, 'pasted_script.txt', true);
  };

  return (
    <div className="pane-scroll">
      {/* Script Selector & File Loader */}
      <div className="section-card">
        <div className="section-header">
          <span className="section-title">ADV 剧情脚本选择 (.txt)</span>
          <span className="section-count">{snap.storyStatus}</span>
        </div>

        <div className="item-list" style={{ maxHeight: 175 }}>
          {scripts.map((sc) => (
            <button
              key={sc.id}
              type="button"
              className={`item-row ${snap.storyScriptLabel === sc.name ? 'active' : ''}`}
              onClick={() => viewerEngine.loadStoryFromUrl(sc.url, sc.name, false)}
            >
              <div className="item-main">
                <div className="item-title">{sc.name}</div>
                <div className="item-sub">
                  {sc.cueCount} 指令 · {sc.messageCount} 句台词 · {sc.voiceCount} 条语音
                </div>
                {sc.preview && (
                  <div className="item-sub" style={{ color: '#8a99b5' }}>
                    {sc.preview}
                  </div>
                )}
              </div>
              <span className="badge cached">内置脚本</span>
            </button>
          ))}
        </div>

        <div className="pill-row" style={{ marginTop: 4 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt"
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />
          <button
            type="button"
            className="btn primary"
            style={{ flex: 1 }}
            onClick={() => fileInputRef.current?.click()}
          >
            📂 加载本地 .txt 脚本
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setShowRawModal((v) => !v)}
          >
            📝 粘贴脚本内容
          </button>
        </div>

        {showRawModal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <textarea
              className="search-input"
              rows={5}
              placeholder="在此粘贴原版 ADV 脚本 ([backgroundgroup ...], [message ...])…"
              value={rawScriptInput}
              onChange={(e) => setRawScriptInput(e.target.value)}
              style={{ fontFamily: 'monospace', resize: 'vertical' }}
            />
            <button type="button" className="btn primary" onClick={handleApplyPastedScript}>
              立即解析并渲染脚本
            </button>
          </div>
        )}
      </div>

      {/* Camera & Audio Settings */}
      <div className="section-card">
        <div className="section-header">
          <span className="section-title">镜头与语音控制 (Camera & Voice)</span>
        </div>
        <div className="pill-row">
          <button
            type="button"
            className={`btn ${!snap.storyCameraLocked ? 'active' : ''}`}
            style={{ flex: 1 }}
            onClick={() => viewerEngine.setStoryCameraLocked(false)}
          >
            🎬 剧本演出镜头
          </button>
          <button
            type="button"
            className={`btn ${snap.storyCameraLocked ? 'active' : ''}`}
            style={{ flex: 1 }}
            onClick={() => viewerEngine.setStoryCameraLocked(true)}
          >
            🕹 自由环绕视角
          </button>
        </div>
        <div className="control-row">
          <span className="control-label">语音音量</span>
          <input
            id="vol"
            type="range"
            className="range-slider"
            min={0}
            max={100}
            value={Math.round((snap.voiceVolume ?? 1) * 100)}
            onChange={(e) => viewerEngine.voiceCtrl.setVolume(Number(e.target.value) / 100)}
          />
          <span style={{ width: 36, textAlign: 'right', fontSize: 11 }}>
            {Math.round((snap.voiceVolume ?? 1) * 100)}%
          </span>
        </div>
      </div>

      {/* Interactive Dialogue & Cue Timeline */}
      <div className="section-card" style={{ flex: 1, minHeight: 260 }}>
        <div className="section-header">
          <span className="section-title">台词时间轴 (点击跳转)</span>
          <span className="section-count">{filteredDialogues.length} 句</span>
        </div>
        <input
          type="text"
          className="search-input"
          placeholder="搜索台词内容或说话人 (如 麻央, プロデューサー)…"
          value={dialogueSearch}
          onChange={(e) => setDialogueSearch(e.target.value)}
        />
        <div className="item-list tall">
          {filteredDialogues.map((d) => {
            const isActive = d.index === activeDialogueIdx;
            const isProducer = d.speaker === 'プロデューサー';
            return (
              <div
                key={`${d.index}-${d.t}`}
                ref={isActive ? activeRowRef : null}
                className={`dialogue-row ${isActive ? 'active' : ''}`}
                onClick={() => viewerEngine.seekStory(d.t + 0.02, snap.storyPlaying)}
              >
                <div className="dialogue-row-head">
                  <span className={`dialogue-speaker ${isProducer ? 'producer' : ''}`}>
                    {d.speaker || '旁白'}
                  </span>
                  <span className="dialogue-time">
                    {d.voice ? '🔊 ' : ''}
                    {d.t.toFixed(2)}s
                  </span>
                </div>
                <div className="dialogue-body">{d.text}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
