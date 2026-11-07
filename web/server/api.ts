/**
 * Shared HTTP middleware for serving `/cache/*` raw game packages, `/api/catalog`,
 * and `/api/ensure` on-demand Octo bundle downloading in both Vite (`vite dev` /
 * `vite preview`) and the standalone server (`pnpm serve`).
 */
import {
  closeSync,
  createReadStream,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensure_bundles,
  ensure_resources,
  load_manifest,
  type OctoBundle,
} from "../../pipeline/fetch.ts";
import { decompressLz4Block } from "../../pipeline/core/lz4.ts";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(SERVER_DIR, "..");
export const REPO_ROOT = path.resolve(WEB_ROOT, "..");
export const CACHE_DIR = path.join(REPO_ROOT, "cache");
export const BUNDLE_DIR = path.join(CACHE_DIR, "bundles");
export const RESOURCE_DIR = path.join(CACHE_DIR, "resources");
export const ASSETS_DIR = path.join(WEB_ROOT, "assets");
const HEADER_SIZE = 0x100;

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".bundle": "application/octet-stream",
  ".acb": "application/octet-stream",
};
export const DEFAULT_MIME = "application/octet-stream";
/** 1 year immutable cache for content-addressed / versioned .bundle and .acb assets */
export const BUNDLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** 24h cache with ETag revalidation for static wasm / script assets */
export const STATIC_CACHE_CONTROL = "public, max-age=86400";
export function statOrNull(target: string) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

class ByteReader {
  readonly buf: Uint8Array;
  readonly view: DataView;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  cstr(): string {
    const start = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0) this.pos++;
    const str = Buffer.from(this.buf.subarray(start, this.pos)).toString("utf8");
    this.pos++;
    return str;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return v;
  }

  i64(): number {
    const v = Number(this.view.getBigInt64(this.pos, false));
    this.pos += 8;
    return v;
  }
}

function readRange(file: string, offset: number, length: number): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const buf = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function readBundleNodePaths(file: string, bundleName: string): string[] {
  const head = readRange(file, 0, HEADER_SIZE);
  if (head.length < 32) return [];

  if (Buffer.from(head.subarray(0, 8)).toString("latin1") !== "UnityFS\0") {
    const mask = Buffer.from(bundleName.toLowerCase(), "utf8");
    if (mask.length > 0) {
      for (let i = 0; i < head.length; i++) {
        head[i] ^= mask[i % mask.length];
      }
    }
  }
  if (Buffer.from(head.subarray(0, 8)).toString("latin1") !== "UnityFS\0") {
    return [];
  }

  const r = new ByteReader(head);
  r.cstr();
  const version = r.u32();
  r.cstr();
  r.cstr();
  const totalSize = r.i64();
  const csize = r.u32();
  const usize = r.u32();
  const flags = r.u32();

  let blocksInfoBytes: Uint8Array;
  if ((flags & 0x80) !== 0) {
    blocksInfoBytes = readRange(file, totalSize - csize, csize);
  } else {
    if (version >= 7) r.pos = (r.pos + 15) & ~15;
    const start = r.pos;
    blocksInfoBytes =
      start + csize <= head.length
        ? head.subarray(start, start + csize)
        : readRange(file, start, csize);
  }

  const comp = flags & 0x3f;
  let infoBuf: Uint8Array;
  if (comp === 0) {
    infoBuf = blocksInfoBytes;
  } else if (comp === 2 || comp === 3) {
    infoBuf = decompressLz4Block(blocksInfoBytes, usize);
  } else {
    return [];
  }

  const ir = new ByteReader(infoBuf);
  ir.pos += 16;
  const blockCount = ir.i32();
  for (let i = 0; i < blockCount; i++) {
    ir.u32();
    ir.u32();
    ir.u16();
  }
  const nodeCount = ir.i32();
  const paths: string[] = [];
  for (let i = 0; i < nodeCount; i++) {
    ir.i64();
    ir.i64();
    ir.u32();
    paths.push(ir.cstr());
  }
  return paths;
}

