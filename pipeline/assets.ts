/**
 * Unity asset helpers for the gakumas bundles: bundle loading, PPtr resolution
 * across bundles, skeletons, meshes and textures.
 *
 * TypeScript port of `pipeline/assets.py` (no UnityPy, no DummyDll).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { texturePng } from "./core/bcn_png.ts";
import { decrypt } from "./core/masked_bundle.ts";
import { SerializedFile, UnityObject } from "./core/serialized_file.ts";
import { readUnityFS } from "./core/unity_fs.ts";

export { texturePng };

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, "..");
const BUNDLES = path.join(ROOT, "cache", "bundles");

export interface BundleContainer {
  name: string;
  files: Map<string, SerializedFile | Uint8Array>;
  serializedFiles: SerializedFile[];
}

export interface SkeletonNode {
  path_id: bigint;
  go: bigint;
  name: string;
  active: boolean;
  transform: Record<string, any>;
  assetsFile: SerializedFile;
  parent: SkeletonNode | null;
  children: SkeletonNode[];
}

function toBytes(value: unknown): Uint8Array {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

export class AssetEnvironment {
  bundles = new Map<string, BundleContainer>();
  cabs = new Map<string, SerializedFile | Uint8Array>();

  bundleFile(name: string): BundleContainer {
    const direct = this.bundles.get(name) ?? this.bundles.get(name + ".bundle");
    if (direct) return direct;
    const wanted = name.endsWith(".bundle") ? name.slice(0, -7) : name;
    for (const [key, container] of this.bundles) {
      const stem = key.endsWith(".bundle") ? key.slice(0, -7) : key;
      if (stem === wanted) return container;
    }
    throw new Error(`bundle not loaded: ${name}`);
  }

  objectsOf(container: BundleContainer | SerializedFile, typeName: string): UnityObject[] {
    if (container instanceof SerializedFile) {
      return [...container.objects.values()].filter((o) => o.typeName === typeName);
    }
    const out: UnityObject[] = [];
    for (const sf of container.serializedFiles) {
      for (const o of sf.objects.values()) {
        if (o.typeName === typeName) out.push(o);
      }
    }
    return out;
  }

  named(
    container: BundleContainer | SerializedFile,
    typeName: string,
    name: string,
  ): Record<string, any> {
    for (const o of this.objectsOf(container, typeName)) {
      try {
        const obj = o.read();
        if (obj.m_Name === name) return obj;
      } catch {
        // ignore malformed objects, like the reference implementation
      }
    }
    throw new Error(name);
  }

  resolvePPtr(
    sf: SerializedFile,
    pptr: { m_FileID: number; m_PathID: bigint | number } | null | undefined,
  ): UnityObject | null {
    if (!pptr || pptr.m_PathID === undefined || pptr.m_PathID === null) return null;
    const pid = BigInt(pptr.m_PathID);
    if (pid === 0n) return null;
    if (!pptr.m_FileID || pptr.m_FileID === 0) {
      return sf.objects.get(pid) ?? null;
    }
    const ext = sf.externals[pptr.m_FileID - 1];
    if (!ext) return null;
    const cabName = ext.path.split("/").pop()!.toLowerCase();
    const target = this.cabs.get(cabName);
    return target instanceof SerializedFile ? (target.objects.get(pid) ?? null) : null;
  }

  readPPtr(
    sf: SerializedFile,
    pptr: { m_FileID: number; m_PathID: bigint | number } | null | undefined,
  ): Record<string, any> | null {
    const obj = this.resolvePPtr(sf, pptr);
    return obj ? obj.read() : null;
  }

  getResourceData(
    sf: SerializedFile,
    streamData: { offset: bigint | number; size: number; path: string },
  ): Uint8Array {
    const size = Number(streamData?.size || 0);
    if (!streamData?.path || size <= 0) return new Uint8Array(0);
    const base = streamData.path.split("/").pop()!;
    const stem = base.replace(/\.[^.]+$/, "");
    const candidates = [base, `${stem}.resource`, `${stem}.assets.resS`, `${stem}.resS`];
    for (const candidate of candidates) {
      const buf = this.cabs.get(candidate.toLowerCase());
      if (buf instanceof Uint8Array) {
        const offset = Number(streamData.offset);
        return buf.subarray(offset, offset + size);
      }
    }
    return new Uint8Array(0);
  }
}

let _env: AssetEnvironment | null = null;

/** Load every bundle into one environment (cached). */
export function loadEnv(): AssetEnvironment {
  if (_env !== null) return _env;
  const env = new AssetEnvironment();
  const entries = fs
    .readdirSync(BUNDLES)
    .filter((name) => name.endsWith(".bundle"))
    .sort();
  for (const fileName of entries) {
    const bundleName = path.basename(fileName, ".bundle");
    const raw = new Uint8Array(fs.readFileSync(path.join(BUNDLES, fileName)));
    const decrypted = decrypt(raw, bundleName);
    const unpacked = readUnityFS(decrypted);

    const container: BundleContainer = {
      name: bundleName,
      files: new Map(),
      serializedFiles: [],
    };
    for (const [entryName, entryBytes] of unpacked) {
      let value: SerializedFile | Uint8Array;
      if (
        !entryName.endsWith(".resS") &&
        !entryName.endsWith(".resource") &&
        !entryName.endsWith(".config") &&
        !entryName.endsWith(".xml") &&
        !entryName.endsWith(".dat")
      ) {
        const sf = new SerializedFile(entryName, entryBytes);
        container.serializedFiles.push(sf);
        value = sf;
      } else {
        value = entryBytes;
      }
      container.files.set(entryName, value);
      env.cabs.set(entryName, value);
      env.cabs.set(entryName.toLowerCase(), value);
    }

    env.bundles.set(bundleName, container);
    env.bundles.set(bundleName + ".bundle", container);
  }
  _env = env;
  return env;
}

