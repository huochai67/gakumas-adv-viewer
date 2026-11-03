/**
 * Static file server for the viewer.
 *
 * HTTP/1.1 keep-alive: one connection per asset instead of one TIME_WAIT per
 * request (the page pulls a few hundred files, which otherwise exhausts the
 * Windows ephemeral port range and fails loads with ERR_ADDRESS_IN_USE).
 *
 * Also exposes the raw game packages so the browser can decode them itself:
 *   /cache/bundles/<file>    -> <repo>/cache/bundles/<file>
 *   /cache/resources/<file>  -> <repo>/cache/resources/<file>
 *   /cache/index.json        -> bundle / resource listing + CAB -> bundle map
 *                               (built from the UnityFS blocksInfo headers only)
 *
 * Usage: bun web/serve.ts
 */
import {
  closeSync,
  createReadStream,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt } from "../pipeline/masked_bundle.ts";
import { decompressLz4Block } from "../pipeline/lz4.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ROOT, "..");
const CACHE_DIR = path.join(REPO_ROOT, "cache");
const BUNDLE_DIR = path.join(CACHE_DIR, "bundles");
const RESOURCE_DIR = path.join(CACHE_DIR, "resources");
const HEADER_SIZE = 0x100;
const HOST = "127.0.0.1";
const PORT = 8777;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".bundle": "application/octet-stream",
  ".acb": "application/octet-stream",
};
const DEFAULT_MIME = "application/octet-stream";

function statOrNull(target: string) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- cache index

/** Big-endian reader for the UnityFS header and blocksInfo. */
class ByteReader {
  buf: Uint8Array;
  view: DataView;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u32(): number {
    const value = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return value;
  }

  i32(): number {
    const value = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return value;
  }

  i64(): number {
    const value = Number(this.view.getBigInt64(this.pos, false));
    this.pos += 8;
    return value;
  }

  cstring(): string {
    let end = this.buf.indexOf(0, this.pos);
    if (end === -1) end = this.buf.length;
    const value = new TextDecoder("utf-8").decode(this.buf.subarray(this.pos, end));
    this.pos = end < this.buf.length ? end + 1 : end;
    return value;
  }
}

/** Read `length` bytes at `offset` (shorter only at EOF). */
function readRange(file: string, offset: number, length: number): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * Return the `m_DirectoryInfo` node paths of a UnityFS bundle by reading and
 * decompressing only its blocksInfo table (never the data blocks).
 */
function readBundleNodePaths(file: string, bundleName: string): string[] {
  const size = statOrNull(file)?.size ?? 0;
  // only the first 0x100 bytes are XOR-masked, so the rest is already plaintext
  const head = decrypt(readRange(file, 0, HEADER_SIZE), bundleName);
  const reader = new ByteReader(head);

  if (reader.cstring() !== "UnityFS") throw new Error("not a UnityFS bundle");
  const version = reader.u32();
  reader.cstring(); // unityVersion
  reader.cstring(); // unityRevision
  reader.i64(); // total bundle size (unused)
  const blocksInfoCompressedSize = reader.u32();
  const blocksInfoUncompressedSize = reader.u32();
  const dataFlags = reader.u32();
  if (version >= 7) reader.pos = (reader.pos + 15) & ~15;

  const infoStart = (dataFlags & 0x80) !== 0
    ? size - blocksInfoCompressedSize
    : reader.pos;
  const infoEnd = infoStart + blocksInfoCompressedSize;
  if (infoStart < 0 || infoEnd > size) throw new Error("blocksInfo outside bundle");

  let infoBytes: Uint8Array;
  if (infoEnd <= HEADER_SIZE) {
    infoBytes = head.subarray(infoStart, infoEnd);
  } else if (infoStart >= HEADER_SIZE) {
    infoBytes = readRange(file, infoStart, blocksInfoCompressedSize);
  } else {
    // blocksInfo straddles the masked header: decrypt the first 0x100, read the
    // rest verbatim, then slice the table out of the merged buffer.
    const merged = new Uint8Array(infoEnd);
    merged.set(head.subarray(0, HEADER_SIZE));
    merged.set(readRange(file, HEADER_SIZE, infoEnd - HEADER_SIZE), HEADER_SIZE);
    infoBytes = merged.subarray(infoStart, infoEnd);
  }

  const compression = dataFlags & 0x3f;
  let blocksInfo: Uint8Array;
  if (compression === 0) blocksInfo = infoBytes;
  else if (compression === 2 || compression === 3) {
    blocksInfo = decompressLz4Block(infoBytes, blocksInfoUncompressedSize);
  } else {
    throw new Error(`unsupported blocksInfo compression ${compression}`);
  }

  const info = new ByteReader(blocksInfo);
  info.pos = 16; // uncompressedDataHash
  const blocksCount = info.i32();
  if (blocksCount < 0) throw new Error("invalid block count");
  info.pos += blocksCount * 10; // uncompressedSize u32, compressedSize u32, flags u16
  const nodesCount = info.i32();
  if (nodesCount < 0) throw new Error("invalid node count");
  const paths: string[] = new Array(nodesCount);
  for (let i = 0; i < nodesCount; i++) {
    info.i64(); // offset
    info.i64(); // size
    info.u32(); // flags
    paths[i] = info.cstring();
  }
  return paths;
}

