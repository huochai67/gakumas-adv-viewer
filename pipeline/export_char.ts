/**
 * Export the 3D actor (body + face + hair) into one GLB plus a metadata JSON.
 *
 * Outputs (under web/):
 *   assets/char.glb      skinned meshes, morph targets (face blendshapes), skeleton
 *   assets/char.json     material definitions, texture paths, humanoid bone map
 *   assets/tex/*.png     decoded textures
 *
 * Bind-pose conventions (verified numerically):
 *   * Unity world -> three.js: p=(x,y,-z), q=(x,y,-z,-w), scale unchanged
 *   * face/hair part roots hang under the body Head bone with identity local
 *     transform; their bindposes are inverse(boneWorld) in the *same* actor space,
 *     which is exactly what glTF skins need (mesh node transform is ignored for
 *     skinned meshes).
 *   * Unity Matrix4x4f (e00..e33) is row-major math layout; glTF wants
 *     column-major, so matrices are transposed on write.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bundleFile,
  loadEnv,
  localTrs,
  meshData,
  objectsOf,
  skeleton,
  texturePng,
  type AssetEnvironment,
  type BundleContainer,
  type SkeletonNode,
} from "./assets";
import { Glb } from "./gltf";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "web");
const OUT = path.join(WEB, "assets");
const TEX = path.join(OUT, "tex");

const PARTS = {
  body: "mdl_chr_amao-casl-0000_body",
  face: "mdl_chr_amao-base-0000_face",
  hair: "mdl_chr_amao-base-0000_hair",
} as const;

const HUMANOID: Record<string, string> = {
  Hips: "Hips",
  Spine: "Spine",
  Chest: "Spine1",
  UpperChest: "Spine2",
  Neck: "Neck",
  Head: "Head",
  LeftShoulder: "LeftShoulder",
  LeftUpperArm: "LeftArm",
  LeftLowerArm: "LeftForeArm",
  LeftHand: "LeftHand",
  RightShoulder: "RightShoulder",
  RightUpperArm: "RightArm",
  RightLowerArm: "RightForeArm",
  RightHand: "RightHand",
  LeftUpperLeg: "LeftUpLeg",
  LeftLowerLeg: "LeftLeg",
  LeftFoot: "LeftFoot",
  LeftToes: "LeftToeBase",
  RightUpperLeg: "RightUpLeg",
  RightLowerLeg: "RightLeg",
  RightFoot: "RightFoot",
  RightToes: "RightToeBase",
  LeftEye: "LeftEye",
  RightEye: "RightEye",
};
const FINGERS: Record<string, string> = {
  Thumb: "Thumb",
  Index: "Index",
  Middle: "Middle",
  Ring: "Ring",
  Little: "Pinky",
};
for (const side of ["Left", "Right"]) {
  for (const [fname, bone] of Object.entries(FINGERS)) {
    ["Proximal", "Intermediate", "Distal"].forEach((seg, i) => {
      HUMANOID[`${side}${fname}${seg}`] = `${side}Hand${bone}${i + 1}`;
    });
  }
}

/** Typetree record (dynamic Unity serialized data). */
type Rec = Record<string, any>;

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type BlendShape = [string, Map<number, Vec3>];

function convV(v: ArrayLike<number>): Vec3 {
  return [v[0], v[1], -v[2]];
}

function convQ(q: ArrayLike<number>): Quat {
  return [q[0], q[1], -q[2], -q[3]];
}

/** Unity Matrix4x4f -> glTF column-major list with the z flip applied. */
function matConvertRows(m: Record<string, any>): number[] {
  const rows: number[][] = [[], [], [], []];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) rows[r][c] = Number(m[`e${r}${c}`] ?? 0);
  }
  const s = [1.0, 1.0, -1.0, 1.0];
  const out: number[] = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) out.push(rows[r][c] * s[r] * s[c]);
  }
  return out;
}

let ENV: AssetEnvironment | null = null;
function env(): AssetEnvironment {
  if (!ENV) ENV = loadEnv();
  return ENV;
}

function pkey(pid: bigint | number | null | undefined): string {
  return String(pid ?? 0);
}

