/**
 * Headless ADV Script-to-Video Renderer (`pipeline/render_video.ts`).
 *
 * Given an input `.txt` ADV script file (or script name in `OctoManifest.json`):
 *   1. Resolves the `.txt` script locally or auto-downloads it from Octo.
 *   2. Parses the timeline and automatically completes all missing `.bundle`
 *      packages (characters, 3D stages, 2D backgrounds, animations + transitive
 *      dependencies) and `.acb`/`.awb` audio resources into `cache/`.
 *   3. Decodes all voice, SE, and BGM CRI HCA audio streams via `gakumas_core.wasm`,
 *      computes 60Hz AIUEO lip-sync frames, and mixes a sample-accurate 48kHz
 *      master soundtrack.
 *   4. Launches a local server + headless Firefox (with WebGL2 hardware acceleration)
 *      + `ffmpeg` H.264/AAC pipeline, steps the 3D/2D scene deterministically at
 *      fixed `1/fps` intervals, and outputs an `.mp4` video.
 *
 * Usage:
 *   pnpm render <input.txt> [output.mp4] [--fps 30] [--width 1280] [--height 720] [--duration 15]
 *   node pipeline/render_video.ts <input.txt> -o output.mp4
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensure_bundles,
  ensure_manifest,
  ensure_resources,
  type OctoManifest,
} from "./fetch.ts";
import { extractAcbHcaStreams } from "./export_voices.ts";
import { parseAdv, buildTimeline } from "../web/src/engine/adv.js";
import {
  ASSETS_DIR,
  DEFAULT_MIME,
  getCacheIndex,
  handleApiAndCacheRequest,
  invalidateCacheIndex,
  MIME_TYPES,
  RESOURCE_DIR,
  STATIC_CACHE_CONTROL,
  statOrNull,
  WEB_ROOT,
} from "../web/server/api.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(WEB_ROOT, "dist");
const WASM_PATH = path.join(WEB_ROOT, "wasm", "gakumas_core.wasm");
const SAMPLE_RATE = 48000;

interface AdvActorParts {
  body?: string;
  face?: string;
  hair?: string;
}

interface AdvCue {
  type: string;
  t: number;
  dur: number;
  clipIn: number;
  params: Record<string, unknown>;
  all?: Record<string, unknown>;
}

interface AdvTimeline {
  actors: Map<string, AdvActorParts>;
  backgrounds: Map<string, { src?: string }>;
  cues: AdvCue[];
  duration: number;
}

interface RenderOptions {
  input: string;
  output: string;
  fps: number;
  width: number;
  height: number;
  startTime: number;
  duration: number | null;
  crf: number;
  preset: string;
  includeUi: boolean;
  useBloom: boolean;
  includeBgm: boolean;
  includeSe: boolean;
  includeVoice: boolean;
}

function printUsage(): void {
  console.log(
    `Usage:
  pnpm render <input.txt | script_name> [output.mp4] [options]
  node pipeline/render_video.ts <input.txt | script_name> [output.mp4] [options]

Options:
  -o, --output <path>     Output video file path (default: <script_stem>.mp4)
  --fps <number>          Frames per second (default: 30)
  --width <pixels>        Output video width (default: 1280)
  --height <pixels>       Output video height (default: 720)
  --start <seconds>       Start timestamp in seconds (default: 0)
  --duration <seconds>    Max duration in seconds to render (default: full script)
  --end <seconds>         End timestamp in seconds (default: full script)
  --crf <number>          H.264 CRF quality, lower is higher quality (default: 18)
  --preset <name>         x264 encoding preset (default: veryfast)
  --no-ui                 Hide the ADV dialogue box overlay
  --no-bloom              Disable Bloom / Depth-of-Field post-processing
  --no-bgm                Disable background music in output audio
  --no-se                 Disable sound effects in output audio
  --no-voice              Disable character voice audio
  -h, --help              Show this help message`.trim(),
  );
}

function parseCliArgs(argv: string[]): RenderOptions {
  let input = "";
  let output = "";
  let fps = 30;
  let width = 1280;
  let height = 720;
  let startTime = 0;
  let duration: number | null = null;
  let endTime: number | null = null;
  let crf = 18;
  let preset = "veryfast";
  let includeUi = true;
  let useBloom = true;
  let includeBgm = true;
  let includeSe = true;
  let includeVoice = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (arg === "-o" || arg === "--output") {
      output = argv[++i] || "";
    } else if (arg === "--fps") {
      fps = Math.max(1, Math.min(120, Number(argv[++i]) || 30));
    } else if (arg === "--width") {
      width = Math.max(160, Math.floor(Number(argv[++i]) || 1280));
    } else if (arg === "--height") {
      height = Math.max(90, Math.floor(Number(argv[++i]) || 720));
    } else if (arg === "--start") {
      startTime = Math.max(0, Number(argv[++i]) || 0);
    } else if (arg === "--duration") {
      const d = Number(argv[++i]);
      if (Number.isFinite(d) && d > 0) duration = d;
    } else if (arg === "--end") {
      const e = Number(argv[++i]);
      if (Number.isFinite(e) && e > 0) endTime = e;
    } else if (arg === "--crf") {
      const c = Number(argv[++i]);
      if (Number.isFinite(c) && c >= 0 && c <= 51) crf = c;
    } else if (arg === "--preset") {
      preset = argv[++i] || "veryfast";
    } else if (arg === "--no-ui") {
      includeUi = false;
    } else if (arg === "--no-bloom") {
      useBloom = false;
    } else if (arg === "--no-bgm") {
      includeBgm = false;
    } else if (arg === "--no-se") {
      includeSe = false;
    } else if (arg === "--no-voice") {
      includeVoice = false;
    } else if (!arg.startsWith("-")) {
      if (!input) {
        input = arg;
      } else if (!output) {
        output = arg;
      }
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!input) {
    printUsage();
    process.exit(1);
  }

  // Ensure even dimensions for yuv420p H.264
  width = width & ~1;
  height = height & ~1;

  if (duration === null && endTime !== null && endTime > startTime) {
    duration = endTime - startTime;
  }

  if (!output) {
    const stem = path.basename(input).replace(/\.txt$/i, "");
    output = path.resolve(process.cwd(), `${stem}.mp4`);
  } else {
    output = path.resolve(process.cwd(), output);
  }

  return {
    input,
    output,
    fps,
    width,
    height,
    startTime,
    duration,
    crf,
    preset,
    includeUi,
    useBloom,
    includeBgm,
    includeSe,
    includeVoice,
  };
}

/* -------------------------------------------------------------------------- */
/* Step 1 & 2: Resolve Script & Auto-Fetch Missing Bundles / Resources        */
/* -------------------------------------------------------------------------- */

