/**
 * Decode Unity AnimationClip compressed data (streamed/dense/constant).
 *
 * Port of `pipeline/unity_anim.py`. Layout (verified against gakumas clips,
 * mirrors AssetRipper AnimationClipConverter):
 * - every generic binding consumes `dimension` consecutive curve slots
 *   (typeID 4 Transform: attribute 1=translation 3, 2=rotation 4, 3=scale 3,
 *   4=euler 3; everything else 1)
 * - slots are ordered: streamed.curveCount, then dense.m_CurveCount, then
 *   len(constant.data)
 * - streamed frames: float time, int32 keyCount, keyCount * StreamedCurveKey
 *   {int index, float c0, float c1, float c2, float value}; value inside the
 *   frame is value + c0*u^3 + c1*u^2 + c2*u with u = t - frameTime
 * - dense: frame-major, m_CurveCount floats per frame, t = frame/frameRate + beginTime
 * - constant: single value valid over [0, stopTime]
 */

const TRANSFORM_DIM: Record<number, number> = { 1: 3, 2: 4, 3: 3, 4: 3 };

const scratch = new DataView(new ArrayBuffer(4));

function u32ToF32(u: number): number {
  scratch.setUint32(0, u >>> 0, true);
  return scratch.getFloat32(0, true);
}

