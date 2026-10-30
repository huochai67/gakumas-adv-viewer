// Animation clip sampling shared by the debug viewer and the story player.
//
// Clips are exported by pipeline/export_clips.py as JSON: one entry per
// AnimationCurve binding, sampled at 30 Hz.
//   muscle - humanoid muscle (index = Unity HumanTrait order, 0..94)
//   bone   - Transform TRS curve keyed by glTF node index
//   blend  - VLActorFaceModel blendShapeWeights slot (morph target index)
//   custom - face-model custom channel (unused)

export const MUSCLE_COUNT = 95;

const cache = new Map();

export async function getClip(name) {
  if (cache.has(name)) return cache.get(name);
  // the player resolves a few hundred candidate names at once; Chromium on
  // Windows occasionally fails individual connects (ERR_ADDRESS_IN_USE) under
  // that burst, so a transient failure is retried while a 404 is not
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`./assets/clips/${name}.json`);
      if (r.status === 404) throw Object.assign(new Error(`clip missing: ${name}`), { fatal: true });
      if (!r.ok) throw new Error(`clip ${r.status}: ${name}`);
      cache.set(name, await r.json());
      return cache.get(name);
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      await new Promise((res) => setTimeout(res, 60 + attempt * 120));
    }
  }
  throw lastErr;
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
 * @returns {{muscles: Float32Array, hasMuscle: Uint8Array, root: object, bones: Array, morph: Array<[number, number]>}}
 */
export function evalClip(clip, time) {
  const muscles = new Float32Array(MUSCLE_COUNT);
  const hasMuscle = new Uint8Array(MUSCLE_COUNT);
  const root = {};
  const bones = [];
  const morph = [];
  if (!clip) return { muscles, hasMuscle, root, bones, morph };
  for (const t of clip.tracks) {
    if (t.kind === 'muscle') {
      muscles[t.index] = sample(t, time)[0];
      hasMuscle[t.index] = 1;
    } else if (t.kind === 'root') {
      root[t.prop] = sample(t, time);
    } else if (t.kind === 'bone') {
      bones.push({ node: t.node, prop: t.prop, value: sample(t, time) });
    } else if (t.kind === 'blend') {
      morph.push([t.index, sample(t, time)[0] / 100]);
    }
  }
  return { muscles, hasMuscle, root, bones, morph };
}