/** JSON writer that emits bigint values with full precision (Python int parity). */
function jdump(value: any, level = 0): string {
  const pad = " ".repeat(level);
  const inner = " ".repeat(level + 1);
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "bigint") return (value as bigint).toString();
  if (t === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t !== "object") return "null";
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const arr = Array.from(value as any);
    if (!arr.length) return "[]";
    return "[\n" + arr.map((e) => inner + jdump(e, level + 1)).join(",\n") + "\n" + pad + "]";
  }
  const keys = Object.keys(value).filter((k) => (value as any)[k] !== undefined);
  if (!keys.length) return "{}";
  return (
    "{\n" +
    keys.map((k) => inner + JSON.stringify(k) + ": " + jdump((value as any)[k], level + 1)).join(",\n") +
    "\n" +
    pad +
    "}"
  );
}

class Exporter {
  glb = new Glb();
  node_of_t = new Map<string, number>();
  node_of_go = new Map<string, number>();
  node_by_name = new Map<string, number>();
  meta: Record<string, any> = { materials: {}, parts: {}, humanoid: {}, boneNodes: {} };
  tex_done = new Map<string, string>();
  tex_idx = new Map<string, number>();
  glb_mat = new Map<string, number>();

  // ---------- textures / materials ----------
  texture_file(tex: Record<string, any>): string {
    const name = tex.m_Name as string;
    const done = this.tex_done.get(name);
    if (done !== undefined) return done;
    mkdirSync(TEX, { recursive: true });
    const file = path.join(TEX, `${name}.png`);
    if (!existsSync(file)) {
      writeFileSync(file, texturePng(tex, env()));
    }
    const rel = `tex/${name}.png`;
    this.tex_done.set(name, rel);
    return rel;
  }

  material(mat: Record<string, any>, part: string): string {
    const entry: Record<string, any> = {
      name: mat.m_Name,
      part,
      renderQueue: mat.m_CustomRenderQueue === undefined ? -1 : Math.trunc(mat.m_CustomRenderQueue),
      maps: {},
      floats: {},
      colors: {},
    };
    const sf = mat._assetsFile;
    const props = mat.m_SavedProperties ?? {};
    for (const pair of props.m_TexEnvs ?? []) {
      const prop = pair[0];
      const te = pair[1];
      let tex: Record<string, any> | null = null;
      try {
        tex = env().readPPtr(sf, te.m_Texture);
      } catch {
        tex = null;
      }
      if (tex === null || tex === undefined) continue;
      entry.maps[prop] = this.texture_file(tex);
    }
    for (const pair of props.m_Floats ?? []) {
      entry.floats[pair[0]] = Number(pair[1]);
    }
    for (const pair of props.m_Colors ?? []) {
      const c = pair[1];
      entry.colors[pair[0]] = [Number(c.r), Number(c.g), Number(c.b), Number(c.a)];
    }
    const key = `${part}:${mat.m_Name}`;
    this.meta.materials[key] = entry;
    let texIdx: number | null = null;
    const albedo: string | undefined = entry.maps["_BaseMap"];
    if (albedo) {
      let idx = this.tex_idx.get(albedo);
      if (idx === undefined) {
        idx = this.glb.texture(this.glb.imageUri(albedo, albedo));
        this.tex_idx.set(albedo, idx);
      }
      texIdx = idx;
    }
    const doubleSided = entry.floats["_Cull"] === 0;
    const alphaClip = entry.floats["_AlphaClip"] ?? 0.0;
    const alphaMode = alphaClip >= 0.5 ? "MASK" : null;
    this.glb_mat.set(
      key,
      this.glb.material(key, texIdx ?? undefined, undefined, doubleSided, alphaMode ?? undefined),
    );
    return key;
  }

  // ---------- nodes ----------
  emit_tree(node: SkeletonNode, parentIndex: number | null): number {
    const [p, q, s] = localTrs(node.transform);
    const idx = this.glb.node(node.name, [convV(p), convQ(q), [...s] as Vec3], parentIndex);
    this.node_of_t.set(pkey(node.path_id), idx);
    this.node_of_go.set(pkey(node.go), idx);
    if (!this.node_by_name.has(node.name)) this.node_by_name.set(node.name, idx);
    this.meta.boneNodes[String(idx)] = node.name;
    if (!this.meta.nodeByPathId) this.meta.nodeByPathId = {};
    this.meta.nodeByPathId[pkey(node.path_id)] = idx;
    for (const c of node.children) this.emit_tree(c, idx);
    return idx;
  }