async function resolveInputScript(inputArg: string): Promise<{ filePath: string; label: string; text: string }> {
  const directPath = path.resolve(process.cwd(), inputArg);
  if (statOrNull(directPath)?.isFile()) {
    return {
      filePath: directPath,
      label: path.basename(directPath),
      text: fs.readFileSync(directPath, "utf8"),
    };
  }

  const baseName = path.basename(inputArg);
  const fileName = baseName.endsWith(".txt") ? baseName : `${baseName}.txt`;

  for (const dir of [RESOURCE_DIR, ASSETS_DIR]) {
    const candidate = path.join(dir, fileName);
    if (statOrNull(candidate)?.isFile()) {
      return {
        filePath: candidate,
        label: fileName,
        text: fs.readFileSync(candidate, "utf8"),
      };
    }
  }

  console.log(`[script] '${fileName}' not found locally; fetching from Octo manifest...`);
  await ensure_manifest(false, true);
  const downloaded = await ensure_resources([fileName], true);
  const resolved = downloaded.get(fileName) || path.join(RESOURCE_DIR, fileName);
  if (!statOrNull(resolved)?.isFile()) {
    throw new Error(`Script file not found locally or in Octo manifest: ${inputArg}`);
  }
  return {
    filePath: resolved,
    label: fileName,
    text: fs.readFileSync(resolved, "utf8"),
  };
}

async function ensureAllScriptAssets(
  timeline: AdvTimeline,
  manifest: OctoManifest,
): Promise<void> {
  const bundleSet = new Set((manifest.assetBundleList ?? []).map((b) => b.name));
  const resourceSet = new Set((manifest.resourceList ?? []).map((r) => r.name));

  // Always include base humanoid skeleton/blendshape reference bundles & default idle clip
  const wantBundles = new Set<string>([
    "mdl_chr_amao-casl-0000_body",
    "mdl_chr_amao-base-0000_face",
    "mdl_chr_amao-base-0000_hair",
    "t_chr_amao-base-0000",
    "mot_all_chr_cmmn_stand-001_lp",
  ]);

  for (const [, parts] of timeline.actors) {
    if (parts.body) wantBundles.add(parts.body);
    if (parts.face) {
      wantBundles.add(parts.face);
      const m = /^mdl_chr_([a-z0-9]+)-/i.exec(parts.face);
      if (m) wantBundles.add(`t_chr_${m[1]}-base-0000`);
    }
    if (parts.hair) wantBundles.add(parts.hair);
  }

  for (const bg of timeline.backgrounds.values()) {
    if (bg && bg.src) {
      wantBundles.add(bg.src);
      if (bg.src.startsWith("env_3d")) {
        wantBundles.add("t_sky_noon-00");
      }
    }
  }

  const wantResources = new Set<string>();

  for (const c of timeline.cues) {
    const p = c.params || {};
    if (
      c.type === "actormotion" ||
      c.type === "actorfacialmotion" ||
      c.type === "actoradditivemotion"
    ) {
      const m = String(p.motion || "");
      if (m) {
        const stem = m.replace(/_[bf]$/, "");
        wantBundles.add(stem);
        wantBundles.add(m);
        wantBundles.add(`${stem}_b`);
        wantBundles.add(`${stem}_f`);
      }
    } else if (c.type === "voice" && p.voice) {
      const cueName = String(p.voice);
      const sheet = cueName.replace(/_[a-z0-9]+-\d+$/, "");
      if (sheet) wantResources.add(`${sheet}.acb`);
      wantResources.add(`${cueName}.acb`);
    } else if (c.type === "se" && p.se) {
      const seName = String(p.se);
      wantResources.add(`${seName}.acb`);
      const seSheet = seName.replace(/-\d+$/, "");
      if (seSheet) wantResources.add(`${seSheet}.acb`);
    } else if (c.type === "message" && p.se) {
      const seName = String(p.se);
      wantResources.add(`${seName}.acb`);
    } else if (c.type === "bgmplay" && p.bgm && p.bgm !== "null") {
      const bgmName = String(p.bgm);
      wantResources.add(`${bgmName}.acb`);
      wantResources.add(`${bgmName}.awb`);
    }
  }

  const filteredBundles = [...wantBundles].filter((b) => bundleSet.has(b));
  const filteredResources = [...wantResources].filter((r) => resourceSet.has(r));

  if (filteredBundles.length > 0) {
    await ensure_bundles(filteredBundles, true, true);
  }
  if (filteredResources.length > 0) {
    await ensure_resources(filteredResources, true);
  }
  invalidateCacheIndex();
  getCacheIndex();
}

