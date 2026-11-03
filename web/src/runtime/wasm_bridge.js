/**
 * JavaScript bridge to `web/wasm/gakumas_core.wasm` (built from `wasm/lib.rs`).
 *
 * Exposes the exact primitives the browser asset runtime needs:
 *   - Octo bundle header unmasking (`decryptBundle`)
 *   - raw LZ4 block decompression (`decompressLz4Block`)
 *   - Unity Texture2D -> RGBA8 (`decodeTextureRgba`)
 *   - CRI HCA -> mono float32 PCM + 60Hz AIUEO lip-sync (`decodeHcaAndLipsync`)
 *
 * IMPORTANT: growing the WASM heap detaches `memory.buffer`, so every typed
 * array view is created *after* `wasm_alloc` and refreshed *after* each WASM
 * call. Allocated buffers are always released in a `finally` block.
 */

const DEFAULT_WASM_URL = '/wasm/gakumas_core.wasm';

/** @type {WebAssembly.Exports | null} */
let wasmExports = null;
/** @type {Promise<WebAssembly.Exports> | null} */
let initPromise = null;

function resolveWasmUrl(wasmUrl) {
  if (typeof wasmUrl !== 'string' || wasmUrl.length === 0) {
    throw new TypeError('initWasm: wasmUrl must be a non-empty string');
  }
  try {
    return new URL(wasmUrl, import.meta.url).href;
  } catch {
    return wasmUrl;
  }
}

/**
 * Fetch + instantiate the WASM module. Idempotent: repeated calls reuse the
 * same instance (and the very same in-flight promise).
 *
 * @param {string} [wasmUrl]
 * @returns {Promise<WebAssembly.Exports>}
 */
export async function initWasm(wasmUrl = DEFAULT_WASM_URL) {
  if (wasmExports) return wasmExports;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const url = resolveWasmUrl(wasmUrl);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`gakumas_core.wasm: HTTP ${response.status} for ${url}`);
    }
    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    wasmExports = instance.exports;
    return wasmExports;
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null; // allow a retry after a transient failure
    throw error;
  }
}

function getExports() {
  if (!wasmExports) {
    throw new Error('gakumas_core WASM is not initialised: await initWasm() first');
  }
  return wasmExports;
}

/** Fresh byte view over the current linear memory (buffer may have detached). */
function memoryBytes() {
  return new Uint8Array(getExports().memory.buffer);
}

/** Fresh float view over the current linear memory. */
function memoryFloats() {
  return new Float32Array(getExports().memory.buffer);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new TypeError('expected a Uint8Array / ArrayBuffer / typed array');
}

/** Allocate `size` bytes (never zero — `wasm_alloc(0)` still returns a block). */
function alloc(size) {
  const rounded = Math.max(size | 0, 1);
  const ptr = getExports().wasm_alloc(rounded);
  if (!ptr) throw new Error(`gakumas_core: wasm_alloc(${rounded}) failed`);
  return { ptr, size: rounded };
}

function free(block) {
  if (!block) return;
  getExports().wasm_free(block.ptr, block.size);
}

/**
 * Bundle names are consumed by the mask generator as raw UTF-16 code units
 * (mirroring `maskForName` in `pipeline/masked_bundle.ts`), not as UTF-8.
 */
