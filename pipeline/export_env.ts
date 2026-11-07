/**
 * Export the 3D ADV stage (env_3d_* prefab scene) to one GLB + metadata.
 *
 * The Unity scene lives in the env_3d_* bundle, but every mesh/material it
 * references lives in dependency bundles (fbx_mdl_env_*); all bundles are loaded
 * into one AssetEnvironment so PPtrs resolve.
 *
 * Static geometry: world transforms are baked into the vertices, so the GLB holds
 * one flat node per renderer. Lightmaps are exported as PNGs plus per-primitive
 * texture index / scale-offset, consumed by the viewer's custom shader.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as assets from "./assets.ts";
import { Glb } from "./core/gltf.ts";
import type { SerializedFile, UnityObject } from "./core/serialized_file.ts";
import { ANIMATION_MANAGE_FIELDS } from "../web/src/engine/animation_manage.js";
import { decodeBc6hHalf } from './core/bcn_png.ts';
import { decodeProbeCubemap, decodeTexture, extractReflectionProbes, extractDefaultReflection, extractSceneVolumes, rendererReflection, environmentNormalMatrix, activeComponent, extractLightControls } from '../web/src/runtime/bundle_loaders.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, "..");
const WEB = path.join(ROOT, "web");
const OUT = path.join(WEB, "assets");
const TEX = path.join(OUT, "tex");

const SCENE = "env_3d_adv_classroom-00-00-noon";
const SKY_BUNDLE = "t_sky_noon-00";
const ROOTS = new Set(["decal", "stg-parts", "eff", "cmn-parts", "Lighting&PostEffects"]);

type Vec3 = [number, number, number];
type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function matMul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

function trs(p: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): Mat4 {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy - wz) * s[0], 2 * (xz + wy) * s[0], p[0],
    2 * (xy + wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz - wx) * s[1], p[1],
    2 * (xz - wy) * s[2], 2 * (yz + wx) * s[2], (1 - 2 * (xx + yy)) * s[2], p[2],
    0.0, 0.0, 0.0, 1.0,
  ];
}

function xform(m: Mat4, v: ArrayLike<number>): Vec3 {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

function xformNormal(m: Mat4, v: ArrayLike<number>): Vec3 {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

function conv(p: ArrayLike<number>): Vec3 {
  return [p[0], p[1], -p[2]];
}

function pidIsZero(p: any): boolean {
  if (p === undefined || p === null) return true;
  return typeof p === "bigint" ? p === 0n : Number(p) === 0;
}

function pidKey(p: any): string {
  return String(p);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function fmt3(v: number): string {
  return v.toFixed(3);
}

interface Bucket {
  material: string;
  glsm: number | null;
  lightmap: boolean;
  overrideColor: number[] | null;
  reflection: { usage: number; anchor: number[]; bounds: { min: number[]; max: number[] } };
  renderingLayerMask: number;
  tan: number[];
  pos: number[];
  nrm: number[];
  uv0: number[];
  uv2: number[];
  idx: number[];
  vcount: number;
}

interface RendererEntry {
  r: Record<string, any>;
  pid: bigint;
}

export class EnvExporter {
  bundle: assets.BundleContainer;
  glb: Glb;
  texDone: Record<string, string>;
  texIdx: Record<string, number>;
  matDone: Record<string, number>;
  buckets: Map<string, Bucket>;
  lodSkipRenderers: Set<string>;
  colorOverrides: Map<string, Map<number, number[]>>;
  meta: Record<string, any>;
  stats: Record<string, number>;

  constructor(bundle: assets.BundleContainer) {
    this.bundle = bundle;
    this.glb = new Glb();
    this.texDone = {};
    this.texIdx = {};
    this.matDone = {};
    this.buckets = new Map();
    this.lodSkipRenderers = new Set();
    this.colorOverrides = new Map();
    this.meta = {
      materials: {}, lightmap: {}, lights: [],
      renderSettings: {}, decals: [], volumes: {}, skybox: null,
    };
    this.stats = { renderers: 0, verts: 0, tris: 0, skipped: 0, decals: 0 };
  }

  // ---------- textures ----------
  texture(tex: Record<string, any>): string | null {
    const name: string = tex.m_Name;
    if (Number(tex.m_TextureFormat) === 24) {
      if (!(name in this.texDone)) {
        fs.mkdirSync(TEX, { recursive: true });
        const decoded = decodeTexture(assets.loadEnv(), tex, decodeBc6hHalf);
        const ref = `tex/${name}.rgba16f`;
        fs.writeFileSync(path.join(OUT, ref), new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength));
        this.meta.hdrTextures ??= {};
        this.meta.hdrTextures[ref] = { width: decoded.width, height: decoded.height, type: 'half-float', colorSpace: 'linear' };
        this.texDone[name] = ref;
      }
      return this.texDone[name];
    }
    if (!(name in this.texDone)) {
      fs.mkdirSync(TEX, { recursive: true });
      const filePath = path.join(TEX, `${name}.png`);
      if (!fs.existsSync(filePath)) {
        try {
          fs.writeFileSync(filePath, assets.texturePng(tex));
        } catch {
          return null;
        }
      }
      this.texDone[name] = `tex/${name}.png`;
      const idx = this.glb.texture(this.glb.image_uri(name, this.texDone[name]));
      this.texIdx[name] = idx;
    }
    return this.texDone[name] ?? null;
  }

  material(mat: Record<string, any>, env: assets.AssetEnvironment): number | null {
    const key: string = mat.m_Name;
    if (key in this.matDone) return this.matDone[key];
    const entry: Record<string, any> = {
      maps: {},
      colors: {},
      floats: {},
      textureTransforms: {},
      shader: env.readPPtr(mat._assetsFile, mat.m_Shader)?.m_ParsedForm?.m_Name ?? env.readPPtr(mat._assetsFile, mat.m_Shader)?.m_Name ?? null,
      keywords: mat.m_ValidKeywords ?? String(mat.m_ShaderKeywords ?? '').split(/\s+/).filter(Boolean),
      renderQueue: Math.trunc(mat.m_CustomRenderQueue ?? -1),
    };
    const sf = mat._assetsFile as SerializedFile;
    const saved = mat.m_SavedProperties ?? {};
    for (const pair of saved.m_TexEnvs ?? []) {
      const prop = pair?.[0];
      const te = pair?.[1];
      entry.textureTransforms[prop] = { scale: [te?.m_Scale?.x ?? 1, te?.m_Scale?.y ?? 1], offset: [te?.m_Offset?.x ?? 0, te?.m_Offset?.y ?? 0] };
      const tex = env.readPPtr(sf, te?.m_Texture);
      if (!tex) continue;
      const rel = this.texture(tex);
      if (rel) entry.maps[prop] = rel;
    }
    for (const pair of saved.m_Colors ?? []) {
      const k = pair?.[0];
      const c = pair?.[1] ?? {};
      entry.colors[k] = [
        Number(c.r ?? 0), Number(c.g ?? 0), Number(c.b ?? 0), Number(c.a ?? 0),
      ];
    }
    for (const pair of saved.m_Floats ?? []) {
      const k = pair?.[0];
      const v = pair?.[1];
      entry.floats[k] = Number(v);
    }
    this.meta.materials[key] = entry;
    const albedo = entry.maps["_BaseMap"] || entry.maps["_MainTex"];
    const texIdx = albedo ? this.texIdx[path.parse(albedo).name] : undefined;
    const baseColor = entry.colors["_BaseColor"] ?? [1, 1, 1, 1];
    const glsm = this.glb.material(
      key,
      texIdx ?? null,
      baseColor,
      entry.floats["_Cull"] === 0,
      (entry.floats["_AlphaClip"] ?? 0.0) >= 0.5 ? "MASK" : null,
    );
    this.matDone[key] = glsm;
    return glsm;
  }

  // ---------- traversal ----------
  walk(
    node: assets.SkeletonNode,
    parentM: Mat4,
    out: Array<[assets.SkeletonNode, Mat4]>,
  ): void {
    if (!node.active) return;
    const [p, q, s] = assets.localTrs(node.transform);
    const m = matMul(parentM, trs(p, q, s));
    out.push([node, m]);
    for (const c of node.children) this.walk(c, m, out);
  }

  addRenderer(
    node: assets.SkeletonNode,
    m: Mat4,
    mf: Record<string, any>,
    mr: Record<string, any>,
    mrPid: bigint,
    env: assets.AssetEnvironment,
  ): void {
    if (!(mr.m_Enabled ?? 1) || this.lodSkipRenderers.has(pidKey(mrPid))) {
      this.stats.skipped += 1;
      return;
    }
    let mesh: UnityObject | null = null;
    try {
      mesh = env.readPPtr(mf._assetsFile, mf.m_Mesh);
    } catch {
      this.stats.skipped += 1;
      return;
    }
    if (mesh === null || mesh === undefined) return;
    const md: Record<string, any> = assets.meshData(mesh);
    const verts: ArrayLike<number>[] = md.vertices ?? [];
    if (!verts.length) return;
    const n = verts.length;
    const normals: ArrayLike<number>[] = md.normals ?? [];
    const uv0: ArrayLike<number>[] = md.uv0 ?? [];
    const uv1: ArrayLike<number>[] = md.uv1 ?? [];
    const vPos: number[] = [];
    const vNrm: number[] = [];
    const vUv0: number[] = [];
    const vUv2: number[] = [];
    const vTan: number[] = [];
    const tangents = md.tangents ?? [];
    let lm: number = mr.m_LightmapIndex ?? -1;
    if (lm === null || lm === undefined || lm >= 65000) lm = -1;
    const to = mr.m_LightmapTilingOffset ?? null;
    const [tsx, tsy, tox, toy] = to !== null
      ? [Number(to.x), Number(to.y), Number(to.z), Number(to.w)]
      : [1.0, 1.0, 0.0, 0.0];
    // Check negative determinant (mirrored scale flips triangle winding!)
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9])
      - m[1] * (m[4] * m[10] - m[6] * m[8])
      + m[2] * (m[4] * m[9] - m[5] * m[8]);
    const flipWinding = det < 0.0;
    const normalMatrix = environmentNormalMatrix(m);
    for (let i = 0; i < n; i++) {
      const pw = conv(xform(m, verts[i]));
      vPos.push(pw[0], pw[1], pw[2]);
      if (tangents.length === n) {
        const t = tangents[i], d = conv([m[0] * t[0] + m[1] * t[1] + m[2] * t[2], m[4] * t[0] + m[5] * t[1] + m[6] * t[2], m[8] * t[0] + m[9] * t[1] + m[10] * t[2]]);
        const len = Math.hypot(...d) || 1;
        vTan.push(d[0] / len, d[1] / len, d[2] / len, t[3] * (flipWinding ? -1 : 1));
      }
      if (i < normals.length) {
        const nn = xformNormal(normalMatrix, normals[i]);
        const ln = Math.sqrt(nn[0] * nn[0] + nn[1] * nn[1] + nn[2] * nn[2]) || 1.0;
        const nnc = conv([nn[0] / ln, nn[1] / ln, nn[2] / ln]);
        vNrm.push(nnc[0], nnc[1], nnc[2]);
      } else {
        vNrm.push(0.0, 1.0, 0.0);
      }
      if (i < uv0.length) {
        const u0 = Number(uv0[i][0]);
        const v0 = Number(uv0[i][1]);
        vUv0.push(u0, 1.0 - v0);
      } else {
        vUv0.push(0.0, 0.0);
      }
      const uv1v = i < uv1.length ? uv1[i] : [0.0, 0.0];
      const a = Number(uv1v[0]);
      const b = Number(uv1v[1]);
      vUv2.push(a * tsx + tox, b * tsy + toy);
    }
    const reflection = rendererReflection(env, mr, vPos, this.world.bind(this));

    const mats: Array<number | null> = [];
    const names: string[] = [];
    const mrSf = mr._assetsFile as SerializedFile;
    for (const mp of mr.m_Materials ?? []) {
      try {
        const mo = env.readPPtr(mrSf, mp);
        if (mo === null) throw new Error("missing material");
        mats.push(this.material(mo, env));
        names.push(mo.m_Name);
      } catch {
        mats.push(null);
        names.push("");
      }
    }

    const ovrMap = this.colorOverrides.get(pidKey(node.go)) ?? new Map<number, number[]>();
    const submeshes: any[] = md.submeshes ?? [];
    for (let si = 0; si < submeshes.length; si++) {
      const sub = submeshes[si];
      const start = Array.isArray(sub) ? sub[0] : sub.start;
      const count = Array.isArray(sub) ? sub[1] : sub.count;
      const tris: any[] = (md.triangles ?? []).slice(start, start + count);
      if (!tris.length) continue;
      const k = names.length ? Math.min(si, names.length - 1) : 0;
      const mname = names.length ? names[k] : "default";
      const glsm = mats.length ? mats[k] : null;
      const ovr = ovrMap.get(k) ?? null;
      const ovrTag = ovr !== null
        ? `${fmt3(ovr[0])}_${fmt3(ovr[1])}_${fmt3(ovr[2])}_${fmt3(ovr[3])}`
        : "1";
      const bkey = `${mname}|${lm >= 0 ? 'lm' : 'lit'}|${ovrTag}|${reflection.usage ? mrPid : 'off'}|${vTan.length ? 'tangent' : 'no-tangent'}|${mr.m_RenderingLayerMask ?? 1}`;
      let bkt = this.buckets.get(bkey);
      if (bkt === undefined) {
        bkt = {
          material: mname,
          glsm,
          lightmap: lm >= 0,
          overrideColor: ovr,
          reflection,
          renderingLayerMask: Number(mr.m_RenderingLayerMask ?? 1),
          tan: [],
          pos: [],
          nrm: [],
          uv0: [],
          uv2: [],
          idx: [],
          vcount: 0,
        };
        this.buckets.set(bkey, bkt);
      }
      const remap = new Map<number, number>();
      for (const tri of tris) {
        const a = tri[0], b = tri[1], c = tri[2];
        for (const vi of [a, b, c]) {
          if (!remap.has(vi)) {
            const gi = bkt.vcount;
            bkt.vcount = gi + 1;
            remap.set(vi, gi);
            bkt.pos.push(vPos[vi * 3], vPos[vi * 3 + 1], vPos[vi * 3 + 2]);
            bkt.nrm.push(vNrm[vi * 3], vNrm[vi * 3 + 1], vNrm[vi * 3 + 2]);
            bkt.uv0.push(vUv0[vi * 2], vUv0[vi * 2 + 1]);
            bkt.uv2.push(vUv2[vi * 2], vUv2[vi * 2 + 1]);
            if (vTan.length) bkt.tan.push(...vTan.slice(vi * 4, vi * 4 + 4));
          }
        }
        const ia = remap.get(a)!, ib = remap.get(b)!, ic = remap.get(c)!;
        if (flipWinding) {
          bkt.idx.push(ia, ib, ic);
        } else {
          bkt.idx.push(ia, ic, ib);
        }
      }
      this.stats.tris += tris.length;
    }
    this.stats.renderers += 1;
    this.stats.verts += n;
  }

  /** World matrix of a Transform (walks the m_Father chain). */
  world(t: Record<string, any>, env: assets.AssetEnvironment): Mat4 {
    const chain: Record<string, any>[] = [];
    let cur: Record<string, any> | null = t;
    let guard = 0;
    while (cur !== null && guard < 64) {
      chain.push(cur);
      const f = cur.m_Father;
      const sf = cur._assetsFile as SerializedFile;
      cur = f !== undefined && f !== null && !pidIsZero(f.m_PathID)
        ? (env.resolvePPtr(sf, f)?.read() ?? null)
        : null;
      guard += 1;
    }
    let m: Mat4 = IDENTITY.slice();
    for (let i = chain.length - 1; i >= 0; i--) {
      const [p, q, s] = assets.localTrs(chain[i]);
      m = matMul(m, trs(p, q, s));
    }
    return m;
  }

  run(): void {
    const env = assets.loadEnv();
    const registerCube = (texture: UnityObject) => {
      const t = texture.read(), ref = `tex/${t.m_Name}.cube.json`;
      const cube = decodeProbeCubemap(env, texture, decodeBc6hHalf);
      fs.mkdirSync(TEX, { recursive: true });
      const mipmaps = cube.mipmaps.map((mip: { width: number; height: number; faces: Uint16Array[] }, level: number) => ({ width: mip.width, height: mip.height, faces: mip.faces.map((data: Uint16Array, face: number) => {
        const file = `tex/${t.m_Name}.m${level}.f${face}.rgba16f`;
        fs.writeFileSync(path.join(OUT, file), new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        return file;
      }) }));
      fs.writeFileSync(path.join(OUT, ref), JSON.stringify({ ...cube, mipmaps }));
      return ref;
    };
    this.meta.reflectionProbes = extractReflectionProbes(env, this.bundle, this.world.bind(this), registerCube);
    this.meta.defaultReflection = extractDefaultReflection(env, this.bundle, registerCube);
    const resolvedVolumes = extractSceneVolumes(env, this.bundle, this.world.bind(this));
    Object.assign(this.meta.volumes, resolvedVolumes.volumes);
    this.meta.volumeStack = resolvedVolumes.stack;
    // scene roots
    const roots: UnityObject[] = [];
    for (const o of assets.objectsOf(this.bundle, "Transform")) {
      const t = o.read();
      if (pidIsZero(t.m_Father?.m_PathID)) {
        const go = env.readPPtr(o.assetsFile, t.m_GameObject);
        if (go && ROOTS.has(go.m_Name)) roots.push(o);
      }
    }
    // renderer lookup by GameObject path id
    // LODGroups: skip LOD1+ duplicate meshes
    for (const o of assets.objectsOf(this.bundle, "LODGroup")) {
      const tt = o.read();
      if (!(tt.m_Enabled ?? 1)) continue;
      const lods: any[] = tt.m_LODs ?? [];
      for (const lod of lods.slice(1)) {
        for (const rref of lod?.renderers ?? []) {
          const rpid = rref?.renderer?.m_PathID ?? 0;
          if (!pidIsZero(rpid)) this.lodSkipRenderers.add(pidKey(rpid));
        }
      }
    }

    // MonoBehaviours: OverrideBaseColor, DecalProjector, and Stage Volumes
    const rawDecals: Array<[UnityObject, Record<string, any>]> = [];
    for (const o of assets.objectsOf(this.bundle, "MonoBehaviour")) {
      const tt = o.read();
      if ("materialIndex" in tt && "color" in tt) {
        const gpid = tt.m_GameObject?.m_PathID ?? 0;
        const c = tt.color;
        const k = pidKey(gpid);
        let ovr = this.colorOverrides.get(k);
        if (ovr === undefined) {
          ovr = new Map();
          this.colorOverrides.set(k, ovr);
        }
        ovr.set(Math.trunc(tt.materialIndex), [
          Number(c.r), Number(c.g), Number(c.b), Number(c.a),
        ]);
      } else if ("m_UVScale" in tt && "m_Size" in tt) {
        if (tt.m_Enabled ?? 1) rawDecals.push([o, tt]);
      } else if (tt.active === 1 || tt.active === true) {
        const isObj = (d: any): boolean =>
          d !== null && typeof d === "object" && !Array.isArray(d) && !(d instanceof Uint8Array);
        const v = (field: string, dflt: any = null): any => {
          const d = tt[field];
          return isObj(d) ? (d.m_Value ?? dflt) : dflt;
        };
        const mergeOvr = (dst: Record<string, any>, fields: string[]): void => {
          for (const fk of fields) {
            const d = tt[fk];
            if (isObj(d) && "m_Value" in d) {
              if (d.m_OverrideState === 1 || d.m_OverrideState === true || !(fk in dst)) dst[fk] = d.m_Value;
            }
          }
        };
        const vol = (key: string): Record<string, any> => {
          if (!(key in this.meta.volumes)) this.meta.volumes[key] = {};
          return this.meta.volumes[key];
        };
        if ("shadeColorMultiply" in tt && "mainLightAngle" in tt) {
          mergeOvr(vol("actorParam"), [
            "lightColor", "mainLightSpace", "mainLightAngle",
            "shadeColorMultiply", "shadeColorAdditive", "shadeApplyRatio",
            "rimAngle", "rimBaseColorRatio", "rimPower", "rimColor",
          ]);
        } else if ("shadowStrength" in tt && "lightDirectional" in tt) {
          mergeOvr(vol("actorShadow"), [
            "shadowStrength", "directionalType", "lightDirectional",
            "facePartsShadowStrength",
          ]);
        } else if ("modelingPoseWeight" in tt && "swingPowerWeight" in tt) {
          mergeOvr(vol("animationManage"), [...ANIMATION_MANAGE_FIELDS]);
        } else if ("radius" in tt && "maxAmount" in tt && "position" in tt) {
          const posU = v("position") ?? { x: 0, y: 0, z: 0 };
          this.meta.volumes.skyHaze = {
            density: v("density", 0.0),
            maxAmount: v("maxAmount", 0.0),
            color: v("color"),
            position: [posU.x, posU.y, -posU.z],
            radius: v("radius", 1.0),
          };
        }
      }
    }

    // renderer lookup by GameObject path id
    const renderers = new Map<string, RendererEntry>();
    const filters = new Map<string, Record<string, any>>();
    for (const o of assets.objectsOf(this.bundle, "MeshRenderer")) {
      const r = o.read();
      let goPid: any;
      try {
        goPid = r.m_GameObject.m_PathID;
      } catch {
        continue;
      }
      renderers.set(pidKey(goPid), { r, pid: o.pathId });
    }
    for (const o of assets.objectsOf(this.bundle, "MeshFilter")) {
      const f = o.read();
      filters.set(pidKey(f.m_GameObject.m_PathID), f);
    }
    const identity = IDENTITY.slice();
    const activeGoWorld = new Map<string, Mat4>();
    for (const r of roots) {
      const [node] = assets.skeleton(r, env);
      const flat: Array<[assets.SkeletonNode, Mat4]> = [];
      this.walk(node, identity, flat);
      for (const [n, m] of flat) {
        const k = pidKey(n.go);
        activeGoWorld.set(k, m);
        const rv = renderers.get(k);
        const fl = filters.get(k);
        if (rv !== undefined && fl !== undefined) {
          this.addRenderer(n, m, fl, rv.r, rv.pid, env);
        }
      }
    }

    // Build triangle soup from opaque stage buckets to snap DecalProjectors onto exact surfaces
    const triData: number[] = [];
    const triMin: number[] = [];
    const triMax: number[] = [];
    for (const bkt of this.buckets.values()) {
      if (!bkt.idx.length) continue;
      const mfl: Record<string, any> = this.meta.materials[bkt.material]?.floats ?? {};
      if (bkt.material.toLowerCase().includes("glass") || mfl._DstBlend === 10.0) continue;
      for (let t = 0; t < bkt.idx.length; t += 3) {
        const corners: Vec3[] = [];
        for (let ci = 0; ci < 3; ci++) {
          const vi = bkt.idx[t + ci] * 3;
          // Convert back to Unity space (x, y, -z) for raycast
          corners.push([bkt.pos[vi], bkt.pos[vi + 1], -bkt.pos[vi + 2]]);
        }
        const mins: Vec3 = [
          Math.min(corners[0][0], corners[1][0], corners[2][0]),
          Math.min(corners[0][1], corners[1][1], corners[2][1]),
          Math.min(corners[0][2], corners[1][2], corners[2][2]),
        ];
        const maxs: Vec3 = [
          Math.max(corners[0][0], corners[1][0], corners[2][0]),
          Math.max(corners[0][1], corners[1][1], corners[2][1]),
          Math.max(corners[0][2], corners[1][2], corners[2][2]),
        ];
        triData.push(
          corners[0][0], corners[0][1], corners[0][2],
          corners[1][0], corners[1][1], corners[1][2],
          corners[2][0], corners[2][1], corners[2][2],
        );
        triMin.push(mins[0], mins[1], mins[2]);
        triMax.push(maxs[0], maxs[1], maxs[2]);
      }
    }
    const triCount = triData.length / 9;

    // Export active DecalProjectors as oriented planar quads snapped to target surfaces
    for (const [o, tt] of rawDecals) {
      const gpid = tt.m_GameObject?.m_PathID ?? 0;
      const wm = activeGoWorld.get(pidKey(gpid));
      if (wm === undefined) continue;
      let dmat: Record<string, any> | null = null;
      try {
        dmat = env.readPPtr(o.assetsFile, tt.m_Material);
      } catch {
        continue;
      }
      if (!dmat) continue;
      this.material(dmat, env);
      const mentry = this.meta.materials[dmat.m_Name] ?? {};
      const maps = mentry.maps ?? {};
      const texRel = maps["_BaseMap"] || maps["_MainTex"];
      if (!texRel) continue;
      const off = tt.m_Offset;
      const sz = tt.m_Size;
      const uvs = tt.m_UVScale;
      const uvb = tt.m_UVBias;
      const scaleMode = Math.trunc(tt.m_ScaleMode ?? 1);
      let useM: Mat4 = wm;
      let zScale = Math.sqrt(wm[2] ** 2 + wm[6] ** 2 + wm[10] ** 2) || 1.0;
      if (scaleMode === 0) {
        const c0 = Math.sqrt(wm[0] ** 2 + wm[4] ** 2 + wm[8] ** 2) || 1.0;
        const c1 = Math.sqrt(wm[1] ** 2 + wm[5] ** 2 + wm[9] ** 2) || 1.0;
        useM = [
          wm[0] / c0, wm[1] / c1, wm[2] / zScale, wm[3],
          wm[4] / c0, wm[5] / c1, wm[6] / zScale, wm[7],
          wm[8] / c0, wm[9] / c1, wm[10] / zScale, wm[11],
          0.0, 0.0, 0.0, 1.0,
        ];
        zScale = 1.0;
      }
      // Outward surface normal is -Z of decal projector; projection ray goes along +Z = -nout_u
      const nz: Vec3 = [-useM[2], -useM[6], -useM[10]];
      const nl = Math.sqrt(nz[0] ** 2 + nz[1] ** 2 + nz[2] ** 2) || 1.0;
      const noutU: Vec3 = [nz[0] / nl, nz[1] / nl, nz[2] / nl];
      const hx = 0.5 * Number(sz.x);
      const hy = 0.5 * Number(sz.y);
      const hz = 0.5 * Number(sz.z);
      const ox = Number(off.x), oy = Number(off.y), oz = Number(off.z);

      // Raycast from front of projector box (oz - 1.2*hz) along +Z to snap onto front-most surface
      let bias = 0.0022;
      if (triCount > 0 && hz > 1e-4) {
        const pStart = xform(useM, [ox, oy, oz - 1.2 * hz]);
        const rayD: Vec3 = [-noutU[0], -noutU[1], -noutU[2]];
        const maxT = 2.4 * hz * zScale;
        const rmin: Vec3 = [
          Math.min(pStart[0], pStart[0] + rayD[0] * maxT) - 0.05,
          Math.min(pStart[1], pStart[1] + rayD[1] * maxT) - 0.05,
          Math.min(pStart[2], pStart[2] + rayD[2] * maxT) - 0.05,
        ];
        const rmax: Vec3 = [
          Math.max(pStart[0], pStart[0] + rayD[0] * maxT) + 0.05,
          Math.max(pStart[1], pStart[1] + rayD[1] * maxT) + 0.05,
          Math.max(pStart[2], pStart[2] + rayD[2] * maxT) + 0.05,
        ];
        let bestT = Infinity;
        for (let ti = 0; ti < triCount; ti++) {
          const b3 = ti * 3;
          // Triangle AABB must overlap the ray bounding box
          if (triMax[b3] < rmin[0] || triMin[b3] > rmax[0]) continue;
          if (triMax[b3 + 1] < rmin[1] || triMin[b3 + 1] > rmax[1]) continue;
          if (triMax[b3 + 2] < rmin[2] || triMin[b3 + 2] > rmax[2]) continue;
          const i9 = ti * 9;
          const v0x = triData[i9], v0y = triData[i9 + 1], v0z = triData[i9 + 2];
          const e1x = triData[i9 + 3] - v0x;
          const e1y = triData[i9 + 4] - v0y;
          const e1z = triData[i9 + 5] - v0z;
          const e2x = triData[i9 + 6] - v0x;
          const e2y = triData[i9 + 7] - v0y;
          const e2z = triData[i9 + 8] - v0z;
          // h = cross(ray_d, e2)
          const hx2 = rayD[1] * e2z - rayD[2] * e2y;
          const hy2 = rayD[2] * e2x - rayD[0] * e2z;
          const hz2 = rayD[0] * e2y - rayD[1] * e2x;
          const det = e1x * hx2 + e1y * hy2 + e1z * hz2;
          if (Math.abs(det) <= 1e-7) continue;
          const invDet = 1.0 / det;
          const sx = pStart[0] - v0x;
          const sy = pStart[1] - v0y;
          const sz2 = pStart[2] - v0z;
          const uB = (sx * hx2 + sy * hy2 + sz2 * hz2) * invDet;
          if (uB < -0.02) continue;
          // q = cross(s, e1)
          const qx = sy * e1z - sz2 * e1y;
          const qy = sz2 * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const vB = (rayD[0] * qx + rayD[1] * qy + rayD[2] * qz) * invDet;
          if (vB < -0.02 || uB + vB > 1.04) continue;
          const tHit = (e2x * qx + e2y * qy + e2z * qz) * invDet;
          if (tHit >= 0.0 && tHit <= maxT && tHit < bestT) bestT = tHit;
        }
        if (bestT !== Infinity) {
          // Center is at 1.2 * hz * z_scale from p_start along ray_d (-nout_u)
          bias = (1.2 * hz * zScale - bestT) + 0.0022;
        }
      }

      const cornersLocal: Vec3[] = [
        [ox - hx, oy - hy, oz],
        [ox + hx, oy - hy, oz],
        [ox + hx, oy + hy, oz],
        [ox - hx, oy + hy, oz],
      ];
      const corners3js: number[] = [];
      for (const cl of cornersLocal) {
        const pw = xform(useM, cl);
        pw[0] += noutU[0] * bias;
        pw[1] += noutU[1] * bias;
        pw[2] += noutU[2] * bias;
        const cc = conv(pw);
        corners3js.push(cc[0], cc[1], cc[2]);
      }
      const u0 = Number(uvb.x);
      const u1 = Number(uvb.x) + Number(uvs.x);
      const v0U = Number(uvb.y);
      const v1U = Number(uvb.y) + Number(uvs.y);
      // Flip V for top-down PNG with flipY=false
      const quadUvs = [
        u0, 1.0 - v0U,
        u1, 1.0 - v0U,
        u1, 1.0 - v1U,
        u0, 1.0 - v1U,
      ];
      const rgba = Math.trunc((tt.m_Color ?? {}).rgba ?? 0xFFFFFFFF) & 0xFFFFFFFF;
      const cr = (rgba & 0xFF) / 255.0;
      const cg = ((rgba >>> 8) & 0xFF) / 255.0;
      const cb = ((rgba >>> 16) & 0xFF) / 255.0;
      const ca = ((rgba >>> 24) & 0xFF) / 255.0;
      this.meta.decals.push({
        material: dmat.m_Name,
        map: texRel,
        positions: corners3js.map((x) => round(x, 5)),
        normal: conv(noutU).map((x) => round(x, 5)),
        uvs: quadUvs.map((x) => round(x, 5)),
        fade: round(Number(tt.m_FadeFactor ?? 1.0) * ca, 4),
        color: [round(cr, 4), round(cg, 4), round(cb, 4)],
        priority: Math.trunc(tt.m_DecalPriority ?? 0),
        isShadow: String(dmat.m_Name).toLowerCase().includes("shadow"),
      });
      this.stats.decals += 1;
    }

    // Skybox texture from t_sky_noon-00
    try {
      const skyB = assets.bundleFile(SKY_BUNDLE);
      for (const o of assets.objectsOf(skyB, "Texture2D")) {
        const tx = o.read();
        if (tx.m_Name === SKY_BUNDLE) {
          this.meta.skybox = this.texture(tx);
          break;
        }
      }
    } catch {
      // no skybox
    }

    // lights (position & forward direction from the GameObject's transform chain)
    for (const o of assets.objectsOf(this.bundle, "Light")) {
      const L = o.read();
      if (!activeComponent(env, o.assetsFile, L)) continue;
      const sf = o.assetsFile;
      let go: Record<string, any> | null = null;
      let tr: Record<string, any> | null = null;
      try {
        go = env.readPPtr(sf, L.m_GameObject);
        if (!(go?.m_IsActive ?? 1)) continue;
        for (const c of go.m_Component ?? []) {
          const compObj = env.resolvePPtr(go._assetsFile ?? sf, c.component);
          if (compObj?.typeName === "Transform") {
            tr = compObj.read();
            break;
          }
        }
      } catch {
        tr = null;
      }
      const w = tr !== null ? this.world(tr, env) : identity;
      const p2 = conv([w[3], w[7], w[11]]);
      const fwU: Vec3 = [w[2], w[6], w[10]];
      const fl = Math.sqrt(fwU[0] ** 2 + fwU[1] ** 2 + fwU[2] ** 2) || 1.0;
      const d2 = conv([fwU[0] / fl, fwU[1] / fl, fwU[2] / fl]);
      const col = L.m_Color ?? {};
      this.meta.lights.push({
        name: tr !== null ? go!.m_Name : "light",
        type: Math.trunc(L.m_Type),
        color: [col.r, col.g, col.b],
        intensity: Number(L.m_Intensity),
        layerMask: Number(L.m_RenderingLayerMask ?? 1),
        ...extractLightControls(env, sf, L),
        bakeType: Number(L.m_BakingOutput?.lightmapBakeMode?.lightmapBakeType ?? L.m_Lightmapping),
        range: Number(L.m_Range),
        spotAngle: Number(L.m_SpotAngle ?? 0.0),
        position: [p2[0], p2[1], p2[2]],
        direction: [d2[0], d2[1], d2[2]],
        shadows: L.m_Shadows?.value ?? 0,
      });
    }
    for (const o of assets.objectsOf(this.bundle, "RenderSettings")) {
      const rs = o.read();
      const has = (k: string): boolean => rs[k] !== undefined && rs[k] !== null;
      const rgb = (c: any): number[] => [c.r, c.g, c.b];
      this.meta.renderSettings = {
        ambientMode: has("m_AmbientMode") ? Math.trunc(rs.m_AmbientMode) : null,
        ambientSkyColor: rgb(rs.m_AmbientSkyColor),
        ambientEquatorColor: rgb(rs.m_AmbientEquatorColor),
        ambientGroundColor: rgb(rs.m_AmbientGroundColor),
        ambientIntensity: rs.m_AmbientIntensity ?? 1.0,
        fog: Boolean(rs.m_Fog ?? false),
        fogColor: has("m_FogColor") ? rgb(rs.m_FogColor) : null,
        fogDensity: rs.m_FogDensity ?? 0.0,
      };
    }
    // lightmap textures (renderers use atlas 0)
    const lms: Record<string, string | null> = {};
    for (const o of assets.objectsOf(this.bundle, "Texture2D")) {
      const t = o.read();
      const tname = String(t.m_Name ?? "");
      if (tname.startsWith("Lightmap-0_comp_light")) {
        lms.light = this.texture(t);
      } else if (tname.startsWith("Lightmap-0_comp_shadowmask")) {
        lms.shadow = this.texture(t);
      }
    }
    this.meta.lightmap = lms;

    // Build ONE merged glTF primitive per (material, lightmapped, overrideColor) bucket
    this.meta.prims = {};
    let bi = 0;
    for (const [, bkt] of this.buckets) {
      const i = bi;
      bi += 1;
      if (!bkt.idx.length) continue;
      const name = `bkt_${i}`;
      const attrs: Record<string, number> = {
        POSITION: this.glb.floats(bkt.pos, "VEC3"),
        NORMAL: this.glb.floats(bkt.nrm, "VEC3"),
        TEXCOORD_0: this.glb.floats(bkt.uv0, "VEC2"),
        TEXCOORD_2: this.glb.floats(bkt.uv2, "VEC2"),
      };
      if (bkt.tan.length) attrs.TANGENT = this.glb.floats(bkt.tan, 'VEC4');
      const acc = this.glb.uints(bkt.idx, "SCALAR");
      const prim = this.glb.primitive(attrs, acc, bkt.glsm);
      const idx = this.glb.mesh(name, [prim]);
      this.glb.node(`env_${name}`, null, null, idx);
      this.meta.prims[name] = {
        material: bkt.material,
        lightmap: bkt.lightmap,
        overrideColor: bkt.overrideColor,
        reflection: bkt.reflection,
        renderingLayerMask: bkt.renderingLayerMask,
      };
    }
    fs.mkdirSync(OUT, { recursive: true });
    this.glb.save(path.join(OUT, "env.glb"));
    fs.writeFileSync(path.join(OUT, "env.json"), JSON.stringify(this.meta, null, 1), "utf8");
    console.log(
      "env stats", this.stats, "materials", Object.keys(this.meta.materials).length,
      "textures", Object.keys(this.texDone).length, "buckets", Object.keys(this.meta.prims).length,
    );
  }
}

export function main(): void {
  assets.loadEnv();
  new EnvExporter(assets.bundleFile(SCENE)).run();
}

if (import.meta.main) {
  main();
}
