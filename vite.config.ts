import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { handleApiAndCacheRequest } from "./web/server/api.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "web");

function gakumasBackendPlugin(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url && (req.url === "/story.html" || req.url.startsWith("/story.html?"))) {
      req.url = req.url.replace(/^\/story\.html/, "/index.html");
    }
    handleApiAndCacheRequest(req, res)
      .then((handled) => {
        if (!handled) next();
      })
      .catch((err) => {
        console.error("API middleware error:", err);
        next();
      });
  };
  return {
    name: "gakumas-backend",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  root: WEB_DIR,
  publicDir: false,
  plugins: [react(), gakumasBackendPlugin()],
  resolve: {
    alias: [
      { find: /^three\/addons\/(.*)$/, replacement: path.resolve(WEB_DIR, "vendor/$1") },
      { find: /^three$/, replacement: path.resolve(WEB_DIR, "vendor/three.module.js") },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 8777,
    strictPort: false,
    fs: {
      allow: [__dirname],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 8777,
  },
  build: {
    outDir: path.resolve(WEB_DIR, "dist"),
    emptyOutDir: true,
    target: "esnext",
  },
});