  // ---------- meshes ----------
  build_primitives(
    md: Record<string, any>,
    joint_count: number,
    weights_override?: [number[], number[]] | null,
    blend_shapes?: BlendShape[] | null,
    mat_keys?: string[] | null,
  ): [any[], number[] | null] {
    const verts: any[] = md.vertices ?? [];
    const normals: any[] = md.normals ?? [];
    const n = verts.length;
    const pos: number[] = [];
    const nrm: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = convV(verts[i]);
      pos.push(p[0], p[1], p[2]);
      if (i < normals.length) {
        const q = convV(normals[i]);
        nrm.push(q[0], q[1], q[2]);
      } else {
        nrm.push(0.0, 0.0, -1.0);
      }
    }
    const uv: number[] = [];
    const uvs0: any[] = md.uv0 ?? [];
    for (let i = 0; i < n; i++) {
      if (i < uvs0.length) {
        const [u0, v0] = uvs0[i];
        uv.push(u0, 1.0 - v0);
      } else {
        uv.push(0.0, 0.0);
      }
    }
    const attrs: Record<string, number> = {
      POSITION: this.glb.floats(pos, "VEC3"),
      NORMAL: this.glb.floats(nrm, "VEC3"),
      TEXCOORD_0: this.glb.floats(uv, "VEC2"),
    };
    const tlist: any[] = md.tangents ?? [];
    if (tlist.length) {
      const tan: number[] = [];
      for (let i = 0; i < n; i++) {
        if (i < tlist.length) {
          const t = tlist[i];
          let tx = t[0];
          let ty = t[1];
          let tz = -t[2];
          const tw = t[3];
          const ln = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (ln > 1e-6) {
            tan.push(tx / ln, ty / ln, tz / ln, tw >= 0 ? 1.0 : -1.0);
          } else {
            tan.push(1.0, 0.0, 0.0, 1.0);
          }
        } else {
          tan.push(1.0, 0.0, 0.0, 1.0);
        }
      }
      attrs.TANGENT = this.glb.floats(tan, "VEC4");
    }
    const clist: any[] = md.colors ?? [];
    if (clist.length) {
      let is_byte = false;
      for (const c of clist.slice(0, 64)) {
        if (ArrayBuffer.isView(c)) {
          is_byte = true;
          break;
        }
        for (const x of c) {
          if (typeof x === "number" && x > 1.001) {
            is_byte = true;
            break;
          }
        }
        if (is_byte) break;
      }
      const scale = is_byte ? 1.0 / 255.0 : 1.0;
      const col: number[] = [];
      for (let i = 0; i < n; i++) {
        if (i < clist.length) {
          const c = clist[i];
          col.push(Number(c[0]) * scale, Number(c[1]) * scale, Number(c[2]) * scale, Number(c[3]) * scale);
        } else {
          col.push(0.0, 0.0, 0.0, 1.0);
        }
      }
      attrs.COLOR_0 = this.glb.floats(col, "VEC4");
    }
    const uvs1: any[] = md.uv1 ?? [];
    if (uvs1.length) {
      const uv1: number[] = [];
      for (let i = 0; i < n; i++) {
        if (i < uvs1.length) {
          const [u1, v1] = uvs1[i];
          uv1.push(u1, 1.0 - v1);
        } else {
          uv1.push(0.0, 0.0);
        }
      }
      attrs.TEXCOORD_1 = this.glb.floats(uv1, "VEC2");
    }
    let ji: number[] | null = null;
    let jw: number[] | null = null;
    const bones: any[] = md.bones ?? [];
    const weights: any[] = md.weights ?? [];
    if (weights_override !== undefined && weights_override !== null) {
      ji = weights_override[0];
      jw = weights_override[1];
    } else if (bones.length && weights.length) {
      ji = [];
      jw = [];
      for (let i = 0; i < n; i++) {
        const bi = bones[i];
        const bw = weights[i];
        const ws: number[] =
          Array.isArray(bw) || ArrayBuffer.isView(bw) ? Array.from(bw as any).slice(0, 4) : [bw];
        const js: number[] =
          Array.isArray(bi) || ArrayBuffer.isView(bi) ? Array.from(bi as any).slice(0, 4) : [bi];
        while (js.length < 4) js.push(0);
        while (ws.length < 4) ws.push(0.0);
        const s = ws.reduce((a, b) => a + b, 0) || 1.0;
        for (const x of js) ji.push(Math.trunc(x));
        for (const w of ws) jw.push(w / s);
      }
    }
    if (ji !== null && jw !== null) {
      attrs.JOINTS_0 = this.glb.ushorts(ji, "VEC4");
      attrs.WEIGHTS_0 = this.glb.floats(jw, "VEC4");
    }

