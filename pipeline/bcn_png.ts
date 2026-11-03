/**
 * Texture decoding (RGB24 / RGBA32 / DXT1 / DXT5 / BC6H / BC7) and PNG encoding.
 *
 * Ported from the Khronos/D3D BPTC specifications; the BC6H mode layout follows
 * the reference behaviour of bcdec (MIT, Sergii Kudlai) so that every one of
 * the 14 modes decodes bit-exactly.
 *
 * No external dependencies: PNG compression uses node:zlib.
 */

import { deflateSync } from "node:zlib";

import { loadEnv } from "./assets.ts";
import type { AssetEnvironment } from "./assets.ts";

/* -------------------------------------------------------------------------- */
/* Partition / anchor / weight tables (BC6H & BC7)                            */
/* -------------------------------------------------------------------------- */

export const PART2 = [
  1347440720, 1077952576, 1414812756, 1414549568, 1346387968, 1431589968, 1431588928, 1414545408,
  1346371584, 1431655504, 1431584768, 1413480448, 1431655488, 1431633920, 1431655680, 1426063360,
  1427439872, 16468, 352387072, 4214868, 16464, 352649472, 83951616, 1079005268,
  4210768, 83951872, 336860180, 85202000, 18175040, 5592320, 352403540, 88162640,
  1145324612, 1426085120, 289673540, 84234320, 89130320, 286344260, 1091846420, 1141969220,
  352669780, 17125440, 84152400, 88428880, 339820820, 1342506320, 1094784020, 1315840,
  267524, 1070096, 273944576, 68486144, 1346438420, 1090851920, 88166420, 335888720,
  1090848020, 1095782420, 1073812820, 1410662720, 1347441920, 5591120, 353701904, 1414792196,
];

export const PART3 = [
  2858963024, 1784303680, 1515864576, 1414570152, 2779054080, 2694860880, 1431675040, 1515868240,
  2857697280, 2857719040, 2863289600, 2425393296, 2492765332, 2762253476, 2846200912, 705315408,
  2777960512, 172118100, 2779096320, 1436590240, 2829603924, 1785348160, 2762231808, 437912832,
  5285028, 2862977168, 342452500, 1768494080, 2693105056, 2860651540, 1352967248, 1784283648,
  2846195712, 1351655592, 2829094992, 606348324, 11162880, 613566756, 608801316, 1352993360,
  1342874960, 2863285316, 1717960704, 2778768800, 1352683680, 1764256040, 1152035396, 1717986816,
  2856600644, 1420317864, 2508232064, 2526451200, 2824098984, 2157286784, 2853442580, 2526412800,
  2863272980, 2689618080, 2695210400, 2516582400, 1082146944, 2846402984, 2863311428, 709513812,
];

export const ANCHOR2 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
  15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
  6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
];

export const ANCHOR3_1 = [
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3,
  3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15,
  3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
];

export const ANCHOR3_2 = [
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8,
  15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8,
  15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
];

export const W2 = [0, 21, 43, 64];
export const W3 = [0, 9, 18, 27, 37, 46, 55, 64];
export const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

/* -------------------------------------------------------------------------- */
/* PNG encoding                                                               */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk, 4, 8 + data.length));
  return chunk;
}

/** Encode RGB (3 channels) or RGBA (4 channels) rows into a PNG byte stream. */
export function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4,
): Uint8Array {
  const rowBytes = width * channels;
  const stride = rowBytes + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const dst = y * stride;
    raw[dst] = 0; // filter: None
    raw.set(pixels.subarray(y * rowBytes, y * rowBytes + rowBytes), dst + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = new Uint8Array(deflateSync(raw));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];

  let total = 0;
  for (const part of parts) total += part.length;
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/* -------------------------------------------------------------------------- */
/* Bit reader (LSB-first, as used by BC6H & BC7)                              */
/* -------------------------------------------------------------------------- */

class BitReader {
  private readonly data: Uint8Array;
  private bytePos = 0;
  private acc = 0;
  private nbits = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readBits(count: number): number {
    if (count <= 0) return 0;
    while (this.nbits < count) {
      const byte = this.bytePos < this.data.length ? this.data[this.bytePos] : 0;
      this.bytePos++;
      this.acc = (this.acc | (byte << this.nbits)) >>> 0;
      this.nbits += 8;
    }
    const mask = count === 32 ? 0xffffffff : (1 << count) - 1;
    const value = (this.acc & mask) >>> 0;
    this.acc = this.acc >>> count;
    this.nbits -= count;
    return value;
  }

  readBit(): number {
    return this.readBits(1);
  }

  /** Read `count` bits and return them with their order reversed (BC6H modes 13/14). */
  readBitsReversed(count: number): number {
    let value = this.readBits(count);
    let result = 0;
    for (let i = 0; i < count; i++) {
      result = (result << 1) | (value & 1);
      value >>>= 1;
    }
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/* Small little-endian readers tolerant of truncated input                    */
/* -------------------------------------------------------------------------- */

function getU16(data: Uint8Array, offset: number): number {
  return (data[offset] | 0) | ((data[offset + 1] | 0) << 8);
}

function getU32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] | 0) |
    ((data[offset + 1] | 0) << 8) |
    ((data[offset + 2] | 0) << 16) |
    ((data[offset + 3] | 0) << 24)
  ) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* BC1 (DXT1) / BC3 (DXT5)                                                    */
