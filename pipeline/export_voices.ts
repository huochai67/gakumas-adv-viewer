/**
 * Export ADV voice audio (.mp3) and 60Hz AIUEO formant lip-sync curves from CRI .acb resources.
 *
 * Scans ADV scripts under web/assets/*.txt (or paths passed on the CLI) for [voice voice=...]
 * cues, downloads the corresponding .acb containers from OctoManifest resourceList into
 * cache/resources/, extracts each exact HCA stream via @UTF + AFS2 tables, transcodes to
 * web/assets/voices/<cueName>.mp3, and writes 60Hz 5-vowel [a, i, u, e, o] lip-sync envelopes
 * to web/assets/voices/lipsync.json.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { type OctoManifest, download, loadManifest } from "./fetch.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, "..");
const CACHE_RES = path.join(ROOT, "cache", "resources");
const OUT_VOICES = path.join(ROOT, "web", "assets", "voices");
const LIP_FPS = 60;

/** @UTF rows are dynamic column-name -> value maps (numbers, strings, byte arrays). */
type UtfRow = Record<string, any>;

const textDecoder = new TextDecoder("utf-8");

function alignUp(v: number, a: number): number {
  return a > 1 ? Math.floor((v + a - 1) / a) * a : v;
}

function roundN(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function findBunExecutable(): string {
  if ((process.versions as { bun?: string }).bun) return process.execPath;
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  const fallback = path.join(os.homedir(), ".bun", "bin", exe);
  return fs.existsSync(fallback) ? fallback : "bun";
}

export function parseUtf(buf: Uint8Array, base = 0): UtfRow[] {
  if (
    buf[base] !== 0x40 || buf[base + 1] !== 0x55
    || buf[base + 2] !== 0x54 || buf[base + 3] !== 0x46
  ) {
    throw new Error(`Expected @UTF magic at ${base}`);
  }
  const bufDv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tableSize = bufDv.getUint32(base + 4, false);
  const t = buf.subarray(base + 8, base + 8 + tableSize);
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const rowsOff = dv.getUint16(2, false);
  const strOff = dv.getUint32(4, false);
  const dataOff = dv.getUint32(8, false);
  const ncols = dv.getUint16(16, false);
  const rowWidth = dv.getUint16(18, false);
  const nrows = dv.getUint32(20, false);

  const cstr = (off: number): string => {
    const p = strOff + off;
    let end = p;
    while (end < t.length && t[end] !== 0) end++;
    return end === -1 ? "" : textDecoder.decode(t.subarray(p, end));
  };

  const readVal = (p: number, ctype: number): [unknown, number] => {
    switch (ctype) {
      case 0:
      case 1:
        return [t[p], p + 1];
      case 2:
      case 3:
        return [dv.getUint16(p, false), p + 2];
      case 4:
      case 5:
        return [dv.getUint32(p, false), p + 4];
      case 6:
      case 7:
        return [Number(dv.getBigUint64(p, false)), p + 8];
      case 8:
        return [dv.getFloat32(p, false), p + 4];
      case 9:
        return [dv.getFloat64(p, false), p + 8];
      case 10: {
        const so = dv.getUint32(p, false);
        const s0 = strOff + so;
        let s1 = s0;
        while (s1 < t.length && t[s1] !== 0) s1++;
        return [textDecoder.decode(t.subarray(s0, s1)), p + 4];
      }
      case 11: {
        const bo = dv.getUint32(p, false);
        const bl = dv.getUint32(p + 4, false);
        return [t.subarray(dataOff + bo, dataOff + bo + bl), p + 8];
      }
      default:
        throw new Error(`Unsupported @UTF column type ${ctype}`);
    }
  };

  const cols: Array<[string, number, number, unknown]> = [];
  let pos = 24;
  for (let ci = 0; ci < ncols; ci++) {
    let flags = t[pos];
    pos += 1;
    if (flags === 0) {
      flags = dv.getUint32(pos, false);
      pos += 4;
    }
    const cname = cstr(dv.getUint32(pos, false));
    pos += 4;
    const ctype = flags & 0x0f;
    const storage = flags & 0xf0;
    let constVal: unknown = null;
    if (storage === 0x30) {
      [constVal, pos] = readVal(pos, ctype);
    }
    cols.push([cname, ctype, storage, constVal]);
  }

  const rows: UtfRow[] = [];
  for (let r = 0; r < nrows; r++) {
    let rp = rowsOff + r * rowWidth;
    const row: UtfRow = {};
    for (const [cname, ctype, storage, constVal] of cols) {
      if (storage === 0x00 || storage === 0x10) {
        row[cname] = null;
      } else if (storage === 0x30) {
        row[cname] = constVal;
      } else if (storage === 0x50) {
        const [val, next] = readVal(rp, ctype);
        row[cname] = val;
        rp = next;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Return {cueName: raw_hca_bytes} from an embedded-AWB CRI .acb container. */
export function extractAcbHcaStreams(acbBytes: Uint8Array): Map<string, Uint8Array> {
  const top = parseUtf(acbBytes, 0)[0];
  const cueNames = parseUtf(top.CueNameTable, 0);
  const cues = parseUtf(top.CueTable, 0);
  const synths = parseUtf(top.SynthTable, 0);
  const waves = parseUtf(top.WaveformTable, 0);

  let awb: Uint8Array | null = top.AwbFile ?? null;
  if (!awb || awb.length === 0) {
    let afs2Pos = -1;
    for (let i = 0; i + 3 < acbBytes.length; i++) {
      if (
        acbBytes[i] === 0x41 && acbBytes[i + 1] === 0x46
        && acbBytes[i + 2] === 0x53 && acbBytes[i + 3] === 0x32
      ) {
        afs2Pos = i;
        break;
      }
    }
    if (afs2Pos < 0) throw new Error("No embedded AFS2 (AwbFile) found in .acb");
    awb = acbBytes.subarray(afs2Pos);
  }

  const magic = String.fromCharCode(awb[0], awb[1], awb[2], awb[3]);
  const adv = new DataView(awb.buffer, awb.byteOffset, awb.byteLength);
  const offSize = adv.getUint8(5);
  const idSize = adv.getUint16(6, true);
  const count = adv.getUint32(8, true);
  const align = adv.getUint16(12, true);
  if (magic !== "AFS2") throw new Error(`Expected AFS2 header, got ${JSON.stringify(magic)}`);

  const idsPos = 16;
  const offsPos = idsPos + count * idSize;
  const readId = (p: number): number =>
    idSize === 2 ? adv.getUint16(p, true) : adv.getUint32(p, true);
  const readOff = (p: number): number =>
    offSize === 2 ? adv.getUint16(p, true) : adv.getUint32(p, true);

  const awbIds: number[] = [];
  for (let i = 0; i < count; i++) awbIds.push(readId(idsPos + i * idSize));
  const rawOffs: number[] = [];
  for (let i = 0; i <= count; i++) rawOffs.push(readOff(offsPos + i * offSize));

  const byAwbId = new Map<number, Uint8Array>();
  for (let i = 0; i < awbIds.length; i++) {
    const s = alignUp(rawOffs[i], align);
    const e = rawOffs[i + 1];
    byAwbId.set(awbIds[i], awb.subarray(s, e));
  }

  const out = new Map<string, Uint8Array>();
  for (const cn of cueNames) {
    const name: string = cn.CueName;
    const ci: number = cn.CueIndex;
    if (ci >= cues.length) continue;
    const c = cues[ci];
    const refIdx: number = c.ReferenceIndex;
    const refType: number | null = "ReferenceType" in c ? c.ReferenceType : 2;
    let widx: number;
    if ((refType === 2 || refType === 3) && refIdx < synths.length) {
      const refItems: Uint8Array = synths[refIdx].ReferenceItems ?? new Uint8Array(0);
      if (refItems.length >= 4) {
        const rdv = new DataView(refItems.buffer, refItems.byteOffset, refItems.byteLength);
        widx = rdv.getUint16(2, false);
      } else {
        continue;
      }
    } else if (refType === 1) {
      widx = refIdx;
    } else {
      continue;
    }
    if (widx >= waves.length) continue;
    const w = waves[widx];
    let awbId: number | null = w.MemoryAwbId ?? null;
    if (awbId === null) awbId = "Id" in w ? w.Id : widx;
    const data = awbId === null ? undefined : byAwbId.get(awbId);
    if (data) out.set(name, data);
  }
  return out;
}

// ---- 2048-point radix-2 Cooley-Tukey FFT (rfft magnitudes 0..1024) ----
const FFT_N = 2048;
const FFT_BITS = 11;
const FFT_HALF = FFT_N >> 1;

const BITREV = new Uint16Array(FFT_N);
for (let i = 0; i < FFT_N; i++) {
  let r = 0;
  for (let b = 0; b < FFT_BITS; b++) r |= ((i >> b) & 1) << (FFT_BITS - 1 - b);
  BITREV[i] = r;
}
const TW_COS = new Float64Array(FFT_HALF);
const TW_SIN = new Float64Array(FFT_HALF);
for (let i = 0; i < FFT_HALF; i++) {
  const ang = (-2 * Math.PI * i) / FFT_N;
  TW_COS[i] = Math.cos(ang);
  TW_SIN[i] = Math.sin(ang);
}

/** In-place complex FFT (forward, exp(-2*pi*i*k*n/N)). */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < FFT_N; i++) {
    const j = BITREV[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= FFT_N; size <<= 1) {
    const half = size >> 1;
    const step = FFT_N / size;
    for (let start = 0; start < FFT_N; start += size) {
      for (let k = 0; k < half; k++) {
        const cos = TW_COS[k * step];
        const sin = TW_SIN[k * step];
        const a = start + k;
        const b = a + half;
        const tre = re[b] * cos - im[b] * sin;
        const tim = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tre;
        im[b] = im[a] - tim;
        re[a] += tre;
        im[a] += tim;
      }
    }
  }
}

// np.hanning(2048): denominator is M - 1.
const HANN = new Float64Array(FFT_N);
for (let i = 0; i < FFT_N; i++) {
  HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
}

function percentile(arr: Float64Array, p: number): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const idx = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Compute smoothed 60Hz [a, i, u, e, o] weights (0..100) from 48kHz mono PCM. */
export function computeAiueoFrames(pcm: Float32Array, sr = 48000, fps = 60): number[][] {
  if (pcm.length < 256) return [];
  const hop = Math.floor(sr / fps); // 800 samples @ 48kHz / 60fps
  const nFft = FFT_N;
  const half = FFT_HALF;
  const freqs = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) freqs[k] = (k * sr) / nFft;

  // Pre-emphasis (matches VLActorTalkFFTBase.PreEmphasisFilter) to lift F1/F2 vowel formants
  const emph = new Float32Array(pcm.length);
  emph[0] = pcm[0];
  for (let i = 1; i < pcm.length; i++) emph[i] = pcm[i] - 0.96 * pcm[i - 1];

  // Normalize speech level per clip (98th percentile RMS) so soft/loud lines open consistently
  const nFrames = Math.max(1, Math.ceil(pcm.length / hop));
  const rmsArr = new Float64Array(nFrames);
  const bandE: Float64Array[] = [];
  for (let i = 0; i < nFrames; i++) bandE.push(new Float64Array(5));

  // Formant frequency bands (Hz) for female/alto Japanese anime voice (Mao):
  // b0: low F1 (240..480 Hz -> I, U)
  // b1: mid F1 (480..780 Hz -> E, O)
  // b2: high F1 / low F2 (780..1250 Hz -> A, O)
  // b3: mid F2 (1250..1950 Hz -> A, U, E)
  // b4: high F2 (1950..3400 Hz -> I, E)
  // b5: sibilant/unvoiced fricative guard (4200..8500 Hz -> S, T, H consonants keep mouth narrow)
  const binRange = (lo: number, hi: number): number[] => {
    const bins: number[] = [];
    for (let k = 0; k <= half; k++) if (freqs[k] >= lo && freqs[k] < hi) bins.push(k);
    return bins;
  };
  const m0 = binRange(240, 480);
  const m1 = binRange(480, 780);
  const m2 = binRange(780, 1250);
  const m3 = binRange(1250, 1950);
  const m4 = binRange(1950, 3400);
  const msib = binRange(4200, 8500);

  const pad = half;
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const mag = new Float64Array(half + 1);
  const bandMean = (bins: number[]): number => {
    let sum = 0;
    for (const k of bins) sum += mag[k];
    return sum / bins.length + 1e-6;
  };

  for (let fi = 0; fi < nFrames; fi++) {
    const c = fi * hop;
    let sumSq = 0;
    for (let i = 0; i < nFft; i++) {
      const idx = c + i - pad;
      const v = idx >= 0 && idx < pcm.length ? pcm[idx] : 0;
      sumSq += v * v;
    }
    rmsArr[fi] = Math.sqrt(sumSq / nFft + 1e-12);

    for (let i = 0; i < nFft; i++) {
      const idx = c + i - pad;
      re[i] = (idx >= 0 && idx < emph.length ? emph[idx] : 0) * HANN[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k <= half; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);

    const e0 = bandMean(m0);
    const e1 = bandMean(m1);
    const e2 = bandMean(m2);
    const e3 = bandMean(m3);
    const e4 = bandMean(m4);
    const esib = bandMean(msib);

    const voicedSum = e0 + e1 + e2 + e3 + e4;
    const sibPenalty = Math.max(0.25, 1.0 - 0.65 * Math.min(1.0, esib / (voicedSum * 0.22)));

    // Score Japanese vowels from F1/F2 spectral distribution
    const sA = (1.35 * e2 + 1.05 * e3 + 0.35 * e1) * sibPenalty;
    const sI = (1.15 * e0 + 1.55 * e4) * sibPenalty;
    const sU = 1.30 * e0 + 0.80 * e2 + 0.45 * e1 - 0.35 * e4;
    const sE = (1.15 * e1 + 1.15 * e3 + 0.85 * e4) * sibPenalty;
    const sO = (1.20 * e1 + 1.25 * e2 - 0.30 * e4) * sibPenalty;
    const scores = [Math.max(0.0, sA), Math.max(0.0, sI), Math.max(0.0, sU), Math.max(0.0, sE), Math.max(0.0, sO)];
    // Sharpen dominant vowel softly (temperature softmax / power=2.2) so mouth shapes read cleanly
    let tot = 0;
    for (let k = 0; k < 5; k++) {
      scores[k] = scores[k] ** 2.2;
      tot += scores[k];
    }
    const out = bandE[fi];
    if (tot > 1e-9) {
      for (let k = 0; k < 5; k++) out[k] = scores[k] / tot;
    } else {
      out[0] = 0.4;
      out[1] = 0.15;
      out[2] = 0.15;
      out[3] = 0.15;
      out[4] = 0.15;
    }
  }

  const refRms = Math.max(0.015, percentile(rmsArr, 95));
  const noiseFloor = refRms * 0.085;

  // Attack / release envelope smoothing (60Hz: attack ~30ms, release ~65ms)
  const outFrames: number[][] = [];
  const cur = new Float64Array(5);
  for (let fi = 0; fi < nFrames; fi++) {
    const amp = Math.max(0.0, (rmsArr[fi] - noiseFloor) / Math.max(1e-5, refRms - noiseFloor));
    // Compression curve matching anime lip dynamics (responsive to normal speech, capped at 1.0)
    let openEnv = Math.min(1.0, (amp ** 0.68) * 1.05);
    if (openEnv < 0.05) openEnv = 0.0;
    for (let k = 0; k < 5; k++) {
      const target = bandE[fi][k] * openEnv;
      const alpha = target > cur[k] ? 0.52 : 0.28;
      cur[k] += (target - cur[k]) * alpha;
    }
    const frame: number[] = [];
    for (let k = 0; k < 5; k++) {
      frame.push(Math.round(Math.min(1.0, Math.max(0.0, cur[k])) * 100));
    }
    outFrames.push(frame);
  }

  // Ensure clean mouth closure on final 2 frames
  if (outFrames.length >= 2) {
    outFrames[outFrames.length - 2] = outFrames[outFrames.length - 2].map((v) => Math.floor(v / 2));
    outFrames[outFrames.length - 1] = [0, 0, 0, 0, 0];
  }
  return outFrames;
}

export async function ensureAcb(sheetName: string, manifest: OctoManifest): Promise<string> {
  fs.mkdirSync(CACHE_RES, { recursive: true });
  const acbFile = `${sheetName}.acb`;
  const entry = (manifest.resourceList ?? []).find((r) => r.name === acbFile) ?? null;
  const dst = path.join(CACHE_RES, acbFile);
  if (fs.existsSync(dst) && (entry === null || fs.statSync(dst).size === entry.size)) return dst;
  if (entry === null) throw new Error(`${acbFile} not found in OctoManifest resourceList`);
  const url = String(manifest.urlFormat).replace("{o}", entry.objectName);
  const raw = new Uint8Array(await download(url));
  if (raw.length !== entry.size) {
    throw new Error(`Size mismatch for ${acbFile}: ${raw.length} != ${entry.size}`);
  }
  fs.writeFileSync(dst, raw);
  return dst;
}

/** Decode all CRI HCA v3.0 streams via native vgmstream clHCA (decode_hca.mjs), encode MP3s, and extract 60Hz AIUEO curves. */
export async function batchDecodeAndExport(
  cueToHca: Map<string, Uint8Array>,
  force = false,
): Promise<Record<string, Record<string, unknown>>> {
  fs.mkdirSync(OUT_VOICES, { recursive: true });
  if (cueToHca.size === 0) return {};

  const bunBin = findBunExecutable();
  const decoderMjs = path.join(MODULE_DIR, "decode_hca.mjs");
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gakumas_hca_"));

  try {
    const jobs: Array<{ cue: string; hcaPath: string; pcmPath: string }> = [];
    const sortedCues = [...cueToHca.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [cueName, hcaBytes] of sortedCues) {
      const hcaP = path.join(tmpdir, `${cueName}.hca`);
      const pcmP = path.join(tmpdir, `${cueName}.f32`);
      fs.writeFileSync(hcaP, hcaBytes);
      jobs.push({ cue: cueName, hcaPath: hcaP, pcmPath: pcmP });
    }

    const jobsJson = path.join(tmpdir, "jobs.json");
    const metaJson = path.join(tmpdir, "meta.json");
    fs.writeFileSync(jobsJson, JSON.stringify(jobs), "utf8");

    const procDec = spawnSync(bunBin, [decoderMjs, jobsJson, metaJson], { encoding: "utf8" });
    if (procDec.status !== 0) {
      throw new Error(`clHCA batch decode failed: ${procDec.stderr ?? ""}`);
    }
    const decInfo = JSON.parse(fs.readFileSync(metaJson, "utf8")) as Record<string, { sr: number }>;

    const results: Record<string, Record<string, unknown>> = {};
    for (const job of jobs) {
      const cueName = job.cue;
      const sr = Number(decInfo[cueName].sr);
      const mp3Path = path.join(OUT_VOICES, `${cueName}.mp3`);
      if (force || !fs.existsSync(mp3Path) || fs.statSync(mp3Path).size < 256) {
        const procMp3 = spawnSync("ffmpeg", [
          "-y", "-v", "error",
          "-f", "f32le", "-ar", String(sr), "-ac", "1", "-i", job.pcmPath,
          "-c:a", "libmp3lame", "-q:a", "2",
          mp3Path,
        ], { encoding: "utf8" });
        if (procMp3.status !== 0) {
          throw new Error(
            `ffmpeg mp3 encode failed on ${cueName}: ${(procMp3.stderr ?? "").slice(-300)}`,
          );
        }
      }

      const raw = fs.readFileSync(job.pcmPath);
      const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const pcm = new Float32Array(ab);
      const duration = roundN(pcm.length / sr, 4);
      const frames = computeAiueoFrames(pcm, sr, LIP_FPS);
      results[cueName] = { duration, fps: LIP_FPS, frames };
    }
    return results;
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

/** Map sheetName -> set(cueName) across ADV scripts. */
export function collectVoiceCues(scriptPaths: string[]): Map<string, Set<string>> {
  const sheets = new Map<string, Set<string>>();
  const cueRe = /\[voice\s+([^\]]+)\]/g;
  const voiceRe = /\bvoice=([^\s\]]+)/;
  for (const sp of scriptPaths) {
    const txt = fs.readFileSync(sp, "utf8");
    for (const m of txt.matchAll(cueRe)) {
      const body = m[1];
      const vm = voiceRe.exec(body);
      if (!vm) continue;
      const cue = vm[1];
      // Sheet name strips trailing _<actor>-<NNN> (e.g. _amao-001)
      const sheet = cue.replace(/_[a-z0-9]+-\d+$/, "");
      let set = sheets.get(sheet);
      if (set === undefined) {
        set = new Set();
        sheets.set(sheet, set);
      }
      set.add(cue);
    }
  }
  return sheets;
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const force = rawArgs.includes("--force");
  const args = rawArgs.filter((a) => !a.startsWith("-")).map((a) => path.resolve(a));
  const assetsDir = path.join(ROOT, "web", "assets");
  const scripts = args.length
    ? args
    : fs.readdirSync(assetsDir).filter((f) => f.endsWith(".txt")).sort()
      .map((f) => path.join(assetsDir, f));
  const sheets = collectVoiceCues(scripts);
  const manifest = await loadManifest();

  const lipsyncPath = path.join(OUT_VOICES, "lipsync.json");
  let lipsyncDb: Record<string, any> = {};
  if (fs.existsSync(lipsyncPath) && !force) {
    try {
      lipsyncDb = JSON.parse(fs.readFileSync(lipsyncPath, "utf8")) as Record<string, any>;
    } catch {
      lipsyncDb = {};
    }
  }

  const cuesMeta: Record<string, unknown> = lipsyncDb.cues ?? {};
  const pendingHca = new Map<string, Uint8Array>();
  const sheetEntries = [...sheets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [sheet, wanted] of sheetEntries) {
    const acbPath = await ensureAcb(sheet, manifest);
    const streams = extractAcbHcaStreams(fs.readFileSync(acbPath));
    console.log(`[${sheet}] ${streams.size} streams in ACB, ${wanted.size} referenced by scripts`);
    for (const cue of [...wanted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const hca = streams.get(cue);
      if (!hca) {
        console.log(`  WARN: missing cue ${cue} in ${path.basename(acbPath)}`);
        continue;
      }
      pendingHca.set(cue, hca);
    }
  }

  const exported = await batchDecodeAndExport(pendingHca, force);
  Object.assign(cuesMeta, exported);

  const outObj = { fps: LIP_FPS, cues: cuesMeta };
  fs.mkdirSync(OUT_VOICES, { recursive: true });
  fs.writeFileSync(lipsyncPath, JSON.stringify(outObj), "utf8");
  const kb = fs.statSync(lipsyncPath).size / 1024;
  console.log(
    `Exported ${Object.keys(exported).length} voice MP3s (clHCA v3.0) + 60Hz AIUEO curves -> ${lipsyncPath} (${kb.toFixed(1)} KB)`,
  );
}

if (import.meta.main) {
  await main();
}
