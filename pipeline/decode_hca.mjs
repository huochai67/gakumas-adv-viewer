/**
 * Batch CRI HCA (v1.1 - v3.0) -> 32-bit float mono PCM decoder using gakumas_core.wasm.
 * Usage: node pipeline/decode_hca.mjs <jobs.json> [meta.json]
 * where jobs.json is [{ "cue": "...", "hcaPath": "...", "pcmPath": "..." }, ...]
 */
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, "..", "web", "wasm", "gakumas_core.wasm");

const jobsPath = process.argv[2];
if (!jobsPath) {
  console.error("Usage: node pipeline/decode_hca.mjs <jobs.json> [meta.json]");
  process.exit(1);
}

const wasmBytes = fs.readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports;

function alloc(size) {
  const n = Math.max(size | 0, 1);
  const ptr = ex.wasm_alloc(n);
  if (!ptr) throw new Error(`wasm_alloc(${n}) failed`);
  return { ptr, size: n };
}

const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
const maxSamples = 48000 * 120; // up to 120s per voice line
const pcmBlock = alloc(maxSamples * 4);
const srBlock = alloc(4);
const results = {};

try {
  for (const job of jobs) {
    const hcaBytes = fs.readFileSync(job.hcaPath);
    const key = BigInt(job.keycode || 0);
    const keyLo = Number(key & 0xffffffffn) >>> 0;
    const keyHi = Number((key >> 32n) & 0xffffffffn) >>> 0;
    const srcBlock = alloc(hcaBytes.length);
    try {
      new Uint8Array(ex.memory.buffer).set(hcaBytes, srcBlock.ptr);
      const n = ex.wasm_decode_hca_mono(
        srcBlock.ptr,
        hcaBytes.length,
        keyLo,
        keyHi,
        pcmBlock.ptr,
        maxSamples,
        srBlock.ptr,
      );
      if (n < 0) {
        throw new Error(`clHCA decode failed for ${job.cue} (${job.hcaPath}): error ${n}`);
      }
      const sr = new Int32Array(ex.memory.buffer, srBlock.ptr, 1)[0] >>> 0;
      const pcmBytes = new Uint8Array(ex.memory.buffer, pcmBlock.ptr, n * 4);
      fs.writeFileSync(job.pcmPath, pcmBytes);
      results[job.cue] = { sr, samples: n };
    } finally {
      ex.wasm_free(srcBlock.ptr, srcBlock.size);
    }
  }
} finally {
  ex.wasm_free(srBlock.ptr, srBlock.size);
  ex.wasm_free(pcmBlock.ptr, pcmBlock.size);
}

if (process.argv[3]) {
  fs.writeFileSync(process.argv[3], JSON.stringify(results), "utf8");
} else {
  console.log(JSON.stringify(results));
}
