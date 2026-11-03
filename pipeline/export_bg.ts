/**
 * Export 2D ADV backgrounds (env_2d_* bundles) as PNGs for the viewer.
 *
 * Each env_2d bundle holds one Texture2D plus the UIBackground material; the
 * viewer only needs the texture, so this copies it to web/assets/tex/<name>.png
 * and records the pixel size in bg.json (the script drives quad scale/position).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv, objectsOf } from "./assets.ts";
import type { BundleContainer } from "./assets.ts";
import { textureInfo } from "./core/bcn_png.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TEX = path.join(ROOT, "web", "assets", "tex");
const OUT = path.join(ROOT, "web", "assets");

const ACTOR_PARAM_FIELDS = [
  "lightColor",
  "mainLightSpace",
  "mainLightAngle",
  "shadeColorMultiply",
  "shadeColorAdditive",
  "shadeApplyRatio",
  "rimAngle",
  "rimBaseColorRatio",
  "rimPower",
  "rimColor",
] as const;

const ACTOR_SHADOW_FIELDS = [
  "shadowStrength",
  "directionalType",
  "lightDirectional",
  "facePartsShadowStrength",
] as const;

/** Material override slots store `{ m_Value, m_OverrideState }`. */
function overrideActive(value: unknown): boolean {
  return value === 1 || value === true;
}

function main(): void {
  const env = loadEnv();
  fs.mkdirSync(TEX, { recursive: true });
  const meta: Record<string, unknown> = {};

  const seenContainers = new Set<BundleContainer>();
  for (const [key, container] of env.bundles) {
    // env.bundles registers each container under both "<name>" and "<name>.bundle".
    if (seenContainers.has(container)) continue;
    seenContainers.add(container);
    const fileName = path.basename(container.name || key);
    const name = fileName.endsWith(".bundle") ? fileName.slice(0, -".bundle".length) : fileName;
    if (!name.startsWith("env_2d_")) continue;
    const bundle = name;

    const entry: Record<string, unknown> = {};
    for (const obj of objectsOf(container, "Texture2D")) {
      const tex = obj.read();
      const info = textureInfo(tex);
      if (!info) continue;
      fs.writeFileSync(path.join(TEX, `${tex.m_Name}.png`), info.png);
      entry.texture = `tex/${tex.m_Name}.png`;
      entry.width = info.width;
      entry.height = info.height;
      console.log(bundle, tex.m_Name, `(${info.width}, ${info.height})`);
    }

    const volumes: Record<string, Record<string, unknown>> = {};
    for (const obj of objectsOf(container, "MonoBehaviour")) {
      const tt = obj.read();
      if ("_verticalSetting" in tt && "_horizontalSetting" in tt) {
        entry.verticalSetting = tt._verticalSetting;
        entry.horizontalSetting = tt._horizontalSetting;
        continue;
      }
      if (!overrideActive(tt.active)) continue;

      const mergeOvr = (dst: Record<string, unknown>, fields: readonly string[]): void => {
        for (const fk of fields) {
          const d = tt[fk];
          if (d !== null && typeof d === "object" && !Array.isArray(d) && "m_Value" in d) {
            if (overrideActive(d.m_OverrideState) || !(fk in dst)) dst[fk] = d.m_Value;
          }
        }
      };

      if ("shadeColorMultiply" in tt && "mainLightAngle" in tt) {
        volumes.actorParam ??= {};
        mergeOvr(volumes.actorParam, ACTOR_PARAM_FIELDS);
      } else if ("shadowStrength" in tt && "lightDirectional" in tt) {
        volumes.actorShadow ??= {};
        mergeOvr(volumes.actorShadow, ACTOR_SHADOW_FIELDS);
      }
    }
    if (Object.keys(volumes).length > 0) entry.volumes = volumes;
    if (Object.keys(entry).length > 0) meta[bundle] = entry;
  }

  fs.writeFileSync(path.join(OUT, "bg.json"), JSON.stringify(meta, null, 1));
}

if (import.meta.main) main();