/* -------------------------------------------------------------------------- */
/* Step 3: Audio Decoding, 60Hz AIUEO Lip-Sync & Master Soundtrack Mixing     */
/* -------------------------------------------------------------------------- */

interface WasmAudioExports {
  memory: WebAssembly.Memory;
  wasm_alloc: (size: number) => number;
  wasm_free: (ptr: number, size: number) => void;
  wasm_decode_hca_mono: (
    srcPtr: number,
    srcLen: number,
    keyLo: number,
    keyHi: number,
    pcmPtr: number,
    maxSamples: number,
    srPtr: number,
  ) => number;
  wasm_compute_aiueo: (
    pcmPtr: number,
    numSamples: number,
    sampleRate: number,
    fps: number,
    outPtr: number,
    maxFrames: number,
  ) => number;
}

class WasmHcaDecoder {
  private ex: WasmAudioExports;

  private constructor(ex: WasmAudioExports) {
    this.ex = ex;
  }

  static async create(): Promise<WasmHcaDecoder> {
    const wasmBytes = fs.readFileSync(WASM_PATH);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    return new WasmHcaDecoder(instance.exports as unknown as WasmAudioExports);
  }

  private alloc(size: number): { ptr: number; size: number } {
    const n = Math.max(size | 0, 1);
    const ptr = this.ex.wasm_alloc(n);
    if (!ptr) throw new Error(`wasm_alloc(${n}) failed`);
    return { ptr, size: n };
  }

  decodeHcaMono(hcaBytes: Uint8Array): { pcm: Float32Array; sampleRate: number } {
    const srcBlock = this.alloc(hcaBytes.length);
    const srBlock = this.alloc(4);
    try {
      new Uint8Array(this.ex.memory.buffer).set(hcaBytes, srcBlock.ptr);
      // Probe sample count first (pass maxSamples=0)
      let totalSamples = this.ex.wasm_decode_hca_mono(
        srcBlock.ptr,
        hcaBytes.length,
        0,
        0,
        0,
        0,
        srBlock.ptr,
      );
      if (totalSamples <= 0) {
        totalSamples = SAMPLE_RATE * 90;
      }
      const pcmBlock = this.alloc(totalSamples * 4);
      try {
        const written = this.ex.wasm_decode_hca_mono(
          srcBlock.ptr,
          hcaBytes.length,
          0,
          0,
          pcmBlock.ptr,
          totalSamples,
          srBlock.ptr,
        );
        if (written < 0) throw new Error(`wasm_decode_hca_mono failed (${written})`);
        const sr = new Int32Array(this.ex.memory.buffer, srBlock.ptr, 1)[0] >>> 0;
        const pcm = new Float32Array(written);
        pcm.set(new Float32Array(this.ex.memory.buffer, pcmBlock.ptr, written));
        return { pcm, sampleRate: sr || SAMPLE_RATE };
      } finally {
        this.ex.wasm_free(pcmBlock.ptr, pcmBlock.size);
      }
    } finally {
      this.ex.wasm_free(srBlock.ptr, srBlock.size);
      this.ex.wasm_free(srcBlock.ptr, srcBlock.size);
    }
  }

  computeAiueo(pcm: Float32Array, sampleRate: number, fps = 60): number[][] {
    if (pcm.length === 0 || sampleRate <= 0) return [];
    const maxFrames = Math.max(1, Math.ceil((pcm.length / sampleRate) * fps) + 8);
    const pcmBlock = this.alloc(pcm.length * 4);
    const outBlock = this.alloc(maxFrames * 5);
    try {
      new Float32Array(this.ex.memory.buffer).set(pcm, pcmBlock.ptr >> 2);
      const count = this.ex.wasm_compute_aiueo(
        pcmBlock.ptr,
        pcm.length,
        sampleRate,
        fps,
        outBlock.ptr,
        maxFrames,
      );
      if (count <= 0) return [];
      const n = Math.min(count, maxFrames);
      const raw = new Uint8Array(this.ex.memory.buffer, outBlock.ptr, n * 5);
      const frames: number[][] = new Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * 5;
        frames[i] = [raw[o], raw[o + 1], raw[o + 2], raw[o + 3], raw[o + 4]];
      }
      return frames;
    } finally {
      this.ex.wasm_free(outBlock.ptr, outBlock.size);
      this.ex.wasm_free(pcmBlock.ptr, pcmBlock.size);
    }
  }
}