export interface CacheIndex {
  bundles: string[];
  resources: string[];
  cabToBundle: Record<string, string>;
}

let cacheIndex: CacheIndex | null = null;
const bundlePathsMemo = new Map<string, string[]>();

export function invalidateCacheIndex(): void {
  cacheIndex = null;
}

export function getCacheIndex(): CacheIndex {
  if (cacheIndex) return cacheIndex;
  const bundles = (statOrNull(BUNDLE_DIR) ? readdirSync(BUNDLE_DIR) : [])
    .filter((name) => name.endsWith(".bundle"))
    .sort();
  const resources = (statOrNull(RESOURCE_DIR) ? readdirSync(RESOURCE_DIR) : [])
    .filter((name) => name.endsWith(".acb"))
    .sort();

  const cabToBundle: Record<string, string> = {};
  for (const bundleName of bundles) {
    try {
      let paths = bundlePathsMemo.get(bundleName);
      if (!paths) {
        paths = readBundleNodePaths(path.join(BUNDLE_DIR, bundleName), bundleName);
        bundlePathsMemo.set(bundleName, paths);
      }
      for (const nodePath of paths) {
        cabToBundle[nodePath.toLowerCase()] = bundleName;
      }
    } catch (err) {
      console.warn(`index: skipping ${bundleName}: ${(err as Error).message}`);
    }
  }

  cacheIndex = { bundles, resources, cabToBundle };
  return cacheIndex;
}

export const ACTOR_NAMES: Record<string, { ja: string; zh: string; color: string }> = {
  amao: { ja: "有村 麻央", zh: "有村 麻央", color: "#b858be" },
  hski: { ja: "花海 咲季", zh: "花海 咲季", color: "#e84858" },
  ttmr: { ja: "月村 手毬", zh: "月村 手毬", color: "#3b88e8" },
  fktn: { ja: "藤田 ことね", zh: "藤田 琴音", color: "#f2b824" },
  hmsz: { ja: "秦谷 美鈴", zh: "秦谷 美铃", color: "#7888d8" },
  ssmk: { ja: "紫雲 清夏", zh: "紫云 清夏", color: "#7ed448" },
  kcna: { ja: "倉本 千奈", zh: "仓本 千奈", color: "#f48234" },
  kllj: { ja: "葛城 リーリヤ", zh: "葛城 莉莉娅", color: "#68c8e8" },
  shro: { ja: "篠澤 広", zh: "筱泽 广", color: "#44b4b8" },
  hrnm: { ja: "姫崎 莉波", zh: "姬崎 莉波", color: "#f088aa" },
  hume: { ja: "花海 佑芽", zh: "花海 佑芽", color: "#e86448" },
  jsna: { ja: "十王 星南", zh: "十王 星南", color: "#d8a848" },
  nasr: { ja: "根緒 亜紗里", zh: "根绪 亚纱里", color: "#68b888" },
  atbm: { ja: "雨夜 燕", zh: "雨夜 燕", color: "#7c64d8" },
  trvo: { ja: "Vo 训练员", zh: "Vo 训练员", color: "#93354d" },
  trda: { ja: "Da 训练员", zh: "Da 训练员", color: "#316296" },
  trvi: { ja: "Vi 训练员", zh: "Vi 训练员", color: "#926e20" },
  krnh: { ja: "賀陽 燐羽", zh: "贺阳燐羽", color: "#8f6c95" },
};

const COSTUME_CATEGORY_LABELS: Record<string, string> = {
  casl: "私服 (Casual)",
  schl: "制服 (School)",
  trng: "训练服 (Training)",
  cstm: "演出服 (Costume)",
  spcs: "特殊/泳装 (Special)",
  othr: "其他 (Other)",
  base: "基础 (Base)",
  hair: "发型变体 (Hair)",
};

