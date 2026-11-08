/**
 * Download + decrypt Octo asset bundles (with dependency closure) and raw resources.
 *
 * Usage:
 *   pnpm run fetch <bundle-or-resource-or-glob> ...
 *   pnpm run fetch:all                         # Download ALL bundles + resources
 *   pnpm run fetch --all-bundles               # Download all 26k+ UnityFS .bundle files
 *   pnpm run fetch --all-resources             # Download all 22k+ resources (.acb, .txt, .awb, .usm, ...)
 *   pnpm run fetch:adv                         # Download all ADV viewer assets (chars, motions, envs, scripts, voices)
 *   pnpm run fetch --all-chars                 # Download all character model bundles (mdl_chr_*) + deps
 *   pnpm run fetch --all-motions               # Download all motion bundles (mot_*) + deps
 *   pnpm run fetch --all-envs                  # Download all 2D/3D stage bundles (env_2d_*, env_3d_*) + deps
 *   pnpm run fetch:scripts                     # Download all ADV .txt scripts
 *   pnpm run fetch --all-voices                # Download all ADV .acb voice containers
 *   pnpm run fetch "mdl_chr_hski-*" -j 12
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { decrypt } from "./core/masked_bundle.ts";

const SELF_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF_FILE);
export const ROOT = path.resolve(HERE, "..");
export const CACHE = path.join(ROOT, "cache");
export const UA = "Dalvik/2.1.0 (Linux; U; Android 11; GM1910 Build/RKQ1.201022.002)";

const OCTO_APP_ID = Number(process.env.GAKUMAS_OCTO_APP_ID) || 400;
const OCTO_VERSION = process.env.GAKUMAS_OCTO_VERSION || "705100";
const OCTO_CLIENT_SECRET = process.env.GAKUMAS_OCTO_SECRET || "0jv0wsohnnsigttbfigushbtl3a8m7l5";
const OCTO_API_KEY_SEED = process.env.GAKUMAS_OCTO_SEED || "x5HFaJCJywDyuButLM0f";
const OCTO_BASE_URL = process.env.GAKUMAS_OCTO_URL || "https://api.asset.game-gakuen-idolmaster.jp/";
export interface OctoBundle {
  name: string;
  id: number | string;
  objectName: string;
  size: number;
  /** manifest misspelling of "dependency" */
  dependencie?: Array<number | string>;
}

export interface OctoResource {
  name: string;
  objectName: string;
  size: number;
}

export interface OctoManifest {
  revision?: number;
  urlFormat: string;
  assetBundleList: OctoBundle[];
  resourceList?: OctoResource[];
  tagname?: string[];
}

