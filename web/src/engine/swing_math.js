// ActorSwing math port. Positions/vectors use Three.js space (Unity z reflected),
// quaternions use (-Unity.x, -Unity.y, Unity.z, Unity.w). Limit numbers remain
// Unity-space degrees for rotation and millimetres for sliding.
// Source evidence: tmp/ghidra-task-exam/adv_out_swing_port/{000,001,016,017}_*.c,
// adv_out_swing_probe/003_SwingStiffnessPendulum.c,
// adv_out_swing_math/{000_ToUnityEuler,001_ToUnityQuaternion}.c and
// adv_out_swing_math_boundaries/{000_Clamp,001_AxisAngle,002_EulerZXY}.c.
import { Quaternion, Vector3 } from 'three';

const FLOAT_MIN_NORMAL = 1.1754943508222875e-38;
const FLOAT_PI = 3.1415927410125732;
const RAD_TO_DEG = 57.295780181884766;
const DEG_TO_RAD = 0.01745329238474369;
const _direction = new Vector3();
const _position = new Vector3();
const _angles = new Vector3();
const _referenceAngles = new Vector3();
const _rotation = new Quaternion();
const _inverse = new Quaternion();

// Native math.min/max select their second operand when the first is NaN.
function nativeMin(value, upper) {
  return Number.isNaN(value) || upper < value ? upper : value;
}

function nativeMax(value, lower) {
  return Number.isNaN(value) || value < lower ? lower : value;
}

function nativeClamp(value, lower, upper) {
  return nativeMax(nativeMin(value, upper), lower);
}

function inverseRotation(out, rotation) {
  const { x, y, z, w } = rotation;
  const reciprocal = 1 / (x * x + y * y + z * z + w * w);
  return out.set(-x * reciprocal, -y * reciprocal, -z * reciprocal, w * reciprocal);
}

// 0x1809964C0: signed ZXY Euler, NOT UnityEngine's [0,360) Euler accessor.
// There is deliberately no angle wrapping, asin clamp or gimbal-lock branch.
function toUnityEuler(out, rotation) {
  const x = -rotation.x, y = -rotation.y, z = rotation.z, w = rotation.w;
  return out.set(
    -Math.asin(2 * (-x * w + z * y)) * RAD_TO_DEG,
    -Math.atan2(-2 * (x * z + w * y), w * w - x * x - y * y + z * z) * RAD_TO_DEG,
    -Math.atan2(-2 * (x * y + w * z), w * w - x * x + y * y - z * z) * RAD_TO_DEG,
  );
}

// 0x1809BD260: quaternion.EulerZXY(Unity degrees * DEG_TO_RAD), reflected back.
function fromUnityEuler(out, angles) {
  const hx = angles.x * DEG_TO_RAD * 0.5;
  const hy = angles.y * DEG_TO_RAD * 0.5;
  const hz = angles.z * DEG_TO_RAD * 0.5;
  const sx = Math.sin(hx), cx = Math.cos(hx);
  const sy = Math.sin(hy), cy = Math.cos(hy);
  const sz = Math.sin(hz), cz = Math.cos(hz);
  return out.set(
    -(cy * sx * cz + sy * cx * sz),
    -(sy * cx * cz - cy * sx * sz),
    cy * cx * sz - sy * sx * cz,
    cy * cx * cz + sy * sx * sz,
  );
}

/**
 * Native CalcStiffnessPendulum (0x1809C2E20), allocation-free.
 * Type 0 takes the simulated/animated direction vectors used by the native
 * caller; every nonzero type takes positions. initialDirection and the parent
 * transform are in Three.js space. The result is a force, not a new position.
 * Neither the effective stiffness nor the type-0 result is clamped/scaled by
 * length. In particular pendulum may make the effective stiffness negative.
 */
