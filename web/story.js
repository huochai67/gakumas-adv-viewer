// Offline ADV story player.
//
// Consumes the game's own ADV script (assets/script.txt or ?script=...),
// the exported 3D stage (assets/env.glb + env.json), 2D backgrounds (bg.json),
// and the authentic Campus/Actor/Default character renderer.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadCharacter } from './char.js';
import { getClip, evalClip } from './clips.js';
import { parseAdv, buildTimeline } from './adv.js';
import { applyCameraSetting, unityEulerQuat } from './camera.js';
import { createBloom } from './bloom.js';
import { TPOSE_MUSCLES } from './pose.js';

const params = new URLSearchParams(location.search);
const SCRIPT_URL = params.get('script') || './assets/script.txt';
const HIDE_HUD = params.get('hud') === '0';
const USER_NAME = 'プロデューサー';
const ACTOR_ID = 'amao';
const STAND_MOTION = 'mot_all_chr_cmmn_stand-001_lp';
const BLINK_MORPH_INDEX = 20; // b_eye.eye_001 (closed eyelids)
const CHARS_PER_SEC = 24;

if (HIDE_HUD) {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
}

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1000);
camera.position.set(0, 1.3, -1.6);

// Stage lights illuminate dynamic (non-lightmapped) 3D props only;
// Campus/Actor/Default and lightmapped MeshBasicMaterial are unaffected.
const sunLight = new THREE.DirectionalLight(0xfffaf0, 2.1);
sunLight.position.set(2.5, 4.5, -4.0);
scene.add(sunLight);
const stageHemi = new THREE.HemisphereLight(0xf6f4ee, 0x9e9284, 1.45);
scene.add(stageHemi);

// Soft actor contact shadow on the 3D stage floor
function blobTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(28,20,18,0.48)');
  grad.addColorStop(0.55, 'rgba(28,20,18,0.18)');
  grad.addColorStop(1, 'rgba(28,20,18,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const groundShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(0.68, 0.52),
  new THREE.MeshBasicMaterial({
    map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.72,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }),
);
groundShadow.rotation.x = -Math.PI / 2;
groundShadow.position.y = 0.004;
groundShadow.renderOrder = 4;
groundShadow.visible = false;
scene.add(groundShadow);

const actorGroup = new THREE.Group();
scene.add(actorGroup);
const envGroup = new THREE.Group();
envGroup.visible = false;
scene.add(envGroup);

const bloomParam = params.get('bloom');
const bloomStrength = bloomParam !== null ? parseFloat(bloomParam) : 0.32;
const bloom = bloomStrength > 0
  ? createBloom(renderer, {
      strength: bloomStrength,
      threshold: 0.98,
      knee: 0.25,
      exposure: 0.97,
      contrast: 1.04,
      saturation: 1.06,
    })
  : null;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (bloom) bloom.setSize(w, h);
}
addEventListener('resize', resize);
resize();

// ---------- stage (3D classroom + lightmap + dynamic props + decals + skybox) ----------
let skyTexture = null;