/* -------------------------------------------------------------------------- */

// Scratch buffers reused across blocks (decoding is single-threaded).
const refColors = new Uint8Array(16);
const alphaPalette = new Uint8Array(8);

function expand565(color: number, out: Uint8Array, at: number): void {
  const r5 = (color >> 11) & 0x1f;
  const g6 = (color >> 5) & 0x3f;
  const b5 = color & 0x1f;
  out[at] = (r5 << 3) | (r5 >>> 2);
  out[at + 1] = (g6 << 2) | (g6 >>> 4);
  out[at + 2] = (b5 << 3) | (b5 >>> 2);
  out[at + 3] = 255;
}

/**
 * Decode an 8-byte BC1 colour block (also the colour half of BC3).
 * `out` receives 16 RGBA pixels in block raster order.
 *
 * Matches Unity's decoder: when `c0 <= c1` the third colour is the average of
 * the endpoints and the fourth is opaque black (its alpha is overwritten by the
 * BC3 alpha block, and BC1 output is opaque).
 */
function decodeColorBlock(data: Uint8Array, offset: number, out: Uint8Array): void {
  const c0 = getU16(data, offset);
  const c1 = getU16(data, offset + 2);

  expand565(c0, refColors, 0);
  expand565(c1, refColors, 4);

  if (c0 > c1) {
    for (let ch = 0; ch < 3; ch++) {
      refColors[8 + ch] = ((2 * refColors[ch] + refColors[4 + ch]) / 3) | 0;
      refColors[12 + ch] = ((refColors[ch] + 2 * refColors[4 + ch]) / 3) | 0;
    }
    refColors[11] = 255;
    refColors[15] = 255;
  } else {
    for (let ch = 0; ch < 3; ch++) {
      refColors[8 + ch] = ((refColors[ch] + refColors[4 + ch]) / 2) | 0;
      refColors[12 + ch] = 0;
    }
    refColors[11] = 255;
    refColors[15] = 255;
  }

  const indices = getU32(data, offset + 4);
  for (let i = 0; i < 16; i++) {
    const idx = (indices >>> (i * 2)) & 3;
    const src = idx * 4;
    const dst = i * 4;
    out[dst] = refColors[src];
    out[dst + 1] = refColors[src + 1];
    out[dst + 2] = refColors[src + 2];
    out[dst + 3] = refColors[src + 3];
  }
}