export const load_env = loadEnv;

export function bundleFile(name: string): BundleContainer {
  return loadEnv().bundleFile(name);
}

export const bundle_file = bundleFile;

export function objectsOf(
  container: BundleContainer | SerializedFile,
  typeName: string,
): UnityObject[] {
  return loadEnv().objectsOf(container, typeName);
}

export const objects_of = objectsOf;

export function named(
  container: BundleContainer | SerializedFile,
  typeName: string,
  name: string,
): Record<string, any> {
  return loadEnv().named(container, typeName, name);
}

/**
 * Walk a Unity transform tree. `root` may be a `UnityObject` wrapper or the
 * plain typetree record returned by `UnityObject.read()` (which carries the
 * non-enumerable `_assetsFile` / `_pathId` back-references).
 */
export function skeleton(
  root: UnityObject | Record<string, any>,
  env?: AssetEnvironment,
): [SkeletonNode, Map<bigint, SkeletonNode>] {
  const assets = env ?? loadEnv();
  const table = new Map<bigint, SkeletonNode>();
  const goCache = new Map<string, { name: string; active: boolean }>();

  const goInfo = (sf: SerializedFile, pptr: Record<string, any>) => {
    const key = `${Number(pptr?.m_FileID ?? 0)}:${String(pptr?.m_PathID ?? 0)}`;
    const cached = goCache.get(key);
    if (cached) return cached;
    const goObj = assets.resolvePPtr(sf, pptr);
    let info: { name: string; active: boolean };
    if (!goObj) {
      info = { name: "", active: true };
    } else {
      const g = goObj.read();
      info = {
        name: g.m_Name,
        active: g.m_IsActive === undefined ? true : !!g.m_IsActive,
      };
    }
    goCache.set(key, info);
    return info;
  };

  const build = (
    nodeOrObject: UnityObject | Record<string, any>,
    parent: SkeletonNode | null,
  ): SkeletonNode => {
    let sf: SerializedFile;
    let pid: bigint;
    let transform: Record<string, any>;
    if (nodeOrObject instanceof UnityObject) {
      sf = nodeOrObject.assetsFile;
      pid = nodeOrObject.pathId;
      transform = nodeOrObject.read();
    } else {
      transform = nodeOrObject;
      const meta = nodeOrObject as { _assetsFile?: SerializedFile; _pathId?: bigint | number };
      sf = meta._assetsFile;
      const rawPid = meta._pathId;
      pid = rawPid === undefined || rawPid === null ? 0n : BigInt(rawPid);
      if (!sf) throw new Error("skeleton: typetree record has no _assetsFile");
    }
    const goPtr = transform.m_GameObject;
    const info = goInfo(sf, goPtr);
    const node: SkeletonNode = {
      path_id: pid,
      go: goPtr && goPtr.m_PathID !== undefined && goPtr.m_PathID !== null
        ? BigInt(goPtr.m_PathID)
        : 0n,
      name: info.name,
      active: info.active,
      transform,
      assetsFile: sf,
      parent,
      children: [],
    };
    table.set(pid, node);
    for (const childPtr of transform.m_Children ?? []) {
      const childObj = assets.resolvePPtr(sf, childPtr);
      if (childObj) node.children.push(build(childObj, node));
    }
    return node;
  };

  return [build(root, null), table];
}

