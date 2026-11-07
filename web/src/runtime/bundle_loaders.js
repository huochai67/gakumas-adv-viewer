/**
 * Browser runtime asset builders.
 *
 * Runs the exact export logic from `pipeline/export_char.ts`,
 * `pipeline/export_env.ts`, `pipeline/export_bg.ts`, `pipeline/export_clips.ts`
 * and `pipeline/export_voices.ts` directly against the in-memory
 * `BrowserAssetEnv`, replacing every disk write with in-memory buffers:
 *
 *   - textures are decoded to RGBA8 by `gakumas_core.wasm`
 *   - GLBs are returned as `Uint8Array`
 *   - voices are decoded to a WAV blob URL plus 60 Hz AIUEO frames
 */

import { decodeTextureRgba, decodeHcaAndLipsync } from './wasm_bridge.js';
import {
  skeleton,
  localTrs,
  meshData,
  Glb,
  crc32,
  bindingDimension,
  ClipSampler,
  extractAcbHcaStreams,
} from './bundle_env.js';
import { setSwingChainRestLengths } from './swing_metadata.js';
import { ANIMATION_MANAGE_DEFAULTS, ANIMATION_MANAGE_FIELDS } from '../engine/animation_manage.js';

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function toBytes(value) {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

function pkey(pid) {
  return String(pid ?? 0);
}

function pidIsZero(p) {
  if (p === undefined || p === null) return true;
  return typeof p === 'bigint' ? p === 0n : Number(p) === 0;
}

function pidKey(p) {
  return String(p);
}

function convV(v) {
  return [v[0], v[1], -v[2]];
}

function convQ(q) {
  return [q[0], q[1], -q[2], -q[3]];
}

/** Unity Matrix4x4f -> glTF column-major list with the z flip applied. */
function matConvertRows(m) {
  const rows = [[], [], [], []];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) rows[r][c] = Number(m[`e${r}${c}`] ?? 0);
  }
  const s = [1.0, 1.0, -1.0, 1.0];
  const out = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) out.push(rows[r][c] * s[r] * s[c]);
  }
  return out;
}

function roundN(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function round5(v) {
  return Math.round(v * 1e5) / 1e5;
}

function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}

/** Python's round(): ties to even. */
function pyRound(v) {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Decode a Unity `Texture2D` (UnityObject wrapper or read typetree record)
 * into `{ name, width, height, data }` with top-down RGBA8 pixels.
 */
function decodeTexture(env, tex) {
  const tt = typeof tex.read === 'function' ? tex.read() : tex;
  const name = String(tt.m_Name ?? '');
  const width = Number(tt.m_Width);
  const height = Number(tt.m_Height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`texture ${name || '<unnamed>'} has invalid size ${tt.m_Width}x${tt.m_Height}`);
  }

  let imageData = toBytes(tt['image data'] ?? tt.m_ImageData);
  const streamData = tt.m_StreamData;
  if (imageData.length === 0 && streamData && streamData.path) {
    const sf = tex.assetsFile ?? tex._assetsFile ?? tt._assetsFile;
    if (!sf) throw new Error(`texture ${name} has stream data but no assets file`);
    imageData = toBytes(env.getResourceData(sf, streamData));
  }
  if (imageData.length === 0) throw new Error(`texture ${name} has no image data`);

  const format = Number(tt.m_TextureFormat) | 0;
  const data = decodeTextureRgba(imageData, width, height, format, true);
  return { name, width, height, data };
}

class LazyTextureMap extends Map {
  constructor(env) {
    super();
    this.env = env;
    this._lazy = new Map();
  }
  register(rel, name, tex) {
    const item = { rel, name, tex };
    this._lazy.set(rel, item);
    this._lazy.set(name, item);
  }
  has(key) {
    return super.has(key) || this._lazy.has(key);
  }
  get(key) {
    if (super.has(key)) return super.get(key);
    const pending = this._lazy.get(key);
    if (!pending) return undefined;
    const decoded = decodeTexture(this.env, pending.tex);
    const entry = { data: decoded.data, width: decoded.width, height: decoded.height };
    super.set(pending.rel, entry);
    super.set(pending.name, entry);
    return entry;
  }
}

/* -------------------------------------------------------------------------- */
/* Character build (pipeline/export_char.ts)                                  */
/* -------------------------------------------------------------------------- */

export const PARTS = {
  body: 'mdl_chr_amao-casl-0000_body',
  face: 'mdl_chr_amao-base-0000_face',
  hair: 'mdl_chr_amao-base-0000_hair',
};
const RAMP_BUNDLE = 't_chr_amao-base-0000';

const HUMANOID = {
  Hips: 'Hips',
  Spine: 'Spine',
  Chest: 'Spine1',
  UpperChest: 'Spine2',
  Neck: 'Neck',
  Head: 'Head',
  LeftShoulder: 'LeftShoulder',
  LeftUpperArm: 'LeftArm',
  LeftLowerArm: 'LeftForeArm',
  LeftHand: 'LeftHand',
  RightShoulder: 'RightShoulder',
  RightUpperArm: 'RightArm',
  RightLowerArm: 'RightForeArm',
  RightHand: 'RightHand',
  LeftUpperLeg: 'LeftUpLeg',
  LeftLowerLeg: 'LeftLeg',
  LeftFoot: 'LeftFoot',
  LeftToes: 'LeftToeBase',
  RightUpperLeg: 'RightUpLeg',
  RightLowerLeg: 'RightLeg',
  RightFoot: 'RightFoot',
  RightToes: 'RightToeBase',
  LeftEye: 'LeftEye',
  RightEye: 'RightEye',
};
const FINGERS = {
  Thumb: 'Thumb',
  Index: 'Index',
  Middle: 'Middle',
  Ring: 'Ring',
  Little: 'Pinky',
};
for (const side of ['Left', 'Right']) {
  for (const [fname, bone] of Object.entries(FINGERS)) {
    ['Proximal', 'Intermediate', 'Distal'].forEach((seg, i) => {
      HUMANOID[`${side}${fname}${seg}`] = `${side}Hand${bone}${i + 1}`;
    });
  }
}

class CharExporter {
  constructor(env) {
    this.env = env;
    this.glb = new Glb();
    this.node_of_t = new Map();
    this.node_of_go = new Map();
    this.node_by_name = new Map();
    this.meta = { materials: {}, parts: {}, humanoid: {}, boneNodes: {} };
    this.tex_done = new Map();
    this.textures = new LazyTextureMap(env);
    this.glb_mat = new Map();
  }

  // ---------- textures / materials ----------
  texture_file(tex) {
    const tt = typeof tex.read === 'function' ? tex.read() : tex;
    const name = tt.m_Name;
    const done = this.tex_done.get(name);
    if (done !== undefined) return done;

    const rel = `tex/${name}.png`;
    this.textures.register(rel, name, tex);
    this.tex_done.set(name, rel);
    return rel;
  }