function extractAfs2Streams(awbBytes: Uint8Array): Uint8Array[] {
  if (awbBytes.length < 16) return [];
  const magic = String.fromCharCode(awbBytes[0], awbBytes[1], awbBytes[2], awbBytes[3]);
  if (magic !== "AFS2") return [];
  const dv = new DataView(awbBytes.buffer, awbBytes.byteOffset, awbBytes.byteLength);
  const offSize = dv.getUint8(5);
  const idSize = dv.getUint16(6, true);
  const count = dv.getUint32(8, true);
  const align = dv.getUint16(12, true);
  const offsPos = 16 + count * idSize;
  const readOff = (p: number): number =>
    offSize === 2 ? dv.getUint16(p, true) : dv.getUint32(p, true);
  const alignUp = (v: number, a: number): number => (a > 1 ? (v + a - 1) & ~(a - 1) : v);

  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const s = alignUp(readOff(offsPos + i * offSize), align);
    const e = readOff(offsPos + (i + 1) * offSize);
    if (e > s && e <= awbBytes.length) {
      out.push(awbBytes.subarray(s, e));
    }
  }
  return out;
}

function mixSamplesInto(
  dst: Float32Array,
  src: Float32Array,
  srcSampleRate: number,
  dstStartSec: number,
  clipInSec = 0,
  gain = 1.0,
  maxDurSec = 0,
): void {
  if (src.length === 0 || gain <= 0) return;
  const ratio = srcSampleRate / SAMPLE_RATE;
  const startSample = Math.round(dstStartSec * SAMPLE_RATE);
  const clipInSamples = clipInSec * srcSampleRate;
  const availOutSamples = Math.floor((src.length - clipInSamples) / ratio);
  if (availOutSamples <= 0) return;
  const limitSamples =
    maxDurSec > 0 ? Math.min(availOutSamples, Math.ceil(maxDurSec * SAMPLE_RATE)) : availOutSamples;

  for (let i = 0; i < limitSamples; i++) {
    const di = startSample + i;
    if (di < 0) continue;
    if (di >= dst.length) break;
    const si = clipInSamples + i * ratio;
    const idx = si | 0;
    if (idx >= src.length) break;
    dst[di] += src[idx] * gain;
  }
}

function writeWav16Mono(filePath: string, samples: Float32Array, sampleRate = SAMPLE_RATE): void {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buf = Buffer.allocUnsafe(44 + dataBytes);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
  buf.writeUInt16LE(1, 22); // 1 channel (mono)
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let x = samples[i];
    // Soft knee clip above 0.85 to prevent harsh digital clipping when BGM+SE+Voice overlap
    if (x > 0.85) x = 0.85 + 0.15 * Math.tanh((x - 0.85) / 0.15);
    else if (x < -0.85) x = -0.85 + 0.15 * Math.tanh((x + 0.85) / 0.15);
    const s16 = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    buf.writeInt16LE(s16, offset);
    offset += 2;
  }

  fs.writeFileSync(filePath, buf);
}

