// ActorAnimationWindUtility.CalcWindPower (0x1809CAF00) and
// ActorAnimationSwingJobSkeleton.ProcessChainBoneSeatedDynamicCorrection
// (0x1809C61E0). Inputs use the same actor-affine frame as ActorSwing.
const gradients = new Float64Array(8);
const TWO_PI = 6.2831855;
const fract = (x) => x - Math.floor(x);
const mod289 = (x) => x - Math.floor(x / 289) * 289;
const permute = (x) => mod289((x * 34 + 1) * x);
const fade = (x) => x * x * x * (x * (x * 6 - 15) + 10);
const mix = (a, b, t) => a + (b - a) * t;

// Unity.Mathematics.noise.cnoise(float3), classic 3-D gradient noise. The
// permutation and Taylor normalization are intentional, not ImprovedNoise's
// permutation table; the two noise functions are not interchangeable.
export function swingNoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    const hash = permute(permute(permute(mod289(ix + dx)) + mod289(iy + dy)) + mod289(iz + dz));
    let gx = hash / 7;
    let gy = fract(Math.floor(gx) / 7) - 0.5;
    gx = fract(gx);
    const gz = 0.5 - Math.abs(gx) - Math.abs(gy);
    if (gz <= 0) {
      gx -= (gx >= 0 ? 1 : 0) - 0.5;
      gy -= (gy >= 0 ? 1 : 0) - 0.5;
    }
    const norm = 1.79284291400159 - 0.85373472095314 * (gx * gx + gy * gy + gz * gz);
    gradients[k] = norm * (gx * (fx - dx) + gy * (fy - dy) + gz * (fz - dz));
  }
  const u = fade(fx), v = fade(fy), w = fade(fz);
  return 2.2 * mix(
    mix(mix(gradients[0], gradients[1], u), mix(gradients[2], gradients[3], u), v),
    mix(mix(gradients[4], gradients[5], u), mix(gradients[6], gradients[7], u), v), w,
  );
}

/** Port of CalcWindPower; power components are magnitudes, direction is Three-space. */
export function swingWind(out, position, wind, time) {
  const sine = Math.sin((time * wind.sineSpeed + wind.sinePhase) * TWO_PI) * wind.sinePower * 0.01;
  const frequency = wind.noiseSpeed * time;
  const noise = (swingNoise(position.x * frequency, position.y * frequency, -position.z * frequency) * 0.5 + 0.5) * 0.01 * wind.noisePower;
  const minimum = wind.minimum * 0.01;
  const limit = wind.limit * 0.01;
  const blend = Math.sin((time * wind.blendSpeed + wind.blendPhase) * TWO_PI) + 1;
  const directionFrequency = wind.directionNoiseSpeed * time;
  const directionNoise = swingNoise(position.x * directionFrequency, position.y * directionFrequency, -position.z * directionFrequency) * 0.01 * wind.directionNoisePower;
  const common = sine + noise - minimum;
  return out.set(
    wind.direction.x * (Math.min(limit, Math.max(0, wind.power.x + common) * blend + minimum) + directionNoise),
    wind.direction.y * (Math.min(limit, Math.max(0, wind.power.y + common) * blend + minimum) + directionNoise),
    wind.direction.z * (Math.min(limit, Math.max(0, wind.power.z + common) * blend + minimum) + directionNoise),
  );
}

/** Native seat correction, followed by the caller's per-bone correction blend. */
export function seatedCorrection(out, parent, animated, simulated, hip, knee, foot, cancel) {
  const ax = hip.x - cancel.x, ay = hip.y - cancel.y, az = hip.z - cancel.z;
  const bx = knee.x - cancel.x, by = knee.y - cancel.y, bz = knee.z - cancel.z;
  const cx = foot.x - cancel.x, cy = foot.y - cancel.y, cz = foot.z - cancel.z;
  const upperLength = Math.hypot(bx - ax, bz - az);
  const fromHip = Math.hypot(animated.x - ax, animated.z - az);
  const fromKnee = Math.hypot(animated.x - bx, animated.z - bz);
  const parentFromHip = Math.hypot(parent.x - ax, parent.z - az);
  out.copy(simulated);
  if (animated.y < by) {
    const f = fromHip / (fromKnee + fromHip);
    const t = f * f;
    const x = parent.x + mix(bx - ax, cx - bx, t);
    const y = parent.y + mix(by - ay, cy - by, t);
    const z = parent.z + mix(bz - az, cz - bz, t);
    if (by > parent.y && by > animated.y) {
      out.set(x, y, z);
    } else if (by <= parent.y && animated.y < by) {
      const alpha = Math.abs(by - animated.y) / Math.abs(parent.y - animated.y);
      out.set(mix(out.x, x, alpha), mix(out.y, y, alpha), mix(out.z, z, alpha));
    }
  }
  if (upperLength < parentFromHip) {
    const blendDistance = upperLength * 0.25;
    const alpha = Math.min(parentFromHip - upperLength, blendDistance) / blendDistance;
    out.set(
      mix(out.x, parent.x + cx - bx, alpha),
      mix(out.y, parent.y + cy - by, alpha),
      mix(out.z, parent.z + cz - bz, alpha),
    );
  }
  return out;
}
