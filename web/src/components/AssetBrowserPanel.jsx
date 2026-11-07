import React, { useMemo, useState } from 'react';
import { viewerEngine } from '../engine/ViewerEngine.js';
import { ActorTransformControl } from './ActorTransformControl.jsx';

const PRESET_MORPHS = [
  { index: 20, label: '闭眼 (Eye Blink #20)' },
  { index: 22, label: '笑眼 (Smile Eye #22)' },
  { index: 64, label: '口型 A (Open Smile #64)' },
  { index: 44, label: '口型 I (Horiz Open #44)' },
  { index: 47, label: '口型 U (Small Oval #47)' },
  { index: 72, label: '口型 E (Medium Open #72)' },
  { index: 49, label: '口型 O (Round Open #49)' },
];

export function AssetBrowserPanel({ catalog, onCatalogUpdate, snap }) {
  const [subTab, setSubTab] = useState('model'); // 'model' | 'motion' | 'facial'
  const [selectedActorId, setSelectedActorId] = useState('amao');
  const [costumeFilter, setCostumeFilter] = useState('all');
  const [costumeSearch, setCostumeSearch] = useState('');
  const [sceneFilter, setSceneFilter] = useState('all');
  const [sceneSearch, setSceneSearch] = useState('');
  const [motionTag, setMotionTag] = useState('all');
  const [motionSearch, setMotionSearch] = useState('');
  const [facialSearch, setFacialSearch] = useState('');
  const [morphValues, setMorphValues] = useState({});
  const actors = catalog?.actors || [];
  const activeActor = useMemo(
    () => actors.find((a) => a.id === selectedActorId) || actors[0] || null,
    [actors, selectedActorId],
  );

  const filteredBodies = useMemo(() => {
    if (!activeActor) return [];
    return activeActor.bodies.filter((b) => {
      if (costumeFilter === 'cached' && !b.cached) return false;
      if (costumeFilter !== 'all' && costumeFilter !== 'cached' && b.category !== costumeFilter) {
        return false;
      }
      if (costumeSearch && !b.name.toLowerCase().includes(costumeSearch.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [activeActor, costumeFilter, costumeSearch]);

  const environments = useMemo(() => {
    const raw = catalog?.environments || [];
    return raw.map((item) => {
      if (typeof item === 'string') {
        const is2d = item.startsWith('env_2d_');
        const parts = item.split('_');
        return {
          name: item,
          type: is2d ? '2d' : '3d',
          category: parts[2] || 'other',
          timeOfDay: '',
          label: item,
          cached: true,
        };
      }
      return item;
    });
  }, [catalog]);

  const filteredEnvironments = useMemo(() => {
    const q = sceneSearch.trim().toLowerCase();
    return environments.filter((env) => {
      if (sceneFilter === '3d' && env.type !== '3d') return false;
      if (sceneFilter === '2d' && env.type !== '2d') return false;
      if (sceneFilter === 'adv' && env.category !== 'adv') return false;
      if (sceneFilter === 'live' && env.category !== 'live') return false;
      if (
        sceneFilter === 'lesson_prod' &&
        env.category !== 'lesson' &&
        env.category !== 'prod' &&
        env.category !== 'home'
      ) {
        return false;
      }
      if (q && !env.name.toLowerCase().includes(q) && !env.label.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [environments, sceneFilter, sceneSearch]);

  const filteredBodyMotions = useMemo(() => {
    const list = catalog?.bodyMotions || [];
    return list.filter((m) => {
      if (motionTag === 'cached' && !m.cached) return false;
      if (motionTag !== 'all' && motionTag !== 'cached' && m.tag !== motionTag) return false;
      if (motionSearch && !m.name.toLowerCase().includes(motionSearch.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [catalog, motionTag, motionSearch]);

  const filteredFacialMotions = useMemo(() => {
    const list = catalog?.facialMotions || [];
    return list.filter((m) => {
      if (facialSearch && !m.name.toLowerCase().includes(facialSearch.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [catalog, facialSearch]);

  const resolveFaceAndHairForBody = (actor, bodyBundleName) => {
    const bodyCode = bodyBundleName.split('-').slice(1).join('-').replace(/_body$/, '');
    const face =
      actor.faces.find((f) => f.code === bodyCode)?.name ||
      actor.faces.find((f) => f.code === 'base-0000' && f.cached)?.name ||
      actor.faces.find((f) => f.code === 'base-0000')?.name ||
      actor.faces.find((f) => f.cached)?.name ||
      actor.faces[0]?.name ||
      snap.currentParts.face;
    const hair =
      actor.hairs.find((h) => h.code === bodyCode)?.name ||
      actor.hairs.find((h) => h.code === 'base-0000' && h.cached)?.name ||
      actor.hairs.find((h) => h.code === 'base-0000')?.name ||
      actor.hairs.find((h) => h.cached)?.name ||
      actor.hairs[0]?.name ||
      snap.currentParts.hair;
    return { face, hair };
  };

  const handleSelectActor = async (actor) => {
    if (!actor) return;
    setSelectedActorId(actor.id);
    const defaultBody =
      actor.bodies.find((b) => b.cached && b.category === 'casl') ||
      actor.bodies.find((b) => b.cached) ||
      actor.bodies.find((b) => b.code === 'casl-0000') ||
      actor.bodies.find((b) => b.category === 'casl') ||
      actor.bodies[0];
    if (!defaultBody) return;
    const { face, hair } = resolveFaceAndHairForBody(actor, defaultBody.name);
    const updated = await viewerEngine.loadCharacterParts({
      body: defaultBody.name,
      face,
      hair,
    });
    if (updated && onCatalogUpdate) onCatalogUpdate(updated);
  };

  const handleSelectBody = async (bodyBundleName) => {
    if (!activeActor) return;
    const { face, hair } = resolveFaceAndHairForBody(activeActor, bodyBundleName);
    const updated = await viewerEngine.loadCharacterParts({
      body: bodyBundleName,
      face,
      hair,
    });
    if (updated && onCatalogUpdate) onCatalogUpdate(updated);
  };

  const handleSelectHair = async (hairBundleName) => {
    const updated = await viewerEngine.loadCharacterParts({
      ...snap.currentParts,
      hair: hairBundleName,
    });
    if (updated && onCatalogUpdate) onCatalogUpdate(updated);
  };

  const handleSelectFace = async (faceBundleName) => {
    const updated = await viewerEngine.loadCharacterParts({
      ...snap.currentParts,
      face: faceBundleName,
    });
    if (updated && onCatalogUpdate) onCatalogUpdate(updated);
  };


  const handleSelectScene = async (sceneName) => {
    const updated = await viewerEngine.setAssetScene(sceneName);
    if (updated && onCatalogUpdate) onCatalogUpdate(updated);
  };

  const activeSceneName =
    snap.assetSceneName ||
    (snap.assetStageMode === 'classroom' ? 'env_3d_adv_classroom-00-00-noon' : 'studio');
  return (
    <>
      <div className="subnav-bar">
        <button
          type="button"
          className={`subnav-btn ${subTab === 'scene' ? 'active' : ''}`}
          onClick={() => setSubTab('scene')}
        >
          🏞 舞台场景
        </button>
        <button
          type="button"
          className={`subnav-btn ${subTab === 'model' ? 'active' : ''}`}
          onClick={() => setSubTab('model')}
        >
          👗 建模与服饰
        </button>
        <button
          type="button"
          className={`subnav-btn ${subTab === 'motion' ? 'active' : ''}`}
          onClick={() => setSubTab('motion')}
        >
          💃 身体动作
        </button>
        <button
          type="button"
          className={`subnav-btn ${subTab === 'facial' ? 'active' : ''}`}
          onClick={() => setSubTab('facial')}
        >
          😊 表情与物理
        </button>
      </div>

      <div className="pane-scroll">
        {subTab === 'scene' && (
          <>
            <ActorTransformControl snap={snap} mode="asset" />
            <div className="section-card">
            <div className="section-header">
              <span className="section-title">场景选择 (Stage / Scene)</span>
              <span className="section-count">{filteredEnvironments.length + 1} 项</span>
            </div>
            <input
              type="text"
              className="search-input"
              placeholder="搜索场景 (如 教室, 宿舍, live, night)…"
              value={sceneSearch}
              onChange={(e) => setSceneSearch(e.target.value)}
            />
            <div className="pill-row">
              {[
                { id: 'all', label: '全部' },
                { id: '3d', label: '3D 舞台' },
                { id: '2d', label: '2D 背景' },
                { id: 'adv', label: '剧情' },
                { id: 'live', label: 'Live' },
                { id: 'lesson_prod', label: '课程/培育' },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`pill-btn ${sceneFilter === f.id ? 'active' : ''}`}
                  onClick={() => setSceneFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="item-list tall">
              <button
                type="button"
                className={`item-row ${activeSceneName === 'studio' ? 'active' : ''}`}
                onClick={() => handleSelectScene('studio')}
              >
                <div className="item-main">
                  <div className="item-title">🌑 摄影棚暗场 (Studio)</div>
                  <div className="item-sub">默认纯色暗场 · 标准打光</div>
                </div>
                <span className="badge tag">暗场</span>
              </button>
              {filteredEnvironments.map((env) => (
                <button
                  key={env.name}
                  type="button"
                  className={`item-row ${activeSceneName === env.name ? 'active' : ''}`}
                  onClick={() => handleSelectScene(env.name)}
                >
                  <div className="item-main">
                    <div className="item-title">{env.label}</div>
                    <div className="item-sub">{env.name}</div>
                  </div>
                  <span className={`badge ${env.type === '3d' ? 'cached' : 'cloud'}`}>
                    {env.type.toUpperCase()}
                  </span>
                </button>
              ))}
            </div>
            </div>
          </>
        )}

        {subTab === 'model' && (
          <>
            {/* Character Selector */}
            <div className="section-card">
              <div className="section-header">
                <span className="section-title">角色选择 (Idol / Actor)</span>
                <span className="section-count">{actors.length} 名角色</span>
              </div>
              <div className="actor-grid">
                {actors.map((actor) => {
                  const cachedCount = actor.bodies.filter((b) => b.cached).length;
                  return (
                    <button
                      key={actor.id}
                      type="button"
                      className={`actor-chip ${actor.id === activeActor?.id ? 'active' : ''}`}
                      onClick={() => handleSelectActor(actor)}
                    >
                      <span className="actor-dot" style={{ background: actor.color }} />
                      <div className="actor-chip-info">
                        <div className="actor-chip-name">{actor.ja}</div>
                        <div className="actor-chip-meta">
                          {actor.id} · {actor.bodies.length} 套服饰
                          {cachedCount > 0 ? ` (${cachedCount} 已缓存)` : ''}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Costume / Body Selector */}
            <div className="section-card">
              <div className="section-header">
                <span className="section-title">服饰建模 (Body Costumes)</span>
                <span className="section-count">{filteredBodies.length} 项</span>
              </div>
              <input
                type="text"
                className="search-input"
                placeholder="搜索服饰代码 (如 casl, cstm-0004, trng)…"
                value={costumeSearch}
                onChange={(e) => setCostumeSearch(e.target.value)}
              />
              <div className="pill-row">
                {[
                  { id: 'all', label: '全部' },
                  { id: 'cached', label: '已缓存' },
                  { id: 'casl', label: '私服' },
                  { id: 'cstm', label: '演出服' },
                  { id: 'trng', label: '训练服' },
                  { id: 'schl', label: '制服' },
                  { id: 'spcs', label: '特殊' },
                ].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`pill-btn ${costumeFilter === f.id ? 'active' : ''}`}
                    onClick={() => setCostumeFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="item-list">
                {filteredBodies.map((b) => (
                  <button
                    key={b.name}
                    type="button"
                    className={`item-row ${snap.currentParts.body === b.name ? 'active' : ''}`}
                    onClick={() => handleSelectBody(b.name)}
                  >
                    <div className="item-main">
                      <div className="item-title">{b.label}</div>
                      <div className="item-sub">{b.name}</div>
                    </div>
                    <span className={`badge ${b.cached ? 'cached' : 'cloud'}`}>
                      {b.cached ? '已缓存' : '云端拉取'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Hair & Face Selector */}
            {activeActor && (
              <div className="section-card">
                <div className="section-header">
                  <span className="section-title">发型与头部组件 (Hair & Face)</span>
                  <span className="section-count">
                    {activeActor.hairs.length} 发型 / {activeActor.faces.length} 面部
                  </span>
                </div>
                <div className="control-row">
                  <span className="control-label">当前发型</span>
                  <select
                    className="search-input"
                    value={snap.currentParts.hair}
                    onChange={(e) => handleSelectHair(e.target.value)}
                  >
                    {activeActor.hairs.map((h) => (
                      <option key={h.name} value={h.name}>
                        {h.code} ({h.cached ? '已缓存' : '云端'}) — {h.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="control-row">
                  <span className="control-label">当前面部</span>
                  <select
                    className="search-input"
                    value={snap.currentParts.face}
                    onChange={(e) => handleSelectFace(e.target.value)}
                  >
                    {activeActor.faces.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.code} ({f.cached ? '已缓存' : '云端'}) — {f.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            <ActorTransformControl snap={snap} mode="asset" />
          </>
        )}
        {subTab === 'motion' && (
          <div className="section-card">
            <div className="section-header">
              <span className="section-title">身体动作库 (Body Motions)</span>
              <span className="section-count">{filteredBodyMotions.length} 个动作</span>
            </div>
            <input
              type="text"
              className="search-input"
              placeholder="搜索动作名称 (如 stand, talk-015, glad, odoroku)…"
              value={motionSearch}
              onChange={(e) => setMotionSearch(e.target.value)}
            />
            <div className="pill-row">
              {[
                { id: 'all', label: '全部' },
                { id: 'cached', label: '已缓存' },
                { id: 'stand', label: '待机' },
                { id: 'talk', label: '对话' },
                { id: 'positive', label: '喜悦/点头' },
                { id: 'reaction', label: '惊讶/疑问' },
                { id: 'transition', label: '进出场' },
                { id: 'pose', label: '静态Pose' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`pill-btn ${motionTag === t.id ? 'active' : ''}`}
                  onClick={() => setMotionTag(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="item-list tall">
              {filteredBodyMotions.map((m) => (
                <button
                  key={m.name}
                  type="button"
                  className={`item-row ${snap.assetBodyMotionName === m.name ? 'active' : ''}`}
                  onClick={() => viewerEngine.setAssetBodyMotion(m.name)}
                >
                  <div className="item-main">
                    <div className="item-title">{m.action}</div>
                    <div className="item-sub">
                      {m.owner.toUpperCase()} · {m.name}
                    </div>
                  </div>
                  <span className={`badge ${m.cached ? 'cached' : 'cloud'}`}>
                    {m.cached ? '已缓存' : '云端'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {subTab === 'facial' && (
          <>
            <div className="section-card">
              <div className="section-header">
                <span className="section-title">面部表情剪辑 (Facial Motions)</span>
                <span className="section-count">{filteredFacialMotions.length} 项</span>
              </div>
              <input
                type="text"
                className="search-input"
                placeholder="搜索表情 (如 egao, ikari, yowaki, default)…"
                value={facialSearch}
                onChange={(e) => setFacialSearch(e.target.value)}
              />
              <div className="item-list">
                {filteredFacialMotions.map((m) => (
                  <button
                    key={m.name}
                    type="button"
                    className={`item-row ${snap.assetFacialMotionName === m.name ? 'active' : ''}`}
                    onClick={() => viewerEngine.setAssetFacialMotion(m.name)}
                  >
                    <div className="item-main">
                      <div className="item-title">{m.action.replace(/^facial-all-/, '')}</div>
                      <div className="item-sub">{m.name}</div>
                    </div>
                    <span className={`badge ${m.cached ? 'cached' : 'cloud'}`}>
                      {m.cached ? '已缓存' : '云端'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Manual BlendShape Overrides */}
            <div className="section-card">
              <div className="section-header">
                <span className="section-title">BlendShape 表情/口型微调</span>
                <button
                  type="button"
                  className="pill-btn"
                  onClick={() => {
                    setMorphValues({});
                    viewerEngine.clearAssetManualMorphs();
                  }}
                >
                  重置微调
                </button>
              </div>
              {PRESET_MORPHS.map((pm) => {
                const val = morphValues[pm.index] ?? 0;
                return (
                  <div key={pm.index} className="control-row">
                    <span className="control-label" style={{ minWidth: 145 }}>
                      {pm.label}
                    </span>
                    <input
                      type="range"
                      className="range-slider"
                      min={0}
                      max={100}
                      value={Math.round(val * 100)}
                      onChange={(e) => {
                        const v = Number(e.target.value) / 100;
                        setMorphValues((prev) => ({ ...prev, [pm.index]: v }));
                        viewerEngine.setAssetManualMorph(pm.index, v);
                      }}
                    />
                    <span style={{ width: 34, textAlign: 'right', fontSize: 11 }}>
                      {Math.round(val * 100)}%
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Rig Physics & Stage Options */}
            <div className="section-card">
              <div className="section-header">
                <span className="section-title">解算器与舞台环境 (Rig & Stage)</span>
              </div>
              <div className="pill-row">
                <button
                  type="button"
                  className={`btn ${snap.assetEnableIK ? 'active' : ''}`}
                  onClick={() =>
                    viewerEngine.setAssetPhysics({ enableIK: !snap.assetEnableIK })
                  }
                >
                  🖐 手部/手指 IK: {snap.assetEnableIK ? '开启' : '关闭'}
                </button>
                <button
                  type="button"
                  className={`btn ${snap.assetEnableSwing ? 'active' : ''}`}
                  onClick={() =>
                    viewerEngine.setAssetPhysics({ enableSwing: !snap.assetEnableSwing })
                  }
                >
                  🎀 头发/裙摆物理: {snap.assetEnableSwing ? '开启' : '关闭'}
                </button>
              </div>
              <div className="pill-row">
                <button
                  type="button"
                  className={`btn ${activeSceneName === 'studio' ? 'active' : ''}`}
                  onClick={() => handleSelectScene('studio')}
                >
                  🌑 摄影棚暗场
                </button>
                <button
                  type="button"
                  className={`btn ${activeSceneName === 'env_3d_adv_classroom-00-00-noon' ? 'active' : ''}`}
                  onClick={() => handleSelectScene('env_3d_adv_classroom-00-00-noon')}
                >
                  🏫 3D 教室实景
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
