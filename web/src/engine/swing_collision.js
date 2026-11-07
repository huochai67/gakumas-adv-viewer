import * as THREE from 'three';

// ActorSwingColliderUtility: ConvertJobCollider (0x1809CE5D0),
// UpdateCollider (0x1809CF020), UpdateFastHitCollider (0x1809CF600).
// Definitions retain Unity-space vectors; world-space arguments/results use Three.js.
const EPSILON = 1e-5;

export class SwingCollider {
  constructor(def) {
    this.def = def;
    this.type = def.type;
    this.mask = def.mask;
    this.ignoreMask = def.ignoreMask ?? 0;
    this.p1 = new THREE.Vector3();
    this.p2 = new THREE.Vector3();
    this.r1 = 0;
    this.r2 = 0;
    this.center = new THREE.Vector3();
    this.boundRadius = 0;
  }

  update(position, parentPosition, rotation, scale = 1) {
    const def = this.def;
    const a = def.vA;
    const b = def.vB;
    // Native ConvertJobCollider does not convert plane definition fields, and
    // UpdateCollider leaves its preinitialized world normal/distance untouched.
    // Runtime plane jobs may assign p1, p2 (normal), and r1 (plane constant).
    if (this.type === 3) {
      this.center.copy(this.p1);
      this.boundRadius = this.r1 * 1.1;
      return this;
    }
    if (this.type === 4) return this;
    this.r1 = def.rA * scale;
    this.r2 = this.type === 1 || this.type === 2 ? def.rB * scale : 0;
    if (this.type === 0) {
      this.p1.set(a[0] * scale, a[1] * scale, -a[2] * scale)
        .applyQuaternion(rotation).add(position);
    } else if (this.type === 1) {
      // vB.x is a direct component index (X=0, Y=1, Z=2), not an axis enum.
      // Both ends use rA for their center-line inset, including tapered capsules.
      const halfLine = b[1] * 0.5 * scale - this.r1;
      const axis = Math.trunc(b[0]);
      const x = axis === 0 ? halfLine : 0;
      const y = axis === 1 ? halfLine : 0;
      const z = axis === 2 ? -halfLine : 0;
      const cx = a[0] * scale;
      const cy = a[1] * scale;
      const cz = -a[2] * scale;
      this.p1.set(cx - x, cy - y, cz - z).applyQuaternion(rotation).add(position);
      this.p2.set(cx + x, cy + y, cz + z).applyQuaternion(rotation).add(position);
    } else if (this.type === 2) {
      this.p1.copy(position);
      this.p2.copy(parentPosition);
      if (a[0] > 0 || a[1] > 0) {
        const dx = parentPosition.x - position.x;
        const dy = parentPosition.y - position.y;
        const dz = parentPosition.z - position.z;
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (length > 0.01) {
          let insetA = (a[0] >= 0 ? a[0] : 0) * scale;
          let insetB = (a[1] >= 0 ? a[1] : 0) * scale;
          if (length < insetA + insetB) {
            const excess = insetA + insetB - length;
            const reducedA = insetA - excess * insetA / (insetB + insetA);
            insetA = reducedA >= 0 ? reducedA : 0;
            // This asymmetric denominator is present in the native implementation.
            const reducedB = insetB - excess * insetB / (insetB + reducedA);
            insetB = reducedB >= 0 ? reducedB : 0;
          }
          this.p1.set(position.x + dx / length * insetA,
            position.y + dy / length * insetA, position.z + dz / length * insetA);
          this.p2.set(parentPosition.x - dx / length * insetB,
            parentPosition.y - dy / length * insetB, parentPosition.z - dz / length * insetB);
        }
      }
    }
    if (this.type === 1 || this.type === 2) {
      this.center.copy(this.p1).sub(this.p2).multiplyScalar(0.5).add(this.p2);
      const maxRadius = this.r2 >= this.r1 ? this.r2 : this.r1;
      this.boundRadius = (maxRadius + maxRadius + this.p1.distanceTo(this.p2)) * 0.5 * 1.1;
    } else if (this.type === 0) {
      this.center.copy(this.p1);
      this.boundRadius = this.r1 * 1.1;
    }
    return this;
  }
}

export class SwingCollisionResult {
  constructor() {
    this.normal = new THREE.Vector3();
    this.point = new THREE.Vector3();
    this.radius = 0;
  }
}

// Native math.saturate uses min/max with the non-NaN argument winning.
function saturate(value) {
  if (Number.isNaN(value) || value > 1) return 1;
  return value < 0 ? 0 : value;
}

function contact(ax, ay, az, bx, by, bz, radius, out) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  const distanceSquared = dx * dx + dy * dy + dz * dz;
  if (!(distanceSquared <= radius * radius)) return false;
  const distance = Math.sqrt(distanceSquared);
  if (distance > EPSILON) out.normal.set(dx / distance, dy / distance, dz / distance);
  else out.normal.set(0, 0, 0);
  out.point.set(bx, by, bz);
  out.radius = radius;
  return true;
}

