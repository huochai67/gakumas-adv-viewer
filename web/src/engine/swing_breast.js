import * as THREE from 'three';
import { calcStiffnessPendulum, swingFromToRotation, clampSwingRotation } from './swing_math.js';

const NATIVE_STEP = 0.01667;
const DEFAULT_INITIALIZATION_COUNT = 5; // ActorAnimationRig.ResetBreastBone
const ONE_THIRD = Math.fround(1 / 3);
const EMPTY_OPTIONS = Object.freeze({});

function unityPosition(value) {
  return new THREE.Vector3(value[0], value[1], -value[2]);
}

function unityRotation(value) {
  return new THREE.Quaternion(-value[0], -value[1], value[2], value[3]);
}

function modelingTransform(value) {
  return {
    position: unityPosition(value.position),
    rotation: unityRotation(value.rotation),
    localPosition: unityPosition(value.localPosition),
    localRotation: unityRotation(value.localRotation),
  };
}

// VL.AnimationCurveEvaluator (0x1809CC720) deliberately uses fmodf(time,
// lastKey.time), not AnimationCurve's pre/post wrap modes. Its native key
// buffer contains six floats and has no weightedMode or wrap-mode fields.
class BreastCurve {
  constructor(keys) {
    this.keys = new Float64Array((keys?.length || 0) * 6);
    for (let i = 0; i < (keys?.length || 0); i++) {
      const key = keys[i];
      const offset = i * 6;
      this.keys[offset] = key.time;
      this.keys[offset + 1] = key.value;
      this.keys[offset + 2] = key.inSlope;
      this.keys[offset + 3] = key.outSlope;
      // CurveToKeyframes (0x1809D1610) resolves WeightedMode while copying.
      this.keys[offset + 4] = key.weightedMode & 1 ? key.inWeight : ONE_THIRD;
      this.keys[offset + 5] = key.weightedMode & 2 ? key.outWeight : ONE_THIRD;
    }
  }

  evaluate(time) {
    const keys = this.keys;
    const count = keys.length / 6;
    if (count === 0) throw new Error('ActorSwing breast arm correction requires curve keys');
    if (count === 1) return keys[1];
    time %= keys[(count - 1) * 6];
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (keys[mid * 6] <= time) low = mid + 1;
      else high = mid;
    }
    const a = Math.max(0, low - 1) * 6;
    const b = Math.min(low, count - 1) * 6;
    const valueA = keys[a + 1];
    const slopeA = keys[a + 3];
    const slopeB = keys[b + 2];
    if (Math.abs(slopeA) === Infinity || Math.abs(slopeB) === Infinity) return valueA;
    const duration = keys[b] - keys[a];
    if (duration === 0) return valueA;
    const t = (time - keys[a]) / duration;
    const valueB = keys[b + 1];
    const tangentA = duration * slopeA;
    const tangentB = duration * slopeB;
    const weightA = keys[a + 5];
    const weightB = keys[b + 4];
    if (weightA === ONE_THIRD && weightB === ONE_THIRD) {
      return ((((2 * valueA + tangentA - 2 * valueB + tangentB) * t
        + (-3 * valueA - 2 * tangentA + 3 * valueB - tangentB)) * t
        + tangentA) * t) + valueA;
    }
    const u = this._extractU(t, weightA, 1 - weightB);
    const v = 1 - u;
    return (tangentA * weightA + valueA) * u * 3 * v * v
      + v * v * v * valueA + (valueB - tangentB * weightB) * u * u * 3 * v
      + u * u * u * valueB;
  }

  _extractU(time, x1, x2) {
    const a = 3 * x1 - 3 * x2 + 1;
    const b = -6 * x1 + 3 * x2;
    const c = 3 * x1;
    if (Math.abs(a) > 0.001) {
      const offset = -b / (3 * a);
      const p = c / (3 * a) - offset * offset;
      const q = (c * b + 3 * a * time) / (6 * a * a) + offset * offset * offset;
      const discriminant = p * p * p + q * q;
      if (discriminant < 0) {
        const radius = Math.sqrt(-p * p * p);
        const angle = Math.acos(q / radius) / 3;
        const scale = 2 * Math.cbrt(radius);
        let root = scale * Math.cos(angle) + offset;
        if (root >= 0 && root <= 1) return root;
        root = scale * Math.cos(angle + 2.0943952) + offset;
        if (root >= 0 && root <= 1) return root;
        return scale * Math.cos(angle - 2.0943952) + offset;
      }
      const sqrt = Math.sqrt(discriminant);
      return Math.cbrt(q + sqrt) + Math.cbrt(q - sqrt) + offset;
    }
    if (Math.abs(b) > 0.001) {
      const sqrt = Math.sqrt(c * c + 4 * b * time);
      const root = (-c + sqrt) / (2 * b);
      return root >= 0 && root <= 1 ? root : (-c - sqrt) / (2 * b);
    }
    return time / c;
  }
}

