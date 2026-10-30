"""Export the 3D actor (body + face + hair) into one GLB plus a metadata JSON.

Outputs (under tools/adv_viewer/web):
  assets/char.glb      skinned meshes, morph targets (face blendshapes), skeleton
  assets/char.json     material definitions, texture paths, humanoid bone map
  assets/tex/*.png     decoded textures

Bind-pose conventions (verified numerically):
  * Unity world -> three.js: p=(x,y,-z), q=(x,y,-z,-w), scale unchanged
  * face/hair part roots hang under the body Head bone with identity local
    transform; their bindposes are inverse(boneWorld) in the *same* actor space,
    which is exactly what glTF skins need (mesh node transform is ignored for
    skinned meshes).
  * Unity Matrix4x4f (e00..e33) is row-major math layout; glTF wants
    column-major, so matrices are transposed on write.
"""
from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import assets
from gltf import Glb, FLOAT

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
OUT = WEB / "assets"
TEX = OUT / "tex"

PARTS = {
    "body": "mdl_chr_amao-casl-0000_body",
    "face": "mdl_chr_amao-base-0000_face",
    "hair": "mdl_chr_amao-base-0000_hair",
}

HUMANOID = {
    "Hips": "Hips", "Spine": "Spine", "Chest": "Spine1", "UpperChest": "Spine2",
    "Neck": "Neck", "Head": "Head",
    "LeftShoulder": "LeftShoulder", "LeftUpperArm": "LeftArm",
    "LeftLowerArm": "LeftForeArm", "LeftHand": "LeftHand",
    "RightShoulder": "RightShoulder", "RightUpperArm": "RightArm",
    "RightLowerArm": "RightForeArm", "RightHand": "RightHand",
    "LeftUpperLeg": "LeftUpLeg", "LeftLowerLeg": "LeftLeg",
    "LeftFoot": "LeftFoot", "LeftToes": "LeftToeBase",
    "RightUpperLeg": "RightUpLeg", "RightLowerLeg": "RightLeg",
    "RightFoot": "RightFoot", "RightToes": "RightToeBase",
    "LeftEye": "LeftEye", "RightEye": "RightEye",
}
FINGERS = {"Thumb": "Thumb", "Index": "Index", "Middle": "Middle",
           "Ring": "Ring", "Little": "Pinky"}
for side in ("Left", "Right"):
    for fname, bone in FINGERS.items():
        for i, seg in enumerate(("Proximal", "Intermediate", "Distal"), start=1):
            HUMANOID[f"{side}{fname}{seg}"] = f"{side}Hand{bone}{i}"


def conv_v(v):
    return (v[0], v[1], -v[2])


def conv_q(q):
    return (q[0], q[1], -q[2], -q[3])


def mat_convert_rows(m):
    """Unity Matrix4x4f -> glTF column-major list with the z flip applied."""
    rows = [[getattr(m, f"e{r}{c}") for c in range(4)] for r in range(4)]
    s = (1.0, 1.0, -1.0, 1.0)
    out = []
    for c in range(4):
        for r in range(4):
            out.append(rows[r][c] * s[r] * s[c])
    return out


