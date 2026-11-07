import * as THREE from 'three';
import { SwingCollider, SwingCollisionResult, collideSwingColliders } from './swing_collision.js';
import {
  calcStiffnessPendulum, swingFromToRotation, clampSwingRotation,
  clampSlidePosition, rootCorrection,
} from './swing_math.js';
import { ActorSwingBreasts } from './swing_breast.js';
import { swingWind, seatedCorrection } from './swing_environment.js';

// The animation adapter samples at 60 Hz. The native integrator's literal is
// 0.01667 (not 1/60), including its reset-count / 2 stabilization interval.
const FRAME_TIME = 1 / 60;
const NATIVE_STEP = 0.01667;
const DEFAULT_INITIALIZATION_COUNT = 5; // ActorAnimationRig.ResetDynamicBone
const ZERO = [0, 0, 0];
const IDENTITY = [0, 0, 0, 1];

function vectorU(a = ZERO) {
  return new THREE.Vector3(a[0], a[1], -a[2]);
}

function quaternionU(a = IDENTITY) {
  return new THREE.Quaternion(-a[0], -a[1], a[2], a[3]);
}

function colliderDefinition(cfg, dynamic = false) {
  return {
    type: dynamic ? cfg.colType : cfg.type,
    mask: cfg.mask,
    ignoreMask: cfg.ignoreMask ?? 0,
    vA: dynamic ? cfg.offset : cfg.vA,
    vB: cfg.vB,
    rA: dynamic ? cfg.radius : cfg.rA,
    rB: dynamic ? cfg.radiusSub : cfg.rB,
  };
}

function makePoseSample(node) {
  return {
    node,
    position: new THREE.Vector3(), rotation: new THREE.Quaternion(),
    previousPosition: new THREE.Vector3(), previousRotation: new THREE.Quaternion(),
    samplePosition: new THREE.Vector3(), sampleRotation: new THREE.Quaternion(),
    scale: 1,
  };
}

function projectLength(out, origin, target, length) {
  out.subVectors(target, origin);
  const lengthSq = out.lengthSq();
  if (lengthSq > 9.9999994e-11) out.multiplyScalar(length / Math.sqrt(lengthSq));
  else out.set(0, 0, 0);
  return out.add(origin);
}

/**
 * ActorAnimationSwingJobSkeleton, with AnimationStream replaced by Object3D
 * pose snapshots. Native entry points and state offsets are documented beside
 * their ports; all simulation positions live in the actor root's affine frame.
 */
