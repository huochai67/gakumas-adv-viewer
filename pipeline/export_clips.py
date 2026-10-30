"""Export AnimationClips (body motions + facial motions) to JSON tracks.

Track kinds:
  bone  - Unity Transform curves (position / rotation / scale / euler) keyed by
          glTF node index of the target bone
  muscle- humanoid muscle curve (index 0..94; 95..136 are translation-DOF slots
          this viewer does not consume)
  blend - VLActorFaceModel blendShapeWeights.w{major}.w{minor} curve

All tracks are sampled at the clip's 30 Hz rate into flat float arrays.
"""
from __future__ import annotations

import json
import zlib
from pathlib import Path

import assets
from unity_anim import ClipSampler, binding_dimension, crc32

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "assets" / "clips"

MUSCLE_BASE = 42
MUSCLE_COUNT = 95
ROOT_PROPS = [
    ("rootT", 7, 3),
    ("rootQ", 10, 4),
    ("lfT", 14, 3),
    ("rfT", 21, 3),
    ("lhQ", 31, 4),
    ("rhQ", 38, 4),
]
TRANSFORM_PROPS = {1: "position", 2: "rotation", 3: "scale", 4: "euler"}

def node_path_table(body_bundle):
    """hash -> (node path id, relative path string) for transform curve paths."""
    root = None
    for o in assets.objects_of(body_bundle, "Transform"):
        t = o.read()
        if t.m_Father.m_PathID == 0 and t.m_GameObject.read().m_Name.startswith("mdl_"):
            root = o
            break
    node, table = assets.skeleton(root)
    out = {}
    prefixes = ["Root_Body/", "Root/", ""]

    def walk(n, path):
        for pre in prefixes:
            s = pre + path
            out.setdefault(crc32(s), (n.path_id, s))
        for c in n.children:
            walk(c, path + "/" + c.name if path else c.name)

    walk(node, "")
    return out


def blend_table(face_bundle):
    out = {}
    for o in assets.objects_of(face_bundle, "MonoBehaviour"):
        t = o.read_typetree()
        if "blendShapes" not in t:
            continue
        for i in range(len(t["blendShapes"])):
            p = f"blendShapeWeights.w{i // 16}.w{i % 16}"
            out[crc32(p)] = (i, p)
        break
    return out


def export_clip(bundle_name, paths, blends, meta_nodes):
    bundle = assets.bundle_file(bundle_name)
    clips = assets.objects_of(bundle, "AnimationClip")
    out = []
    for o in clips:
        a = o.read()
        bindings = a.m_ClipBindingConstant.genericBindings
        stop = a.m_MuscleClip.m_StopTime
        nframes = max(1, int(round(stop * 30)) + 1)
        times = [i / 30.0 for i in range(nframes)]
        s = ClipSampler(a, bindings, stop)
        tracks = []
        root_slots = {}
        unresolved = 0
        slot = 0
        for gb in bindings:
            dim = binding_dimension(gb)
            if gb.typeID == 4 and gb.attribute in TRANSFORM_PROPS:
                info = paths.get(gb.path)
                if info is None:
                    unresolved += 1
                elif a.m_Name.find("facial") == -1:
                    node_id = info[0] if info[0] >= 0 else None
                    if node_id is not None:
                        vals = [round(s.value(slot + k, t), 5) for t in times for k in range(dim)]
                        tracks.append({"kind": "bone", "node": node_id,
                                       "prop": TRANSFORM_PROPS[gb.attribute],
                                       "values": vals, "dim": dim,
                                       "path": info[1]})
            elif gb.typeID == 95 and gb.customType == 8:
                attr = int(gb.attribute)
                if MUSCLE_BASE <= attr < MUSCLE_BASE + MUSCLE_COUNT:
                    tracks.append({
                        "kind": "muscle",
                        "index": attr - MUSCLE_BASE,
                        "values": [round(s.value(slot, t), 5) for t in times],
                    })
                else:
                    for rname, rbase, rdim in ROOT_PROPS:
                        if rbase <= attr < rbase + rdim:
                            root_slots[(rname, attr - rbase)] = slot
            elif gb.typeID == 114:
                info = blends.get(gb.attribute)
                if info is not None:
                    tracks.append({"kind": "blend", "index": info[0],
                                   "values": [round(s.value(slot, t), 4) for t in times]})
                elif gb.attribute == 682354173:
                    tracks.append({"kind": "custom", "index": 0,
                                   "values": [round(s.value(slot, t), 4) for t in times]})
                else:
                    unresolved += 1
            slot += dim
        for rname, rbase, rdim in ROOT_PROPS:
            if all((rname, k) in root_slots for k in range(rdim)):
                tracks.append({
                    "kind": "root",
                    "prop": rname,
                    "dim": rdim,
                    "values": [
                        round(s.value(root_slots[(rname, k)], t), 5)
                        for t in times for k in range(rdim)
                    ],
                })
        out.append({
            "name": a.m_Name,
            "duration": stop,
            "frameCount": nframes,
            "tracks": tracks,
            "unresolved": unresolved,
        })
    return out


def main():
    assets.load_env()
    body = assets.bundle_file("mdl_chr_amao-casl-0000_body")
    face = assets.bundle_file("mdl_chr_amao-base-0000_face")
    paths = node_path_table(body)
    blends = blend_table(face)

    char_meta = json.loads((ROOT / "web" / "assets" / "char.json").read_text())
    by_path = char_meta.get("nodeByPathId", {})
    paths2 = {h: (int(by_path.get(str(v[0]), -1)), v[1]) for h, v in paths.items()}

    OUT.mkdir(parents=True, exist_ok=True)
    wanted = [n for n in __import__("glob").glob(str(ROOT / "cache" / "bundles" / "mot_*.bundle"))]
    total = 0
    for p in wanted:
        bname = Path(p).stem
        clips = export_clip(bname, paths2, blends, {})
        total += len(clips)
        for c in clips:
            (OUT / f"{c['name']}.json").write_text(json.dumps(c, separators=(",", ":")),
                                                   encoding="utf-8")
        print(bname, [(c["name"], c["frameCount"], len(c["tracks"]), c["unresolved"]) for c in clips])
    print("clips", total)


if __name__ == "__main__":
    main()