function encodeBundleName(name) {
  const text = String(name ?? '');
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Remove the Octo header mask from a `.bundle` payload.
 *
 * @param {Uint8Array|ArrayBuffer} data
 * @param {string} bundleName e.g. `"adv_story_bg-00-00"`
 * @returns {Uint8Array} decrypted copy (input is left untouched)
 */
export function decryptBundle(data, bundleName) {
  const ex = getExports();
  const src = toBytes(data);
  const nameBytes = encodeBundleName(bundleName);

  const srcBlock = alloc(src.length);
  const nameBlock = alloc(nameBytes.length);
  try {
    if (src.length > 0) memoryBytes().set(src, srcBlock.ptr);
    if (nameBytes.length > 0) memoryBytes().set(nameBytes, nameBlock.ptr);

    ex.wasm_decrypt_bundle(srcBlock.ptr, src.length, nameBlock.ptr, nameBytes.length);
    return memoryBytes().slice(srcBlock.ptr, srcBlock.ptr + src.length);
  } finally {
    free(nameBlock);
    free(srcBlock);
  }
}

/**
 * Decompress a bare (headerless) LZ4 block, as stored in Unity bundles.
 *
 * @param {Uint8Array|ArrayBuffer} src
 * @param {number} uncompressedSize
 * @returns {Uint8Array} the decompressed bytes (`uncompressedSize` long)
 */
export function decompressLz4Block(src, uncompressedSize) {
  const ex = getExports();
  const input = toBytes(src);
  const size = Math.max(Math.trunc(Number(uncompressedSize)) || 0, 0);
  if (size === 0) return new Uint8Array(0);

  const srcBlock = alloc(input.length);
  const dstBlock = alloc(size);
  try {
    if (input.length > 0) memoryBytes().set(input, srcBlock.ptr);

    const written = ex.wasm_lz4_decompress(srcBlock.ptr, input.length, dstBlock.ptr, size);
    if (written < 0) throw new Error(`LZ4 decompression failed (code ${written})`);
    return memoryBytes().slice(dstBlock.ptr, dstBlock.ptr + written);
  } finally {
    free(dstBlock);
    free(srcBlock);
  }
}

/**
 * Decode raw Unity `Texture2D` bytes into tightly packed RGBA8.
 *
 * @param {Uint8Array|ArrayBuffer} src
 * @param {number} width
 * @param {number} height
 * @param {number} format Unity `TextureFormat` (3, 4, 10, 12, 24, 25)
 * @param {boolean} [flip] mirror rows vertically (default true)
 * @returns {Uint8Array} `width * height * 4` bytes
 */
export function decodeTextureRgba(src, width, height, format, flip = true) {
  const ex = getExports();
  const input = toBytes(src);
  const w = Math.trunc(Number(width)) || 0;
  const h = Math.trunc(Number(height)) || 0;
  const fmt = Math.trunc(Number(format)) || 0;
  if (w <= 0 || h <= 0) throw new Error(`decodeTextureRgba: invalid size ${width}x${height}`);

  const outLen = w * h * 4;
  const srcBlock = alloc(input.length);
  const dstBlock = alloc(outLen);
  try {
    if (input.length > 0) memoryBytes().set(input, srcBlock.ptr);

    const rc = ex.wasm_decode_texture2d_rgba(
      srcBlock.ptr,
      input.length,
      w,
      h,
      fmt,
      flip ? 1 : 0,
      dstBlock.ptr,
    );
    if (rc < 0) {
      throw new Error(`decodeTextureRgba: format ${fmt} failed (code ${rc})`);
    }
    return memoryBytes().slice(dstBlock.ptr, dstBlock.ptr + outLen);
  } finally {
    free(dstBlock);
    free(srcBlock);
  }
}

/* ------------------------------------------------------------------------- */
/* HCA voice + lip-sync                                                      */
/* ------------------------------------------------------------------------- */

/** One size-query / decode call into the WASM heap. */
function hcaDecodeOnce(srcPtr, srcLen, maxSamples) {
  const ex = getExports();
  const cap = Math.max(maxSamples | 0, 0);
  const pcmBlock = alloc(cap * 4);
  const srBlock = alloc(4);
  try {
    const written = ex.wasm_decode_hca_mono(
      srcPtr,
      srcLen,
      0, // key_lo
      0, // key_hi (Gakumas voices are unencrypted)
      cap > 0 ? pcmBlock.ptr : 0,
      cap,
      srBlock.ptr,
    );
    if (written < 0) throw new Error(`HCA decode failed (code ${written})`);

    const sampleRate = new Int32Array(ex.memory.buffer, srBlock.ptr, 1)[0] >>> 0;
    const available = Math.min(written, cap);
    const pcm = available > 0
      ? memoryFloats().slice(pcmBlock.ptr >> 2, (pcmBlock.ptr >> 2) + available)
      : new Float32Array(0);
    return { written, sampleRate, pcm };
  } finally {
    free(srBlock);
    free(pcmBlock);
  }
}

/** Compute `[a, i, u, e, o]` (0..100) per frame for `pcm`. */
function computeAiueoFrames(pcm, sampleRate, fps) {
  const ex = getExports();
  if (pcm.length === 0 || sampleRate <= 0) return [];

  const rate = Math.max(Math.trunc(fps) || 60, 1);
  const maxFrames = Math.max(1, Math.ceil((pcm.length / sampleRate) * rate) + 8);
  const pcmBlock = alloc(pcm.length * 4);
  const framesBlock = alloc(maxFrames * 5);
  try {
    memoryFloats().set(pcm, pcmBlock.ptr >> 2);

    const nFrames = ex.wasm_compute_aiueo(
      pcmBlock.ptr,
      pcm.length,
      sampleRate,
      rate,
      framesBlock.ptr,
      maxFrames,
    );
    if (nFrames < 0) throw new Error(`AIUEO analysis failed (code ${nFrames})`);

    const count = Math.min(nFrames, maxFrames);
    const raw = memoryBytes().slice(framesBlock.ptr, framesBlock.ptr + count * 5);
    const frames = new Array(count);
    for (let f = 0; f < count; f++) {
      const o = f * 5;
      frames[f] = [raw[o], raw[o + 1], raw[o + 2], raw[o + 3], raw[o + 4]];
    }
    return frames;
  } finally {
    free(framesBlock);
    free(pcmBlock);
  }
}

function writeAscii(target, offset, text) {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i) & 0xff;
}