export class ActorSwing {
  constructor(nodes, meta, hips) {
    this.nodes = nodes;
    this.spaceRoot = hips?.parent || hips;
    this.hips = hips;
    this.parameters = {
      weight: 1, speed: 1, root: 1, rootXZ: 1, rootY: 1,
      initializationCount: DEFAULT_INITIALIZATION_COUNT,
      seated: false,
      wind: {
        power: new THREE.Vector3(), direction: new THREE.Vector3(),
        noisePower: 0, noiseSpeed: 0, sinePower: 0, sineSpeed: 0, sinePhase: 0,
        limit: 0, minimum: 0, blendSpeed: 0, blendPhase: 0,
        directionNoisePower: 0, directionNoiseSpeed: 0,
      },
    };
    this.bones = [];
    this.boneByNode = new Map();
    this.boneByObject = new Map();
    const defs = meta.swing || {};
    for (const cfg of defs.dynamicBones || []) {
      const node = nodes.get(cfg.node);
      if (!node) continue;
      const modeling = cfg.modelingTransform;
      const bind = node.userData.bindTRS;
      const localPosition = modeling ? vectorU(modeling.localPosition) : bind.p.clone();
      const localRotation = modeling ? quaternionU(modeling.localRotation) : bind.q.clone();
      const length = localPosition.length();
      const state = {
        cfg, node, parent: null, child: null, depth: 0,
        active: cfg.enabled !== false,
        initialPosition: localPosition,
        initialRotation: localRotation,
        direction: length > 1e-5 ? localPosition.clone().multiplyScalar(1 / length) : new THREE.Vector3(1, 0, 0),
        length,
        position: new THREE.Vector3(), rotation: new THREE.Quaternion(),
        framePosition: new THREE.Vector3(), frameRotation: new THREE.Quaternion(),
        velocity: new THREE.Vector3(),
        sourcePosition: node.position.clone(), sourceRotation: node.quaternion.clone(),
        sourceScale: node.scale.clone(),
        sample: makePoseSample(node),
        initialCount: this.parameters.initializationCount,
        history: new Float32Array(15), historyCount: 0,
        cancel: new THREE.Vector3(),
        rootWeights: { xz: cfg.rootWeight, y: cfg.rootWeight },
        collider: new SwingCollider(colliderDefinition(cfg, true)),
        scale: 1, reference: null,
      };
      this.bones.push(state);
      this.boneByNode.set(cfg.node, state);
      this.boneByObject.set(node, state);
    }
    for (const b of this.bones) {
      b.parent = this.boneByObject.get(b.node.parent) || null;
      b.child = this.boneByObject.get(b.node.children[0]) || null;
      b.reference = this.boneByNode.get(b.cfg.referenceLimit?.node) || null;
      let n = b.node.parent;
      while (n) { b.depth++; n = n.parent; }
    }
    // Native SortDynamicBone is hierarchy-first; the imported component order
    // is retained within a layer, including static collider traversal order.
    this.bones.sort((a, b) => a.depth - b.depth);
    this.layers = [];
    for (const b of this.bones) {
      let layer = this.layers[this.layers.length - 1];
      if (!layer || layer.depth !== b.depth) {
        layer = { depth: b.depth, bones: [], nets: [] };
        this.layers.push(layer);
      }
      layer.bones.push(b);
    }
    this.nets = [];
    for (const chain of defs.chains || []) {
      if (chain.enabled === false) continue;
      for (const cfg of chain.layers || []) {
        if (!cfg.active || cfg.nodes.length < 2) continue;
        const members = cfg.nodes.map((id) => this.boneByNode.get(id) || null);
        const first = members.find((b) => b?.parent);
        if (!first) continue;
        const layer = this.layers.find((l) => l.depth === first.parent.depth);
        if (!layer) continue;
        const segments = [];
        const count = cfg.around ? members.length : members.length - 1;
        for (let i = 0; i < count; i++) {
          const a = members[i], b = members[(i + 1) % members.length];
          // A missing component disables its own segment, never joins its two
          // neighbours into an artificial long chord through the actor.
          if (!a?.parent || !b?.parent) continue;
          segments.push({ a, b, collider: new SwingCollider({
            type: 2, mask: a.cfg.mask | b.cfg.mask, ignoreMask: 0,
            vA: ZERO, vB: ZERO, rA: cfg.radius, rB: cfg.radius,
          }) });
        }
        const net = {
          cfg, members, segments, restLength: 0,
          before: members.map(() => new THREE.Vector3()),
          smooth: members.map(() => new THREE.Vector3()),
        };
        this.nets.push(net);
        layer.nets.push(net);
      }
    }
    this.statics = [];
    this.collisionWorld = [];
    for (const cfg of defs.staticColliders || []) {
      const node = nodes.get(cfg.node);
      if (!node || cfg.enabled === false) continue;
      const entry = {
        cfg, sample: makePoseSample(node), parent: node.parent ? makePoseSample(node.parent) : null,
        collider: new SwingCollider(colliderDefinition(cfg)),
      };
      this.statics.push(entry);
      this.collisionWorld.push(entry.collider);
    }
    this.breasts = new ActorSwingBreasts(nodes, defs.breastBones || []);
    this.spaceInverse = new THREE.Matrix4();
    this.spaceWorld = new THREE.Matrix4();
    this.spaceRotation = new THREE.Quaternion();
    this.spaceWorldRotation = new THREE.Quaternion();
    this.rootPosition = new THREE.Vector3();
    this.rootPrevious = new THREE.Vector3();
    this.rootSample = new THREE.Vector3();
    this.hipsInitialPosition = hips?.userData.bindTRS.p.clone() || new THREE.Vector3();
    this.spaceScale = new THREE.Vector3(1, 1, 1);
    this.context = {
      spaceInverse: this.spaceInverse, spaceWorld: this.spaceWorld,
      spaceRotation: this.spaceRotation, spaceWorldRotation: this.spaceWorldRotation,
      rootTranslation: this.rootSample, rootCorrection: { weight: 1, xz: 1, y: 1 },
      weight: 1, speed: 1, seated: false, time: 0, alpha: 1,
      collisionWorld: this.collisionWorld,
    };
    this.scratch = {
      p: new THREE.Vector3(), q: new THREE.Quaternion(), scale: new THREE.Vector3(),
      target: new THREE.Vector3(), force: new THREE.Vector3(), localForce: new THREE.Vector3(),
      delta: new THREE.Vector3(), before: new THREE.Vector3(), direction: new THREE.Vector3(),
      oldDirection: new THREE.Vector3(), wind: new THREE.Vector3(),
      a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(),
      mean: new THREE.Vector3(), corrected: new THREE.Vector3(),
      q0: new THREE.Quaternion(), q1: new THREE.Quaternion(), q2: new THREE.Quaternion(),
      parentInverse: new THREE.Matrix4(), hit: new SwingCollisionResult(),
      seatHip: new THREE.Vector3(), seatKnee: new THREE.Vector3(), seatFoot: new THREE.Vector3(),
    };
    this.seatAnchors = [this.scratch.seatHip, this.scratch.seatKnee, this.scratch.seatFoot];
    this.seatNodes = [
      meta.humanoid?.LeftUpperLeg, meta.humanoid?.RightUpperLeg,
      meta.humanoid?.LeftLowerLeg, meta.humanoid?.RightLowerLeg,
      meta.humanoid?.LeftFoot, meta.humanoid?.RightFoot,
    ].map((id) => nodes.get(id));
    this.lastTime = null;
    this.accumulator = 0;
    this.written = false;
    this.ready = false;
  }