async function synthesizeAudioAndLipsync(
  timeline: AdvTimeline,
  opts: RenderOptions,
  renderDuration: number,
  wavOutPath: string,
): Promise<{ fps: number; cues: Record<string, { duration: number; fps: number; frames: number[][] }> }> {
  const decoder = await WasmHcaDecoder.create();
  const lipsyncCues: Record<string, { duration: number; fps: number; frames: number[][] }> = {};
  const acbStreamCache = new Map<string, Map<string, Uint8Array>>();
  const decodedCueCache = new Map<string, { pcm: Float32Array; sampleRate: number }>();

  const getAcbStreams = (sheetName: string): Map<string, Uint8Array> | null => {
    if (acbStreamCache.has(sheetName)) return acbStreamCache.get(sheetName)!;
    const p = path.join(RESOURCE_DIR, `${sheetName}.acb`);
    if (!statOrNull(p)?.isFile()) return null;
    try {
      const streams = extractAcbHcaStreams(fs.readFileSync(p));
      acbStreamCache.set(sheetName, streams);
      return streams;
    } catch {
      return null;
    }
  };

  const getDecodedCue = (sheetName: string, cueName: string): { pcm: Float32Array; sampleRate: number } | null => {
    const key = `${sheetName}:${cueName}`;
    if (decodedCueCache.has(key)) return decodedCueCache.get(key)!;
    const streams = getAcbStreams(sheetName);
    const hca = streams?.get(cueName) || (streams && streams.size === 1 ? [...streams.values()][0] : null);
    if (!hca) return null;
    try {
      const dec = decoder.decodeHcaMono(hca);
      decodedCueCache.set(key, dec);
      return dec;
    } catch {
      return null;
    }
  };

  const totalSamples = Math.max(1, Math.ceil(renderDuration * SAMPLE_RATE));
  const master = new Float32Array(totalSamples);
  const endTime = opts.startTime + renderDuration;

  // 1. Decode all voice cues (for both lip-sync & audio mix)
  let voiceMixedCount = 0;
  for (const c of timeline.cues) {
    if (c.type !== "voice" || !c.params?.voice) continue;
    const cueName = String(c.params.voice);
    const sheet = cueName.replace(/_[a-z0-9]+-\d+$/, "");
    const dec = getDecodedCue(sheet, cueName) || getDecodedCue(cueName, cueName);
    if (!dec) continue;

    if (!lipsyncCues[cueName]) {
      const frames = decoder.computeAiueo(dec.pcm, dec.sampleRate, 60);
      lipsyncCues[cueName] = {
        duration: dec.pcm.length / dec.sampleRate,
        fps: 60,
        frames,
      };
    }

    if (opts.includeVoice) {
      const cueDur = Math.max(c.dur || 0, dec.pcm.length / dec.sampleRate);
      if (c.t + cueDur >= opts.startTime && c.t <= endTime) {
        const vol = Number(c.params.volume ?? 1) * 0.92;
        mixSamplesInto(master, dec.pcm, dec.sampleRate, c.t - opts.startTime, c.clipIn || 0, vol);
        voiceMixedCount++;
      }
    }
  }

  // 2. Mix Sound Effects ([se] and [message se=...])
  let seMixedCount = 0;
  if (opts.includeSe) {
    for (const c of timeline.cues) {
      let seName = "";
      let vol = 0.45;
      if (c.type === "se" && c.params?.se) {
        seName = String(c.params.se);
        vol = Number(c.params.volume ?? 1) * 0.48;
      } else if (c.type === "message" && c.params?.se) {
        seName = String(c.params.se);
        vol = 0.32;
      }
      if (!seName) continue;
      if (c.t + 5 < opts.startTime || c.t > endTime) continue;
      const seSheet = seName.replace(/-\d+$/, "");
      const dec = getDecodedCue(seName, seName) || getDecodedCue(seSheet, seName);
      if (!dec) continue;
      mixSamplesInto(master, dec.pcm, dec.sampleRate, c.t - opts.startTime, c.clipIn || 0, vol);
      seMixedCount++;
    }
  }

  // 3. Mix BGM ([bgmplay] ... [bgmstop])
  let bgmMixedCount = 0;
  if (opts.includeBgm) {
    interface BgmSpan {
      bgm: string;
      start: number;
      end: number;
      volume: number;
      fadeIn: number;
      fadeOut: number;
    }
    const spans: BgmSpan[] = [];
    let current: BgmSpan | null = null;
    for (const c of timeline.cues) {
      if (c.type === "bgmplay") {
        const bgm = String(c.params?.bgm || "");
        if (current) {
          current.end = c.t;
          current.fadeOut = Number(c.params?.fadeTime ?? 0.3);
          spans.push(current);
          current = null;
        }
        if (bgm && bgm !== "null") {
          current = {
            bgm,
            start: c.t,
            end: timeline.duration,
            volume: Number(c.params?.volume ?? 0.7),
            fadeIn: Number(c.params?.fadeTime ?? 0),
            fadeOut: 0.4,
          };
        }
      } else if (c.type === "bgmstop" && current) {
        current.end = c.t;
        current.fadeOut = Number(c.params?.fadeTime ?? 0.5);
        spans.push(current);
        current = null;
      }
    }
    if (current) spans.push(current);

    for (const span of spans) {
      if (span.end <= opts.startTime || span.start >= endTime) continue;
      const awbPath = path.join(RESOURCE_DIR, `${span.bgm}.awb`);
      const acbPath = path.join(RESOURCE_DIR, `${span.bgm}.acb`);
      let hcaStreams: Uint8Array[] = [];
      if (statOrNull(awbPath)?.isFile()) {
        hcaStreams = extractAfs2Streams(fs.readFileSync(awbPath));
      } else if (statOrNull(acbPath)?.isFile()) {
        try {
          const map = extractAcbHcaStreams(fs.readFileSync(acbPath));
          hcaStreams = [...map.values()];
        } catch {
          hcaStreams = [];
        }
      }
      if (hcaStreams.length === 0) continue;

      const decodedParts: Array<{ pcm: Float32Array; sampleRate: number }> = [];
      for (const hs of hcaStreams) {
        try {
          decodedParts.push(decoder.decodeHcaMono(hs));
        } catch {
          // ignore undecodable stream
        }
      }
      if (decodedParts.length === 0) continue;

      const introPart = decodedParts.length > 1 ? decodedParts[0] : null;
      const loopPart = decodedParts[decodedParts.length - 1];
      const baseGain = span.volume * 0.22;
      const fadeInSec = Math.max(0.02, span.fadeIn);
      const fadeOutSec = Math.max(0.05, span.fadeOut);
      const effectiveEnd = span.end + fadeOutSec;

      const startOutIdx = Math.max(0, Math.floor((span.start - opts.startTime) * SAMPLE_RATE));
      const endOutIdx = Math.min(
        master.length,
        Math.ceil((effectiveEnd - opts.startTime) * SAMPLE_RATE),
      );
      const introLen = introPart ? introPart.pcm.length : 0;
      const loopLen = loopPart.pcm.length;
      if (loopLen <= 0) continue;

      for (let di = startOutIdx; di < endOutIdx; di++) {
        const timelineT = opts.startTime + di / SAMPLE_RATE;
        const elapsed = timelineT - span.start;
        if (elapsed < 0) continue;
        const elapsedSamples = Math.floor(elapsed * SAMPLE_RATE);
        let sampleVal = 0;
        if (introPart && elapsedSamples < introLen) {
          sampleVal = introPart.pcm[elapsedSamples];
        } else {
          const loopIdx = (elapsedSamples - introLen) % loopLen;
          sampleVal = loopPart.pcm[loopIdx];
        }
        let envGain = 1.0;
        if (elapsed < fadeInSec && span.fadeIn > 0) {
          envGain = Math.min(1, elapsed / fadeInSec);
        }
        if (timelineT > span.end) {
          envGain *= Math.max(0, 1 - (timelineT - span.end) / fadeOutSec);
        }
        master[di] += sampleVal * baseGain * envGain;
      }
      bgmMixedCount++;
    }
  }

  writeWav16Mono(wavOutPath, master, SAMPLE_RATE);
  console.log(
    `[audio] Synthesized ${(renderDuration).toFixed(2)}s 48kHz audio track ` +
      `(voices: ${voiceMixedCount}, SE: ${seMixedCount}, BGM: ${bgmMixedCount})`,
  );

  return { fps: 60, cues: lipsyncCues };
}

