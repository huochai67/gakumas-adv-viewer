import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { parseAdv, buildTimeline } from './adv.js';
import { createBloom } from './bloom.js';
import { applyCameraSetting, unityEulerQuat } from './camera.js';
import { loadCharacter } from './char.js';
import { getClip, evalClip, setClipCharMeta } from './clips.js';
import { applyAnimationManage, blendAnimationManage } from './animation_manage.js';
import { getBrowserEnv } from '../runtime/bundle_env.js';
import {
  PARTS as DEFAULT_PARTS,
  buildEnv3dFromBundles,
  loadBg2dFromBundle,
  loadVoiceCueFromAcb,
} from '../runtime/bundle_loaders.js';

const USER_NAME = 'プロデューサー';
const DEFAULT_ACTOR_ID = 'amao';
const STAND_MOTION = 'mot_all_chr_cmmn_stand-001_lp';
const BLINK_MORPH_INDEX = 20;
const CHARS_PER_SEC = 24;
const CLOSED_EXPR_MOUTHS = [42, 45, 46, 54, 71, 74, 75];

const DEFAULT_LOOK_TARGET = {
  type: 0,
  actorId: '',
  bones: 10,
  azimuth: 0,
  elevation: 0,
  weight: 0,
  eyesWeight: 0.3,
  headWeight: 0.6,
  bodyWeight: 0.1,
};

function stripRuby(s) {
  return String(s || '').replace(/<r=([^>]*)>([^<]*)<\/r>/g, '$2');
}

function hash01(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function lerp(a, b, w) {
  return a + (b - a) * w;
}

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
    lfQ: nlerpQuat(ra.lfQ, rb.lfQ, w),
    rfT: lerpArr(ra.rfT, rb.rfT, w),
    rfQ: nlerpQuat(ra.rfQ, rb.rfQ, w),
    lhT: lerpArr(ra.lhT, rb.lhT, w),
    lhQ: nlerpQuat(ra.lhQ, rb.lhQ, w),
    rhT: lerpArr(ra.rhT, rb.rhT, w),
    rhQ: nlerpQuat(ra.rhQ, rb.rhQ, w),
  };
}

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

