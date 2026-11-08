import React, { useEffect, useMemo, useRef, useState } from 'react';
import { viewerEngine } from '../engine/ViewerEngine.js';
import { ActorTransformControl } from './ActorTransformControl.jsx';

const SCRIPT_TYPE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'dear', label: '亲爱度 (dear)' },
  { id: 'pevent', label: '培育事件 (pevent)' },
  { id: 'pstory', label: '培育主线 (pstory)' },
  { id: 'cidol', label: '偶像卡 (cidol)' },
  { id: 'csprt', label: '支援卡 (csprt)' },
  { id: 'event', label: '活动 (event)' },
  { id: 'pstep', label: '阶段 (pstep)' },
  { id: 'unit', label: '组合 (unit)' },
  { id: 'live', label: 'Live (live)' },
  { id: 'produce', label: '课程 (produce)' },
  { id: 'pgrowth', label: '特训 (pgrowth)' },
  { id: 'pweek', label: '周常 (pweek)' },
  { id: 'gasha', label: '抽卡 (gasha)' },
  { id: 'startup', label: '登录 (startup)' },
  { id: 'tutorial', label: '教程 (tutorial)' },
  { id: 'presult', label: '结算 (presult)' },
  { id: 'other', label: '其他' },
];

const KNOWN_SCRIPT_TYPES = {
  dear: true,
  pevent: true,
  pstory: true,
  cidol: true,
  csprt: true,
  event: true,
  pstep: true,
  unit: true,
  live: true,
  produce: true,
  pgrowth: true,
  pweek: true,
  gasha: true,
  startup: true,
  tutorial: true,
  presult: true,
};

function resolveScriptType(sc) {
  if (sc.type) return sc.type;
  const stem = String(sc.name || '').replace(/\.txt$/i, '');
  if (stem.startsWith('adv_')) {
    const m = /^([a-z0-9]+)(?:[_-]|$)/i.exec(stem.slice(4));
    if (m) {
      const t = m[1].toLowerCase();
      if (KNOWN_SCRIPT_TYPES[t]) return t;
    }
  }
  return 'other';
}

export function StoryBrowserPanel({ catalog, snap }) {
  const [scriptTypeFilter, setScriptTypeFilter] = useState('all');
  const [scriptSearch, setScriptSearch] = useState('');
  const [dialogueSearch, setDialogueSearch] = useState('');
  const [showRawModal, setShowRawModal] = useState(false);
  const [rawScriptInput, setRawScriptInput] = useState('');
  const fileInputRef = useRef(null);
  const activeRowRef = useRef(null);

  const scripts = catalog?.scripts || [];
  const dialogues = snap.storyDialogueList || [];

  const filteredScripts = useMemo(() => {
    const q = scriptSearch.trim().toLowerCase();
    return scripts.filter((sc) => {
      const scType = resolveScriptType(sc);
      if (scriptTypeFilter !== 'all' && scType !== scriptTypeFilter) return false;
      if (
        q &&
        !sc.name.toLowerCase().includes(q) &&
        !(sc.preview && sc.preview.toLowerCase().includes(q)) &&
        !(sc.actors && sc.actors.some((a) => a.toLowerCase().includes(q)))
      ) {
        return false;
      }
      return true;
    });
  }, [scripts, scriptTypeFilter, scriptSearch]);
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
          <span className="section-count">
            {filteredScripts.length} 篇 · {snap.storyStatus}
          </span>
        </div>

        <input
          type="text"
          className="search-input"
          placeholder="搜索脚本名称、角色或台词预览 (如 amao, hski, 002)…"
          value={scriptSearch}
          onChange={(e) => setScriptSearch(e.target.value)}
        />

        <div className="pill-row">
          {SCRIPT_TYPE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`pill-btn ${scriptTypeFilter === f.id ? 'active' : ''}`}
              onClick={() => setScriptTypeFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="item-list" style={{ maxHeight: 210 }}>
          {useMemo(
            () =>
              filteredScripts.map((sc) => {
                const scType = resolveScriptType(sc);
                return (
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
                    <span className="badge cached">{scType}</span>
                  </button>
                );
              }),
            [filteredScripts, snap.storyScriptLabel],
          )}
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

      <ActorTransformControl snap={snap} mode="story" />

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
