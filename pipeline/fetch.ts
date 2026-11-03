/**
 * Download + decrypt Octo asset bundles (with dependency closure) and raw resources.
 *
 * Usage:
 *   bun pipeline/fetch.ts <bundle-or-resource-or-glob> ...
 *   bun pipeline/fetch.ts --all                # Download ALL bundles + resources
 *   bun pipeline/fetch.ts --all-bundles        # Download all 26k+ UnityFS .bundle files
 *   bun pipeline/fetch.ts --all-resources      # Download all 22k+ resources (.acb, .txt, .awb, .usm, ...)
 *   bun pipeline/fetch.ts --all-adv            # Download all ADV viewer assets (chars, motions, envs, scripts, voices)
 *   bun pipeline/fetch.ts --all-chars          # Download all character model bundles (mdl_chr_*) + deps
 *   bun pipeline/fetch.ts --all-motions        # Download all motion bundles (mot_*) + deps
 *   bun pipeline/fetch.ts --all-envs           # Download all 2D/3D stage bundles (env_2d_*, env_3d_*) + deps
 *   bun pipeline/fetch.ts --all-scripts        # Download all ADV .txt scripts
 *   bun pipeline/fetch.ts --all-voices         # Download all ADV .acb voice containers
 *   bun pipeline/fetch.ts "mdl_chr_hski-*" -j 12
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { decrypt } from "./core/masked_bundle.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const CACHE = path.join(ROOT, "cache");
export const UA = "Dalvik/2.1.0 (Linux; U; Android 11; GM1910 Build/RKQ1.201022.002)";

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
  urlFormat: string;
  assetBundleList: OctoBundle[];
  resourceList?: OctoResource[];
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

/** Manifest locations, in priority order. */
export function manifest_candidates(): string[] {
  const out: string[] = [];
  const envPath = process.env.GAKUMAS_OCTO_MANIFEST;
  if (envPath) out.push(envPath);
  out.push(path.join(CACHE, "OctoManifest.json"));
  out.push("C:\\workspace\\GakumasAuto\\tmp\\gkm_tl\\cache\\octo\\OctoManifest.json");
  return out;
}

export const manifestCandidates = manifest_candidates;

export function load_manifest(): OctoManifest {
  for (const p of manifest_candidates()) {
    if (isFile(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as OctoManifest;
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
  const manifest = load_manifest();
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
  const manifest = load_manifest();
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
  const manifest = load_manifest();
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
      "",
      "Usage:",
      "  bun pipeline/fetch.ts [options] [bundle-or-resource-or-glob ...]",
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
      "  -j, --concurrency N Parallel download workers (default: 8)",
      "  --no-deps           Skip dependency closure expansion for bundles",
      "  --keep-raw          Also keep un-decrypted raw .bundle files in cache/downloads/",
      "  -h, --help          Show this help message",
      "",
      "Examples:",
      "  bun pipeline/fetch.ts --all -j 12",
      "  bun pipeline/fetch.ts --all-adv",
      "  bun pipeline/fetch.ts --all-scripts",
      "  bun pipeline/fetch.ts \"mdl_chr_hski-*\" \"adv_dear_hski_*.txt\"",
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

  const manifest = load_manifest();
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
