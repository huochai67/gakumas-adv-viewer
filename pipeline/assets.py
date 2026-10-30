"""UnityPy helpers for the gakumas asset bundles: loading, meshes, textures,
skeletons and PPtr resolution across bundles.

All bundles are loaded into ONE UnityPy environment so cross-bundle PPtrs
(shaders, meshes, textures living in dependency bundles) resolve.
"""
from __future__ import annotations

import glob
import io
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import UnityPy
from UnityPy.helpers import MeshHelper

ROOT = Path(__file__).resolve().parent.parent
BUNDLES = ROOT / "cache" / "bundles"
UNITY_VERSION = "6000.0.77f1"


def resolve_dump_dll() -> Path:
    env_path = os.environ.get("GAKUMAS_DUMMY_DLL")
    candidates = [
        Path(env_path) if env_path else None,
        ROOT / "cache" / "DummyDll",
        Path(r"C:\workspace\GakumasAuto\tools\il2cpp-re\dumper\DummyDll"),
    ]
    for p in candidates:
        if p is not None and p.is_dir():
            return p
    return ROOT / "cache" / "DummyDll"


DUMP_DLL = resolve_dump_dll()

_env = None


def load_env():
    """Load every bundle into one environment (cached)."""
    global _env
    if _env is not None:
        return _env
    UnityPy.config.FALLBACK_UNITY_VERSION = UNITY_VERSION
    from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator

    gen = TypeTreeGenerator(UNITY_VERSION)
    for dll in glob.glob(str(DUMP_DLL / "*.dll")):
        gen.load_dll(open(dll, "rb").read())

    files = sorted(glob.glob(str(BUNDLES / "*.bundle")))
    env = UnityPy.load(*files)
    env.typetree_generator = gen
    _env = env
    return env


def bundle_file(name: str):
    """Return the BundleFile for a bundle name (scopes object lookups)."""
    env = load_env()
    for f in env.files.values():
        if getattr(f, "name", None) == name + ".bundle":
            return f
    raise KeyError(name)


def objects_of(container, type_name: str):
    """Objects of a type inside a BundleFile / SerializedFile."""
    return [o for o in container.get_objects() if o.type.name == type_name]


def named(container, type_name: str, name: str):
    for o in objects_of(container, type_name):
        try:
            if o.read().m_Name == name:
                return o.read()
        except Exception:
            continue
    raise KeyError(name)


class Node:
    __slots__ = ("path_id", "go", "name", "active", "transform", "parent", "children")

    def __init__(self, path_id, go, name, active, transform, parent):
        self.path_id = path_id      # Transform path id
        self.go = go                # GameObject path id
        self.name = name
        self.active = active
        self.transform = transform
        self.parent = parent
        self.children: List["Node"] = []
    def __repr__(self):
        return f"<Node {self.name}>"


def skeleton(root) -> Tuple[Node, Dict[int, Node]]:
    """Walk a Unity transform tree (root = Object wrapper or Transform instance)."""
    table: Dict[int, Node] = {}
    go_cache: Dict[int, Tuple[str, bool]] = {}

    def go_info(pptr):
        if pptr.m_PathID in go_cache:
            return go_cache[pptr.m_PathID]
        g = pptr.read()
        info = (g.m_Name, bool(getattr(g, "m_IsActive", 1)))
        go_cache[pptr.m_PathID] = info
        return info

    def build(pptr_or_obj, parent):
        if hasattr(pptr_or_obj, "read"):
            pid = pptr_or_obj.path_id
            t = pptr_or_obj.read()
        else:
            pid = getattr(pptr_or_obj, "path_id", None)
            t = pptr_or_obj
        gname, gactive = go_info(t.m_GameObject)
        n = Node(pid, t.m_GameObject.m_PathID, gname, gactive, t, parent)
        table[pid] = n
        for c in t.m_Children:
            n.children.append(build(c, n))
        return n
    return build(root, None), table


def local_trs(t) -> Tuple[Tuple[float, float, float], Tuple[float, float, float, float],
                          Tuple[float, float, float]]:
    p = t.m_LocalPosition
    q = t.m_LocalRotation
    s = t.m_LocalScale
    return (p.x, p.y, p.z), (q.x, q.y, q.z, q.w), (s.x, s.y, s.z)


def mesh_data(mesh) -> dict:
    """Extract renderable vertex data from a Unity Mesh."""
    h = MeshHelper.MeshHandler(mesh)
    h.process()
    verts = h.m_Vertices or []
    normals = h.m_Normals or []
    tangents = h.m_Tangents or []
    uvs0 = h.m_UV0 or []
    uvs1 = h.m_UV1 or []
    colors = h.m_Colors or []
    subs = []
    tris = []
    per_sub = h.get_triangles() or []
    for s, tlist in zip(mesh.m_SubMeshes, per_sub):
        base = getattr(s, "baseVertex", 0) or 0
        start = len(tris)
        for t in tlist:
            tris.append((t[0] + base, t[1] + base, t[2] + base))
        subs.append((start, len(tlist), s.topology))
    skinned = bool(mesh.m_BindPose)
    bones = h.m_BoneIndices or []
    weights = h.m_BoneWeights or []
    return {
        "name": mesh.m_Name,
        "vertices": [(v[0], v[1], v[2]) for v in verts],
        "normals": [(n[0], n[1], n[2]) for n in normals],
        "tangents": [(t[0], t[1], t[2], t[3]) for t in tangents],
        "uv0": [(u[0], u[1]) for u in uvs0],
        "uv1": [(u[0], u[1]) for u in uvs1],
        "colors": colors,
        "triangles": tris,
        "submeshes": subs,
        "index_format": mesh.m_IndexFormat,
        "n_indices": len(tris) * 3,
        "bones": bones,
        "weights": weights,
        "blendshape_names": [s.name for s in getattr(mesh.m_Shapes, "shapes", [])],
    }


def texture_png(tex) -> bytes:
    """Decode a Texture2D to PNG bytes."""
    img = tex.image
    if img is None:
        raise ValueError(f"cannot decode texture {tex.m_Name}")
    if img.mode not in ("RGBA", "RGB"):
        img = img.convert("RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