export interface FetchOptions {
  withDeps?: boolean;
  verbose?: boolean;
  concurrency?: number;
  keepRaw?: boolean;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function fileSize(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

const utf8Decoder = new TextDecoder();

function readVarint(b: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  while (pos < b.length) {
    const byte = b[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  throw new Error("Truncated protobuf varint in Octo database");
}

function skipProtoField(b: Uint8Array, pos: number, wireType: number): number {
  if (wireType === 0) return readVarint(b, pos)[1];
  if (wireType === 1) return pos + 8;
  if (wireType === 2) {
    const [len, next] = readVarint(b, pos);
    return next + Number(len);
  }
  if (wireType === 5) return pos + 4;
  throw new Error(`Unsupported protobuf wireType ${wireType}`);
}

function decodeOctoDataEntry(b: Uint8Array, start: number, end: number): OctoBundle & Record<string, unknown> {
  let pos = start;
  let id = 0;
  let filepath = "";
  let name = "";
  let size = 0;
  let crc = 0;
  let priority = 0;
  const tagid: number[] = [];
  const dependencie: number[] = [];
  let state = 0;
  let md5 = "";
  let objectName = "";
  let generation = 0;
  let uploadVersionId = 0;

  while (pos < end) {
    const [tagVal, p1] = readVarint(b, pos);
    pos = p1;
    const fieldNo = Number(tagVal >> 3n);
    const wireType = Number(tagVal & 7n);
    if (fieldNo === 1 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      id = Number(BigInt.asIntN(32, v));
      pos = p2;
    } else if (fieldNo === 2 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const l = Number(len);
      filepath = utf8Decoder.decode(b.subarray(p2, p2 + l));
      pos = p2 + l;
    } else if (fieldNo === 3 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const l = Number(len);
      name = utf8Decoder.decode(b.subarray(p2, p2 + l));
      pos = p2 + l;
    } else if (fieldNo === 4 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      size = Number(BigInt.asIntN(32, v));
      pos = p2;
    } else if (fieldNo === 5 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      crc = Number(BigInt.asUintN(32, v));
      pos = p2;
    } else if (fieldNo === 6 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      priority = Number(BigInt.asIntN(32, v));
      pos = p2;
    } else if (fieldNo === 7 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      tagid.push(Number(BigInt.asIntN(32, v)));
      pos = p2;
    } else if (fieldNo === 7 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const pEnd = p2 + Number(len);
      pos = p2;
      while (pos < pEnd) {
        const [v, p3] = readVarint(b, pos);
        tagid.push(Number(BigInt.asIntN(32, v)));
        pos = p3;
      }
    } else if (fieldNo === 8 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      dependencie.push(Number(BigInt.asIntN(32, v)));
      pos = p2;
    } else if (fieldNo === 8 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const pEnd = p2 + Number(len);
      pos = p2;
      while (pos < pEnd) {
        const [v, p3] = readVarint(b, pos);
        dependencie.push(Number(BigInt.asIntN(32, v)));
        pos = p3;
      }
    } else if (fieldNo === 9 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      state = Number(v);
      pos = p2;
    } else if (fieldNo === 10 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const l = Number(len);
      md5 = utf8Decoder.decode(b.subarray(p2, p2 + l));
      pos = p2 + l;
    } else if (fieldNo === 11 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const l = Number(len);
      objectName = utf8Decoder.decode(b.subarray(p2, p2 + l));
      pos = p2 + l;
    } else if (fieldNo === 12 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      generation = Number(v);
      pos = p2;
    } else if (fieldNo === 13 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      uploadVersionId = Number(BigInt.asIntN(32, v));
      pos = p2;
    } else {
      pos = skipProtoField(b, pos, wireType);
    }
  }
  return {
    id,
    filepath,
    name,
    size,
    crc,
    priority,
    tagid,
    dependencie,
    state,
    md5,
    objectName,
    generation,
    uploadVersionId,
  };
}

function decodeOctoDatabase(b: Uint8Array): OctoManifest {
  let pos = 0;
  let revision = 0;
  const assetBundleList: OctoBundle[] = [];
  const tagname: string[] = [];
  const resourceList: OctoResource[] = [];
  let urlFormat = "";

  while (pos < b.length) {
    const [tagVal, p1] = readVarint(b, pos);
    pos = p1;
    const fieldNo = Number(tagVal >> 3n);
    const wireType = Number(tagVal & 7n);
    if (fieldNo === 1 && wireType === 0) {
      const [v, p2] = readVarint(b, pos);
      revision = Number(BigInt.asIntN(32, v));
      pos = p2;
    } else if (fieldNo === 2 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const l = Number(len);
      assetBundleList.push(decodeOctoDataEntry(b, p2, p2 + l));
      pos = p2 + l;
    } else if (fieldNo === 3 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const l = Number(len);
      tagname.push(utf8Decoder.decode(b.subarray(p2, p2 + l)));
      pos = p2 + l;
    } else if (fieldNo === 4 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const l = Number(len);
      resourceList.push(decodeOctoDataEntry(b, p2, p2 + l));
      pos = p2 + l;
    } else if (fieldNo === 5 && wireType === 2) {
      const [len, p2] = readVarint(b, pos);
      const l = Number(len);
      urlFormat = utf8Decoder.decode(b.subarray(p2, p2 + l));
      pos = p2 + l;
    } else {
      pos = skipProtoField(b, pos, wireType);
    }
  }
  return { revision, assetBundleList, tagname, resourceList, urlFormat };
}

/** Manifest locations, in priority order. */
export function manifest_candidates(): string[] {
  const out: string[] = [];
  const envPath = process.env.GAKUMAS_OCTO_MANIFEST;
  if (envPath) out.push(envPath);
  out.push(path.join(CACHE, "OctoManifest.json"));
  out.push(path.resolve(ROOT, "..", "gkm_tl", "cache", "octo", "OctoManifest.json"));
  out.push("C:\\workspace\\GakumasAuto\\tmp\\gkm_tl\\cache\\octo\\OctoManifest.json");
  return out;
}

export const manifestCandidates = manifest_candidates;

let cachedManifest: OctoManifest | null = null;

/** Fetch the encrypted Octo database from the game asset API, decrypt, decode, and save to `cache/OctoManifest.json`. */
export async function fetch_octo_manifest(revision = 0, verbose = true): Promise<OctoManifest> {
  const baseUrl = OCTO_BASE_URL.endsWith("/") ? OCTO_BASE_URL : `${OCTO_BASE_URL}/`;
  const url = `${baseUrl}v2/pub/a/${OCTO_APP_ID}/v/${OCTO_VERSION}/list/${revision}`;
  if (verbose) {
    console.log(`[manifest] Fetching Octo database from ${url} ...`);
  }
  const resp = await fetch(url, {
    headers: {
      "Accept": `application/x-protobuf,x-octo-app/${OCTO_APP_ID}`,
      "X-OCTO-KEY": OCTO_CLIENT_SECRET,
      "User-Agent": UA,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(`Octo manifest request failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  const enc = Buffer.from(await resp.arrayBuffer());
  if (enc.length < 32) {
    throw new Error(`Octo manifest response too short (${enc.length} bytes)`);
  }
  const key = crypto.createHash("sha256").update(OCTO_API_KEY_SEED).digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, enc.subarray(0, 16));
  const pt = Buffer.concat([decipher.update(enc.subarray(16)), decipher.final()]);
  const manifest = decodeOctoDatabase(pt);

  fs.mkdirSync(CACHE, { recursive: true });
  const dst = path.join(CACHE, "OctoManifest.json");
  const tmp = `${dst}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, dst);
  cachedManifest = manifest;

  if (verbose) {
    console.log(
      `[manifest] Saved ${dst} (revision ${manifest.revision ?? 0}, ` +
        `${manifest.assetBundleList.length} bundles, ${manifest.resourceList?.length ?? 0} resources)`,
    );
  }
  return manifest;
}

export const fetchOctoManifest = fetch_octo_manifest;

export async function ensure_manifest(forceRefresh = false, verbose = true): Promise<OctoManifest> {
  if (!forceRefresh && cachedManifest) return cachedManifest;
  if (!forceRefresh) {
    for (const p of manifest_candidates()) {
      if (isFile(p)) {
        cachedManifest = JSON.parse(fs.readFileSync(p, "utf8")) as OctoManifest;
        return cachedManifest;
      }
    }
  }
  return await fetch_octo_manifest(0, verbose);
}

export const ensureManifest = ensure_manifest;

export function load_manifest(): OctoManifest {
  if (cachedManifest) return cachedManifest;
  for (const p of manifest_candidates()) {
    if (isFile(p)) {
      cachedManifest = JSON.parse(fs.readFileSync(p, "utf8")) as OctoManifest;
      return cachedManifest;
    }
  }
  const res = spawnSync(process.execPath, [SELF_FILE, "--manifest-only"], { stdio: "inherit" });
  if (res.status === 0) {
    for (const p of manifest_candidates()) {
      if (isFile(p)) {
        cachedManifest = JSON.parse(fs.readFileSync(p, "utf8")) as OctoManifest;
        return cachedManifest;
      }
    }
  }
  const err = new Error("OctoManifest.json not found");
  err.name = "FileNotFoundError";
  throw err;
}

export const loadManifest = load_manifest;
/** Fetch a URL with the game's user agent, retrying a few times. */
export async function download(url: string, attempts = 3): Promise<Uint8Array> {
  let last: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      last = e;
      await sleep(1000 * (1 + i));
    }
  }
  throw new Error(`download failed ${url}: ${last}`);
}

export const _download = download;

/**
 * Download (and decrypt) every bundle in the dependency closure of `names`.
 * Returns bundle name -> decrypted file path.
 */
export async function ensure_bundles(
  names: Iterable<string>,
  withDeps = true,
  verbose = true,
  concurrency = 6,
  keepRaw = false,
): Promise<Map<string, string>> {
  const manifest = await ensure_manifest(false, verbose);
  const list = manifest.assetBundleList ?? [];
  const byName = new Map<string, OctoBundle>(list.map((b): [string, OctoBundle] => [b.name, b]));
  const byId = new Map<number | string, OctoBundle>(
    list.map((b): [number | string, OctoBundle] => [b.id, b]),
  );
  const urlFormat = manifest.urlFormat;

  const needed: OctoBundle[] = [];
  const seen = new Set<string>();
  const stack: OctoBundle[] = [];
  for (const rawName of names) {
    const n = rawName.replace(/\.bundle$/, "");
    const b = byName.get(n);
    if (!b) throw new Error(`bundle not found in manifest: ${n}`);
    stack.push(b);
  }
  while (stack.length > 0) {
    const b = stack.pop()!;
    if (seen.has(b.name)) continue;
    seen.add(b.name);
    needed.push(b);
    if (withDeps) {
      for (const dep of b.dependencie ?? []) {
        const db = byId.get(dep);
        if (db !== undefined && !seen.has(db.name)) stack.push(db);
      }
    }
  }

  if (keepRaw) {
    fs.mkdirSync(path.join(CACHE, "downloads"), { recursive: true });
  }
  fs.mkdirSync(path.join(CACHE, "bundles"), { recursive: true });

  const out = new Map<string, string>();
  const todo: OctoBundle[] = [];
  let cachedBytes = 0;
  let todoBytes = 0;

  for (const b of needed) {
    const dst = path.join(CACHE, "bundles", b.name + ".bundle");
    out.set(b.name, dst);
    if (fileSize(dst) === b.size) {
      cachedBytes += b.size;
      continue;
    }
    todo.push(b);
    todoBytes += b.size;
  }

  if (verbose) {
    console.log(
      `[bundles] ${needed.length} in closure (${fmtBytes(cachedBytes + todoBytes)}), ` +
        `${needed.length - todo.length} cached, ${todo.length} to download (${fmtBytes(todoBytes)})`,
    );
  }
  if (todo.length === 0) return out;

  const startTime = Date.now();
  let completed = 0;
  let downloadedBytes = 0;
  let failed = 0;
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, todo.length));

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= todo.length) break;
      const b = todo[idx];
      const rawPath = path.join(CACHE, "downloads", b.name + ".bundle");
      const dstPath = path.join(CACHE, "bundles", b.name + ".bundle");
      try {
        let raw: Uint8Array;
        if (fileSize(rawPath) === b.size) {
          raw = fs.readFileSync(rawPath);
        } else {
          raw = await download(urlFormat.replaceAll("{o}", b.objectName));
          if (raw.length !== b.size) {
            throw new Error(`size mismatch ${b.name}: ${raw.length} != ${b.size}`);
          }
          if (keepRaw) {
            fs.writeFileSync(rawPath, raw);
          }
        }
        const dec = decrypt(raw, b.name);
        fs.writeFileSync(dstPath, dec);
        completed++;
        downloadedBytes += b.size;
        if (verbose && (todo.length <= 50 || completed % 10 === 0 || completed === todo.length)) {
          const elapsedSec = Math.max(0.001, (Date.now() - startTime) / 1000);
          const speed = downloadedBytes / elapsedSec;
          const pct = ((completed / todo.length) * 100).toFixed(1);
          console.log(
            `  [bundle ${completed}/${todo.length} ${pct}%] ${b.name} (${fmtBytes(b.size)}) — ${fmtBytes(speed)}/s`,
          );
        }
      } catch (err) {
        failed++;
        console.error(`  [ERROR] bundle ${b.name}: ${(err as Error).message}`);
        if (todo.length <= 10) throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (verbose && todo.length > 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[bundles] finished: ${completed} downloaded (${fmtBytes(downloadedBytes)}) in ${elapsed}s` +
        (failed > 0 ? `, ${failed} failed` : ""),
    );
  }
  return out;
}

export const ensureBundles = ensure_bundles;

/**
 * Download raw resources (`.acb`, `.txt`, `.awb`, `.usm`, `.mp3`, `.png`, `.acf`)
 * from `manifest.resourceList` into `cache/resources/`.
 */
export async function ensure_resources(
  names: Iterable<string>,
  verbose = true,
  concurrency = 6,
): Promise<Map<string, string>> {
  const manifest = await ensure_manifest(false, verbose);
  const list = manifest.resourceList ?? [];
  const byName = new Map<string, OctoResource>(list.map((r): [string, OctoResource] => [r.name, r]));
  const urlFormat = manifest.urlFormat;

  const needed: OctoResource[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) continue;
    const r = byName.get(n);
    if (!r) throw new Error(`resource not found in manifest: ${n}`);
    seen.add(n);
    needed.push(r);
  }

  const resDir = path.join(CACHE, "resources");
  fs.mkdirSync(resDir, { recursive: true });

  const out = new Map<string, string>();
  const todo: OctoResource[] = [];
  let cachedBytes = 0;
  let todoBytes = 0;

  for (const r of needed) {
    const dst = path.join(resDir, r.name);
    out.set(r.name, dst);
    if (fileSize(dst) === r.size) {
      cachedBytes += r.size;
      continue;
    }
    todo.push(r);
    todoBytes += r.size;
  }

  if (verbose) {
    console.log(
      `[resources] ${needed.length} selected (${fmtBytes(cachedBytes + todoBytes)}), ` +
        `${needed.length - todo.length} cached, ${todo.length} to download (${fmtBytes(todoBytes)})`,
    );
  }
  if (todo.length === 0) return out;

  const startTime = Date.now();
  let completed = 0;
  let downloadedBytes = 0;
  let failed = 0;
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, todo.length));

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= todo.length) break;
      const r = todo[idx];
      const dstPath = path.join(resDir, r.name);
      try {
        const raw = await download(urlFormat.replaceAll("{o}", r.objectName));
        if (raw.length !== r.size) {
          throw new Error(`size mismatch ${r.name}: ${raw.length} != ${r.size}`);
        }
        fs.writeFileSync(dstPath, raw);
        completed++;
        downloadedBytes += r.size;
        if (verbose && (todo.length <= 50 || completed % 10 === 0 || completed === todo.length)) {
          const elapsedSec = Math.max(0.001, (Date.now() - startTime) / 1000);
          const speed = downloadedBytes / elapsedSec;
          const pct = ((completed / todo.length) * 100).toFixed(1);
          console.log(
            `  [resource ${completed}/${todo.length} ${pct}%] ${r.name} (${fmtBytes(r.size)}) — ${fmtBytes(speed)}/s`,
          );
        }
      } catch (err) {
        failed++;
        console.error(`  [ERROR] resource ${r.name}: ${(err as Error).message}`);
        if (todo.length <= 10) throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (verbose && todo.length > 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[resources] finished: ${completed} downloaded (${fmtBytes(downloadedBytes)}) in ${elapsed}s` +
        (failed > 0 ? `, ${failed} failed` : ""),
    );
  }
  return out;
}

export const ensureResources = ensure_resources;

/**
 * Download all bundles and/or resources matching a preset or filter.
 */
export async function fetch_all(options: {
  bundles?: boolean;
  resources?: boolean;
  bundleFilter?: (b: OctoBundle) => boolean;
  resourceFilter?: (r: OctoResource) => boolean;
  withDeps?: boolean;
  concurrency?: number;
  keepRaw?: boolean;
  verbose?: boolean;
} = {}): Promise<{ bundles: Map<string, string>; resources: Map<string, string> }> {
  const manifest = await ensure_manifest(false, options.verbose ?? true);
  const doBundles = options.bundles ?? true;
  const doResources = options.resources ?? true;
  const concurrency = options.concurrency ?? 8;
  const verbose = options.verbose ?? true;
  const withDeps = options.withDeps ?? true;
  const keepRaw = options.keepRaw ?? false;

  let bundlesOut = new Map<string, string>();
  let resourcesOut = new Map<string, string>();

  if (doBundles) {
    const allBundles = manifest.assetBundleList ?? [];
    const matched = options.bundleFilter ? allBundles.filter(options.bundleFilter) : allBundles;
    bundlesOut = await ensure_bundles(
      matched.map((b) => b.name),
      withDeps,
      verbose,
      concurrency,
      keepRaw,
    );
  }

  if (doResources) {
    const allResources = manifest.resourceList ?? [];
    const matched = options.resourceFilter
      ? allResources.filter(options.resourceFilter)
      : allResources;
    resourcesOut = await ensure_resources(
      matched.map((r) => r.name),
      verbose,
      concurrency,
    );
  }

  return { bundles: bundlesOut, resources: resourcesOut };
}

export const fetchAll = fetch_all;

function printHelp(): void {
  console.log(
    [
      "Download + decrypt Octo asset bundles and raw resources.",
      "Always sync the latest Octo manifest before selecting and downloading assets.",
      "",
      "Usage:",
      "  pnpm run fetch [options] [bundle-or-resource-or-glob ...]",
      "",
      "Batch / Full Download Flags:",
      "  --all, -a           Download ALL bundles (26k+) and ALL resources (22k+)",
      "  --all-bundles       Download all UnityFS .bundle packages in assetBundleList",
      "  --all-resources     Download all raw files (.acb, .txt, .awb, .usm, ...) in resourceList",
      "  --all-adv           Download all ADV viewer assets (chars, motions, envs, .txt scripts, .acb voices)",
      "  --all-chars         Download all character model bundles (mdl_chr_*) + dependencies",
      "  --all-motions       Download all motion clip bundles (mot_*) + dependencies",
      "  --all-envs          Download all 2D & 3D stage bundles (env_2d_*, env_3d_*) + dependencies",
      "  --all-scripts       Download all ADV .txt story scripts into cache/resources/",
      "  --all-voices        Download all ADV voice .acb containers (sud_vo_adv_*.acb)",
      "",
      "Options:",
      "  -j, --concurrency N  Parallel download workers (default: 8)",
      "  --no-deps            Skip dependency closure expansion for bundles",
      "  --keep-raw           Also keep un-decrypted raw .bundle files in cache/downloads/",
      "  --manifest-only      Only download/update OctoManifest.json and exit",
      "  -h, --help           Show this help message",
      "",
      "Examples:",
      "  pnpm run fetch:all -j 12",
      "  pnpm run fetch:adv",
      "  pnpm run fetch:scripts",
      "  pnpm run fetch \"mdl_chr_hski-*\" \"adv_dear_hski_*.txt\"",
    ].join("\n"),
  );
}

if (import.meta.main) {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes("-h") || rawArgs.includes("--help")) {
    printHelp();
    process.exit(rawArgs.length === 0 ? 1 : 0);
  }

  let concurrency = 8;
  let withDeps = true;
  let keepRaw = false;
  let flagAll = false;
  let flagAllBundles = false;
  let flagAllResources = false;
  let flagAllAdv = false;
  let flagAllChars = false;
  let flagAllMotions = false;
  let flagAllEnvs = false;
  let flagAllScripts = false;
  let flagAllVoices = false;
  let flagManifestOnly = false;
  const patterns: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--all" || a === "-a") flagAll = true;
    else if (a === "--all-bundles") flagAllBundles = true;
    else if (a === "--all-resources") flagAllResources = true;
    else if (a === "--all-adv") flagAllAdv = true;
    else if (a === "--all-chars") flagAllChars = true;
    else if (a === "--all-motions") flagAllMotions = true;
    else if (a === "--all-envs") flagAllEnvs = true;
    else if (a === "--all-scripts") flagAllScripts = true;
    else if (a === "--all-voices") flagAllVoices = true;
    else if (a === "--no-deps") withDeps = false;
    else if (a === "--keep-raw") keepRaw = true;
    else if (a === "--manifest-only") flagManifestOnly = true;
    else if (a === "-j" || a === "--concurrency") {
      concurrency = Math.max(1, parseInt(rawArgs[++i] ?? "8", 10) || 8);
    } else if (a.startsWith("--concurrency=")) {
      concurrency = Math.max(1, parseInt(a.split("=")[1] ?? "8", 10) || 8);
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      printHelp();
      process.exit(1);
    } else {
      patterns.push(a);
    }
  }

