import fs from 'node:fs';
import path from 'node:path';
import type { AssetEnvironment } from '../assets.ts';
import type { UnityObject } from './serialized_file.ts';
import { decodeBc6hHalf } from './bcn_png.ts';
import { decodeProbeCubemap } from '../../web/src/runtime/bundle_loaders.js';

/** The browser and CLI preserve the same raw Unity faces and linear HDR mip chain. */
export function writeCubemap(env: AssetEnvironment, texture: UnityObject, outputDir: string): string {
  const source = texture.read(), ref = `tex/${source.m_Name}.cube.json`;
  const cube = decodeProbeCubemap(env, texture, decodeBc6hHalf);
  fs.mkdirSync(path.join(outputDir, 'tex'), { recursive: true });
  const mipmaps = cube.mipmaps.map((mip: { width: number; height: number; faces: Uint16Array[] }, level: number) => ({
    width: mip.width, height: mip.height,
    faces: mip.faces.map((data: Uint16Array, face: number) => {
      const file = `tex/${source.m_Name}.m${level}.f${face}.rgba16f`;
      fs.writeFileSync(path.join(outputDir, file), new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return file;
    }),
  }));
  fs.writeFileSync(path.join(outputDir, ref), JSON.stringify({ ...cube, mipmaps }));
  return ref;
}
