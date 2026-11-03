// Offline ADV story player.
//
// Consumes the game's own ADV script (assets/script.txt or ?script=...),
// the raw .bundle packages (3D stage, 2D backgrounds, character, clips) and
// .acb voice packages decoded in the browser through gakumas_core.wasm, and
// the authentic Campus/Actor/Default character renderer.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadCharacter } from './char.js';
import { getClip, evalClip, setClipCharMeta } from './clips.js';
import { getBrowserEnv } from './runtime/bundle_env.js';
import { buildEnv3dFromBundles, loadBg2dFromBundle, loadVoiceCueFromAcb } from './runtime/bundle_loaders.js';
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
  const env = await getBrowserEnv();
  const { glbBytes, meta, textures } = await buildEnv3dFromBundles(env);
  const gltf = await new GLTFLoader().parseAsync(
    glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength), '');

  // Bundle textures arrive as decoded RGBA with row 0 = top of the source
  // image, i.e. exactly what TextureLoader hands over for a PNG. A DataTexture
  // uploads row 0 to v = 0 with flipY = false, matching the old PNG path; the
  // lightmap keeps flipY = true so Unity's bottom-up v = 1 UVs line up.
  // Downsample oversized 3D prop textures (2048x2048 -> 1024x1024) via a 2x2 box
  // filter so 50 stage atlases take ~180 MB VRAM instead of ~940 MB uncompressed RGBA8.
  const downsampleRgba = (src, sw, sh, maxDim) => {
    let w = sw, h = sh, data = src;
    while ((w > maxDim || h > maxDim) && w >= 2 && h >= 2) {
      const nw = w >> 1, nh = h >> 1;
      const dst = new Uint8Array(nw * nh * 4);
      for (let y = 0; y < nh; y++) {
        const r0 = (y * 2) * w * 4;
        const r1 = r0 + w * 4;
        let di = y * nw * 4;
        for (let x = 0; x < nw; x++) {
          const i00 = r0 + (x << 3);
          const i01 = i00 + 4;
          const i10 = r1 + (x << 3);
          const i11 = i10 + 4;
          dst[di]     = (data[i00]     + data[i01]     + data[i10]     + data[i11]     + 2) >> 2;
          dst[di + 1] = (data[i00 + 1] + data[i01 + 1] + data[i10 + 1] + data[i11 + 1] + 2) >> 2;
          dst[di + 2] = (data[i00 + 2] + data[i01 + 2] + data[i10 + 2] + data[i11 + 2] + 2) >> 2;
          dst[di + 3] = (data[i00 + 3] + data[i01 + 3] + data[i10 + 3] + data[i11 + 3] + 2) >> 2;
          di += 4;
        }
      }
      data = dst;
      w = nw;
      h = nh;
    }
    return { data, width: w, height: h };
  };

  const stageTexCache = new Map();
  const stageTex = (rel, srgb, flipY = false, maxDim = 1024) => {
    if (!rel) return null;
    const entry = textures.get(rel);
    if (!entry) return null;
    const ckey = `${rel}|${srgb ? 1 : 0}|${flipY ? 1 : 0}|${maxDim}`;
    let tex = stageTexCache.get(ckey);
    if (!tex) {
      const img = (entry.width > maxDim || entry.height > maxDim)
        ? downsampleRgba(entry.data, entry.width, entry.height, maxDim)
        : entry;
      tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
      tex.flipY = flipY;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      stageTexCache.set(ckey, tex);
    }
    return tex;
  };

  let lmap = null;
  if (meta.lightmap && meta.lightmap.light) {
    lmap = stageTex(meta.lightmap.light, true, true, 2048);
    if (lmap) {
      lmap.channel = 1;
      lmap.needsUpdate = true;
    }
  }

  if (meta.skybox) {
    // Pre-generate the CubeUV PMREM texture once from a 1024x512 skybox so
    // Three.js never invokes PMREMGenerator mid-frame inside setProgram() when
    // scrubbing into the 3D stage (which previously allocated two 3072x4096
    // HalfFloat targets mid-render and corrupted renderStateStack).
    const skyEntry = textures.get(meta.skybox);
    if (skyEntry) {
      const small = downsampleRgba(skyEntry.data, skyEntry.width, skyEntry.height, 1024);
      const eqTex = new THREE.DataTexture(small.data, small.width, small.height, THREE.RGBAFormat);
      eqTex.flipY = false;
      eqTex.colorSpace = THREE.SRGBColorSpace;
      eqTex.mapping = THREE.EquirectangularReflectionMapping;
      eqTex.minFilter = THREE.LinearFilter;
      eqTex.magFilter = THREE.LinearFilter;
      eqTex.generateMipmaps = false;
      eqTex.needsUpdate = true;
      const pmrem = new THREE.PMREMGenerator(renderer);
      skyTexture = pmrem.fromEquirectangular(eqTex).texture;
      pmrem.dispose();
      eqTex.dispose();
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

    // The in-memory GLB carries no texture objects, so resolve the albedo from
    // the material descriptor and the bundle texture map.
    const albedoRel = mdesc.maps && (mdesc.maps._BaseMap || mdesc.maps._MainTex);
    const albedo = albedoRel ? stageTex(albedoRel, true, false) : null;

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
    const defMap = (emMax > 0.5 && defRel) ? stageTex(defRel, false, false) : null;

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
  for (const d of (meta.decals || [])) {
    if (!d.map || !d.positions || d.fade <= 0.005) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(d.positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(d.uvs, 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.computeVertexNormals();
    const dmat = new THREE.MeshBasicMaterial({
      name: d.material,
      map: stageTex(d.map, true, false),
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

const DEFAULT_LOOK_TARGET = {
  type: 0, actorId: '', bones: 10, azimuth: 0, elevation: 0,
  weight: 0, eyesWeight: 0.3, headWeight: 0.6, bodyWeight: 0.1,
};

const _lookActPosW = new THREE.Vector3();
const _lookActQuatW = new THREE.Quaternion();
const _lookActQuatInv = new THREE.Quaternion();
const _lookTargetA = new THREE.Vector3();
const _lookTargetB = new THREE.Vector3();
const _lookBonePosW = new THREE.Vector3();
const _lookBoneQuatW = new THREE.Quaternion();
const _lookParentQuatW = new THREE.Quaternion();
const _lookDesLocal = new THREE.Vector3();
const _lookCurLocal = new THREE.Vector3();
const _lookDeltaQuat = new THREE.Quaternion();
const _lookRotActor = new THREE.Quaternion();
const _lookRotWorld = new THREE.Quaternion();
const _lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function resolveLookTargetPos(out, target) {
  const D2R = Math.PI / 180;
  const tp = target || DEFAULT_LOOK_TARGET;
  if (tp.type === 1) {
    camera.getWorldPosition(out);
    return out;
  }
  const az = (tp.azimuth ?? 0) * D2R;
  const el = (tp.elevation ?? 0) * D2R;
  const ce = Math.cos(el);
  out.set(Math.sin(az) * ce, -Math.sin(el), -Math.cos(az) * ce)
    .applyQuaternion(_lookActQuatW)
    .multiplyScalar(10)
    .add(_lookActPosW);
  out.y += 1.38 * actorGroup.scale.y;
  return out;
}

function evalLookState(st, t) {
  if (!st.looks || !st.looks.length) return null;
  let activeCue = null;
  for (const l of st.looks) {
    if (t < l.start) break;
    activeCue = l;
  }
  if (!activeCue) return null;

  if (activeCue.kind === 'instant') {
    const tgt = activeCue.target || DEFAULT_LOOK_TARGET;
    const w = Math.max(0, Math.min(1, tgt.weight ?? 0));
    if (w <= 1e-4) return null;
    return {
      posW: resolveLookTargetPos(_lookTargetA, tgt),
      headW: w * (tgt.headWeight ?? 0.6),
      bodyW: w * (tgt.bodyWeight ?? 0.1),
      eyesW: w * (tgt.eyesWeight ?? 0.3),
    };
  }

  const from = activeCue.from || DEFAULT_LOOK_TARGET;
  const to = activeCue.to || DEFAULT_LOOK_TARGET;
  const u = activeCue.dur > 0 ? Math.min(1, Math.max(0, (t - activeCue.start) / activeCue.dur)) : 1;
  const w0 = Math.max(0, Math.min(1, from.weight ?? 0));
  const w1 = Math.max(0, Math.min(1, to.weight ?? 0));

  // Matches Campus.ADV.ActorLookTargetMixerPlayable$$SetLookAt:
  // When tweening weight (0->1 or 1->0), keep the higher-weight endpoint's target position
  // fixed and ramp weights (bodyWeight uses Easing.InCirc).
  if (Math.abs(w0 - w1) > 1e-4) {
    const w = w0 + (w1 - w0) * u;
    if (w <= 1e-4) return null;
    const dom = w0 < w1 ? to : from;
    const inCirc = 1 - Math.sqrt(Math.max(0, 1 - w * w));
    return {
      posW: resolveLookTargetPos(_lookTargetA, dom),
      headW: w * (dom.headWeight ?? 0.6),
      bodyW: inCirc * (dom.bodyWeight ?? 0.1),
      eyesW: w * (dom.eyesWeight ?? 0.3),
    };
  }

  if (w1 <= 1e-4) return null;
  resolveLookTargetPos(_lookTargetA, from);
  resolveLookTargetPos(_lookTargetB, to);
  _lookTargetA.lerp(_lookTargetB, u);
  return {
    posW: _lookTargetA,
    headW: w1 * (to.headWeight ?? 0.6),
    bodyW: w1 * (to.bodyWeight ?? 0.1),
    eyesW: w1 * (to.eyesWeight ?? 0.3),
  };
}

function aimBoneAtTarget(solver, bname, targetPosW, weight, maxYawDeg, maxPitchDeg) {
  if (weight <= 1e-4) return;
  const bone = solver.nameToNode[bname];
  if (!bone || !bone.parent) return;
  const D2R = Math.PI / 180;
  bone.updateWorldMatrix(true, false);
  bone.getWorldPosition(_lookBonePosW);
  bone.getWorldQuaternion(_lookBoneQuatW);

  _lookDesLocal.copy(targetPosW).sub(_lookBonePosW).applyQuaternion(_lookActQuatInv);
  if (_lookDesLocal.lengthSq() < 1e-8) return;
  _lookDesLocal.normalize();

  const bindQ = solver.bindQuat3[bname];
  _lookDeltaQuat.copy(_lookActQuatInv).multiply(_lookBoneQuatW);
  if (bindQ) _lookDeltaQuat.multiply(_lookParentQuatW.copy(bindQ).invert());
  _lookCurLocal.set(0, 0, -1).applyQuaternion(_lookDeltaQuat).normalize();

  const desYaw = Math.atan2(-_lookDesLocal.x, -_lookDesLocal.z);
  const curYaw = Math.atan2(-_lookCurLocal.x, -_lookCurLocal.z);
  let dYaw = desYaw - curYaw;
  while (dYaw > Math.PI) dYaw -= Math.PI * 2;
  while (dYaw < -Math.PI) dYaw += Math.PI * 2;

  const desPitch = Math.asin(Math.max(-1, Math.min(1, _lookDesLocal.y)));
  const curPitch = Math.asin(Math.max(-1, Math.min(1, _lookCurLocal.y)));
  const maxYaw = maxYawDeg * D2R;
  const maxPitch = maxPitchDeg * D2R;
  const yaw = Math.max(-maxYaw, Math.min(maxYaw, dYaw)) * weight;
  const pitch = Math.max(-maxPitch, Math.min(maxPitch, desPitch - curPitch)) * weight;

  _lookEuler.set(pitch, yaw, 0, 'YXZ');
  _lookRotActor.setFromEuler(_lookEuler);
  _lookRotWorld.copy(_lookActQuatW).multiply(_lookRotActor).multiply(_lookActQuatInv);

  bone.parent.getWorldQuaternion(_lookParentQuatW);
  _lookDeltaQuat.copy(_lookParentQuatW).invert().multiply(_lookRotWorld).multiply(_lookParentQuatW);
  bone.quaternion.premultiply(_lookDeltaQuat);
  bone.updateMatrixWorld(true);
}

function applyLookTarget(char, st, t) {
  if (!char || !st.actorVisible) return;
  const { solver } = char;
  if (!solver.nameToNode.Head) return;

  actorGroup.updateMatrixWorld(true);
  actorGroup.getWorldPosition(_lookActPosW);
  actorGroup.getWorldQuaternion(_lookActQuatW);
  _lookActQuatInv.copy(_lookActQuatW).invert();

  const lk = evalLookState(st, t);
  if (!lk) return;

  const chestName = solver.nameToNode.Chest ? 'Chest'
    : (solver.nameToNode.Spine2 ? 'Spine2' : 'Spine1');
  aimBoneAtTarget(solver, chestName, lk.posW, lk.bodyW, 30, 20);
  aimBoneAtTarget(solver, 'Head', lk.posW, lk.headW, 50, 35);
  // Eye bone pivot sits behind the cornea; clamp to realistic ocular excursion
  aimBoneAtTarget(solver, 'LeftEye', lk.posW, lk.eyesW, 8, 5);
  aimBoneAtTarget(solver, 'RightEye', lk.posW, lk.eyesW, 8, 5);
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
    lhT: lerpArr(ra.lhT, rb.lhT, w),
    lhQ: nlerpQuat(ra.lhQ, rb.lhQ, w),
    rhT: lerpArr(ra.rhT, rb.rhT, w),
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
      bgActive: this.defaultBg, bgSet: new Map(), camera: null, dof: null,
      layout: null, actorVisible: true,
      motion: null, prevMotion: null, facial: null, prevFacial: null,
      overrides: [], additive: [], shakes: [], looks: [], transitions: [],
      activeVoice: null, actorVoice: null, lineVoice: null,
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
          st.dof = (p.setting && p.setting.dofSetting) || null;
          break;
        case 'cameratween': {
          const from = p.from || st.camera;
          const to = p.to || from;
          if (from && to) {
            let u = c.dur > 0 ? Math.min(1, Math.max(0, (t - c.t) / c.dur)) : 1;
            if (p.ease === 'OutQuad') u = 1 - (1 - u) * (1 - u);
            const lv3 = (a, b) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) });
            st.camera = {
              ...to,
              focalLength: lerp(from.focalLength ?? 30, to.focalLength ?? 30, u),
              transform: (from.transform && to.transform) ? {
                position: lv3(from.transform.position, to.transform.position),
                rotation: lv3(from.transform.rotation, to.transform.rotation),
                scale: to.transform.scale || { x: 1, y: 1, z: 1 },
              } : (to.transform || from.transform),
            };
            if (to.dofSetting) st.dof = to.dofSetting;
          }
          break;
        }
        case 'dof': {
          const s = p.setting || {};
          const val = (k, fb) => (s[k] && typeof s[k] === 'object' && 'm_Value' in s[k]) ? s[k].m_Value : (s[k] ?? fb);
          st.dof = {
            active: true,
            focalPoint: Number(val('focalPoint', 2.0)),
            fNumber: Number(val('fNumber', 2.8)),
            maxBlurSpread: Number(val('maxBlurSpread', 2.0)),
            foregroundBlurExtrude: Number(val('foregroundBlurExtrude', 1.15)),
            focalSize: Number(val('focalSize', 1.0)),
          };
          break;
        }
        case 'actorlayoutgroup': {
          const layouts = (c.all.layouts || []).flat();
          const mine = layouts.find((l) => !l.params.id || l.params.id === ACTOR_ID);
          if (mine) {
            st.actorVisible = true;
            if (mine.params.transform) st.layout = mine.params.transform;
          } else {
            st.actorVisible = false;
          }
          break;
        }
        case 'actormotion': {
          if (p.id && p.id !== ACTOR_ID) break;
          const tr = Number(p.transition ?? 0);
          st.prevMotion = st.motion;
          st.motion = {
            name: p.motion, variant: 'b', start: c.t, clipIn: c.clipIn,
            transition: tr,
          };
          // Campus.ADV.ActorMotionCommand$$BindParameter also binds the embedded _f facial clip
          // (with DefaultFacialTransitionTime = 0.22s when transition > 0) unless overridden at c.t.
          if (this.clipOf(p.motion, 'f')
              && !(st.facial && st.facial.explicit && Math.abs(st.facial.start - c.t) < 1e-4)) {
            const ftr = p.facialTransition !== undefined ? Number(p.facialTransition) : (tr > 0 ? 0.22 : 0);
            st.prevFacial = st.facial;
            st.facial = {
              name: p.motion, variant: 'f', start: c.t, clipIn: c.clipIn,
              transition: ftr, explicit: false,
            };
          }
          break;
        }
        case 'actorfacialmotion': {
          if (p.id && p.id !== ACTOR_ID) break;
          if (!(st.facial && !st.facial.explicit && Math.abs(st.facial.start - c.t) < 1e-4)) {
            st.prevFacial = st.facial;
          }
          st.facial = {
            name: p.motion, variant: 'f', start: c.t, clipIn: c.clipIn,
            transition: Number(p.transition ?? 0), explicit: true,
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
        case 'actorlooktarget': {
          if (p.id && p.id !== ACTOR_ID) break;
          const target = p.target || DEFAULT_LOOK_TARGET;
          st.looks.push({ kind: 'instant', start: c.t, dur: 0, target, endTarget: target });
          break;
        }
        case 'actorlooktargettween': {
          if (p.id && p.id !== ACTOR_ID) break;
          const prev = st.looks.length ? st.looks[st.looks.length - 1].endTarget : null;
          const from = p.from || prev || DEFAULT_LOOK_TARGET;
          const to = p.to || DEFAULT_LOOK_TARGET;
          st.looks.push({ kind: 'tween', start: c.t, dur: c.dur || 0.01, from, to, endTarget: to });
          break;
        }
        case 'voice': {
          const cueName = p.voice;
          if (!cueName) break;
          const metaDur = (lipsyncDb && lipsyncDb.cues && lipsyncDb.cues[cueName]?.duration) || 0;
          const dur = Math.max(c.dur || 0, metaDur);
          const isMine = p.actorId ? p.actorId === ACTOR_ID : String(cueName).includes(`_${ACTOR_ID}-`);
          const vObj = {
            voice: cueName,
            actorId: p.actorId || '',
            isMine,
            start: c.t,
            dur,
            clipIn: c.clipIn || 0,
            volume: Number(p.volume ?? 1),
          };
          st.lineVoice = vObj;
          if (t < c.t + dur + 0.35) {
            st.activeVoice = vObj;
          }
          if (isMine && t < c.t + dur + 0.15) {
            st.actorVoice = vObj;
          }
          break;
        }
        case 'message':
          if (t < c.t + c.dur) {
            st.message = { text: p.text, name: p.name, hide: p.hide, start: c.t, dur: c.dur, narration: false };
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
    if (variant === 'f') {
      return this.clips.get(`${name}_f`) || (name.endsWith('_f') ? this.clips.get(name) : null) || null;
    }
    if (variant === 'b') {
      return this.clips.get(`${name}_b`) || (!name.endsWith('_f') ? this.clips.get(name) : null) || null;
    }
    return this.clips.get(name)
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
      if (pe && w < 1 && pe.bones && pe.bones.length) {
        const pMap = new Map();
        for (const b of pe.bones) pMap.set(`${b.node}:${b.prop}`, b.value);
        const seen = new Set();
        for (const b of ce.bones) {
          const key = `${b.node}:${b.prop}`;
          seen.add(key);
          const pv = pMap.get(key);
          if (!pv) {
            bones.push(b);
          } else {
            bones.push({
              node: b.node,
              prop: b.prop,
              value: b.prop === 'rotation' ? nlerpQuat(pv, b.value, w) : lerpArr(pv, b.value, w),
            });
          }
        }
        for (const b of pe.bones) {
          if (!seen.has(`${b.node}:${b.prop}`)) bones.push(b);
        }
      } else {
        bones.push(...ce.bones);
      }

      // Gentle chest-only breathing (~0.4 deg sagittal inhalation) after a non-looping clip settles;
      // never inject stand-001_lp leg/hip/head fidget deltas onto a settled pose.
      if (curM.elapsed > curM.clip.duration) {
        const settle = Math.min(1, (curM.elapsed - curM.clip.duration) / 0.8);
        const breath = Math.sin((t - st.motion.start) * 1.75) * 0.010 * settle;
        muscles[3] += breath;
        muscles[6] += breath;
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
    // ---------- Voice-driven 60Hz AIUEO lip-sync ----------
    const vowels = evalLipSync(t, st, this.hasVoices);
    if (vowels) applyLipSyncToMorph(morph, vowels);

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
const voiceBtn = document.getElementById('voice');
const volEl = document.getElementById('vol');
const voiceReplayBtn = document.getElementById('voice-replay');
const bgEl = document.getElementById('bg2d');
const bgImages = new Map();
const bgTextures = new Map();
const _bgUvMat = new THREE.Matrix3();

// ---------- Voice Audio & 60Hz AIUEO Formant Lip-Sync ----------
let lipsyncDb = { fps: 60, cues: {} };
const CLOSED_EXPR_MOUTHS = [42, 45, 46, 54, 71, 74, 75];

function kanaVowelVec(ch) {
  if (!ch || /[、。！？…・\s「」（）『』]/.test(ch)) return [0, 0, 0, 0, 0];
  const code = ch.charCodeAt(0);
  // Hiragana / Katakana vowel column estimation + kanji hash fallback
  if ((code >= 0x3041 && code <= 0x3096) || (code >= 0x30A1 && code <= 0x30F6)) {
    const h = code >= 0x30A1 ? code - 0x60 : code;
    if (h === 0x3093 || h === 0x3063) return [0, 0, 0.15, 0, 0]; // ん / っ
    const aCols = 'あかさたなはまやらわがざだばぱぁゃゎ';
    const iCols = 'いきしちにひみりぎじぢびぴぃ';
    const uCols = 'うくすつぬふむゆるぐずづぶぷぅゅ';
    const eCols = 'えけせてねへめれげぜでべぺぇ';
    const oCols = 'おこそとのほもよろをごぞどぼぽぉょ';
    const hc = String.fromCharCode(h);
    if (aCols.includes(hc)) return [0.85, 0, 0, 0.1, 0];
    if (iCols.includes(hc)) return [0, 0.85, 0, 0.15, 0];
    if (uCols.includes(hc)) return [0, 0, 0.85, 0, 0.15];
    if (eCols.includes(hc)) return [0.15, 0.15, 0, 0.75, 0];
    if (oCols.includes(hc)) return [0.1, 0, 0.15, 0, 0.80];
  }
  const pick = Math.floor(hash01(code) * 5);
  const out = [0.08, 0.08, 0.08, 0.08, 0.08];
  out[pick] = 0.68;
  return out;
}

function evalTextFallbackLipSync(text, elapsed, totalDur) {
  const clean = stripRuby(text || '').replace(/\s+/g, '');
  if (!clean || /^[\s…・。、！？?]+$/.test(clean)) return null;
  const speakDur = Math.min(totalDur * 0.9, Math.max(0.4, clean.length * 0.11));
  if (elapsed < 0 || elapsed > speakDur) return null;
  const pos = (elapsed / speakDur) * clean.length;
  const idx = Math.min(clean.length - 1, Math.floor(pos));
  const frac = pos - idx;
  const pulse = Math.sin(Math.PI * Math.min(1, frac * 1.15));
  const v = kanaVowelVec(clean[idx]);
  return v.map((x) => x * pulse * 0.85);
}

function sampleLipSyncEntry(voiceName, lt, dur, msgText) {
  if (lt < 0 || (dur > 0 && lt > dur + 0.03)) return null;
  const entry = lipsyncDb && lipsyncDb.cues && lipsyncDb.cues[voiceName];
  if (entry && entry.frames && entry.frames.length > 0) {
    const fps = entry.fps || lipsyncDb.fps || 60;
    const clipDur = dur > 0 ? dur : (entry.duration || entry.frames.length / fps);
    const f = lt * fps;
    const i0 = Math.max(0, Math.min(entry.frames.length - 1, Math.floor(f)));
    const i1 = Math.min(entry.frames.length - 1, i0 + 1);
    const u = Math.max(0, Math.min(1, f - i0));
    const a0 = entry.frames[i0];
    const a1 = entry.frames[i1];
    const tail = clipDur > 0.08 ? Math.min(1, Math.max(0, (clipDur + 0.02 - lt) / 0.06)) : 1;
    return [
      ((a0[0] * (1 - u) + a1[0] * u) / 100) * tail,
      ((a0[1] * (1 - u) + a1[1] * u) / 100) * tail,
      ((a0[2] * (1 - u) + a1[2] * u) / 100) * tail,
      ((a0[3] * (1 - u) + a1[3] * u) / 100) * tail,
      ((a0[4] * (1 - u) + a1[4] * u) / 100) * tail,
    ];
  }
  if (msgText) return evalTextFallbackLipSync(msgText, lt, dur || 2.5);
  return null;
}

function evalLipSync(t, st, hasScriptVoices) {
  const mv = voiceCtrl && voiceCtrl.getManualActorPlayback();
  if (mv) {
    return sampleLipSyncEntry(mv.voice, mv.currentTime, mv.dur, st.message?.text);
  }
  const av = st.actorVoice;
  if (av) {
    // Lock lip-sync directly to hardware audio playback clock when actively speaking
    const liveAudioT = (voiceCtrl && voiceCtrl.currentCue === av.voice && voiceCtrl.isSpeaking())
      ? voiceCtrl.audio.currentTime
      : ((t - av.start) + (av.clipIn || 0));
    return sampleLipSyncEntry(av.voice, liveAudioT, av.dur, st.message?.text);
  }
  if (!hasScriptVoices && st.message && st.message.name === '麻央' && !st.message.hide) {
    return evalTextFallbackLipSync(st.message.text, t - st.message.start, st.message.dur || 2.5);
  }
  return null;
}

function applyLipSyncToMorph(morph, vowels) {
  const [va, vi, vu, ve, vo] = vowels;
  const openTotal = Math.min(1, va + vi + vu + ve + vo);
  if (openTotal <= 0.004) return;

  // Determine smiling vs serious/worried mood from active base expression morphs
  const smile = Math.min(1, Math.max(0, (morph.get(71) || 0) + (morph.get(42) || 0) + (morph.get(75) || 0)));
  const serious = 1 - smile;

  // Unseal closed-mouth expression morphs proportionally so lips open cleanly and return smoothly on pauses
  const closedKeep = 1 - Math.min(0.88, openTotal * 0.85);
  for (const idx of CLOSED_EXPR_MOUTHS) {
    if (morph.has(idx)) morph.set(idx, morph.get(idx) * closedKeep);
  }

  const addM = (idx, val) => {
    if (val > 0.001) morph.set(idx, Math.min(1, (morph.get(idx) || 0) + val));
  };
  if (smile > 0.01) {
    addM(64, va * smile * 0.86);                       // A (あ): warm D-shaped open smile
    addM(44, (vi + ve * 0.30) * smile * 0.78);         // I (い): smiling horizontal open
    addM(47, vu * smile * 0.68);                       // U (う): small rounded oval
    addM(72, ve * smile * 0.66);                       // E (え): medium D-shaped open
    addM(49, vo * smile * 0.74);                       // O (お): rounded medium open
  }
  if (serious > 0.01) {
    addM(72, va * serious * 0.60);                     // A (あ): neutral medium open
    addM(53, (vi * 0.68 + ve * 0.42) * serious);       // I/E (い/え): neutral horizontal open
    addM(47, vu * serious * 0.64);                     // U (う): small rounded
    addM(48, (vo * 0.72 + va * 0.18 + ve * 0.28) * serious); // O (お): neutral oval
  }
}

class VoiceController {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.blobUrls = new Map();
    this.muted = params.get('mute') === '1';
    this.userVolume = Math.max(0, Math.min(1, Number(params.get('vol') ?? 1)));
    if (volEl) volEl.value = String(Math.round(this.userVolume * 100));
    this.autoplayBlocked = false;
    this.currentCue = null;
    this.manualCue = null;
    this._pendingPlay = null;
    this._btnStateKey = '';
    this.audio.addEventListener('ended', () => {
      this.manualCue = null;
      this._updateBtn();
    });
    this.audio.addEventListener('pause', () => this._updateBtn());
    this.audio.addEventListener('play', () => this._updateBtn());
    this._updateBtn();
  }

  resolveUrl(cueName) {
    return this.blobUrls.get(cueName) || null;
  }

  /**
   * Decode each cue's CRI HCA stream out of its .acb sheet into a WAV blob URL
   * and cache the 60 Hz AIUEO lip-sync weights on `lipsyncDb`.
   */
  async preloadCues(cueNames) {
    for (const vc of cueNames) {
      if (this.blobUrls.has(vc)) continue;
      try {
        const info = await loadVoiceCueFromAcb(vc);
        if (!info) continue;
        lipsyncDb.cues[vc] = { duration: info.duration, fps: info.fps, frames: info.frames };
        this.blobUrls.set(vc, info.wavBlobUrl);
      } catch (e) {
        console.warn(`voice load failed ${vc}`, e);
      }
    }
  }

  isSpeaking() {
    return !this.audio.paused && !this.audio.ended && !this.muted && this.userVolume > 0;
  }

  _updateBtn() {
    const speaking = this.isSpeaking();
    const mode = (this.muted || this.userVolume <= 0)
      ? 'off'
      : (this.autoplayBlocked ? 'blocked' : (speaking ? 'playing' : 'on'));
    const key = `${mode}:${speaking ? 1 : 0}`;
    if (this._btnStateKey === key) return;
    this._btnStateKey = key;
    if (voiceBtn) {
      voiceBtn.classList.toggle('speaking', speaking);
      if (mode === 'off') {
        voiceBtn.textContent = 'voice: off';
        voiceBtn.classList.remove('warn');
      } else if (mode === 'blocked') {
        voiceBtn.textContent = 'voice: tap to unmute';
        voiceBtn.classList.add('warn');
      } else {
        voiceBtn.textContent = speaking ? 'voice: playing' : 'voice: on';
        voiceBtn.classList.remove('warn');
      }
    }
    if (voiceReplayBtn) {
      voiceReplayBtn.classList.toggle('playing', speaking);
    }
  }

  setVolume(v01) {
    this.userVolume = Math.max(0, Math.min(1, Number(v01)));
    if (volEl) volEl.value = String(Math.round(this.userVolume * 100));
    if (this.userVolume > 0 && this.muted) this.muted = false;
    this.audio.volume = Math.max(0, Math.min(1, (this._cueVolume ?? 1) * this.userVolume));
    this._updateBtn();
  }

  setMuted(v) {
    this.muted = !!v;
    if (this.muted) {
      this.autoplayBlocked = false;
      this.manualCue = null;
      if (!this.audio.paused) this.audio.pause();
    }
    this._updateBtn();
  }

  toggleMute() {
    if (this.autoplayBlocked && !this.muted) {
      this.unlock();
      return;
    }
    if (!this.muted && this.userVolume <= 0) {
      this.setVolume(1);
      return;
    }
    this.setMuted(!this.muted);
  }

  unlock() {
    if (this.muted) return;
    const wasBlocked = this.autoplayBlocked;
    this.autoplayBlocked = false;
    this._updateBtn();
    if (wasBlocked && player) {
      this.sync(time, player.stateAt(time), playing, speed);
    }
  }

  replayLine(vObj) {
    if (!vObj || !vObj.voice) return;
    const url = this.resolveUrl(vObj.voice);
    if (!url) return;
    if (this.muted) this.muted = false;
    if (this.userVolume <= 0) this.setVolume(1);
    this.autoplayBlocked = false;
    this.manualCue = vObj;
    this.currentCue = vObj.voice;
    this._cueVolume = vObj.volume ?? 1;
    this.audio.volume = Math.max(0, Math.min(1, this._cueVolume * this.userVolume));
    this.audio.playbackRate = 1;
    this.audio.src = url;
    try { this.audio.currentTime = vObj.clipIn || 0; } catch { /* wait metadata */ }
    this._tryPlay();
  }

  getManualActorPlayback() {
    if (!this.manualCue || !this.manualCue.isMine) return null;
    if (this.audio.paused || this.audio.ended) {
      if (this.audio.ended) this.manualCue = null;
      return null;
    }
    return {
      voice: this.manualCue.voice,
      currentTime: this.audio.currentTime || 0,
      dur: this.manualCue.dur || this.audio.duration || 0,
    };
  }

  sync(t, st, isPlaying, playbackSpeed) {
    if (isPlaying && this.manualCue) {
      this.manualCue = null;
    }
    if (!isPlaying && this.manualCue) {
      this._updateBtn();
      return;
    }

    const v = st && st.activeVoice;
    if (!v || !isPlaying || this.muted || this.userVolume <= 0) {
      if (!this.audio.paused) this.audio.pause();
      if (!v) this.currentCue = null;
      this._updateBtn();
      return;
    }
    const wantTime = Math.max(0, (t - v.start) + (v.clipIn || 0));
    const rate = Math.max(0.25, Math.min(4, playbackSpeed || 1));
    if (this.audio.playbackRate !== rate) this.audio.playbackRate = rate;
    this._cueVolume = v.volume ?? 1;
    const vol = Math.max(0, Math.min(1, this._cueVolume * this.userVolume));
    if (Math.abs(this.audio.volume - vol) > 0.01) this.audio.volume = vol;

    if (this.currentCue !== v.voice) {
      // Do not start a cue that has already finished on the timeline
      if (wantTime >= v.dur - 0.05) {
        this._updateBtn();
        return;
      }
      const url = this.resolveUrl(v.voice);
      if (!url) {
        this._updateBtn();
        return;
      }
      this.currentCue = v.voice;
      this.audio.src = url;
      const seekAndPlay = () => {
        if (this.currentCue !== v.voice) return;
        const liveWant = Math.max(0, (time - v.start) + (v.clipIn || 0));
        try {
          if (liveWant > 0.05 && (!Number.isFinite(this.audio.duration) || liveWant < this.audio.duration - 0.05)) {
            this.audio.currentTime = liveWant;
          }
        } catch { /* metadata still loading */ }
        if (playing && !this.muted && !this.autoplayBlocked) {
          this._tryPlay();
        }
      };
      if (this.audio.readyState >= 1) seekAndPlay();
      else this.audio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      return;
    }

    // Let an already-playing clip finish naturally without premature tail cutoff; only re-seek on large user jumps (>0.45s)
    if (this.audio.ended) {
      if (wantTime < v.dur - 0.25) {
        try { this.audio.currentTime = wantTime; } catch { /* ignore */ }
        if (!this.autoplayBlocked && !this._pendingPlay) this._tryPlay();
      }
      this._updateBtn();
      return;
    }

    if (this.audio.readyState >= 3 && Math.abs(this.audio.currentTime - wantTime) > 0.45) {
      if (wantTime < v.dur - 0.08 && (!Number.isFinite(this.audio.duration) || wantTime < this.audio.duration - 0.05)) {
        try { this.audio.currentTime = wantTime; } catch { /* ignore */ }
      }
    }
    if (this.audio.paused && wantTime < v.dur - 0.08 && !this.autoplayBlocked && !this._pendingPlay) {
      this._tryPlay();
    }
    this._updateBtn();
  }

  _tryPlay() {
    const p = this.audio.play();
    this._pendingPlay = p;
    if (p && typeof p.then === 'function') {
      p.then(() => {
        this._pendingPlay = null;
        this.autoplayBlocked = false;
        this._updateBtn();
      }).catch((err) => {
        this._pendingPlay = null;
        if (err && err.name === 'NotAllowedError') {
          this.autoplayBlocked = true;
          this._updateBtn();
        }
      });
    } else {
      this._pendingPlay = null;
    }
  }
}

const voiceCtrl = new VoiceController();
function stripRuby(s) {
  return String(s || '').replace(/<r=([^>]*)>([^<]*)<\/r>/g, '$2');
}

let lastVolumeSrc = null;

function getBgTexture(src, img) {
  let tex = bgTextures.get(src);
  if (!tex && img && img.complete && img.naturalWidth > 0) {
    tex = new THREE.Texture(img);
    tex.flipY = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    bgTextures.set(src, tex);
  }
  return tex || null;
}

function applyBackground(t, st, bgMeta) {
  const src = st.bgActive ? (timeline.backgrounds.get(st.bgActive) || {}).src : null;
  const is3d = !!src && src.startsWith('env_3d');
  const activeDof = st.dof || (st.camera && st.camera.dofSetting) || null;
  const camFocalMm = (st.camera && st.camera.focalLength) || 30;
  if (bloom) bloom.setDof(activeDof, camFocalMm, is3d);

  envGroup.visible = is3d;
  scene.background = (is3d && skyTexture) ? skyTexture : null;
  if (src && src !== lastVolumeSrc && player && player.char) {
    lastVolumeSrc = src;
    if (is3d && envInfo && envInfo.meta && envInfo.meta.volumes) {
      player.char.applyActorVolume(envInfo.meta.volumes);
    } else if (!is3d && bgMeta[src] && bgMeta[src].volumes) {
      player.char.applyActorVolume(bgMeta[src].volumes);
    }
  }
  if (is3d || !src) {
    bgEl.style.display = 'none';
    bgEl.style.filter = 'none';
    bgEl.style.transform = 'none';
    if (bloom) bloom.setBg2D({ active: false });
    return;
  }
  const meta = bgMeta[src] || {};
  let img = bgImages.get(src);
  if (!img) {
    img = document.createElement('img');
    if (meta.blobUrl) img.src = meta.blobUrl;
    bgEl.appendChild(img);
    bgImages.set(src, img);
  }

  const W = innerWidth, H = innerHeight;
  const setting = st.bgSet.get(st.bgActive) || {};
  const pos = setting.position || { x: 0, y: 0 };
  const scale = setting.scale || { x: 1, y: 1 };
  const angle = setting.angle || 0;
  const k = H / 1920;
  const fit = (W <= H ? meta.verticalSetting : meta.horizontalSetting) || meta.verticalSetting;

  const webglTex = bloom ? getBgTexture(src, img) : null;
  if (bloom && webglTex && fit && fit.baseSize && fit.clippingRect) {
    bgEl.style.display = 'none';
    const base = fit.baseSize;
    const clip = fit.clippingRect;
    const s0 = Math.max(W / clip.width, H / clip.height);
    const imgW = base.x * s0;
    const imgH = base.y * s0;
    const cx = (clip.x + clip.width * 0.5) * s0;
    const cy = (base.y - (clip.y + clip.height * 0.5)) * s0;
    const tx = (pos.x || 0) * k;
    const ty = -(pos.y || 0) * k;
    const sx = Math.abs(scale.x || 1) > 1e-4 ? scale.x : 1;
    const sy = Math.abs(scale.y || 1) > 1e-4 ? scale.y : 1;
    const rad = ((angle || 0) * Math.PI) / 180;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    const ax = W / sx, ay = H / sy;
    const bx = (-0.5 * W - tx) / sx, by = (-0.5 * H - ty) / sy;
    _bgUvMat.set(
      (ca * ax) / imgW, (-sa * ay) / imgW, (ca * bx - sa * by + cx) / imgW,
      (sa * ax) / imgH, (ca * ay) / imgH, (sa * bx + ca * by + cy) / imgH,
      0, 0, 1,
    );
    bloom.setBg2D({ active: true, texture: webglTex, uvMatrix: _bgUvMat, srcId: src });
    return;
  }

  // Fallback DOM background path (when ?bloom=0 or image still decoding)
  if (bloom) bloom.setBg2D({ active: false });
  bgEl.style.display = 'block';
  for (const [k2, other] of bgImages) other.style.display = k2 === src ? 'block' : 'none';
  img.style.display = 'block';
  const dofActive = !!(activeDof && activeDof.active);
  bgEl.style.filter = dofActive ? `blur(${(5.8 * H / 960).toFixed(1)}px)` : 'none';
  bgEl.style.transform = 'none';
  if (fit && fit.baseSize && fit.clippingRect) {
    const base = fit.baseSize;
    const clip = fit.clippingRect;
    const s0 = Math.max(W / clip.width, H / clip.height);
    const cx = (clip.x + clip.width * 0.5) * s0;
    const cy = (base.y - (clip.y + clip.height * 0.5)) * s0;
    img.style.inset = 'auto';
    img.style.objectFit = 'fill';
    img.style.width = `${base.x * s0}px`;
    img.style.height = `${base.y * s0}px`;
    img.style.left = `${W * 0.5 - cx}px`;
    img.style.top = `${H * 0.5 - cy}px`;
    img.style.transformOrigin = `${cx}px ${cy}px`;
  }
  img.style.transform =
    `translate(${pos.x * k}px, ${-pos.y * k}px) scale(${scale.x}, ${scale.y}) rotate(${-angle}deg)`;
}

function getLineVoiceForMessage(st) {
  const m = st && st.message;
  const lv = st && st.lineVoice;
  if (!m || !lv || m.narration) return null;
  return Math.abs(lv.start - m.start) <= 0.6 ? lv : null;
}

function applyMessage(t, st) {
  const m = st.message;
  if (!m) {
    msgEl.style.display = 'none';
    if (voiceReplayBtn) voiceReplayBtn.style.display = 'none';
    return;
  }
  msgEl.style.display = 'block';
  const name = m.name === '{user}' ? USER_NAME : (m.name || '');
  nameEl.textContent = name;
  nameEl.style.display = (!name || m.narration) ? 'none' : 'block';
  if (voiceReplayBtn) {
    voiceReplayBtn.style.display = getLineVoiceForMessage(st) ? 'flex' : 'none';
  }
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
  const env = await getBrowserEnv();
  const [text, char, stage] = await Promise.all([
    fetch(SCRIPT_URL).then((r) => r.text()),
    loadCharacter(scene),
    loadEnv().catch((e) => { console.warn('env load failed', e?.stack || e); return null; }),
  ]);
  setClipCharMeta(char.meta);
  if (stage && stage.meta && stage.meta.volumes) {
    char.applyActorVolume(stage.meta.volumes);
  }
  char.root.position.set(0, 0, 0);
  actorGroup.add(char.root);

  const events = parseAdv(text);
  timeline = buildTimeline(events);
  player = new Player(timeline, char);
  const voiceCueNames = [...new Set(
    timeline.cues.filter((c) => c.type === 'voice' && c.params.voice).map((c) => c.params.voice),
  )];
  player.hasVoices = voiceCueNames.length > 0;

  // 2D backgrounds: decode once per bundle into a WebGL texture (bloom path)
  // and a PNG blob URL for the DOM fallback path.
  const bgLoads = [];
  for (const bg of timeline.backgrounds.values()) {
    const src = bg && bg.src;
    if (!src || src.startsWith('env_3d') || bgMeta[src]) continue;
    bgLoads.push((async () => {
      const info = await loadBg2dFromBundle(env, src);
      if (!info) return;
      bgMeta[src] = info;
      const tex = new THREE.DataTexture(info.rgba, info.width, info.height, THREE.RGBAFormat);
      tex.flipY = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      bgTextures.set(src, tex);
      const img = document.createElement('img');
      img.src = info.blobUrl;
      img.style.display = 'none';
      bgEl.appendChild(img);
      bgImages.set(src, img);
      if (typeof img.decode === 'function') await img.decode().catch(() => {});
    })().catch((e) => console.warn(`bg load failed ${src}`, e)));
  }
  await Promise.all(bgLoads);

  const pre = await player.preload();
  // Decode every voice cue's HCA stream and 60 Hz AIUEO weights up front so the
  // timeline has real durations and lip-sync from the first rendered frame.
  await voiceCtrl.preloadCues(voiceCueNames);

  seekEl.max = String(Math.ceil(timeline.duration * 1000));
  statusEl.textContent =
    `${events.length} cues · ${timeline.duration.toFixed(1)}s · clips ${pre.total - pre.missing.length}/${pre.total}` +
    (pre.missing.length ? ` (missing: ${pre.missing.join(', ')})` : '');

  window.story = {
    timeline, player, camera, scene, char, THREE,
    voice: voiceCtrl,
    apply(t) { time = t; frame(); },
    get time() { return time; },
    seek(t) { time = t; playing = false; frame(); },
    play() { playing = true; voiceCtrl.unlock(); frame(); },
    pause() { playing = false; frame(); },
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
  if (st.actorVisible) {
    player.char.solver.updatePostRig(time);
  }
  applyBackground(time, st, bgMeta);
  applyMessage(time, st);
  applyFade(time, st);
  voiceCtrl.sync(time, st, playing, speed);
  // Update character view-space head uniforms, shadow matrix & CampusActorFaceCorrection
  player.char.update(camera);
  player.char.renderShadow(renderer);

  groundShadow.visible = actorGroup.visible && envGroup.visible;
  if (groundShadow.visible) {
    const hips = player.char.solver.nameToNode.Hips;
    const hp = hips ? hips.getWorldPosition(new THREE.Vector3()) : actorGroup.position;
    groundShadow.position.set(hp.x, actorGroup.position.y + 0.004, hp.z);
  }

  if (seekEl && !seeking) seekEl.value = String(Math.round(time * 1000));
  if (timeEl) timeEl.textContent = `${time.toFixed(2)}s`;
  if (bloom) bloom.render(scene, camera);
  else renderer.render(scene, camera);
}

// ---------- controls ----------
let seeking = false;
let seekWasPlaying = false;
seekEl?.addEventListener('input', () => {
  if (!seeking) {
    seeking = true;
    seekWasPlaying = playing;
    playing = false;
  }
  voiceCtrl.manualCue = null;
  time = Number(seekEl.value) / 1000;
  if (timeEl) timeEl.textContent = `${time.toFixed(2)}s`;
});
seekEl?.addEventListener('change', () => {
  if (seeking) {
    seeking = false;
    if (seekWasPlaying) {
      playing = true;
      voiceCtrl.unlock();
    }
    frame();
  }
});
document.getElementById('play')?.addEventListener('click', () => {
  playing = !playing;
  if (playing) voiceCtrl.unlock();
  else voiceCtrl.manualCue = null;
  frame();
});
voiceBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  voiceCtrl.toggleMute();
  if (player) voiceCtrl.sync(time, player.stateAt(time), playing, speed);
});
volEl?.addEventListener('input', (e) => {
  voiceCtrl.setVolume(Number(e.target.value) / 100);
  if (player) voiceCtrl.sync(time, player.stateAt(time), playing, speed);
});
voiceReplayBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!player) return;
  const st = player.stateAt(time);
  const lv = getLineVoiceForMessage(st);
  if (lv) {
    if (playing) {
      time = lv.start;
      voiceCtrl.currentCue = null;
      voiceCtrl.unlock();
      frame();
    } else {
      voiceCtrl.replayLine(lv);
    }
  }
});
document.getElementById('speed')?.addEventListener('change', (e) => {
  speed = Number(e.target.value);
  if (player) voiceCtrl.sync(time, player.stateAt(time), playing, speed);
});
document.getElementById('next')?.addEventListener('click', () => {
  voiceCtrl.manualCue = null;
  voiceCtrl.unlock();
  const nextMsg = timeline.cues.find((c) => (c.type === 'message' || c.type === 'narration') && c.t > time + 0.01);
  if (nextMsg) { time = nextMsg.t; frame(); }
});
addEventListener('pointerdown', () => { voiceCtrl.unlock(); }, { passive: true });
addEventListener('keydown', (e) => {
  voiceCtrl.unlock();
  if (e.code === 'Space') { playing = !playing; e.preventDefault(); frame(); }
  if (e.code === 'KeyM') { voiceCtrl.toggleMute(); frame(); }
  if (e.code === 'ArrowRight') { voiceCtrl.manualCue = null; time += 1; frame(); }
  if (e.code === 'ArrowLeft') { voiceCtrl.manualCue = null; time = Math.max(0, time - 1); frame(); }
});

boot().catch((e) => {
  statusEl.textContent = 'ERROR ' + e.message;
  console.error(e);
});
