"""Minimal GLB (glTF 2.0 binary) writer: meshes, skins, morph targets, images.

Kept deliberately small - only what the ADV viewer needs. All geometry is
written as float32 / uint32, images embedded as PNG blobs inside the binary
chunk, so the resulting .glb is a single self-contained file.
"""
from __future__ import annotations

import json
import struct
from typing import Dict, List, Optional, Sequence

COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4,
              "MAT3": 9, "MAT4": 16}

FLOAT = 5126
UINT = 5125
USHORT = 5123
UBYTE = 5121
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.json = {
            "asset": {"version": "2.0", "generator": "adv_viewer"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "materials": [],
            "accessors": [],
            "bufferViews": [],
            "buffers": [{"byteLength": 0}],
            "textures": [],
            "images": [],
            "samplers": [],
            "skins": [],
        }
        self._view_cache: Dict[int, int] = {}

    # ---- low level ----
    def _align(self):
        while len(self.bin) % 4:
            self.bin.append(0)

    def view(self, data: bytes, target: Optional[int] = None) -> int:
        self._align()
        off = len(self.bin)
        self.bin += data
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        self.json["bufferViews"].append(v)
        return len(self.json["bufferViews"]) - 1

    def accessor(self, view: int, component_type: int, count: int,
                 type_: str, minv=None, maxv=None, normalized=False) -> int:
        a = {"bufferView": view, "componentType": component_type,
             "count": count, "type": type_}
        if minv is not None:
            a["min"] = minv
        if maxv is not None:
            a["max"] = maxv
        if normalized:
            a["normalized"] = True
        self.json["accessors"].append(a)
        return len(self.json["accessors"]) - 1

    def floats(self, values: Sequence[float], type_: str) -> int:
        n = COMPONENTS[type_]
        data = struct.pack(f"<{len(values)}f", *values)
        v = self.view(data, ARRAY_BUFFER)
        return self.accessor(v, FLOAT, len(values) // n, type_)

    def uints(self, values: Sequence[int], type_: str) -> int:
        n = COMPONENTS[type_]
        data = struct.pack(f"<{len(values)}I", *values)
        v = self.view(data, ELEMENT_ARRAY_BUFFER)
        return self.accessor(v, UINT, len(values) // n, type_)

    def ushorts(self, values: Sequence[int], type_: str) -> int:
        n = COMPONENTS[type_]
        data = struct.pack(f"<{len(values)}H", *values)
        v = self.view(data, ARRAY_BUFFER)
        return self.accessor(v, USHORT, len(values) // n, type_)

    def sparse_float_accessor(self, count: int, type_: str,
                              indices: Sequence[int], values: Sequence[float]) -> int:
        """Sparse accessor (used for morph targets)."""
        n = COMPONENTS[type_]
        idata = struct.pack(f"<{len(indices)}I", *indices)
        v_idx = self.view(idata, ARRAY_BUFFER)
        v_idx_acc = self.accessor(v_idx, UINT, len(indices), "SCALAR")
        v_val = self.view(struct.pack(f"<{len(values)}f", *values), ARRAY_BUFFER)
        v_val_acc = self.accessor(v_val, FLOAT, len(values) // n, type_)
        self.json["accessors"].append({
            "componentType": FLOAT, "count": count, "type": type_,
            "sparse": {
                "count": len(indices),
                "indices": {"bufferView": v_idx, "componentType": UINT},
                "values": {"bufferView": v_val},
            },
        })
        return len(self.json["accessors"]) - 1

    # ---- high level ----
    def node(self, name: str, trs=None, parent: Optional[int] = None,
             mesh: Optional[int] = None, skin: Optional[int] = None,
             weights: Optional[List[float]] = None) -> int:
        n = {"name": name}
        if trs is not None:
            t, r, s = trs
            if t != (0.0, 0.0, 0.0):
                n["translation"] = list(t)
            if r != (0.0, 0.0, 0.0, 1.0):
                n["rotation"] = list(r)
            if s != (1.0, 1.0, 1.0):
                n["scale"] = list(s)
        if mesh is not None:
            n["mesh"] = mesh
        if skin is not None:
            n["skin"] = skin
        if weights is not None:
            n["weights"] = list(weights)
        idx = len(self.json["nodes"])
        self.json["nodes"].append(n)
        if parent is not None:
            self.json["nodes"][parent].setdefault("children", []).append(idx)
        else:
            self.json["scenes"][0]["nodes"].append(idx)
        return idx

    def image_uri(self, name: str, uri: str) -> int:
        self.json["images"].append({"name": name, "uri": uri})
        return len(self.json["images"]) - 1

    def image_png(self, name: str, png: bytes) -> int:
        v = self.view(png)
        self.json["images"].append({"name": name, "mimeType": "image/png",
                                    "bufferView": v})
        return len(self.json["images"]) - 1

    def texture(self, image: int, sampler: Optional[int] = None) -> int:
        t = {"source": image}
        if sampler is not None:
            t["sampler"] = sampler
        self.json["textures"].append(t)
        return len(self.json["textures"]) - 1

    def sampler(self, wrap_s=10497, wrap_t=10497) -> int:
        self.json["samplers"].append({"magFilter": 9729, "minFilter": 9987,
                                      "wrapS": wrap_s, "wrapT": wrap_t})
        return len(self.json["samplers"]) - 1

    def material(self, name: str, base_color_texture: Optional[int] = None,
                 base_color=(1.0, 1.0, 1.0, 1.0), double_sided=True,
                 alpha_mode: Optional[str] = None) -> int:
        pbr = {"baseColorFactor": list(base_color),
               "metallicFactor": 0.0, "roughnessFactor": 1.0}
        if base_color_texture is not None:
            pbr["baseColorTexture"] = {"index": base_color_texture}
        m = {"name": name, "pbrMetallicRoughness": pbr, "doubleSided": double_sided}
        if alpha_mode:
            m["alphaMode"] = alpha_mode
        self.json["materials"].append(m)
        return len(self.json["materials"]) - 1

    def primitive(self, attributes: Dict[str, int], indices: int,
                  material: Optional[int] = None,
                  targets: Optional[List[Dict[str, int]]] = None) -> dict:
        p = {"attributes": attributes, "indices": indices, "mode": 4}
        if material is not None:
            p["material"] = material
        if targets:
            p["targets"] = targets
        return p

    def mesh(self, name: str, primitives: List[dict],
             weights: Optional[List[float]] = None) -> int:
        m = {"name": name, "primitives": primitives}
        if weights:
            m["weights"] = list(weights)
        self.json["meshes"].append(m)
        return len(self.json["meshes"]) - 1

    def skin(self, name: str, joints: List[int], ibms: Sequence[float],
             skeleton: Optional[int] = None) -> int:
        data = struct.pack(f"<{len(ibms)}f", *ibms)
        v = self.view(data)
        acc = self.accessor(v, FLOAT, len(joints), "MAT4")
        s = {"name": name, "joints": joints, "inverseBindMatrices": acc}
        if skeleton is not None:
            s["skeleton"] = skeleton
        self.json["skins"].append(s)
        return len(self.json["skins"]) - 1

    # ---- output ----
    def to_glb(self) -> bytes:
        self._align()
        self.json["buffers"][0]["byteLength"] = len(self.bin)
        js = json.dumps(self.json, separators=(",", ":")).encode("utf-8")
        while len(js) % 4:
            js += b" "
        b = bytes(self.bin)
        while len(b) % 4:
            b += b"\0"
        total = 12 + 8 + len(js) + 8 + len(b)
        out = bytearray()
        out += struct.pack("<4sII", b"glTF", 2, total)
        out += struct.pack("<I4s", len(js), b"JSON") + js
        out += struct.pack("<I4s", len(b), b"BIN\0") + b
        return bytes(out)

    def save(self, path) -> None:
        with open(path, "wb") as f:
            f.write(self.to_glb())