/** 44-byte RIFF/WAVE header for mono IEEE-float32 PCM. */
function buildFloat32WavHeader(sampleRate, dataBytes) {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  writeAscii(header, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // chunk size
  writeAscii(header, 8, 'WAVE');
  writeAscii(header, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 32, true); // bits per sample
  writeAscii(header, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * Decode a CRI HCA stream to mono float32 PCM, compute 60Hz AIUEO lip-sync
 * weights and wrap the PCM in a playable `audio/wav` blob URL.
 *
 * @param {Uint8Array|ArrayBuffer} hcaBytes raw `.hca` stream (no AWB framing)
 * @param {number} [fps] lip-sync frame rate (default 60)
 * @returns {{ pcm: Float32Array, sampleRate: number, duration: number,
 *             frames: number[][], wavBlobUrl: string }}
 */
export function decodeHcaAndLipsync(hcaBytes, fps = 60) {
  const src = toBytes(hcaBytes);
  if (src.length === 0) throw new Error('decodeHcaAndLipsync: empty HCA stream');

  const srcBlock = alloc(src.length);
  let pcm;
  let sampleRate;
  try {
    memoryBytes().set(src, srcBlock.ptr);

    // Size query first (no PCM buffer), then decode exactly that many samples.
    // A decoder without a query mode reports < 0 (or throws); fall back to
    // growing the buffer until the returned length stops filling it.
    let probe = null;
    try {
      probe = hcaDecodeOnce(srcBlock.ptr, src.length, 0);
    } catch {
      probe = null;
    }
    const total = probe && probe.written > 0 ? probe.written : 0;
    if (total > 0) {
      const decoded = hcaDecodeOnce(srcBlock.ptr, src.length, total);
      pcm = decoded.pcm;
      sampleRate = decoded.sampleRate || (probe && probe.sampleRate) || 0;
      if (pcm.length === 0 && decoded.written > 0) {
        throw new Error('decodeHcaAndLipsync: PCM buffer was not filled');
      }
    } else {
      let cap = 1 << 16;
      let previous = -1;
      for (let attempt = 0; attempt < 24; attempt++) {
        const decoded = hcaDecodeOnce(srcBlock.ptr, src.length, cap);
        sampleRate = decoded.sampleRate;
        if (decoded.written < cap || decoded.written === previous) {
          pcm = decoded.pcm;
          break;
        }
        previous = decoded.written;
        cap = Math.max(decoded.written * 2, cap * 2);
      }
      if (!pcm) throw new Error('decodeHcaAndLipsync: HCA stream is too long to decode');
    }
    if (!sampleRate) throw new Error('decodeHcaAndLipsync: decoder reported sample rate 0');
  } finally {
    free(srcBlock);
  }

  const rate = Math.trunc(fps) || 60;
  const frames = computeAiueoFrames(pcm, sampleRate, rate);
  const duration = pcm.length / sampleRate;
  const pcmBytes = pcm.length * 4;
  const wavHeader = buildFloat32WavHeader(sampleRate, pcmBytes);
  const wavBlobUrl = URL.createObjectURL(
    new Blob([wavHeader, pcm], { type: 'audio/wav' }),
  );

  return { pcm, sampleRate, duration, frames, wavBlobUrl };
}