  restorePose() {
    if (!this.written) return;
    for (const b of this.bones) {
      b.node.position.copy(b.sourcePosition);
      b.node.quaternion.copy(b.sourceRotation);
      b.node.scale.copy(b.sourceScale);
    }
    this.breasts.restorePose();
    this.written = false;
  }

  reset(count = this.parameters.initializationCount) {
    this.restorePose();
    this.lastTime = null;
    this.accumulator = 0;
    this.ready = false;
    for (const b of this.bones) {
      b.velocity.set(0, 0, 0);
      b.cancel.set(0, 0, 0);
      b.initialCount = count;
      b.historyCount = 0;
      b.history.fill(0);
    }
    this.breasts.reset(count);
  }

  _captureSample(sample, first) {
    const node = sample.node;
    node.getWorldPosition(sample.position).applyMatrix4(this.spaceInverse);
    node.getWorldQuaternion(sample.rotation).premultiply(this.spaceRotation);
    node.getWorldScale(this.scratch.scale);
    sample.scale = Math.min(this.scratch.scale.x, this.scratch.scale.y, this.scratch.scale.z) /
      Math.min(this.spaceScale.x, this.spaceScale.y, this.spaceScale.z);
    if (first) {
      sample.previousPosition.copy(sample.position);
      sample.previousRotation.copy(sample.rotation);
    }
  }

  _capture(first) {
    this.spaceRoot.updateWorldMatrix(true, true);
    this.spaceWorld.copy(this.spaceRoot.matrixWorld);
    this.spaceInverse.copy(this.spaceWorld).invert();
    this.spaceRoot.getWorldQuaternion(this.spaceWorldRotation);
    this.spaceRotation.copy(this.spaceWorldRotation).invert();
    this.spaceRoot.getWorldScale(this.spaceScale);
    this.rootPosition.copy(this.hips.position).sub(this.hipsInitialPosition);
    if (first) this.rootPrevious.copy(this.rootPosition);
    for (const b of this.bones) {
      b.sourcePosition.copy(b.node.position);
      b.sourceRotation.copy(b.node.quaternion);
      b.sourceScale.copy(b.node.scale);
      this._captureSample(b.sample, first);
      b.scale = b.sample.scale;
      if (first) {
        b.position.copy(b.sample.position);
        b.rotation.copy(b.sample.rotation);
      }
    }
    for (const entry of this.statics) {
      this._captureSample(entry.sample, first);
      if (entry.parent) this._captureSample(entry.parent, first);
    }
    this.breasts.capture(this.context);
    if (first) {
      for (const net of this.nets) {
        net.restLength = 0;
        for (const seg of net.segments) net.restLength += seg.a.sample.position.distanceTo(seg.b.sample.position);
      }
    }
  }

  _sample(sample, alpha) {
    sample.samplePosition.lerpVectors(sample.previousPosition, sample.position, alpha);
    sample.sampleRotation.slerpQuaternions(sample.previousRotation, sample.rotation, alpha);
  }

  _staticColliders(alpha) {
    for (const entry of this.statics) {
      this._sample(entry.sample, alpha);
      if (entry.parent) this._sample(entry.parent, alpha);
      entry.collider.update(entry.sample.samplePosition,
        entry.parent?.samplePosition || entry.sample.samplePosition,
        entry.sample.sampleRotation, entry.sample.scale);
    }
  }