interface CacheIndex {
  bundles: string[];
  resources: string[];
  cabToBundle: Record<string, string>;
}

let cacheIndex: CacheIndex | null = null;

function getCacheIndex(): CacheIndex {
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
      for (const nodePath of readBundleNodePaths(path.join(BUNDLE_DIR, bundleName), bundleName)) {
        cabToBundle[nodePath.toLowerCase()] = bundleName;
      }
    } catch (err) {
      console.warn(`index: skipping ${bundleName}: ${(err as Error).message}`);
    }
  }

  cacheIndex = { bundles, resources, cabToBundle };
  return cacheIndex;
}

// -------------------------------------------------------------------- server

const server = createServer((req, res) => {
  const method = req.method ?? "GET";

  const sendText = (status: number, message: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(message),
      ...extra,
    });
    res.end(method === "HEAD" ? undefined : message);
  };

  /** Serve one file from an explicit root directory, guarding against traversal. */
  const sendFile = (file: string): void => {
    const st = statOrNull(file);
    if (st === null || !st.isFile()) {
      sendText(404, "Not Found\n");
      return;
    }
    res.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": MIME_TYPES[path.extname(file).toLowerCase()] ?? DEFAULT_MIME,
      "Content-Length": st.size,
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };

  const sendJson = (value: unknown): void => {
    const body = JSON.stringify(value);
    res.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(method === "HEAD" ? undefined : body);
  };

  if (method !== "GET" && method !== "HEAD") {
    sendText(405, "Method Not Allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  let rawPath: string;
  let search: string;
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    rawPath = url.pathname;
    search = url.search;
  } catch {
    sendText(400, "Bad Request\n");
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    sendText(400, "Bad Request\n");
    return;
  }
  if (pathname.includes("\0")) {
    sendText(404, "Not Found\n");
    return;
  }

  // ---- raw game packages ---------------------------------------------------
  if (pathname === "/cache/index.json") {
    try {
      sendJson(getCacheIndex());
    } catch (err) {
      sendText(500, `index failed: ${(err as Error).message}\n`);
    }
    return;
  }

  if (pathname.startsWith("/cache/bundles/") || pathname.startsWith("/cache/resources/")) {
    const isBundle = pathname.startsWith("/cache/bundles/");
    const baseDir = isBundle ? BUNDLE_DIR : RESOURCE_DIR;
    const rest = pathname.slice((isBundle ? "/cache/bundles/" : "/cache/resources/").length);
    const file = path.resolve(baseDir, rest);
    if (!file.startsWith(baseDir + path.sep)) {
      sendText(404, "Not Found\n");
      return;
    }
    sendFile(file);
    return;
  }

  // ---- viewer sources and pre-exported fallbacks ---------------------------
  let target = path.resolve(ROOT, "." + path.posix.normalize(pathname));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    sendText(404, "Not Found\n");
    return;
  }

  let st = statOrNull(target);
  if (st === null) {
    sendText(404, "Not Found\n");
    return;
  }

  if (st.isDirectory()) {
    if (!rawPath.endsWith("/")) {
      res.writeHead(301, {
        "Cache-Control": "no-cache",
        Location: rawPath + "/" + search,
        "Content-Length": 0,
      });
      res.end();
      return;
    }
    target = path.join(target, "index.html");
    st = statOrNull(target);
    if (st === null) {
      sendText(404, "Not Found\n");
      return;
    }
  }
  if (!st.isFile()) {
    sendText(404, "Not Found\n");
    return;
  }

  res.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": MIME_TYPES[path.extname(target).toLowerCase()] ?? DEFAULT_MIME,
    "Content-Length": st.size,
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(target);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
});

server.keepAliveTimeout = 30_000;
server.on("error", (err) => {
  console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => console.log(`serving on ${PORT}`));