async function loadEnv() {
  const meta = await (await fetch('./assets/env.json')).json();
  const gltf = await new GLTFLoader().loadAsync('./assets/env.glb');
  const loader = new THREE.TextureLoader();

  let lmap = null;
  if (meta.lightmap && meta.lightmap.light) {
    lmap = await loader.loadAsync('./assets/' + meta.lightmap.light).catch((e) => {
      console.warn('lightmap load failed', e);
      return null;
    });
    if (lmap) {
      lmap.flipY = true;
      lmap.colorSpace = THREE.SRGBColorSpace;
      lmap.channel = 1;
      lmap.needsUpdate = true;
    }
  }

  if (meta.skybox) {
    skyTexture = await loader.loadAsync('./assets/' + meta.skybox).catch(() => null);
    if (skyTexture) {
      skyTexture.mapping = THREE.EquirectangularReflectionMapping;
      skyTexture.colorSpace = THREE.SRGBColorSpace;
    }
  }

  // Configure stage lighting for non-lightmapped 3D props from RenderSettings & Directional Light
  if (meta.renderSettings) {
    const rs = meta.renderSettings;
    if (rs.ambientSkyColor) stageHemi.color.setRGB(...rs.ambientSkyColor);
    if (rs.ambientGroundColor) stageHemi.groundColor.setRGB(...rs.ambientGroundColor);
    stageHemi.intensity = 1.55;
  }
  if (Array.isArray(meta.lights)) {
    const dirL = meta.lights.find((l) => l.type === 1);
    if (dirL && dirL.direction) {
      sunLight.color.setRGB(...dirL.color);
      // Light shines ALONG direction, so Three.js light position is -direction
      sunLight.position.set(-dirL.direction[0] * 10, -dirL.direction[1] * 10, -dirL.direction[2] * 10);
      sunLight.intensity = 2.0;
    }
  }

  const lmVolIntensity = (meta.volumes && meta.volumes.lightmap && meta.volumes.lightmap.intensity) ?? 0.95;
  // Three.js MeshBasicMaterial multiplies lightMapIntensity by RECIPROCAL_PI (1 / Math.PI)!
  // Multiply by Math.PI * 1.45 to cancel RECIPROCAL_PI and match native URP baked irradiance.
  const lmScale = 1.45 * Math.PI * lmVolIntensity;
  const defTexCache = new Map();
  const loadStageDef = (rel) => {
    if (!rel) return null;
    if (defTexCache.has(rel)) return defTexCache.get(rel);
    const t = loader.load('./assets/' + rel);
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    defTexCache.set(rel, t);
    return t;
  };
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry && o.geometry.attributes.uv2 && !o.geometry.attributes.uv1) {
      o.geometry.setAttribute('uv1', o.geometry.attributes.uv2);
    }
    const exactName = o.name.replace(/^env_/, '');
    const strippedName = exactName.replace(/_\d+$/, '');
    const parentName = (o.parent && o.parent.name ? o.parent.name.replace(/^env_/, '') : '');
    const info = meta.prims[exactName] || meta.prims[parentName] || meta.prims[strippedName] || {};
    const matName = info.material || exactName.split('|')[0] || '';
    const mdesc = (meta.materials && meta.materials[matName]) || { colors: {}, floats: {} };

    const src = o.material;
    const albedo = src && src.map ? src.map : null;
    if (albedo) {
      albedo.colorSpace = THREE.SRGBColorSpace;
      albedo.anisotropy = 4;
    }

    const bc = mdesc.colors._BaseColor || mdesc.colors._Color || [1, 1, 1, 1];
    const ovr = info.overrideColor || [1, 1, 1, 1];
    const tint = new THREE.Color(bc[0] * ovr[0], bc[1] * ovr[1], bc[2] * ovr[2]);
    const alphaFactor = (bc[3] ?? 1) * (ovr[3] ?? 1);

    const fl = mdesc.floats || {};
    const alphaClip = (fl._AlphaClip ?? 0) >= 0.5;
    const isGlass = /glass|window/i.test(matName);
    const isBlend = isGlass || /_trs|_alp/i.test(matName) || fl._Surface === 1 || fl._DstBlend === 10;
    const side = fl._Cull === 0 ? THREE.DoubleSide : THREE.FrontSide;

    const ec = mdesc.colors._EmissionColor || [0, 0, 0, 1];
    const emMax = Math.max(ec[0] || 0, ec[1] || 0, ec[2] || 0);
    const defRel = mdesc.maps && mdesc.maps._DefMap;
    const defMap = (emMax > 0.5 && defRel) ? loadStageDef(defRel) : null;

    let mat;
    if (info.lightmap && lmap) {
      mat = new THREE.MeshBasicMaterial({
        name: matName,
        map: albedo,
        color: tint,
        lightMap: lmap,
        lightMapIntensity: lmScale,
        side,
        transparent: isBlend,
        opacity: isBlend ? alphaFactor : 1.0,
        alphaTest: alphaClip ? (fl._Cutoff ?? 0.5) : 0,
        depthWrite: !isBlend,
      });
    } else {
      // Dynamic non-lightmapped 3D stage props (teapots, cups, chairs, desk props, curtains)
      mat = new THREE.MeshStandardMaterial({
        name: matName,
        map: albedo,
        color: tint,
        roughness: 0.68,
        metalness: 0.04,
        envMap: isGlass ? null : (skyTexture || null),
        envMapIntensity: isGlass ? 0.0 : 0.4,
        side,
        transparent: isBlend,
        opacity: isBlend ? alphaFactor : 1.0,
        alphaTest: alphaClip ? (fl._Cutoff ?? 0.5) : 0,
        depthWrite: !isBlend,
      });
    }
    // Add HDR emission from _DefMap.g * _EmissionColor (fluorescent ceiling lamps, LEDs)
    if (defMap && emMax > 0.5) {
      const emVec = new THREE.Vector3(ec[0], ec[1], ec[2]);
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uStageDef = { value: defMap };
        shader.uniforms.uStageEmissive = { value: emVec };
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D uStageDef;\nuniform vec3 uStageEmissive;')
          .replace(
            '#include <opaque_fragment>',
            '#ifdef USE_MAP\n\toutgoingLight += texture2D(uStageDef, vMapUv).g * uStageEmissive;\n\t#endif\n\t#include <opaque_fragment>',
          );
      };
      mat.customProgramCacheKey = () => `emis-${matName}`;
    }
    if (isBlend) o.renderOrder = 2;
    o.material = mat;
  });
  envGroup.add(gltf.scene);

  // Build DecalProjector quads (whiteboard drawings, blackboard chalk, monitor, prop contact shadows)
  const decalTexCache = new Map();
  const loadDecalTex = (rel) => {
    if (decalTexCache.has(rel)) return decalTexCache.get(rel);
    const t = loader.load('./assets/' + rel);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    decalTexCache.set(rel, t);
    return t;
  };
  for (const d of (meta.decals || [])) {
    if (!d.map || !d.positions || d.fade <= 0.005) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(d.positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(d.uvs, 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.computeVertexNormals();
    const dmat = new THREE.MeshBasicMaterial({
      name: d.material,
      map: loadDecalTex(d.map),
      color: new THREE.Color(...(d.color || [1, 1, 1])),
      transparent: true,
      opacity: Math.min(1, d.fade),
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2 - (d.priority || 0),
      polygonOffsetUnits: -2 - (d.priority || 0),
    });
    const dm = new THREE.Mesh(geo, dmat);
    dm.renderOrder = (d.isShadow ? 1 : 3) + (d.priority || 0);
    envGroup.add(dm);
  }

  return { meta, group: gltf.scene };
}

/** Screen shake: damped oscillation over the cue window (strength is in px). */
function shakeAt(st, t) {
  for (let i = st.shakes.length - 1; i >= 0; i--) {
    const s = st.shakes[i];
    if (t < s.start || t >= s.start + s.dur) continue;
    const d = t - s.start;
    const u = d / s.dur;
    const amp = ((s.setting.strength ?? 8) / 540) * (1 - u) * (1 - u);
    const f = 1 / Math.max(0.02, s.setting.interval ?? 0.05);
    return {
      yaw: Math.cos(2 * Math.PI * f * d) * amp,
      pitch: Math.sin(2 * Math.PI * f * 1.37 * d) * amp * 0.6,
    };
  }
  return null;
}

function mixLook(a, b, u) {
  const L = (k, d = 0) => ((a && a[k]) ?? d) * (1 - u) + ((b && b[k]) ?? d) * u;
  return {
    azimuth: L('azimuth'), elevation: L('elevation'), weight: L('weight'),
    headWeight: L('headWeight', 1), bodyWeight: L('bodyWeight'),
  };
}

function lookAtTime(st, t) {
  let cur = null;
  for (const l of st.looks) {
    if (t < l.start) break;
    const u = l.dur > 0 ? Math.min(1, (t - l.start) / l.dur) : 1;
    const from = l.from || cur;
    cur = from ? mixLook(from, l.to, u) : (l.to || null);
  }
  return cur;
}

function rotateBoneWorld(bone, yaw, pitch) {
  bone.updateWorldMatrix(true, false);
  const pw = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(pw);
  const w = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  bone.quaternion.premultiply(pw.clone().invert().multiply(w).multiply(pw));
  bone.updateMatrixWorld(true);
}

function applyLookTarget(char, st, t) {
  const l = lookAtTime(st, t);
  if (!char || !l || !(l.weight > 0.001)) return;
  const head = char.solver.nameToNode.Head;
  if (!head) return;
  const D2R = Math.PI / 180;
  const hw = l.headWeight * l.weight;
  const pitch = l.elevation * D2R * hw;
  const yaw = -l.azimuth * D2R * hw;
  const chest = char.solver.nameToNode.Chest
    || char.solver.nameToNode.Spine2 || char.solver.nameToNode.Spine1;
  if (chest && l.bodyWeight > 0) {
    const bw = l.bodyWeight * l.weight;
    rotateBoneWorld(chest, -l.azimuth * D2R * bw, l.elevation * D2R * bw);
  }
  rotateBoneWorld(head, yaw, pitch);
}

function hash01(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function lerp(a, b, w) { return a + (b - a) * w; }

function lerpArr(a, b, w) {
  if (!a) return b;
  if (!b) return a;
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * (1 - w) + b[i] * w;
  return out;
}

function nlerpQuat(a, b, w) {
  if (!a) return b;
  if (!b) return a;
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  const x = a[0] * (1 - w) + b[0] * s * w;
  const y = a[1] * (1 - w) + b[1] * s * w;
  const z = a[2] * (1 - w) + b[2] * s * w;
  const qw = a[3] * (1 - w) + b[3] * s * w;
  const l = Math.hypot(x, y, z, qw) || 1;
  return [x / l, y / l, z / l, qw / l];
}

function blendRoot(ra, rb, w) {
  if (!ra || !Object.keys(ra).length) return rb || null;
  if (!rb || !Object.keys(rb).length) return ra || null;
  return {
    rootT: lerpArr(ra.rootT, rb.rootT, w),
    rootQ: nlerpQuat(ra.rootQ, rb.rootQ, w),
    lfT: lerpArr(ra.lfT, rb.lfT, w),
    rfT: lerpArr(ra.rfT, rb.rfT, w),
    lhQ: nlerpQuat(ra.lhQ, rb.lhQ, w),
    rhQ: nlerpQuat(ra.rhQ, rb.rhQ, w),
  };
}

class Player {
  constructor(timeline, char) {
    this.timeline = timeline;
    this.char = char;
    this.clips = new Map();
    this.baseClip = null;
    this.baseRef0 = null;
    this.baseTime = 0;
    this.defaultBg = [...timeline.backgrounds.keys()][0] || null;
  }

  async preload() {
    const names = new Set([STAND_MOTION]);
    for (const c of this.timeline.cues) {
      if (c.type === 'actormotion' || c.type === 'actorfacialmotion'
          || c.type === 'actoradditivemotion') {
        if (c.params.id && c.params.id !== ACTOR_ID) continue;
        if (c.params.motion) names.add(c.params.motion);
      }
    }
    const candidates = new Set();
    for (const n of names) for (const c of [n, `${n}_b`, `${n}_f`]) candidates.add(c);
    const queue = [...candidates];
    const worker = async () => {
      while (queue.length) {
        const n = queue.pop();
        try { this.clips.set(n, await getClip(n)); } catch { this.clips.set(n, null); }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    this.baseClip = this.clipOf(STAND_MOTION, 'b');
    this.baseRef0 = this.baseClip ? evalClip(this.baseClip, 0) : null;
    this.baseTime = this.baseClip ? this.baseClip.duration : 0;
    const want = [...names].filter((n) => !this.clipOf(n, 'b') && !this.clipOf(n, 'f'));
    return { total: names.size, missing: want };
  }

  stateAt(t) {
    const st = {
      bgActive: this.defaultBg, bgSet: new Map(), camera: null,
      layout: null, actorVisible: true,
      motion: null, prevMotion: null, facial: null, prevFacial: null,
      overrides: [], additive: [], shakes: [], looks: [], transitions: [],
      message: null, fade: { from: 0, to: 0, t: 0, dur: 0, color: '#000000' },
    };
    for (const c of this.timeline.cues) {
      if (c.t > t) break;
      const p = c.params;
      switch (c.type) {
        case 'backgroundlayoutgroup': {
          const l = (c.all.layouts || []).flat()[0];
          if (l && l.params.id) st.bgActive = l.params.id;
          break;
        }
        case 'backgroundsetting': {
          if (p.id) st.bgSet.set(p.id, p.setting || null);
          if (!st.bgActive && p.id) st.bgActive = p.id;
          break;
        }
        case 'camerasetting':
          st.camera = p.setting;
          break;
        case 'actorlayoutgroup': {
          const layouts = (c.all.layouts || []).flat();
          const mine = layouts.find((l) => !l.params.id || l.params.id === ACTOR_ID);
          if (mine) {
            st.actorVisible = true;
            if (mine.params.transform) st.layout = mine.params.transform;
          } else if (layouts.length > 0) {
            st.actorVisible = false;
          }
          break;
        }
        case 'actormotion': {
          if (p.id && p.id !== ACTOR_ID) break;
          st.prevMotion = st.motion;
          st.motion = {
            name: p.motion, variant: 'b', start: c.t, clipIn: c.clipIn,
            transition: Number(p.transition ?? 0),
          };
          break;
        }
        case 'actorfacialmotion': {
          if (p.id && p.id !== ACTOR_ID) break;
          st.prevFacial = st.facial;
          st.facial = {
            name: p.motion, variant: 'f', start: c.t, clipIn: c.clipIn,
            transition: Number(p.transition ?? 0),
          };
          break;
        }
        case 'actorfacialoverridemotion': {
          if (p.id && p.id !== ACTOR_ID) break;
          const models = (p.setting && p.setting.faceModels) || [];
          const clipMeta = p.clip || {};
          st.overrides.push({
            start: c.t,
            dur: c.dur,
            easeIn: Number(clipMeta._easeInDuration ?? 0),
            easeOut: Number(clipMeta._easeOutDuration ?? 0),
            models,
          });
          break;
        }
        case 'actoradditivemotion': {
          if (p.id && p.id !== ACTOR_ID) break;
          st.additive.push({ name: p.motion, start: c.t, clipIn: c.clipIn });
          break;
        }
        case 'transition':
          if (p.type) st.transitions.push({ start: c.t, dur: c.dur || 0.2, type: p.type });
          break;
        case 'shake':
          st.shakes.push({ start: c.t, dur: c.dur, setting: p.setting || {} });
          break;
        case 'actorlooktargettween': {
          if (p.id && p.id !== ACTOR_ID) break;
          const prev = st.looks.length ? st.looks[st.looks.length - 1].to : null;
          st.looks.push({ start: c.t, dur: c.dur || 0.01, from: p.from || prev, to: p.to || null });
          break;
        }
        case 'message':
          if (t < c.t + c.dur) {
            st.message = { text: p.text, name: p.name, hide: p.hide, start: c.t, narration: false };
          }
          break;
        case 'narration':
          if (t < c.t + c.dur && !p.hide) {
            st.message = { text: p.text, name: '', hide: true, start: c.t, narration: true };
          }
          break;
        case 'fade': {
          const rawCol = String(p.color || '#000000');
          st.fade = {
            from: Number(p.from ?? 0),
            to: Number(p.to ?? 1),
            t: c.t,
            dur: c.dur,
            color: rawCol.startsWith('#') ? rawCol.slice(0, 7) : '#000000',
          };
          break;
        }
        default:
          break;
      }
    }
    return st;
  }

  clipOf(name, variant) {
    if (!name) return null;
    return (variant && this.clips.get(`${name}_${variant}`))
      || this.clips.get(name)
      || this.clips.get(`${name}_b`)
      || this.clips.get(`${name}_f`)
      || null;
  }

  applyCharacter(t, st) {
    actorGroup.visible = st.actorVisible;
    if (!st.actorVisible) return;

    const { solver } = this.char;
    const evalOf = (m) => {
      if (!m) return null;
      const clip = this.clipOf(m.name, m.variant);
      if (!clip) return null;
      const isLoop = m.name.endsWith('_lp');
      const elapsed = Math.max(0, t - m.start + (m.clipIn || 0));
      const lt = isLoop && clip.duration > 0 ? (elapsed % clip.duration) : Math.min(clip.duration, elapsed);
      return { ev: evalClip(clip, lt), clip, elapsed };
    };

    const base = this.baseClip
      ? evalClip(this.baseClip, this.baseTime > 0 ? (t % this.baseTime) : 0)
      : null;

    const curM = evalOf(st.motion);
    const prevM = evalOf(st.prevMotion);
    let w = 1;
    if (curM && st.motion.transition > 0) {
      const u = Math.min(1, Math.max(0, (t - st.motion.start) / st.motion.transition));
      w = u * u * (3 - 2 * u); // smoothstep cross-fade
    }

    const muscles = new Float32Array(95);
    let root = null;
    const bones = [];

    if (curM) {
      const ce = curM.ev;
      const pe = prevM ? prevM.ev : base;
      for (let i = 0; i < 95; i++) {
        const cv = ce.hasMuscle[i] ? ce.muscles[i] : (base ? base.muscles[i] : TPOSE_MUSCLES[i]);
        const pv = pe && pe.hasMuscle[i] ? pe.muscles[i] : cv;
        muscles[i] = pv * (1 - w) + cv * w;
      }
      root = (pe && w < 1) ? blendRoot(pe.root, ce.root, w) : ce.root;
      bones.push(...ce.bones);

      // Subtle alive breathing from stand-001_lp delta after a non-looping gesture settles
      if (base && this.baseRef0 && curM.elapsed > curM.clip.duration) {
        const settle = Math.min(1, (curM.elapsed - curM.clip.duration) / 0.6) * 0.45;
        for (let i = 0; i < 95; i++) {
          muscles[i] += (base.muscles[i] - this.baseRef0.muscles[i]) * settle;
        }
      }
    } else if (base) {
      muscles.set(base.muscles);
      root = base.root;
      bones.push(...base.bones);
    } else {
      muscles.set(TPOSE_MUSCLES);
    }

    // Additive gesture clips (e.g., nod): subtract clip's own t=0 reference pose!
    for (const a of st.additive) {
      const clip = this.clipOf(a.name, 'b');
      if (!clip) continue;
      const lt = t - a.start + (a.clipIn || 0);
      if (lt < 0 || lt > clip.duration) continue;
      const ev = evalClip(clip, lt);
      const ref0 = evalClip(clip, 0);
      const fade = Math.min(1, lt / 0.12, (clip.duration - lt) / 0.12);
      if (fade <= 0) continue;
      for (let i = 0; i < 95; i++) {
        if (ev.hasMuscle[i]) muscles[i] += (ev.muscles[i] - ref0.muscles[i]) * fade;
      }
    }

    solver.applyPose(null, solver.poseFrom(muscles, bones, root), 1);

    // ---------- Facial morphs + timed overrides + real 3D eyelid blink ----------
    const morph = new Map();
    const curF = evalOf(st.facial);
    const prevF = evalOf(st.prevFacial);
    // Also check if body motion carries a matching _f facial clip when no explicit facial cue fired
    const fallbackF = !curF && st.motion ? evalOf({ ...st.motion, variant: 'f' }) : null;
    const activeF = curF || fallbackF;
    if (activeF) {
      const fw = (curF && prevF && st.facial.transition > 0)
        ? Math.min(1, Math.max(0, (t - st.facial.start) / st.facial.transition))
        : 1;
      if (prevF && fw < 1) {
        for (const [i, v] of prevF.ev.morph) morph.set(i, v * (1 - fw));
      }
      for (const [i, v] of activeF.ev.morph) {
        morph.set(i, (morph.get(i) || 0) + v * fw);
      }
    }

    for (const o of st.overrides) {
      if (t < o.start || t > o.start + o.dur) continue;
      let ow = 1;
      if (o.easeIn > 0) ow = Math.min(ow, (t - o.start) / o.easeIn);
      if (o.easeOut > 0) ow = Math.min(ow, (o.start + o.dur - t) / o.easeOut);
      ow = Math.max(0, Math.min(1, ow));
      for (const m of o.models) {
        if (m.path === 'Root_Face') {
          morph.set(m.index, Math.max(morph.get(m.index) || 0, m.value * ow));
        }
      }
    }

    // Periodic real 3D eyelid blink (only when eyes aren't already morphed closed/smiling)
    let eyeBusy = 0;
    for (let ei = 20; ei <= 38; ei++) eyeBusy += morph.get(ei) || 0;
    if (eyeBusy < 0.12 && params.get('blink') !== '0') {
      const period = 3.6 + 0.9 * hash01(Math.floor(t / 3.6));
      const x = t % period;
      if (x > 1.4 && x < 1.53) {
        const closed = Math.sin(((x - 1.4) / 0.13) * Math.PI);
        morph.set(BLINK_MORPH_INDEX, Math.max(morph.get(BLINK_MORPH_INDEX) || 0, closed));
      }
    }

    this.char.setMorph(morph);

    const L = st.layout;
    if (L) {
      actorGroup.position.set(L.position.x, L.position.y, -L.position.z);
      actorGroup.quaternion.copy(unityEulerQuat(L.rotation.x, L.rotation.y, L.rotation.z));
      const s = L.scale || { x: 1, y: 1, z: 1 };
      actorGroup.scale.set(s.x, s.y, s.z);
    }
  }
}

// ---------- UI ----------
const msgEl = document.getElementById('msg');
const nameEl = msgEl.querySelector('.name');
const textEl = msgEl.querySelector('.text');
const fadeEl = document.getElementById('fade');
const statusEl = document.getElementById('status');
const seekEl = document.getElementById('seek');
const timeEl = document.getElementById('time');

const bgEl = document.getElementById('bg2d');
const bgImages = new Map();

function stripRuby(s) {
  return String(s || '').replace(/<r=([^>]*)>([^<]*)<\/r>/g, '$2');
}

function applyBackground(t, st, bgMeta) {
  const src = st.bgActive ? (timeline.backgrounds.get(st.bgActive) || {}).src : null;
  const is3d = !!src && src.startsWith('env_3d');
  envGroup.visible = is3d;
  scene.background = (is3d && skyTexture) ? skyTexture : null;
  bgEl.style.display = is3d ? 'none' : 'block';
  if (is3d || !src) return;
  let img = bgImages.get(src);
  if (!img) {
    const meta = bgMeta[src];
    img = document.createElement('img');
    if (meta) img.src = './assets/' + meta.texture;
    bgEl.appendChild(img);
    bgImages.set(src, img);
  }
  for (const [k, other] of bgImages) other.style.display = k === src ? 'block' : 'none';
  img.style.display = 'block';
  const setting = st.bgSet.get(st.bgActive) || {};
  const pos = setting.position || { x: 0, y: 0 };
  const scale = setting.scale || { x: 1, y: 1 };
  const angle = setting.angle || 0;
  const k = innerHeight / 1080;
  img.style.transform =
    `translate(${pos.x * k}px, ${-pos.y * k}px) scale(${scale.x}, ${scale.y}) rotate(${-angle}deg)`;
}

function applyMessage(t, st) {
  const m = st.message;
  if (!m) { msgEl.style.display = 'none'; return; }
  msgEl.style.display = 'block';
  const name = m.name === '{user}' ? USER_NAME : (m.name || '');
  nameEl.textContent = name;
  nameEl.style.display = (!name || m.narration) ? 'none' : 'block';
  const clean = stripRuby(m.text);
  const shown = Math.max(0, Math.floor((t - m.start) * CHARS_PER_SEC));
  textEl.textContent = clean.slice(0, shown);
}

function flashAt(st, t) {
  let a = 0;
  for (const tr of st.transitions) {
    if (t < tr.start) break;
    const u = Math.min(1, Math.max(0, (t - tr.start) / tr.dur));
    a = tr.type === 'In' ? u : 1 - u;
  }
  return a;
}

function applyFade(t, st) {
  const f = st.fade;
  const w = f.dur > 0 ? Math.min(1, Math.max(0, (t - f.t) / f.dur)) : 1;
  const fadeA = lerp(f.from, f.to, w);
  const flash = flashAt(st, t);
  if (flash > fadeA) {
    fadeEl.style.background = '#ffffff';
    fadeEl.style.opacity = String(flash);
  } else {
    fadeEl.style.background = f.color || '#000000';
    fadeEl.style.opacity = String(fadeA);
  }
}

// ---------- boot ----------
let timeline = null;
let player = null;
let bgMeta = {};
let playing = params.get('autoplay') !== '0';
let speed = 1;
let time = parseFloat(params.get('t') || '0') || 0;
let envInfo = null;
let cameraLocked = false;

async function boot() {
  statusEl.textContent = 'loading assets…';
  const [text, char, bgJson, env] = await Promise.all([
    fetch(SCRIPT_URL).then((r) => r.text()),
    loadCharacter(scene),
    fetch('./assets/bg.json').then((r) => r.json()).catch(() => ({})),
    loadEnv().catch((e) => { console.warn('env load failed', e?.stack || e); return null; }),
  ]);
  envInfo = env;
  bgMeta = bgJson;
  if (env && env.meta && env.meta.volumes && env.meta.volumes.actorParam) {
    char.applyActorVolume(env.meta.volumes.actorParam);
  }
  char.root.position.set(0, 0, 0);
  actorGroup.add(char.root);

  const events = parseAdv(text);
  timeline = buildTimeline(events);
  player = new Player(timeline, char);
  const pre = await player.preload();

  seekEl.max = String(Math.ceil(timeline.duration * 1000));
  statusEl.textContent =
    `${events.length} cues · ${timeline.duration.toFixed(1)}s · clips ${pre.total - pre.missing.length}/${pre.total}` +
    (pre.missing.length ? ` (missing: ${pre.missing.join(', ')})` : '');

  window.story = {
    timeline, player, camera, scene, char, THREE,
    apply(t) { time = t; frame(); },
    get time() { return time; },
    seek(t) { time = t; playing = false; frame(); },
    lockCamera(v) { cameraLocked = !!v; },
    render() { frame(); },
    renderer,
    lights: { sunLight, stageHemi },
    env: envGroup,
    actorGroup,
    shadow: groundShadow,
  };
  frame();
  requestAnimationFrame(loop);
}

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const raw = Math.min(1.0, (now - last) / 1000);
  last = now;
  if (playing) {
    time += raw * speed;
    if (time > timeline.duration) time = 0;
  }
  frame();
}

function frame() {
  if (!player) return;
  const st = player.stateAt(time);
  if (st.camera && !cameraLocked) applyCameraSetting(camera, st.camera);
  const sk = shakeAt(st, time);
  if (sk) { camera.rotateY(sk.yaw); camera.rotateX(sk.pitch); }
  player.applyCharacter(time, st);
  applyLookTarget(player.char, st, time);
  applyBackground(time, st, bgMeta);
  applyMessage(time, st);
  applyFade(time, st);

  // Update character view-space head normal & CampusActorFaceCorrection profile blendshapes
  player.char.update(camera);

  groundShadow.visible = actorGroup.visible && envGroup.visible;
  if (groundShadow.visible) {
    const hips = player.char.solver.nameToNode.Hips;
    const hp = hips ? hips.getWorldPosition(new THREE.Vector3()) : actorGroup.position;
    groundShadow.position.set(hp.x, actorGroup.position.y + 0.004, hp.z);
  }

  if (seekEl) seekEl.value = String(Math.round(time * 1000));
  if (timeEl) timeEl.textContent = `${time.toFixed(2)}s`;
  if (bloom) bloom.render(scene, camera);
  else renderer.render(scene, camera);
}

// ---------- controls ----------
seekEl?.addEventListener('input', () => {
  time = Number(seekEl.value) / 1000;
  playing = false;
});
document.getElementById('play')?.addEventListener('click', () => { playing = !playing; });
document.getElementById('speed')?.addEventListener('change', (e) => { speed = Number(e.target.value); });
document.getElementById('next')?.addEventListener('click', () => {
  const nextMsg = timeline.cues.find((c) => (c.type === 'message' || c.type === 'narration') && c.t > time + 0.01);
  if (nextMsg) { time = nextMsg.t; playing = false; frame(); }
});
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { playing = !playing; e.preventDefault(); }
  if (e.code === 'ArrowRight') { time += 1; frame(); }
  if (e.code === 'ArrowLeft') { time = Math.max(0, time - 1); frame(); }
});

boot().catch((e) => {
  statusEl.textContent = 'ERROR ' + e.message;
  console.error(e);
});