  update(time, enabled = true) {
    if (!this.spaceRoot || !this.hips) return;
    if (!enabled) {
      this.reset();
      return;
    }
    const p = this.parameters;
    const ctx = this.context;
    ctx.weight = p.weight;
    ctx.speed = p.speed;
    ctx.seated = p.seated;
    ctx.rootCorrection.weight = p.root;
    ctx.rootCorrection.xz = p.rootXZ;
    ctx.rootCorrection.y = p.rootY;
    const first = !this.ready || (this.lastTime !== null && time < this.lastTime);
    if (first && this.ready) this.reset();
    this._capture(first);
    if (first) {
      this.rootSample.copy(this.rootPosition);
      ctx.time = time;
      ctx.alpha = 1;
      this._staticColliders(1);
      this.breasts.step(NATIVE_STEP, ctx);
      this._step(NATIVE_STEP, 1);
      this.ready = true;
      this.accumulator = 0;
    } else {
      const elapsed = time - this.lastTime;
      const carried = this.accumulator;
      this.accumulator += elapsed;
      let progressed = FRAME_TIME - carried;
      while (this.accumulator + 1e-10 >= FRAME_TIME) {
        const alpha = elapsed > 0 ? Math.min(1, progressed / elapsed) : 1;
        this.rootSample.lerpVectors(this.rootPrevious, this.rootPosition, alpha);
        ctx.time = this.lastTime + progressed;
        ctx.alpha = alpha;
        this._staticColliders(alpha);
        this.breasts.step(NATIVE_STEP, ctx);
        this._step(NATIVE_STEP, alpha);
        this.accumulator -= FRAME_TIME;
        progressed += FRAME_TIME;
      }
    }
    this._writePose();
    this.rootPrevious.copy(this.rootPosition);
    for (const b of this.bones) {
      b.sample.previousPosition.copy(b.sample.position);
      b.sample.previousRotation.copy(b.sample.rotation);
    }
    for (const entry of this.statics) {
      entry.sample.previousPosition.copy(entry.sample.position);
      entry.sample.previousRotation.copy(entry.sample.rotation);
      if (entry.parent) {
        entry.parent.previousPosition.copy(entry.parent.position);
        entry.parent.previousRotation.copy(entry.parent.rotation);
      }
    }
    this.lastTime = time;
  }

  _step(dt, alpha) {
    const ctx = this.context;
    for (const b of this.bones) this._sample(b.sample, alpha);
    if (ctx.seated) this._seatAnchors();
    for (const layer of this.layers) {
      for (const parent of layer.bones) {
        if (!parent.parent) {
          parent.position.copy(parent.sample.samplePosition);
          parent.rotation.copy(parent.sample.sampleRotation);
        } else if (parent.parent.child !== parent) {
          parent.position.copy(parent.initialPosition).applyQuaternion(parent.parent.rotation).add(parent.parent.position);
          parent.rotation.copy(parent.parent.rotation).multiply(parent.initialRotation);
        }
        parent.framePosition.copy(parent.position);
        parent.frameRotation.copy(parent.rotation);
        const child = parent.child;
        if (!child) continue;
        this._integrate(parent, child, dt);
      }
      for (const net of layer.nets) {
        this._collideNet(net);
        if (this._smoothNet(net)) this._collideNet(net);
      }
      for (const parent of layer.bones) this._solveTransform(parent);
    }
  }

  _cachePosition(parent, child) {
    const history = parent.history;
    const offset = (parent.historyCount % 5) * 3;
    history[offset] = child.position.x;
    history[offset + 1] = child.position.y;
    history[offset + 2] = child.position.z;
    parent.historyCount++;
    if (parent.historyCount < 5) return false;
    let travelSq = 0;
    for (let i = 0; i < 5; i++) {
      const a = i * 3, b = ((i + 1) % 5) * 3;
      const x = history[a] - history[b], y = history[a + 1] - history[b + 1], z = history[a + 2] - history[b + 2];
      travelSq += x * x + y * y + z * z;
    }
    return travelSq < 1e-6;
  }

