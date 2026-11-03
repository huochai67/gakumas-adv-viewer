import React, { useEffect, useRef } from 'react';
import { viewerEngine } from '../engine/ViewerEngine.js';

export function ViewportPane({ snap }) {
  const canvasHostRef = useRef(null);
  const bg2dRef = useRef(null);

  useEffect(() => {
    if (canvasHostRef.current && bg2dRef.current) {
      viewerEngine.mount(canvasHostRef.current, bg2dRef.current);
    }
    return () => {
      viewerEngine.unmount();
    };
  }, []);

  const isStory = snap.mode === 'story';
  const msg = snap.storyActiveMessage;
  const fade = snap.storyFade || { color: '#000000', opacity: 0 };

  return (
    <div className="viewport-root">
      <div ref={bg2dRef} id="bg2d" className="viewport-bg2d" />
      <div ref={canvasHostRef} id="app" className="viewport-canvas" />

      {isStory && (
        <div
          id="fade"
          className="viewport-fade"
          style={{
            background: fade.color,
            opacity: fade.opacity,
          }}
        />
      )}

      {isStory && msg && (
        <div id="msg" className="adv-dialogue-box">
          <div className="adv-dialogue-window" />
          {!msg.narration && msg.speaker && (
            <div className="adv-dialogue-name">{msg.speaker}</div>
          )}
          {msg.hasVoice && (
            <button
              id="voice-replay"
              type="button"
              className="adv-voice-replay"
              title="重播此句语音"
              onClick={() => viewerEngine.replayCurrentVoice()}
            >
              🔊
            </button>
          )}
          <div className="adv-dialogue-text">{msg.shownText}</div>
          <div className="adv-dialogue-next" />
        </div>
      )}

      {/* Floating Bottom Transport Bar */}
      {isStory ? (
        <div id="hud" className="viewport-hud-bar">
          <button
            id="play"
            type="button"
            className={`btn ${snap.storyPlaying ? 'active' : 'primary'}`}
            onClick={() => viewerEngine.setStoryPlaying(!snap.storyPlaying)}
          >
            {snap.storyPlaying ? '⏸ 暂停' : '▶ 播放'}
          </button>
          <button
            id="next"
            type="button"
            className="btn"
            onClick={() => viewerEngine.nextStoryMessage()}
          >
            ⏭ 下一句
          </button>
          <input
            id="seek"
            type="range"
            className="range-slider"
            min={0}
            max={Math.max(100, Math.ceil((snap.storyDuration || 0) * 1000))}
            value={Math.round((snap.storyTime || 0) * 1000)}
            onChange={(e) =>
              viewerEngine.seekStory(Number(e.target.value) / 1000, snap.storyPlaying)
            }
          />
          <span id="time" className="hud-time">
            {(snap.storyTime || 0).toFixed(2)}s / {(snap.storyDuration || 0).toFixed(1)}s
          </span>
          <select
            id="speed"
            className="btn"
            value={snap.storySpeed}
            onChange={(e) => viewerEngine.setStorySpeed(Number(e.target.value))}
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2x</option>
          </select>
          <button
            id="voice"
            type="button"
            className={`btn ${!snap.voiceMuted ? 'active' : ''}`}
            onClick={() => viewerEngine.voiceCtrl.toggleMute()}
          >
            {snap.voiceMuted
              ? '🔇 静音'
              : snap.voiceAutoplayBlocked
                ? '🔈 点击解锁语音'
                : snap.voiceSpeaking
                  ? '🔊 播放中'
                  : '🔊 语音开启'}
          </button>
        </div>
      ) : (
        <div className="viewport-hud-bar">
          <button
            type="button"
            className={`btn ${snap.assetPlaying ? 'active' : 'primary'}`}
            onClick={() => viewerEngine.setAssetPlaying(!snap.assetPlaying)}
          >
            {snap.assetPlaying ? '⏸ 暂停动作' : '▶ 播放动作'}
          </button>
          <button
            type="button"
            className={`btn ${snap.assetLoop ? 'active' : ''}`}
            onClick={() => viewerEngine.setAssetLoop(!snap.assetLoop)}
          >
            🔁 循环
          </button>
          <input
            type="range"
            className="range-slider"
            min={0}
            max={Math.max(100, Math.round((snap.assetDuration || 4) * 1000))}
            value={Math.round((snap.assetTime || 0) * 1000)}
            onChange={(e) => viewerEngine.setAssetTime(Number(e.target.value) / 1000)}
          />
          <span className="hud-time">
            {(snap.assetTime || 0).toFixed(2)}s / {(snap.assetDuration || 0).toFixed(2)}s
          </span>
          <select
            className="btn"
            value={snap.assetSpeed}
            onChange={(e) => viewerEngine.setAssetSpeed(Number(e.target.value))}
          >
            <option value={0.25}>0.25x</option>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={1.5}>1.5x</option>
          </select>
        </div>
      )}

      {snap.loading && (
        <div className="viewport-loading">
          <div className="spinner" />
          <div style={{ fontSize: 13, fontWeight: 600 }}>{snap.loadingText || '加载中…'}</div>
        </div>
      )}
    </div>
  );
}
