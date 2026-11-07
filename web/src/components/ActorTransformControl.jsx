import React from 'react';
import { viewerEngine } from '../engine/ViewerEngine.js';

const YAW_PRESETS = [
  { label: '正面 0°', value: 0 },
  { label: '左前 -45°', value: -45 },
  { label: '左侧 -90°', value: -90 },
  { label: '右前 +45°', value: 45 },
  { label: '右侧 +90°', value: 90 },
  { label: '背面 180°', value: 180 },
];

export function ActorTransformControl({ snap, mode = 'asset' }) {
  const isStory = mode === 'story';
  const tf = (isStory ? snap.storyActorTransform : snap.assetActorTransform) || {
    x: 0,
    y: 0,
    z: 0,
    rotY: 0,
  };

  const x = Number(tf.x) || 0;
  const y = Number(tf.y) || 0;
  const z = Number(tf.z) || 0;
  const rotY = Number(tf.rotY) || 0;

  const minX = Math.min(-5, Math.floor(x - 2));
  const maxX = Math.max(5, Math.ceil(x + 2));
  const minY = Math.min(-2, Math.floor(y - 1));
  const maxY = Math.max(3, Math.ceil(y + 1));
  const minZ = Math.min(-5, Math.floor(z - 2));
  const maxZ = Math.max(5, Math.ceil(z + 2));

  const updateField = (patch) => {
    viewerEngine.setActorTransform(patch, mode);
  };

  return (
    <div className="section-card">
      <div className="section-header">
        <span className="section-title">
          {isStory ? '人物位置与朝向偏移 (Actor Offset)' : '人物位置与朝向 (Position & Orientation)'}
        </span>
        <div className="pill-row" style={{ gap: 4 }}>
          <button
            type="button"
            className={`pill-btn ${snap.showActorGizmo ? 'active' : ''}`}
            title="在 3D 视口中显示脚底位置/朝向操控环，可直接用鼠标拖拽移动与旋转"
            onClick={() => viewerEngine.setShowActorGizmo(!snap.showActorGizmo)}
          >
            🧭 3D操控环
          </button>
          <button
            type="button"
            className="pill-btn"
            title="重置人物位置与朝向为默认值 (0, 0, 0, 0°)"
            onClick={() => viewerEngine.resetActorTransform(mode)}
          >
            ↺ 重置
          </button>
        </div>
      </div>

      {/* Orientation (Yaw) Control */}
      <div className="control-row">
        <span className="control-label" title="人物水平朝向角度 (Y轴旋转)">
          水平朝向 (°)
        </span>
        <input
          type="range"
          className="range-slider"
          min={-180}
          max={180}
          step={1}
          value={Math.round(rotY)}
          onChange={(e) => updateField({ rotY: Number(e.target.value) })}
        />
        <input
          type="number"
          className="transform-num-input"
          min={-180}
          max={180}
          step={5}
          value={Math.round(rotY)}
          onChange={(e) => updateField({ rotY: Number(e.target.value) })}
        />
      </div>

      <div className="pill-row">
        {YAW_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`pill-btn ${Math.round(rotY) === p.value ? 'active' : ''}`}
            onClick={() => updateField({ rotY: p.value })}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className="pill-btn"
          title="让人物自动转身面向当前摄像机位置"
          onClick={() => viewerEngine.faceActorToCamera()}
        >
          👀 面向镜头
        </button>
      </div>

      {/* Position X / Y / Z Controls */}
      <div className="control-row">
        <span className="control-label" title="水平左右位置 X (米)">
          左右位置 X
        </span>
        <input
          type="range"
          className="range-slider"
          min={minX}
          max={maxX}
          step={0.01}
          value={x}
          onChange={(e) => updateField({ x: Number(e.target.value) })}
        />
        <input
          type="number"
          className="transform-num-input"
          step={0.05}
          value={Number(x.toFixed(2))}
          onChange={(e) => updateField({ x: Number(e.target.value) })}
        />
      </div>

      <div className="control-row">
        <span className="control-label" title="垂直上下高度 Y (米)">
          垂直高度 Y
        </span>
        <input
          type="range"
          className="range-slider"
          min={minY}
          max={maxY}
          step={0.01}
          value={y}
          onChange={(e) => updateField({ y: Number(e.target.value) })}
        />
        <input
          type="number"
          className="transform-num-input"
          step={0.05}
          value={Number(y.toFixed(2))}
          onChange={(e) => updateField({ y: Number(e.target.value) })}
        />
      </div>

      <div className="control-row">
        <span className="control-label" title="前后景深位置 Z (米)">
          前后景深 Z
        </span>
        <input
          type="range"
          className="range-slider"
          min={minZ}
          max={maxZ}
          step={0.01}
          value={z}
          onChange={(e) => updateField({ z: Number(e.target.value) })}
        />
        <input
          type="number"
          className="transform-num-input"
          step={0.05}
          value={Number(z.toFixed(2))}
          onChange={(e) => updateField({ z: Number(e.target.value) })}
        />
      </div>

      {/* Quick Spatial Actions */}
      <div className="pill-row">
        {!isStory && (
          <button
            type="button"
            className="btn"
            style={{ flex: 1, padding: '5px 8px', fontSize: 11 }}
            title="将人物移动到当前摄像机注视的地面中心并面向镜头"
            onClick={() => viewerEngine.placeActorAtCameraTarget()}
          >
            📍 移至当前视角
          </button>
        )}
        <button
          type="button"
          className="btn"
          style={{ flex: 1, padding: '5px 8px', fontSize: 11 }}
          title="将摄像机焦点对准人物当前所在位置"
          onClick={() => viewerEngine.focusCameraOnActor()}
        >
          🎯 镜头聚焦人物
        </button>
        <button
          type="button"
          className="btn"
          style={{ padding: '5px 8px', fontSize: 11 }}
          title="向左旋转 15° (快捷键 Q)"
          onClick={() => viewerEngine.rotateActorBy(-15, mode)}
        >
          ↶ -15°
        </button>
        <button
          type="button"
          className="btn"
          style={{ padding: '5px 8px', fontSize: 11 }}
          title="向右旋转 15° (快捷键 E)"
          onClick={() => viewerEngine.rotateActorBy(15, mode)}
        >
          ↷ +15°
        </button>
      </div>

      {snap.showActorGizmo && (
        <div className="transform-gizmo-hint">
          💡 视口操控已开启：可直接拖拽人物脚底 <b>蓝盘/箭头</b> 移动位置，拖拽 <b>粉圈</b> 旋转朝向；也可用键盘 <b>WASD</b> 移动、<b>Q/E</b> 旋转。
        </div>
      )}
    </div>
  );
}
