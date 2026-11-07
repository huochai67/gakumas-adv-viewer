import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decodeBc6hHalf as decodeJs } from './bcn_png.ts';
import { initWasm, decodeBc6hHalf as decodeWasm } from '../../web/src/runtime/wasm_bridge.js';

await initWasm(`data:application/wasm;base64,${(await readFile(new URL('../../web/wasm/gakumas_core.wasm', import.meta.url))).toString('base64')}`);
// BC6H unsigned mode 11: explicit ten-bit endpoints, all texel indices zero.
// RGB endpoints (512,0,1023) finish-unquantize to half bits (0x3e0f,0,0x7bff):
// values >1 and the maximum finite half must survive without RGBA8 clipping.
let bits = 3n;
let offset = 5n;
for (const endpoint of [512, 0, 1023, 512, 0, 1023]) {
  bits |= BigInt(endpoint) << offset;
  offset += 10n;
}
const block = Uint8Array.from({ length: 16 }, (_, i) => Number((bits >> BigInt(i * 8)) & 255n));
const pixel = [0x3e0f, 0, 0x7bff, 0x3c00];

for (const [name, decode] of [['CLI', decodeJs], ['WASM', decodeWasm]]) {
  test(`${name} BC6H preserves HDR endpoints and clips only the partial-block footprint`, () => {
    assert.deepEqual(Array.from(decode(block, 4, 4)), Array.from({ length: 16 }, () => pixel).flat());
    assert.deepEqual(Array.from(decode(block, 1, 2)), [...pixel, ...pixel]);
    assert.throws(() => decode(block.subarray(0, 15), 4, 4), /truncated|failed/i);
    assert.deepEqual(Array.from(decode(block, 1, 1)), pixel);
  });
}
