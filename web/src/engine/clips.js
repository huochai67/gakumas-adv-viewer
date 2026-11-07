// Animation clip sampling shared by the debug viewer and the story player.
//
// Clips are decoded on demand from the raw AnimationClip assets inside the
// game's .bundle packages (one track per AnimationCurve binding, sampled at
// 30 Hz):
//   muscle - humanoid muscle (index = Unity HumanTrait order, 0..94)
//   bone   - Transform TRS curve keyed by glTF node index
//   blend  - VLActorFaceModel blendShapeWeights slot (morph target index)
//   custom - face-model custom channel (unused)

import { getBrowserEnv } from '../runtime/bundle_env.js';
import { buildCharFromBundles, loadClipFromBundle } from '../runtime/bundle_loaders.js';

export const MUSCLE_COUNT = 95;

const cache = new Map();
const MAX_CACHED_CLIPS = 64;
let charMetaRevision = 0;

// Character metadata (glTF node indices per bone, morph target mapping) that
// clip tracks are resolved against. Provided by loadCharacter() via
// setClipCharMeta(); rebuilt from the bundles when a clip is requested first.
let charMeta = null;
let charMetaPromise = null;

export function setClipCharMeta(meta) {
  meta = meta || null;
  if (charMeta === meta && !charMetaPromise) return;
  cache.clear();
  charMetaRevision++;
  charMeta = meta;
  charMetaPromise = null;
}

async function ensureCharMeta(env) {
  while (!charMeta) {
    const revision = charMetaRevision;
    if (!charMetaPromise) {
      charMetaPromise = buildCharFromBundles(env).then(({ meta, textures }) => {
        textures.clear();
        return meta;
      });
    }
    const pending = charMetaPromise;
    try {
      const meta = await pending;
      if (revision === charMetaRevision) charMeta = meta;
    } catch (error) {
      if (revision === charMetaRevision) throw error;
    } finally {
      if (charMetaPromise === pending) charMetaPromise = null;
    }
  }
  return charMeta;
}

export async function getClip(name) {
  for (;;) {
    if (cache.has(name)) {
      const clip = cache.get(name);
      cache.delete(name);
      cache.set(name, clip);
      return clip;
    }
    const env = await getBrowserEnv();
    const meta = await ensureCharMeta(env);
    const revision = charMetaRevision;
    // A character replacement may run between ensureCharMeta and this continuation.
    if (meta !== charMeta) continue;
    let clip;
    try {
      clip = await loadClipFromBundle(env, name, meta);
    } catch (error) {
      if (revision !== charMetaRevision) continue;
      throw error;
    }
    if (revision !== charMetaRevision) continue;
    if (!clip) throw Object.assign(new Error('clip missing: ' + name), { fatal: true });
    cache.set(name, clip);
    while (cache.size > MAX_CACHED_CLIPS) cache.delete(cache.keys().next().value);
    return clip;
  }
}

export function hasClip(name) {
  return cache.has(name);
}

export function clipDuration(clip, fallback = 0.0333) {
  return clip && clip.duration > 0 ? clip.duration : fallback;
}

function sample(track, time) {
  const dim = track.dim || 1;
  const n = track.values.length / dim;
  const f = Math.min(n - 1, Math.max(0, time * 30));
  const i0 = Math.floor(f);
  const i1 = Math.min(n - 1, i0 + 1);
  const a = f - i0;
  const out = new Array(dim);
  for (let d = 0; d < dim; d++) {
    const v0 = track.values[i0 * dim + d];
    const v1 = track.values[i1 * dim + d];
    out[d] = v0 + (v1 - v0) * a;
  }
  return out;
}

/**
 * Sample a clip at `time` seconds.
 * @returns {{muscles: Float32Array, hasMuscle: Uint8Array, root: object, bones: Array, morph: Array<[number, number]>, manage: object}}
 */
export function evalClip(clip, time) {
  const muscles = new Float32Array(MUSCLE_COUNT);
  const hasMuscle = new Uint8Array(MUSCLE_COUNT);
  const root = {};
  const bones = [];
  const morph = [];
  const manage = {};
  if (!clip) return { muscles, hasMuscle, root, bones, morph, manage };
  for (const t of clip.tracks) {
    if (t.kind === 'muscle') {
      muscles[t.index] = sample(t, time)[0];
      hasMuscle[t.index] = 1;
    } else if (t.kind === 'root') {
      root[t.prop] = sample(t, time);
    } else if (t.kind === 'bone') {
      bones.push({
        node: t.node,
        boneName: t.path ? String(t.path).split('/').pop() : null,
        prop: t.prop,
        value: sample(t, time),
      });
    } else if (t.kind === 'blend') {
      morph.push([t.index, sample(t, time)[0] / 100]);
    } else if (t.kind === 'manage') {
      manage[t.prop] = sample(t, time)[0];
    }
  }
  return { muscles, hasMuscle, root, bones, morph, manage };
}