export function calcStiffnessPendulum(
  out, type, initialDirection, length, parentPosition, parentRotation,
  simulatedPosition, animatedPosition, stiffness, pendulum, pendulumRange,
) {
  let reduction = 0;
  if (type === 0) {
    _direction.copy(initialDirection).applyQuaternion(parentRotation);
    if (pendulum > 1e-5 && pendulumRange > 1e-5) {
      const sx = simulatedPosition.x, sy = simulatedPosition.y, sz = simulatedPosition.z;
      const ax = animatedPosition.x, ay = animatedPosition.y, az = animatedPosition.z;
      const cosine = Math.abs(sx * ax + sy * ay + sz * az)
        / (Math.sqrt(sx * sx + sy * sy + sz * sz) * Math.sqrt(ax * ax + ay * ay + az * az));
      reduction = nativeMax(cosine - (1 - pendulumRange), 0) / pendulumRange * pendulum;
    }
    return out.copy(_direction).multiplyScalar(stiffness - reduction);
  }

  const sx = simulatedPosition.x, sy = simulatedPosition.y, sz = simulatedPosition.z;
  _direction.copy(initialDirection).multiplyScalar(length).applyQuaternion(parentRotation).add(parentPosition);
  if (pendulum > 1e-5 && pendulumRange > 1e-5) {
    const dx = animatedPosition.x - sx;
    const dy = animatedPosition.y - sy;
    const dz = animatedPosition.z - sz;
    const distance = Math.min(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10, pendulumRange);
    reduction = (1 - distance / pendulumRange) * pendulum;
  }
  return out.set(_direction.x - sx, _direction.y - sy, _direction.z - sz).multiplyScalar(stiffness - reduction);
}

/**
 * Native FromToRotation (0x1809D1160). Intentionally differs from Three.js
 * setFromUnitVectors: zero inputs produce (0,0,0,cos(pi/4)); antiparallel inputs
 * use raw from x right, or raw from x up when its squared length is < 1e-10.
 * That antiparallel axis is NOT normalized by the native AxisAngle call.
 */
export function swingFromToRotation(out, from, to) {
  const fx = from.x, fy = from.y, fz = from.z;
  const tx = to.x, ty = to.y, tz = to.z;
  const fromLengthSquared = fx * fx + fy * fy + fz * fz;
  const toLengthSquared = tx * tx + ty * ty + tz * tz;
  const normalizeFrom = fromLengthSquared > FLOAT_MIN_NORMAL;
  const normalizeTo = !(toLengthSquared <= FLOAT_MIN_NORMAL);
  const fromReciprocal = normalizeFrom ? 1 / Math.sqrt(fromLengthSquared) : 0;
  const toReciprocal = normalizeTo ? 1 / Math.sqrt(toLengthSquared) : 0;
  const nfx = normalizeFrom ? fx * fromReciprocal : 0;
  const nfy = normalizeFrom ? fy * fromReciprocal : 0;
  const nfz = normalizeFrom ? fz * fromReciprocal : 0;
  const ntx = normalizeTo ? tx * toReciprocal : 0;
  const nty = normalizeTo ? ty * toReciprocal : 0;
  const ntz = normalizeTo ? tz * toReciprocal : 0;
  const dot = nfx * ntx + nfy * nty + nfz * ntz;
  if (dot >= 1) return out.set(0, 0, 0, 1);

  let x, y, z, angle;
  if (dot <= -1) {
    x = 0;
    y = fz;
    z = -fy;
    if (y * y + z * z < 1e-10) {
      x = -fz;
      y = 0;
      z = fx;
    }
    angle = FLOAT_PI;
  } else {
    x = fy * tz - fz * ty;
    y = fz * tx - fx * tz;
    z = fx * ty - fy * tx;
    const axisLengthSquared = x * x + y * y + z * z;
    if (axisLengthSquared > FLOAT_MIN_NORMAL) {
      const reciprocal = 1 / Math.sqrt(axisLengthSquared);
      x *= reciprocal;
      y *= reciprocal;
      z *= reciprocal;
    } else {
      x = 0;
      y = 0;
      z = 0;
    }
    angle = Math.acos(dot);
  }
  const halfAngle = angle * 0.5;
  const sine = Math.sin(halfAngle);
  return out.set(x * sine, y * sine, z * sine, Math.cos(halfAngle));
}

// The native upper-reference comparison ignores a NaN reference; the lower
// comparison replaces a NaN reference by the current angle before taking max.
function clampReference(value, reference, lower, upper) {
  if (upper && reference <= value) value = reference;
  if (lower && !Number.isNaN(reference) && !(reference < value)) value = reference;
  return value;
}

