"""Export the 3D ADV stage (env_3d_* prefab scene) to one GLB + metadata.

The Unity scene lives in the env_3d_* bundle, but every mesh/material it
references lives in dependency bundles (fbx_mdl_env_*); all bundles are loaded
into one UnityPy environment so PPtrs resolve.

Static geometry: world transforms are baked into the vertices, so the GLB holds
one flat node per renderer. Lightmaps are exported as PNGs plus per-primitive
texture index / scale-offset, consumed by the viewer's custom shader.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import assets
from gltf import Glb, FLOAT

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
OUT = WEB / "assets"
TEX = OUT / "tex"

SCENE = "env_3d_adv_classroom-00-00-noon"
SKY_BUNDLE = "t_sky_noon-00"
ROOTS = {"decal", "stg-parts", "eff", "cmn-parts", "Lighting&PostEffects"}
def mat_mul(a, b):
    """4x4 row-major math matrices."""
    out = [0.0] * 16
    for r in range(4):
        for c in range(4):
            out[r * 4 + c] = sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
    return out


def trs(p, q, s):
    x, y, z, w = q
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    m = [
        (1 - 2 * (yy + zz)) * s[0], 2 * (xy - wz) * s[0], 2 * (xz + wy) * s[0], p[0],
        2 * (xy + wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz - wx) * s[1], p[1],
        2 * (xz - wy) * s[2], 2 * (yz + wx) * s[2], (1 - 2 * (xx + yy)) * s[2], p[2],
        0.0, 0.0, 0.0, 1.0,
    ]
    return m


def xform(m, v):
    x, y, z = v
    return (m[0] * x + m[1] * y + m[2] * z + m[3],
            m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11])


def xform_normal(m, v):
    x, y, z = v
    return (m[0] * x + m[4] * y + m[8] * z,
            m[1] * x + m[5] * y + m[9] * z,
            m[2] * x + m[6] * y + m[10] * z)


def conv(p):
    return (p[0], p[1], -p[2])


class EnvExporter:
    def __init__(self, bundle):
        self.bundle = bundle
        self.glb = Glb()
        self.tex_done = {}
        self.tex_idx = {}
        self.mat_done = {}
        self.buckets = {}
        self.lod_skip_renderers = set()
        self.color_overrides = {}
        self.meta = {
            "materials": {}, "lightmap": {}, "lights": [],
            "renderSettings": {}, "decals": [], "volumes": {}, "skybox": None,
        }
        self.stats = {"renderers": 0, "verts": 0, "tris": 0, "skipped": 0, "decals": 0}
    # ---------- textures ----------
    def texture(self, tex):
        name = tex.m_Name
        if name not in self.tex_done:
            TEX.mkdir(parents=True, exist_ok=True)
            path = TEX / f"{name}.png"
            if not path.exists():
                try:
                    path.write_bytes(assets.texture_png(tex))
                except Exception:
                    return None
            self.tex_done[name] = f"tex/{name}.png"
            idx = self.glb.texture(self.glb.image_uri(name, self.tex_done[name]))
            self.tex_idx[name] = idx
        return self.tex_done.get(name)

    def material(self, mat):
        key = mat.m_Name
        if key in self.mat_done:
            return self.mat_done[key]
        entry = {"maps": {}, "colors": {}, "floats": {}, "renderQueue": int(getattr(mat, "m_CustomRenderQueue", -1))}
        for prop, te in mat.m_SavedProperties.m_TexEnvs:
            try:
                tex = te.m_Texture.read()
            except Exception:
                continue
            if tex is None:
                continue
            rel = self.texture(tex)
            if rel:
                entry["maps"][prop] = rel
        for k, c in mat.m_SavedProperties.m_Colors:
            entry["colors"][k] = [float(c.r), float(c.g), float(c.b), float(c.a)]
        for k, v in mat.m_SavedProperties.m_Floats:
            entry["floats"][k] = float(v)
        self.meta["materials"][key] = entry
        albedo = entry["maps"].get("_BaseMap") or entry["maps"].get("_MainTex")
        glsm = self.glb.material(
            key,
            self.tex_idx.get(Path(albedo).stem) if albedo else None,
            base_color=tuple(entry["colors"].get("_BaseColor", [1, 1, 1, 1])),
            double_sided=entry["floats"].get("_Cull") == 0,
            alpha_mode="MASK" if entry["floats"].get("_AlphaClip", 0.0) >= 0.5 else None)
        self.mat_done[key] = glsm
        return glsm

    # ---------- traversal ----------
    def walk(self, node, parent_m, out):
        if not node.active:
            return
        p, q, s = assets.local_trs(node.transform)
        m = mat_mul(parent_m, trs(p, q, s))
        out.append((node, m))
        for c in node.children:
            self.walk(c, m, out)

    def add_renderer(self, node, m, mf, mr, mr_pid):
        if not getattr(mr, "m_Enabled", 1) or mr_pid in self.lod_skip_renderers:
            self.stats["skipped"] += 1
            return
        try:
            mesh = mf.m_Mesh.read()
        except Exception:
            self.stats["skipped"] += 1
            return
        if mesh is None:
            return
        md = assets.mesh_data(mesh)
        if not md["vertices"]:
            return
        n = len(md["vertices"])
        v_pos, v_nrm, v_uv0, v_uv2 = [], [], [], []
        lm = getattr(mr, "m_LightmapIndex", -1)
        if lm is None or lm >= 65000:
            lm = -1
        to = getattr(mr, "m_LightmapTilingOffset", None)
        tsx, tsy, tox, toy = ((to.x, to.y, to.z, to.w) if to is not None
                              else (1.0, 1.0, 0.0, 0.0))
        # Check negative determinant (mirrored scale flips triangle winding!)
        det = (
            m[0] * (m[5] * m[10] - m[6] * m[9])
            - m[1] * (m[4] * m[10] - m[6] * m[8])
            + m[2] * (m[4] * m[9] - m[5] * m[8])
        )
        flip_winding = det < 0.0
        for i in range(n):
            v_pos.append(conv(xform(m, md["vertices"][i])))
            if i < len(md["normals"]):
                nn = xform_normal(m, md["normals"][i])
                ln = math.sqrt(sum(c * c for c in nn)) or 1.0
                v_nrm.append(conv((nn[0] / ln, nn[1] / ln, nn[2] / ln)))
            else:
                v_nrm.append((0.0, 1.0, 0.0))
            if i < len(md["uv0"]):
                u0, v0 = md["uv0"][i]
                v_uv0.append((u0, 1.0 - v0))
            else:
                v_uv0.append((0.0, 0.0))
            a, b = md["uv1"][i] if i < len(md["uv1"]) else (0.0, 0.0)
            v_uv2.append((a * tsx + tox, b * tsy + toy))

        mats, names = [], []
        for mp in mr.m_Materials:
            try:
                mo = mp.read()
                mats.append(self.material(mo))
                names.append(mo.m_Name)
            except Exception:
                mats.append(None)
                names.append("")

        ovr_map = self.color_overrides.get(node.go, {})
        for si, (start, count, topo) in enumerate(md["submeshes"]):
            tris = md["triangles"][start:start + count]
            if not tris:
                continue
            k = min(si, len(names) - 1) if names else 0
            mname = names[k] if names else "default"
            glsm = mats[k] if mats else None
            ovr = ovr_map.get(k)
            ovr_tag = (
                f"{ovr[0]:.3f}_{ovr[1]:.3f}_{ovr[2]:.3f}_{ovr[3]:.3f}"
                if ovr is not None else "1"
            )
            bkey = f"{mname}|{'lm' if lm >= 0 else 'lit'}|{ovr_tag}"
            bkt = self.buckets.get(bkey)
            if bkt is None:
                bkt = {
                    "material": mname,
                    "glsm": glsm,
                    "lightmap": lm >= 0,
                    "overrideColor": ovr,
                    "pos": [],
                    "nrm": [],
                    "uv0": [],
                    "uv2": [],
                    "idx": [],
                    "vcount": 0,
                }
                self.buckets[bkey] = bkt
            remap = {}
            for a, b, c in tris:
                for vi in (a, b, c):
                    if vi not in remap:
                        gi = bkt["vcount"]
                        bkt["vcount"] = gi + 1
                        remap[vi] = gi
                        bkt["pos"].extend(v_pos[vi])
                        bkt["nrm"].extend(v_nrm[vi])
                        bkt["uv0"].extend(v_uv0[vi])
                        bkt["uv2"].extend(v_uv2[vi])
                ia, ib, ic = remap[a], remap[b], remap[c]
                if flip_winding:
                    bkt["idx"].extend((ia, ib, ic))
                else:
                    bkt["idx"].extend((ia, ic, ib))
            self.stats["tris"] += len(tris)
        self.stats["renderers"] += 1
        self.stats["verts"] += n
    def world(self, t):
        """World matrix of a Transform (walks the m_Father chain)."""
        chain = []
        cur = t
        guard = 0
        while cur is not None and guard < 64:
            chain.append(cur)
            f = getattr(cur, "m_Father", None)
            cur = f.read() if (f is not None and getattr(f, "m_PathID", 0)) else None
            guard += 1
        m = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
        for c in reversed(chain):
            p, q, s = assets.local_trs(c)
            m = mat_mul(m, trs(p, q, s))
        return m

    def run(self):
        env = assets.load_env()
        # scene roots
        roots = []
        for o in assets.objects_of(self.bundle, "Transform"):
            t = o.read()
            if t.m_Father.m_PathID == 0:
                name = t.m_GameObject.read().m_Name
                if name in ROOTS:
                    roots.append(o)
        # renderer lookup by GameObject path id
        # LODGroups: skip LOD1+ duplicate meshes
        for o in assets.objects_of(self.bundle, "LODGroup"):
            tt = o.read_typetree()
            if not tt.get("m_Enabled", 1):
                continue
            lods = tt.get("m_LODs") or []
            for lod in lods[1:]:
                for rref in lod.get("renderers") or []:
                    rpid = (rref.get("renderer") or {}).get("m_PathID", 0)
                    if rpid:
                        self.lod_skip_renderers.add(rpid)

        # MonoBehaviours: OverrideBaseColor, DecalProjector, and Stage Volumes
        raw_decals = []
        for o in assets.objects_of(self.bundle, "MonoBehaviour"):
            tt = o.read_typetree()
            if "materialIndex" in tt and "color" in tt:
                gpid = (tt.get("m_GameObject") or {}).get("m_PathID", 0)
                c = tt["color"]
                self.color_overrides.setdefault(gpid, {})[int(tt["materialIndex"])] = [
                    float(c["r"]), float(c["g"]), float(c["b"]), float(c["a"])
                ]
            elif "m_UVScale" in tt and "m_Size" in tt:
                if tt.get("m_Enabled", 1):
                    raw_decals.append((o, tt))
            elif tt.get("active") == 1:
                def _v(field, default=None):
                    d = tt.get(field)
                    return d.get("m_Value", default) if isinstance(d, dict) else default
                if "shadeColorMultiply" in tt and "mainLightAngle" in tt:
                    self.meta["volumes"]["actorParam"] = {
                        "lightColor": _v("lightColor"),
                        "mainLightAngle": _v("mainLightAngle"),
                        "shadeColorMultiply": _v("shadeColorMultiply"),
                        "shadeColorAdditive": _v("shadeColorAdditive"),
                        "rimAngle": _v("rimAngle"),
                        "rimBaseColorRatio": _v("rimBaseColorRatio"),
                        "rimPower": _v("rimPower"),
                        "rimColor": _v("rimColor"),
                    }
                elif "reflectionScale" in tt and "intensity" in tt:
                    self.meta["volumes"]["lightmap"] = {
                        "intensity": _v("intensity", 1.0),
                        "color": _v("color"),
                    }
                elif "threshold" in tt and "diffusion" in tt:
                    self.meta["volumes"]["bloom"] = {
                        "intensity": _v("intensity", 1.0),
                        "threshold": _v("threshold", 0.97),
                    }
                elif "postExposure" in tt and "saturation" in tt:
                    self.meta["volumes"]["colorAdjustments"] = {
                        "postExposure": _v("postExposure", 0.0),
                        "contrast": _v("contrast", 0.0),
                        "saturation": _v("saturation", 0.0),
                        "colorFilter": _v("colorFilter"),
                    }
                elif "radius" in tt and "maxAmount" in tt and "position" in tt:
                    pos_u = _v("position") or {"x": 0, "y": 0, "z": 0}
                    self.meta["volumes"]["skyHaze"] = {
                        "density": _v("density", 0.0),
                        "maxAmount": _v("maxAmount", 0.0),
                        "color": _v("color"),
                        "position": [pos_u["x"], pos_u["y"], -pos_u["z"]],
                        "radius": _v("radius", 1.0),
                    }

        # renderer lookup by GameObject path id
        renderers = {}
        filters = {}
        for o in assets.objects_of(self.bundle, "MeshRenderer"):
            r = o.read()
            try:
                go = r.m_GameObject.m_PathID
            except Exception:
                continue
            renderers[go] = (r, o.path_id)
        for o in assets.objects_of(self.bundle, "MeshFilter"):
            f = o.read()
            filters[f.m_GameObject.m_PathID] = f
        identity = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
        active_go_world = {}
        for r in roots:
            node, _ = assets.skeleton(r)
            flat = []
            self.walk(node, identity, flat)
            for n, m in flat:
                active_go_world[n.go] = m
                if n.go in renderers and n.go in filters:
                    mr_obj, mr_pid = renderers[n.go]
                    self.add_renderer(n, m, filters[n.go], mr_obj, mr_pid)

        # Build numpy triangle array from opaque stage buckets to snap DecalProjectors onto exact surfaces
        import numpy as np
        tri_list = []
        for bkt in self.buckets.values():
            if not bkt["idx"]:
                continue
            mfl = self.meta["materials"].get(bkt["material"], {}).get("floats", {})
            if "glass" in bkt["material"].lower() or mfl.get("_DstBlend") == 10.0:
                continue
            vp = np.array(bkt["pos"], dtype=np.float32).reshape(-1, 3)
            # Convert back to Unity space (x, y, -z) for raycast
            vp[:, 2] = -vp[:, 2]
            vi = np.array(bkt["idx"], dtype=np.int32).reshape(-1, 3)
            tri_list.append(vp[vi])
        if tri_list:
            all_tris = np.concatenate(tri_list, axis=0) # (T, 3, 3)
            tri_min = all_tris.min(axis=1)
            tri_max = all_tris.max(axis=1)
        else:
            all_tris = None

        # Export active DecalProjectors as oriented planar quads snapped to target surfaces
        for o, tt in raw_decals:
            gpid = (tt.get("m_GameObject") or {}).get("m_PathID", 0)
            wm = active_go_world.get(gpid)
            if wm is None:
                continue
            mb = o.read()
            try:
                dmat = mb.m_Material.read()
            except Exception:
                continue
            self.material(dmat)
            mentry = self.meta["materials"].get(dmat.m_Name, {})
            tex_rel = mentry.get("maps", {}).get("_BaseMap") or mentry.get("maps", {}).get("_MainTex")
            if not tex_rel:
                continue
            off = tt["m_Offset"]
            sz = tt["m_Size"]
            uvs = tt["m_UVScale"]
            uvb = tt["m_UVBias"]
            scale_mode = int(tt.get("m_ScaleMode", 1))
            use_m = wm
            z_scale = math.sqrt(wm[2]**2 + wm[6]**2 + wm[10]**2) or 1.0
            if scale_mode == 0:
                c0 = math.sqrt(wm[0]**2 + wm[4]**2 + wm[8]**2) or 1.0
                c1 = math.sqrt(wm[1]**2 + wm[5]**2 + wm[9]**2) or 1.0
                use_m = [
                    wm[0]/c0, wm[1]/c1, wm[2]/z_scale, wm[3],
                    wm[4]/c0, wm[5]/c1, wm[6]/z_scale, wm[7],
                    wm[8]/c0, wm[9]/c1, wm[10]/z_scale, wm[11],
                    0.0, 0.0, 0.0, 1.0,
                ]
                z_scale = 1.0
            # Outward surface normal is -Z of decal projector; projection ray goes along +Z = -nout_u
            nz = (-use_m[2], -use_m[6], -use_m[10])
            nl = math.sqrt(nz[0]**2 + nz[1]**2 + nz[2]**2) or 1.0
            nout_u = (nz[0] / nl, nz[1] / nl, nz[2] / nl)
            hx, hy, hz = 0.5 * float(sz["x"]), 0.5 * float(sz["y"]), 0.5 * float(sz["z"])
            ox, oy, oz = float(off["x"]), float(off["y"]), float(off["z"])

            # Raycast from front of projector box (oz - 1.2*hz) along +Z to snap onto front-most surface
            bias = 0.0022
            if all_tris is not None and hz > 1e-4:
                p_start = np.array(xform(use_m, (ox, oy, oz - 1.2 * hz)), dtype=np.float32)
                ray_d = np.array([-nout_u[0], -nout_u[1], -nout_u[2]], dtype=np.float32)
                max_t = 2.4 * hz * z_scale
                p_end = p_start + ray_d * max_t
                rmin = np.minimum(p_start, p_end) - 0.05
                rmax = np.maximum(p_start, p_end) + 0.05
                mask = np.all((tri_max >= rmin) & (tri_min <= rmax), axis=1)
                cand = all_tris[mask]
                if len(cand):
                    v0 = cand[:, 0]
                    e1 = cand[:, 1] - v0
                    e2 = cand[:, 2] - v0
                    h_vec = np.cross(ray_d, e2)
                    det = np.einsum("ij,ij->i", e1, h_vec)
                    valid = np.abs(det) > 1e-7
                    if np.any(valid):
                        inv_det = 1.0 / det[valid]
                        s_vec = p_start - v0[valid]
                        u_b = np.einsum("ij,ij->i", s_vec, h_vec[valid]) * inv_det
                        q_vec = np.cross(s_vec, e1[valid])
                        v_b = np.einsum("j,ij->i", ray_d, q_vec) * inv_det
                        t_hit = np.einsum("ij,ij->i", e2[valid], q_vec) * inv_det
                        ok = (u_b >= -0.02) & (v_b >= -0.02) & (u_b + v_b <= 1.04) & (t_hit >= 0.0) & (t_hit <= max_t)
                        if np.any(ok):
                            best_t = float(t_hit[ok].min())
                            # Center is at 1.2 * hz * z_scale from p_start along ray_d (-nout_u)
                            bias = (1.2 * hz * z_scale - best_t) + 0.0022

            corners_local = [
                (ox - hx, oy - hy, oz),
                (ox + hx, oy - hy, oz),
                (ox + hx, oy + hy, oz),
                (ox - hx, oy + hy, oz),
            ]
            corners_3js = []
            for cl in corners_local:
                pw = xform(use_m, cl)
                pw = (pw[0] + nout_u[0] * bias, pw[1] + nout_u[1] * bias, pw[2] + nout_u[2] * bias)
                corners_3js.extend(conv(pw))
            u0 = float(uvb["x"])
            u1 = float(uvb["x"]) + float(uvs["x"])
            v0_u = float(uvb["y"])
            v1_u = float(uvb["y"]) + float(uvs["y"])
            # Flip V for top-down PNG with flipY=false
            quad_uvs = [
                u0, 1.0 - v0_u,
                u1, 1.0 - v0_u,
                u1, 1.0 - v1_u,
                u0, 1.0 - v1_u,
            ]
            rgba = int((tt.get("m_Color") or {}).get("rgba", 0xFFFFFFFF)) & 0xFFFFFFFF
            cr = (rgba & 0xFF) / 255.0
            cg = ((rgba >> 8) & 0xFF) / 255.0
            cb = ((rgba >> 16) & 0xFF) / 255.0
            ca = ((rgba >> 24) & 0xFF) / 255.0
            self.meta["decals"].append({
                "material": dmat.m_Name,
                "map": tex_rel,
                "positions": [round(x, 5) for x in corners_3js],
                "normal": [round(x, 5) for x in conv(nout_u)],
                "uvs": [round(x, 5) for x in quad_uvs],
                "fade": round(float(tt.get("m_FadeFactor", 1.0)) * ca, 4),
                "color": [round(cr, 4), round(cg, 4), round(cb, 4)],
                "priority": int(tt.get("m_DecalPriority", 0)),
                "isShadow": "shadow" in dmat.m_Name.lower(),
            })
            self.stats["decals"] += 1

        # Skybox texture from t_sky_noon-00
        try:
            sky_b = assets.bundle_file(SKY_BUNDLE)
            for o in assets.objects_of(sky_b, "Texture2D"):
                tx = o.read()
                if tx.m_Name == SKY_BUNDLE:
                    self.meta["skybox"] = self.texture(tx)
                    break
        except Exception:
            pass

        # lights (position & forward direction from the GameObject's transform chain)
        for o in assets.objects_of(self.bundle, "Light"):
            L = o.read()
            try:
                go = L.m_GameObject.read()
                if not getattr(go, "m_IsActive", 1):
                    continue
                tr = go.m_Transform.read()
            except Exception:
                tr = None
            w = self.world(tr) if tr is not None else identity
            p2 = conv((w[3], w[7], w[11]))
            fw_u = (w[2], w[6], w[10])
            fl = math.sqrt(sum(c * c for c in fw_u)) or 1.0
            d2 = conv((fw_u[0] / fl, fw_u[1] / fl, fw_u[2] / fl))
            self.meta["lights"].append({
                "name": go.m_Name if tr is not None else "light",
                "type": int(L.m_Type),
                "color": [L.m_Color.r, L.m_Color.g, L.m_Color.b],
                "intensity": float(L.m_Intensity),
                "range": float(L.m_Range),
                "spotAngle": float(getattr(L, "m_SpotAngle", 0.0)),
                "position": [p2[0], p2[1], p2[2]],
                "direction": [d2[0], d2[1], d2[2]],
                "shadows": int(getattr(L.m_Shadows, "value", 0)) if hasattr(L, "m_Shadows") else 0,
            })
        for o in assets.objects_of(self.bundle, "RenderSettings"):
            rs = o.read()
            self.meta["renderSettings"] = {
                "ambientMode": int(rs.m_AmbientMode) if hasattr(rs, "m_AmbientMode") else None,
                "ambientSkyColor": [rs.m_AmbientSkyColor.r, rs.m_AmbientSkyColor.g, rs.m_AmbientSkyColor.b],
                "ambientEquatorColor": [rs.m_AmbientEquatorColor.r, rs.m_AmbientEquatorColor.g, rs.m_AmbientEquatorColor.b],
                "ambientGroundColor": [rs.m_AmbientGroundColor.r, rs.m_AmbientGroundColor.g, rs.m_AmbientGroundColor.b],
                "ambientIntensity": getattr(rs, "m_AmbientIntensity", 1.0),
                "fog": bool(getattr(rs, "m_Fog", False)),
                "fogColor": [rs.m_FogColor.r, rs.m_FogColor.g, rs.m_FogColor.b] if hasattr(rs, "m_FogColor") else None,
                "fogDensity": getattr(rs, "m_FogDensity", 0.0),
            }
        # lightmap textures (renderers use atlas 0)
        lms = {}
        for o in assets.objects_of(self.bundle, "Texture2D"):
            t = o.read()
            if t.m_Name.startswith("Lightmap-0_comp_light"):
                lms["light"] = self.texture(t)
            elif t.m_Name.startswith("Lightmap-0_comp_shadowmask"):
                lms["shadow"] = self.texture(t)
        self.meta["lightmap"] = lms

        # Build ONE merged glTF primitive per (material, lightmapped, overrideColor) bucket
        self.meta["prims"] = {}
        for i, (bkey, bkt) in enumerate(self.buckets.items()):
            if not bkt["idx"]:
                continue
            name = f"bkt_{i}"
            attrs = {
                "POSITION": self.glb.floats(bkt["pos"], "VEC3"),
                "NORMAL": self.glb.floats(bkt["nrm"], "VEC3"),
                "TEXCOORD_0": self.glb.floats(bkt["uv0"], "VEC2"),
                "TEXCOORD_2": self.glb.floats(bkt["uv2"], "VEC2"),
            }
            acc = self.glb.uints(bkt["idx"], "SCALAR")
            prim = self.glb.primitive(attrs, acc, material=bkt["glsm"])
            idx = self.glb.mesh(name, [prim])
            self.glb.node(f"env_{name}", None, None, mesh=idx)
            self.meta["prims"][name] = {
                "material": bkt["material"],
                "lightmap": bkt["lightmap"],
                "overrideColor": bkt["overrideColor"],
            }
        self.glb.save(OUT / "env.glb")
        (OUT / "env.json").write_text(json.dumps(self.meta, indent=1), encoding="utf-8")
        print("env stats", self.stats, "materials", len(self.meta["materials"]),
              "textures", len(self.tex_done), "buckets", len(self.meta["prims"]))


def main():
    assets.load_env()
    EnvExporter(assets.bundle_file(SCENE)).run()


if __name__ == "__main__":
    main()
