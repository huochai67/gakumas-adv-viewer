/**
 * Batch native CRI HCA (v1.1 - v3.0) -> 32-bit float mono PCM decoder using vgmstream's clHCA via bun:ffi TinyCC.
 * Usage: bun pipeline/decode_hca.mjs <jobs.json>
 * where jobs.json is [{ "cue": "...", "hcaPath": "...", "pcmPath": "..." }, ...]
 */
import { cc, ptr } from "bun:ffi";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clhcaDir = join(__dirname, "clhca");
const wrapperPath = join(clhcaDir, "hca_freestanding.c");

// Build freestanding C translation unit if missing or older than clhca.c
let clhcaSrc = await Bun.file(join(clhcaDir, "clhca.c")).text();
clhcaSrc = clhcaSrc
  .replace("#include <stddef.h>", "")
  .replace("#include <stdlib.h>", "")
  .replace("#include <memory.h>", "");

const freestandingC = `
#define NULL ((void*)0)
typedef unsigned long long size_t;
static void* my_memset(void* dst, int val, size_t n) {
    unsigned char* p = (unsigned char*)dst;
    for (size_t i = 0; i < n; i++) p[i] = (unsigned char)val;
    return dst;
}
static void* my_memcpy(void* dst, const void* src, size_t n) {
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    for (size_t i = 0; i < n; i++) d[i] = s[i];
    return dst;
}
#define memset my_memset
#define memcpy my_memcpy
static unsigned char _hca_static_pool[524288];
static void* malloc(size_t n) { return n <= sizeof(_hca_static_pool) ? (void*)_hca_static_pool : NULL; }
static void free(void* p) { (void)p; }

${clhcaSrc}

int decode_hca_mono(
    const unsigned char* data,
    unsigned int size,
    unsigned long long keycode,
    float* out_pcm,
    unsigned int max_samples,
    int* out_sr
) {
    if (sizeof(clHCA) > sizeof(_hca_static_pool)) return -99;
    clHCA* hca = (clHCA*)_hca_static_pool;
    clHCA_clear(hca);
    if (keycode != 0) {
        clHCA_SetKey(hca, keycode);
    }
    int err = clHCA_DecodeHeader(hca, data, size);
    if (err < 0) return err;
    clHCA_stInfo info;
    clHCA_getInfo(hca, &info);
    if (out_sr) *out_sr = (int)info.samplingRate;
    if (info.channelCount < 1 || info.channelCount > 16) return -101;

    static float block_pcm[1024 * 16];
    static unsigned char block_buf[65536];
    if (info.blockSize > sizeof(block_buf)) return -102;

    unsigned int ch = info.channelCount;
    unsigned int pos = info.headerSize;
    unsigned int total_written = 0;
    unsigned int raw_frame_idx = 0;
    unsigned int keep_start = info.encoderDelay;
    unsigned int keep_end = info.encoderDelay + info.sampleCount;

    for (unsigned int b = 0; b < info.blockCount; b++) {
        if (pos + info.blockSize > size) break;
        my_memcpy(block_buf, data + pos, info.blockSize);
        pos += info.blockSize;
        err = clHCA_DecodeBlock(hca, block_buf, info.blockSize);
        if (err < 0) return -200 + err;
        clHCA_ReadSamples(hca, block_pcm);
        for (unsigned int s = 0; s < info.samplesPerBlock; s++) {
            if (raw_frame_idx >= keep_start && raw_frame_idx < keep_end) {
                if (total_written < max_samples) {
                    if (ch == 1) {
                        out_pcm[total_written++] = block_pcm[s];
                    } else {
                        float acc = 0.0f;
                        for (unsigned int c = 0; c < ch; c++) acc += block_pcm[s * ch + c];
                        out_pcm[total_written++] = acc / (float)ch;
                    }
                }
            }
            raw_frame_idx++;
        }
    }
    return (int)total_written;
}
`;
await Bun.write(wrapperPath, freestandingC);

const lib = cc({
  source: wrapperPath,
  include: [clhcaDir],
  symbols: {
    decode_hca_mono: {
      args: ["ptr", "u32", "u64", "ptr", "u32", "ptr"],
      returns: "i32",
    },
  },
});

const jobsPath = process.argv[2];
if (!jobsPath) {
  console.error("Usage: bun pipeline/decode_hca.mjs <jobs.json>");
  process.exit(1);
}

const jobs = await Bun.file(jobsPath).json();
const maxSamples = 48000 * 120; // up to 120s per voice line
const outPcm = new Float32Array(maxSamples);
const outSr = new Int32Array(1);
const results = {};

for (const job of jobs) {
  const hcaBytes = await Bun.file(job.hcaPath).bytes();
  const key = BigInt(job.keycode || 0);
  const n = lib.symbols.decode_hca_mono(ptr(hcaBytes), hcaBytes.length, key, ptr(outPcm), maxSamples, ptr(outSr));
  if (n < 0) {
    throw new Error(`clHCA decode failed for ${job.cue} (${job.hcaPath}): error ${n}`);
  }
  await Bun.write(job.pcmPath, outPcm.subarray(0, n));
  results[job.cue] = { sr: outSr[0], samples: n };
}

if (process.argv[3]) {
  await Bun.write(process.argv[3], JSON.stringify(results));
} else {
  console.log(JSON.stringify(results));
}
