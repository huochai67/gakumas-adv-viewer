/**
 * Production / standalone HTTP server for the viewer.
 *
 * Delegates `/cache/*`, `/api/*`, `/wasm/*`, and `/assets/*` to `./server_api.ts`
 * and serves the Vite production build (`web/dist`) or source directory (`web`).
 */
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import {
  BUNDLE_CACHE_CONTROL,
  DEFAULT_MIME,
  handleApiAndCacheRequest,
  MIME_TYPES,
  STATIC_CACHE_CONTROL,
  statOrNull,
  WEB_ROOT,
} from "./api.ts";

const DIST_ROOT = path.join(WEB_ROOT, "dist");
const HOST = "127.0.0.1";
const PORT = Number(process.argv[2]) || 8777;

const server = createServer(async (req, res) => {
  const handled = await handleApiAndCacheRequest(req, res);
  if (handled) return;

  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("Method Not Allowed\n");
    return;
  }

  let rawPath: string;
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    rawPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request\n");
    return;
  }
  if (rawPath === "/" || rawPath === "/story.html") {
    rawPath = "/index.html";
  }

  const normalized = "." + path.posix.normalize(rawPath);
  for (const base of [DIST_ROOT, WEB_ROOT]) {
    const target = path.resolve(base, normalized);
    if (target !== base && !target.startsWith(base + path.sep)) continue;
    const st = statOrNull(target);
    if (st && st.isFile()) {
      const ext = path.extname(target).toLowerCase();
      const isHashedDistAsset = base === DIST_ROOT && rawPath.startsWith("/assets/");
      const cacheControl =
        ext === ".html"
          ? "no-cache"
          : isHashedDistAsset || ext === ".bundle" || ext === ".acb"
            ? BUNDLE_CACHE_CONTROL
            : STATIC_CACHE_CONTROL;
      const etag = `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { "Cache-Control": cacheControl, ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Cache-Control": cacheControl,
        ETag: etag,
        "Last-Modified": st.mtime.toUTCString(),
        "Content-Type": MIME_TYPES[ext] ?? DEFAULT_MIME,
        "Content-Length": st.size,
      });
      if (method === "HEAD") {
        res.end();
        return;
      }
      const stream = createReadStream(target);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found\n");
});

server.keepAliveTimeout = 30_000;
server.listen(PORT, HOST, () => console.log(`serving on http://${HOST}:${PORT}`));
