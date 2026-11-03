/**
 * Static file server for the viewer.
 *
 * HTTP/1.1 keep-alive: one connection per asset instead of one TIME_WAIT per
 * request (the page pulls a few hundred files, which otherwise exhausts the
 * Windows ephemeral port range and fails loads with ERR_ADDRESS_IN_USE).
 *
 * Usage: bun web/serve.ts
 */
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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
};
const DEFAULT_MIME = "application/octet-stream";

function statOrNull(target: string) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

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
