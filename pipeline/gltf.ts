/**
 * Minimal GLB (glTF 2.0 binary) writer: meshes, skins, morph targets, images.
 *
 * Port of `pipeline/gltf.py`. All geometry is written as float32 / uint32,
 * images embedded as PNG blobs inside the binary chunk, so the resulting
 * .glb is a single self-contained file.
 */
import * as fs from "node:fs";

export const COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export const FLOAT = 5126;
export const UINT = 5125;
export const USHORT = 5123;
export const UBYTE = 5121;
export const ARRAY_BUFFER = 34962;
export const ELEMENT_ARRAY_BUFFER = 34963;

function bytesOfFloats(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], true);
  return out;
}

function bytesOfUint32(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i], true);
  return out;
}

function bytesOfUint16(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint16(i * 2, values[i], true);
  return out;
}

export class Glb {
  /** Binary chunk bytes appended by `view()`. */
  bin: Uint8Array;
  private binLength = 0;
  json: Record<string, any>;

  constructor() {
    this.bin = new Uint8Array(1024);
    this.json = {
      asset: { version: "2.0", generator: "adv_viewer" },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      accessors: [],
      bufferViews: [],
      buffers: [{ byteLength: 0 }],
      textures: [],
      images: [],
      samplers: [],
      skins: [],
    };
  }