export function localTrs(
  t: Record<string, any>,
): [[number, number, number], [number, number, number, number], [number, number, number]] {
  const p = t.m_LocalPosition ?? {};
  const q = t.m_LocalRotation ?? {};
  const s = t.m_LocalScale ?? {};
  return [
    [Number(p.x ?? 0), Number(p.y ?? 0), Number(p.z ?? 0)],
    [Number(q.x ?? 0), Number(q.y ?? 0), Number(q.z ?? 0), Number(q.w ?? 1)],
    [Number(s.x ?? 1), Number(s.y ?? 1), Number(s.z ?? 1)],
  ];
}

export const local_trs = localTrs;

// ---- mesh decoding (Unity 2019+ vertex layouts) ----

interface VertexStream {
  offset: number;
  stride: number;
}

const COMPONENT_BYTES: Record<number, number> = {
  0: 4, // Float32
  1: 2, // Float16
  2: 1, // UNorm8
  3: 1, // SNorm8
  4: 2, // UNorm16
  5: 2, // SNorm16
  6: 1, // UInt8
  7: 1, // SInt8
  8: 2, // UInt16
  9: 2, // SInt16
  10: 4, // UInt32
  11: 4, // SInt32
};

function componentSize(format: number): number {
  const size = COMPONENT_BYTES[format];
  if (size === undefined) throw new Error(`unknown vertex format ${format}`);
  return size;
}

