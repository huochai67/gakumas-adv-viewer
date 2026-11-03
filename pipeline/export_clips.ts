/**
 * Export AnimationClips (body motions + facial motions) to JSON tracks.
 *
 * Track kinds:
 *   bone  - Unity Transform curves (position / rotation / scale / euler) keyed by
 *           glTF node index of the target bone
 *   muscle- humanoid muscle curve (index 0..94; 95..136 are translation-DOF slots
 *           this viewer does not consume)
 *   blend - VLActorFaceModel blendShapeWeights.w{major}.w{minor} curve
 *
 * All tracks are sampled at the clip's 30 Hz rate into flat float arrays.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bundleFile,
  loadEnv,
  objectsOf,
  skeleton,
  type BundleContainer,
  type SkeletonNode,
} from "./assets";
import { ClipSampler, bindingDimension, crc32 } from "./core/unity_anim.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "web", "assets", "clips");
/** Typetree record (dynamic Unity serialized data). */
type Rec = Record<string, any>;

const BUNDLES = path.join(ROOT, "cache", "bundles");

const MUSCLE_BASE = 42;
const MUSCLE_COUNT = 95;
const ROOT_PROPS: Array<[string, number, number]> = [
  ["rootT", 7, 3],
  ["rootQ", 10, 4],
  ["lfT", 14, 3],
  ["rfT", 21, 3],
  ["lhT", 28, 3],
  ["lhQ", 31, 4],
  ["rhT", 35, 3],
  ["rhQ", 38, 4],
];
const TRANSFORM_PROPS: Record<number, string> = {
  1: "position",
  2: "rotation",
  3: "scale",
  4: "euler",
};

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Python's round(): ties to even. */
function pyRound(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function nodePathTable(body_bundle: BundleContainer): Map<number, [bigint, string]> {
  let root: any = null;
  for (const o of objectsOf(body_bundle, "Transform")) {
    const t = o.read() as Rec;
    if (BigInt(t.m_Father?.m_PathID ?? 0) !== 0n) continue;
    const go = loadEnv().readPPtr(o.assetsFile, t.m_GameObject);
    if (String(go?.m_Name ?? "").startsWith("mdl_")) {
      root = o;
      break;
    }
  }
  if (root === null) throw new Error("no root transform");
  const [node] = skeleton(root, loadEnv());
  const out = new Map<number, [bigint, string]>();
  const prefixes = ["Root_Body/", "Root/", ""];

  const walk = (n: SkeletonNode, p: string): void => {
    for (const pre of prefixes) {
      const s = pre + p;
      const h = crc32(s) >>> 0;
      if (!out.has(h)) out.set(h, [n.path_id, s]);
    }
    for (const c of n.children) walk(c, p ? p + "/" + c.name : c.name);
  };

  walk(node, "");
  return out;
}

function blendTable(face_bundle: BundleContainer): Map<number, [number, string]> {
  const out = new Map<number, [number, string]>();
  for (const o of objectsOf(face_bundle, "MonoBehaviour")) {
    const t = o.read() as Rec;
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

interface ClipTrack {
  kind: string;
  [key: string]: unknown;
}

function exportClip(
  bundle_name: string,
  paths: Map<number, [bigint | number, string]>,
  blends: Map<number, [number, string]>,
  meta_nodes: unknown,
): any[] {
  const bundle = bundleFile(bundle_name);
  const clips = objectsOf(bundle, "AnimationClip");
  const out: any[] = [];
  for (const o of clips) {
    const a = o.read() as Rec;
    const bindings: any[] = a.m_ClipBindingConstant?.genericBindings ?? [];
    const stop: number = a.m_MuscleClip.m_StopTime;
    const nframes = Math.max(1, pyRound(stop * 30) + 1);
    const times: number[] = [];
    for (let i = 0; i < nframes; i++) times.push(i / 30.0);
    const s = new ClipSampler(a, bindings, stop);
    const tracks: ClipTrack[] = [];
    const root_slots = new Map<string, number>();
    let unresolved = 0;
    let slot = 0;
    for (const gb of bindings) {
      const dim = bindingDimension(gb);
      if (gb.typeID === 4 && Object.prototype.hasOwnProperty.call(TRANSFORM_PROPS, gb.attribute)) {
        const info = paths.get(gb.path >>> 0);
        if (info === undefined) {
          unresolved += 1;
        } else if (!String(a.m_Name).includes("facial")) {
          const node_id = Number(info[0]) >= 0 ? Number(info[0]) : null;
          if (node_id !== null) {
            const vals: number[] = [];
            for (const t of times) {
              for (let k = 0; k < dim; k++) vals.push(round5(s.value(slot + k, t)));
            }
            tracks.push({
              kind: "bone",
              node: node_id,
              prop: TRANSFORM_PROPS[gb.attribute],
              values: vals,
              dim,
              path: info[1],
            });
          }
        }
      } else if (gb.typeID === 95 && gb.customType === 8) {
        const attr = Math.trunc(gb.attribute);
        if (attr >= MUSCLE_BASE && attr < MUSCLE_BASE + MUSCLE_COUNT) {
          const vals: number[] = [];
          for (const t of times) vals.push(round5(s.value(slot, t)));
          tracks.push({ kind: "muscle", index: attr - MUSCLE_BASE, values: vals });
        } else {
          for (const [rname, rbase, rdim] of ROOT_PROPS) {
            if (attr >= rbase && attr < rbase + rdim) {
              root_slots.set(`${rname}/${attr - rbase}`, slot);
            }
          }
        }
      } else if (gb.typeID === 114) {
        const info = blends.get(gb.attribute >>> 0);
        if (info !== undefined) {
          const vals: number[] = [];
          for (const t of times) vals.push(round4(s.value(slot, t)));
          tracks.push({ kind: "blend", index: info[0], values: vals });
        } else if (gb.attribute === 682354173) {
          const vals: number[] = [];
          for (const t of times) vals.push(round4(s.value(slot, t)));
          tracks.push({ kind: "custom", index: 0, values: vals });
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
      const vals: number[] = [];
      for (const t of times) {
        for (let k = 0; k < rdim; k++) {
          vals.push(round5(s.value(root_slots.get(`${rname}/${k}`)!, t)));
        }
      }
      tracks.push({ kind: "root", prop: rname, dim: rdim, values: vals });
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

function main(): void {
  loadEnv();
  const body = bundleFile("mdl_chr_amao-casl-0000_body");
  const face = bundleFile("mdl_chr_amao-base-0000_face");
  const paths = nodePathTable(body);
  const blends = blendTable(face);

  const char_meta = JSON.parse(readFileSync(path.join(ROOT, "web", "assets", "char.json"), "utf8"));
  const by_path: Record<string, number> = char_meta.nodeByPathId ?? {};
  const paths2 = new Map<number, [number, string]>();
  for (const [h, v] of paths) {
    const raw = by_path[String(v[0])];
    paths2.set(h, [raw === undefined ? -1 : Math.trunc(Number(raw)), v[1]]);
  }

  mkdirSync(OUT, { recursive: true });
  const wanted = readdirSync(BUNDLES)
    .filter((n) => n.startsWith("mot_") && n.endsWith(".bundle"))
    .sort();
  let total = 0;
  for (const f of wanted) {
    const bname = path.basename(f, ".bundle");
    const clips = exportClip(bname, paths2, blends, {});
    total += clips.length;
    for (const c of clips) {
      writeFileSync(path.join(OUT, `${c.name}.json`), JSON.stringify(c), "utf8");
    }
    console.log(
      bname,
      clips.map((c) => [c.name, c.frameCount, c.tracks.length, c.unresolved]),
    );
  }
  console.log("clips", total);
}

main();