// CollisionSphereCapsule (0x1809D0B30), including the reverse result contract.
function sphereCapsule(sphere, capsule, out, reverse) {
  const dx = capsule.p2.x - capsule.p1.x;
  const dy = capsule.p2.y - capsule.p1.y;
  const dz = capsule.p2.z - capsule.p1.z;
  let t = (sphere.p1.x - capsule.p1.x) * dx
    + (sphere.p1.y - capsule.p1.y) * dy + (sphere.p1.z - capsule.p1.z) * dz;
  let x, y, z, radius;
  if (t <= 0) {
    x = capsule.p1.x;
    y = capsule.p1.y;
    z = capsule.p1.z;
    radius = capsule.r1;
  } else {
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    if (lengthSquared <= t) {
      x = capsule.p2.x;
      y = capsule.p2.y;
      z = capsule.p2.z;
      t = 1;
    } else {
      t /= lengthSquared;
      x = capsule.p1.x + dx * t;
      y = capsule.p1.y + dy * t;
      z = capsule.p1.z + dz * t;
    }
    radius = (1 - t) * capsule.r1 + t * capsule.r2;
  }
  radius += sphere.r1;
  if (reverse) return contact(x, y, z, sphere.p1.x, sphere.p1.y, sphere.p1.z, radius, out);
  return contact(sphere.p1.x, sphere.p1.y, sphere.p1.z, x, y, z, radius, out);
}

// CollisionCapsuleCapsule (0x1809D05E0). Epsilon tests are on squared
// segment lengths and on the determinant, not on normalized directions.
function capsuleCapsule(a, b, out) {
  const ux = a.p2.x - a.p1.x;
  const uy = a.p2.y - a.p1.y;
  const uz = a.p2.z - a.p1.z;
  const vx = b.p2.x - b.p1.x;
  const vy = b.p2.y - b.p1.y;
  const vz = b.p2.z - b.p1.z;
  const wx = a.p1.x - b.p1.x;
  const wy = a.p1.y - b.p1.y;
  const wz = a.p1.z - b.p1.z;
  const uu = ux * ux + uy * uy + uz * uz;
  const vv = vx * vx + vy * vy + vz * vz;
  const vw = vx * wx + vy * wy + vz * wz;
  let s = 0;
  let t = 0;
  if (uu > EPSILON) {
    const uw = ux * wx + uy * wy + uz * wz;
    if (vv <= EPSILON) {
      s = saturate(-uw / uu);
    } else {
      const uv = ux * vx + uy * vy + uz * vz;
      const determinant = vv * uu - uv * uv;
      s = determinant > EPSILON ? saturate((uv * vw - uw * vv) / determinant) : 0;
      t = (uv * s + vw) / vv;
      if (t < 0) {
        s = saturate(-uw / uu);
        t = 0;
      } else if (t > 1) {
        // Confirmed in native assembly 0x1809D08CE: (uv - uw) / uu.
        s = saturate((uv - uw) / uu);
        t = 1;
      }
    }
  } else if (vv > EPSILON) {
    t = saturate(vw / vv);
  }
  const radius = (1 - s) * a.r1 + s * a.r2 + (1 - t) * b.r1 + t * b.r2;
  return contact(a.p1.x + ux * s, a.p1.y + uy * s, a.p1.z + uz * s,
    b.p1.x + vx * t, b.p1.y + vy * t, b.p1.z + vz * t, radius, out);
}

// Native plane output is deliberately different: point is the selected center
// on a, radius is penetration, and p2/r1 on b encode dot(p, normal) = distance.
function colliderPlane(a, b, out) {
  let point = a.p1;
  let radius = a.r1;
  let distance = point.dot(b.p2) - b.r1;
  if (a.type === 2) {
    const distance2 = a.p2.dot(b.p2) - b.r1;
    if (distance2 < distance) {
      point = a.p2;
      radius = a.r2;
      distance = distance2;
    }
  }
  if (!(distance <= radius)) return false;
  out.normal.copy(b.p2);
  out.point.copy(point);
  out.radius = radius - distance;
  return true;
}

// ProcessColliderToCollider / inlined dispatch at 0x1809B5D40.
// The movable collider a is a sphere (0) or connection capsule (2); fixed
// capsules (1) and planes (3) occur only as b in the original solver.
export function collideSwingColliders(a, b, out, seated = false) {
  out.normal.set(0, 0, 0);
  out.point.set(0, 0, 0);
  out.radius = 0;
  if (a.type === 4 || b.type === 4) return false;
  const maskA = seated ? a.mask & ~a.ignoreMask : a.mask;
  const maskB = seated ? b.mask & ~b.ignoreMask : b.mask;
  if ((maskA & maskB) === 0) return false;
  if (b.type !== 3) {
    const radius = a.boundRadius + b.boundRadius;
    if (!(a.center.distanceToSquared(b.center) <= radius * radius)) return false;
  }
  if (a.type === 0) {
    if (b.type === 0) {
      return contact(a.p1.x, a.p1.y, a.p1.z, b.p1.x, b.p1.y, b.p1.z, a.r1 + b.r1, out);
    }
    if (b.type === 1 || b.type === 2) return sphereCapsule(a, b, out, false);
    if (b.type === 3) return colliderPlane(a, b, out);
  } else if (a.type === 2) {
    if (b.type === 0) return sphereCapsule(b, a, out, true);
    if (b.type === 1 || b.type === 2) return capsuleCapsule(a, b, out);
    if (b.type === 3) return colliderPlane(a, b, out);
  }
  return false;
}