function componentReader(format: number): (dv: DataView, offset: number) => number {
  switch (format) {
    case 0:
      return (dv, o) => dv.getFloat32(o, true);
    case 1:
      return (dv, o) => halfToFloat(dv.getUint16(o, true));
    case 2:
      return (dv, o) => dv.getUint8(o);
    case 3:
      return (dv, o) => dv.getInt8(o);
    case 4:
      return (dv, o) => dv.getUint16(o, true);
    case 5:
      return (dv, o) => dv.getInt16(o, true);
    case 6:
      return (dv, o) => dv.getUint8(o);
    case 7:
      return (dv, o) => dv.getInt8(o);
    case 8:
      return (dv, o) => dv.getUint16(o, true);
    case 9:
      return (dv, o) => dv.getInt16(o, true);
    case 10:
      return (dv, o) => dv.getUint32(o, true);
    case 11:
      return (dv, o) => dv.getInt32(o, true);
    default:
      throw new Error(`unknown vertex format ${format}`);
  }
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >>> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function buildStreams(channels: Array<Record<string, any>>, vertexCount: number): VertexStream[] {
  let streamCount = 1;
  for (const ch of channels) {
    streamCount = Math.max(streamCount, Number(ch.stream ?? 0) + 1);
  }
  const streams: VertexStream[] = [];
  let offset = 0;
  for (let s = 0; s < streamCount; s++) {
    let stride = 0;
    for (let chn = 0; chn < channels.length; chn++) {
      const ch = channels[chn];
      if (Number(ch.stream ?? 0) !== s) continue;
      const dimension = Number(ch.dimension ?? 0);
      if (dimension > 0) {
        stride += (dimension & 0xf) * componentSize(Number(ch.format ?? 0));
      }
    }
    streams.push({ offset, stride });
    offset += vertexCount * stride;
    offset = Math.ceil(offset / 16) * 16;
  }
  return streams;
}

function takePad(values: number[], count: number): number[] {
  const out = values.slice(0, count);
  while (out.length < count) out.push(0);
  return out;
}

function decodeIndices(raw: Uint8Array, use16: boolean): Uint32Array {
  if (use16) {
    const count = raw.length >>> 1;
    const out = new Uint32Array(count);
    const dv = new DataView(raw.buffer, raw.byteOffset, count * 2);
    for (let i = 0; i < count; i++) out[i] = dv.getUint16(i * 2, true);
    return out;
  }
  const count = raw.length >>> 2;
  const out = new Uint32Array(count);
  const dv = new DataView(raw.buffer, raw.byteOffset, count * 4);
  for (let i = 0; i < count; i++) out[i] = dv.getUint32(i * 4, true);
  return out;
}

function getTriangles(
  indices: Uint32Array | null,
  submeshes: Array<Record<string, any>>,
  use16: boolean,
): Array<Array<[number, number, number]>> {
  if (indices === null) {
    if (submeshes.some((s) => Number(s.indexCount ?? 0) > 0)) {
      throw new Error("failed getting triangles: submeshes have indices but the mesh has none");
    }
    return submeshes.map(() => []);
  }

  return submeshes.map((sub) => {
    let firstIndex = Math.floor(Number(sub.firstByte ?? 0) / 2);
    if (!use16) firstIndex = Math.floor(firstIndex / 2);
    const indexCount = Number(sub.indexCount ?? 0);
    const topology = Number(sub.topology ?? 0);
    const triangles: Array<[number, number, number]> = [];

    if (topology === 0) {
      for (let i = firstIndex; i + 2 < firstIndex + indexCount; i += 3) {
        triangles.push([indices[i], indices[i + 1], indices[i + 2]]);
      }
    } else if (topology === 1) {
      // UnityPy MeshTopology.TriangleStrip (deprecated)
      for (let i = firstIndex; i < firstIndex + indexCount - 2; i++) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        if (a === b || a === c || b === c) continue;
        // winding flip-flop of strips
        if ((i - firstIndex) & 1) triangles.push([b, a, c]);
        else triangles.push([a, b, c]);
      }
    } else if (topology === 2) {
      // UnityPy MeshTopology.Quads: one quad is two triangles
      for (let i = firstIndex; i < firstIndex + indexCount; i += 4) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        const d = indices[i + 3];
        triangles.push([a, b, c]);
        triangles.push([a, c, d]);
      }
    } else {
      throw new Error("failed getting triangles: submesh topology is lines or points");
    }
    return triangles;
  });
}