/* -------------------------------------------------------------------------- */
/* Step 4: Headless Browser + Marionette + FFmpeg Video Encoding              */
/* -------------------------------------------------------------------------- */

function getFreePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    srv.close(() => resolve(port));
  });
  srv.on("error", reject);
  return promise;
}

function detectHeadlessFirefoxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MOZ_WEBRENDER: "1",
  };
  if (!env.WAYLAND_DISPLAY) {
    try {
      const runUser = "/run/user";
      if (statOrNull(runUser)?.isDirectory()) {
        for (const uidDir of fs.readdirSync(runUser)) {
          const fullUidDir = path.join(runUser, uidDir);
          if (!statOrNull(fullUidDir)?.isDirectory()) continue;
          for (const entry of fs.readdirSync(fullUidDir)) {
            if (entry.startsWith("wayland-") && !entry.endsWith(".lock")) {
              env.WAYLAND_DISPLAY = path.join(fullUidDir, entry);
              env.MOZ_ENABLE_WAYLAND = "1";
              break;
            }
          }
          if (env.WAYLAND_DISPLAY) break;
        }
      }
    } catch {
      // fallback to default headless display
    }
  } else {
    env.MOZ_ENABLE_WAYLAND = "1";
  }
  return env;
}

class MarionetteClient {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, (msg: unknown[]) => void>();
  private msgId = 1;