  const manifest = await ensure_manifest(true, true);
  if (flagManifestOnly) {
    process.exit(0);
  }
  const bundleNames = new Set<string>();
  const resourceNames = new Set<string>();

  if (flagAll || flagAllBundles) {
    for (const b of manifest.assetBundleList ?? []) bundleNames.add(b.name);
  }
  if (flagAll || flagAllResources) {
    for (const r of manifest.resourceList ?? []) resourceNames.add(r.name);
  }
  if (flagAllAdv || flagAllChars) {
    for (const b of manifest.assetBundleList ?? []) {
      if (b.name.startsWith("mdl_chr_") || b.name.startsWith("t_chr_") || b.name === "actor-shader") {
        bundleNames.add(b.name);
      }
    }
  }
  if (flagAllAdv || flagAllMotions) {
    for (const b of manifest.assetBundleList ?? []) {
      if (b.name.startsWith("mot_")) bundleNames.add(b.name);
    }
  }
  if (flagAllAdv || flagAllEnvs) {
    for (const b of manifest.assetBundleList ?? []) {
      if (b.name.startsWith("env_2d_") || b.name.startsWith("env_3d_") || b.name.startsWith("t_sky_")) {
        bundleNames.add(b.name);
      }
    }
  }
  if (flagAllAdv || flagAllScripts) {
    for (const r of manifest.resourceList ?? []) {
      if (r.name.endsWith(".txt")) resourceNames.add(r.name);
    }
  }
  if (flagAllAdv || flagAllVoices) {
    for (const r of manifest.resourceList ?? []) {
      if (r.name.startsWith("sud_vo_adv_") && r.name.endsWith(".acb")) {
        resourceNames.add(r.name);
      }
    }
  }