export function meshData(
  meshObj: UnityObject | Record<string, any>,
  env?: AssetEnvironment,
): Record<string, any> {
  const assets = env ?? loadEnv();
  let sf: SerializedFile;
  let mesh: Record<string, any>;
  if (meshObj instanceof UnityObject) {
    sf = meshObj.assetsFile;
    mesh = meshObj.read();
  } else {
    mesh = meshObj;
    const meta = meshObj as { _assetsFile?: SerializedFile };
    sf = meta._assetsFile;
  }

  const vd = mesh.m_VertexData ?? {};
  const channels = (vd.m_Channels ?? []) as Array<Record<string, any>>;
  const vertexCount = Number(vd.m_VertexCount ?? 0);
  const streams = buildStreams(channels, vertexCount);

  let vertexBytes = toBytes(vd.m_DataSize);
  const streamData = mesh.m_StreamData;
  if (vertexBytes.length === 0 && streamData && streamData.path) {
    vertexBytes = assets.getResourceData(sf, streamData);
  }
  const dv = new DataView(vertexBytes.buffer, vertexBytes.byteOffset, vertexBytes.byteLength);

  let vertices: number[][] = [];
  let normals: number[][] = [];
  let tangents: number[][] = [];
  let colors: number[][] = [];
  let uv0: number[][] = [];
  let uv1: number[][] = [];
  let boneWeights: number[][] = [];
  let boneIndices: number[][] = [];

  if (vertexBytes.length > 0 && vertexCount > 0) {
    for (let chn = 0; chn < channels.length; chn++) {
      const channel = channels[chn];
      const dimension = Number(channel.dimension ?? 0);
      if (dimension === 0) continue;
      if (![0, 1, 2, 3, 4, 5, 12, 13].includes(chn)) continue;

      const stream = streams[Number(channel.stream ?? 0)];
      if (!stream || stream.stride === 0) continue;
      const dim = dimension & 0xf;
      const format = Number(channel.format ?? 0);
      const size = componentSize(format);
      const read = componentReader(format);
      const channelOffset = stream.offset + Number(channel.offset ?? 0);
      const rows: number[][] = [];
      for (let v = 0; v < vertexCount; v++) {
        const base = channelOffset + v * stream.stride;
        const values: number[] = [];
        for (let c = 0; c < dim; c++) values.push(read(dv, base + c * size));
        rows.push(values);
      }
      if (chn === 0) vertices = rows.map((r) => takePad(r, 3));
      else if (chn === 1) normals = rows.map((r) => takePad(r, 3));
      else if (chn === 2) tangents = rows.map((r) => takePad(r, 4));
      else if (chn === 3) colors = rows.map((r) => takePad(r, 4));
      else if (chn === 4) uv0 = rows.map((r) => takePad(r, 2));
      else if (chn === 5) uv1 = rows.map((r) => takePad(r, 2));
      else if (chn === 12) boneWeights = rows.map((r) => takePad(r, 4));
      else if (chn === 13) boneIndices = rows.map((r) => takePad(r, 4));
    }
  }

  // Legacy skin data (pre-2018 meshes / meshes that keep m_Skin around).
  if ((boneWeights.length === 0 || boneIndices.length === 0) && Array.isArray(mesh.m_Skin)) {
    const skin = mesh.m_Skin as Array<Record<string, any>>;
    if (skin.length) {
      const pick = (row: Record<string, any>, base: string) => {
        const out: number[] = [];
        for (let i = 0; i < 4; i++) {
          out.push(Number(row[`${base}_${i}_`] ?? row[`${base}_${i}`] ?? 0));
        }
        return out;
      };
      boneIndices = skin.map((s) => pick(s, "boneIndex"));
      boneWeights = skin.map((s) => pick(s, "weight"));
    }
  }

  const rawIndex = toBytes(mesh.m_IndexBuffer);
  const use16 =
    mesh.m_Use16BitIndices !== undefined && mesh.m_Use16BitIndices !== null
      ? !!mesh.m_Use16BitIndices
      : Number(mesh.m_IndexFormat ?? 0) === 0;
  const indices = rawIndex.length > 0 ? decodeIndices(rawIndex, use16) : null;
  const submeshes = (mesh.m_SubMeshes ?? []) as Array<Record<string, any>>;
  const perSub = getTriangles(indices, submeshes, use16);

  const triangles: Array<[number, number, number]> = [];
  const subs: Array<[number, number, number]> = [];
  for (let si = 0; si < perSub.length; si++) {
    const sub = submeshes[si];
    const base = Number(sub.baseVertex || 0);
    const start = triangles.length;
    const list = perSub[si];
    for (const t of list) triangles.push([t[0] + base, t[1] + base, t[2] + base]);
    subs.push([start, list.length, Number(sub.topology ?? 0)]);
  }

  return {
    name: mesh.m_Name,
    vertices,
    normals,
    tangents,
    uv0,
    uv1,
    colors,
    triangles,
    submeshes: subs,
    index_format: mesh.m_IndexFormat,
    n_indices: triangles.length * 3,
    bones: boneIndices,
    weights: boneWeights,
    blendshape_names: Array.isArray(mesh.m_Shapes?.shapes)
      ? mesh.m_Shapes.shapes.map((s: Record<string, any>) => s.name)
      : [],
  };
}

export const mesh_data = meshData;

/** Decode a Texture2D to PNG bytes (re-exported from `bcn_png.ts`). */
export const texture_png = texturePng;