function createSide(nodes, boneIndex, endIndex, armIndex, model, endModel) {
  const bone = nodes.get(boneIndex);
  const end = nodes.get(endIndex);
  const arm = nodes.get(armIndex);
  if (!bone || !end || !arm) throw new Error('ActorSwingBreastBone references a missing transform');
  return {
    bone, end, arm,
    model: modelingTransform(model),
    endModel: modelingTransform(endModel),
    direction: new THREE.Vector3(),
    length: 0,
    position: new THREE.Vector3(),
    rotation: new THREE.Quaternion(),
    animatedPosition: new THREE.Vector3(),
    animatedRotation: new THREE.Quaternion(),
    previousPosition: new THREE.Vector3(),
    previousRotation: new THREE.Quaternion(),
    previousArmPosition: new THREE.Vector3(),
    sampledArmPosition: new THREE.Vector3(),
    initialLocalRotation: bone.quaternion.clone(),
    armPosition: new THREE.Vector3(),
    springPosition: new THREE.Vector3(),
    frameRotation: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    localPosition: new THREE.Vector3(),
    localRotation: new THREE.Quaternion(),
    outputPosition: new THREE.Vector3(),
    outputRotation: new THREE.Quaternion(),
    hasOutput: false,
  };
}

/**
 * Native ActorSwing breast-pair solver. Animation writers must run between
 * restorePose() and capture(context); capture() is after animation and IK.
 * All persistent simulation state is in context's actor-root affine space.
 */
export class ActorSwingBreasts {
  constructor(nodes, breastBones) {
    // AddBreastBone (0x1809B0300) only adds to the breast list, never to the
    // static list. Neither breast job function consumes breastCollider.
    this.pairs = [];
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._q0 = new THREE.Quaternion();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._q3 = new THREE.Quaternion();
    this._parentPosition = new THREE.Vector3();
    this._parentScale = new THREE.Vector3();
    this._sampleParentPosition = new THREE.Vector3();
    this._sampleParentRotation = new THREE.Quaternion();
    this._captured = false;
    for (const cfg of breastBones || []) {
      if (cfg.enabled === false) continue;
      const parent = nodes.get(cfg.node);
      if (!parent) throw new Error('ActorSwingBreastBone references a missing root transform');
      const left = createSide(nodes, cfg.leftBreast, cfg.leftBreastEnd, cfg.leftLowerArm,
        cfg.modelingLeftTransform, cfg.modelingLeftEndTransform);
      const right = createSide(nodes, cfg.rightBreast, cfg.rightBreastEnd, cfg.rightLowerArm,
        cfg.modelingRightTransform, cfg.modelingRightEndTransform);
      this.pairs.push({
        cfg, parent, sides: [left, right],
        parentPosition: new THREE.Vector3(),
        parentRotation: new THREE.Quaternion(),
        previousParentPosition: new THREE.Vector3(),
        previousParentRotation: new THREE.Quaternion(),
        simulationParentRotation: new THREE.Quaternion(),
        cancelPosition: new THREE.Vector3(),
        upCurve: new BreastCurve(cfg.upCurve),
        sideCurve: new BreastCurve(cfg.sideCurve),
        initialized: false,
        initialCount: DEFAULT_INITIALIZATION_COUNT,
      });
    }
    this.reset();
  }