    let targets: Array<Record<string, number>> | null = null;
    let out_weights: number[] | null = null;
    if (blend_shapes && blend_shapes.length) {
      targets = [];
      out_weights = [];
      for (const [bsName, deltas] of blend_shapes) {
        const idxs = Array.from(deltas.keys()).sort((a, b) => a - b);
        const vals: number[] = [];
        for (const vi of idxs) {
          const d = deltas.get(vi)!;
          const v = convV(d);
          vals.push(v[0], v[1], v[2]);
        }
        const acc = this.glb.sparseFloatAccessor(n, "VEC3", idxs, vals);
        targets.push({ POSITION: acc });
        out_weights.push(0.0);
      }
    }

    const prims: any[] = [];
    const submeshes: any[] = md.submeshes ?? [];
    const triangles: any[] = md.triangles ?? [];
    for (let si = 0; si < submeshes.length; si++) {
      const start = submeshes[si][0];
      const count = submeshes[si][1];
      const flat: number[] = [];
      for (const tri of triangles.slice(start, start + count)) {
        flat.push(tri[0], tri[2], tri[1]);
      }
      if (!flat.length) continue;
      const acc = this.glb.uints(flat, "SCALAR");
      let mi: number | undefined;
      if (mat_keys && mat_keys.length) {
        mi = this.glb_mat.get(mat_keys[Math.min(si, mat_keys.length - 1)]);
      }
      prims.push(
        this.glb.primitive({ ...attrs }, acc, mi, targets === null ? undefined : targets),
      );
    }
    return [prims, out_weights];
  }

  add_skinned(
    part_name: string,
    parent_go: Record<string, any>,
    mesh: Record<string, any>,
    joints: any[],
    bond_matrices: any[],
    materials: string[],
    name: string,
    blend_shapes?: BlendShape[] | null,
    weights_override?: [number[], number[]] | null,
  ): number {
    const md = meshData(mesh, env());
    const joint_nodes: number[] = [];
    for (const t of joints) {
      const pid = pkey(t.m_PathID);
      const nodeIdx = this.node_of_t.get(pid);
      if (nodeIdx === undefined) throw new Error(`joint path_id ${String(t.m_PathID)} missing for ${name}`);
      joint_nodes.push(nodeIdx);
    }
    const ibm: number[] = [];
    for (const m of bond_matrices) ibm.push(...matConvertRows(m));
    const skin = this.glb.skin(name, joint_nodes, ibm);
    const [prims, weights] = this.build_primitives(
      md,
      joint_nodes.length,
      weights_override ?? undefined,
      blend_shapes ?? undefined,
      materials,
    );
    const gltf_mesh = this.glb.mesh(name, prims, weights ?? undefined);
    const parentNode = this.node_of_go.get(pkey(parent_go.m_PathID));
    if (parentNode === undefined) throw new Error(`parent node missing for ${name}`);
    const mesh_node = this.glb.node(
      name + "_mesh",
      undefined,
      parentNode,
      gltf_mesh,
      skin,
      weights ?? undefined,
    );
    this.meta.parts[name] = {
      node: mesh_node,
      materials,
      submeshCount: prims.length,
      vertexCount: (md.vertices ?? []).length,
      blendShapes: blend_shapes && blend_shapes.length ? blend_shapes.map((bs) => bs[0]) : [],
    };
    return mesh_node;
  }
}