  // ---- low level ----
  private ensure(extra: number): void {
    const need = this.binLength + extra;
    if (need <= this.bin.length) return;
    let cap = this.bin.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bin.subarray(0, this.binLength));
    this.bin = next;
  }

  private append(data: Uint8Array): number {
    this.ensure(data.length);
    const off = this.binLength;
    this.bin.set(data, off);
    this.binLength += data.length;
    return off;
  }

  private appendByte(value: number): void {
    this.ensure(1);
    this.bin[this.binLength++] = value & 0xff;
  }

  private align(): void {
    while (this.binLength % 4) this.appendByte(0);
  }

  view(data: Uint8Array, target?: number | null): number {
    this.align();
    const off = this.append(data);
    const v: Record<string, any> = {
      buffer: 0,
      byteOffset: off,
      byteLength: data.length,
    };
    if (target) v.target = target;
    this.json.bufferViews.push(v);
    return this.json.bufferViews.length - 1;
  }

  accessor(
    view: number,
    componentType: number,
    count: number,
    type: string,
    minv?: ArrayLike<number> | null,
    maxv?: ArrayLike<number> | null,
    normalized?: boolean,
  ): number {
    const a: Record<string, any> = {
      bufferView: view,
      componentType,
      count,
      type,
    };
    if (minv !== undefined && minv !== null) a.min = Array.from(minv);
    if (maxv !== undefined && maxv !== null) a.max = Array.from(maxv);
    if (normalized) a.normalized = true;
    this.json.accessors.push(a);
    return this.json.accessors.length - 1;
  }

  floats(values: ArrayLike<number>, type: string): number {
    const n = COMPONENTS[type];
    const v = this.view(bytesOfFloats(values), ARRAY_BUFFER);
    return this.accessor(v, FLOAT, values.length / n, type);
  }

  uints(values: ArrayLike<number>, type: string): number {
    const n = COMPONENTS[type];
    const v = this.view(bytesOfUint32(values), ELEMENT_ARRAY_BUFFER);
    return this.accessor(v, UINT, values.length / n, type);
  }

  ushorts(values: ArrayLike<number>, type: string): number {
    const n = COMPONENTS[type];
    const v = this.view(bytesOfUint16(values), ARRAY_BUFFER);
    return this.accessor(v, USHORT, values.length / n, type);
  }

  /** Sparse accessor (used for morph targets). */
  sparse_float_accessor(
    count: number,
    type: string,
    indices: ArrayLike<number>,
    values: ArrayLike<number>,
  ): number {
    const n = COMPONENTS[type];
    const vIdx = this.view(bytesOfUint32(indices), ARRAY_BUFFER);
    // Register the index accessor like the Python version does.
    this.accessor(vIdx, UINT, indices.length, "SCALAR");
    const vVal = this.view(bytesOfFloats(values), ARRAY_BUFFER);
    this.accessor(vVal, FLOAT, values.length / n, type);
    this.json.accessors.push({
      componentType: FLOAT,
      count,
      type,
      sparse: {
        count: indices.length,
        indices: { bufferView: vIdx, componentType: UINT },
        values: { bufferView: vVal },
      },
    });
    return this.json.accessors.length - 1;
  }

  sparseFloatAccessor(
    count: number,
    type: string,
    indices: ArrayLike<number>,
    values: ArrayLike<number>,
  ): number {
    return this.sparse_float_accessor(count, type, indices, values);
  }

  // ---- high level ----
  node(
    name: string,
    trs?: ArrayLike<ArrayLike<number>> | null,
    parent?: number | null,
    mesh?: number | null,
    skin?: number | null,
    weights?: number[] | null,
  ): number {
    const n: Record<string, any> = { name };
    if (trs !== undefined && trs !== null) {
      const t = trs[0];
      const r = trs[1];
      const s = trs[2];
      if (t[0] !== 0.0 || t[1] !== 0.0 || t[2] !== 0.0) {
        n.translation = [t[0], t[1], t[2]];
      }
      if (r[0] !== 0.0 || r[1] !== 0.0 || r[2] !== 0.0 || r[3] !== 1.0) {
        n.rotation = [r[0], r[1], r[2], r[3]];
      }
      if (s[0] !== 1.0 || s[1] !== 1.0 || s[2] !== 1.0) {
        n.scale = [s[0], s[1], s[2]];
      }
    }
    if (mesh !== undefined && mesh !== null) n.mesh = mesh;
    if (skin !== undefined && skin !== null) n.skin = skin;
    if (weights !== undefined && weights !== null) n.weights = [...weights];
    const idx = this.json.nodes.length;
    this.json.nodes.push(n);
    if (parent !== undefined && parent !== null) {
      const p = this.json.nodes[parent];
      if (!p.children) p.children = [];
      p.children.push(idx);
    } else {
      this.json.scenes[0].nodes.push(idx);
    }
    return idx;
  }

  image_uri(name: string, uri: string): number {
    this.json.images.push({ name, uri });
    return this.json.images.length - 1;
  }

  imageUri(name: string, uri: string): number {
    return this.image_uri(name, uri);
  }

  image_png(name: string, png: Uint8Array): number {
    const v = this.view(png);
    this.json.images.push({ name, mimeType: "image/png", bufferView: v });
    return this.json.images.length - 1;
  }

  imagePng(name: string, png: Uint8Array): number {
    return this.image_png(name, png);
  }

  texture(image: number, sampler?: number | null): number {
    const t: Record<string, any> = { source: image };
    if (sampler !== undefined && sampler !== null) t.sampler = sampler;
    this.json.textures.push(t);
    return this.json.textures.length - 1;
  }

  sampler(wrapS = 10497, wrapT = 10497): number {
    this.json.samplers.push({
      magFilter: 9729,
      minFilter: 9987,
      wrapS,
      wrapT,
    });
    return this.json.samplers.length - 1;
  }

  material(
    name: string,
    baseColorTexture?: number | null,
    baseColor: ArrayLike<number> = [1.0, 1.0, 1.0, 1.0],
    doubleSided = true,
    alphaMode?: string | null,
  ): number {
    const pbr: Record<string, any> = {
      baseColorFactor: Array.from(baseColor),
      metallicFactor: 0.0,
      roughnessFactor: 1.0,
    };
    if (baseColorTexture !== undefined && baseColorTexture !== null) {
      pbr.baseColorTexture = { index: baseColorTexture };
    }
    const m: Record<string, any> = {
      name,
      pbrMetallicRoughness: pbr,
      doubleSided,
    };
    if (alphaMode) m.alphaMode = alphaMode;
    this.json.materials.push(m);
    return this.json.materials.length - 1;
  }

  primitive(
    attributes: Record<string, number>,
    indices: number,
    material?: number | null,
    targets?: Array<Record<string, number>> | null,
  ): Record<string, any> {
    const p: Record<string, any> = { attributes, indices, mode: 4 };
    if (material !== undefined && material !== null) p.material = material;
    if (targets && targets.length) p.targets = targets;
    return p;
  }

  mesh(name: string, primitives: Array<Record<string, any>>, weights?: number[] | null): number {
    const m: Record<string, any> = { name, primitives };
    if (weights && weights.length) m.weights = [...weights];
    this.json.meshes.push(m);
    return this.json.meshes.length - 1;
  }

  skin(
    name: string,
    joints: number[],
    ibms: ArrayLike<number>,
    skeleton?: number | null,
  ): number {
    const v = this.view(bytesOfFloats(ibms));
    const acc = this.accessor(v, FLOAT, joints.length, "MAT4");
    const s: Record<string, any> = {
      name,
      joints: [...joints],
      inverseBindMatrices: acc,
    };
    if (skeleton !== undefined && skeleton !== null) s.skeleton = skeleton;
    this.json.skins.push(s);
    return this.json.skins.length - 1;
  }

  // ---- output ----
  to_glb(): Uint8Array {
    this.align();
    this.json.buffers[0].byteLength = this.binLength;

    const rawJs = new TextEncoder().encode(JSON.stringify(this.json));
    const jsLen = (rawJs.length + 3) & ~3;
    const js = new Uint8Array(jsLen);
    js.set(rawJs);
    js.fill(0x20, rawJs.length);
    const bin = this.bin.subarray(0, this.binLength);
    const total = 12 + 8 + js.length + 8 + bin.length;

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out[0] = 0x67; // g
    out[1] = 0x6c; // l
    out[2] = 0x54; // T
    out[3] = 0x46; // F
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);

    let off = 12;
    dv.setUint32(off, js.length, true);
    out[off + 4] = 0x4a; // J
    out[off + 5] = 0x53; // S
    out[off + 6] = 0x4f; // O
    out[off + 7] = 0x4e; // N
    out.set(js, off + 8);
    off += 8 + js.length;

    dv.setUint32(off, bin.length, true);
    out[off + 4] = 0x42; // B
    out[off + 5] = 0x49; // I
    out[off + 6] = 0x4e; // N
    out[off + 7] = 0x00;
    out.set(bin, off + 8);
    return out;
  }

  toGlb(): Uint8Array {
    return this.to_glb();
  }

  save(filePath: string): void {
    fs.writeFileSync(filePath, this.to_glb());
  }
}