/** Decode the 8-byte BC3 alpha block, writing alpha into every 4th byte of `out`. */
function decodeSmoothAlphaBlock(data: Uint8Array, offset: number, out: Uint8Array): void {
  const a0 = data[offset] | 0;
  const a1 = data[offset + 1] | 0;
  alphaPalette[0] = a0;
  alphaPalette[1] = a1;

  if (a0 > a1) {
    for (let i = 1; i <= 6; i++) {
      alphaPalette[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
    }
  } else {
    for (let i = 1; i <= 4; i++) {
      alphaPalette[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0;
    }
    alphaPalette[6] = 0;
    alphaPalette[7] = 255;
  }

  for (let i = 0; i < 16; i++) {
    const bit = i * 3;
    const byteOffset = offset + 2 + (bit >> 3);
    const bits = getU16(data, byteOffset) >>> (bit & 7);
    out[i * 4 + 3] = alphaPalette[bits & 7];
  }
}

/* -------------------------------------------------------------------------- */
/* BC6H (unsigned float16, all 14 modes)                                      */
/* -------------------------------------------------------------------------- */

// Per mode: endpoint-0 precision (W) and delta precisions (dR/dG/dB).
const BC6H_W = [10, 7, 11, 11, 11, 9, 8, 8, 8, 6, 10, 11, 12, 16];
const BC6H_DR = [5, 6, 5, 4, 4, 5, 6, 5, 5, 6, 10, 9, 8, 4];
const BC6H_DG = [5, 6, 5, 5, 4, 5, 5, 6, 5, 6, 10, 9, 8, 4];
const BC6H_DB = [5, 6, 4, 4, 5, 5, 5, 5, 6, 6, 10, 9, 8, 4];

function extendSign(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

function transformInverse(value: number, a0: number, bits: number): number {
  return (value + a0) & ((1 << bits) - 1);
}

function unquantizeUF16(value: number, bits: number): number {
  if (bits >= 15) return value;
  if (value === 0) return 0;
  if (value === (1 << bits) - 1) return 0xffff;
  return ((value << 16) + 0x8000) >> bits;
}

function interpolate(a: number, b: number, weights: number[], index: number): number {
  const w = weights[index];
  return (a * (64 - w) + b * w + 32) >>> 6;
}

function halfToFloat(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

let halfTable: Float32Array | null = null;

function halfLookup(bits: number): number {
  if (halfTable === null) {
    const table = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) table[i] = halfToFloat(i);
    halfTable = table;
  }
  return halfTable[bits];
}

/** Convert an unquantized BC6H value to an 8-bit channel. */
function bc6hToByte(value: number): number {
  const half = (value * 31) >>> 6;
  const f = halfLookup(half);
  return Math.min(255, Math.max(0, Math.trunc(f * 255.0)));
}

const BC6H_RESERVED = new Uint8Array(16 * 3);

/**
 * Decode one 16-byte BC6H (UF16) block into 16 RGB pixels (48 bytes).
 */
function decodeBc6hBlock(data: Uint8Array, out: Uint8Array): void {
  const bits = new BitReader(data);

  const r = [0, 0, 0, 0];
  const g = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];

  let mode = bits.readBits(2);
  if (mode > 1) mode |= bits.readBits(3) << 2;

  let partition = 0;
  let tableMode: number;

  switch (mode) {
    /* mode 1 */
    case 0b00: {
      g[2] |= bits.readBit() << 4;
      b[2] |= bits.readBit() << 4;
      b[3] |= bits.readBit() << 4;
      r[0] |= bits.readBits(10);
      g[0] |= bits.readBits(10);
      b[0] |= bits.readBits(10);
      r[1] |= bits.readBits(5);
      g[3] |= bits.readBit() << 4;
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(5);
      b[3] |= bits.readBit();
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(5);
      b[3] |= bits.readBit() << 1;
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(5);
      b[3] |= bits.readBit() << 2;
      r[3] |= bits.readBits(5);
      b[3] |= bits.readBit() << 3;
      partition = bits.readBits(5);
      tableMode = 0;
      break;
    }

    /* mode 2 */
    case 0b01: {
      g[2] |= bits.readBit() << 5;
      g[3] |= bits.readBit() << 4;
      g[3] |= bits.readBit() << 5;
      r[0] |= bits.readBits(7);
      b[3] |= bits.readBit();
      b[3] |= bits.readBit() << 1;
      b[2] |= bits.readBit() << 4;
      g[0] |= bits.readBits(7);
      b[2] |= bits.readBit() << 5;
      b[3] |= bits.readBit() << 2;
      g[2] |= bits.readBit() << 4;
      b[0] |= bits.readBits(7);
      b[3] |= bits.readBit() << 3;
      b[3] |= bits.readBit() << 5;
      b[3] |= bits.readBit() << 4;
      r[1] |= bits.readBits(6);
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(6);
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(6);
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(6);
      r[3] |= bits.readBits(6);
      partition = bits.readBits(5);
      tableMode = 1;
      break;
    }

    /* mode 3 */
    case 0b00010: {
      r[0] |= bits.readBits(10);
      g[0] |= bits.readBits(10);
      b[0] |= bits.readBits(10);
      r[1] |= bits.readBits(5);
      r[0] |= bits.readBit() << 10;
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(4);
      g[0] |= bits.readBit() << 10;
      b[3] |= bits.readBit();
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(4);
      b[0] |= bits.readBit() << 10;
      b[3] |= bits.readBit() << 1;
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(5);
      b[3] |= bits.readBit() << 2;
      r[3] |= bits.readBits(5);
      b[3] |= bits.readBit() << 3;
      partition = bits.readBits(5);
      tableMode = 2;
      break;
    }

    /* mode 4 */
    case 0b00110: {
      r[0] |= bits.readBits(10);
      g[0] |= bits.readBits(10);
      b[0] |= bits.readBits(10);
      r[1] |= bits.readBits(4);
      r[0] |= bits.readBit() << 10;
      g[3] |= bits.readBit() << 4;
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(5);
      g[0] |= bits.readBit() << 10;
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(4);
      b[0] |= bits.readBit() << 10;
      b[3] |= bits.readBit() << 1;
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(4);
      b[3] |= bits.readBit();
      b[3] |= bits.readBit() << 2;
      r[3] |= bits.readBits(4);
      g[2] |= bits.readBit() << 4;
      b[3] |= bits.readBit() << 3;
      partition = bits.readBits(5);
      tableMode = 3;
      break;
    }

    /* mode 5 */
    case 0b01010: {
      r[0] |= bits.readBits(10);
      g[0] |= bits.readBits(10);
      b[0] |= bits.readBits(10);
      r[1] |= bits.readBits(4);
      r[0] |= bits.readBit() << 10;
      b[2] |= bits.readBit() << 4;
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(4);
      g[0] |= bits.readBit() << 10;
      b[3] |= bits.readBit();
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(5);
      b[0] |= bits.readBit() << 10;
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(4);
      b[3] |= bits.readBit() << 1;
      b[3] |= bits.readBit() << 2;
      r[3] |= bits.readBits(4);
      b[3] |= bits.readBit() << 4;
      b[3] |= bits.readBit() << 3;
      partition = bits.readBits(5);
      tableMode = 4;
      break;
    }

    /* mode 6 */
    case 0b01110: {
      r[0] |= bits.readBits(9);
      b[2] |= bits.readBit() << 4;
      g[0] |= bits.readBits(9);
      g[2] |= bits.readBit() << 4;
      b[0] |= bits.readBits(9);
      b[3] |= bits.readBit() << 4;
      r[1] |= bits.readBits(5);
      g[3] |= bits.readBit() << 4;
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(5);
      b[3] |= bits.readBit();
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(5);
      b[3] |= bits.readBit() << 1;
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(5);
      b[3] |= bits.readBit() << 2;
      r[3] |= bits.readBits(5);
      b[3] |= bits.readBit() << 3;
      partition = bits.readBits(5);
      tableMode = 5;
      break;
    }

    /* mode 7 */
    case 0b10010: {
      r[0] |= bits.readBits(8);
      g[3] |= bits.readBit() << 4;
      b[2] |= bits.readBit() << 4;
      g[0] |= bits.readBits(8);
      b[3] |= bits.readBit() << 2;
      g[2] |= bits.readBit() << 4;
      b[0] |= bits.readBits(8);
      b[3] |= bits.readBit() << 3;
      b[3] |= bits.readBit() << 4;
      r[1] |= bits.readBits(6);
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(5);
      b[3] |= bits.readBit();
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(5);
      b[3] |= bits.readBit() << 1;
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(6);
      r[3] |= bits.readBits(6);
      partition = bits.readBits(5);
      tableMode = 6;
      break;
    }

    /* mode 8 */
    case 0b10110: {
      r[0] |= bits.readBits(8);
      b[3] |= bits.readBit();
      b[2] |= bits.readBit() << 4;
      g[0] |= bits.readBits(8);
      g[2] |= bits.readBit() << 5;
      g[2] |= bits.readBit() << 4;
      b[0] |= bits.readBits(8);
      g[3] |= bits.readBit() << 5;
      b[3] |= bits.readBit() << 4;
      r[1] |= bits.readBits(5);
      g[3] |= bits.readBit() << 4;
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(6);
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(5);
      b[3] |= bits.readBit() << 1;
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(5);
      b[3] |= bits.readBit() << 2;
      r[3] |= bits.readBits(5);
      b[3] |= bits.readBit() << 3;
      partition = bits.readBits(5);
      tableMode = 7;
      break;
    }

    /* mode 9 */
    case 0b11010: {
      r[0] |= bits.readBits(8);
      b[3] |= bits.readBit() << 1;
      b[2] |= bits.readBit() << 4;
      g[0] |= bits.readBits(8);
      b[2] |= bits.readBit() << 5;
      g[2] |= bits.readBit() << 4;
      b[0] |= bits.readBits(8);
      b[3] |= bits.readBit() << 5;
      b[3] |= bits.readBit() << 4;
      r[1] |= bits.readBits(5);
      g[3] |= bits.readBit() << 4;
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(5);
      b[3] |= bits.readBit();
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(6);
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(5);
      b[3] |= bits.readBit() << 2;
      r[3] |= bits.readBits(5);
      b[3] |= bits.readBit() << 3;
      partition = bits.readBits(5);
      tableMode = 8;
      break;
    }

    /* mode 10 */
    case 0b11110: {
      r[0] |= bits.readBits(6);
      g[3] |= bits.readBit() << 4;
      b[3] |= bits.readBit();
      b[3] |= bits.readBit() << 1;
      b[2] |= bits.readBit() << 4;
      g[0] |= bits.readBits(6);
      g[2] |= bits.readBit() << 5;
      b[2] |= bits.readBit() << 5;
      b[3] |= bits.readBit() << 2;
      g[2] |= bits.readBit() << 4;
      b[0] |= bits.readBits(6);
      g[3] |= bits.readBit() << 5;
      b[3] |= bits.readBit() << 3;
      b[3] |= bits.readBit() << 5;
      b[3] |= bits.readBit() << 4;
      r[1] |= bits.readBits(6);
      g[2] |= bits.readBits(4);
      g[1] |= bits.readBits(6);
      g[3] |= bits.readBits(4);
      b[1] |= bits.readBits(6);
      b[2] |= bits.readBits(4);
      r[2] |= bits.readBits(6);
      r[3] |= bits.readBits(6);
      partition = bits.readBits(5);
      tableMode = 9;
      break;
    }

    /* mode 11 */
    case 0b00011: {
      r[0] |= bits.readBits(10);
      g[0] |= bits.readBits(10);
      b[0] |= bits.readBits(10);
      r[1] |= bits.readBits(10);
      g[1] |= bits.readBits(10);
      b[1] |= bits.readBits(10);
      tableMode = 10;
      break;
    }

    /* mode 12 */
    case 0b00111: {
      r[0] |= bits.readBits(10);
      g[0] |= bits.readBits(10);
      b[0] |= bits.readBits(10);
      r[1] |= bits.readBits(9);
      r[0] |= bits.readBit() << 10;
      g[1] |= bits.readBits(9);
      g[0] |= bits.readBit() << 10;
      b[1] |= bits.readBits(9);
      b[0] |= bits.readBit() << 10;
      tableMode = 11;
      break;
    }

    /* mode 13 */
    case 0b01011: {
      r[0] |= bits.readBits(10);
      g[0] |= bits.readBits(10);
      b[0] |= bits.readBits(10);
      r[1] |= bits.readBits(8);
      r[0] |= bits.readBitsReversed(2) << 10;
      g[1] |= bits.readBits(8);
      g[0] |= bits.readBitsReversed(2) << 10;
      b[1] |= bits.readBits(8);
      b[0] |= bits.readBitsReversed(2) << 10;
      tableMode = 12;
      break;
    }

    /* mode 14 */
    case 0b01111: {
      r[0] |= bits.readBits(10);
      g[0] |= bits.readBits(10);
      b[0] |= bits.readBits(10);
      r[1] |= bits.readBits(4);
      r[0] |= bits.readBitsReversed(6) << 10;
      g[1] |= bits.readBits(4);
      g[0] |= bits.readBitsReversed(6) << 10;
      b[1] |= bits.readBits(4);
      b[0] |= bits.readBitsReversed(6) << 10;
      tableMode = 13;
      break;
    }

    default: {
      // Reserved modes: 10011, 10111, 11011, 11111 decode to black.
      out.set(BC6H_RESERVED);
      return;
    }
  }

  const numPartitions = tableMode >= 10 ? 0 : 1;
  const endpointCount = (numPartitions + 1) * 2;
  const wBits = BC6H_W[tableMode];

  // Delta-compressed modes (everything except 0b11110 and 0b00011): the
  // remaining endpoints are signed two's-complement deltas from endpoint 0.
  if (tableMode !== 9 && tableMode !== 10) {
    const dRBits = BC6H_DR[tableMode];
    const dGBits = BC6H_DG[tableMode];
    const dBBits = BC6H_DB[tableMode];
    for (let i = 1; i < endpointCount; i++) {
      r[i] = extendSign(r[i], dRBits);
      g[i] = extendSign(g[i], dGBits);
      b[i] = extendSign(b[i], dBBits);
    }
    for (let i = 1; i < endpointCount; i++) {
      r[i] = transformInverse(r[i], r[0], wBits);
      g[i] = transformInverse(g[i], g[0], wBits);
      b[i] = transformInverse(b[i], b[0], wBits);
    }
  }

  for (let i = 0; i < endpointCount; i++) {
    r[i] = unquantizeUF16(r[i], wBits);
    g[i] = unquantizeUF16(g[i], wBits);
    b[i] = unquantizeUF16(b[i], wBits);
  }

  const weights = tableMode >= 10 ? W4 : W3;
  const baseIndexBits = tableMode >= 10 ? 4 : 3;
  const anchor = numPartitions === 1 ? ANCHOR2[partition] : 0;
  const partPattern = numPartitions === 1 ? PART2[partition] : 0;

  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const pixel = py * 4 + px;
      let subset: number;
      let isFixUp: boolean;
      if (numPartitions === 1) {
        subset = (partPattern >>> (pixel * 2)) & 3;
        isFixUp = pixel === 0 || pixel === anchor;
      } else {
        subset = 0;
        isFixUp = pixel === 0;
      }
      const index = bits.readBits(baseIndexBits - (isFixUp ? 1 : 0));
      const ep = subset * 2;
      const dst = pixel * 3;
      out[dst] = bc6hToByte(interpolate(r[ep], r[ep + 1], weights, index));
      out[dst + 1] = bc6hToByte(interpolate(g[ep], g[ep + 1], weights, index));
      out[dst + 2] = bc6hToByte(interpolate(b[ep], b[ep + 1], weights, index));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* BC7 (all 8 modes)                                                          */
/* -------------------------------------------------------------------------- */

// [subsets, partBits, rotBits, idxModeBits, colorBits, alphaBits,
//  epPbits, spPbits, idxBits0, idxBits1]
const BC7_MODES: ReadonlyArray<readonly number[]> = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0], // mode 0
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0], // mode 1
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0], // mode 2
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0], // mode 3
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3], // mode 4
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2], // mode 5
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0], // mode 6
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0], // mode 7
];