  /** Remove only this module's previous local TR, before any animation writes. */
  restorePose() {
    for (let i = 0; i < this.pairs.length; i++) {
      const sides = this.pairs[i].sides;
      for (let j = 0; j < 2; j++) {
        const s = sides[j];
        if (!s.hasOutput) continue;
        // An animation system may already have replaced either component. Never
        // roll back a component which no longer contains our previous output.
        if (s.bone.position.equals(s.outputPosition)) s.bone.position.copy(s.localPosition);
        if (s.bone.quaternion.equals(s.outputRotation)) s.bone.quaternion.copy(s.localRotation);
        s.bone.updateMatrix();
        s.hasOutput = false;
      }
    }
  }

  reset(initializationCount = DEFAULT_INITIALIZATION_COUNT) {
    this.restorePose();
    this._captured = false;
    for (let i = 0; i < this.pairs.length; i++) {
      const pair = this.pairs[i];
      pair.initialized = false;
      pair.initialCount = initializationCount;
      for (let j = 0; j < 2; j++) {
        const s = pair.sides[j];
        s.velocity.set(0, 0, 0);
        s.direction.copy(s.endModel.localPosition);
        s.length = s.direction.length();
        s.direction.multiplyScalar(1 / s.length);
        s.springPosition.copy(s.endModel.position);
      }
    }
  }

  _readPosition(node, out, options) {
    out.setFromMatrixPosition(node.matrixWorld);
    if (options.spaceInverse) out.applyMatrix4(options.spaceInverse);
  }

  _readRotation(node, out, options) {
    node.matrixWorld.decompose(this._parentPosition, out, this._parentScale);
    if (options.spaceRotation) out.premultiply(options.spaceRotation);
  }

  capture(options = EMPTY_OPTIONS) {
    this.restorePose();
    for (let i = 0; i < this.pairs.length; i++) {
      const pair = this.pairs[i];
      if (this._captured) {
        pair.previousParentPosition.copy(pair.parentPosition);
        pair.previousParentRotation.copy(pair.parentRotation);
      }
      pair.parent.updateWorldMatrix(true, true);
      this._readPosition(pair.parent, pair.parentPosition, options);
      this._readRotation(pair.parent, pair.parentRotation, options);
      if (!this._captured) {
        pair.previousParentPosition.copy(pair.parentPosition);
        pair.previousParentRotation.copy(pair.parentRotation);
      }
      for (let j = 0; j < 2; j++) {
        const s = pair.sides[j];
        if (this._captured) {
          s.previousPosition.copy(s.animatedPosition);
          s.previousRotation.copy(s.animatedRotation);
          s.previousArmPosition.copy(s.armPosition);
        }
        s.bone.updateWorldMatrix(true, false);
        s.arm.updateWorldMatrix(true, false);
        this._readPosition(s.bone, s.animatedPosition, options);
        this._readRotation(s.bone, s.animatedRotation, options);
        this._readPosition(s.arm, s.armPosition, options);
        if (!this._captured) {
          s.previousPosition.copy(s.animatedPosition);
          s.previousRotation.copy(s.animatedRotation);
          s.previousArmPosition.copy(s.armPosition);
        }
        s.localPosition.copy(s.bone.position);
        s.localRotation.copy(s.bone.quaternion);
      }
    }
    this._captured = true;
  }

