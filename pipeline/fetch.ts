/**
 * Download + decrypt Octo asset bundles (with dependency closure).
 *
 * Usage: bun pipeline/fetch.ts mdl_chr_amao-casl-0000_body env_3d_adv_classroom-00-00-noon ...
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { decrypt } from "./masked_bundle.ts";

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
  for (const n of names) {
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
        if (db !== undefined) stack.push(db);
      }
    }
  }

  fs.mkdirSync(path.join(CACHE, "downloads"), { recursive: true });
  fs.mkdirSync(path.join(CACHE, "bundles"), { recursive: true });

  const out = new Map<string, string>();
  const todo: OctoBundle[] = [];
  for (const b of needed) {
    const dst = path.join(CACHE, "bundles", b.name + ".bundle");
    out.set(b.name, dst);
    if (fileSize(dst) === b.size) continue;
    todo.push(b);
  }
  if (verbose) {
    console.log(`${needed.length} bundles in closure, ${todo.length} to download`);
  }

  for (let i = 0; i < todo.length; i++) {
    const b = todo[i];
    const rawPath = path.join(CACHE, "downloads", b.name + ".bundle");
    let raw: Uint8Array;
    if (fileSize(rawPath) === b.size) {
      raw = fs.readFileSync(rawPath);
    } else {
      raw = await download(urlFormat.replaceAll("{o}", b.objectName));
      if (raw.length !== b.size) {
        throw new Error(`size mismatch ${b.name}: ${raw.length} != ${b.size}`);
      }
      fs.writeFileSync(rawPath, raw);
    }
    const dec = decrypt(raw, b.name);
    fs.writeFileSync(path.join(CACHE, "bundles", b.name + ".bundle"), dec);
    if (verbose) {
      console.log(`  [${i + 1}/${todo.length}] ${b.name} ${(b.size / 1e6).toFixed(2)}MB`);
    }
  }
  return out;
}

export const ensureBundles = ensure_bundles;

if (import.meta.main) {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error(
      "Download + decrypt Octo asset bundles (with dependency closure).\n\n" +
        "Usage: bun pipeline/fetch.ts <bundle-name> ...",
    );
    process.exit(1);
  }
  for (const [name, p] of await ensure_bundles(names)) console.log(name, p);
}