  _integrate(parent, child, dt) {
    const s = this.scratch, cfg = child.cfg, ctx = this.context;
    const count = parent.initialCount;
    const settling = count > 0;
    parent.initialCount = 0;
    s.target.copy(child.initialPosition).applyQuaternion(parent.rotation).add(parent.position);
    child.framePosition.copy(s.target);
    child.frameRotation.copy(parent.rotation).multiply(child.initialRotation);
    child.position.sub(child.cancel);
    rootCorrection(child.cancel, this.rootSample, this.parameters.root,
      ctx.rootCorrection, parent.rootWeights);
    if (!parent.active || !child.active) {
      parent.velocity.set(0, 0, 0);
      child.position.copy(s.target);
      child.rotation.copy(child.frameRotation);
      child.cancel.set(0, 0, 0);
      return;
    }
    // Native simulation stores the child in root-cancelled coordinates, but
    // collision geometry and final bone transforms are in the actor frame.
    parent.position.sub(child.cancel);
    s.target.sub(child.cancel);
    if (settling) {
      parent.velocity.set(0, 0, 0);
      child.position.copy(s.target);
    }
    let remaining = settling ? count * 0.5 * NATIVE_STEP : dt;
    while (remaining > 0) {
      const step = Math.min(NATIVE_STEP, remaining);
      calcStiffnessPendulum(s.force, cfg.dynamicType, child.direction, child.length,
        parent.position, parent.rotation, child.position, s.target,
        cfg.stiffness, cfg.pendulum, cfg.pendulumRange);
      const damping = (1 - cfg.damping) * (1 - cfg.damping);
      s.force.addScaledVector(s.delta.subVectors(s.target, child.position), damping);
      s.force.y -= cfg.mass * 0.01;
      if (cfg.useWindGlobalForce) {
        swingWind(s.wind, parent.position, this.parameters.wind, ctx.time);
        s.force.addScaledVector(s.wind, cfg.wind);
      }
      s.force.addScaledVector(parent.velocity, settling ? 0 : cfg.spring);
      if (parent.cfg.dynamicType === 1) {
        s.q0.copy(parent.rotation).invert();
        s.localForce.copy(s.force).applyQuaternion(s.q0);
        const x = Math.abs(s.localForce.x);
        if (!settling) {
          s.localForce.y += Math.sign(s.localForce.y) * x * cfg.axisAddXToY;
          s.localForce.z += Math.sign(s.localForce.z) * x * cfg.axisAddXToZ;
        }
        s.force.copy(s.localForce).applyQuaternion(parent.rotation);
      }
      parent.velocity.copy(s.force).multiplyScalar(step * 40 * this.parameters.speed);
      s.before.copy(child.position);
      child.position.add(parent.velocity);
      if (ctx.seated && cfg.seatDynamicCorrection > 1e-5) {
        seatedCorrection(s.corrected, parent.position, s.target, child.position,
          s.seatHip, s.seatKnee, s.seatFoot, child.cancel);
        child.position.lerp(s.corrected, cfg.seatDynamicCorrection);
      }
      if (cfg.dynamicType === 0) {
        s.oldDirection.copy(child.direction).applyQuaternion(parent.rotation);
        s.direction.subVectors(child.position, parent.position);
        swingFromToRotation(s.q0, s.oldDirection, s.direction);
        parent.rotation.premultiply(s.q0);
        projectLength(child.position, parent.position, child.position, child.length);
      }
      // Native FUN_1809b4d70: visit each static shape once, rebuild the dynamic
      // shape after each contact, and project the result back to its bone length.
      child.position.add(child.cancel);
      parent.position.add(child.cancel);
      child.collider.update(child.position, parent.position, parent.rotation, child.scale);
      for (const col of this.collisionWorld) {
        if (!collideSwingColliders(child.collider, col, s.hit, ctx.seated)) continue;
        s.a.copy(s.hit.point).addScaledVector(s.hit.normal, s.hit.radius);
        projectLength(child.position, parent.position, s.a, child.length);
        child.collider.update(child.position, parent.position, parent.rotation, child.scale);
      }
      child.position.sub(child.cancel);
      parent.position.sub(child.cancel);
      remaining -= NATIVE_STEP;
      if (settling && this._cachePosition(parent, child)) break;
    }
    child.position.add(child.cancel);
    parent.position.add(child.cancel);
  }