/**
 * Native CalcDynamicSwing rotation-limit stage (0x1809C2360).
 * limit = { useLimit, limitX:[min,max], limitY:[min,max], limitZ:[min,max] }.
 * Bounds are native Unity degrees, not reflected Three.js Euler angles.
 * frameRotation is initialGlobal.rotation (not the current parent rotation).
 * referenceLimit = { lower:{x,y,z}, upper:{x,y,z} }, each component boolean;
 * lower enforces worldEuler >= referenceEuler, upper enforces <=. Both true
 * select the reference angle. Reference limits only run inside useLimit.
 * Seated mode skips only the local limit when seatedLimitWeight >= 1e-5;
 * reference limits still run. No slerp/blend is performed in this helper.
 */
export function clampSwingRotation(
  out, frameRotation, worldRotation, limit, referenceWorldRotation = null,
  referenceLimit = null, seated = false, seatedLimitWeight = 0,
) {
  if (!limit.useLimit) return out.copy(worldRotation);
  inverseRotation(_inverse, frameRotation);
  _rotation.multiplyQuaternions(_inverse, worldRotation);
  toUnityEuler(_angles, _rotation);
  if (!seated || seatedLimitWeight < 1e-5) {
    _angles.set(
      nativeClamp(_angles.x, limit.limitX[0], limit.limitX[1]),
      nativeClamp(_angles.y, limit.limitY[0], limit.limitY[1]),
      nativeClamp(_angles.z, limit.limitZ[0], limit.limitZ[1]),
    );
  }
  fromUnityEuler(_rotation, _angles);
  _rotation.premultiply(frameRotation);
  if (referenceWorldRotation !== null && referenceLimit !== null) {
    toUnityEuler(_referenceAngles, referenceWorldRotation);
    toUnityEuler(_angles, _rotation);
    const { lower, upper } = referenceLimit;
    _angles.set(
      clampReference(_angles.x, _referenceAngles.x, lower.x, upper.x),
      clampReference(_angles.y, _referenceAngles.y, lower.y, upper.y),
      clampReference(_angles.z, _referenceAngles.z, lower.z, upper.z),
    );
    fromUnityEuler(_rotation, _angles);
  }
  return out.copy(_rotation);
}

/**
 * Native CalcDynamicSlide position stage (0x1809C1F60).
 * framePosition/Rotation are the CURRENT parent's global transform, and
 * initialLocalPosition is the bone's initialLocal.translation in Three space.
 * The limit shape matches clampSwingRotation, but bounds are Unity millimetres:
 * local delta = inverse(parent) * world - initialLocalPosition;
 * clamp each Unity-space axis to [min,max] * 0.001 (NO bone-length scaling),
 * then return parent * (initialLocalPosition + weight * clampedDelta).
 * weight is the original slide blend parameter and is not clamped.
 */
export function clampSlidePosition(
  out, framePosition, frameRotation, worldPosition, limit, initialLocalPosition, weight = 1,
) {
  inverseRotation(_inverse, frameRotation);
  _position.copy(worldPosition).sub(framePosition).applyQuaternion(_inverse).sub(initialLocalPosition);
  if (limit.useLimit) {
    _position.set(
      nativeClamp(_position.x, limit.limitX[0] * 0.001, limit.limitX[1] * 0.001),
      nativeClamp(_position.y, limit.limitY[0] * 0.001, limit.limitY[1] * 0.001),
      -nativeClamp(-_position.z, limit.limitZ[0] * 0.001, limit.limitZ[1] * 0.001),
    );
  }
  _position.multiplyScalar(weight).add(initialLocalPosition).applyQuaternion(frameRotation).add(framePosition);
  return out.copy(_position);
}

/**
 * Native GetRootCorrectionCancelPosition (0x1809D15C0).
 * correctionWeight and rootWeight are {xz,y}; the scalar weight is separate.
 * x/z multiply by 1-weight*correctionWeight.xz*rootWeight.xz, and y by
 * 1-weight*correctionWeight.y*rootWeight.y. None of these weights is clamped.
 */
export function rootCorrection(out, rootTranslation, weight, correctionWeight, rootWeight) {
  const xz = 1 - weight * correctionWeight.xz * rootWeight.xz;
  const y = 1 - weight * correctionWeight.y * rootWeight.y;
  return out.set(rootTranslation.x * xz, rootTranslation.y * y, rootTranslation.z * xz);
}