function find_root(bundle: BundleContainer): any {
  let fallback: any = null;
  for (const o of objectsOf(bundle, "Transform")) {
    const t = o.read() as Rec;
    if (BigInt(t.m_Father?.m_PathID ?? 0) !== 0n) continue;
    const go = env().readPPtr(o.assetsFile, t.m_GameObject);
    const name = String(go?.m_Name ?? "");
    if (name.startsWith("mdl_")) return o;
    if (!fallback) fallback = o;
  }
  if (!fallback) throw new Error("no root transform");
  return fallback;
}

function main(): void {
  const exp = new Exporter();
  env();

  // ---------------- body ----------------
  const body_bundle = bundleFile(PARTS.body);
  const [body_root] = skeleton(find_root(body_bundle), env());
  const actor = exp.glb.node("actor");
  const body_idx = exp.emit_tree(body_root, actor);
  // the body root node is the actor root itself
  const gltfNodes: any[] = exp.glb.json.nodes;
  if (!gltfNodes[actor].children) gltfNodes[actor].children = [];
  const ci = gltfNodes[actor].children.indexOf(body_idx);
  if (ci >= 0) gltfNodes[actor].children.splice(ci, 1);
  exp.glb.json.scenes[0].nodes = [body_idx];
  gltfNodes[body_idx].name = "actor";

  for (const o of objectsOf(body_bundle, "SkinnedMeshRenderer")) {
    const r = o.read() as Rec;
    const sf = o.assetsFile;
    const mesh = env().readPPtr(sf, r.m_Mesh)!;
    const mats = (r.m_Materials ?? []).map((m: any) => exp.material(env().readPPtr(sf, m)!, "body"));
    exp.add_skinned(
      "body",
      r.m_GameObject,
      mesh,
      r.m_Bones ?? [],
      mesh.m_BindPose ?? [],
      mats,
      "body_geo",
    );
  }

  // Export ActorAnimationQuartzDriver* twist/helper bone rules from body
  const qdrivers: any[] = [];
  const ik_colliders: any[] = [];
  const ik_goals: any[] = [];
  for (const o of objectsOf(body_bundle, "MonoBehaviour")) {
    const mb = o.read() as Rec;
    const sf = o.assetsFile;
    let cls_name = "";
    try {
      const script = env().readPPtr(sf, mb.m_Script);
      cls_name = String(script?.m_ClassName ?? "");
    } catch {
      cls_name = "";
    }
    const tt = mb;
    const go_pid = mb.m_GameObject.m_PathID;
    const node_idx = exp.node_of_go.get(pkey(go_pid));
    if (node_idx === undefined || node_idx === null) continue;
    const bname: string = exp.meta.boneNodes[String(node_idx)] ?? "";
    if (tt.setting !== undefined && cls_name.includes("QuartzDriver")) {
      const st: Record<string, any> = { ...tt.setting };
      for (const ref_key of ["referenceBone", "referenceWaistOffsetBone", "referenceThighOffsetBone"]) {
        if (ref_key in st && st[ref_key] !== null && typeof st[ref_key] === "object") {
          const rpid = st[ref_key].m_PathID ?? 0;
          st[ref_key] = exp.node_of_t.get(pkey(rpid)) ?? -1;
        }
      }
      qdrivers.push({ node: node_idx, name: bname, type: cls_name, setting: st });
    } else if (cls_name === "ActorAnimationIKCorrectionCollider") {
      const off = tt.offset || {};
      const rot = tt.rotation || {};
      ik_colliders.push({
        node: node_idx,
        name: bname,
        type: Math.trunc(tt.type ?? 1),
        weight: Number(tt.weight ?? 0.75),
        radius: Number(tt.radius ?? 0.125),
        radiusSub: Number(tt.radiusSub ?? 0.15),
        dampArea: Number(tt.dampArea ?? 0.01),
        length: Number(tt.length ?? 0.17),
        offset: [Number(off.x ?? 0.0), Number(off.y ?? 0.0), Number(off.z ?? 0.0)],
        rotation: [Number(rot.x ?? 0.0), Number(rot.y ?? 0.0), Number(rot.z ?? 0.0)],
      });
    } else if (cls_name === "ActorAnimationIKCorrectionGoal") {
      const off = tt.offset || {};
      ik_goals.push({
        node: node_idx,
        name: bname,
        goal: Math.trunc(tt.goal ?? 2),
        enable: Math.trunc(tt.enable ?? 1),
        radius: Number(tt.radius ?? 0.06),
        offset: [Number(off.x ?? 0.0), Number(off.y ?? 0.0), Number(off.z ?? 0.0)],
      });
    }
  }
  exp.meta.quartzDrivers = qdrivers;
  exp.meta.ikCorrection = { colliders: ik_colliders, goals: ik_goals };
  const head_bone = exp.node_by_name.get("Head");
  if (head_bone === undefined) throw new Error("Head bone not found");

  // ---------------- face ----------------
  const face_bundle = bundleFile(PARTS.face);
  const [face_root] = skeleton(find_root(face_bundle), env());
  exp.emit_tree(face_root, head_bone);

  for (const o of objectsOf(face_bundle, "MonoBehaviour")) {
    const t = o.read() as Rec;
    if (t.curves !== undefined && t.blendShapeIndices !== undefined) {
      exp.meta.faceCorrection = {
        indices: (t.blendShapeIndices ?? []).map((x: any) => Math.trunc(x)),
        curves: (t.curves ?? []).map((cv: any) =>
          (cv.m_Curve ?? []).map((k: any) => ({ t: Number(k.time), v: Number(k.value) })),
        ),
      };
      continue;
    }
    if (t.blendShapes === undefined) continue;
    const mb = t;
    const sf = o.assetsFile;
    const mesh = env().readPPtr(sf, mb.mesh)!;
    const mats = (mb.sharedMaterials ?? []).map((m: any) =>
      exp.material(env().readPPtr(sf, m)!, "face"),
    );
    const shapes: BlendShape[] = [];
    for (const bs of mb.blendShapes ?? []) {
      const deltas = new Map<number, Vec3>();
      for (const v of bs.blendShapeVertices ?? []) {
        deltas.set(Math.trunc(v.vertIndex), [v.position.x, v.position.y, v.position.z]);
      }
      shapes.push([String(bs.blendShapeName), deltas]);
    }
    const n = (meshData(mesh, env()).vertices ?? []).length;
    const bwi: any[] = Array.from(t.boneWeightAndIndices ?? []) as any[];
    const nbones = Math.max(1, (mb.bones ?? []).length);
    let override: [number[], number[]];
    if (bwi.length === 4 * n) {
      const ji: number[] = [];
      const jw: number[] = [];
      for (let vi = 0; vi < n; vi++) {
        const js: number[] = [];
        const ws: number[] = [];
        for (let k = 0; k < 4; k++) {
          const u = Math.trunc(Number(bwi[vi * 4 + k])) >>> 0;
          let bi = u & 0xffff;
          let wt = ((u >>> 16) & 0xffff) / 65535.0;
          if (bi >= nbones) {
            bi = 0;
            wt = 0.0;
          }
          js.push(bi);
          ws.push(wt);
        }
        const sw = ws.reduce((a, b) => a + b, 0);
        if (sw > 1e-6) {
          for (let k = 0; k < 4; k++) ws[k] = ws[k] / sw;
        } else {
          js.splice(0, 4, 0, 0, 0, 0);
          ws.splice(0, 4, 1.0, 0.0, 0.0, 0.0);
        }
        ji.push(...js);
        jw.push(...ws);
      }
      override = [ji, jw];
    } else {
      const ji = new Array<number>(4 * n).fill(0);
      const jw: number[] = [];
      for (let vi = 0; vi < n; vi++) jw.push(1.0, 0.0, 0.0, 0.0);
      override = [ji, jw];
    }
    exp.add_skinned(
      "face",
      mb.m_GameObject,
      mesh,
      mb.bones ?? [],
      mb.bindposes ?? [],
      mats,
      "face_geo",
      shapes,
      override,
    );
    exp.meta.faceBlendShapeCount = shapes.length;
  }

  // Also export character ramp texture from t_chr_amao-base-0000 if not already referenced
  try {
    const base_tex_b = bundleFile("t_chr_amao-base-0000");
    for (const o of objectsOf(base_tex_b, "Texture2D")) {
      const tx = o.read() as Rec;
      if (String(tx.m_Name).endsWith("_rmp")) {
        exp.meta.rampMap = exp.texture_file(tx);
      }
    }
  } catch {
    /* ignore */
  }

  // ---------------- hair ----------------
  const hair_bundle = bundleFile(PARTS.hair);
  const [hair_root] = skeleton(find_root(hair_bundle), env());
  exp.emit_tree(hair_root, head_bone);
  const hair_renderers = objectsOf(hair_bundle, "SkinnedMeshRenderer");
  for (let i = 0; i < hair_renderers.length; i++) {
    const o = hair_renderers[i];
    const r = o.read() as Rec;
    const sf = o.assetsFile;
    const mesh = env().readPPtr(sf, r.m_Mesh)!;
    const mats = (r.m_Materials ?? []).map((m: any) => exp.material(env().readPPtr(sf, m)!, "hair"));
    exp.add_skinned(
      "hair" + String(i),
      r.m_GameObject,
      mesh,
      r.m_Bones ?? [],
      mesh.m_BindPose ?? [],
      mats,
      `hair_geo${i}`,
    );
  }

  // ---------------- ActorSwing colliders & dynamic spring bones ----------------
  const static_cols: any[] = [];
  const dyn_bones: any[] = [];
  const breast_bones: any[] = [];
  const swing_chains: any[] = [];
  for (const [part_tag, bdl] of [
    ["body", body_bundle],
    ["face", face_bundle],
    ["hair", hair_bundle],
  ] as Array<[string, BundleContainer]>) {
    const mb_to_node = new Map<string, number>();
    const mb_entries: Array<[string, number, any]> = [];
    for (const o of objectsOf(bdl, "MonoBehaviour")) {
      const mb = o.read() as Rec;
      let cls_name = "";
      try {
        const script = env().readPPtr(o.assetsFile, mb.m_Script);
        cls_name = String(script?.m_ClassName ?? "");
      } catch {
        continue;
      }
      const node_idx = exp.node_of_go.get(pkey(mb.m_GameObject.m_PathID));
      if (node_idx !== undefined) mb_to_node.set(pkey(o.path_id), node_idx);
      if (
        cls_name === "ActorSwingStaticBone" ||
        cls_name === "ActorSwingDynamicBone" ||
        cls_name === "ActorSwingBreastBone" ||
        cls_name === "ActorSwingChain"
      ) {
        if (node_idx !== undefined) mb_entries.push([cls_name, node_idx, o]);
      }
    }
    for (const [cls_name, node_idx, o] of mb_entries) {
      const bname: string = exp.meta.boneNodes[String(node_idx)] ?? "";
      const tt = o.read() as Rec;
      if (cls_name === "ActorSwingStaticBone") {
        const sc = tt.staticCollider || {};
        const va = sc.vector3_A || {};
        const vb = sc.vector3_B || {};
        static_cols.push({
          node: node_idx,
          name: bname,
          part: part_tag,
          type: Math.trunc(sc.type ?? 0),
          mask: Math.trunc(sc.collisionMask ?? 0),
          vA: [Number(va.x ?? 0.0), Number(va.y ?? 0.0), Number(va.z ?? 0.0)],
          vB: [Number(vb.x ?? 0.0), Number(vb.y ?? 0.0), Number(vb.z ?? 0.0)],
          rA: Number(sc.float_A ?? 0.0),
          rB: Number(sc.float_B ?? 0.0),
        });
      } else if (cls_name === "ActorSwingDynamicBone") {
        const dc = tt.dynamicCollider || {};
        const va = dc.vector3_A || {};
        const vb = dc.vector3_B || {};
        const lim = tt.limitInfo || {};
        const lx = lim.axisX || {};
        const ly = lim.axisY || {};
        const lz = lim.axisZ || {};
        dyn_bones.push({
          node: node_idx,
          name: bname,
          part: part_tag,
          dynamicType: Math.trunc(tt.dynamicType ?? 0),
          damping: Number(tt.damping ?? 0.5),
          stiffness: Number(tt.stiffness ?? 0.1),
          spring: Number(tt.spring ?? 0.0),
          pendulum: Number(tt.pendulum ?? 0.0),
          pendulumRange: Number(tt.pendulumRange ?? 1.0),
          mass: Number(tt.mass ?? 0.0),
          rootWeight: Number(tt.rootWeight ?? 0.3),
          colType: Math.trunc(dc.type ?? 0),
          mask: Math.trunc(dc.collisionMask ?? 0),
          offset: [Number(va.x ?? 0.0), Number(va.y ?? 0.0), Number(va.z ?? 0.0)],
          vB: [Number(vb.x ?? 0.0), Number(vb.y ?? 0.0), Number(vb.z ?? 0.0)],
          radius: Number(dc.float_A ?? 0.0),
          radiusSub: Number(dc.float_B ?? 0.0),
          useLimit: Math.trunc(lim.useLimit ?? 0),
          limitX: [Number(lx.x ?? -180), Number(lx.y ?? 180)],
          limitY: [Number(ly.x ?? -180), Number(ly.y ?? 180)],
          limitZ: [Number(lz.x ?? -180), Number(lz.y ?? 180)],
        });
      } else if (cls_name === "ActorSwingBreastBone") {
        const bc = tt.breastCollider || {};
        breast_bones.push({
          node: node_idx,
          name: bname,
          radius: Number(bc.float_A ?? 0.05),
          mask: Math.trunc(bc.collisionMask ?? -1),
          damping: Number(tt.damping ?? 0.24),
          stiffness: Number(tt.stiffness ?? 0.08),
          spring: Number(tt.spring ?? 1.0),
          leftLowerArm: exp.node_of_t.get(pkey((tt.leftLowerArm || {}).m_PathID ?? 0)) ?? -1,
          rightLowerArm: exp.node_of_t.get(pkey((tt.rightLowerArm || {}).m_PathID ?? 0)) ?? -1,
          leftBreast: exp.node_of_t.get(pkey((tt.leftBreast || {}).m_PathID ?? 0)) ?? -1,
          rightBreast: exp.node_of_t.get(pkey((tt.rightBreast || {}).m_PathID ?? 0)) ?? -1,
          leftBreastEnd: exp.node_of_t.get(pkey((tt.leftBreastEnd || {}).m_PathID ?? 0)) ?? -1,
          rightBreastEnd: exp.node_of_t.get(pkey((tt.rightBreastEnd || {}).m_PathID ?? 0)) ?? -1,
        });
      } else if (cls_name === "ActorSwingChain") {
        const root_nodes: number[] = [];
        for (const p of tt.rootBones ?? []) {
          const idx = mb_to_node.get(pkey(p.m_PathID));
          if (idx !== undefined) root_nodes.push(idx);
        }
        const layers: any[] = [];
        for (const ly of (tt.chains || {}).layers ?? []) {
          const lnodes: number[] = [];
          for (const p of ly.bones ?? []) {
            const idx = mb_to_node.get(pkey(p.m_PathID));
            if (idx !== undefined) lnodes.push(idx);
          }
          layers.push({
            active: Math.trunc(ly.active ?? 0),
            around: Math.trunc(ly.around ?? 0),
            radius: Number(ly.radius ?? 0.015),
            smoothing: Number(ly.smoothing ?? 0.0),
            nodes: lnodes,
          });
        }
        swing_chains.push({
          node: node_idx,
          name: bname,
          part: part_tag,
          rootNodes: root_nodes,
          layers,
        });
      }
    }
  }
  exp.meta.swing = {
    staticColliders: static_cols,
    dynamicBones: dyn_bones,
    breastBones: breast_bones,
    chains: swing_chains,
  };

  // ---------------- humanoid map ----------------
  for (const [hname, bname] of Object.entries(HUMANOID)) {
    const nid = exp.node_by_name.get(bname);
    if (nid !== undefined) exp.meta.humanoid[hname] = nid;
  }
  exp.meta.missingHumanoid = Object.keys(HUMANOID).filter((h) => !(h in exp.meta.humanoid));

  mkdirSync(OUT, { recursive: true });
  exp.glb.save(path.join(OUT, "char.glb"));
  writeFileSync(path.join(OUT, "char.json"), jdump(exp.meta), "utf8");
  console.log(
    "nodes",
    exp.glb.json.nodes.length,
    "meshes",
    exp.glb.json.meshes.length,
    "skins",
    exp.glb.json.skins.length,
    "textures",
    exp.tex_done.size,
  );
  console.log("missing humanoid", exp.meta.missingHumanoid);
}

main();