/** Expand a `precision`-bit value to 8 bits with bit replication. */
function expandTo8(value: number, precision: number): number {
  return (value << (8 - precision)) | (value >>> (2 * precision - 8));
}

function blend(e0: number, e1: number, w: number): number {
  return (e0 * (64 - w) + e1 * w + 32) >>> 6;
}

const BC7_RESERVED = new Uint8Array(16 * 4);
const bc7Indices0 = new Uint8Array(16);
const bc7Indices1 = new Uint8Array(16);
const bc7Indices1Raw = new Uint8Array(16);

/** Decode one 16-byte BC7 block into 16 RGBA pixels (64 bytes). */
function decodeBc7Block(data: Uint8Array, out: Uint8Array): void {
  const bits = new BitReader(data);

  let mode = 0;
  while (mode < 8 && bits.readBit() === 0) mode++;
  if (mode >= 8) {
    out.set(BC7_RESERVED);
    return;
  }

  const spec = BC7_MODES[mode];
  const subsets = spec[0];
  const partBits = spec[1];
  const rotBits = spec[2];
  const idxModeBits = spec[3];
  const colorBits = spec[4];
  const alphaBits = spec[5];
  const epPbits = spec[6];
  const spPbits = spec[7];
  const idxBits0 = spec[8];
  const idxBits1 = spec[9];

  const part = bits.readBits(partBits);
  const rotation = bits.readBits(rotBits);
  const idxMode = bits.readBits(idxModeBits);

  const endpointCount = subsets * 2;
  const endpoints: number[][] = [];
  for (let i = 0; i < endpointCount; i++) endpoints.push([0, 0, 0, alphaBits > 0 ? 0 : 255]);

  for (let ch = 0; ch < 3; ch++) {
    for (let ep = 0; ep < endpointCount; ep++) endpoints[ep][ch] = bits.readBits(colorBits);
  }
  if (alphaBits > 0) {
    for (let ep = 0; ep < endpointCount; ep++) endpoints[ep][3] = bits.readBits(alphaBits);
  }

  let colorPrec = colorBits;
  let alphaPrec = alphaBits > 0 ? alphaBits : 0;

  if (epPbits) {
    for (let ep = 0; ep < endpointCount; ep++) {
      const p = bits.readBit();
      endpoints[ep][0] = (endpoints[ep][0] << 1) | p;
      endpoints[ep][1] = (endpoints[ep][1] << 1) | p;
      endpoints[ep][2] = (endpoints[ep][2] << 1) | p;
      if (alphaBits > 0) endpoints[ep][3] = (endpoints[ep][3] << 1) | p;
    }
    colorPrec += 1;
    if (alphaBits > 0) alphaPrec += 1;
  } else if (spPbits) {
    for (let s = 0; s < subsets; s++) {
      const p = bits.readBit();
      const e0 = s * 2;
      const e1 = e0 + 1;
      for (let ch = 0; ch < 3; ch++) {
        endpoints[e0][ch] = (endpoints[e0][ch] << 1) | p;
        endpoints[e1][ch] = (endpoints[e1][ch] << 1) | p;
      }
    }
    colorPrec += 1;
  }

  for (let ep = 0; ep < endpointCount; ep++) {
    for (let ch = 0; ch < 3; ch++) {
      endpoints[ep][ch] = expandTo8(endpoints[ep][ch], colorPrec);
    }
    if (alphaBits > 0) endpoints[ep][3] = expandTo8(endpoints[ep][3], alphaPrec);
  }

  const anchor1 =
    subsets >= 2 ? (subsets === 3 ? ANCHOR3_1[part] : ANCHOR2[part]) : -1;
  const anchor2 = subsets === 3 ? ANCHOR3_2[part] : -1;

  for (let i = 0; i < 16; i++) {
    const isAnchor = i === 0 || i === anchor1 || i === anchor2;
    bc7Indices0[i] = bits.readBits(idxBits0 - (isAnchor ? 1 : 0));
  }

  if (idxBits1 > 0) {
    for (let i = 0; i < 16; i++) {
      bc7Indices1Raw[i] = bits.readBits(idxBits1 - (i === 0 ? 1 : 0));
    }
  }

  const weights0 = idxBits0 === 2 ? W2 : idxBits0 === 3 ? W3 : W4;
  const weights1 = idxBits1 === 2 ? W2 : W3;

  for (let i = 0; i < 16; i++) {
    const subset =
      subsets === 1
        ? 0
        : subsets === 2
          ? (PART2[part] >>> (i * 2)) & 3
          : (PART3[part] >>> (i * 2)) & 3;
    const e0 = endpoints[subset * 2];
    const e1 = endpoints[subset * 2 + 1];

    let colorIndex = bc7Indices0[i];
    let alphaIndex = bc7Indices0[i];
    let colorWeights = weights0;
    let alphaWeights = weights0;

    if (idxBits1 > 0) {
      if (idxMode === 0) {
        colorWeights = weights0;
        colorIndex = bc7Indices0[i];
        alphaWeights = weights1;
        alphaIndex = bc7Indices1Raw[i];
      } else {
        colorWeights = weights1;
        colorIndex = bc7Indices1Raw[i];
        alphaWeights = weights0;
        alphaIndex = bc7Indices0[i];
      }
    }

    const cw = colorWeights[colorIndex];
    const aw = alphaWeights[alphaIndex];

    let r = blend(e0[0], e1[0], cw);
    let g = blend(e0[1], e1[1], cw);
    let b = blend(e0[2], e1[2], cw);
    let a = blend(e0[3], e1[3], aw);

    if (rotation === 1) {
      const t = a;
      a = r;
      r = t;
    } else if (rotation === 2) {
      const t = a;
      a = g;
      g = t;
    } else if (rotation === 3) {
      const t = a;
      a = b;
      b = t;
    }

    const dst = i * 4;
    out[dst] = r;
    out[dst + 1] = g;
    out[dst + 2] = b;
    out[dst + 3] = a;
  }
}