class Exporter:
    def __init__(self):
        self.glb = Glb()
        self.node_of_t = {}
        self.node_of_go = {}
        self.node_by_name = {}
        self.meta = {"materials": {}, "parts": {}, "humanoid": {}, "boneNodes": {}}
        self.tex_done = {}
        self.tex_idx = {}
        self.glb_mat = {}

    # ---------- textures / materials ----------
    def texture_file(self, tex):
        name = tex.m_Name
        if name in self.tex_done:
            return self.tex_done[name]
        TEX.mkdir(parents=True, exist_ok=True)
        path = TEX / f"{name}.png"
        if not path.exists():
            path.write_bytes(assets.texture_png(tex))
        self.tex_done[name] = f"tex/{name}.png"
        return self.tex_done[name]

    def material(self, mat, part):
        entry = {
            "name": mat.m_Name,
            "part": part,
            "renderQueue": int(getattr(mat, "m_CustomRenderQueue", -1)),
            "maps": {},
            "floats": {},
            "colors": {},
        }
        for prop, te in mat.m_SavedProperties.m_TexEnvs:
            try:
                tex = te.m_Texture.read()
            except Exception:
                tex = None
            if tex is None:
                continue
            entry["maps"][prop] = self.texture_file(tex)
        for k, v in mat.m_SavedProperties.m_Floats:
            entry["floats"][k] = float(v)
        for k, c in mat.m_SavedProperties.m_Colors:
            entry["colors"][k] = [float(c.r), float(c.g), float(c.b), float(c.a)]
        key = f"{part}:{mat.m_Name}"
        self.meta["materials"][key] = entry
        tex_idx = None
        albedo = entry["maps"].get("_BaseMap")
        if albedo:
            if albedo not in self.tex_idx:
                self.tex_idx[albedo] = self.glb.texture(self.glb.image_uri(albedo, albedo))
            tex_idx = self.tex_idx[albedo]
        self.glb_mat[key] = self.glb.material(
            key, tex_idx, double_sided=entry["floats"].get("_Cull") == 0,
            alpha_mode="MASK" if entry["floats"].get("_AlphaClip", 0.0) >= 0.5 else None)
        return key

    # ---------- nodes ----------
    def emit_tree(self, node, parent_index):
        p, q, s = assets.local_trs(node.transform)
        idx = self.glb.node(node.name, (conv_v(p), conv_q(q), s), parent_index)
        self.node_of_t[node.path_id] = idx
        self.node_of_go[node.go] = idx
        self.node_by_name.setdefault(node.name, idx)
        self.meta["boneNodes"][str(idx)] = node.name
        self.meta.setdefault("nodeByPathId", {})[str(node.path_id)] = idx
        for c in node.children:
            self.emit_tree(c, idx)
        return idx

    # ---------- meshes ----------
    def build_primitives(self, md, joint_count, weights_override=None,
                         blend_shapes=None, mat_keys=None):
        n = len(md["vertices"])
        pos, nrm = [], []
        for i in range(n):
            pos.extend(conv_v(md["vertices"][i]))
            nrm.extend(conv_v(md["normals"][i]) if i < len(md["normals"])
                       else (0.0, 0.0, 1.0))
        uv = []
        for i in range(n):
            if i < len(md["uv0"]):
                u0, v0 = md["uv0"][i]
                uv.extend((u0, 1.0 - v0))
            else:
                uv.extend((0.0, 0.0))
        attrs = {
            "POSITION": self.glb.floats(pos, "VEC3"),
            "NORMAL": self.glb.floats(nrm, "VEC3"),
            "TEXCOORD_0": self.glb.floats(uv, "VEC2"),
        }
        if md.get("tangents"):
            tan = []
            tlist = md["tangents"]
            for i in range(n):
                if i < len(tlist):
                    tx, ty, tz, tw = tlist[i]
                    tx, ty, tz = tx, ty, -tz
                    ln = math.sqrt(tx * tx + ty * ty + tz * tz)
                    if ln > 1e-6:
                        tan.extend((tx / ln, ty / ln, tz / ln, 1.0 if tw >= 0 else -1.0))
                    else:
                        tan.extend((1.0, 0.0, 0.0, 1.0))
                else:
                    tan.extend((1.0, 0.0, 0.0, 1.0))
            attrs["TANGENT"] = self.glb.floats(tan, "VEC4")
        if md.get("colors"):
            clist = md["colors"]
            is_byte = any(
                (isinstance(x, int) and not isinstance(x, bool)) or x > 1.001
                for c in clist[:64] for x in c
            )
            scale = (1.0 / 255.0) if is_byte else 1.0
            col = []
            for i in range(n):
                if i < len(clist):
                    c = clist[i]
                    col.extend((float(c[0]) * scale, float(c[1]) * scale,
                                float(c[2]) * scale, float(c[3]) * scale))
                else:
                    col.extend((0.0, 0.0, 0.0, 1.0))
            attrs["COLOR_0"] = self.glb.floats(col, "VEC4")
        if md["uv1"]:
            uv1 = []
            for i in range(n):
                if i < len(md["uv1"]):
                    u1, v1 = md["uv1"][i]
                    uv1.extend((u1, 1.0 - v1))
                else:
                    uv1.extend((0.0, 0.0))
            attrs["TEXCOORD_1"] = self.glb.floats(uv1, "VEC2")
        if weights_override is not None:
            ji, jw = weights_override
        elif md["bones"] and md["weights"]:
            ji, jw = [], []
            for i in range(n):
                bi = md["bones"][i]
                bw = md["weights"][i]
                ws = list(bw)[:4] if isinstance(bw, (list, tuple)) else [bw]
                js = list(bi)[:4] if isinstance(bi, (list, tuple)) else [bi]
                while len(js) < 4:
                    js.append(0)
                while len(ws) < 4:
                    ws.append(0.0)
                s = sum(ws) or 1.0
                ji.extend(int(x) for x in js)
                jw.extend(float(w) / s for w in ws)
        else:
            ji, jw = None, None
        if ji is not None:
            attrs["JOINTS_0"] = self.glb.ushorts(ji, "VEC4")
            attrs["WEIGHTS_0"] = self.glb.floats(jw, "VEC4")

        targets = None
        weights = None
        if blend_shapes:
            targets = []
            weights = []
            for name, deltas in blend_shapes:
                idxs = sorted(deltas)
                vals = []
                for vi in idxs:
                    vals.extend(conv_v(deltas[vi]))
                acc = self.glb.sparse_float_accessor(n, "VEC3", idxs, vals)
                targets.append({"POSITION": acc})
                weights.append(0.0)

        prims = []
        for si, (start, count, topo) in enumerate(md["submeshes"]):
            flat = []
            tris = md["triangles"][start:start + count]
            for a, b, c in tris:
                flat.extend((a, c, b))
            if not flat:
                continue
            acc = self.glb.uints(flat, "SCALAR")
            mi = None
            if mat_keys:
                mi = self.glb_mat.get(mat_keys[min(si, len(mat_keys) - 1)])
            prims.append(self.glb.primitive(dict(attrs), acc, material=mi,
                                            targets=targets))
        return prims, weights

    def add_skinned(self, part_name, parent_go, mesh, joints, bond_matrices,
                    materials, name, blend_shapes=None, weights_override=None):
        md = assets.mesh_data(mesh)
        joint_nodes = []
        for t in joints:
            pid = t.m_PathID
            if pid not in self.node_of_t:
                raise RuntimeError(f"joint path_id {pid} missing for {name}")
            joint_nodes.append(self.node_of_t[pid])
        ibm = []
        for m in bond_matrices:
            ibm.extend(mat_convert_rows(m))
        skin = self.glb.skin(name, joint_nodes, ibm)
        prims, weights = self.build_primitives(md, len(joint_nodes),
                                               weights_override, blend_shapes,
                                               materials)
        gltf_mesh = self.glb.mesh(name, prims, weights)
        parent_node = self.node_of_go[parent_go.m_PathID]
        mesh_node = self.glb.node(name + "_mesh", None, parent_node,
                                  mesh=gltf_mesh, skin=skin, weights=weights)
        self.meta["parts"][name] = {
            "node": mesh_node, "materials": materials,
            "submeshCount": len(prims), "vertexCount": len(md["vertices"]),
            "blendShapes": [bs[0] for bs in blend_shapes] if blend_shapes else [],
        }
        return mesh_node