function parseCharBundle(stem: string) {
  // e.g. mdl_chr_amao-casl-0000_body
  const m = /^mdl_chr_([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)_(body|face|hair)$/i.exec(stem);
  if (!m) return null;
  const [, actorId, category, index, part] = m;
  const code = `${category}-${index}`;
  const catLabel = COSTUME_CATEGORY_LABELS[category] || category;
  return {
    name: stem,
    actorId,
    category,
    index,
    code,
    part: part as "body" | "face" | "hair",
    label: `${code} · ${catLabel}`,
  };
}

export interface MotionCatalogEntry {
  name: string;
  owner: string;
  action: string;
  isFacial: boolean;
  tag: string;
  cached: boolean;
}

export interface EnvironmentCatalogEntry {
  name: string;
  type: "3d" | "2d";
  category: string;
  timeOfDay: string;
  label: string;
  cached: boolean;
}

const ENV_TIME_LABELS: Record<string, string> = {
  noon: "白昼",
  evening: "傍晚",
  night: "夜晚",
  morning: "清晨",
  other: "特殊",
};

const ENV_GROUP_LABELS: Record<string, string> = {
  adv: "剧情",
  live: "Live舞台",
  lesson: "课程",
  prod: "培育",
  home: "主页",
  tour: "巡演",
  photo: "摄影",
  dress: "更衣室",
  gasha: "抽卡",
  angya: "行脚",
  all: "通用",
  general: "通用",
};

const ENV_PLACE_LABELS: Record<string, string> = {
  classroom: "教室",
  consultingroom: "谈话室",
  corridor: "走廊",
  councilroom: "学生会室",
  courtyard: "中庭",
  danceroom: "舞蹈训练室",
  dormitory: "宿舍",
  dormterrace: "宿舍露台",
  dressroom: "更衣室",
  ground: "操场",
  hallexterior: "大礼堂外",
  hallway: "大厅走廊",
  hifstage: "HIF舞台",
  hotspring: "温泉",
  offstage: "后台通道",
  riverbed: "河岸",
  rooftop: "天台",
  schoolgarden: "学园庭院",
  schoolroom: "教务室/教室",
  seats: "观众席",
  sharedspace: "公共休息区",
  studio: "摄影棚",
  toschool: "通学路",
  toschoolop: "通学路 (OP)",
  trainingroom: "训练室",
  unitstage: "组合舞台",
  visualroom: "表现力训练室",
  vocalroom: "声乐训练室",
  waitingroom: "候场室",
  audition: "试镜会场",
  ceremony: "典礼会场",
  photobooth: "拍照亭",
  charactercapture: "角色展示背景",
};

function parseEnvironmentBundle(stem: string, cached = true): EnvironmentCatalogEntry {
  const m = /^env_(3d|2d)_([a-z0-9]+)_(.+)$/i.exec(stem);
  if (!m) {
    return {
      name: stem,
      type: stem.startsWith("env_2d_") ? "2d" : "3d",
      category: "other",
      timeOfDay: "",
      label: stem,
      cached,
    };
  }
  const [, dim, groupRaw, rest] = m;
  const type = dim.toLowerCase() as "3d" | "2d";
  const category = groupRaw.toLowerCase();
  const tm = /-(noon|evening|night|morning|other)(?:_c\d+)?$/i.exec(rest);
  const timeOfDay = tm ? tm[1].toLowerCase() : "";
  const timeLabel = ENV_TIME_LABELS[timeOfDay] || "";

  const baseSlug = rest
    .replace(/-(?:noon|evening|night|morning|other)(?:_c\d+)?$/i, "")
    .replace(/-(\d{2})(?:-(\d{2}))?$/, (_, a: string, b?: string) => {
      if (b) return a === "00" && b === "00" ? "" : ` #${a}-${b}`;
      return a === "00" ? "" : ` #${a}`;
    });

  const rawPlace = baseSlug.split(" #")[0];
  const variantSuffix = baseSlug.includes(" #") ? ` #${baseSlug.split(" #")[1]}` : "";

  let placeTitle = ENV_PLACE_LABELS[rawPlace] || "";
  if (!placeTitle) {
    const actorMatch = /^([a-z]{4})(\d{3})$/i.exec(rawPlace);
    if (actorMatch && ACTOR_NAMES[actorMatch[1].toLowerCase()]) {
      placeTitle = `${ACTOR_NAMES[actorMatch[1].toLowerCase()].ja} 舞台 #${actorMatch[2]}`;
    } else if (/^all(\d{3})$/i.exec(rawPlace)) {
      placeTitle = `全员舞台 #${rawPlace.slice(3)}`;
    } else if (rawPlace.startsWith("dormitory-")) {
      const sub = rawPlace.slice("dormitory-".length);
      const roomMatch = /^([a-z]{4})room$/i.exec(sub);
      if (roomMatch && ACTOR_NAMES[roomMatch[1].toLowerCase()]) {
        placeTitle = `宿舍 · ${ACTOR_NAMES[roomMatch[1].toLowerCase()].ja}房间`;
      } else {
        placeTitle = `宿舍 · ${sub.replace(/-/g, " ")}`;
      }
    } else {
      placeTitle = rawPlace.replace(/^(other|outschool|school|hall)-/, "$1 · ").replace(/-/g, " ");
    }
  }

  const groupLabel = ENV_GROUP_LABELS[category] || category.toUpperCase();
  const labelParts = [`[${type.toUpperCase()}·${groupLabel}]`, `${placeTitle}${variantSuffix}`];
  if (timeLabel) labelParts.push(`· ${timeLabel}`);

  return {
    name: stem,
    type,
    category,
    timeOfDay,
    label: labelParts.join(" "),
    cached,
  };
}

export interface ScriptSummary {
  id: string;
  name: string;
  url: string;
  cueCount: number;
  messageCount: number;
  voiceCount: number;
  actors: string[];
  backgrounds: string[];
  preview: string;
}

function parseMotionBundle(stem: string, cached = true): MotionCatalogEntry {
  const isFacial = stem.includes("_facial-");
  const m = /^mot_all_chr_([a-z0-9]+)_(.+)$/i.exec(stem);
  const owner = m ? m[1] : "cmmn";
  const action = m ? m[2] : stem.replace(/^mot_/, "");
  let tag = "other";
  if (isFacial) tag = "facial";
  else if (action.startsWith("stand") || action.startsWith("idle")) tag = "stand";
  else if (action.startsWith("talk")) tag = "talk";
  else if (action.startsWith("glad") || action.startsWith("yes")) tag = "positive";
  else if (action.startsWith("ask") || action.startsWith("odoroku") || action.startsWith("kiduku") || action.startsWith("akireru")) tag = "reaction";
  else if (action.startsWith("enter") || action.startsWith("exit")) tag = "transition";
  else if (action.endsWith("_pose")) tag = "pose";
  return {
    name: stem,
    owner,
    action,
    isFacial,
    tag,
    cached,
  };
}

function summarizeScriptFile(
  fileName: string,
  filePath: string,
  urlPrefix = "./assets",
): ScriptSummary {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const actors: string[] = [];
  const backgrounds: string[] = [];
  let messageCount = 0;
  let voiceCount = 0;
  const firstMessages: string[] = [];

  for (const line of lines) {
    if (line.startsWith("[actorgroup")) {
      for (const m of line.matchAll(/\[actor\s+id=([^\s\]]+)/g)) {
        if (!actors.includes(m[1])) actors.push(m[1]);
      }
    } else if (line.startsWith("[backgroundgroup")) {
      for (const m of line.matchAll(/src=([^\s\]]+)/g)) {
        if (!backgrounds.includes(m[1])) backgrounds.push(m[1]);
      }
    } else if (line.startsWith("[message ")) {
      messageCount++;
      if (firstMessages.length < 2) {
        const tm = /text=([^\]]+?)\s+(?:name=|hide=|clip=)/.exec(line);
        const nm = /name=([^\s\]]+)/.exec(line);
        if (tm) {
          const clean = tm[1].replace(/\\n/g, " ").replace(/<r=[^>]*>([^<]*)<\/r>/g, "$1");
          firstMessages.push(nm ? `${nm[1]}: ${clean}` : clean);
        }
      }
    } else if (line.startsWith("[voice ")) {
      voiceCount++;
    }
  }

  return {
    id: fileName,
    name: fileName,
    url: `${urlPrefix}/${fileName}`,
    cueCount: lines.length,
    messageCount,
    voiceCount,
    actors,
    backgrounds,
    preview: firstMessages.join(" / "),
  };
}