/** zlib-compatible CRC32 over the UTF-8 encoding of `s`. */
export function crc32(s: string): number {
  const data = new TextEncoder().encode(s);
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function bindingDimension(b: Record<string, any>): number {
  if (Number(b.typeID) === 4) {
    return TRANSFORM_DIM[Number(b.attribute)] ?? 1;
  }
  return 1;
}

export function binding_dimension(b: Record<string, any>): number {
  return bindingDimension(b);
}

/** Return (slot -> [binding index, component]) plus total slot count. */
export function buildCurveMap(
  bindings: Array<Record<string, any>>,
): [Array<[number, number]>, number] {
  const out: Array<[number, number]> = [];
  for (let bi = 0; bi < bindings.length; bi++) {
    const dim = bindingDimension(bindings[bi]);
    for (let d = 0; d < dim; d++) out.push([bi, d]);
  }
  return [out, out.length];
}

export function build_curve_map(
  bindings: Array<Record<string, any>>,
): [Array<[number, number]>, number] {
  return buildCurveMap(bindings);
}

function asWords(data: ArrayLike<number>): ArrayLike<number> {
  if (data instanceof Uint8Array) {
    const count = data.byteLength >>> 2;
    const words = new Uint32Array(count);
    const dv = new DataView(data.buffer, data.byteOffset, count * 4);
    for (let i = 0; i < count; i++) words[i] = dv.getUint32(i * 4, true);
    return words;
  }
  return data;
}

export type StreamedKey = [number, number, number, number];

/** Sampler for a Unity StreamedClip. */
export class StreamedFrames {
  frames: Array<[number, Map<number, StreamedKey>]>;
  private declaredCount: number;

  constructor(data: ArrayLike<number> | null | undefined, declaredCount = 0) {
    this.frames = [];
    this.declaredCount = Number(declaredCount || 0);
    if (!data) return;

    const words = asWords(data);
    const n = words.length;
    let i = 0;
    while (i + 1 < n) {
      const t = u32ToF32(words[i]);
      const count = words[i + 1] | 0;
      i += 2;
      if (count <= 0) continue;
      const keys = new Map<number, StreamedKey>();
      for (let k = 0; k < count; k++) {
        if (i + 5 > n) {
          i = n;
          break;
        }
        const idx = words[i] | 0;
        keys.set(idx, [
          u32ToF32(words[i + 1]),
          u32ToF32(words[i + 2]),
          u32ToF32(words[i + 3]),
          u32ToF32(words[i + 4]),
        ]);
        i += 5;
      }
      this.frames.push([t, keys]);
    }
  }

  curveCount(): number {
    if (this.declaredCount > 0) return this.declaredCount;
    let mx = -1;
    for (const [, keys] of this.frames) {
      for (const idx of keys.keys()) if (idx > mx) mx = idx;
    }
    return mx >= 0 ? mx + 1 : 0;
  }

  curve_count(): number {
    return this.curveCount();
  }

  private evalKey(prev: StreamedKey, u: number): number {
    const [c0, c1, c2, val] = prev;
    if (!(Number.isFinite(c0) && Number.isFinite(c1) && Number.isFinite(c2))) {
      return val;
    }
    return val + u * (c2 + u * (c1 + u * c0));
  }

  sample(index: number, t: number): number {
    let prev: StreamedKey | null = null;
    let prevTime = 0.0;
    for (const [ft, keys] of this.frames) {
      const k = keys.get(index);
      if (k === undefined) continue;
      if (t < ft) {
        if (prev === null) return k[3];
        return this.evalKey(prev, t - prevTime);
      }
      prev = k;
      prevTime = ft;
    }
    if (prev === null) return 0.0;
    return prev[3];
  }
}

/** Random access sampler for one AnimationClip's curve slots. */
export class ClipSampler {
  stopTime: number;
  curveMap: Array<[number, number]>;
  slotCount: number;
  streamed: StreamedFrames | null;
  streamedCount: number;
  denseCount: number;
  denseSamples: number[];
  denseFrames: number;
  denseRate: number;
  denseBegin: number;
  constOffset: number;
  constData: number[];

  constructor(clipObj: Record<string, any>, bindings: Array<Record<string, any>>, stopTime: number) {
    const data = clipObj?.m_MuscleClip?.m_Clip?.data ?? {};
    this.stopTime = stopTime;
    [this.curveMap, this.slotCount] = buildCurveMap(bindings ?? []);

    const sc = data.m_StreamedClip;
    const streamedData = sc?.data;
    const hasStreamed = !!streamedData && streamedData.length > 0;
    this.streamed = hasStreamed
      ? new StreamedFrames(streamedData, Number(sc?.curveCount ?? 0))
      : null;
    this.streamedCount = hasStreamed ? Number(sc?.curveCount ?? 0) : 0;

    const dense = data.m_DenseClip ?? {};
    this.denseCount = Number(dense.m_CurveCount ?? 0);
    if (this.denseCount) {
      this.denseSamples = Array.from(dense.m_SampleArray ?? []);
      this.denseFrames = Number(dense.m_FrameCount ?? 0);
      this.denseRate = Number(dense.m_SampleRate ?? 0) || 30.0;
      this.denseBegin = Number(dense.m_BeginTime ?? 0);
    } else {
      this.denseSamples = [];
      this.denseFrames = 0;
      this.denseRate = 30.0;
      this.denseBegin = 0.0;
    }

    this.constOffset = this.streamedCount + this.denseCount;
    this.constData = data.m_ConstantClip ? Array.from(data.m_ConstantClip.data ?? []) : [];
  }

  value(slot: number, t: number): number {
    if (slot < this.streamedCount) {
      return this.streamed ? this.streamed.sample(slot, t) : 0.0;
    }
    if (slot < this.constOffset) {
      const fi = slot - this.streamedCount;
      if (this.denseFrames === 0) return 0.0;
      // Linear interpolation between dense samples.
      const f = (t - this.denseBegin) * this.denseRate;
      let i0 = Math.trunc(f);
      i0 = Math.max(0, Math.min(this.denseFrames - 1, i0));
      const i1 = Math.max(0, Math.min(this.denseFrames - 1, i0 + 1));
      const frac = Math.min(1.0, Math.max(0.0, f - i0));
      const n = this.denseCount;
      const a = this.denseSamples[i0 * n + fi];
      const b = this.denseSamples[i1 * n + fi];
      return a + (b - a) * frac;
    }
    const ci = slot - this.constOffset;
    if (ci < this.constData.length) return this.constData[ci];
    return 0.0;
  }

  /** Per-time slot values, frame-major. */
  sampleAll(times: number[]): number[][] {
    const out: number[][] = [];
    for (const t of times) {
      const row: number[] = [];
      for (let slot = 0; slot < this.slotCount; slot++) row.push(this.value(slot, t));
      out.push(row);
    }
    return out;
  }

  sample_all(times: number[]): number[][] {
    return this.sampleAll(times);
  }
}