function kanaVowelVec(ch) {
  if (!ch || /[、。！？…・\s「」（）『』]/.test(ch)) return [0, 0, 0, 0, 0];
  const code = ch.charCodeAt(0);
  if ((code >= 0x3041 && code <= 0x3096) || (code >= 0x30a1 && code <= 0x30f6)) {
    const h = code >= 0x30a1 ? code - 0x60 : code;
    if (h === 0x3093 || h === 0x3063) return [0, 0, 0.15, 0, 0];
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
    if (oCols.includes(hc)) return [0.1, 0, 0.15, 0, 0.8];
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

function applyLipSyncToMorph(morph, vowels) {
  const [va, vi, vu, ve, vo] = vowels;
  const openTotal = Math.min(1, va + vi + vu + ve + vo);
  if (openTotal <= 0.004) return;

  const smile = Math.min(
    1,
    Math.max(0, (morph.get(71) || 0) + (morph.get(42) || 0) + (morph.get(75) || 0)),
  );
  const serious = 1 - smile;
  const closedKeep = 1 - Math.min(0.88, openTotal * 0.85);
  for (const idx of CLOSED_EXPR_MOUTHS) {
    if (morph.has(idx)) morph.set(idx, morph.get(idx) * closedKeep);
  }
  const addM = (idx, val) => {
    if (val > 0.001) morph.set(idx, Math.min(1, (morph.get(idx) || 0) + val));
  };
  if (smile > 0.01) {
    addM(64, va * smile * 0.86);
    addM(44, (vi + ve * 0.3) * smile * 0.78);
    addM(47, vu * smile * 0.68);
    addM(72, ve * smile * 0.66);
    addM(49, vo * smile * 0.74);
  }
  if (serious > 0.01) {
    addM(72, va * serious * 0.6);
    addM(53, (vi * 0.68 + ve * 0.42) * serious);
    addM(47, vu * serious * 0.64);
    addM(48, (vo * 0.72 + va * 0.18 + ve * 0.28) * serious);
  }
}

function downsampleRgba(src, sw, sh, maxDim) {
  let w = sw;
  let h = sh;
  let data = src;
  while ((w > maxDim || h > maxDim) && w >= 2 && h >= 2) {
    const nw = w >> 1;
    const nh = h >> 1;
    const dst = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const r0 = y * 2 * w * 4;
      const r1 = r0 + w * 4;
      let di = y * nw * 4;
      for (let x = 0; x < nw; x++) {
        const i00 = r0 + (x << 3);
        const i01 = i00 + 4;
        const i10 = r1 + (x << 3);
        const i11 = i10 + 4;
        dst[di] = (data[i00] + data[i01] + data[i10] + data[i11] + 2) >> 2;
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
}

class VoiceController {
  constructor(lipsyncDb, onChange) {
    this.lipsyncDb = lipsyncDb;
    this.onChange = onChange;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.blobUrls = new Map();
    this._generation = 0;
    this.muted = false;
    this.userVolume = 1;
    this.autoplayBlocked = false;
    this.currentCue = null;
    this.manualCue = null;
    this._pendingPlay = null;
    this._cueVolume = 1;

    this.audio.addEventListener('ended', () => {
      this.manualCue = null;
      this.onChange?.();
    });
    this.audio.addEventListener('pause', () => this.onChange?.());
    this.audio.addEventListener('play', () => this.onChange?.());
  }

  resolveUrl(cueName) {
    return this.blobUrls.get(cueName) || null;
  }

  clear() {
    ++this._generation;
    this.currentCue = null;
    this.manualCue = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
    this.lipsyncDb.cues = {};
  }

  async preloadCues(cueNames) {
    const generation = this._generation;
    for (const vc of cueNames) {
      if (generation !== this._generation) return;
      if (this.blobUrls.has(vc) || (this.lipsyncDb?.cues?.[vc] && this.muted)) continue;
      try {
        const info = await loadVoiceCueFromAcb(vc);
        if (!info) continue;
        if (generation !== this._generation) {
          URL.revokeObjectURL(info.wavBlobUrl);
          return;
        }
        this.lipsyncDb.cues[vc] = { duration: info.duration, fps: info.fps, frames: info.frames };
        this.blobUrls.set(vc, info.wavBlobUrl);
      } catch (e) {
        console.warn(`voice load failed ${vc}`, e);
      }
    }
  }

  isSpeaking() {
    return !this.audio.paused && !this.audio.ended && !this.muted && this.userVolume > 0;
  }

  setVolume(v) {
    this.userVolume = Math.max(0, Math.min(1, v));
    this.audio.volume = Math.max(0, Math.min(1, (this._cueVolume ?? 1) * this.userVolume));
    if (this.userVolume > 0 && this.muted) this.muted = false;
    this.onChange?.();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.autoplayBlocked = false;
    if (this.muted) {
      this.manualCue = null;
      this.audio.pause();
    }
    this.onChange?.();
  }

  unlock() {
    this.autoplayBlocked = false;
    if (!this.muted && this.currentCue && this.audio.paused) {
      this._tryPlay();
    }
    this.onChange?.();
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
    try {
      this.audio.currentTime = vObj.clipIn || 0;
    } catch {
      /* wait metadata */
    }
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

  sync(t, st, isPlaying, playbackSpeed, getLiveTime) {
    if (isPlaying && this.manualCue) {
      this.manualCue = null;
    }
    if (!isPlaying && this.manualCue) {
      return;
    }
    const v = st && st.activeVoice;
    if (!v || !isPlaying || this.muted || this.userVolume <= 0) {
      if (!this.audio.paused) this.audio.pause();
      if (!v) this.currentCue = null;
      return;
    }
    const wantTime = Math.max(0, t - v.start + (v.clipIn || 0));
    const rate = Math.max(0.25, Math.min(4, playbackSpeed || 1));
    if (this.audio.playbackRate !== rate) this.audio.playbackRate = rate;
    this._cueVolume = v.volume ?? 1;
    const vol = Math.max(0, Math.min(1, this._cueVolume * this.userVolume));
    if (Math.abs(this.audio.volume - vol) > 0.01) this.audio.volume = vol;

    if (this.currentCue !== v.voice) {
      if (wantTime >= v.dur - 0.05) return;
      const url = this.resolveUrl(v.voice);
      if (!url) return;
      this.currentCue = v.voice;
      this.audio.src = url;
      const seekAndPlay = () => {
        if (this.currentCue !== v.voice) return;
        const liveT = getLiveTime ? getLiveTime() : t;
        const liveWant = Math.max(0, liveT - v.start + (v.clipIn || 0));
        try {
          if (
            liveWant > 0.05 &&
            (!Number.isFinite(this.audio.duration) || liveWant < this.audio.duration - 0.05)
          ) {
            this.audio.currentTime = liveWant;
          }
        } catch {
          /* metadata still loading */
        }
        if (!this.muted && !this.autoplayBlocked) {
          this._tryPlay();
        }
      };
      if (this.audio.readyState >= 1) seekAndPlay();
      else this.audio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      return;
    }

    if (this.audio.ended) {
      if (wantTime < v.dur - 0.25) {
        try {
          this.audio.currentTime = wantTime;
        } catch {
          /* ignore */
        }
        if (!this.autoplayBlocked && !this._pendingPlay) this._tryPlay();
      }
      return;
    }

    if (this.audio.readyState >= 3 && Math.abs(this.audio.currentTime - wantTime) > 0.45) {
      if (
        wantTime < v.dur - 0.08 &&
        (!Number.isFinite(this.audio.duration) || wantTime < this.audio.duration - 0.05)
      ) {
        try {
          this.audio.currentTime = wantTime;
        } catch {
          /* ignore */
        }
      }
    }
    if (this.audio.paused && wantTime < v.dur - 0.08 && !this.autoplayBlocked && !this._pendingPlay) {
      this._tryPlay();
    }
  }

  _tryPlay() {
    const p = this.audio.play();
    this._pendingPlay = p;
    if (p && typeof p.then === 'function') {
      p.then(() => {
        this._pendingPlay = null;
        this.autoplayBlocked = false;
        this.onChange?.();
      }).catch((err) => {
        this._pendingPlay = null;
        if (err && err.name === 'NotAllowedError') {
          this.autoplayBlocked = true;
          this.onChange?.();
        }
      });
    } else {
      this._pendingPlay = null;
    }
  }
}

class StoryPlayer {
  constructor(timeline, char, actorId, lipsyncDb, voiceCtrl, actorGroup, actorEntries = null) {
    this.timeline = timeline;
    this.char = char;
    this.actorId = actorId || DEFAULT_ACTOR_ID;
    this.lipsyncDb = lipsyncDb;
    this.voiceCtrl = voiceCtrl;
    this.actorGroup = actorGroup;
    this.actorEntries =
      actorEntries ||
      new Map([
        [
          this.actorId,
          { actorId: this.actorId, char: this.char, group: this.actorGroup, groundShadow: null },
        ],
      ]);
    this.clips = new Map();
    this.baseClip = null;
    this.baseTime = 0;
    this.defaultBg = [...timeline.backgrounds.keys()][0] || null;
    this.animationManageProperties = null;
    this.hasVoices = false;
  }

  async preload() {
    const names = new Set([STAND_MOTION]);
    for (const c of this.timeline.cues) {
      if (
        c.type === 'actormotion' ||
        c.type === 'actorfacialmotion' ||
        c.type === 'actoradditivemotion'
      ) {
        if (c.params.id && !this.actorEntries.has(c.params.id) && c.params.id !== this.actorId) {
          continue;
        }
        if (c.params.motion) names.add(c.params.motion);
      }
    }
    const candidates = new Set();
    for (const n of names) {
      for (const c of [n, `${n}_b`, `${n}_f`]) candidates.add(c);
    }
    const queue = [...candidates];
    const worker = async () => {
      while (queue.length) {
        const n = queue.pop();
        try {
          this.clips.set(n, await getClip(n));
        } catch {
          this.clips.set(n, null);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    this.baseClip = this.clipOf(STAND_MOTION, 'b');
    this.baseTime = this.baseClip ? this.baseClip.duration : 0;
    const want = [...names].filter((n) => !this.clipOf(n, 'b') && !this.clipOf(n, 'f'));
    return { total: names.size, missing: want };
  }

  clipOf(name, variant) {
    if (!name) return null;
    if (variant === 'f') {
      return (
        this.clips.get(`${name}_f`) || (name.endsWith('_f') ? this.clips.get(name) : null) || null
      );
    }
    if (variant === 'b') {
      return (
        this.clips.get(`${name}_b`) || (!name.endsWith('_f') ? this.clips.get(name) : null) || null
      );
    }
    return (
      this.clips.get(name) || this.clips.get(`${name}_b`) || this.clips.get(`${name}_f`) || null
    );
  }

  stateAt(t) {
    const actors = new Map();
    for (const aid of this.actorEntries.keys()) {
      actors.set(aid, {
        visible: aid === this.actorId,
        layout: null,
        motion: null,
        prevMotion: null,
        facial: null,
        prevFacial: null,
        overrides: [],
        additive: [],
        looks: [],
        actorVoice: null,
      });
    }
    const st = {
      bgActive: this.defaultBg,
      bgSet: new Map(),
      camera: null,
      dof: null,
      actors,
      layout: null,
      actorVisible: true,
      motion: null,
      prevMotion: null,
      facial: null,
      prevFacial: null,
      overrides: [],
      additive: [],
      shakes: [],
      looks: [],
      transitions: [],
      activeVoice: null,
      actorVoice: null,
      lineVoice: null,
      message: null,
      fade: { from: 0, to: 0, t: 0, dur: 0, color: '#000000' },
    };
    const resolveActor = (id) => st.actors.get(id || this.actorId) || null;

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
            const lv3 = (a, b) => ({
              x: lerp(a.x, b.x, u),
              y: lerp(a.y, b.y, u),
              z: lerp(a.z, b.z, u),
            });
            st.camera = {
              ...to,
              focalLength: lerp(from.focalLength ?? 30, to.focalLength ?? 30, u),
              transform:
                from.transform && to.transform
                  ? {
                      position: lv3(from.transform.position, to.transform.position),
                      rotation: lv3(from.transform.rotation, to.transform.rotation),
                      scale: to.transform.scale || { x: 1, y: 1, z: 1 },
                    }
                  : to.transform || from.transform,
            };
            if (to.dofSetting) st.dof = to.dofSetting;
          }
          break;
        }
        case 'dof': {
          const s = p.setting || {};
          const val = (k, fb) =>
            s[k] && typeof s[k] === 'object' && 'm_Value' in s[k] ? s[k].m_Value : (s[k] ?? fb);
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
          for (const [aid, aSt] of st.actors) {
            const mine = layouts.find(
              (l) => l.params.id === aid || (!l.params.id && aid === this.actorId),
            );
            if (mine) {
              aSt.visible = true;
              if (mine.params.transform) aSt.layout = mine.params.transform;
            } else {
              aSt.visible = false;
            }
          }
          break;
        }
        case 'actortween': {
          const aSt = resolveActor(p.id);
          if (!aSt) break;
          const from = p.from || aSt.layout;
          const to = p.to || from;
          if (from && to) {
            let u = c.dur > 0 ? Math.min(1, Math.max(0, (t - c.t) / c.dur)) : 1;
            if (p.ease === 'OutQuad') u = 1 - (1 - u) * (1 - u);
            const lv3 = (a, b) => ({
              x: lerp(a.x, b.x, u),
              y: lerp(a.y, b.y, u),
              z: lerp(a.z, b.z, u),
            });
            aSt.layout = {
              position:
                from.position && to.position
                  ? lv3(from.position, to.position)
                  : to.position || from.position,
              rotation:
                from.rotation && to.rotation
                  ? lv3(from.rotation, to.rotation)
                  : to.rotation || from.rotation,
              scale: to.scale || from.scale || { x: 1, y: 1, z: 1 },
            };
          }
          break;
        }
        case 'actormotion': {
          const aSt = resolveActor(p.id);
          if (!aSt) break;
          const tr = Number(p.transition ?? 0);
          aSt.prevMotion = aSt.motion;
          aSt.motion = {
            name: p.motion,
            variant: 'b',
            start: c.t,
            clipIn: c.clipIn,
            transition: tr,
          };
          if (
            this.clipOf(p.motion, 'f') &&
            !(aSt.facial && aSt.facial.explicit && Math.abs(aSt.facial.start - c.t) < 1e-4)
          ) {
            const ftr =
              p.facialTransition !== undefined
                ? Number(p.facialTransition)
                : tr > 0
                  ? 0.22
                  : 0;
            aSt.prevFacial = aSt.facial;
            aSt.facial = {
              name: p.motion,
              variant: 'f',
              start: c.t,
              clipIn: c.clipIn,
              transition: ftr,
              explicit: false,
            };
          }
          break;
        }
        case 'actorfacialmotion': {
          const aSt = resolveActor(p.id);
          if (!aSt) break;
          if (!(aSt.facial && !aSt.facial.explicit && Math.abs(aSt.facial.start - c.t) < 1e-4)) {
            aSt.prevFacial = aSt.facial;
          }
          aSt.facial = {
            name: p.motion,
            variant: 'f',
            start: c.t,
            clipIn: c.clipIn,
            transition: Number(p.transition ?? 0),
            explicit: true,
          };
          break;
        }
        case 'actorfacialoverridemotion': {
          const aSt = resolveActor(p.id);
          if (!aSt) break;
          const models = (p.setting && p.setting.faceModels) || [];
          const clipMeta = p.clip || {};
          aSt.overrides.push({
            start: c.t,
            dur: c.dur,
            easeIn: Number(clipMeta._easeInDuration ?? 0),
            easeOut: Number(clipMeta._easeOutDuration ?? 0),
            models,
          });
          break;
        }
        case 'actoradditivemotion': {
          const aSt = resolveActor(p.id);
          if (!aSt) break;
          aSt.additive.push({ name: p.motion, start: c.t, clipIn: c.clipIn });
          break;
        }
        case 'transition':
          if (p.type) st.transitions.push({ start: c.t, dur: c.dur || 0.2, type: p.type });
          break;
        case 'shake':
          st.shakes.push({ start: c.t, dur: c.dur, setting: p.setting || {} });
          break;
        case 'actorlooktarget': {
          const aSt = resolveActor(p.id);
          if (!aSt) break;
          const target = p.target || DEFAULT_LOOK_TARGET;
          aSt.looks.push({ kind: 'instant', start: c.t, dur: 0, target, endTarget: target });
          break;
        }
        case 'actorlooktargettween': {
          const aSt = resolveActor(p.id);
          if (!aSt) break;
          const prev = aSt.looks.length ? aSt.looks[aSt.looks.length - 1].endTarget : null;
          const from = p.from || prev || DEFAULT_LOOK_TARGET;
          const to = p.to || DEFAULT_LOOK_TARGET;
          aSt.looks.push({ kind: 'tween', start: c.t, dur: c.dur || 0.01, from, to, endTarget: to });
          break;
        }
        case 'voice': {
          const cueName = p.voice;
          if (!cueName) break;
          const metaDur =
            (this.lipsyncDb && this.lipsyncDb.cues && this.lipsyncDb.cues[cueName]?.duration) || 0;
          const dur = Math.max(c.dur || 0, metaDur);
          const isMine = p.actorId
            ? p.actorId === this.actorId
            : String(cueName).includes(`_${this.actorId}-`);
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
          if (t < c.t + dur + 0.35) st.activeVoice = vObj;
          for (const [aid, aSt] of st.actors) {
            const isActorMatch = p.actorId
              ? p.actorId === aid
              : String(cueName).includes(`_${aid}-`);
            if (isActorMatch && t < c.t + dur + 0.15) {
              aSt.actorVoice = { ...vObj, isMine: true };
            }
          }
          break;
        }
        case 'message':
          if (t < c.t + c.dur) {
            st.message = {
              text: p.text,
              name: p.name,
              hide: p.hide,
              start: c.t,
              dur: c.dur,
              narration: false,
            };
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

    const prim = st.actors.get(this.actorId);
    if (prim) {
      st.actorVisible = prim.visible;
      st.layout = prim.layout;
      st.motion = prim.motion;
      st.prevMotion = prim.prevMotion;
      st.facial = prim.facial;
      st.prevFacial = prim.prevFacial;
      st.overrides = prim.overrides;
      st.additive = prim.additive;
      st.looks = prim.looks;
      st.actorVoice = prim.actorVoice;
    }
    return st;
  }

  sampleLipSyncEntry(voiceName, lt, dur, msgText) {
    if (lt < 0 || (dur > 0 && lt > dur + 0.03)) return null;
    const entry = this.lipsyncDb && this.lipsyncDb.cues && this.lipsyncDb.cues[voiceName];
    if (entry && entry.frames && entry.frames.length > 0) {
      const fps = entry.fps || this.lipsyncDb.fps || 60;
      const clipDur = dur > 0 ? dur : entry.duration || entry.frames.length / fps;
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

  evalLipSyncForActor(t, st, aSt, aid) {
    if (aid === this.actorId) {
      const mv = this.voiceCtrl && this.voiceCtrl.getManualActorPlayback();
      if (mv) {
        return this.sampleLipSyncEntry(mv.voice, mv.currentTime, mv.dur, st.message?.text);
      }
    }
    const av = aSt?.actorVoice;
    if (av) {
      const liveAudioT =
        this.voiceCtrl && this.voiceCtrl.currentCue === av.voice && this.voiceCtrl.isSpeaking()
          ? this.voiceCtrl.audio.currentTime
          : t - av.start + (av.clipIn || 0);
      return this.sampleLipSyncEntry(av.voice, liveAudioT, av.dur, st.message?.text);
    }
    if (
      !this.hasVoices &&
      st.message &&
      !st.message.narration &&
      !st.message.hide &&
      st.message.name &&
      st.message.name !== '{user}' &&
      st.message.name !== USER_NAME &&
      aid === this.actorId
    ) {
      return evalTextFallbackLipSync(st.message.text, t - st.message.start, st.message.dur || 2.5);
    }
    return null;
  }

  evalLipSync(t, st) {
    return this.evalLipSyncForActor(t, st, st.actors?.get(this.actorId) || st, this.actorId);
  }

  applySingleActor(t, st, aid, entry, aSt) {
    if (!entry || !entry.char || !entry.group || !aSt) return;
    entry.group.visible = aSt.visible;
    if (!aSt.visible) return;

    const { solver } = entry.char;
    const evalOf = (m) => {
      if (!m) return null;
      const clip = this.clipOf(m.name, m.variant);
      if (!clip) return null;
      const isLoop = m.name.endsWith('_lp');
      const elapsed = Math.max(0, t - m.start + (m.clipIn || 0));
      const lt =
        isLoop && clip.duration > 0 ? elapsed % clip.duration : Math.min(clip.duration, elapsed);
      return { ev: evalClip(clip, lt), clip, elapsed };
    };

    const base = this.baseClip
      ? evalClip(this.baseClip, this.baseTime > 0 ? t % this.baseTime : 0)
      : null;

    const curM = evalOf(aSt.motion);
    const prevM = evalOf(aSt.prevMotion);
    let w = 1;
    if (curM && aSt.motion.transition > 0) {
      const u = Math.min(1, Math.max(0, (t - aSt.motion.start) / aSt.motion.transition));
      w = u * u * (3 - 2 * u);
    }

    const muscles = new Float32Array(95);
    let root = null;
    const bones = [];

    if (curM) {
      const ce = curM.ev;
      const pe = prevM ? prevM.ev : base;
      for (let i = 0; i < 95; i++) {
        const cv = ce.hasMuscle[i] ? ce.muscles[i] : base?.hasMuscle[i] ? base.muscles[i] : solver.tposeMuscles[i];
        const pv = pe && pe.hasMuscle[i] ? pe.muscles[i] : cv;
        muscles[i] = pv * (1 - w) + cv * w;
      }
      root = pe && w < 1 ? blendRoot(pe.root, ce.root, w) : ce.root;
      if (pe && w < 1 && pe.bones && pe.bones.length) {
        const pMap = new Map();
        for (const b of pe.bones) pMap.set(`${b.boneName || b.node}:${b.prop}`, b.value);
        const seen = new Set();
        for (const b of ce.bones) {
          const key = `${b.boneName || b.node}:${b.prop}`;
          seen.add(key);
          const pv = pMap.get(key);
          if (!pv) {
            bones.push(b);
          } else {
            bones.push({
              node: b.node,
              boneName: b.boneName,
              prop: b.prop,
              value: b.prop === 'rotation' ? nlerpQuat(pv, b.value, w) : lerpArr(pv, b.value, w),
            });
          }
        }
        for (const b of pe.bones) {
          if (!seen.has(`${b.boneName || b.node}:${b.prop}`)) bones.push(b);
        }
      } else {
        bones.push(...ce.bones);
      }

      if (curM.elapsed > curM.clip.duration) {
        const settle = Math.min(1, (curM.elapsed - curM.clip.duration) / 0.8);
        const breath = Math.sin((t - aSt.motion.start) * 1.75) * 0.01 * settle;
        muscles[3] += breath;
        muscles[6] += breath;
      }
    } else if (base) {
      for (let i = 0; i < 95; i++) muscles[i] = base.hasMuscle[i] ? base.muscles[i] : solver.tposeMuscles[i];
      root = base.root;
      bones.push(...base.bones);
    } else {
      muscles.set(solver.tposeMuscles);
    }

    for (const a of aSt.additive) {
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

    const manage = curM ? blendAnimationManage(prevM?.ev.manage || base?.manage, curM.ev.manage, w,
      this.animationManageProperties, this.animationManageVolume) : base?.manage;
    applyAnimationManage(solver.swing, this.animationManageProperties, manage, this.animationManageVolume);
    solver.applyPose(null, solver.poseFrom(muscles, bones, root), 1);

    const morph = new Map();
    const curF = evalOf(aSt.facial);
    const prevF = evalOf(aSt.prevFacial);
    const fallbackF = !curF && aSt.motion ? evalOf({ ...aSt.motion, variant: 'f' }) : null;
    const activeF = curF || fallbackF;
    if (activeF) {
      const fw =
        curF && prevF && aSt.facial.transition > 0
          ? Math.min(1, Math.max(0, (t - aSt.facial.start) / aSt.facial.transition))
          : 1;
      if (prevF && fw < 1) {
        for (const [i, v] of prevF.ev.morph) morph.set(i, v * (1 - fw));
      }
      for (const [i, v] of activeF.ev.morph) {
        morph.set(i, (morph.get(i) || 0) + v * fw);
      }
    }

    for (const o of aSt.overrides) {
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

    let eyeBusy = 0;
    for (let ei = 20; ei <= 38; ei++) eyeBusy += morph.get(ei) || 0;
    if (eyeBusy < 0.12) {
      const period = 3.6 + 0.9 * hash01(Math.floor(t / 3.6) + aid.charCodeAt(0));
      const x = t % period;
      if (x > 1.4 && x < 1.53) {
        const closed = Math.sin(((x - 1.4) / 0.13) * Math.PI);
        morph.set(BLINK_MORPH_INDEX, Math.max(morph.get(BLINK_MORPH_INDEX) || 0, closed));
      }
    }

    const vowels = this.evalLipSyncForActor(t, st, aSt, aid);
    if (vowels) applyLipSyncToMorph(morph, vowels);

    entry.char.setMorph(morph);
    const L = aSt.layout;
    const offset = aid === this.actorId ? this.actorTransformOffset : null;
    const ox = Number(offset?.x) || 0;
    const oy = Number(offset?.y) || 0;
    const oz = Number(offset?.z) || 0;
    const orotY = Number(offset?.rotY) || 0;
    if (L) {
      entry.group.position.set(L.position.x + ox, L.position.y + oy, -L.position.z + oz);
      entry.group.quaternion.copy(unityEulerQuat(L.rotation.x, L.rotation.y, L.rotation.z));
      if (Math.abs(orotY) > 1e-4) {
        entry.group.quaternion.premultiply(
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            THREE.MathUtils.degToRad(orotY),
          ),
        );
      }
      const s = L.scale || { x: 1, y: 1, z: 1 };
      entry.group.scale.set(s.x, s.y, s.z);
    } else if (aid === this.actorId) {
      entry.group.position.set(ox, oy, oz);
      entry.group.rotation.set(0, THREE.MathUtils.degToRad(orotY), 0);
      entry.group.scale.set(1, 1, 1);
    }
    entry.group.updateMatrixWorld(true);
  }

  applyCharacter(t, st) {
    for (const [aid, entry] of this.actorEntries) {
      const aSt = st.actors ? st.actors.get(aid) : null;
      if (aSt) this.applySingleActor(t, st, aid, entry, aSt);
    }
  }
}

export class ViewerEngine {
  constructor() {
    this.listeners = new Set();
    this.mode = 'asset'; // 'asset' | 'story'
    this.mounted = false;
    this.container = null;
    this.bgEl = null;
    this.viewportWidth = 960;
    this.viewportHeight = 540;

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.bloom = null;
    this.useBloom = true;
    this.sunLight = null;
    this.stageHemi = null;
    this.groundShadow = null;
    this.actorGroup = null;
    this.envGroup = null;
    this.skyTexture = null;
    this.envInfo = null;
    this.envLoaded = false;
    this.env3dCache = new Map();
    this._env3dLoads = new Map();
    this._bg2dLoads = new Map();
    this._characterRequest = 0;
    this._sceneRequest = 0;
    this.activeEnv3dName = null;

    this.char = null;
    this.currentParts = { ...DEFAULT_PARTS };
    this.extraStoryActors = new Map();
    // Asset Browser state
    this.assetPlaying = true;
    this.assetLoop = true;
    this.assetSpeed = 1;
    this.assetTime = 0;
    this.assetDuration = 4;
    this.assetBodyMotionName = 'mot_all_chr_amao_glad-001_in';
    this.assetFacialMotionName = 'mot_all_chr_amao_facial-all-default_in';
    this.assetBodyClip = null;
    this.assetFacialClip = null;
    this.assetStageMode = 'studio'; // 'studio' | 'classroom' | sceneName
    this.assetSceneName = 'studio'; // 'studio' | 'env_3d_*' | 'env_2d_*'
    this.assetEnableIK = true;
    this.assetEnableSwing = true;
    this.animationManageProperties = null;
    this.assetManualMorphs = new Map();
    this.assetActorTransform = { x: 0, y: 0, z: 0, rotY: 0 };
    this.storyActorTransform = { x: 0, y: 0, z: 0, rotY: 0 };
    this.showActorGizmo = false;
    this.actorGizmo = null;
    this.gizmoYawGroup = null;
    this._gizmoPickables = [];
    this._gizmoHovered = null;
    this._gizmoDrag = null;
    this._raycaster = new THREE.Raycaster();
    this._pointerNdc = new THREE.Vector2();
    this._dragPlane = new THREE.Plane();
    this._dragHitPoint = new THREE.Vector3();
    this._gizmoEuler = new THREE.Euler(0, 0, 0, 'YXZ');

    // Story Browser state
    this.lipsyncDb = { fps: 60, cues: {} };
    this.voiceCtrl = new VoiceController(this.lipsyncDb, () => this._emit());
    this.storyScriptUrl = './assets/script.txt';
    this.storyScriptLabel = 'script.txt';
    this.storyTimeline = null;
    this.storyPlayer = null;
    this.storyPlaying = false;
    this.storySpeed = 1;
    this.storyTime = 0;
    this.storyDuration = 0;
    this.storyCameraLocked = false;
    this.storyDialogueList = [];
    this.storyCues = [];
    this.storyActiveMessage = null;
    this.storyFade = { color: '#000000', opacity: 0 };
    this.storyStatus = 'Ready';
    this.bgMeta = {};
    this.bgImages = new Map();
    this.bgTextures = new Map();
    this._bgUvMat = new THREE.Matrix3();
    this._lastVolumeSrc = null;

    this.loading = true;
    this.loadingText = 'Initializing WASM & 3D Engine…';

    // Temp vectors for lookAt
    this._lookActPosW = new THREE.Vector3();
    this._lookActQuatW = new THREE.Quaternion();
    this._lookActQuatInv = new THREE.Quaternion();
    this._lookTargetA = new THREE.Vector3();
    this._lookTargetB = new THREE.Vector3();
    this._lookBonePosW = new THREE.Vector3();
    this._lookBoneQuatW = new THREE.Quaternion();
    this._lookParentQuatW = new THREE.Quaternion();
    this._lookDesLocal = new THREE.Vector3();
    this._lookCurLocal = new THREE.Vector3();
    this._lookDeltaQuat = new THREE.Quaternion();
    this._lookRotActor = new THREE.Quaternion();
    this._lookRotWorld = new THREE.Quaternion();
    this._lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

    // Monotonic simulation time between explicit resets, independent of clip
    // wrap, playback speed and held end poses. UI-only renders do not advance it.
    this.physicsTime = 0;

    this._lastEmitTs = 0;
    this._rafId = 0;
    this._lastFrameNow = performance.now();
    this._resizeObserver = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  getSnapshot() {
    return {
      mode: this.mode,
      loading: this.loading,
      loadingText: this.loadingText,
      useBloom: this.useBloom,
      currentParts: { ...this.currentParts },

      // Asset mode state
      assetPlaying: this.assetPlaying,
      assetLoop: this.assetLoop,
      assetSpeed: this.assetSpeed,
      assetTime: this.assetTime,
      assetDuration: this.assetDuration,
      assetBodyMotionName: this.assetBodyMotionName,
      assetFacialMotionName: this.assetFacialMotionName,
      assetStageMode: this.assetStageMode,
      assetSceneName: this.assetSceneName,
      assetEnableIK: this.assetEnableIK,
      assetEnableSwing: this.assetEnableSwing,
      faceBlendShapeCount: this.char?.meta?.faceBlendShapeCount || 0,
      assetActorTransform: { ...this.assetActorTransform },
      storyActorTransform: { ...this.storyActorTransform },
      showActorGizmo: this.showActorGizmo,

      // Story mode state
      storyScriptUrl: this.storyScriptUrl,
      storyScriptLabel: this.storyScriptLabel,
      storyPlaying: this.storyPlaying,
      storySpeed: this.storySpeed,
      storyTime: this.storyTime,
      storyDuration: this.storyDuration,
      storyCameraLocked: this.storyCameraLocked,
      storyDialogueList: this.storyDialogueList,
      storyActiveMessage: this.storyActiveMessage,
      storyFade: this.storyFade,
      storyStatus: this.storyStatus,
      voiceMuted: this.voiceCtrl.muted,
      voiceVolume: this.voiceCtrl.userVolume,
      voiceSpeaking: this.voiceCtrl.isSpeaking(),
      voiceAutoplayBlocked: this.voiceCtrl.autoplayBlocked,
    };
  }

  mount(canvasContainer, bg2dContainer) {
    this.container = canvasContainer;
    this.bgEl = bg2dContainer;

    if (!this.renderer) {
      this._initThree();
      this._setupWindowHooks();
      this._bootInitial();
    } else {
      canvasContainer.innerHTML = '';
      canvasContainer.appendChild(this.renderer.domElement);
    }

    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvasContainer);
    this.resize();

    if (!this._rafId) {
      this._lastFrameNow = performance.now();
      const loop = (now) => {
        this._rafId = requestAnimationFrame(loop);
        this._tick(now);
      };
      this._rafId = requestAnimationFrame(loop);
    }
  }

  unmount() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  _initThree() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;
    this.container.innerHTML = '';
    this.container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.08, 1000);
    camera.position.set(0, 1.24, -1.75);
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.08, 0);
    controls.dampingFactor = 0.08;
    controls.update();
    this.controls = controls;

    const sunLight = new THREE.DirectionalLight(0xfffaf0, 2.1);
    sunLight.position.set(2.5, 4.5, -4.0);
    scene.add(sunLight);
    this.sunLight = sunLight;

    const stageHemi = new THREE.HemisphereLight(0xf6f4ee, 0x9e9284, 1.45);
    scene.add(stageHemi);
    this.stageHemi = stageHemi;

    const groundShadow = this._createGroundShadow();
    scene.add(groundShadow);
    this.groundShadow = groundShadow;
    const actorGroup = new THREE.Group();
    scene.add(actorGroup);
    this.actorGroup = actorGroup;
    const actorGizmo = this._createActorGizmo();
    scene.add(actorGizmo);
    this.actorGizmo = actorGizmo;
    this._bindGizmoPointerEvents(renderer.domElement);

    const envGroup = new THREE.Group();
    envGroup.visible = false;
    scene.add(envGroup);
    this.envGroup = envGroup;

    this.bloom = createBloom(renderer, {
      strength: 0.32,
      threshold: 0.98,
      knee: 0.25,
      exposure: 0.97,
      contrast: 1.04,
      saturation: 1.06,
    });
  }

  _createGroundShadow() {
    const groundShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.68, 0.52),
      new THREE.MeshBasicMaterial({
        map: blobTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 0.72,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    groundShadow.rotation.x = -Math.PI / 2;
    groundShadow.position.y = 0.004;
    groundShadow.renderOrder = 4;
    return groundShadow;
  }

  _createActorGizmo() {
    const gizmo = new THREE.Group();
    gizmo.name = 'ActorTransformGizmo';
    gizmo.visible = false;
    const pickables = [];

    // Ground XZ free-move disc
    const xzMat = new THREE.MeshBasicMaterial({
      color: 0x4c9aff,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    const xzMesh = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.24, 40), xzMat);
    xzMesh.rotation.x = -Math.PI / 2;
    xzMesh.position.y = 0.008;
    xzMesh.renderOrder = 25;
    xzMesh.userData = {
      gizmoAxis: 'xz',
      visualMat: xzMat,
      baseColor: 0x4c9aff,
      hoverColor: 0x8ec2ff,
      baseOpacity: 0.28,
      hoverOpacity: 0.52,
    };
    gizmo.add(xzMesh);
    pickables.push(xzMesh);

    const makeAxisArrow = (axis, colorHex, hoverHex, dirVec) => {
      const mat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: false,
      });
      const hitMat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
      });
      const group = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.34, 12), mat);
      shaft.position.y = 0.19;
      shaft.renderOrder = 26;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.085, 16), mat);
      head.position.y = 0.38;
      head.renderOrder = 26;
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.44, 8), hitMat);
      hit.position.y = 0.22;
      const uData = {
        gizmoAxis: axis,
        visualMat: mat,
        baseColor: colorHex,
        hoverColor: hoverHex,
        baseOpacity: 0.9,
        hoverOpacity: 1.0,
      };
      shaft.userData = uData;
      head.userData = uData;
      hit.userData = uData;
      group.add(shaft, head, hit);
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirVec.clone().normalize());
      if (axis !== 'y') group.position.y = 0.015;
      gizmo.add(group);
      pickables.push(hit, shaft, head);
    };

    makeAxisArrow('x', 0xff5668, 0xff94a0, new THREE.Vector3(1, 0, 0));
    makeAxisArrow('y', 0x42d392, 0x85f2c0, new THREE.Vector3(0, 1, 0));
    makeAxisArrow('z', 0x4c9aff, 0x94c4ff, new THREE.Vector3(0, 0, 1));

    // Outer Yaw Rotation Ring + Forward Arrow (-Z in local character space)
    const yawGroup = new THREE.Group();
    yawGroup.position.y = 0.012;
    const yawMat = new THREE.MeshBasicMaterial({
      color: 0xe868b8,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    const yawHitMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    const ringMesh = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.013, 12, 64), yawMat);
    ringMesh.rotation.x = Math.PI / 2;
    ringMesh.renderOrder = 26;
    const frontCone = new THREE.Mesh(new THREE.ConeGeometry(0.044, 0.11, 16), yawMat);
    frontCone.rotation.x = -Math.PI / 2;
    frontCone.position.set(0, 0, -0.53);
    frontCone.renderOrder = 26;
    const ringHit = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.055, 8, 48), yawHitMat);
    ringHit.rotation.x = Math.PI / 2;
    const yawData = {
      gizmoAxis: 'rotY',
      visualMat: yawMat,
      baseColor: 0xe868b8,
      hoverColor: 0xffaee0,
      baseOpacity: 0.88,
      hoverOpacity: 1.0,
    };
    ringMesh.userData = yawData;
    frontCone.userData = yawData;
    ringHit.userData = yawData;
    yawGroup.add(ringMesh, frontCone, ringHit);
    gizmo.add(yawGroup);
    this.gizmoYawGroup = yawGroup;
    pickables.push(ringHit, ringMesh, frontCone);

    this._gizmoPickables = pickables;
    return gizmo;
  }

  _setGizmoHover(hitObj) {
    const nextData = hitObj?.userData?.gizmoAxis ? hitObj.userData : null;
    if (this._gizmoHovered === nextData) return;
    if (this._gizmoHovered && this._gizmoHovered.visualMat) {
      this._gizmoHovered.visualMat.color.setHex(this._gizmoHovered.baseColor);
      this._gizmoHovered.visualMat.opacity = this._gizmoHovered.baseOpacity;
    }
    this._gizmoHovered = nextData;
    if (nextData && nextData.visualMat) {
      nextData.visualMat.color.setHex(nextData.hoverColor);
      nextData.visualMat.opacity = nextData.hoverOpacity;
    }
    this.renderFrame();
  }

  _getPointerRay(clientX, clientY) {
    if (!this.renderer || !this.camera) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this._pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._pointerNdc, this.camera);
    return this._raycaster.ray;
  }

  _bindGizmoPointerEvents(domElement) {
    const onPointerDown = (e) => {
      if (e.button !== 0 || !this.showActorGizmo || !this.actorGizmo || !this.actorGizmo.visible) {
        return;
      }
      const ray = this._getPointerRay(e.clientX, e.clientY);
      if (!ray) return;
      const hits = this._raycaster.intersectObjects(this._gizmoPickables, false);
      if (!hits.length) return;
      const hitObj = hits[0].object;
      const axis = hitObj?.userData?.gizmoAxis;
      if (!axis) return;

      this._setGizmoHover(hitObj);
      const groupPos = this.actorGroup.position.clone();
      const curTf = {
        ...(this.mode === 'asset' ? this.assetActorTransform : this.storyActorTransform),
      };

      if (axis === 'y') {
        const n = new THREE.Vector3(
          this.camera.position.x - groupPos.x,
          0,
          this.camera.position.z - groupPos.z,
        );
        if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
        else n.normalize();
        this._dragPlane.setFromNormalAndCoplanarPoint(n, groupPos);
      } else {
        this._dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), groupPos);
      }

      if (!ray.intersectPlane(this._dragPlane, this._dragHitPoint)) {
        this._dragHitPoint.copy(hits[0].point);
      }
      const startAngle = Math.atan2(
        -(this._dragHitPoint.x - groupPos.x),
        -(this._dragHitPoint.z - groupPos.z),
      );
      this._gizmoDrag = {
        axis,
        pointerId: e.pointerId,
        startTransform: curTf,
        startGroupPos: groupPos,
        startHit: this._dragHitPoint.clone(),
        startAngle,
      };
      if (this.controls) this.controls.enabled = false;
      domElement.style.cursor = 'grabbing';
      try {
        domElement.setPointerCapture(e.pointerId);
      } catch {
        /* ignore synthetic pointer events */
      }
      e.stopPropagation();
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (this._gizmoDrag) {
        const drag = this._gizmoDrag;
        const ray = this._getPointerRay(e.clientX, e.clientY);
        if (!ray || !ray.intersectPlane(this._dragPlane, this._dragHitPoint)) return;
        if (drag.axis === 'y') {
          const dy = Math.max(-10, Math.min(10, this._dragHitPoint.y - drag.startHit.y));
          this.setActorTransform({ y: Number((drag.startTransform.y + dy).toFixed(3)) });
        } else if (drag.axis === 'rotY') {
          const dx = this._dragHitPoint.x - drag.startGroupPos.x;
          const dz = this._dragHitPoint.z - drag.startGroupPos.z;
          if (Math.hypot(dx, dz) > 1e-4) {
            const curAngle = Math.atan2(-dx, -dz);
            const deltaDeg = THREE.MathUtils.radToDeg(curAngle - drag.startAngle);
            this.setActorTransform({ rotY: Math.round(drag.startTransform.rotY + deltaDeg) });
          }
        } else {
          let dx = this._dragHitPoint.x - drag.startHit.x;
          let dz = this._dragHitPoint.z - drag.startHit.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 30) {
            dx *= 30 / dist;
            dz *= 30 / dist;
          }
          const patch = {};
          if (drag.axis === 'x' || drag.axis === 'xz') {
            patch.x = Number((drag.startTransform.x + dx).toFixed(3));
          }
          if (drag.axis === 'z' || drag.axis === 'xz') {
            patch.z = Number((drag.startTransform.z + dz).toFixed(3));
          }
          this.setActorTransform(patch);
        }
        e.stopPropagation();
        return;
      }

      if (!this.showActorGizmo || !this.actorGizmo || !this.actorGizmo.visible) {
        if (this._gizmoHovered) {
          this._setGizmoHover(null);
          domElement.style.cursor = '';
        }
        return;
      }
      const ray = this._getPointerRay(e.clientX, e.clientY);
      if (!ray) return;
      const hits = this._raycaster.intersectObjects(this._gizmoPickables, false);
      const hitObj = hits.length ? hits[0].object : null;
      this._setGizmoHover(hitObj);
      domElement.style.cursor = hitObj ? 'grab' : '';
    };

    const onPointerUp = (e) => {
      if (!this._gizmoDrag) return;
      try {
        if (domElement.hasPointerCapture?.(this._gizmoDrag.pointerId)) {
          domElement.releasePointerCapture(this._gizmoDrag.pointerId);
        }
      } catch {
        /* ignore */
      }
      this._gizmoDrag = null;
      if (this.controls) {
        this.controls.enabled = this.mode === 'asset' ? true : this.storyCameraLocked;
      }
      domElement.style.cursor = this._gizmoHovered ? 'grab' : '';
      e.stopPropagation();
    };

    domElement.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  _syncActorGizmoTransform() {
    if (!this.actorGizmo) return;
    const visible = Boolean(this.showActorGizmo && this.actorGroup && this.actorGroup.visible);
    this.actorGizmo.visible = visible;
    if (!visible) return;
    this.actorGizmo.position.copy(this.actorGroup.position);
    if (this.gizmoYawGroup) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.actorGroup.quaternion);
      this.gizmoYawGroup.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
    }
  }

  setViewportSize(w, h, pixelRatio = null) {
    if (!this.renderer || !this.camera) return;
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    this.viewportWidth = width;
    this.viewportHeight = height;
    if (pixelRatio !== null) {
      this.renderer.setPixelRatio(pixelRatio);
    }
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.bloom) this.bloom.setSize(width, height);
  }

  resize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.setViewportSize(w, h);
    this.renderFrame();
  }

  async _bootInitial() {
    try {
      const isHeadless =
        typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('headless') === '1';
      if (isHeadless) {
        this.mode = 'story';
        this.voiceCtrl.muted = true;
        await getBrowserEnv();
        this.loading = false;
        this.loadingText = '';
        this._setupWindowHooks();
        this._emit();
        return;
      }

      this.loading = true;
      this.loadingText = '正在通过 WASM 解密并构建角色与 3D 教室资产…';
      this._emit();

      await getBrowserEnv();
      const [char, stage] = await Promise.all([
        loadCharacter(null, this.currentParts),
        this._loadEnv3d().catch((e) => {
          console.warn('env load failed', e);
          return null;
        }),
      ]);
      this.char = char;
      this.envInfo = stage;
      setClipCharMeta(char.meta);
      if (stage?.meta?.volumes) {
        char.applyActorVolume(stage.meta.volumes);
      }
      char.root.position.set(0, 0, 0);
      this.actorGroup.add(char.root);

      await Promise.all([
        this.setAssetBodyMotion(this.assetBodyMotionName),
        this.setAssetFacialMotion(this.assetFacialMotionName),
      ]);

      this.loading = false;
      this.loadingText = '';
      this._setupWindowHooks();
      this._emit();
      this.renderFrame();

      if (this.mode === 'story' && !this.storyTimeline && !this._storyLoad) {
        await this.loadStoryFromUrl(this.storyScriptUrl, 'script.txt', false);
      }
    } catch (e) {
      console.error('Boot error:', e);
      this.loading = false;
      this.loadingText = `Error: ${e?.message || e}`;
      this._emit();
    }
  }

  async _loadEnv3d(sceneName = 'env_3d_adv_classroom-00-00-noon') {
    if (this.env3dCache.has(sceneName)) return this._activateEnv3d(sceneName);
    if (this._env3dLoads.has(sceneName)) return this._env3dLoads.get(sceneName);
    const pending = this._buildEnv3d(sceneName);
    this._env3dLoads.set(sceneName, pending);
    try {
      return await pending;
    } finally {
      this._env3dLoads.delete(sceneName);
    }
  }

  async _buildEnv3d(sceneName) {
    if (this.env3dCache.has(sceneName)) {
      return this._activateEnv3d(sceneName);
    }
    const sharedEnv = await getBrowserEnv();
    const env = sharedEnv.createScope();
    let needsServerEnsure = !env.hasBundle(sceneName);
    if (!needsServerEnsure) {
      try {
        const container = await env.ensureBundle(sceneName, false);
        for (const sf of container.serializedFiles) {
          for (const ext of sf.externals) {
            const base = ext.path.split('/').pop().toLowerCase();
            if (base && base.startsWith('cab-') && !env.index.cabToBundle[base]) {
              needsServerEnsure = true;
              break;
            }
          }
          if (needsServerEnsure) break;
        }
      } catch {
        needsServerEnsure = true;
      }
    }
    if (needsServerEnsure) {
      await this.ensureAssetsOnServer([sceneName, 't_sky_noon-00'], [], true).catch(() => {});
      env.updateIndex(sharedEnv.index);
    }
    let { glbBytes, meta, textures } = await buildEnv3dFromBundles(env, sceneName);
    const gltf = await new GLTFLoader().parseAsync(
      glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength),
      '',
    );
    glbBytes = null;
    const stageGroup = new THREE.Group();
    stageGroup.name = sceneName;
    stageGroup.add(gltf.scene);
    const entry = { sceneName, meta, group: stageGroup, skyTexture: null, skyTarget: null, textures: new Set() };
    try {

    const stageTexCache = new Map();
    const stageTex = (rel, srgb, flipY = false, maxDim = 1024) => {
      if (!rel) return null;
      const image = textures.get(rel);
      if (!image) return null;
      const ckey = `${rel}|${srgb ? 1 : 0}|${flipY ? 1 : 0}|${maxDim}`;
      let tex = stageTexCache.get(ckey);
      if (!tex) {
        const img =
          image.width > maxDim || image.height > maxDim
            ? downsampleRgba(image.data, image.width, image.height, maxDim)
            : image;
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
        entry.textures.add(tex);
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

    let stageSkyTexture = null;
    if (meta.skybox) {
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
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        try {
          entry.skyTarget = pmrem.fromEquirectangular(eqTex);
          stageSkyTexture = entry.skyTarget.texture;
        } finally {
          pmrem.dispose();
          eqTex.dispose();
        }
      }
    }

    const lmVolIntensity =
      (meta.volumes && meta.volumes.lightmap && meta.volumes.lightmap.intensity) ?? 0.95;
    const lmScale = 1.45 * Math.PI * lmVolIntensity;

    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry && o.geometry.attributes.uv2 && !o.geometry.attributes.uv1) {
        o.geometry.setAttribute('uv1', o.geometry.attributes.uv2);
      }
      const exactName = o.name.replace(/^env_/, '');
      const strippedName = exactName.replace(/_\d+$/, '');
      const parentName = o.parent && o.parent.name ? o.parent.name.replace(/^env_/, '') : '';
      const info =
        meta.prims[exactName] || meta.prims[parentName] || meta.prims[strippedName] || {};
      const matName = info.material || exactName.split('|')[0] || '';
      const mdesc = (meta.materials && meta.materials[matName]) || { colors: {}, floats: {} };

      const albedoRel = mdesc.maps && (mdesc.maps._BaseMap || mdesc.maps._MainTex);
      const albedo = albedoRel ? stageTex(albedoRel, true, false) : null;

      const bc = mdesc.colors._BaseColor || mdesc.colors._Color || [1, 1, 1, 1];
      const ovr = info.overrideColor || [1, 1, 1, 1];
      const tint = new THREE.Color(bc[0] * ovr[0], bc[1] * ovr[1], bc[2] * ovr[2]);
      const alphaFactor = (bc[3] ?? 1) * (ovr[3] ?? 1);

      const fl = mdesc.floats || {};
      const alphaClip = (fl._AlphaClip ?? 0) >= 0.5;
      const isGlass = /glass|window/i.test(matName);
      const isBlend =
        isGlass || /_trs|_alp/i.test(matName) || fl._Surface === 1 || fl._DstBlend === 10;
      const side = fl._Cull === 0 ? THREE.DoubleSide : THREE.FrontSide;

      const ec = mdesc.colors._EmissionColor || [0, 0, 0, 1];
      const emMax = Math.max(ec[0] || 0, ec[1] || 0, ec[2] || 0);
      const defRel = mdesc.maps && mdesc.maps._DefMap;
      const defMap = emMax > 0.5 && defRel ? stageTex(defRel, false, false) : null;

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
        mat = new THREE.MeshStandardMaterial({
          name: matName,
          map: albedo,
          color: tint,
          roughness: 0.68,
          metalness: 0.04,
          envMap: isGlass ? null : stageSkyTexture,
          envMapIntensity: isGlass ? 0.0 : 0.4,
          side,
          transparent: isBlend,
          opacity: isBlend ? alphaFactor : 1.0,
          alphaTest: alphaClip ? (fl._Cutoff ?? 0.5) : 0,
          depthWrite: !isBlend,
        });
      }
      if (defMap && emMax > 0.5) {
        const emVec = new THREE.Vector3(ec[0], ec[1], ec[2]);
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uStageDef = { value: defMap };
          shader.uniforms.uStageEmissive = { value: emVec };
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              '#include <common>\nuniform sampler2D uStageDef;\nuniform vec3 uStageEmissive;',
            )
            .replace(
              '#include <opaque_fragment>',
              '#ifdef USE_MAP\n\toutgoingLight += texture2D(uStageDef, vMapUv).g * uStageEmissive;\n\t#endif\n\t#include <opaque_fragment>',
            );
        };
        mat.customProgramCacheKey = () => `emis-${matName}`;
      }
      if (isBlend) o.renderOrder = 2;
      const previousMaterials = Array.isArray(o.material) ? o.material : [o.material];
      for (const previous of previousMaterials) previous?.dispose();
      o.material = mat;
    });


    for (const d of meta.decals || []) {
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
      stageGroup.add(dm);
    }

    this.envGroup.add(stageGroup);
    entry.skyTexture = stageSkyTexture;
    textures.clear();
    textures = null;
    this.env3dCache.set(sceneName, entry);
    this.envLoaded = true;
    return this._activateEnv3d(sceneName);
    } catch (error) {
      this.env3dCache.delete(sceneName);
      this._disposeEnv3d(entry);
      throw error;
    } finally {
      textures?.clear();
    }
  }

  _disposeEnv3d(entry) {
    entry.group.removeFromParent();
    const geometries = new Set();
    const materials = new Set();
    entry.group.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material) materials.add(material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of entry.textures) texture.dispose();
    entry.textures.clear();
    entry.skyTarget?.dispose();
    entry.group.clear();
  }

  _pruneSceneResources(timeline = this.storyTimeline) {
    // Keep only the selected asset scene and the current story's seekable backgrounds.
    const keep = new Set([this.assetSceneName]);
    for (const bg of timeline?.backgrounds.values() || []) if (bg?.src) keep.add(bg.src);
    for (const [name, entry] of this.env3dCache) {
      if (keep.has(name)) continue;
      if (this.scene.background === entry.skyTexture) this.scene.background = null;
      if (this.envInfo === entry) {
        this.envInfo = null;
        this.skyTexture = null;
        this.activeEnv3dName = null;
      }
      this._disposeEnv3d(entry);
      this.env3dCache.delete(name);
    }
    this.envLoaded = this.env3dCache.size > 0;
    for (const [name, texture] of this.bgTextures) {
      if (keep.has(name)) continue;
      // Drop post-processing references before deleting the GPU texture.
      this.bloom?.setBg2D({ active: false });
      texture.dispose();
      this.bgTextures.delete(name);
      const image = this.bgImages.get(name);
      if (image) { image.removeAttribute('src'); image.remove(); }
      this.bgImages.delete(name);
      const info = this.bgMeta[name];
      if (info?.blobUrl) URL.revokeObjectURL(info.blobUrl);
      delete this.bgMeta[name];
    }
    this.renderer?.renderLists.dispose();
  }

  _activateEnv3d(sceneName) {
    const targetName =
      sceneName && this.env3dCache.has(sceneName)
        ? sceneName
        : this.env3dCache.keys().next().value || null;
    if (!targetName) return null;
    const entry = this.env3dCache.get(targetName);
    if (!entry) return null;
    for (const [k, e] of this.env3dCache) {
      e.group.visible = k === targetName;
    }
    if (this.activeEnv3dName !== targetName) {
      this.activeEnv3dName = targetName;
      this.envInfo = entry;
      this.skyTexture = entry.skyTexture || null;
      const { meta } = entry;
      if (meta.renderSettings) {
        const rs = meta.renderSettings;
        if (rs.ambientSkyColor) this.stageHemi.color.setRGB(...rs.ambientSkyColor);
        if (rs.ambientGroundColor) this.stageHemi.groundColor.setRGB(...rs.ambientGroundColor);
        this.stageHemi.intensity = 1.55;
      }
      if (Array.isArray(meta.lights)) {
        const dirL = meta.lights.find((l) => l.type === 1);
        if (dirL && dirL.direction) {
          this.sunLight.color.setRGB(...dirL.color);
          this.sunLight.position.set(
            -dirL.direction[0] * 10,
            -dirL.direction[1] * 10,
            -dirL.direction[2] * 10,
          );
          this.sunLight.intensity = 2.0;
        }
      }
    }
    return entry;
  }

  async ensureAssetsOnServer(bundleNames = [], resourceNames = [], forceBundles = false) {
    const env = await getBrowserEnv();
    const missingBundles = forceBundles
      ? [...new Set(bundleNames.filter(Boolean))]
      : [...new Set(bundleNames.filter((n) => n && !env.hasBundle(n)))];
    const cachedResources = new Set(
      (env.index && Array.isArray(env.index.resources) ? env.index.resources : []).map((r) =>
        String(r),
      ),
    );
    const missingResources = [
      ...new Set(resourceNames.filter((r) => r && !cachedResources.has(r))),
    ];
    if (missingBundles.length === 0 && missingResources.length === 0) return null;
    this.loading = true;
    this.loadingText = `正在从 Octo 清单拉取并补齐资源 (${missingBundles.length} bundles, ${missingResources.length} resources)…`;
    this._emit();
    const resp = await fetch('/api/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundles: missingBundles, resources: missingResources }),
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (data.index) env.updateIndex(data.index);
    return data.catalog || null;
  }

  async ensureBundlesOnServer(bundleNames, forceBundles = false) {
    return this.ensureAssetsOnServer(bundleNames, [], forceBundles);
  }

  async _loadBg2d(src) {
    if (!src || this.bgMeta[src]) return null;
    if (this._bg2dLoads.has(src)) return this._bg2dLoads.get(src);
    const pending = this._buildBg2d(src);
    this._bg2dLoads.set(src, pending);
    try {
      return await pending;
    } finally {
      this._bg2dLoads.delete(src);
    }
  }

  async _buildBg2d(src) {
    const env = await getBrowserEnv();
    let updatedCatalog = null;
    if (!env.hasBundle(src)) {
      updatedCatalog = await this.ensureBundlesOnServer([src]).catch(() => null);
    }
    const info = await loadBg2dFromBundle(env, src);
    if (!info) return updatedCatalog;
    this.bgMeta[src] = info;
    const tex = new THREE.DataTexture(
      info.rgba,
      info.width,
      info.height,
      THREE.RGBAFormat,
    );
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.bgTextures.set(src, tex);
    if (this.bgEl && !this.bgImages.has(src)) {
      const img = document.createElement('img');
      img.src = info.blobUrl;
      img.style.display = 'none';
      this.bgEl.appendChild(img);
      this.bgImages.set(src, img);
      if (typeof img.decode === 'function') await img.decode().catch(() => {});
    }
    return updatedCatalog;
  }

  _syncAssetSceneLighting() {
    const sceneName = this.assetSceneName || 'studio';
    if (sceneName.startsWith('env_3d_') && this.env3dCache.has(sceneName)) {
      this._activateEnv3d(sceneName);
      if (this.char) {
        this.char.applyActorVolume(this.envInfo?.meta?.volumes || null);
      }
      return;
    }
    if (this.sunLight) {
      this.sunLight.color.setHex(0xfffaf0);
      this.sunLight.position.set(2.5, 4.5, -4.0);
      this.sunLight.intensity = 2.1;
    }
    if (this.stageHemi) {
      this.stageHemi.color.setHex(0xf6f4ee);
      this.stageHemi.groundColor.setHex(0x9e9284);
      this.stageHemi.intensity = 1.45;
    }
    if (this.char) {
      if (sceneName.startsWith('env_2d_') && this.bgMeta[sceneName]?.volumes) {
        this.char.applyActorVolume(this.bgMeta[sceneName].volumes);
      } else {
        this.char.applyActorVolume(null);
      }
    }
  }

  // -------------------- Mode Switching --------------------
  _resetPhysics(time) {
    this.physicsTime = time;
    this.char?.solver.resetSwing();
    for (const entry of this.extraStoryActors.values()) entry.char?.solver.resetSwing();
  }

  setMode(newMode) {
    if (this.mode === newMode) return;
    this._resetPhysics(newMode === 'asset' ? this.assetTime : this.storyTime);
    this.mode = newMode;
    if (newMode === 'asset') {
      this.storyPlaying = false;
      this.voiceCtrl.audio.pause();
      this._syncAssetSceneLighting();
      const { x, y, z, rotY } = this.assetActorTransform;
      this.actorGroup.visible = true;
      this.actorGroup.position.set(x, y, z);
      this.actorGroup.rotation.set(0, THREE.MathUtils.degToRad(rotY), 0);
      this.actorGroup.scale.set(1, 1, 1);
      this.controls.enabled = true;
      this.setAssetCameraPreset('full');
      if (this.char) {
        this.char.solver.enableIK = this.assetEnableIK;
        this.char.solver.enableSwing = this.assetEnableSwing;
      }
    } else {
      // Story mode
      this.controls.enabled = this.storyCameraLocked;
      if (this.char) {
        this.char.solver.enableIK = true;
        this.char.solver.enableSwing = true;
      }
      if (!this.storyTimeline && !this._storyLoad) {
        this.loadStoryFromUrl(this.storyScriptUrl, 'script.txt', false);
      }
    }
    this._emit();
    this.renderFrame();
  }

  // -------------------- Tab 1: Asset Browser Controls --------------------
  async loadCharacterParts(parts) {
    const request = ++this._characterRequest;
    const nextParts = {
      body: parts.body || this.currentParts.body,
      face: parts.face || this.currentParts.face,
      hair: parts.hair || this.currentParts.hair,
    };
    try {
      this.loading = true;
      this.loadingText = `正在加载角色模型 (${nextParts.body})…`;
      this._emit();

      const updatedCatalog = await this.ensureBundlesOnServer([
        nextParts.body,
        nextParts.face,
        nextParts.hair,
      ]);
      if (request !== this._characterRequest) return updatedCatalog;
      const newChar = await loadCharacter(null, nextParts);
      if (request !== this._characterRequest) {
        newChar.dispose();
        return updatedCatalog;
      }
      const oldChar = this.char;
      if (this.char) {
        this.char.dispose();
      }
      this.char = newChar;
      this.currentParts = nextParts;
      setClipCharMeta(newChar.meta);
      this._syncAssetSceneLighting();
      newChar.solver.enableIK = this.assetEnableIK;
      newChar.solver.enableSwing = this.assetEnableSwing;
      newChar.root.position.set(0, 0, 0);
      this.actorGroup.add(newChar.root);
      if (this.storyPlayer) {
        this.storyPlayer.char = newChar;
        for (const entry of this.storyPlayer.actorEntries.values()) {
          if (entry.char === oldChar) entry.char = newChar;
        }
      }
      this.renderer?.renderLists.dispose();

      // Re-bind current asset clips against new character skeleton
      await Promise.all([
        this.setAssetBodyMotion(this.assetBodyMotionName),
        this.setAssetFacialMotion(this.assetFacialMotionName),
      ]);

      if (request !== this._characterRequest) return updatedCatalog;

      this.loading = false;
      this.loadingText = '';
      this._emit();
      this.renderFrame();
      return updatedCatalog;
    } catch (e) {
      if (request !== this._characterRequest) return null;
      console.error('Failed to load character parts:', e);
      this.loading = false;
      this.loadingText = `模型加载失败: ${e?.message || e}`;
      this._emit();
      return null;
    }
  }

  async setAssetBodyMotion(motionName) {
    if (!motionName) return;
    try {
      const env = await getBrowserEnv();
      const baseName = motionName.replace(/_[bf]$/, '');
      if (!env.hasBundle(motionName) && !env.hasBundle(baseName)) {
        await this.ensureBundlesOnServer([baseName]);
      }
      let clip = null;
      for (const cand of [`${baseName}_b`, motionName, baseName]) {
        try {
          clip = await getClip(cand);
          if (clip) break;
        } catch {
          /* try next */
        }
      }
      if (clip) {
        this.assetBodyMotionName = motionName;
        this.assetBodyClip = clip;
        this.assetDuration = Math.max(0.05, clip.duration || 4);
        this.assetTime = 0;
        this._resetPhysics(this.mode === 'asset' ? this.assetTime : this.storyTime);
        this._emit();
        this.renderFrame();
      }
    } catch (e) {
      console.warn('setAssetBodyMotion failed:', e);
    }
  }

  async setAssetFacialMotion(motionName) {
    if (!motionName) {
      this.assetFacialMotionName = '';
      this.assetFacialClip = null;
      this._emit();
      this.renderFrame();
      return;
    }
    try {
      const env = await getBrowserEnv();
      const baseName = motionName.replace(/_[bf]$/, '');
      if (!env.hasBundle(motionName) && !env.hasBundle(baseName)) {
        await this.ensureBundlesOnServer([baseName]);
      }
      let clip = null;
      for (const cand of [`${baseName}_f`, motionName, baseName]) {
        try {
          clip = await getClip(cand);
          if (clip) break;
        } catch {
          /* try next */
        }
      }
      if (clip) {
        this.assetFacialMotionName = motionName;
        this.assetFacialClip = clip;
        this._emit();
        this.renderFrame();
      }
    } catch (e) {
      console.warn('setAssetFacialMotion failed:', e);
    }
  }

  setAssetPlaying(v) {
    this.assetPlaying = !!v;
    this._emit();
  }

  setAssetLoop(v) {
    this.assetLoop = !!v;
    this._emit();
  }

  setAssetSpeed(s) {
    this.assetSpeed = Number(s) || 1;
    this._emit();
  }

  setAssetTime(t) {
    this.assetTime = Math.max(0, Math.min(this.assetDuration, Number(t) || 0));
    this._resetPhysics(this.assetTime);
    this.renderFrame();
    this._emit();
  }

  async setAssetScene(sceneName) {
    const request = ++this._sceneRequest;
    const normalized =
      !sceneName || sceneName === 'studio'
        ? 'studio'
        : sceneName === 'classroom'
          ? 'env_3d_adv_classroom-00-00-noon'
          : String(sceneName);
    this.assetSceneName = normalized;
    this.assetStageMode =
      normalized === 'studio'
        ? 'studio'
        : normalized === 'env_3d_adv_classroom-00-00-noon'
          ? 'classroom'
          : normalized;

    if (normalized === 'studio') {
      this.loading = false;
      this.loadingText = '';
      this._pruneSceneResources();
      this._syncAssetSceneLighting();
      this._emit();
      this.renderFrame();
      return null;
    }

    try {
      let updatedCatalog = null;
      if (normalized.startsWith('env_3d_')) {
        if (!this.env3dCache.has(normalized)) {
          this.loading = true;
          this.loadingText = `正在加载 3D 场景 (${normalized})…`;
          this._emit();
          await this._loadEnv3d(normalized);
          if (request !== this._sceneRequest) return updatedCatalog;
          this.loading = false;
          this.loadingText = '';
        }
      } else if (normalized.startsWith('env_2d_')) {
        if (!this.bgMeta[normalized]) {
          this.loading = true;
          this.loadingText = `正在加载 2D 场景 (${normalized})…`;
          this._emit();
          updatedCatalog = await this._loadBg2d(normalized);
          if (request !== this._sceneRequest) return updatedCatalog;
          this.loading = false;
          this.loadingText = '';
        }
      }
      this._syncAssetSceneLighting();
      this._emit();
      this.renderFrame();
      return updatedCatalog;
    } catch (e) {
      if (request !== this._sceneRequest) return null;
      console.error('Failed to load asset scene:', e);
      this.loading = false;
      this.loadingText = `场景加载失败: ${e?.message || e}`;
      this._emit();
      this.renderFrame();
      return null;
    } finally {
      this._pruneSceneResources();
      this.renderFrame();
    }
  }

  setAssetStageMode(mode) {
    return this.setAssetScene(mode);
  }

  setAssetPhysics({ enableIK, enableSwing }) {
    if (enableIK !== undefined) this.assetEnableIK = !!enableIK;
    if (enableSwing !== undefined) this.assetEnableSwing = !!enableSwing;
    if (this.char) {
      this.char.solver.enableIK = this.assetEnableIK;
      this.char.solver.enableSwing = this.assetEnableSwing;
      if (enableSwing !== undefined) this._resetPhysics(this.mode === 'asset' ? this.assetTime : this.storyTime);
    }
    this._emit();
    this.renderFrame();
  }

  setAnimationManageProperties(properties) {
    this.animationManageProperties = properties || null;
    if (this.storyPlayer) this.storyPlayer.animationManageProperties = this.animationManageProperties;
    this.renderFrame();
  }

  setUseBloom(v) {
    this.useBloom = !!v;
    this._emit();
    this.renderFrame();
  }

  setAssetManualMorph(idx, val) {
    if (val <= 0.001) this.assetManualMorphs.delete(idx);
    else this.assetManualMorphs.set(idx, Math.max(0, Math.min(1, val)));
    this.renderFrame();
  }

  clearAssetManualMorphs() {
    this.assetManualMorphs.clear();
    this.renderFrame();
  }

  setActorTransform(partial = {}, targetMode = this.mode) {
    const isStory = targetMode === 'story';
    const prev = isStory ? this.storyActorTransform : this.assetActorTransform;
    const next = { ...prev };
    if (partial.x !== undefined && Number.isFinite(Number(partial.x))) {
      next.x = Number(partial.x);
    }
    if (partial.y !== undefined && Number.isFinite(Number(partial.y))) {
      next.y = Number(partial.y);
    }
    if (partial.z !== undefined && Number.isFinite(Number(partial.z))) {
      next.z = Number(partial.z);
    }
    if (partial.rotY !== undefined && Number.isFinite(Number(partial.rotY))) {
      let d = ((Number(partial.rotY) + 180) % 360 + 360) % 360 - 180;
      if (d === -180 && Number(partial.rotY) > 0) d = 180;
      next.rotY = d;
    }
    if (isStory) {
      this.storyActorTransform = next;
    } else {
      this.assetActorTransform = next;
    }
    this._emit();
    this.renderFrame();
  }

  setAssetActorTransform(partial) {
    this.setActorTransform(partial, 'asset');
  }

  setStoryActorTransform(partial) {
    this.setActorTransform(partial, 'story');
  }

  resetActorTransform(targetMode = this.mode) {
    this.setActorTransform({ x: 0, y: 0, z: 0, rotY: 0 }, targetMode);
  }

  rotateActorBy(deltaDeg, targetMode = this.mode) {
    const cur = targetMode === 'story' ? this.storyActorTransform : this.assetActorTransform;
    this.setActorTransform({ rotY: (cur.rotY || 0) + (Number(deltaDeg) || 0) }, targetMode);
  }

  translateActorBy(dx = 0, dy = 0, dz = 0, local = false, targetMode = this.mode) {
    const cur = targetMode === 'story' ? this.storyActorTransform : this.assetActorTransform;
    let ox = Number(dx) || 0;
    const oy = Number(dy) || 0;
    let oz = Number(dz) || 0;
    if (local && (Math.abs(ox) > 1e-6 || Math.abs(oz) > 1e-6)) {
      const rad = THREE.MathUtils.degToRad(cur.rotY || 0);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rx = ox * cos + oz * sin;
      const rz = -ox * sin + oz * cos;
      ox = rx;
      oz = rz;
    }
    this.setActorTransform(
      {
        x: Number((cur.x + ox).toFixed(3)),
        y: Number((cur.y + oy).toFixed(3)),
        z: Number((cur.z + oz).toFixed(3)),
      },
      targetMode,
    );
  }

  moveActorCameraRelative(forwardStep = 0, rightStep = 0, upStep = 0, targetMode = this.mode) {
    if (!this.camera) {
      this.translateActorBy(rightStep, upStep, forwardStep, false, targetMode);
      return;
    }
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    else fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const dx = fwd.x * forwardStep + right.x * rightStep;
    const dz = fwd.z * forwardStep + right.z * rightStep;
    this.translateActorBy(dx, upStep, dz, false, targetMode);
  }

  faceActorToCamera() {
    if (!this.camera) return;
    const ax = this.actorGroup ? this.actorGroup.position.x : this.assetActorTransform.x;
    const az = this.actorGroup ? this.actorGroup.position.z : this.assetActorTransform.z;
    const dx = this.camera.position.x - ax;
    const dz = this.camera.position.z - az;
    if (Math.hypot(dx, dz) <= 1e-4) return;
    const worldYawDeg = THREE.MathUtils.radToDeg(Math.atan2(-dx, -dz));
    if (this.mode === 'story' && this.storyPlayer) {
      const st = this.storyPlayer.stateAt(this.storyTime);
      const rot = st?.layout?.rotation;
      let baseThreeYaw = 0;
      if (rot) {
        const baseQ = unityEulerQuat(rot.x || 0, rot.y || 0, rot.z || 0);
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(baseQ);
        baseThreeYaw = THREE.MathUtils.radToDeg(Math.atan2(-fwd.x, -fwd.z));
      }
      this.setActorTransform({ rotY: Math.round(worldYawDeg - baseThreeYaw) }, 'story');
    } else {
      this.setActorTransform({ rotY: Math.round(worldYawDeg) }, 'asset');
    }
  }

  placeActorAtCameraTarget() {
    if (!this.controls || !this.camera) return;
    const tx = Number(this.controls.target.x.toFixed(2));
    const tz = Number(this.controls.target.z.toFixed(2));
    const dx = this.camera.position.x - tx;
    const dz = this.camera.position.z - tz;
    const rotY =
      Math.hypot(dx, dz) > 1e-4
        ? Math.round(THREE.MathUtils.radToDeg(Math.atan2(-dx, -dz)))
        : this.assetActorTransform.rotY;
    this.setActorTransform({ x: tx, z: tz, rotY }, 'asset');
  }

  focusCameraOnActor() {
    if (!this.camera || !this.controls || !this.actorGroup) return;
    const targetPos = new THREE.Vector3(
      this.actorGroup.position.x,
      this.actorGroup.position.y + 1.08,
      this.actorGroup.position.z,
    );
    const delta = targetPos.clone().sub(this.controls.target);
    this.camera.position.add(delta);
    this.controls.target.copy(targetPos);
    this.controls.update();
    this.renderFrame();
  }

  setShowActorGizmo(v) {
    this.showActorGizmo = !!v;
    if (!this.showActorGizmo && this.renderer?.domElement) {
      this.renderer.domElement.style.cursor = '';
      this._gizmoHovered = null;
    }
    this._syncActorGizmoTransform();
    this._emit();
    this.renderFrame();
  }

  setAssetCameraPreset(preset) {
    if (!this.camera || !this.controls) return;
    let camOffset;
    let targetOffset;
    if (preset === 'face') {
      camOffset = new THREE.Vector3(0, 1.38, -0.58);
      targetOffset = new THREE.Vector3(0, 1.36, 0);
    } else if (preset === 'bust') {
      camOffset = new THREE.Vector3(0, 1.28, -1.05);
      targetOffset = new THREE.Vector3(0, 1.22, 0);
    } else if (preset === 'side') {
      camOffset = new THREE.Vector3(1.45, 1.12, -0.45);
      targetOffset = new THREE.Vector3(0, 1.02, 0);
    } else if (preset === 'back') {
      camOffset = new THREE.Vector3(0, 1.22, 1.75);
      targetOffset = new THREE.Vector3(0, 1.02, 0);
    } else {
      // full
      camOffset = new THREE.Vector3(0, 1.18, -1.85);
      targetOffset = new THREE.Vector3(0, 1.02, 0);
    }
    const { x, y, z, rotY } = this.assetActorTransform;
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(rotY || 0),
    );
    camOffset.applyQuaternion(q);
    targetOffset.applyQuaternion(q);
    this.camera.position.set(x + camOffset.x, y + camOffset.y, z + camOffset.z);
    this.controls.target.set(x + targetOffset.x, y + targetOffset.y, z + targetOffset.z);
    this.controls.update();
    this.renderFrame();
  }

  // -------------------- Tab 2: Story Browser Controls --------------------
  async loadStoryFromUrl(url, label = '', autoPlay = false) {
    this.storyScriptUrl = url;
    this.storyScriptLabel = label || url.split('/').pop() || 'script.txt';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${url}`);
    const text = await resp.text();
    await this.loadStoryFromText(text, this.storyScriptLabel, autoPlay);
  }

  _disposeExtraStoryActors() {
    for (const entry of this.extraStoryActors.values()) {
      if (entry.char) entry.char.dispose();
      if (entry.group && entry.group.parent) entry.group.parent.remove(entry.group);
      if (entry.groundShadow) {
        entry.groundShadow.removeFromParent();
        entry.groundShadow.geometry.dispose();
        entry.groundShadow.material.map?.dispose();
        entry.groundShadow.material.dispose();
      }
    }
    this.extraStoryActors.clear();
  }

  async loadStoryFromText(text, label = 'custom.txt', autoPlay = false) {
    // Story loads mutate shared actor groups; do not interleave their ownership.
    const pending = (this._storyLoad || Promise.resolve()).then(() =>
      this._loadStoryFromText(text, label, autoPlay));
    this._storyLoad = pending;
    try {
      return await pending;
    } finally {
      if (this._storyLoad === pending) this._storyLoad = null;
    }
  }

  async _loadStoryFromText(text, label, autoPlay) {
    try {
      this.loading = true;
      this.loadingText = `正在解析剧情脚本 ${label}…`;
      this._emit();

      const env = await getBrowserEnv();
      const events = parseAdv(text);
      const timeline = buildTimeline(events);
      this.storyPlaying = false;
      this.storyPlayer = null;
      this.storyTimeline = timeline;
      this.voiceCtrl.clear();
      this._disposeExtraStoryActors();
      this._pruneSceneResources(timeline);

      // Collect all required bundles and voice .acb resources from the script
      const neededBundles = new Set([STAND_MOTION]);
      for (const [, parts] of timeline.actors) {
        if (parts.body) neededBundles.add(parts.body);
        if (parts.face) {
          neededBundles.add(parts.face);
          const m = /^mdl_chr_([a-z0-9]+)-/i.exec(parts.face);
          if (m) neededBundles.add(`t_chr_${m[1]}-base-0000`);
        }
        if (parts.hair) neededBundles.add(parts.hair);
      }
      for (const bg of timeline.backgrounds.values()) {
        if (bg && bg.src) {
          neededBundles.add(bg.src);
          if (bg.src.startsWith('env_3d')) neededBundles.add('t_sky_noon-00');
        }
      }
      for (const c of timeline.cues) {
        if (
          c.type === 'actormotion' ||
          c.type === 'actorfacialmotion' ||
          c.type === 'actoradditivemotion'
        ) {
          const m = c.params.motion;
          if (m) {
            const stem = m.replace(/_[bf]$/, '');
            neededBundles.add(stem);
            neededBundles.add(m);
          }
        }
      }

      const voiceCueNames = [
        ...new Set(
          timeline.cues
            .filter((c) => c.type === 'voice' && c.params.voice)
            .map((c) => c.params.voice),
        ),
      ];
      const neededResources = new Set();
      for (const cueName of voiceCueNames) {
        const sheet = String(cueName).replace(/_[a-z0-9]+-\d+$/, '');
        if (sheet) neededResources.add(`${sheet}.acb`);
      }

      await this.ensureAssetsOnServer([...neededBundles], [...neededResources]).catch((e) =>
        console.warn('auto-ensure warning:', e),
      );

      // Extract primary actor ID from script's [actorgroup] if present
      let scriptActorId = DEFAULT_ACTOR_ID;
      if (timeline.actors.size > 0) {
        scriptActorId = timeline.actors.has(DEFAULT_ACTOR_ID)
          ? DEFAULT_ACTOR_ID
          : [...timeline.actors.keys()][0];
      }

      // Load primary character if not yet loaded or if its parts differ from currentParts
      const primaryParts = timeline.actors.get(scriptActorId);
      const wantParts =
        primaryParts && primaryParts.body && primaryParts.face && primaryParts.hair
          ? primaryParts
          : this.currentParts;
      if (
        !this.char ||
        wantParts.body !== this.currentParts.body ||
        wantParts.face !== this.currentParts.face ||
        wantParts.hair !== this.currentParts.hair
      ) {
        this.loadingText = `正在加载角色模型 (${scriptActorId})…`;
        this._emit();
        const newChar = await loadCharacter(null, wantParts);
        if (this.char) this.char.dispose();
        this.char = newChar;
        this.currentParts = { ...wantParts };
        setClipCharMeta(newChar.meta);
        if (this.envInfo?.meta?.volumes) {
          newChar.applyActorVolume(this.envInfo.meta.volumes);
        }
        newChar.root.position.set(0, 0, 0);
        this.actorGroup.add(newChar.root);
      }

      // Load any additional actors in multi-character scripts
      const actorEntries = new Map([
        [
          scriptActorId,
          {
            actorId: scriptActorId,
            char: this.char,
            group: this.actorGroup,
            groundShadow: this.groundShadow,
          },
        ],
      ]);
      for (const [aid, parts] of timeline.actors) {
        if (aid === scriptActorId || !parts.body || !parts.face || !parts.hair) continue;
        try {
          this.loadingText = `正在加载同场角色模型 (${aid})…`;
          this._emit();
          const extraChar = await loadCharacter(null, parts);
          if (this.envInfo?.meta?.volumes) {
            extraChar.applyActorVolume(this.envInfo.meta.volumes);
          }
          const extraGroup = new THREE.Group();
          extraGroup.visible = false;
          extraChar.root.position.set(0, 0, 0);
          extraGroup.add(extraChar.root);
          this.scene.add(extraGroup);
          const extraShadow = this._createGroundShadow();
          extraShadow.visible = false;
          this.scene.add(extraShadow);
          const entry = {
            actorId: aid,
            parts: { ...parts },
            char: extraChar,
            group: extraGroup,
            groundShadow: extraShadow,
          };
          this.extraStoryActors.set(aid, entry);
          actorEntries.set(aid, entry);
        } catch (e) {
          console.warn(`extra actor load failed (${aid}):`, e);
        }
      }

      const player = new StoryPlayer(
        timeline,
        this.char,
        scriptActorId,
        this.lipsyncDb,
        this.voiceCtrl,
        this.actorGroup,
        actorEntries,
      );
      player.hasVoices = voiceCueNames.length > 0;

      // Load 3D stages and 2D backgrounds referenced by timeline
      const bgLoads = [];
      for (const bg of timeline.backgrounds.values()) {
        const src = bg && bg.src;
        if (!src) continue;
        if (src.startsWith('env_3d')) {
          if (!this.env3dCache.has(src)) {
            bgLoads.push(
              this._loadEnv3d(src).catch((e) => console.warn(`3d stage load failed ${src}`, e)),
            );
          }
          continue;
        }
        if (this.bgMeta[src]) continue;
        bgLoads.push(
          this._loadBg2d(src).catch((e) => console.warn(`bg load failed ${src}`, e)),
        );
      }
      await Promise.all(bgLoads);

      const pre = await player.preload();
      await this.voiceCtrl.preloadCues(voiceCueNames);

      // Build interactive dialogue cue list for the Story Browser sidebar
      const dialogues = [];
      for (let i = 0; i < timeline.cues.length; i++) {
        const c = timeline.cues[i];
        if (c.type === 'message' || (c.type === 'narration' && !c.params.hide)) {
          const speaker =
            c.type === 'narration'
              ? '旁白'
              : c.params.name === '{user}'
                ? USER_NAME
                : c.params.name || '';
          const cleanText = stripRuby(c.params.text || '');
          let voiceCue = null;
          for (const vc of timeline.cues) {
            if (vc.type === 'voice' && vc.params.voice && Math.abs(vc.t - c.t) <= 0.65) {
              voiceCue = vc.params.voice;
              break;
            }
          }
          dialogues.push({
            index: dialogues.length,
            t: c.t,
            dur: c.dur || 2.5,
            speaker,
            text: cleanText,
            narration: c.type === 'narration',
            hide: !!c.params.hide,
            voice: voiceCue,
          });
        }
      }

      this._lastVolumeSrc = null;
      this.storyTimeline = timeline;
      this.storyPlayer = player;
      this.storyScriptLabel = label;
      this.storyDuration = timeline.duration;
      this.storyTime = 0;
      this.storyPlaying = !!autoPlay;
      this._resetPhysics(this.mode === 'story' ? this.storyTime : this.assetTime);
      this.storyDialogueList = dialogues;
      this.storyStatus =
        `${events.length} cues · ${timeline.duration.toFixed(1)}s · clips ${pre.total - pre.missing.length}/${pre.total}` +
        (pre.missing.length ? ` (missing: ${pre.missing.length})` : '');

      this.loading = false;
      this.loadingText = '';
      this._emit();
      this.renderFrame();
    } catch (e) {
      console.error('loadStoryFromText failed:', e);
      this.loading = false;
      this.loadingText = `脚本加载失败: ${e?.message || e}`;
      this._emit();
    } finally {
      this._pruneSceneResources();
      this.renderFrame();
    }
  }

  setStoryPlaying(v) {
    this.storyPlaying = !!v;
    if (this.storyPlaying) this.voiceCtrl.unlock();
    else {
      this.voiceCtrl.manualCue = null;
      this.voiceCtrl.audio.pause();
    }
    this._emit();
    this.renderFrame();
  }

  setStorySpeed(s) {
    this.storySpeed = Number(s) || 1;
    this._emit();
  }

  seekStory(t, keepPlaying = false) {
    this.storyTime = Math.max(0, Math.min(this.storyDuration || 0, Number(t) || 0));
    if (!keepPlaying) {
      this.storyPlaying = false;
      this.voiceCtrl.audio.pause();
    }
    this.voiceCtrl.manualCue = null;
    this._resetPhysics(this.storyTime);
    this.renderFrame();
    this._emit();
  }

  nextStoryMessage() {
    if (!this.storyTimeline) return;
    const next = this.storyTimeline.cues.find(
      (c) => (c.type === 'message' || c.type === 'narration') && c.t > this.storyTime + 0.05,
    );
    if (next) {
      this.storyTime = next.t + 0.01;
      this._resetPhysics(this.storyTime);
      if (this.storyPlaying) this.voiceCtrl.unlock();
      this.renderFrame();
      this._emit();
    }
  }

  replayCurrentVoice() {
    if (!this.storyPlayer) return;
    const st = this.storyPlayer.stateAt(this.storyTime);
    const m = st?.message;
    const lv = st?.lineVoice;
    const vObj = m && lv && !m.narration && Math.abs(lv.start - m.start) <= 0.6 ? lv : null;
    if (!vObj) return;
    if (this.storyPlaying) {
      this.storyTime = vObj.start;
      this._resetPhysics(this.storyTime);
      this.voiceCtrl.currentCue = null;
      this.voiceCtrl.unlock();
      this.renderFrame();
    } else {
      this.voiceCtrl.replayLine(vObj);
    }
    this._emit();
  }

  setStoryCameraLocked(locked) {
    this.storyCameraLocked = !!locked;
    if (this.mode === 'story' && this.controls) {
      this.controls.enabled = this.storyCameraLocked;
      if (this.storyCameraLocked) {
        this.controls.target.set(
          this.actorGroup.position.x,
          this.actorGroup.position.y + 1.25,
          this.actorGroup.position.z,
        );
        this.controls.update();
      }
    }
    this._emit();
  }

  // -------------------- Frame Loop & Rendering --------------------
  _tick(now) {
    const rawDt = Math.min(0.1, Math.max(0, (now - this._lastFrameNow) / 1000));
    this._lastFrameNow = now;
    if (!this.char) return;

    if (this.mode === 'asset') {
      if (this.assetPlaying && this.assetDuration > 0) {
        this.assetTime += rawDt * this.assetSpeed;
        if (this.assetTime >= this.assetDuration) {
          this.assetTime = this.assetLoop ? this.assetTime % this.assetDuration : this.assetDuration;
          // Hold the final pose while physics continues; only an explicit
          // pause freezes the transport, including hair/cloth settling.
        }
      }
      this.renderFrame(this.assetPlaying ? rawDt : 0);
      if (now - this._lastEmitTs > 80) {
        this._lastEmitTs = now;
        this._emit();
      }
    } else {
      if (this.storyPlaying && this.storyDuration > 0) {
        this.storyTime += rawDt * this.storySpeed;
        if (this.storyTime > this.storyDuration) {
          this.storyTime = 0;
        }
      }
      this.renderFrame(this.storyPlaying ? rawDt : 0);
      if (now - this._lastEmitTs > 65) {
        this._lastEmitTs = now;
        this._emit();
      }
    }
  }

  // delta is elapsed simulation time; transport sampling is controlled by the
  // caller. No delta means a redraw/seek snapshot, not another physics frame.
  renderFrame(physicsDelta = 0) {
    if (!this.renderer || !this.scene || !this.camera || !this.char) return;
    this.physicsTime += physicsDelta;
    if (this.mode === 'asset') {
      this._renderAssetFrame();
    } else {
      this._renderStoryFrame();
    }
  }

  _renderAssetFrame() {
    for (const entry of this.extraStoryActors.values()) {
      if (entry.group) entry.group.visible = false;
      if (entry.groundShadow) entry.groundShadow.visible = false;
    }
    const sceneName = this.assetSceneName || 'studio';
    const is3d = sceneName.startsWith('env_3d_') && this.env3dCache.has(sceneName);
    const is2d = sceneName.startsWith('env_2d_') && Boolean(this.bgMeta[sceneName]);
    let manageVolume = null;
    if (is3d) {
      this._activateEnv3d(sceneName);
      manageVolume = this.envInfo?.meta?.volumes?.animationManage || null;
      this.envGroup.visible = true;
      this.scene.background = this.skyTexture || new THREE.Color(0x111520);
      if (this.bgEl) this.bgEl.style.display = 'none';
      if (this.bloom) {
        this.bloom.setBg2D({ active: false });
        this.bloom.setDof(null, 35, true);
      }
    } else if (is2d) {
      manageVolume = this.bgMeta[sceneName]?.volumes?.animationManage || null;
      this.envGroup.visible = false;
      this.scene.background = null;
      if (this.bloom) this.bloom.setDof(null, 35, false);
      this._applyBg2dLayer(sceneName, {});
    } else {
      this.envGroup.visible = false;
      this.scene.background = new THREE.Color(0x111520);
      if (this.bgEl) this.bgEl.style.display = 'none';
      if (this.bloom) {
        this.bloom.setBg2D({ active: false });
        this.bloom.setDof(null, 35, false);
      }
    }

    if (this.controls && this.controls.enabled) {
      this.controls.update();
    }

    const { x, y, z, rotY } = this.assetActorTransform;
    this.actorGroup.visible = true;
    this.actorGroup.position.set(x, y, z);
    this.actorGroup.rotation.set(0, THREE.MathUtils.degToRad(rotY), 0);
    this.actorGroup.scale.set(1, 1, 1);
    this.actorGroup.updateMatrixWorld(true);
    if (this.assetBodyClip) {
      const ev = evalClip(this.assetBodyClip, this.assetTime);
      applyAnimationManage(this.char.solver.swing, this.animationManageProperties, ev.manage, manageVolume);
      this.char.solver.applyPose(
        null,
        this.char.solver.poseFrom(ev.muscles, ev.bones, ev.root),
        1,
      );
    } else {
      applyAnimationManage(this.char.solver.swing, this.animationManageProperties, null, manageVolume);
      this.char.reset();
    }

    const morph = new Map();
    if (this.assetFacialClip) {
      const lt =
        this.assetFacialClip.duration > 0
          ? Math.min(this.assetFacialClip.duration, this.assetTime)
          : 0;
      const fev = evalClip(this.assetFacialClip, lt);
      for (const [k, v] of fev.morph) morph.set(k, v);
    }
    for (const [k, v] of this.assetManualMorphs) {
      morph.set(k, v);
    }
    this.char.setMorph(morph);

    this.char.solver.updatePostRig(this.physicsTime);
    this.char.update(this.camera);
    this.char.renderShadow(this.renderer);

    this.groundShadow.visible = !is2d;
    const hips = this.char.solver.nameToNode.Hips;
    const hp = hips ? hips.getWorldPosition(new THREE.Vector3()) : this.actorGroup.position;
    this.groundShadow.position.set(hp.x, this.actorGroup.position.y + 0.004, hp.z);
    this._syncActorGizmoTransform();
    if (this.bloom && this.useBloom) this.bloom.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  _renderStoryFrame() {
    if (!this.storyPlayer || !this.storyTimeline) return;
    const t = this.storyTime;
    const st = this.storyPlayer.stateAt(t);

    if (st.camera && !this.storyCameraLocked) {
      applyCameraSetting(this.camera, st.camera);
    } else if (this.storyCameraLocked && this.controls) {
      this.controls.update();
    }

    const sk = this._shakeAt(st, t);
    if (sk && !this.storyCameraLocked) {
      this.camera.rotateY(sk.yaw);
      this.camera.rotateX(sk.pitch);
    }

    this._applyStoryBackground(t, st);
    this._updateStoryOverlayState(t, st);
    this.voiceCtrl.sync(t, st, this.storyPlaying, this.storySpeed, () => this.storyTime);

    this.storyPlayer.animationManageProperties = this.animationManageProperties;
    this.storyPlayer.animationManageVolume = this._activeAnimationManageVolume;
    this.storyPlayer.actorTransformOffset = this.storyActorTransform;
    this.storyPlayer.applyCharacter(t, st);
    for (const [aid, entry] of this.storyPlayer.actorEntries) {
      const aSt = st.actors ? st.actors.get(aid) : st;
      if (!entry.char || !entry.group) continue;
      if (aSt && aSt.visible) {
        this._applyLookTargetForActor(entry, aSt, t);
        entry.char.solver.updatePostRig(this.physicsTime);
        entry.char.update(this.camera);
        entry.char.renderShadow(this.renderer);
      }
      if (entry.groundShadow) {
        entry.groundShadow.visible = entry.group.visible && this.envGroup.visible;
        if (entry.groundShadow.visible) {
          const hips = entry.char.solver.nameToNode.Hips;
          const hp = hips ? hips.getWorldPosition(new THREE.Vector3()) : entry.group.position;
          entry.groundShadow.position.set(hp.x, entry.group.position.y + 0.004, hp.z);
        }
      }
    }
    this._syncActorGizmoTransform();

    if (this.bloom && this.useBloom) this.bloom.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  _shakeAt(st, t) {
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

  _resolveLookTargetPos(out, target, groupScaleY = 1) {
    const D2R = Math.PI / 180;
    const tp = target || DEFAULT_LOOK_TARGET;
    if (tp.type === 1) {
      this.camera.getWorldPosition(out);
      return out;
    }
    const az = (tp.azimuth ?? 0) * D2R;
    const el = (tp.elevation ?? 0) * D2R;
    const ce = Math.cos(el);
    out
      .set(Math.sin(az) * ce, -Math.sin(el), -Math.cos(az) * ce)
      .applyQuaternion(this._lookActQuatW)
      .multiplyScalar(10)
      .add(this._lookActPosW);
    out.y += 1.38 * groupScaleY;
    return out;
  }

  _evalLookState(st, t, groupScaleY = 1) {
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
        posW: this._resolveLookTargetPos(this._lookTargetA, tgt, groupScaleY),
        headW: w * (tgt.headWeight ?? 0.6),
        bodyW: w * (tgt.bodyWeight ?? 0.1),
        eyesW: w * (tgt.eyesWeight ?? 0.3),
      };
    }
    const from = activeCue.from || DEFAULT_LOOK_TARGET;
    const to = activeCue.to || DEFAULT_LOOK_TARGET;
    const u =
      activeCue.dur > 0 ? Math.min(1, Math.max(0, (t - activeCue.start) / activeCue.dur)) : 1;
    const w0 = Math.max(0, Math.min(1, from.weight ?? 0));
    const w1 = Math.max(0, Math.min(1, to.weight ?? 0));
    if (Math.abs(w0 - w1) > 1e-4) {
      const w = w0 + (w1 - w0) * u;
      if (w <= 1e-4) return null;
      const dom = w0 < w1 ? to : from;
      const inCirc = 1 - Math.sqrt(Math.max(0, 1 - w * w));
      return {
        posW: this._resolveLookTargetPos(this._lookTargetA, dom, groupScaleY),
        headW: w * (dom.headWeight ?? 0.6),
        bodyW: inCirc * (dom.bodyWeight ?? 0.1),
        eyesW: w * (dom.eyesWeight ?? 0.3),
      };
    }
    if (w1 <= 1e-4) return null;
    this._resolveLookTargetPos(this._lookTargetA, from, groupScaleY);
    this._resolveLookTargetPos(this._lookTargetB, to, groupScaleY);
    this._lookTargetA.lerp(this._lookTargetB, u);
    return {
      posW: this._lookTargetA,
      headW: w1 * (to.headWeight ?? 0.6),
      bodyW: w1 * (to.bodyWeight ?? 0.1),
      eyesW: w1 * (to.eyesWeight ?? 0.3),
    };
  }

  _aimBoneAtTarget(solver, bname, targetPosW, weight, maxYawDeg, maxPitchDeg) {
    if (weight <= 1e-4) return;
    const bone = solver.nameToNode[bname];
    if (!bone || !bone.parent) return;
    const D2R = Math.PI / 180;
    bone.updateWorldMatrix(true, false);
    bone.getWorldPosition(this._lookBonePosW);
    bone.getWorldQuaternion(this._lookBoneQuatW);

    this._lookDesLocal.copy(targetPosW).sub(this._lookBonePosW).applyQuaternion(this._lookActQuatInv);
    if (this._lookDesLocal.lengthSq() < 1e-8) return;
    this._lookDesLocal.normalize();

    const bindQ = solver.bindQuat3[bname];
    this._lookDeltaQuat.copy(this._lookActQuatInv).multiply(this._lookBoneQuatW);
    if (bindQ) this._lookDeltaQuat.multiply(this._lookParentQuatW.copy(bindQ).invert());
    this._lookCurLocal.set(0, 0, -1).applyQuaternion(this._lookDeltaQuat).normalize();

    const desYaw = Math.atan2(-this._lookDesLocal.x, -this._lookDesLocal.z);
    const curYaw = Math.atan2(-this._lookCurLocal.x, -this._lookCurLocal.z);
    let dYaw = desYaw - curYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;

    const desPitch = Math.asin(Math.max(-1, Math.min(1, this._lookDesLocal.y)));
    const curPitch = Math.asin(Math.max(-1, Math.min(1, this._lookCurLocal.y)));
    const maxYaw = maxYawDeg * D2R;
    const maxPitch = maxPitchDeg * D2R;
    const yaw = Math.max(-maxYaw, Math.min(maxYaw, dYaw)) * weight;
    const pitch = Math.max(-maxPitch, Math.min(maxPitch, desPitch - curPitch)) * weight;

    this._lookEuler.set(pitch, yaw, 0, 'YXZ');
    this._lookRotActor.setFromEuler(this._lookEuler);
    this._lookRotWorld
      .copy(this._lookActQuatW)
      .multiply(this._lookRotActor)
      .multiply(this._lookActQuatInv);

    bone.parent.getWorldQuaternion(this._lookParentQuatW);
    this._lookDeltaQuat
      .copy(this._lookParentQuatW)
      .invert()
      .multiply(this._lookRotWorld)
      .multiply(this._lookParentQuatW);
    bone.quaternion.premultiply(this._lookDeltaQuat);
    bone.updateMatrixWorld(true);
  }

  _applyLookTargetForActor(entry, aSt, t) {
    if (!entry || !entry.char || !entry.group || !aSt.visible) return;
    const { solver } = entry.char;
    if (!solver.nameToNode.Head) return;

    entry.group.updateMatrixWorld(true);
    entry.group.getWorldPosition(this._lookActPosW);
    entry.group.getWorldQuaternion(this._lookActQuatW);
    this._lookActQuatInv.copy(this._lookActQuatW).invert();

    const lk = this._evalLookState(aSt, t, entry.group.scale.y);
    if (!lk) return;

    const chestName = solver.nameToNode.Chest
      ? 'Chest'
      : solver.nameToNode.Spine2
        ? 'Spine2'
        : 'Spine1';
    this._aimBoneAtTarget(solver, chestName, lk.posW, lk.bodyW, 30, 20);
    this._aimBoneAtTarget(solver, 'Head', lk.posW, lk.headW, 50, 35);
    this._aimBoneAtTarget(solver, 'LeftEye', lk.posW, lk.eyesW, 8, 5);
    this._aimBoneAtTarget(solver, 'RightEye', lk.posW, lk.eyesW, 8, 5);
  }

  _applyLookTarget(st, t) {
    this._applyLookTargetForActor(
      { char: this.char, group: this.actorGroup },
      { visible: st.actorVisible, looks: st.looks },
      t,
    );
  }

  _applyVolumeToAllStoryChars(vol) {
    if (!vol) return;
    if (this.char) this.char.applyActorVolume(vol);
    for (const entry of this.extraStoryActors.values()) {
      if (entry.char) entry.char.applyActorVolume(vol);
    }
  }

  _applyStoryBackground(t, st) {
    const src = st.bgActive ? (this.storyTimeline.backgrounds.get(st.bgActive) || {}).src : null;
    const is3d = !!src && src.startsWith('env_3d');
    const activeDof = st.dof || (st.camera && st.camera.dofSetting) || null;
    const camFocalMm = (st.camera && st.camera.focalLength) || 30;
    if (this.bloom) this.bloom.setDof(activeDof, camFocalMm, is3d);

    if (is3d) {
      this._activateEnv3d(src);
    }
    this._activeAnimationManageVolume = is3d
      ? this.envInfo?.meta?.volumes?.animationManage : this.bgMeta[src]?.volumes?.animationManage;
    this.envGroup.visible = is3d;
    this.scene.background = is3d && this.skyTexture ? this.skyTexture : null;
    if (src && src !== this._lastVolumeSrc) {
      this._lastVolumeSrc = src;
      if (is3d && this.envInfo?.meta?.volumes) {
        this._applyVolumeToAllStoryChars(this.envInfo.meta.volumes);
      } else if (!is3d && this.bgMeta[src]?.volumes) {
        this._applyVolumeToAllStoryChars(this.bgMeta[src].volumes);
      }
    }
    if (is3d || !src) {
      if (this.bgEl) {
        this.bgEl.style.display = 'none';
        this.bgEl.style.filter = 'none';
        this.bgEl.style.transform = 'none';
      }
      if (this.bloom) this.bloom.setBg2D({ active: false });
      return;
    }

    const setting = st.bgSet.get(st.bgActive) || {};
    this._applyBg2dLayer(src, setting);
  }

  _applyBg2dLayer(src, setting = {}) {
    const meta = this.bgMeta[src] || {};
    const W = this.viewportWidth;
    const H = this.viewportHeight;
    const pos = setting.position || { x: 0, y: 0 };
    const scale = setting.scale || { x: 1, y: 1 };
    const angle = setting.angle || 0;
    const k = H / 1920;
    const fit =
      (W <= H ? meta.verticalSetting : meta.horizontalSetting) || meta.verticalSetting;

    const webglTex = this.bgTextures.get(src) || null;
    if (this.bloom && this.useBloom && webglTex) {
      if (this.bgEl) this.bgEl.style.display = 'none';
      if (fit && fit.baseSize && fit.clippingRect) {
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
        const ca = Math.cos(rad);
        const sa = Math.sin(rad);
        const ax = W / sx;
        const ay = H / sy;
        const bx = (-0.5 * W - tx) / sx;
        const by = (-0.5 * H - ty) / sy;
        this._bgUvMat.set(
          (ca * ax) / imgW,
          (-sa * ay) / imgW,
          (ca * bx - sa * by + cx) / imgW,
          (sa * ax) / imgH,
          (ca * ay) / imgH,
          (sa * bx + ca * by + cy) / imgH,
          0,
          0,
          1,
        );
      } else {
        this._bgUvMat.identity();
      }
      this.bloom.setBg2D({ active: true, texture: webglTex, uvMatrix: this._bgUvMat, srcId: src });
      return;
    }
    if (this.bloom) this.bloom.setBg2D({ active: false });
    if (this.bgEl) {
      this.bgEl.style.display = 'block';
      for (const [k, img] of this.bgImages) {
        img.style.display = k === src ? 'block' : 'none';
      }
    }
  }

  _updateStoryOverlayState(t, st) {
    const m = st.message;
    if (!m) {
      this.storyActiveMessage = null;
    } else {
      const name = m.name === '{user}' ? USER_NAME : m.name || '';
      const clean = stripRuby(m.text);
      const shown = Math.max(0, Math.floor((t - m.start) * CHARS_PER_SEC));
      const lv = st.lineVoice;
      const hasVoice = !!(lv && !m.narration && Math.abs(lv.start - m.start) <= 0.6);
      this.storyActiveMessage = {
        speaker: name,
        fullText: clean,
        shownText: clean.slice(0, shown),
        narration: !!m.narration,
        hasVoice,
        start: m.start,
      };
    }

    const f = st.fade;
    const w = f.dur > 0 ? Math.min(1, Math.max(0, (t - f.t) / f.dur)) : 1;
    const fadeA = lerp(f.from, f.to, w);
    let flash = 0;
    for (const tr of st.transitions) {
      if (t < tr.start) break;
      const u = Math.min(1, Math.max(0, (t - tr.start) / tr.dur));
      flash = tr.type === 'In' ? u : 1 - u;
    }
    if (flash > fadeA) {
      this.storyFade = { color: '#ffffff', opacity: flash };
    } else {
      this.storyFade = { color: f.color || '#000000', opacity: fadeA };
    }
  }

  compositeStoryFrameToCanvas(targetCanvas, includeUi = true) {
    const ctx = targetCanvas.getContext('2d');
    if (!ctx || !this.renderer) return;
    const W = targetCanvas.width;
    const H = targetCanvas.height;

    ctx.fillStyle = '#090c12';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(this.renderer.domElement, 0, 0, W, H);

    const fade = this.storyFade;
    if (fade && fade.opacity > 0.001) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, fade.opacity));
      ctx.fillStyle = fade.color || '#000000';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    const msg = this.storyActiveMessage;
    if (!includeUi || !msg) return;

    const s = H / 720;
    const bx = Math.round(W * 0.06);
    const bw = Math.round(W * 0.88);
    const bh = Math.round(136 * s);
    const by = Math.round(H - bh - 30 * s);
    const br = Math.round(16 * s);
    const fontStack =
      '"Droid Sans Japanese", "Droid Sans Fallback", "Noto Sans CJK JP", "Hiragino Sans", sans-serif';

    ctx.save();
    // Window background & shadow
    ctx.shadowColor = 'rgba(25, 16, 22, 0.28)';
    ctx.shadowBlur = 24 * s;
    ctx.shadowOffsetY = 8 * s;
    const winGrad = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
    winGrad.addColorStop(0, 'rgba(255, 254, 252, 0.955)');
    winGrad.addColorStop(0.45, 'rgba(255, 246, 240, 0.945)');
    winGrad.addColorStop(1, 'rgba(255, 228, 212, 0.935)');
    ctx.fillStyle = winGrad;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, br);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.stroke();

    // Speaker pill badge
    if (!msg.narration && msg.speaker) {
      const spkFontPx = Math.max(11, Math.round(14 * s));
      ctx.font = `700 ${spkFontPx}px ${fontStack}`;
      const textW = ctx.measureText(msg.speaker).width;
      const padX = Math.round(18 * s);
      const pillW = Math.ceil(textW + padX * 2);
      const pillH = Math.round(27 * s);
      const pillX = bx + Math.round(28 * s);
      const pillY = by - Math.round(13 * s);

      const isProducer = msg.speaker === USER_NAME;
      const pillGrad = ctx.createLinearGradient(pillX, pillY, pillX + pillW, pillY);
      if (isProducer) {
        pillGrad.addColorStop(0, '#3b88e8');
        pillGrad.addColorStop(1, '#5ca0f2');
      } else {
        pillGrad.addColorStop(0, '#b858be');
        pillGrad.addColorStop(1, '#d46ad0');
      }
      ctx.fillStyle = pillGrad;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(msg.speaker, pillX + padX, pillY + pillH / 2 + 0.5 * s);
    }

    // Dialogue body text with wrapping
    const bodyFontPx = Math.max(12, Math.round(18 * s));
    const lineHeight = Math.round(bodyFontPx * 1.58);
    ctx.font = `600 ${bodyFontPx}px ${fontStack}`;
    ctx.fillStyle = '#36281e';
    ctx.textBaseline = 'top';
    const textX = bx + Math.round(32 * s);
    let textY = by + Math.round(24 * s);
    const maxTextW = bw - Math.round(64 * s);
    const rawLines = String(msg.shownText || '').split(/\r?\n/);
    for (const rawLine of rawLines) {
      let cur = '';
      for (const ch of rawLine) {
        const test = cur + ch;
        if (cur && ctx.measureText(test).width > maxTextW) {
          ctx.fillText(cur, textX, textY);
          textY += lineHeight;
          cur = ch;
        } else {
          cur = test;
        }
      }
      ctx.fillText(cur, textX, textY);
      textY += lineHeight;
    }

    // Next indicator triangle
    const bob = Math.sin((this.storyTime || 0) * 3.5) * 2 * s;
    const tx = bx + bw - Math.round(26 * s);
    const ty = by + bh - Math.round(18 * s) + bob;
    ctx.fillStyle = '#c864b8';
    ctx.beginPath();
    ctx.moveTo(tx - 6 * s, ty - 4 * s);
    ctx.lineTo(tx + 6 * s, ty - 4 * s);
    ctx.lineTo(tx, ty + 4 * s);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  _setupWindowHooks() {
    const self = this;
    window.story = {
      get timeline() {
        return self.storyTimeline;
      },
      get player() {
        return self.storyPlayer;
      },
      camera: this.camera,
      scene: this.scene,
      get char() {
        return self.char;
      },
      THREE,
      voice: this.voiceCtrl,
      apply(t) {
        self.seekStory(t, false);
      },
      get time() {
        return self.storyTime;
      },
      seek(t) {
        self.seekStory(t, false);
      },
      play() {
        self.setStoryPlaying(true);
      },
      pause() {
        self.setStoryPlaying(false);
      },
      lockCamera(v) {
        self.setStoryCameraLocked(v);
      },
      render() {
        self.renderFrame();
      },
      renderer: this.renderer,
      lights: { sunLight: this.sunLight, stageHemi: this.stageHemi },
      env: this.envGroup,
      actorGroup: this.actorGroup,
      shadow: this.groundShadow,
    };

    window.viewer = {
      THREE,
      get char() {
        return self.char;
      },
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      controls: this.controls,
      setClip: async (name, t = 0) => {
        await self.setAssetBodyMotion(name);
        self.setAssetTime(t);
      },
    };
    window.viewerEngine = this;
  }
}

export const viewerEngine = new ViewerEngine();