  _collideNet(net) {
    const s = this.scratch;
    for (const seg of net.segments) {
      const a = seg.a, b = seg.b;
      if (!a.active || !b.active) continue;
      seg.collider.update(a.position, b.position, a.rotation, a.scale);
      for (const col of this.collisionWorld) {
        if (!collideSwingColliders(seg.collider, col, s.hit, this.context.seated)) continue;
        s.target.copy(s.hit.point).addScaledVector(s.hit.normal, s.hit.radius);
        s.direction.subVectors(b.position, a.position).normalize();
        s.delta.subVectors(s.target, a.position);
        const projection = s.delta.dot(s.direction);
        s.delta.copy(s.target).sub(s.a.copy(a.position).addScaledVector(s.direction, projection));
        s.b.copy(a.position).add(s.delta);
        s.c.copy(b.position).add(s.delta);
        projectLength(a.position, a.parent.position, s.b, a.length);
        projectLength(b.position, b.parent.position, s.c, b.length);
        seg.collider.update(a.position, b.position, a.rotation, a.scale);
      }
    }
  }

  _smoothNet(net) {
    // ProcessChainBoneSmoothing only runs on closed (around) layers. Preserve
    // the rest circumference after averaging, rather than shrinking the cloth.
    if (!net.cfg.around || net.cfg.smoothing < 1e-5) return false;
    const members = net.members, n = members.length;
    for (let i = 0; i < n; i++) if (!members[i]?.active) return false;
    const s = this.scratch;
    for (let i = 0; i < n; i++) net.before[i].copy(members[i].position);
    for (let i = 0; i < n; i++) {
      net.smooth[i].addVectors(net.before[(i + n - 1) % n], net.before[(i + 1) % n]).multiplyScalar(0.5);
      net.smooth[i].lerpVectors(net.before[i], net.smooth[i], net.cfg.smoothing);
    }
    let length = 0;
    s.mean.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      length += net.smooth[i].distanceTo(net.smooth[(i + 1) % n]);
      s.mean.add(net.smooth[i]);
    }
    s.mean.multiplyScalar(1 / n);
    if (length < net.restLength && length > 0) {
      const scale = net.restLength / length;
      for (let i = 0; i < n; i++) net.smooth[i].sub(s.mean).multiplyScalar(scale).add(s.mean);
    }
    for (let i = 0; i < n; i++) members[i].position.copy(net.smooth[i]);
    return true;
  }

  _solveTransform(parent) {
    const child = parent.child;
    if (!child || !parent.active) return;
    const s = this.scratch;
    if (child.cfg.dynamicType === 0) {
      s.oldDirection.copy(child.direction).applyQuaternion(parent.rotation);
      s.direction.subVectors(child.position, parent.position);
      swingFromToRotation(s.q0, s.oldDirection, s.direction);
      parent.rotation.premultiply(s.q0);
      clampSwingRotation(parent.rotation, parent.frameRotation, parent.rotation,
        parent.cfg, parent.reference?.rotation || null, parent.cfg.referenceLimit,
        this.context.seated, parent.cfg.seatDynamicCorrection);
      parent.rotation.slerpQuaternions(parent.frameRotation, parent.rotation, this.parameters.weight);
      child.position.copy(child.initialPosition).applyQuaternion(parent.rotation).add(parent.position);
      child.rotation.copy(parent.rotation).multiply(child.initialRotation);
    } else {
      clampSlidePosition(child.position, parent.framePosition, parent.frameRotation,
        child.position, child.cfg, child.initialPosition, this.parameters.weight);
      child.rotation.copy(parent.rotation).multiply(child.initialRotation);
    }
  }

  _seatAnchors() {
    const s = this.scratch;
    const pairs = this.seatAnchors;
    for (let i = 0; i < 3; i++) {
      const a = this.seatNodes[i * 2], b = this.seatNodes[i * 2 + 1];
      if (!a || !b) {
        pairs[i].set(0, 0, 0);
        continue;
      }
      a.getWorldPosition(s.a).applyMatrix4(this.spaceInverse);
      b.getWorldPosition(s.b).applyMatrix4(this.spaceInverse);
      pairs[i].addVectors(s.a, s.b).multiplyScalar(0.5);
    }
  }

  _writePose() {
    const s = this.scratch;
    for (const b of this.bones) {
      if (!b.active) continue;
      s.p.copy(b.position).applyMatrix4(this.spaceWorld);
      s.q.copy(b.rotation).premultiply(this.spaceWorldRotation);
      const parent = b.node.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        s.parentInverse.copy(parent.matrixWorld).invert();
        b.node.position.copy(s.p).applyMatrix4(s.parentInverse);
        parent.getWorldQuaternion(s.q0).invert();
        b.node.quaternion.copy(s.q0).multiply(s.q);
      } else {
        b.node.position.copy(s.p);
        b.node.quaternion.copy(s.q);
      }
      b.node.updateWorldMatrix(false, false);
    }
    this.breasts.apply(this.context);
    this.written = true;
  }
}