  material(mat, part) {
    const entry = {
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
      let tex = null;
      try {
        tex = this.env.readPPtr(sf, te.m_Texture);
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
    const doubleSided = entry.floats['_Cull'] === 0;
    const alphaClip = entry.floats['_AlphaClip'] ?? 0.0;
    const alphaMode = alphaClip >= 0.5 ? 'MASK' : null;
    // Deliberately no baseColorTexture: the runtime builds materials from
    // meta.materials + the in-memory texture map, and GLTFLoader must not fetch
    // tex/*.png over HTTP.
    this.glb_mat.set(
      key,
      this.glb.material(key, null, undefined, doubleSided, alphaMode ?? undefined),
    );
    return key;
  }

  // ---------- nodes ----------
  emit_tree(node, parentIndex) {
    const [p, q, s] = localTrs(node.transform);
    const idx = this.glb.node(node.name, [convV(p), convQ(q), [...s]], parentIndex);
    this.node_of_t.set(pkey(node.path_id), idx);
    this.node_of_go.set(pkey(node.go), idx);
    if (!this.node_by_name.has(node.name)) this.node_by_name.set(node.name, idx);
    this.meta.boneNodes[String(idx)] = node.name;
    if (!this.meta.nodeByPathId) this.meta.nodeByPathId = {};
    this.meta.nodeByPathId[pkey(node.path_id)] = idx;
    if (!this.meta.nodeByName) this.meta.nodeByName = {};
    if (!(node.name in this.meta.nodeByName)) this.meta.nodeByName[node.name] = idx;
    for (const c of node.children) this.emit_tree(c, idx);
    return idx;
  }

  // ---------- meshes ----------
  build_primitives(md, joint_count, weights_override, blend_shapes, mat_keys) {
    const verts = md.vertices ?? [];
    const normals = md.normals ?? [];
    const n = verts.length;
    const pos = [];
    const nrm = [];
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
    const uv = [];
    const uvs0 = md.uv0 ?? [];
    for (let i = 0; i < n; i++) {
      if (i < uvs0.length) {
        const [u0, v0] = uvs0[i];
        uv.push(u0, 1.0 - v0);
      } else {
        uv.push(0.0, 0.0);
      }
    }
    const attrs = {
      POSITION: this.glb.floats(pos, 'VEC3'),
      NORMAL: this.glb.floats(nrm, 'VEC3'),
      TEXCOORD_0: this.glb.floats(uv, 'VEC2'),
    };
    const tlist = md.tangents ?? [];
    if (tlist.length) {
      const tan = [];
      for (let i = 0; i < n; i++) {
        if (i < tlist.length) {
          const t = tlist[i];
          const tx = t[0];
          const ty = t[1];
          const tz = -t[2];
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
      attrs.TANGENT = this.glb.floats(tan, 'VEC4');
    }
    const clist = md.colors ?? [];
    if (clist.length) {
      let is_byte = false;
      for (const c of clist.slice(0, 64)) {
        if (ArrayBuffer.isView(c)) {
          is_byte = true;
          break;
        }
        for (const x of c) {
          if (typeof x === 'number' && x > 1.001) {
            is_byte = true;
            break;
          }
        }
        if (is_byte) break;
      }
      const scale = is_byte ? 1.0 / 255.0 : 1.0;
      const col = [];
      for (let i = 0; i < n; i++) {
        if (i < clist.length) {
          const c = clist[i];
          col.push(Number(c[0]) * scale, Number(c[1]) * scale, Number(c[2]) * scale, Number(c[3]) * scale);
        } else {
          col.push(0.0, 0.0, 0.0, 1.0);
        }
      }
      attrs.COLOR_0 = this.glb.floats(col, 'VEC4');
    }
    const uvs1 = md.uv1 ?? [];
    if (uvs1.length) {
      const uv1 = [];
      for (let i = 0; i < n; i++) {
        if (i < uvs1.length) {
          const [u1, v1] = uvs1[i];
          uv1.push(u1, 1.0 - v1);
        } else {
          uv1.push(0.0, 0.0);
        }
      }
      attrs.TEXCOORD_1 = this.glb.floats(uv1, 'VEC2');
    }
    let ji = null;
    let jw = null;
    const bones = md.bones ?? [];
    const weights = md.weights ?? [];
    if (weights_override !== undefined && weights_override !== null) {
      ji = weights_override[0];
      jw = weights_override[1];
    } else if (bones.length && weights.length) {
      ji = [];
      jw = [];
      for (let i = 0; i < n; i++) {
        const bi = bones[i];
        const bw = weights[i];
        const ws = Array.isArray(bw) || ArrayBuffer.isView(bw) ? Array.from(bw).slice(0, 4) : [bw];
        const js = Array.isArray(bi) || ArrayBuffer.isView(bi) ? Array.from(bi).slice(0, 4) : [bi];
        while (js.length < 4) js.push(0);
        while (ws.length < 4) ws.push(0.0);
        const s = ws.reduce((a, b) => a + b, 0) || 1.0;
        for (const x of js) ji.push(Math.trunc(x));
        for (const w of ws) jw.push(w / s);
      }
    }
    if (ji !== null && jw !== null) {
      attrs.JOINTS_0 = this.glb.ushorts(ji, 'VEC4');
      attrs.WEIGHTS_0 = this.glb.floats(jw, 'VEC4');
    }

    let targets = null;
    let out_weights = null;
    if (blend_shapes && blend_shapes.length) {
      targets = [];
      out_weights = [];
      for (const [bsName, deltas] of blend_shapes) {
        const idxs = Array.from(deltas.keys()).sort((a, b) => a - b);
        const vals = [];
        for (const vi of idxs) {
          const d = deltas.get(vi);
          const v = convV(d);
          vals.push(v[0], v[1], v[2]);
        }
        const acc = this.glb.sparseFloatAccessor(n, 'VEC3', idxs, vals);
        targets.push({ POSITION: acc });
        out_weights.push(0.0);
      }
    }

    const prims = [];
    const submeshes = md.submeshes ?? [];
    const triangles = md.triangles ?? [];
    for (let si = 0; si < submeshes.length; si++) {
      const start = submeshes[si][0];
      const count = submeshes[si][1];
      const flat = [];
      for (const tri of triangles.slice(start, start + count)) {
        flat.push(tri[0], tri[2], tri[1]);
      }
      if (!flat.length) continue;
      const acc = this.glb.uints(flat, 'SCALAR');
      let mi;
      if (mat_keys && mat_keys.length) {
        mi = this.glb_mat.get(mat_keys[Math.min(si, mat_keys.length - 1)]);
      }
      prims.push(this.glb.primitive({ ...attrs }, acc, mi, targets === null ? undefined : targets));
    }
    return [prims, out_weights];
  }

  add_skinned(part_name, parent_go, mesh, joints, bond_matrices, materials, name, blend_shapes, weights_override) {
    const md = meshData(mesh, this.env);
    const joint_nodes = [];
    for (const t of joints) {
      const pid = pkey(t.m_PathID);
      const nodeIdx = this.node_of_t.get(pid);
      if (nodeIdx === undefined) throw new Error(`joint path_id ${String(t.m_PathID)} missing for ${name}`);
      joint_nodes.push(nodeIdx);
    }
    const ibm = [];
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
      name + '_mesh',
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

function findRoot(env, bundle) {
  let fallback = null;
  for (const o of env.objectsOf(bundle, 'Transform')) {
    const t = o.read();
    if (BigInt(t.m_Father?.m_PathID ?? 0) !== 0n) continue;
    const go = env.readPPtr(o.assetsFile, t.m_GameObject);
    const name = String(go?.m_Name ?? '');
    if (name.startsWith('mdl_')) return o;
    if (!fallback) fallback = o;
  }
  if (!fallback) throw new Error('no root transform');
  return fallback;
}

/**
 * Build the character GLB + metadata + in-memory RGBA textures from the three
 * character bundles.
 */
export async function buildCharFromBundles(env, parts = PARTS) {
  const activeParts = {
    body: parts?.body || PARTS.body,
    face: parts?.face || PARTS.face,
    hair: parts?.hair || PARTS.hair,
  };
  await Promise.all([
    env.ensureBundle(activeParts.body, true),
    env.ensureBundle(activeParts.face, true),
    env.ensureBundle(activeParts.hair, true),
  ]);
  const actorMatch = /^mdl_chr_([a-z0-9]+)-/i.exec(activeParts.face) || /^mdl_chr_([a-z0-9]+)-/i.exec(activeParts.body);
  const rampBundle = actorMatch ? `t_chr_${actorMatch[1]}-base-0000` : RAMP_BUNDLE;
  if (env.hasBundle(rampBundle)) {
    try {
      await env.ensureBundle(rampBundle, true);
    } catch {
      // optional ramp bundle
    }
  }

  const exp = new CharExporter(env);
  const body_bundle = env.bundleFile(activeParts.body);
  // ---------------- body ----------------
  const [body_root] = skeleton(findRoot(env, body_bundle), env);
  const actor = exp.glb.node('actor');
  const body_idx = exp.emit_tree(body_root, actor);
  // the body root node is the actor root itself
  const gltfNodes = exp.glb.json.nodes;
  if (!gltfNodes[actor].children) gltfNodes[actor].children = [];
  const ci = gltfNodes[actor].children.indexOf(body_idx);
  if (ci >= 0) gltfNodes[actor].children.splice(ci, 1);
  exp.glb.json.scenes[0].nodes = [body_idx];
  gltfNodes[body_idx].name = 'actor';

  for (const o of env.objectsOf(body_bundle, 'SkinnedMeshRenderer')) {
    const r = o.read();
    const sf = o.assetsFile;
    const mesh = env.readPPtr(sf, r.m_Mesh);
    const mats = (r.m_Materials ?? []).map((m) => exp.material(env.readPPtr(sf, m), 'body'));
    exp.add_skinned(
      'body',
      r.m_GameObject,
      mesh,
      r.m_Bones ?? [],
      mesh.m_BindPose ?? [],
      mats,
      'body_geo',
    );
  }

  // Export body IK correction settings; Quartz waits until all part nodes exist.
  const ik_colliders = [];
  const ik_goals = [];
  for (const o of env.objectsOf(body_bundle, 'MonoBehaviour')) {
    const mb = o.read();
    const sf = o.assetsFile;
    let cls_name = '';
    try {
      const script = env.readPPtr(sf, mb.m_Script);
      cls_name = String(script?.m_ClassName ?? '');
    } catch {
      cls_name = '';
    }
    const tt = mb;
    const go_pid = mb.m_GameObject.m_PathID;
    const node_idx = exp.node_of_go.get(pkey(go_pid));
    if (node_idx === undefined || node_idx === null) continue;
    const bname = exp.meta.boneNodes[String(node_idx)] ?? '';
    if (cls_name === 'ActorAnimationIKCorrectionCollider') {
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
    } else if (cls_name === 'ActorAnimationIKCorrectionGoal') {
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
  exp.meta.ikCorrection = { colliders: ik_colliders, goals: ik_goals };
  const head_bone = exp.node_by_name.get('Head');
  if (head_bone === undefined) throw new Error('Head bone not found');

  // ---------------- face ----------------
  const face_bundle = env.bundleFile(activeParts.face);
  const [face_root] = skeleton(findRoot(env, face_bundle), env);
  exp.emit_tree(face_root, head_bone);

  for (const o of env.objectsOf(face_bundle, 'MonoBehaviour')) {
    const t = o.read();
    if (t.curves !== undefined && t.blendShapeIndices !== undefined) {
      exp.meta.faceCorrection = {
        indices: (t.blendShapeIndices ?? []).map((x) => Math.trunc(x)),
        curves: (t.curves ?? []).map((cv) =>
          (cv.m_Curve ?? []).map((k) => ({ t: Number(k.time), v: Number(k.value) })),
        ),
      };
      continue;
    }
    if (t.blendShapes === undefined || !t.mesh) continue;
    const mb = t;
    const sf = o.assetsFile;
    const mesh = env.readPPtr(sf, mb.mesh);
    if (!mesh) continue;
    const mats = (mb.sharedMaterials ?? []).map((m) => exp.material(env.readPPtr(sf, m), 'face'));
    const shapes = [];
    for (const bs of mb.blendShapes ?? []) {
      const deltas = new Map();
      for (const v of bs.blendShapeVertices ?? []) {
        deltas.set(Math.trunc(v.vertIndex), [v.position.x, v.position.y, v.position.z]);
      }
      shapes.push([String(bs.blendShapeName), deltas]);
    }
    const n = (meshData(mesh, env).vertices ?? []).length;
    const bwi = Array.from(t.boneWeightAndIndices ?? []);
    const nbones = Math.max(1, (mb.bones ?? []).length);
    let override;
    if (bwi.length === 4 * n) {
      const ji = [];
      const jw = [];
      for (let vi = 0; vi < n; vi++) {
        const js = [];
        const ws = [];
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
      const ji = new Array(4 * n).fill(0);
      const jw = [];
      for (let vi = 0; vi < n; vi++) jw.push(1.0, 0.0, 0.0, 0.0);
      override = [ji, jw];
    }
    exp.add_skinned(
      'face',
      mb.m_GameObject,
      mesh,
      mb.bones ?? [],
      mb.bindposes ?? [],
      mats,
      'face_geo',
      shapes,
      override,
    );
    exp.meta.faceBlendShapeCount = shapes.length;
  }

  // Also export character ramp texture from t_chr_amao-base-0000 if not already referenced
  if (env.hasBundle(rampBundle)) {
    try {
      const base_tex_b = env.bundleFile(rampBundle);
      for (const o of env.objectsOf(base_tex_b, 'Texture2D')) {
        const tx = o.read();
        if (String(tx.m_Name).endsWith('_rmp')) {
          exp.meta.rampMap = exp.texture_file(tx);
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ---------------- hair ----------------
  const hair_bundle = env.bundleFile(activeParts.hair);
  const [hair_root] = skeleton(findRoot(env, hair_bundle), env);
  exp.emit_tree(hair_root, head_bone);
  const hair_renderers = env.objectsOf(hair_bundle, 'SkinnedMeshRenderer');
  for (let i = 0; i < hair_renderers.length; i++) {
    const o = hair_renderers[i];
    const r = o.read();
    const sf = o.assetsFile;
    const mesh = env.readPPtr(sf, r.m_Mesh);
    const mats = (r.m_Materials ?? []).map((m) => exp.material(env.readPPtr(sf, m), 'hair'));
    exp.add_skinned(
      'hair' + String(i),
      r.m_GameObject,
      mesh,
      r.m_Bones ?? [],
      mesh.m_BindPose ?? [],
      mats,
      `hair_geo${i}`,
    );
  }
  // Native Quartz references are GameObject PPtrs, not Transform PPtrs.
  const qdrivers = [];
  for (const [part, bundle] of [['body', body_bundle], ['face', face_bundle], ['hair', hair_bundle]]) {
    for (const o of env.objectsOf(bundle, 'MonoBehaviour')) {
      const mb = o.read();
      const script = env.readPPtr(o.assetsFile, mb.m_Script);
      const type = String(script?.m_ClassName ?? '');
      if (!/^ActorAnimationQuartzDriver(?:Rotation|Frill|Skirt|Hair|HumanoidHand|HumanoidSleeve|HumanoidUpLeg|HumanoidArm|Waist|Furisode|Poncho)Bone$/.test(type) || mb.setting === undefined) continue;
      const node = exp.node_of_go.get(pkey(mb.m_GameObject.m_PathID));
      if (node === undefined) continue;
      const setting = { ...mb.setting };
      for (const [key, value] of Object.entries(setting)) {
        if (value !== null && typeof value === 'object' && 'm_PathID' in value) {
          setting[key] = exp.node_of_go.get(pkey(value.m_PathID)) ?? -1;
        }
      }
      qdrivers.push({ node, name: exp.meta.boneNodes[String(node)] ?? '', type,
        part, enabled: Boolean(mb.m_Enabled ?? true), setting });
    }
  }
  exp.meta.quartzDrivers = qdrivers;


  // ---------------- ActorSwing colliders & dynamic spring bones ----------------
  // Keep serialized modeling poses in Unity coordinates; solvers convert on initialization.
  // Defaults follow native .ctors: DynamicBone 0x1809B3430, BreastBone 0x1809B24C0,
  // Collider 0x1809CF8A0, ChainLayerInfo 0x1809B3FF0; uninitialized poses stay zero.
  const swingVector = (v) => [Number(v?.x ?? 0), Number(v?.y ?? 0), Number(v?.z ?? 0)];
  const swingQuaternion = (rotation) => {
    const q = rotation?.value ?? rotation;
    return [Number(q?.x ?? 0), Number(q?.y ?? 0), Number(q?.z ?? 0), Number(q?.w ?? 0)];
  };
  const swingModelingTransform = (t) => ({
    localPosition: swingVector(t?.localPosition),
    localRotation: swingQuaternion(t?.localRotation),
    position: swingVector(t?.position),
    rotation: swingQuaternion(t?.rotation),
  });
  const swingCurve = (curve) =>
    curve == null ? null : (curve.m_Curve ?? []).map((key) =>
      Object.fromEntries(Object.entries(key).map(([name, value]) => [name, Number(value)])),
    );
  const static_cols = [];
  const dyn_bones = [];
  const breast_bones = [];
  const swing_chains = [];
  for (const [part_tag, bdl] of [
    ['body', body_bundle],
    ['face', face_bundle],
    ['hair', hair_bundle],
  ]) {
    const mb_to_node = new Map();
    const mb_entries = [];
    for (const o of env.objectsOf(bdl, 'MonoBehaviour')) {
      const mb = o.read();
      let cls_name = '';
      try {
        const script = env.readPPtr(o.assetsFile, mb.m_Script);
        cls_name = String(script?.m_ClassName ?? '');
      } catch {
        continue;
      }
      const node_idx = exp.node_of_go.get(pkey(mb.m_GameObject.m_PathID));
      if (node_idx !== undefined) mb_to_node.set(pkey(o.path_id), node_idx);
      if (
        cls_name === 'ActorSwingStaticBone' ||
        cls_name === 'ActorSwingDynamicBone' ||
        cls_name === 'ActorSwingBreastBone' ||
        cls_name === 'ActorSwingChain'
      ) {
        if (node_idx !== undefined) mb_entries.push([cls_name, node_idx, o]);
      }
    }
    for (const [cls_name, node_idx, o] of mb_entries) {
      const bname = exp.meta.boneNodes[String(node_idx)] ?? '';
      const tt = o.read();
      if (cls_name === 'ActorSwingStaticBone') {
        const sc = tt.staticCollider || {};
        const va = sc.vector3_A || {};
        const vb = sc.vector3_B || {};
        static_cols.push({
          node: node_idx,
          name: bname,
          part: part_tag,
          enabled: Boolean(tt.m_Enabled ?? true),
          type: Math.trunc(Number(sc.type ?? 0)),
          mask: Math.trunc(Number(sc.collisionMask ?? -1)),
          ignoreMask: Math.trunc(Number(sc.seatDynamicCorrectionDisableCollisionMask ?? 0)),
          vA: [Number(va.x ?? 0.0), Number(va.y ?? 0.0), Number(va.z ?? 0.0)],
          vB: [Number(vb.x ?? 0.0), Number(vb.y ?? 0.0), Number(vb.z ?? 0.0)],
          rA: Number(sc.float_A ?? 0.05),
          rB: Number(sc.float_B ?? 0.05),
        });
      } else if (cls_name === 'ActorSwingDynamicBone') {
        const dc = tt.dynamicCollider || {};
        const va = dc.vector3_A || {};
        const vb = dc.vector3_B || {};
        const lim = tt.limitInfo || {};
        const lx = lim.axisX || {};
        const ly = lim.axisY || {};
        const lz = lim.axisZ || {};
        const reference = tt.referenceLimitInfo;
        const referenceKey = pkey(reference?.bone?.m_PathID ?? 0);
        dyn_bones.push({
          node: node_idx,
          name: bname,
          part: part_tag,
          enabled: Boolean(tt.m_Enabled ?? true),
          resetType: Math.trunc(Number(tt.resetType ?? 0)),
          dynamicType: Math.trunc(Number(tt.dynamicType ?? 0)),
          damping: Number(tt.damping ?? 0.5),
          stiffness: Number(tt.stiffness ?? 0.05),
          spring: Number(tt.spring ?? 0.0),
          pendulum: Number(tt.pendulum ?? 0.0),
          pendulumRange: Number(tt.pendulumRange ?? 1.0),
          mass: Number(tt.mass ?? 0.0),
          rootWeight: Number(tt.rootWeight ?? 1.0),
          axisAddXToY: Number(tt.axisAddXToY ?? 0),
          axisAddXToZ: Number(tt.axisAddXToZ ?? 0),
          wind: Number(tt.wind ?? 1),
          useWindGlobalForce: Boolean(tt.useWindGlobalForce ?? true),
          seatDynamicCorrection: Number(tt.seatDynamicCorrection ?? 0),
          colType: Math.trunc(Number(dc.type ?? 0)),
          mask: Math.trunc(Number(dc.collisionMask ?? -1)),
          offset: [Number(va.x ?? 0.0), Number(va.y ?? 0.0), Number(va.z ?? 0.0)],
          vB: [Number(vb.x ?? 0.0), Number(vb.y ?? 0.0), Number(vb.z ?? 0.0)],
          radius: Number(dc.float_A ?? 0.05),
          radiusSub: Number(dc.float_B ?? 0.05),
          useLimit: Math.trunc(Number(lim.useLimit ?? 0)),
          limitX: [Number(lx.x ?? -180), Number(lx.y ?? 180)],
          limitY: [Number(ly.x ?? -180), Number(ly.y ?? 180)],
          limitZ: [Number(lz.x ?? -180), Number(lz.y ?? 180)],
          referenceLimit: {
            node: mb_to_node.get(referenceKey) ?? exp.node_of_t.get(referenceKey) ?? -1,
            lower: {
              x: Boolean(reference?.min?.x ?? false),
              y: Boolean(reference?.min?.y ?? false),
              z: Boolean(reference?.min?.z ?? false),
            },
            upper: {
              x: Boolean(reference?.max?.x ?? false),
              y: Boolean(reference?.max?.y ?? false),
              z: Boolean(reference?.max?.z ?? false),
            },
          },
          modelingTransform: swingModelingTransform(tt.modelingTransform),
        });
      } else if (cls_name === 'ActorSwingBreastBone') {
        const bc = tt.breastCollider || {};
        const lim = tt.limitInfo || {};
        const lx = lim.axisX || {};
        const ly = lim.axisY || {};
        const lz = lim.axisZ || {};
        breast_bones.push({
          node: node_idx,
          name: bname,
          part: part_tag,
          enabled: Boolean(tt.m_Enabled ?? true),
          colType: Math.trunc(Number(bc.type ?? 0)),
          offset: swingVector(bc.vector3_A),
          vB: swingVector(bc.vector3_B),
          radiusSub: Number(bc.float_B ?? 0.05),
          ignoreMask: Math.trunc(Number(bc.seatDynamicCorrectionDisableCollisionMask ?? 0)),
          radius: Number(bc.float_A ?? 0.05),
          mask: Math.trunc(Number(bc.collisionMask ?? -1)),
          damping: Number(tt.damping ?? 0.5),
          stiffness: Number(tt.stiffness ?? 0.05),
          spring: Number(tt.spring ?? 0),
          pendulum: Number(tt.pendulum ?? 0),
          pendulumRange: Number(tt.pendulumRange ?? 0),
          average: Number(tt.average ?? 0),
          useLimit: Math.trunc(Number(lim.useLimit ?? 0)),
          limitX: [Number(lx.x ?? -180), Number(lx.y ?? 180)],
          limitY: [Number(ly.x ?? -180), Number(ly.y ?? 180)],
          limitZ: [Number(lz.x ?? -180), Number(lz.y ?? 180)],
          rootWeight: Number(tt.rootWeight ?? 1),
          useArmCorrection: Boolean(tt.useArmCorrection ?? true),
          leftLowerArm: exp.node_of_t.get(pkey((tt.leftLowerArm || {}).m_PathID ?? 0)) ?? -1,
          rightLowerArm: exp.node_of_t.get(pkey((tt.rightLowerArm || {}).m_PathID ?? 0)) ?? -1,
          leftBreast: exp.node_of_t.get(pkey((tt.leftBreast || {}).m_PathID ?? 0)) ?? -1,
          rightBreast: exp.node_of_t.get(pkey((tt.rightBreast || {}).m_PathID ?? 0)) ?? -1,
          leftBreastEnd: exp.node_of_t.get(pkey((tt.leftBreastEnd || {}).m_PathID ?? 0)) ?? -1,
          rightBreastEnd: exp.node_of_t.get(pkey((tt.rightBreastEnd || {}).m_PathID ?? 0)) ?? -1,
          modelingLeftTransform: swingModelingTransform(tt.modelingLeftTransform),
          modelingRightTransform: swingModelingTransform(tt.modelingRightTransform),
          modelingLeftEndTransform: swingModelingTransform(tt.modelingLeftEndTransform),
          modelingRightEndTransform: swingModelingTransform(tt.modelingRightEndTransform),
          upCurve: swingCurve(tt.upCurve),
          sideCurve: swingCurve(tt.sideCurve),
          ...(tt.upCurve && {
            upCurvePreInfinity: Number(tt.upCurve.m_PreInfinity),
            upCurvePostInfinity: Number(tt.upCurve.m_PostInfinity),
            upCurveRotationOrder: Number(tt.upCurve.m_RotationOrder),
          }),
          ...(tt.sideCurve && {
            sideCurvePreInfinity: Number(tt.sideCurve.m_PreInfinity),
            sideCurvePostInfinity: Number(tt.sideCurve.m_PostInfinity),
            sideCurveRotationOrder: Number(tt.sideCurve.m_RotationOrder),
          }),
        });
      } else if (cls_name === 'ActorSwingChain') {
        const root_nodes = [];
        for (const p of tt.rootBones ?? []) {
          const idx = mb_to_node.get(pkey(p.m_PathID));
          if (idx !== undefined) root_nodes.push(idx);
        }
        const layers = [];
        for (const ly of (tt.chains || {}).layers ?? []) {
          const lnodes = [];
          for (const p of ly.bones ?? []) {
            const idx = mb_to_node.get(pkey(p.m_PathID));
            lnodes.push(idx ?? -1);
          }
          layers.push({
            active: Math.trunc(Number(ly.active ?? 0)),
            around: Math.trunc(Number(ly.around ?? 0)),
            radius: Number(ly.radius ?? 0.05),
            smoothing: Number(ly.smoothing ?? 0.0),
            nodes: lnodes,
          });
        }
        swing_chains.push({
          node: node_idx,
          name: bname,
          part: part_tag,
          enabled: Boolean(tt.m_Enabled ?? true),
          rootNodes: root_nodes,
          layers,
        });
      }
    }
  }
  setSwingChainRestLengths(exp.glb.json.nodes, swing_chains);
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

  return { glbBytes: exp.glb.toGlb(), meta: exp.meta, textures: exp.textures };
}

/* -------------------------------------------------------------------------- */
/* 3D environment build (pipeline/export_env.ts)                              */
/* -------------------------------------------------------------------------- */

const SCENE = 'env_3d_adv_classroom-00-00-noon';
const SKY_BUNDLE = 't_sky_noon-00';
const ROOTS = new Set(['decal', 'stg-parts', 'eff', 'cmn-parts', 'Lighting&PostEffects']);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function matMul(a, b) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

function trs(p, q, s) {
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

function xform(m, v) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

function xformNormal(m, v) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

function conv(p) {
  return [p[0], p[1], -p[2]];
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function fmt3(v) {
  return v.toFixed(3);
}

class EnvExporter {
  constructor(env, bundle) {
    this.env = env;
    this.bundle = bundle;
    this.glb = new Glb();
    this.texDone = {};
    this.texIdx = {};
    this.matDone = {};
    this.buckets = new Map();
    this.lodSkipRenderers = new Set();
    this.colorOverrides = new Map();
    this.textures = new LazyTextureMap(env);
    this.meta = {
      materials: {},
      lightmap: {},
      lights: [],
      renderSettings: {},
      decals: [],
      volumes: {},
      skybox: null,
    };
    this.stats = { renderers: 0, verts: 0, tris: 0, skipped: 0, decals: 0 };
  }

  // ---------- textures ----------
  texture(tex) {
    const tt = typeof tex.read === 'function' ? tex.read() : tex;
    const name = tt.m_Name;
    if (!name || !(Number(tt.m_Width) > 0) || !(Number(tt.m_Height) > 0)) return null;
    if (!(name in this.texDone)) {
      const rel = `tex/${name}.png`;
      this.textures.register(rel, name, tex);
      this.texDone[name] = rel;
    }
    return this.texDone[name] ?? null;
  }

  material(mat, env) {
    const key = mat.m_Name;
    if (key in this.matDone) return this.matDone[key];
    const entry = {
      maps: {},
      colors: {},
      floats: {},
      renderQueue: Math.trunc(mat.m_CustomRenderQueue ?? -1),
    };
    const sf = mat._assetsFile;
    const saved = mat.m_SavedProperties ?? {};
    for (const pair of saved.m_TexEnvs ?? []) {
      const prop = pair?.[0];
      const te = pair?.[1];
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
    const baseColor = entry.colors['_BaseColor'] ?? [1, 1, 1, 1];
    // No baseColorTexture: story.js maps meta.materials[key].maps onto the
    // in-memory texture map, and GLTFLoader must not issue HTTP texture fetches.
    const glsm = this.glb.material(
      key,
      null,
      baseColor,
      entry.floats['_Cull'] === 0,
      (entry.floats['_AlphaClip'] ?? 0.0) >= 0.5 ? 'MASK' : null,
    );
    this.matDone[key] = glsm;
    return glsm;
  }

  // ---------- traversal ----------
  walk(node, parentM, out) {
    if (!node.active) return;
    const [p, q, s] = localTrs(node.transform);
    const m = matMul(parentM, trs(p, q, s));
    out.push([node, m]);
    for (const c of node.children) this.walk(c, m, out);
  }

  addRenderer(node, m, mf, mr, mrPid, env) {
    if (!(mr.m_Enabled ?? 1) || this.lodSkipRenderers.has(pidKey(mrPid))) {
      this.stats.skipped += 1;
      return;
    }
    let mesh = null;
    try {
      mesh = env.readPPtr(mf._assetsFile, mf.m_Mesh);
    } catch {
      this.stats.skipped += 1;
      return;
    }
    if (mesh === null || mesh === undefined) return;
    const md = meshData(mesh, env);
    const verts = md.vertices ?? [];
    if (!verts.length) return;
    const n = verts.length;
    const normals = md.normals ?? [];
    const uv0 = md.uv0 ?? [];
    const uv1 = md.uv1 ?? [];
    const vPos = [];
    const vNrm = [];
    const vUv0 = [];
    const vUv2 = [];
    let lm = mr.m_LightmapIndex ?? -1;
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
    for (let i = 0; i < n; i++) {
      const pw = conv(xform(m, verts[i]));
      vPos.push(pw[0], pw[1], pw[2]);
      if (i < normals.length) {
        const nn = xformNormal(m, normals[i]);
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

    const mats = [];
    const names = [];
    const mrSf = mr._assetsFile;
    for (const mp of mr.m_Materials ?? []) {
      try {
        const mo = env.readPPtr(mrSf, mp);
        if (mo === null) throw new Error('missing material');
        mats.push(this.material(mo, env));
        names.push(mo.m_Name);
      } catch {
        mats.push(null);
        names.push('');
      }
    }

    const ovrMap = this.colorOverrides.get(pidKey(node.go)) ?? new Map();
    const submeshes = md.submeshes ?? [];
    for (let si = 0; si < submeshes.length; si++) {
      const sub = submeshes[si];
      const start = Array.isArray(sub) ? sub[0] : sub.start;
      const count = Array.isArray(sub) ? sub[1] : sub.count;
      const tris = (md.triangles ?? []).slice(start, start + count);
      if (!tris.length) continue;
      const k = names.length ? Math.min(si, names.length - 1) : 0;
      const mname = names.length ? names[k] : 'default';
      const glsm = mats.length ? mats[k] : null;
      const ovr = ovrMap.get(k) ?? null;
      const ovrTag = ovr !== null
        ? `${fmt3(ovr[0])}_${fmt3(ovr[1])}_${fmt3(ovr[2])}_${fmt3(ovr[3])}`
        : '1';
      const bkey = `${mname}|${lm >= 0 ? 'lm' : 'lit'}|${ovrTag}`;
      let bkt = this.buckets.get(bkey);
      if (bkt === undefined) {
        bkt = {
          material: mname,
          glsm,
          lightmap: lm >= 0,
          overrideColor: ovr,
          pos: [],
          nrm: [],
          uv0: [],
          uv2: [],
          idx: [],
          vcount: 0,
        };
        this.buckets.set(bkey, bkt);
      }
      const remap = new Map();
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
          }
        }
        const ia = remap.get(a), ib = remap.get(b), ic = remap.get(c);
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
  world(t, env) {
    const chain = [];
    let cur = t;
    let guard = 0;
    while (cur !== null && guard < 64) {
      chain.push(cur);
      const f = cur.m_Father;
      const sf = cur._assetsFile;
      cur = f !== undefined && f !== null && !pidIsZero(f.m_PathID)
        ? (env.resolvePPtr(sf, f)?.read() ?? null)
        : null;
      guard += 1;
    }
    let m = IDENTITY.slice();
    for (let i = chain.length - 1; i >= 0; i--) {
      const [p, q, s] = localTrs(chain[i]);
      m = matMul(m, trs(p, q, s));
    }
    return m;
  }

  run() {
    const env = this.env;
    // scene roots
    const roots = [];
    for (const o of env.objectsOf(this.bundle, 'Transform')) {
      const t = o.read();
      if (pidIsZero(t.m_Father?.m_PathID)) {
        const go = env.readPPtr(o.assetsFile, t.m_GameObject);
        if (go && ROOTS.has(go.m_Name)) roots.push(o);
      }
    }
    // renderer lookup by GameObject path id
    // LODGroups: skip LOD1+ duplicate meshes
    for (const o of env.objectsOf(this.bundle, 'LODGroup')) {
      const tt = o.read();
      if (!(tt.m_Enabled ?? 1)) continue;
      const lods = tt.m_LODs ?? [];
      for (const lod of lods.slice(1)) {
        for (const rref of lod?.renderers ?? []) {
          const rpid = rref?.renderer?.m_PathID ?? 0;
          if (!pidIsZero(rpid)) this.lodSkipRenderers.add(pidKey(rpid));
        }
      }
    }

    // MonoBehaviours: OverrideBaseColor, DecalProjector, and Stage Volumes
    const rawDecals = [];
    for (const o of env.objectsOf(this.bundle, 'MonoBehaviour')) {
      const tt = o.read();
      if ('materialIndex' in tt && 'color' in tt) {
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
      } else if ('m_UVScale' in tt && 'm_Size' in tt) {
        if (tt.m_Enabled ?? 1) rawDecals.push([o, tt]);
      } else if (tt.active === 1 || tt.active === true) {
        const isObj = (d) => d !== null && typeof d === 'object' && !Array.isArray(d) && !(d instanceof Uint8Array);
        const v = (field, dflt = null) => {
          const d = tt[field];
          return isObj(d) ? (d.m_Value ?? dflt) : dflt;
        };
        const mergeOvr = (dst, fields) => {
          for (const fk of fields) {
            const d = tt[fk];
            if (isObj(d) && 'm_Value' in d) {
              if (d.m_OverrideState === 1 || d.m_OverrideState === true || !(fk in dst)) dst[fk] = d.m_Value;
            }
          }
        };
        const vol = (key) => {
          if (!(key in this.meta.volumes)) this.meta.volumes[key] = {};
          return this.meta.volumes[key];
        };
        if ('shadeColorMultiply' in tt && 'mainLightAngle' in tt) {
          mergeOvr(vol('actorParam'), [
            'lightColor', 'mainLightSpace', 'mainLightAngle',
            'shadeColorMultiply', 'shadeColorAdditive', 'shadeApplyRatio',
            'rimAngle', 'rimBaseColorRatio', 'rimPower', 'rimColor',
          ]);
        } else if ('shadowStrength' in tt && 'lightDirectional' in tt) {
          mergeOvr(vol('actorShadow'), [
            'shadowStrength', 'directionalType', 'lightDirectional',
            'facePartsShadowStrength',
          ]);
        } else if ('modelingPoseWeight' in tt && 'swingPowerWeight' in tt) {
          mergeOvr(vol('animationManage'), ANIMATION_MANAGE_FIELDS);
        } else if ('reflectionScale' in tt && 'intensity' in tt) {
          this.meta.volumes.lightmap = {
            intensity: v('intensity', 1.0),
            color: v('color'),
          };
        } else if ('threshold' in tt && 'diffusion' in tt) {
          this.meta.volumes.bloom = {
            intensity: v('intensity', 1.0),
            threshold: v('threshold', 0.97),
          };
        } else if ('postExposure' in tt && 'saturation' in tt) {
          this.meta.volumes.colorAdjustments = {
            postExposure: v('postExposure', 0.0),
            contrast: v('contrast', 0.0),
            saturation: v('saturation', 0.0),
            colorFilter: v('colorFilter'),
          };
        } else if ('radius' in tt && 'maxAmount' in tt && 'position' in tt) {
          const posU = v('position') ?? { x: 0, y: 0, z: 0 };
          this.meta.volumes.skyHaze = {
            density: v('density', 0.0),
            maxAmount: v('maxAmount', 0.0),
            color: v('color'),
            position: [posU.x, posU.y, -posU.z],
            radius: v('radius', 1.0),
          };
        }
      }
    }

    // renderer lookup by GameObject path id
    const renderers = new Map();
    const filters = new Map();
    for (const o of env.objectsOf(this.bundle, 'MeshRenderer')) {
      const r = o.read();
      let goPid;
      try {
        goPid = r.m_GameObject.m_PathID;
      } catch {
        continue;
      }
      renderers.set(pidKey(goPid), { r, pid: o.pathId });
    }
    for (const o of env.objectsOf(this.bundle, 'MeshFilter')) {
      const f = o.read();
      filters.set(pidKey(f.m_GameObject.m_PathID), f);
    }
    const identity = IDENTITY.slice();
    const activeGoWorld = new Map();
    for (const r of roots) {
      const [node] = skeleton(r, env);
      const flat = [];
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
    const triData = [];
    const triMin = [];
    const triMax = [];
    for (const bkt of this.buckets.values()) {
      if (!bkt.idx.length) continue;
      const mfl = this.meta.materials[bkt.material]?.floats ?? {};
      if (bkt.material.toLowerCase().includes('glass') || mfl._DstBlend === 10.0) continue;
      for (let t = 0; t < bkt.idx.length; t += 3) {
        const corners = [];
        for (let ci = 0; ci < 3; ci++) {
          const vi = bkt.idx[t + ci] * 3;
          // Convert back to Unity space (x, y, -z) for raycast
          corners.push([bkt.pos[vi], bkt.pos[vi + 1], -bkt.pos[vi + 2]]);
        }
        const mins = [
          Math.min(corners[0][0], corners[1][0], corners[2][0]),
          Math.min(corners[0][1], corners[1][1], corners[2][1]),
          Math.min(corners[0][2], corners[1][2], corners[2][2]),
        ];
        const maxs = [
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
      let dmat = null;
      try {
        dmat = env.readPPtr(o.assetsFile, tt.m_Material);
      } catch {
        continue;
      }
      if (!dmat) continue;
      this.material(dmat, env);
      const mentry = this.meta.materials[dmat.m_Name] ?? {};
      const maps = mentry.maps ?? {};
      const texRel = maps['_BaseMap'] || maps['_MainTex'];
      if (!texRel) continue;
      const off = tt.m_Offset;
      const sz = tt.m_Size;
      const uvs = tt.m_UVScale;
      const uvb = tt.m_UVBias;
      const scaleMode = Math.trunc(tt.m_ScaleMode ?? 1);
      let useM = wm;
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
      const nz = [-useM[2], -useM[6], -useM[10]];
      const nl = Math.sqrt(nz[0] ** 2 + nz[1] ** 2 + nz[2] ** 2) || 1.0;
      const noutU = [nz[0] / nl, nz[1] / nl, nz[2] / nl];
      const hx = 0.5 * Number(sz.x);
      const hy = 0.5 * Number(sz.y);
      const hz = 0.5 * Number(sz.z);
      const ox = Number(off.x), oy = Number(off.y), oz = Number(off.z);

      // Raycast from front of projector box (oz - 1.2*hz) along +Z to snap onto front-most surface
      let bias = 0.0022;
      if (triCount > 0 && hz > 1e-4) {
        const pStart = xform(useM, [ox, oy, oz - 1.2 * hz]);
        const rayD = [-noutU[0], -noutU[1], -noutU[2]];
        const maxT = 2.4 * hz * zScale;
        const rmin = [
          Math.min(pStart[0], pStart[0] + rayD[0] * maxT) - 0.05,
          Math.min(pStart[1], pStart[1] + rayD[1] * maxT) - 0.05,
          Math.min(pStart[2], pStart[2] + rayD[2] * maxT) - 0.05,
        ];
        const rmax = [
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

      const cornersLocal = [
        [ox - hx, oy - hy, oz],
        [ox + hx, oy - hy, oz],
        [ox + hx, oy + hy, oz],
        [ox - hx, oy + hy, oz],
      ];
      const corners3js = [];
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
        isShadow: String(dmat.m_Name).toLowerCase().includes('shadow'),
      });
      this.stats.decals += 1;
    }

    // Skybox texture from t_sky_noon-00
    try {
      const skyB = env.bundleFile(SKY_BUNDLE);
      for (const o of env.objectsOf(skyB, 'Texture2D')) {
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
    for (const o of env.objectsOf(this.bundle, 'Light')) {
      const L = o.read();
      const sf = o.assetsFile;
      let go = null;
      let tr = null;
      try {
        go = env.readPPtr(sf, L.m_GameObject);
        if (!(go?.m_IsActive ?? 1)) continue;
        for (const c of go.m_Component ?? []) {
          const compObj = env.resolvePPtr(go._assetsFile ?? sf, c.component);
          if (compObj?.typeName === 'Transform') {
            tr = compObj.read();
            break;
          }
        }
      } catch {
        tr = null;
      }
      const w = tr !== null ? this.world(tr, env) : identity;
      const p2 = conv([w[3], w[7], w[11]]);
      const fwU = [w[2], w[6], w[10]];
      const fl = Math.sqrt(fwU[0] ** 2 + fwU[1] ** 2 + fwU[2] ** 2) || 1.0;
      const d2 = conv([fwU[0] / fl, fwU[1] / fl, fwU[2] / fl]);
      const col = L.m_Color ?? {};
      this.meta.lights.push({
        name: tr !== null ? go.m_Name : 'light',
        type: Math.trunc(L.m_Type),
        color: [col.r, col.g, col.b],
        intensity: Number(L.m_Intensity),
        range: Number(L.m_Range),
        spotAngle: Number(L.m_SpotAngle ?? 0.0),
        position: [p2[0], p2[1], p2[2]],
        direction: [d2[0], d2[1], d2[2]],
        shadows: L.m_Shadows?.value ?? 0,
      });
    }
    for (const o of env.objectsOf(this.bundle, 'RenderSettings')) {
      const rs = o.read();
      const has = (k) => rs[k] !== undefined && rs[k] !== null;
      const rgb = (c) => [c.r, c.g, c.b];
      this.meta.renderSettings = {
        ambientMode: has('m_AmbientMode') ? Math.trunc(rs.m_AmbientMode) : null,
        ambientSkyColor: rgb(rs.m_AmbientSkyColor),
        ambientEquatorColor: rgb(rs.m_AmbientEquatorColor),
        ambientGroundColor: rgb(rs.m_AmbientGroundColor),
        ambientIntensity: rs.m_AmbientIntensity ?? 1.0,
        fog: Boolean(rs.m_Fog ?? false),
        fogColor: has('m_FogColor') ? rgb(rs.m_FogColor) : null,
        fogDensity: rs.m_FogDensity ?? 0.0,
      };
    }
    // lightmap textures (renderers use atlas 0)
    const lms = {};
    for (const o of env.objectsOf(this.bundle, 'Texture2D')) {
      const t = o.read();
      const tname = String(t.m_Name ?? '');
      if (tname.startsWith('Lightmap-0_comp_light')) {
        lms.light = this.texture(t);
      } else if (tname.startsWith('Lightmap-0_comp_shadowmask')) {
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
      const attrs = {
        POSITION: this.glb.floats(bkt.pos, 'VEC3'),
        NORMAL: this.glb.floats(bkt.nrm, 'VEC3'),
        TEXCOORD_0: this.glb.floats(bkt.uv0, 'VEC2'),
        TEXCOORD_2: this.glb.floats(bkt.uv2, 'VEC2'),
      };
      const acc = this.glb.uints(bkt.idx, 'SCALAR');
      const prim = this.glb.primitive(attrs, acc, bkt.glsm);
      const idx = this.glb.mesh(name, [prim]);
      this.glb.node(`env_${name}`, null, null, idx);
      this.meta.prims[name] = {
        material: bkt.material,
        lightmap: bkt.lightmap,
        overrideColor: bkt.overrideColor,
      };
    }
  }
}

/** Build the 3D ADV stage GLB + metadata + in-memory RGBA textures. */
export async function buildEnv3dFromBundles(env, sceneName = SCENE) {
  await env.ensureBundle(sceneName, true);
  if (env.hasBundle(SKY_BUNDLE)) {
    try {
      await env.ensureBundle(SKY_BUNDLE, true);
    } catch {
      // optional skybox
    }
  }
  const exp = new EnvExporter(env, env.bundleFile(sceneName));
  exp.run();
  return { glbBytes: exp.glb.toGlb(), meta: exp.meta, textures: exp.textures };
}

/* -------------------------------------------------------------------------- */
/* 2D background (pipeline/export_bg.ts)                                      */
/* -------------------------------------------------------------------------- */

const ACTOR_PARAM_FIELDS = [
  'lightColor',
  'mainLightSpace',
  'mainLightAngle',
  'shadeColorMultiply',
  'shadeColorAdditive',
  'shadeApplyRatio',
  'rimAngle',
  'rimBaseColorRatio',
  'rimPower',
  'rimColor',
];

const ACTOR_SHADOW_FIELDS = [
  'shadowStrength',
  'directionalType',
  'lightDirectional',
  'facePartsShadowStrength',
];

function overrideActive(value) {
  return value === 1 || value === true;
}

async function rgbaToBlobUrl(data, width, height) {
  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const pixels = new Uint8ClampedArray(data.length);
  pixels.set(data);
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? URL.createObjectURL(blob) : '';
}

/** Load one `env_2d_*` bundle into raw RGBA pixels plus a PNG blob URL. */
export async function loadBg2dFromBundle(env, bundleName) {
  const name = String(bundleName).endsWith('.bundle')
    ? String(bundleName).slice(0, -'.bundle'.length)
    : String(bundleName);
  if (env.hasBundle(name)) await env.ensureBundle(name, true);
  const bundle = env.bundleFile(name);

  let decoded = null;
  for (const obj of env.objectsOf(bundle, 'Texture2D')) {
    const tex = obj.read();
    decoded = decodeTexture(env, tex);
  }
  if (!decoded) throw new Error(`no Texture2D in ${name}`);

  let verticalSetting = null;
  let horizontalSetting = null;
  const volumes = {};
  for (const obj of env.objectsOf(bundle, 'MonoBehaviour')) {
    const tt = obj.read();
    if ('_verticalSetting' in tt && '_horizontalSetting' in tt) {
      verticalSetting = tt._verticalSetting;
      horizontalSetting = tt._horizontalSetting;
      continue;
    }
    if (!overrideActive(tt.active)) continue;

    const mergeOvr = (dst, fields) => {
      for (const fk of fields) {
        const d = tt[fk];
        if (d !== null && typeof d === 'object' && !Array.isArray(d) && 'm_Value' in d) {
          if (overrideActive(d.m_OverrideState) || !(fk in dst)) dst[fk] = d.m_Value;
        }
      }
    };

    if ('shadeColorMultiply' in tt && 'mainLightAngle' in tt) {
      volumes.actorParam ??= {};
      mergeOvr(volumes.actorParam, ACTOR_PARAM_FIELDS);
    } else if ('shadowStrength' in tt && 'lightDirectional' in tt) {
      volumes.actorShadow ??= {};
      mergeOvr(volumes.actorShadow, ACTOR_SHADOW_FIELDS);
    } else if ('modelingPoseWeight' in tt && 'swingPowerWeight' in tt) {
      volumes.animationManage ??= {};
      mergeOvr(volumes.animationManage, ANIMATION_MANAGE_FIELDS);
    }
  }

  const data = decoded.data;
  const blobUrl = await rgbaToBlobUrl(data, decoded.width, decoded.height);
  return {
    width: decoded.width,
    height: decoded.height,
    verticalSetting,
    horizontalSetting,
    volumes,
    data,
    rgba: data,
    blobUrl,
  };
}

/* -------------------------------------------------------------------------- */
/* Animation clips (pipeline/export_clips.ts)                                 */
/* -------------------------------------------------------------------------- */

const MUSCLE_BASE = 42;
const MUSCLE_COUNT = 95;
const ROOT_PROPS = [
  ['rootT', 7, 3],
  ['rootQ', 10, 4],
  ['lfT', 14, 3],
  ['lfQ', 17, 4],
  ['rfT', 21, 3],
  ['rfQ', 24, 4],
  ['lhT', 28, 3],
  ['lhQ', 31, 4],
  ['rhT', 35, 3],
  ['rhQ', 38, 4],
];
const TRANSFORM_PROPS = {
  1: 'position',
  2: 'rotation',
  3: 'scale',
  4: 'euler',
};
const MANAGE_PROPS = new Map(Object.keys(ANIMATION_MANAGE_DEFAULTS).map((key) =>
  [crc32(`propertyData.${key}`) >>> 0, key]));

function nodePathTable(env, body_bundle) {
  let root = null;
  for (const o of env.objectsOf(body_bundle, 'Transform')) {
    const t = o.read();
    if (BigInt(t.m_Father?.m_PathID ?? 0) !== 0n) continue;
    const go = env.readPPtr(o.assetsFile, t.m_GameObject);
    if (String(go?.m_Name ?? '').startsWith('mdl_')) {
      root = o;
      break;
    }
  }
  if (root === null) throw new Error('no root transform');
  const [node] = skeleton(root, env);
  const out = new Map();
  const prefixes = ['Root_Body/', 'Root/', ''];

  const walk = (n, p) => {
    for (const pre of prefixes) {
      const s = pre + p;
      const h = crc32(s) >>> 0;
      if (!out.has(h)) out.set(h, [n.path_id, s]);
    }
    for (const c of n.children) walk(c, p ? p + '/' + c.name : c.name);
  };

  walk(node, '');
  return out;
}

function blendTable(env, face_bundle) {
  const out = new Map();
  for (const o of env.objectsOf(face_bundle, 'MonoBehaviour')) {
    const t = o.read();
    if (t.blendShapes === undefined) continue;
    const count = (t.blendShapes ?? []).length;
    for (let i = 0; i < count; i++) {
      const p = `blendShapeWeights.w${Math.floor(i / 16)}.w${i % 16}`;
      out.set(crc32(p) >>> 0, [i, p]);
    }
    break;
  }
  return out;
}

async function ensureClipTables(env, charMeta) {
  if (!env._clipPathTable || !env._clipBlendTable) {
    await Promise.all([
      env.ensureBundle(PARTS.body, false),
      env.ensureBundle(PARTS.face, false),
    ]);
    if (!env._clipPathTable) {
      env._clipPathTable = nodePathTable(env, env.bundleFile(PARTS.body));
    }
    if (!env._clipBlendTable) {
      env._clipBlendTable = blendTable(env, env.bundleFile(PARTS.face));
    }
  }

  const byPath = charMeta?.nodeByPathId ?? null;
  const byName = charMeta?.nodeByName ?? null;
  if (byPath && env._clipCharPaths !== byPath) {
    const paths = new Map();
    for (const [h, v] of env._clipPathTable) {
      const bname = String(v[1] || '').split('/').pop();
      const raw = byPath[String(v[0])] ?? (bname && byName ? byName[bname] : undefined);
      paths.set(h, [raw === undefined ? -1 : Math.trunc(Number(raw)), v[1]]);
    }
    env._clipCharPaths = byPath;
    env._clipCharPathsMapped = paths;
  } else if (!byPath && !env._clipCharPathsMapped) {
    const paths = new Map();
    for (const [h, v] of env._clipPathTable) paths.set(h, [-1, v[1]]);
    env._clipCharPathsMapped = paths;
  }
  return { paths: env._clipCharPathsMapped, blends: env._clipBlendTable };
}

function exportClipsFromBundle(env, bundleName, paths, blends) {
  const bundle = env.bundleFile(bundleName);
  const clips = env.objectsOf(bundle, 'AnimationClip');
  const out = [];
  for (const o of clips) {
    const a = o.read();
    const bindings = a.m_ClipBindingConstant?.genericBindings ?? [];
    const stop = a.m_MuscleClip.m_StopTime;
    const nframes = Math.max(1, pyRound(stop * 30) + 1);
    const times = [];
    for (let i = 0; i < nframes; i++) times.push(i / 30.0);
    const s = new ClipSampler(a, bindings, stop);
    const tracks = [];
    const root_slots = new Map();
    let unresolved = 0;
    let slot = 0;
    for (const gb of bindings) {
      const dim = bindingDimension(gb);
      if (gb.typeID === 4 && Object.prototype.hasOwnProperty.call(TRANSFORM_PROPS, gb.attribute)) {
        const info = paths.get(gb.path >>> 0);
        if (info === undefined) {
          unresolved += 1;
        } else if (!String(a.m_Name).includes('facial')) {
          const node_id = Number(info[0]) >= 0 ? Number(info[0]) : -1;
          const vals = [];
          for (const t of times) {
            for (let k = 0; k < dim; k++) vals.push(round5(s.value(slot + k, t)));
          }
          tracks.push({
            kind: 'bone',
            node: node_id,
            prop: TRANSFORM_PROPS[gb.attribute],
            values: vals,
            dim,
            path: info[1],
          });
        }
      } else if (gb.typeID === 95 && gb.customType === 8) {
        const attr = Math.trunc(gb.attribute);
        if (attr >= MUSCLE_BASE && attr < MUSCLE_BASE + MUSCLE_COUNT) {
          const vals = [];
          for (const t of times) vals.push(round5(s.value(slot, t)));
          tracks.push({ kind: 'muscle', index: attr - MUSCLE_BASE, values: vals });
        } else {
          for (const [rname, rbase, rdim] of ROOT_PROPS) {
            if (attr >= rbase && attr < rbase + rdim) {
              root_slots.set(`${rname}/${attr - rbase}`, slot);
            }
          }
        }
      } else if (gb.typeID === 114) {
        const manage = MANAGE_PROPS.get(gb.attribute >>> 0);
        if (manage !== undefined) {
          const values = times.map((t) => round5(s.value(slot, t)));
          tracks.push({ kind: 'manage', prop: manage, values });
          slot += dim;
          continue;
        }
        const info = blends.get(gb.attribute >>> 0);
        if (info !== undefined) {
          const vals = [];
          for (const t of times) vals.push(round4(s.value(slot, t)));
          tracks.push({ kind: 'blend', index: info[0], values: vals });
        } else if (gb.attribute === 682354173) {
          const vals = [];
          for (const t of times) vals.push(round4(s.value(slot, t)));
          tracks.push({ kind: 'custom', index: 0, values: vals });
        } else {
          unresolved += 1;
        }
      }
      slot += dim;
    }
    for (const [rname, , rdim] of ROOT_PROPS) {
      let complete = true;
      for (let k = 0; k < rdim; k++) {
        if (!root_slots.has(`${rname}/${k}`)) {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      const vals = [];
      for (const t of times) {
        for (let k = 0; k < rdim; k++) {
          vals.push(round5(s.value(root_slots.get(`${rname}/${k}`), t)));
        }
      }
      tracks.push({ kind: 'root', prop: rname, dim: rdim, values: vals });
    }
    out.push({
      name: a.m_Name,
      duration: stop,
      frameCount: nframes,
      tracks,
      unresolved,
    });
  }
  return out;
}

/** Load (and cache) one sampled AnimationClip from its `mot_*` bundle. */
export async function loadClipFromBundle(env, clipName, charMeta) {
  if (!env._clipCache) env._clipCache = new Map();
  const cache = env._clipCache;
  if (cache.has(clipName)) return cache.get(clipName);

  const bundleName = String(clipName).replace(/_[bf]$/, '');
  if (!env.hasBundle(bundleName)) return null;

  await env.ensureBundle(bundleName, false);
  const { paths, blends } = await ensureClipTables(env, charMeta);
  const clips = exportClipsFromBundle(env, bundleName, paths, blends);
  for (const c of clips) cache.set(c.name, c);
  if (!cache.has(clipName)) cache.set(clipName, null);
  return cache.get(clipName);
}

/* -------------------------------------------------------------------------- */
/* Voice / lip-sync (pipeline/export_voices.ts)                               */
/* -------------------------------------------------------------------------- */

const ACB_SHEET_CACHE = new Map();
const VOICE_CUE_CACHE = new Map();
const VOICE_CUE_INFLIGHT = new Map();

async function loadAcbSheet(sheet) {
  let promise = ACB_SHEET_CACHE.get(sheet);
  if (!promise) {
    promise = (async () => {
      const response = await fetch(`/cache/resources/${encodeURIComponent(sheet)}.acb`);
      if (!response.ok) {
        throw new Error(`failed to fetch ${sheet}.acb (HTTP ${response.status})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return extractAcbHcaStreams(bytes);
    })();
    ACB_SHEET_CACHE.set(sheet, promise);
    promise.catch(() => {
      if (ACB_SHEET_CACHE.get(sheet) === promise) ACB_SHEET_CACHE.delete(sheet);
    });
  }
  return promise;
}

/** Decode a CRI `.acb` cue to a WAV blob URL + 60 Hz AIUEO frames. */
export async function loadVoiceCueFromAcb(cueName) {
  if (VOICE_CUE_CACHE.has(cueName)) return VOICE_CUE_CACHE.get(cueName);

  let promise = VOICE_CUE_INFLIGHT.get(cueName);
  if (!promise) {
    promise = (async () => {
      const sheet = String(cueName).replace(/_[a-z0-9]+-\d+$/, '');
      let streams;
      try {
        streams = await loadAcbSheet(sheet);
      } catch {
        return null;
      }
      const hcaBytes = streams.get(cueName);
      if (!hcaBytes) {
        VOICE_CUE_CACHE.set(cueName, null);
        return null;
      }
      try {
        const decoded = await decodeHcaAndLipsync(hcaBytes, 60);
        const result = {
          duration: decoded.duration,
          fps: 60,
          frames: decoded.frames,
          wavBlobUrl: decoded.wavBlobUrl,
        };
        VOICE_CUE_CACHE.set(cueName, result);
        return result;
      } catch {
        return null;
      }
    })();
    VOICE_CUE_INFLIGHT.set(cueName, promise);
    promise.finally(() => {
      if (VOICE_CUE_INFLIGHT.get(cueName) === promise) VOICE_CUE_INFLIGHT.delete(cueName);
    });
  }
  return promise;
}

/* -------------------------------------------------------------------------- */
/* Convenience exports                                                        */
/* -------------------------------------------------------------------------- */

export { CharExporter, EnvExporter, decodeTexture };
