import { mul, rotate } from './human_rig.js';

// GameAssembly: sphere 1809B8340, capsule 1809B7630, collision info 1809A1940,
// CalcGoalPosition 1809B8050 and NormalizeCorrection 1809B6450.
// Inputs and outputs are Unity actor-space arrays; no scale or handedness conversion.
const DEG_TO_RAD = 0.01745329238474369;

// 1809B74B0 order 4 dispatches to EulerZXY (1809B7170): qY * qX * qZ.
function correctionEuler(angles) {
  const x = angles[0] * DEG_TO_RAD * 0.5;
  const y = angles[1] * DEG_TO_RAD * 0.5;
  const z = angles[2] * DEG_TO_RAD * 0.5;
  const sx = Math.sin(x), cx = Math.cos(x);
  const sy = Math.sin(y), cy = Math.cos(y);
  const sz = Math.sin(z), cz = Math.cos(z);
  return [
    cy * sx * cz + sy * cx * sz,
    sy * cx * cz - cy * sx * sz,
    cy * cx * sz - sy * sx * cz,
    cy * cx * cz + sy * sx * sz,
  ];
}

/** Native sphere/capsule collision info; type 0 is sphere, type 1 is capsule. */
export function correctionCollisionInfo(cfg, position, rotation, point, goalRadius) {
  if (cfg.type !== 0 && cfg.type !== 1) return null;

  const offset = rotate(rotation, cfg.offset);
  const center = [position[0] + offset[0], position[1] + offset[1], position[2] + offset[2]];
  let radius = cfg.radius;
  if (cfg.type === 1) {
    const half = rotate(mul(rotation, correctionEuler(cfg.rotation)), [0, cfg.length * 0.5, 0]);
    const ax = center[0] + half[0], ay = center[1] + half[1], az = center[2] + half[2];
    const bx = center[0] - half[0], by = center[1] - half[1], bz = center[2] - half[2];
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const projection = (point[0] - ax) * dx + (point[1] - ay) * dy + (point[2] - az) * dz;
    // +Y carries radius, -Y carries radiusSub. Zero length takes the +Y branch.
    if (projection <= 0) {
      center[0] = ax;
      center[1] = ay;
      center[2] = az;
    } else if ((point[0] - bx) * -dx + (point[1] - by) * -dy + (point[2] - bz) * -dz <= 0) {
      center[0] = bx;
      center[1] = by;
      center[2] = bz;
      radius = cfg.radiusSub;
    } else {
      const t = projection / (dx * dx + dy * dy + dz * dz);
      center[0] = ax + dx * t;
      center[1] = ay + dy * t;
      center[2] = az + dz * t;
      radius += (cfg.radiusSub - radius) * t;
    }
  }

  const dx = point[0] - center[0], dy = point[1] - center[1], dz = point[2] - center[2];
  return {
    radius,
    dampArea: cfg.dampArea,
    center,
    weight: cfg.weight,
    // Signed surface separation, excluding dampArea; negative means overlap.
    distance: Math.sqrt(dx * dx + dy * dy + dz * dz) - (radius + goalRadius),
  };
}

/** Return the surface target and its weight, without preblending the goal point. */
export function correctGoalPosition(info, point, goalRadius, weight) {
  const dx = point[0] - info.center[0];
  const dy = point[1] - info.center[1];
  const dz = point[2] - info.center[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const radius = info.radius + goalRadius;
  let correctionWeight = info.weight * weight;
  if (!(distance < radius)) {
    if (radius + info.dampArea <= distance) return null;
    correctionWeight = (1 - (distance - radius) / info.dampArea) * info.weight * weight;
  }

  // NormalizeCorrection returns Vector3.zero at magnitude <= 1e-5, not a fallback axis.
  const nx = distance > 1e-5 ? dx / distance : 0;
  const ny = distance > 1e-5 ? dy / distance : 0;
  const nz = distance > 1e-5 ? dz / distance : 0;
  return {
    position: [info.center[0] + nx * radius, info.center[1] + ny * radius, info.center[2] + nz * radius],
    weight: correctionWeight,
  };
}