let manifestBundlesCache: OctoBundle[] | null = null;
let manifestBundleSetCache: Set<string> | null = null;
let manifestResourceSetCache: Set<string> | null = null;
function getManifestBundles(): OctoBundle[] {
  if (manifestBundlesCache !== null) return manifestBundlesCache;
  try {
    const m = load_manifest();
    manifestBundlesCache = m.assetBundleList ?? [];
    manifestBundleSetCache = new Set(manifestBundlesCache.map((b) => b.name));
    manifestResourceSetCache = new Set((m.resourceList ?? []).map((r) => r.name));
  } catch {
    manifestBundlesCache = [];
    manifestBundleSetCache = new Set();
    manifestResourceSetCache = new Set();
  }
  return manifestBundlesCache;
}

export function buildCatalog() {
  const idx = getCacheIndex();
  const cachedSet = new Set(idx.bundles.map((b) => b.replace(/\.bundle$/, "")));

  const actorsMap = new Map<
    string,
    {
      id: string;
      ja: string;
      zh: string;
      color: string;
      bodies: Array<{ name: string; code: string; category: string; label: string; cached: boolean }>;
      faces: Array<{ name: string; code: string; category: string; label: string; cached: boolean }>;
      hairs: Array<{ name: string; code: string; category: string; label: string; cached: boolean }>;
    }
  >();

  const ensureActor = (actorId: string) => {
    let a = actorsMap.get(actorId);
    if (!a) {
      const info = ACTOR_NAMES[actorId] || { ja: actorId.toUpperCase(), zh: actorId.toUpperCase(), color: "#8892b0" };
      a = {
        id: actorId,
        ja: info.ja,
        zh: info.zh,
        color: info.color,
        bodies: [],
        faces: [],
        hairs: [],
      };
      actorsMap.set(actorId, a);
    }
    return a;
  };

  const seenCharStems = new Set<string>();
  const addCharStem = (stem: string, isCached: boolean) => {
    if (seenCharStems.has(stem)) return;
    const parsed = parseCharBundle(stem);
    if (!parsed) return;
    seenCharStems.add(stem);
    const actor = ensureActor(parsed.actorId);
    const item = {
      name: parsed.name,
      code: parsed.code,
      category: parsed.category,
      label: parsed.label,
      cached: isCached,
    };
    if (parsed.part === "body") actor.bodies.push(item);
    else if (parsed.part === "face") actor.faces.push(item);
    else if (parsed.part === "hair") actor.hairs.push(item);
  };

  for (const b of cachedSet) {
    if (b.startsWith("mdl_chr_")) addCharStem(b, true);
  }
  const manifestList = getManifestBundles();
  for (const mb of manifestList) {
    if (mb.name && mb.name.startsWith("mdl_chr_")) {
      addCharStem(mb.name, cachedSet.has(mb.name));
    }
  }

  for (const actor of actorsMap.values()) {
    const sortFn = (a: { cached: boolean; code: string }, b: { cached: boolean; code: string }) => {
      if (a.cached !== b.cached) return a.cached ? -1 : 1;
      return a.code.localeCompare(b.code);
    };
    actor.bodies.sort(sortFn);
    actor.faces.sort(sortFn);
    actor.hairs.sort(sortFn);
  }

  const actors = [...actorsMap.values()].sort((a, b) => {
    const aHasCached = a.bodies.some((x) => x.cached);
    const bHasCached = b.bodies.some((x) => x.cached);
    if (aHasCached !== bHasCached) return aHasCached ? -1 : 1;
    const order = Object.keys(ACTOR_NAMES);
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.id.localeCompare(b.id);
  });

  const bodyMotions: MotionCatalogEntry[] = [];
  const facialMotions: MotionCatalogEntry[] = [];
  const seenMotions = new Set<string>();
  for (const b of cachedSet) {
    if (!b.startsWith("mot_")) continue;
    seenMotions.add(b);
    const info = parseMotionBundle(b, true);
    if (info.isFacial) facialMotions.push(info);
    else bodyMotions.push(info);
  }
  for (const mb of manifestList) {
    const name = mb.name;
    if (!name || !name.startsWith("mot_all_chr_") || seenMotions.has(name)) continue;
    if (!name.startsWith("mot_all_chr_cmmn_") && !name.startsWith("mot_all_chr_amao_")) continue;
    if (bodyMotions.length + facialMotions.length >= 260) break;
    seenMotions.add(name);
    const info = parseMotionBundle(name, false);
    if (info.isFacial) facialMotions.push(info);
    else bodyMotions.push(info);
  }
  const sortMotion = (a: MotionCatalogEntry, b: MotionCatalogEntry) => {
    if (a.cached !== b.cached) return a.cached ? -1 : 1;
    return a.action.localeCompare(b.action);
  };
  bodyMotions.sort(sortMotion);
  facialMotions.sort(sortMotion);

  const envMap = new Map<string, EnvironmentCatalogEntry>();
  const addEnvStem = (stem: string, isCached: boolean) => {
    if (envMap.has(stem)) return;
    if ((!stem.startsWith("env_3d_") && !stem.startsWith("env_2d_")) || stem.startsWith("env_3d_warmup_")) {
      return;
    }
    envMap.set(stem, parseEnvironmentBundle(stem, isCached));
  };
  for (const b of cachedSet) addEnvStem(b, true);
  for (const mb of manifestList) {
    if (mb.name) addEnvStem(mb.name, cachedSet.has(mb.name));
  }
  const environments = [...envMap.values()].sort((a, b) => {
    if (a.cached !== b.cached) return a.cached ? -1 : 1;
    if (a.name === "env_3d_adv_classroom-00-00-noon") return -1;
    if (b.name === "env_3d_adv_classroom-00-00-noon") return 1;
    if (a.type !== b.type) return a.type === "3d" ? -1 : 1;
    if ((a.category === "adv") !== (b.category === "adv")) return a.category === "adv" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const scripts: ScriptSummary[] = [];
  const seenScripts = new Set<string>();
  if (statOrNull(ASSETS_DIR)) {
    for (const f of readdirSync(ASSETS_DIR).sort()) {
      if (!f.endsWith(".txt") || seenScripts.has(f)) continue;
      try {
        scripts.push(summarizeScriptFile(f, path.join(ASSETS_DIR, f), "./assets"));
        seenScripts.add(f);
      } catch {
        // ignore unreadable script
      }
    }
  }
  if (statOrNull(RESOURCE_DIR)) {
    for (const f of readdirSync(RESOURCE_DIR).sort()) {
      if (!f.endsWith(".txt") || seenScripts.has(f)) continue;
      if (scripts.length >= 300) break;
      try {
        scripts.push(summarizeScriptFile(f, path.join(RESOURCE_DIR, f), "/cache/resources"));
        seenScripts.add(f);
      } catch {
        // ignore unreadable script
      }
    }
  }

  return {
    hasOctoManifest: manifestList.length > 0,
    actors,
    bodyMotions,
    facialMotions,
    environments,
    scripts,
    cachedCounts: {
      bundles: idx.bundles.length,
      resources: idx.resources.length,
      bodyMotions: bodyMotions.length,
      facialMotions: facialMotions.length,
    },
  };
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
    try {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text ? JSON.parse(text) : {});
    } catch (e) {
      reject(e);
    }
  });
  req.on("error", reject);
  return promise;
}