  async connect(port: number, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const s = net.createConnection({ host: "127.0.0.1", port }, () => {
          this.sock = s;
          resolve();
        });
        s.once("error", reject);
        await promise;
        break;
      } catch {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 150);
        await promise;
      }
    }
    if (!this.sock) throw new Error(`Timed out connecting to Firefox Marionette on port ${port}`);

    const { promise: readyPromise, resolve: resolveReady } = Promise.withResolvers<void>();
    this.sock.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      while (true) {
        const colon = this.buf.indexOf(58); // ':'
        if (colon === -1) break;
        const len = parseInt(this.buf.subarray(0, colon).toString("ascii"), 10);
        if (this.buf.length < colon + 1 + len) break;
        const body = this.buf.subarray(colon + 1, colon + 1 + len).toString("utf8");
        this.buf = this.buf.subarray(colon + 1 + len);
        const msg = JSON.parse(body);
        if (msg && typeof msg === "object" && "applicationType" in msg && msg.applicationType === "gecko") {
          resolveReady();
        } else if (Array.isArray(msg) && msg[0] === 1) {
          const cb = this.pending.get(Number(msg[1]));
          if (cb) {
            this.pending.delete(Number(msg[1]));
            cb(msg);
          }
        }
      }
    });
    await readyPromise;
  }

  send(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.msgId++;
    const payload = JSON.stringify([0, id, name, params]);
    const frame = `${Buffer.byteLength(payload)}:${payload}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.pending.set(id, (msg: unknown[]) => {
      if (msg[2]) reject(new Error(JSON.stringify(msg[2])));
      else resolve(msg[3]);
    });
    this.sock.write(frame);
    return promise;
  }

  close(): void {
    try {
      this.sock?.destroy();
    } catch {
      // ignore
    }
  }
}

function readBinaryBody(req: IncomingMessage): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
  return promise;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const opts = parseCliArgs(process.argv.slice(2));

  // 1. Resolve .txt script (auto-downloading from Octo if needed)
  const scriptInfo = await resolveInputScript(opts.input);
  const events = parseAdv(scriptInfo.text);
  const timeline = buildTimeline(events) as unknown as AdvTimeline;
  if (timeline.duration <= 0) {
    throw new Error(`Script '${scriptInfo.label}' produced an empty timeline.`);
  }

  const maxAvailDuration = Math.max(0.1, timeline.duration - opts.startTime);
  const renderDuration =
    opts.duration !== null ? Math.min(opts.duration, maxAvailDuration) : maxAvailDuration;
  const totalFrames = Math.max(1, Math.round(renderDuration * opts.fps));

  console.log(
    `[render] Script: ${scriptInfo.label} (${events.length} cues, total ${timeline.duration.toFixed(2)}s)`,
  );
  console.log(
    `[render] Target: ${opts.output} (${opts.width}x${opts.height} @ ${opts.fps}fps, ` +
      `start=${opts.startTime.toFixed(2)}s, duration=${renderDuration.toFixed(2)}s, ${totalFrames} frames)`,
  );

  // 2. Ensure Octo manifest & auto-complete all missing bundles and resources
  const manifest = await ensure_manifest(false, true);
  await ensureAllScriptAssets(timeline, manifest);

  // 3. Synthesize master 48kHz WAV audio & 60Hz AIUEO lip-sync database
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gakumas-render-"));
  const wavPath = path.join(tmpDir, "soundtrack.wav");
  let ffProc: ChildProcess | null = null;
  let fxProc: ChildProcess | null = null;
  let httpServer: Server | null = null;
  const cleanup = () => {
    try {
      fxProc?.kill("SIGKILL");
    } catch {}
    try {
      httpServer?.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    const lipsyncDb = await synthesizeAudioAndLipsync(timeline, opts, renderDuration, wavPath);

    // 4. Spawn ffmpeg reading JPEG frames from stdin pipe:0 + soundtrack.wav
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    const ffArgs = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-framerate",
      String(opts.fps),
      "-i",
      "pipe:0",
      "-i",
      wavPath,
      "-c:v",
      "libx264",
      "-preset",
      opts.preset,
      "-crf",
      String(opts.crf),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      opts.output,
    ];
    ffProc = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "inherit", "pipe"] });
    let ffStderr = "";
    ffProc.stderr?.on("data", (d) => {
      ffStderr += d.toString();
    });
    const {
      promise: ffExitPromise,
      resolve: resolveFfExit,
      reject: rejectFfExit,
    } = Promise.withResolvers<number>();
    ffProc.on("error", rejectFfExit);
    ffProc.on("close", (code) => resolveFfExit(code ?? 1));

    // 5. Start local HTTP server with /api/render-job, /api/render-frame, /api/render-done
    const httpPort = await getFreePort();
    const marionettePort = await getFreePort();

    let framesReceived = 0;
    let renderStartAt = 0;
    const {
      promise: renderDonePromise,
      resolve: resolveRenderDone,
      reject: rejectRenderDone,
    } = Promise.withResolvers<void>();
    httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const urlObj = new URL(req.url ?? "/", `http://127.0.0.1:${httpPort}`);
      const pathname = decodeURIComponent(urlObj.pathname);

      if (pathname === "/api/render-job" && req.method === "GET") {
        const body = JSON.stringify({
          scriptText: scriptInfo.text,
          scriptLabel: scriptInfo.label,
          width: opts.width,
          height: opts.height,
          fps: opts.fps,
          startTime: opts.startTime,
          totalFrames,
          includeUi: opts.includeUi,
          useBloom: opts.useBloom,
          lipsyncDb,
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(body);
        return;
      }

      if (pathname === "/api/render-log" && req.method === "POST") {
        const buf = await readBinaryBody(req);
        try {
          const msg = JSON.parse(buf.toString("utf8"));
          if (msg.message) console.log(`[browser] ${msg.message}`);
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
      }

      if (pathname === "/api/render-frame" && req.method === "POST") {
        try {
          const jpgBytes = await readBinaryBody(req);
          if (!ffProc?.stdin || ffProc.stdin.destroyed) {
            throw new Error("ffmpeg stdin closed unexpectedly");
          }
          const canContinue = ffProc.stdin.write(jpgBytes);
          if (!canContinue) {
            const { promise: drainPromise, resolve: resolveDrain } = Promise.withResolvers<void>();
            ffProc.stdin.once("drain", resolveDrain);
            await drainPromise;
          }
          if (framesReceived === 0) renderStartAt = Date.now();
          framesReceived++;
          if (
            framesReceived === 1 ||
            framesReceived % Math.max(1, Math.floor(opts.fps)) === 0 ||
            framesReceived === totalFrames
          ) {
            const elapsedSec = Math.max(0.05, (Date.now() - renderStartAt) / 1000);
            const renderFps = framesReceived / elapsedSec;
            const pct = ((framesReceived / totalFrames) * 100).toFixed(1);
            const curT = opts.startTime + (framesReceived - 1) / opts.fps;
            process.stdout.write(
              `\r[render] Frame ${framesReceived}/${totalFrames} (${pct}%) · t=${curT.toFixed(2)}s · ${renderFps.toFixed(1)} fps   `,
            );
            if (framesReceived === totalFrames) process.stdout.write("\n");
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
          rejectRenderDone(err as Error);
        }
        return;
      }

      if (pathname === "/api/render-done" && req.method === "POST") {
        const buf = await readBinaryBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        try {
          const data = JSON.parse(buf.toString("utf8"));
          if (data.error) {
            rejectRenderDone(new Error(`Browser render error: ${data.error}`));
          } else {
            resolveRenderDone();
          }
        } catch {
          resolveRenderDone();
        }
        return;
      }

      const handled = await handleApiAndCacheRequest(req, res);
      if (handled) return;

      let fileRoute = pathname === "/" || pathname === "/story.html" ? "/index.html" : pathname;
      const normalized = "." + path.posix.normalize(fileRoute);
      for (const base of [DIST_ROOT, WEB_ROOT]) {
        const target = path.resolve(base, normalized);
        if (target !== base && !target.startsWith(base + path.sep)) continue;
        const st = statOrNull(target);
        if (st && st.isFile()) {
          const ext = path.extname(target).toLowerCase();
          res.writeHead(200, {
            "Cache-Control": ext === ".html" ? "no-cache" : STATIC_CACHE_CONTROL,
            "Content-Type": MIME_TYPES[ext] ?? DEFAULT_MIME,
            "Content-Length": st.size,
          });
          fs.createReadStream(target).pipe(res);
          return;
        }
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found\n");
    });

    const { promise: listenPromise, resolve: resolveListen } = Promise.withResolvers<void>();
    httpServer.listen(httpPort, "127.0.0.1", resolveListen);
    await listenPromise;
    // 6. Launch Headless Firefox with Marionette & Hardware WebGL2
    const profileDir = path.join(tmpDir, "fx-profile");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "user.js"),
      [
        `user_pref("marionette.port", ${marionettePort});`,
        `user_pref("webgl.force-enabled", true);`,
        `user_pref("webgl.disabled", false);`,
        `user_pref("gfx.webrender.all", true);`,
        `user_pref("media.autoplay.default", 0);`,
        `user_pref("dom.timeout.enable_budget_timer_throttling", false);`,
        `user_pref("dom.min_background_timeout_value", 0);`,
      ].join("\n"),
    );

    const fxEnv = detectHeadlessFirefoxEnv();
    fxProc = spawn(
      "firefox-esr",
      [
        "--headless",
        "--marionette",
        "--no-remote",
        "--profile",
        profileDir,
        `--window-size=${opts.width},${opts.height}`,
        "about:blank",
      ],
      { env: fxEnv, stdio: ["ignore", "ignore", "pipe"] },
    );

    fxProc.on("exit", (code) => {
      if (framesReceived < totalFrames) {
        rejectRenderDone(new Error(`Headless Firefox exited prematurely (code ${code})`));
      }
    });

    const mc = new MarionetteClient();
    await mc.connect(marionettePort);
    await mc.send("WebDriver:NewSession", { capabilities: {} });

    const pageUrl = `http://127.0.0.1:${httpPort}/?headless=1`;
    await mc.send("WebDriver:Navigate", { url: pageUrl });

    // Kick off the browser-side deterministic render loop
    await mc.send("WebDriver:ExecuteScript", {
      script: `
        (async () => {
          const log = (message) => fetch('/api/render-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
          }).catch(() => {});

          try {
            // Wait for ViewerEngine to mount and finish headless boot
            for (let i = 0; i < 600; i++) {
              if (window.viewerEngine && window.viewerEngine.renderer && !window.viewerEngine.loading) {
                break;
              }
              await new Promise((r) => setTimeout(r, 50));
            }
            const eng = window.viewerEngine;
            if (!eng || !eng.renderer) {
              throw new Error('ViewerEngine failed to initialize WebGL renderer');
            }

            // Stop interactive requestAnimationFrame loop so only our deterministic stepper runs
            if (eng._rafId) {
              cancelAnimationFrame(eng._rafId);
              eng._rafId = 0;
            }

            const gl = eng.renderer.getContext();
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            const gpuRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            await log('WebGL2 GPU: ' + gpuRenderer);

            const jobResp = await fetch('/api/render-job');
            const job = await jobResp.json();

            eng.useBloom = !!job.useBloom;
            eng.voiceCtrl.muted = true;
            if (job.lipsyncDb && job.lipsyncDb.cues) {
              eng.lipsyncDb.fps = job.lipsyncDb.fps || 60;
              Object.assign(eng.lipsyncDb.cues, job.lipsyncDb.cues);
            }

            eng.setMode('story');
            eng.setViewportSize(job.width, job.height, 1);

            await log('Loading story assets & compiling shaders for ' + job.scriptLabel + '...');
            await eng.loadStoryFromText(job.scriptText, job.scriptLabel, false);
            eng.setViewportSize(job.width, job.height, 1);

            const compositeCanvas = document.createElement('canvas');
            compositeCanvas.width = job.width;
            compositeCanvas.height = job.height;

            // Seed the independent simulation clock and reset all actors once.
            eng.seekStory(job.startTime, false);

            await log('Rendering ' + job.totalFrames + ' frames (' + job.width + 'x' + job.height + ' @ ' + job.fps + 'fps)...');

            for (let f = 0; f < job.totalFrames; f++) {
              const t = job.startTime + f / job.fps;
              eng.storyTime = t;
              eng.renderFrame(f === 0 ? 0 : 1 / job.fps);
              eng.compositeStoryFrameToCanvas(compositeCanvas, job.includeUi);

              const blob = await new Promise((resolve) =>
                compositeCanvas.toBlob(resolve, 'image/jpeg', 0.94),
              );
              const fResp = await fetch('/api/render-frame?frame=' + f, {
                method: 'POST',
                body: blob,
              });
              if (!fResp.ok) {
                throw new Error('Frame upload failed at frame ' + f + ': HTTP ' + fResp.status);
              }
            }

            await fetch('/api/render-done', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ok: true, frames: job.totalFrames }),
            });
          } catch (err) {
            await fetch('/api/render-done', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: err && err.stack ? err.stack : String(err) }),
            }).catch(() => {});
          }
        })();
      `,
      args: [],
    });

    await renderDonePromise;
    mc.close();

    // Close ffmpeg stdin and wait for muxing to finish
    ffProc.stdin?.end();
    const ffCode = await ffExitPromise;
    if (ffCode !== 0) {
      throw new Error(`ffmpeg exited with code ${ffCode}: ${ffStderr}`);
    }

    const outStat = statOrNull(opts.output);
    const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[done] Video saved to ${opts.output} (${((outStat?.size ?? 0) / (1024 * 1024)).toFixed(2)} MB) in ${totalSec}s`,
    );
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(`[error] ${err?.stack || err}`);
  process.exit(1);
});