  // Resolve explicit names or wildcard patterns against both assetBundleList and resourceList
  const bundleByName = new Map((manifest.assetBundleList ?? []).map((b) => [b.name, b]));
  const resByName = new Map((manifest.resourceList ?? []).map((r) => [r.name, r]));

  for (const pat of patterns) {
    const cleanPat = pat.replace(/\.bundle$/, "");
    if (pat.includes("*") || pat.includes("?")) {
      const reBundle = globToRegExp(cleanPat);
      const reRes = globToRegExp(pat);
      let matched = 0;
      for (const b of manifest.assetBundleList ?? []) {
        if (reBundle.test(b.name)) {
          bundleNames.add(b.name);
          matched++;
        }
      }
      for (const r of manifest.resourceList ?? []) {
        if (reRes.test(r.name)) {
          resourceNames.add(r.name);
          matched++;
        }
      }
      if (matched === 0) {
        console.warn(`WARN: pattern "${pat}" matched 0 bundles or resources in manifest`);
      }
    } else if (bundleByName.has(cleanPat)) {
      bundleNames.add(cleanPat);
    } else if (resByName.has(pat)) {
      resourceNames.add(pat);
    } else {
      throw new Error(`asset not found in manifest (neither bundle nor resource): ${pat}`);
    }
  }

  if (bundleNames.size > 0) {
    await ensure_bundles(bundleNames, withDeps, true, concurrency, keepRaw);
  }
  if (resourceNames.size > 0) {
    await ensure_resources(resourceNames, true, concurrency);
  }
}