/**
 * Handle `/cache/*`, `/api/*`, and `/wasm/*` requests. Returns `true` if handled,
 * `false` if the caller (Vite or static file server) should continue.
 */
export async function handleApiAndCacheRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  let pathname: string;
  try {
    const u = new URL(rawUrl, "http://127.0.0.1");
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return false;
  }
  if (pathname.includes("\0")) return false;

  const sendJson = (status: number, value: unknown) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(method === "HEAD" ? undefined : body);
  };

  const sendFile = (file: string, cacheControl = STATIC_CACHE_CONTROL): boolean => {
    const st = statOrNull(file);
    if (st === null || !st.isFile()) return false;
    const etag = `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
    const lastModified = st.mtime.toUTCString();
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, {
        "Cache-Control": cacheControl,
        ETag: etag,
        "Last-Modified": lastModified,
      });
      res.end();
      return true;
    }
    res.writeHead(200, {
      "Cache-Control": cacheControl,
      ETag: etag,
      "Last-Modified": lastModified,
      "Content-Type": MIME_TYPES[path.extname(file).toLowerCase()] ?? DEFAULT_MIME,
      "Content-Length": st.size,
    });
    if (method === "HEAD") {
      res.end();
      return true;
    }
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return true;
  };

  if (pathname === "/cache/index.json" && (method === "GET" || method === "HEAD")) {
    try {
      sendJson(200, getCacheIndex());
    } catch (err) {
      sendJson(500, { error: (err as Error).message });
    }
    return true;
  }

  if (pathname === "/api/catalog" && (method === "GET" || method === "HEAD")) {
    try {
      sendJson(200, buildCatalog());
    } catch (err) {
      sendJson(500, { error: (err as Error).message });
    }
    return true;
  }

  if (pathname === "/api/ensure" && method === "POST") {
    try {
      const body = await readJsonBody(req);
      getManifestBundles();
      const rawBundles: string[] = Array.isArray(body?.bundles)
        ? body.bundles.map((x: unknown) => String(x).replace(/\.bundle$/, "")).filter(Boolean)
        : [];
      const rawResources: string[] = Array.isArray(body?.resources)
        ? body.resources.map((x: unknown) => String(x)).filter(Boolean)
        : [];
      const bundles =
        manifestBundleSetCache && manifestBundleSetCache.size > 0
          ? rawBundles.filter((b) => manifestBundleSetCache!.has(b))
          : rawBundles;
      const resources =
        manifestResourceSetCache && manifestResourceSetCache.size > 0
          ? rawResources.filter((r) => manifestResourceSetCache!.has(r))
          : rawResources;
      if (bundles.length > 0) {
        await ensure_bundles(bundles, true, true);
        invalidateCacheIndex();
      }
      if (resources.length > 0) {
        await ensure_resources(resources, true);
        invalidateCacheIndex();
      }
      sendJson(200, {
        ok: true,
        index: getCacheIndex(),
        catalog: buildCatalog(),
      });
    } catch (err) {
      sendJson(500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  if (pathname.startsWith("/cache/bundles/") || pathname.startsWith("/cache/resources/")) {
    const isBundle = pathname.startsWith("/cache/bundles/");
    const baseDir = isBundle ? BUNDLE_DIR : RESOURCE_DIR;
    const rest = pathname.slice((isBundle ? "/cache/bundles/" : "/cache/resources/").length);
    const file = path.resolve(baseDir, rest);
    if (!file.startsWith(baseDir + path.sep)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found\n");
      return true;
    }
    const ext = path.extname(file).toLowerCase();
    const cc =
      isBundle || ext === ".bundle" || ext === ".acb" || ext === ".awb" || ext === ".usm"
        ? BUNDLE_CACHE_CONTROL
        : STATIC_CACHE_CONTROL;
    if (!sendFile(file, cc)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found\n");
    }
    return true;
  }

  if (pathname.startsWith("/wasm/") || pathname.startsWith("/assets/")) {
    const file = path.resolve(WEB_ROOT, "." + path.posix.normalize(pathname));
    if (file.startsWith(WEB_ROOT + path.sep) && sendFile(file)) {
      return true;
    }
  }

  return false;
}