  /**
   * One native fixed tick; callers supply ticks at 60 Hz. Native breast code
   * ignores AnimationStream.deltaTime and integrates its literal 0.01667.
   * rootTranslation is cumulative actor-root displacement, never a tick delta.
   * Optional modelingWeight and armCorrectionWeight mirror the common native
   * settings; their constructor defaults are respectively zero and one.
   */
  step(dt, options = EMPTY_OPTIONS) {
    if (!this._captured) this.capture(options);
    if (!(dt > 0)) {
      this.apply(options);
      return;
    }
    const alpha = options.alpha ?? 1;
    const weight = options.weight ?? 1;
    const speed = options.speed ?? 1;
    const armWeight = options.armCorrectionWeight ?? 1;
    for (let i = 0; i < this.pairs.length; i++) {
      const pair = this.pairs[i];
      const cfg = pair.cfg;
      this._sampleParentPosition.lerpVectors(pair.previousParentPosition, pair.parentPosition, alpha);
      this._sampleParentRotation.slerpQuaternions(pair.previousParentRotation, pair.parentRotation, alpha);
      pair.simulationParentRotation.copy(this._sampleParentRotation);
      const root = options.rootTranslation;
      const correction = options.rootCorrection;
      const rootWeight = (correction?.weight ?? 1) * cfg.rootWeight;
      if (root) {
        pair.cancelPosition.set(root.x * (1 - rootWeight * (correction?.xz ?? 1)),
          root.y * (1 - rootWeight * (correction?.y ?? 1)),
          root.z * (1 - rootWeight * (correction?.xz ?? 1)));
      } else {
        pair.cancelPosition.set(0, 0, 0);
      }
      this._sampleParentPosition.sub(pair.cancelPosition);
      const initializationCount = pair.initialCount;
      let remaining = initializationCount > 0 ? initializationCount * 0.5 * NATIVE_STEP : NATIVE_STEP;
      pair.initialCount = 0;
      // A pending native reset disables velocity carry for this entire settle
      // batch; arm-correction displacement is divided by ceil(batch/tick), <=3.
      const spring = initializationCount > 0 ? 0 : cfg.spring;
      const divisor = Math.min(3, Math.ceil(remaining / NATIVE_STEP));
      for (let j = 0; j < 2; j++) {
        const s = pair.sides[j];
        s.position.lerpVectors(s.previousPosition, s.animatedPosition, alpha).sub(pair.cancelPosition);
        s.rotation.slerpQuaternions(s.previousRotation, s.animatedRotation, alpha);
        s.sampledArmPosition.lerpVectors(s.previousArmPosition, s.armPosition, alpha).sub(pair.cancelPosition);
        if (initializationCount > 0) {
          s.rotation.multiplyQuaternions(this._sampleParentRotation, s.model.localRotation);
          s.springPosition.copy(s.endModel.localPosition).applyQuaternion(s.rotation).add(s.position);
        }
      }
      while (remaining > 0) {
        const delta = Math.min(NATIVE_STEP, remaining);
        for (let j = 0; j < 2; j++) {
          this._integrate(pair, pair.sides[j], j, delta, spring, divisor, speed, weight, armWeight);
        }
        const left = pair.sides[0].rotation;
        const right = pair.sides[1].rotation;
        this._q0.copy(left);
        left.slerp(right, cfg.average);
        right.slerp(this._q0, cfg.average);
        remaining -= NATIVE_STEP;
      }
      pair.initialized = true;
    }
    this.apply(options);
  }

