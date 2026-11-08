import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeProbeCubemap } from './bundle_loaders.js';

const packedUnit = ((16 << 27) | (64 << 18) | (128 << 9) | 256) >>> 0;

test('RGB9E5 cubemaps retain HDR, half subnormals and face-major mip ordering', () => {
  const words = new Uint32Array(6 * 5);
  for (let face = 0; face < 6; face++) {
    words.fill(packedUnit, face * 5, face * 5 + 4);
    words[face * 5 + 4] = face % 2 ? 1 : 0xffffffff;
  }
  const cube = decodeProbeCubemap(null, {
    m_Name: 'native-actor-reflection', m_TextureFormat: 22, m_Width: 2, m_Height: 2, m_MipCount: 2,
    m_ImageData: new Uint8Array(words.buffer),
  });
  for (let face = 0; face < 6; face++) {
    assert.deepEqual(Array.from(cube.mipmaps[0].faces[face]), [
      0x3c00, 0x3800, 0x3400, 0x3c00, 0x3c00, 0x3800, 0x3400, 0x3c00,
      0x3c00, 0x3800, 0x3400, 0x3c00, 0x3c00, 0x3800, 0x3400, 0x3c00,
    ]);
    assert.deepEqual(Array.from(cube.mipmaps[1].faces[face]), face % 2
      ? [1, 0, 0, 0x3c00] : [0x7bfc, 0x7bfc, 0x7bfc, 0x3c00]);
  }
});

test('a truncated cubemap cannot shift later faces into the preceding mip chain', () => {
  assert.throws(() => decodeProbeCubemap(null, {
    m_Name: 'truncated', m_TextureFormat: 22, m_Width: 2, m_Height: 2, m_MipCount: 2,
    m_ImageData: new Uint8Array(6 * 5 * 4 - 4),
  }), /Invalid probe mip payload/);
});