/* -------------------------------------------------------------------------- */
/* Texture decoding entry point                                               */
/* -------------------------------------------------------------------------- */

/** Unity `TextureFormat` values handled by this module. */
const FMT_RGB24 = 3;
const FMT_RGBA32 = 4;
const FMT_DXT1 = 10;
const FMT_DXT5 = 12;
const FMT_BC6H = 24;
const FMT_BC7 = 25;

const BLOCK_PIXELS = 16;

/**
 * Decode raw `Texture2D` bytes into tightly packed RGB/RGBA rows.
 *
 * Block-compressed formats are padded up to whole 4x4 blocks when decoding and
 * then cropped back to `width x height`. `flip` (default `true`) mirrors rows
 * vertically so Unity's bottom-up data becomes top-down (PNG) order.
 */
export function decodeTexture2D(
  imageData: Uint8Array,
  width: number,
  height: number,
  textureFormat: number,
  flip = true,
): { data: Uint8Array; width: number; height: number; channels: 3 | 4 } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`decodeTexture2D: invalid size ${width}x${height}`);
  }

  if (textureFormat === FMT_RGB24 || textureFormat === FMT_RGBA32) {
    const channels: 3 | 4 = textureFormat === FMT_RGBA32 ? 4 : 3;
    const rowBytes = width * channels;
    const data = new Uint8Array(rowBytes * height);
    for (let srcY = 0; srcY < height; srcY++) {
      const dstY = flip ? height - 1 - srcY : srcY;
      const src = srcY * rowBytes;
      const dst = dstY * rowBytes;
      data.set(imageData.subarray(src, src + rowBytes), dst);
    }
    return { data, width, height, channels };
  }

  let channels: 3 | 4;
  let blockBytes: number;
  switch (textureFormat) {
    case FMT_DXT1:
      channels = 4;
      blockBytes = 8;
      break;
    case FMT_DXT5:
      channels = 4;
      blockBytes = 16;
      break;
    case FMT_BC6H:
      channels = 3;
      blockBytes = 16;
      break;
    case FMT_BC7:
      channels = 4;
      blockBytes = 16;
      break;
    default:
      throw new Error(`decodeTexture2D: unsupported texture format ${textureFormat}`);
  }

  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const data = new Uint8Array(width * height * channels);
  const block = new Uint8Array(blockBytes);
  const pixels = new Uint8Array(BLOCK_PIXELS * channels);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const offset = (by * blocksX + bx) * blockBytes;
      const end = Math.min(offset + blockBytes, imageData.length);
      block.fill(0);
      if (offset < end) block.set(imageData.subarray(offset, end));

      switch (textureFormat) {
        case FMT_DXT1:
          decodeColorBlock(block, 0, pixels);
          break;
        case FMT_DXT5:
          decodeColorBlock(block, 8, pixels);
          decodeSmoothAlphaBlock(block, 0, pixels);
          break;
        case FMT_BC6H:
          decodeBc6hBlock(block, pixels);
          break;
        case FMT_BC7:
          decodeBc7Block(block, pixels);
          break;
      }

      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) break;
        const dstY = flip ? height - 1 - y : y;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) continue;
          const src = (py * 4 + px) * channels;
          const dst = (dstY * width + x) * channels;
          data[dst] = pixels[src];
          data[dst + 1] = pixels[src + 1];
          data[dst + 2] = pixels[src + 2];
          if (channels === 4) data[dst + 3] = pixels[src + 3];
        }
      }
    }
  }

  return { data, width, height, channels };
}