  _integrate(pair, s, side, delta, spring, divisor, speed, weight, armWeight) {
    const cfg = pair.cfg;
    s.frameRotation.copy(s.rotation);
    const target = this._v0.copy(s.endModel.localPosition).applyQuaternion(s.rotation).add(s.position);
    const force = calcStiffnessPendulum(this._v1, 0, s.direction, s.length,
      s.position, s.rotation, s.springPosition, target, cfg.stiffness, cfg.pendulum, cfg.pendulumRange);
    const damping = (1 - cfg.damping) * (1 - cfg.damping);
    force.addScaledVector(this._v2.subVectors(target, s.springPosition), damping)
      .addScaledVector(s.velocity, spring);
    if (cfg.useArmCorrection) {
      this._q0.copy(this._sampleParentRotation).invert();
      const localArm = this._v2.subVectors(s.sampledArmPosition, this._sampleParentPosition)
        .applyQuaternion(this._q0);
      const up = pair.upCurve.evaluate(localArm.y / localArm.length());
      this._v3.set(up, 0, 0).applyQuaternion(s.rotation);
      force.addScaledVector(this._v3, armWeight / divisor);
      this._q0.multiply(s.rotation);
      const localEnd = this._v3.copy(s.endModel.localPosition).applyQuaternion(this._q0);
      const angle = Math.acos(localArm.dot(localEnd) / (localArm.length() * localEnd.length()));
      const sideForce = pair.sideCurve.evaluate(angle);
      // Reflection reverses Unity's local Z while preserving local X/Y.
      this._v3.set(0, 0, side === 0 ? -sideForce : sideForce).applyQuaternion(s.rotation);
      force.addScaledVector(this._v3, armWeight / divisor);
    }
    s.velocity.copy(force).multiplyScalar(delta * 40 * speed);
    s.springPosition.add(s.velocity);
    this._v2.copy(s.direction).applyQuaternion(s.rotation);
    this._v3.subVectors(s.springPosition, s.position);
    swingFromToRotation(this._q0, this._v2, this._v3);
    s.rotation.premultiply(this._q0);
    this._spring(this._v4, s.position, s.springPosition, s.length);
    s.springPosition.copy(this._v4);
    // 0x1809C3B70 has only angular limits and the job weight. Breast motion
    // does not call CheckDynamicCollision; do not invent breast self-collision.
    clampSwingRotation(this._q0, s.frameRotation, s.rotation, cfg);
    s.rotation.copy(s.frameRotation).slerp(this._q0, weight);
  }

  /** Reapply a completed fixed-step pose without advancing its simulation. */
  apply(options = EMPTY_OPTIONS) {
    const modelingWeight = options.modelingWeight ?? 0;
    for (let i = 0; i < this.pairs.length; i++) {
      const pair = this.pairs[i];
      if (!pair.initialized) continue;
      for (let j = 0; j < 2; j++) {
        const s = pair.sides[j];
        this._q2.copy(s.rotation);
        if (modelingWeight >= 1e-5) {
          this._q3.copy(pair.simulationParentRotation).invert();
          this._q2.premultiply(this._q3).slerp(s.initialLocalRotation, modelingWeight);
          this._q2.premultiply(pair.simulationParentRotation);
        }
        this._writeRotation(s, this._q2, options, 1);
      }
    }
  }
  _writeRotation(s, rotation, options, weight) {
    this._q0.copy(rotation);
    if (options.spaceWorldRotation) this._q0.premultiply(options.spaceWorldRotation);
    if (s.bone.parent) {
      s.bone.parent.updateWorldMatrix(true, false);
      s.bone.parent.matrixWorld.decompose(this._parentPosition, this._q1, this._parentScale);
      this._q0.premultiply(this._q1.invert());
    }
    s.bone.quaternion.copy(s.localRotation).slerp(this._q0, weight);
    s.bone.updateMatrix();
    s.bone.updateWorldMatrix(false, true);
    s.outputPosition.copy(s.bone.position);
    s.outputRotation.copy(s.bone.quaternion);
    s.hasOutput = true;
  }

  _spring(out, origin, position, length) {
    out.subVectors(position, origin);
    const squaredLength = out.lengthSq();
    if (squaredLength > 9.9999994e-11) {
      out.multiplyScalar(length / Math.sqrt(squaredLength)).add(origin);
    } else {
      out.copy(origin);
    }
    return out;
  }

}