def find_root(bundle):
    fallback = None
    for o in assets.objects_of(bundle, "Transform"):
        t = o.read()
        if t.m_Father.m_PathID != 0:
            continue
        name = t.m_GameObject.read().m_Name
        if name.startswith("mdl_"):
            return t
        fallback = fallback or t
    if fallback is None:
        raise RuntimeError("no root transform")
    return fallback


def main():
    exp = Exporter()
    assets.load_env()

    # ---------------- body ----------------
    body_bundle = assets.bundle_file(PARTS["body"])
    body_root, _ = assets.skeleton(find_root(body_bundle))
    actor = exp.glb.node("actor")
    body_idx = exp.emit_tree(body_root, actor)
    # the body root node is the actor root itself
    exp.glb.json["nodes"][actor].setdefault("children", [])
    if body_idx in exp.glb.json["nodes"][actor]["children"]:
        exp.glb.json["nodes"][actor]["children"].remove(body_idx)
    exp.glb.json["scenes"][0]["nodes"] = [body_idx]
    exp.glb.json["nodes"][body_idx]["name"] = "actor"

    for o in assets.objects_of(body_bundle, "SkinnedMeshRenderer"):
        r = o.read()
        mesh = r.m_Mesh.read()
        mats = [exp.material(m.read(), "body") for m in r.m_Materials]
        exp.add_skinned("body", r.m_GameObject, mesh,
                        list(r.m_Bones), mesh.m_BindPose, mats,
                        "body_geo")

    # Export ActorAnimationQuartzDriver* twist/helper bone rules from body
    qdrivers = []
    for o in assets.objects_of(body_bundle, "MonoBehaviour"):
        tt = o.read_typetree()
        if "setting" not in tt:
            continue
        mb = o.read()
        go_pid = mb.m_GameObject.m_PathID
        node_idx = exp.node_of_go.get(go_pid)
        if node_idx is None:
            continue
        st = dict(tt["setting"])
        for ref_key in ("referenceBone", "referenceWaistOffsetBone", "referenceThighOffsetBone"):
            if ref_key in st and isinstance(st[ref_key], dict):
                rpid = st[ref_key].get("m_PathID", 0)
                st[ref_key] = exp.node_of_t.get(rpid, -1)
        qdrivers.append({
            "node": node_idx,
            "name": exp.meta["boneNodes"].get(str(node_idx), ""),
            "setting": st,
        })
    exp.meta["quartzDrivers"] = qdrivers

    head_bone = exp.node_by_name.get("Head")
    if head_bone is None:
        raise RuntimeError("Head bone not found")

    # ---------------- face ----------------
    face_bundle = assets.bundle_file(PARTS["face"])
    face_root, _ = assets.skeleton(find_root(face_bundle))
    exp.emit_tree(face_root, head_bone)

    for o in assets.objects_of(face_bundle, "MonoBehaviour"):
        t = o.read_typetree()
        if "curves" in t and "blendShapeIndices" in t:
            exp.meta["faceCorrection"] = {
                "indices": [int(x) for x in t["blendShapeIndices"]],
                "curves": [
                    [{"t": float(k["time"]), "v": float(k["value"])} for k in cv["m_Curve"]]
                    for cv in t["curves"]
                ],
            }
            continue
        if "blendShapes" not in t:
            continue
        mb = o.read()
        mesh = mb.mesh.read()
        mats = [exp.material(m.read(), "face") for m in mb.sharedMaterials]
        shapes = []
        for bs in mb.blendShapes:
            deltas = {}
            for v in bs.blendShapeVertices:
                deltas[int(v.vertIndex)] = (v.position.x, v.position.y, v.position.z)
            shapes.append((bs.blendShapeName, deltas))
        n = len(assets.mesh_data(mesh)["vertices"])
        bwi = list(t.get("boneWeightAndIndices") or [])
        nbones = max(1, len(mb.bones))
        if len(bwi) == 4 * n:
            ji, jw = [], []
            for vi in range(n):
                js, ws = [], []
                for k in range(4):
                    u = int(bwi[vi * 4 + k]) & 0xFFFFFFFF
                    bi = u & 0xFFFF
                    wt = ((u >> 16) & 0xFFFF) / 65535.0
                    if bi >= nbones:
                        bi, wt = 0, 0.0
                    js.append(bi)
                    ws.append(wt)
                sw = sum(ws)
                if sw > 1e-6:
                    ws = [w / sw for w in ws]
                else:
                    js, ws = [0, 0, 0, 0], [1.0, 0.0, 0.0, 0.0]
                ji.extend(js)
                jw.extend(ws)
            override = (ji, jw)
        else:
            override = ([0] * (4 * n), [1.0, 0.0, 0.0, 0.0] * n)
        exp.add_skinned("face", mb.m_GameObject, mesh,
                        list(mb.bones), mb.bindposes, mats,
                        "face_geo", shapes, override)
        exp.meta["faceBlendShapeCount"] = len(shapes)

    # Also export character ramp texture from t_chr_amao-base-0000 if not already referenced
    try:
        base_tex_b = assets.bundle_file("t_chr_amao-base-0000")
        for o in assets.objects_of(base_tex_b, "Texture2D"):
            tx = o.read()
            if tx.m_Name.endswith("_rmp"):
                exp.meta["rampMap"] = exp.texture_file(tx)
    except Exception:
        pass
    # ---------------- hair ----------------
    hair_bundle = assets.bundle_file(PARTS["hair"])
    hair_root, _ = assets.skeleton(find_root(hair_bundle))
    exp.emit_tree(hair_root, head_bone)
    for i, o in enumerate(assets.objects_of(hair_bundle, "SkinnedMeshRenderer")):
        r = o.read()
        mesh = r.m_Mesh.read()
        mats = [exp.material(m.read(), "hair") for m in r.m_Materials]
        exp.add_skinned("hair" + str(i), r.m_GameObject, mesh,
                        list(r.m_Bones), mesh.m_BindPose, mats,
                        f"hair_geo{i}")

    # ---------------- humanoid map ----------------
    for hname, bname in HUMANOID.items():
        nid = exp.node_by_name.get(bname)
        if nid is not None:
            exp.meta["humanoid"][hname] = nid
    exp.meta["missingHumanoid"] = [h for h in HUMANOID if h not in exp.meta["humanoid"]]

    OUT.mkdir(parents=True, exist_ok=True)
    exp.glb.save(OUT / "char.glb")
    (OUT / "char.json").write_text(json.dumps(exp.meta, indent=1), encoding="utf-8")
    print("nodes", len(exp.glb.json["nodes"]), "meshes", len(exp.glb.json["meshes"]),
          "skins", len(exp.glb.json["skins"]), "textures", len(exp.tex_done))
    print("missing humanoid", exp.meta["missingHumanoid"])


if __name__ == "__main__":
    main()