/* -------------------------------------------------------------------------- */
/* Texture2D objects -> PNG                                                   */
/* -------------------------------------------------------------------------- */

type UnknownRecord = Record<string, unknown>;
type GetResourceDataArgs = Parameters<AssetEnvironment["getResourceData"]>;

/** Unity typetree fields consumed from a `Texture2D`. */
interface TextureTypetree {
  m_Name?: string;
  m_Width?: number;
  m_Height?: number;
  m_TextureFormat?: number;
  "image data"?: unknown;
  m_StreamData?: GetResourceDataArgs[1];
  assetsFile?: unknown;
  _assetsFile?: unknown;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : null;
}

/** Runtime marker for an `AssetEnvironment` (textures and envs may arrive swapped). */
function isEnvironment(value: unknown): value is AssetEnvironment {
  const record = asRecord(value);
  return (
    record !== null &&
    (typeof record.getResourceData === "function" || record.bundles instanceof Map)
  );
}

/** Accept `(env, tex)`, `(tex, env)` and `(tex)` call styles. */
function textureArguments(
  first: unknown,
  second?: unknown,
): { env?: AssetEnvironment; tex: unknown } {
  if (second === undefined) return { tex: first };
  if (isEnvironment(first)) return { env: first, tex: second };
  if (isEnvironment(second)) return { env: second, tex: first };
  return { tex: second };
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

/**
 * Decode a Unity `Texture2D` (either a `UnityObject` or its already-read
 * typetree) into PNG bytes plus its nominal dimensions.
 */
export function textureInfo(
  texOrEnv: unknown,
  maybeTex?: unknown,
): { png: Uint8Array; width: number; height: number } {
  const { env: providedEnv, tex } = textureArguments(texOrEnv, maybeTex);
  const texRecord = asRecord(tex);
  if (!texRecord) throw new Error("textureInfo: no texture given");

  const read = texRecord.read;
  const tt = (typeof read === "function" ? read.call(tex) : tex) as TextureTypetree;
  const label = tt.m_Name ?? "<unnamed>";

  const width = Number(tt.m_Width);
  const height = Number(tt.m_Height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`textureInfo: ${label} has invalid size ${tt.m_Width}x${tt.m_Height}`);
  }

  let imageData = toUint8Array(tt["image data"]);

  const streamData = tt.m_StreamData;
  if ((!imageData || imageData.byteLength === 0) && streamData && streamData.path) {
    const env = providedEnv ?? loadEnv();
    const serializedFile = (texRecord.assetsFile ??
      texRecord._assetsFile ??
      tt._assetsFile ??
      tt.assetsFile) as GetResourceDataArgs[0] | undefined;
    if (!serializedFile) {
      throw new Error(`textureInfo: ${label} has stream data but no assets file`);
    }
    imageData = toUint8Array(env.getResourceData(serializedFile, streamData));
  }

  if (!imageData || imageData.byteLength === 0) {
    throw new Error(`textureInfo: ${label} has no image data`);
  }

  const decoded = decodeTexture2D(imageData, width, height, Number(tt.m_TextureFormat) | 0, true);
  const png = encodePng(decoded.data, decoded.width, decoded.height, decoded.channels);
  return { png, width, height };
}

/** Decode a Unity `Texture2D` to PNG bytes. */
export function texturePng(texOrEnv: unknown, maybeTex?: unknown): Uint8Array {
  return textureInfo(texOrEnv, maybeTex).png;
}
