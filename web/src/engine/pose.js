// Humanoid FK derives native muscle frames and scale from this actor's bind skeleton.
// Post-rig IK, Quartz and ActorSwing precede the final humanoid twist pass.
import * as THREE from 'three';
import { ActorSwing } from './actor_swing.js';
import { QuartzDriver } from './quartz.js';
import { HumanRig } from './human_rig.js';
import { HumanIKPose, clipHumanGoals, solveHumanGoals } from './human_ik.js';
import { applyHumanTwist } from './human_twist.js';
import { BodyIKCorrection } from './body_ik.js';

// ---------- Unity Hamilton quaternion helpers [x, y, z, w] ----------
function qmul(a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function qnorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function qinv(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

function qrot(q, v) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  const ux = qy * vz - qz * vy;
  const uy = qz * vx - qx * vz;
  const uz = qx * vy - qy * vx;
  const uux = qy * uz - qz * uy;
  const uuy = qz * ux - qx * uz;
  const uuz = qx * uy - qy * ux;
  return [
    vx + 2 * (qw * ux + uux),
    vy + 2 * (qw * uy + uuy),
    vz + 2 * (qw * uz + uuz),
  ];
}


function convQ(q) {
  return new THREE.Quaternion(q[0], q[1], -q[2], -q[3]).normalize();
}

export class PoseSolver {
  /**
   * @param {Map<number, THREE.Object3D>} nodeByIndex glTF node index -> object
   * @param {object} charMeta assets/char.json
   */
  constructor(nodeByIndex, charMeta) {
    this.nodes = nodeByIndex;
    this.meta = charMeta;
    this.humanoid = charMeta.humanoid || {};
    this.nameToNode = {};
    for (const [idx, name] of Object.entries(charMeta.boneNodes || {})) {
      const n = nodeByIndex.get(parseInt(idx, 10));
      if (n && !(name in this.nameToNode)) this.nameToNode[name] = n;
      if (n) n.userData.skeletonName = name;
    }

    // Snapshot bind world transforms (in actor root space) & local TRS
    this.bind = new Map();       // Object3D -> {pos, quat} in Three.js space
    this.bindPosU = {};          // boneName -> [x, y, z] in Unity space
    this.bindQuat3 = {};         // boneName -> THREE.Quaternion (world bind)
    for (const n of nodeByIndex.values()) {
      n.updateWorldMatrix(true, false);
      const pos = n.getWorldPosition(new THREE.Vector3());
      const quat = n.getWorldQuaternion(new THREE.Quaternion());
      const scale = n.getWorldScale(new THREE.Vector3());
      this.bind.set(n, { pos, quat, scale });
      const sname = n.userData.skeletonName;
      if (sname && !(sname in this.bindPosU)) {
        this.bindPosU[sname] = [pos.x, pos.y, -pos.z];
        this.bindQuat3[sname] = quat.clone();
      }
    }

    this.humanRig = new HumanRig(nodeByIndex, charMeta, this.bind);
    this.tposeMuscles = this.humanRig.tposeMuscles;
    this.humanScale = this.humanRig.humanScale;
    this.muscles = new Float32Array(this.tposeMuscles);
    this._twistSources = this.humanRig.bones.map(({ node }) => ({ node, rotation: node.quaternion.clone() }));
    this._twistCaptured = false;
    this._twistPosition = new THREE.Vector3();
    this._twistOuterInverse = new THREE.Matrix4();
    this._rigRoot = this.humanRig.body[0].node;
    while (this.bind.has(this._rigRoot.parent)) this._rigRoot = this._rigRoot.parent;
    this._initSwingAndIK();
  }

  /**
   * Solve full-body pose from 95 humanoid muscles + optional root/bone tracks.
   * @param {Float32Array|number[]} muscles
   * @param {Array} boneTracks
   * @param {object|null} root Normalized body RootT/RootQ and foot/hand Goal T/Q.
   */
  poseFrom(muscles, boneTracks = [], root = null) {
    const rig = this.humanRig;
    const m = muscles || this.tposeMuscles;
    const rq = root?.rootQ ? qnorm(root.rootQ) : [0, 0, 0, 1];
    const solved = rig.solve(m);
    const bodyPositions = rig.body.map(b => b && solved.positions.get(b));
    const center = rig.massCenter(bodyPositions);
    // RetargetTo (UnityPlayer B87F80): express the solved pelvis relative to the
    // current mass center/body orientation, then apply the requested body TRS.
    const orientation = qmul(rig.orientation(bodyPositions), qinv(rig.bodyRotation));
    const correction = qmul(rq, qinv(orientation));
    const targetCenter = root?.rootT
      ? root.rootT.map(v => v * rig.humanScale)
      : rig.center;
    const rotations = new Map(), positions = new Map();
    for (const bone of rig.bones) {
      rotations.set(bone, qmul(correction, solved.worlds.get(bone)));
      const offset = qrot(correction, solved.positions.get(bone).map((v, i) => v - center[i]));
      positions.set(bone, targetCenter.map((v, i) => v + offset[i]));
    }
    const ik = new HumanIKPose(rig, rotations, positions);
    solveHumanGoals(ik, clipHumanGoals(ik, root, rq, targetCenter));
    const worldDeltaU = {};
    for (const bone of rig.bones) {
      worldDeltaU[bone.name] = qmul(ik.worldRotations.get(bone), qinv(bone.rotation));
    }

    const out = new Map();
    const solvedWorld3 = new Map();
    const getWorld3 = obj => {
      if (!obj || !this.bind.has(obj)) return new THREE.Quaternion();
      if (solvedWorld3.has(obj)) return solvedWorld3.get(obj);
      const name = obj.userData?.skeletonName;
      const delta = name && worldDeltaU[name];
      const q = delta
        ? convQ(delta).multiply(this.bind.get(obj).quat)
        : getWorld3(obj.parent).clone().multiply(obj.userData?.bindTRS?.q || obj.quaternion);
      solvedWorld3.set(obj, q);
      return q;
    };
    const solvedPosition3 = new Map();
    const getPosition3 = obj => {
      if (!obj || !this.bind.has(obj)) return new THREE.Vector3();
      if (solvedPosition3.has(obj)) return solvedPosition3.get(obj);
      const bone = rig.byNode.get(obj), p = bone && ik.worldPositions.get(bone);
      const position = p ? new THREE.Vector3(p[0], p[1], -p[2])
        : (obj.userData?.bindTRS?.p || obj.position).clone()
          .multiply(this.bind.get(obj.parent)?.scale || new THREE.Vector3(1, 1, 1))
          .applyQuaternion(getWorld3(obj.parent)).add(getPosition3(obj.parent));
      solvedPosition3.set(obj, position);
      return position;
    };
    // Emit every stretchable translation on every pose, including unstretched
    // poses. Otherwise seek/crossfade would retain the previous frame's length.
    const translated = new Set([0, 3, 4, 5, 6, 16, 17, 18, 19].map(i => rig.body[i]));
    for (const bone of rig.bones) {
      const obj = bone.node;
      const value = { q: getWorld3(obj.parent).clone().invert().multiply(getWorld3(obj)) };
      if (translated.has(bone)) {
        const p = getPosition3(obj).clone();
        if (obj.parent) {
          p.sub(getPosition3(obj.parent)).applyQuaternion(getWorld3(obj.parent).clone().invert());
          const parentScale = this.bind.get(obj.parent)?.scale;
          if (parentScale) p.divide(parentScale);
        }
        value.p = p.toArray();
      }
      out.set(obj, value);
    }
    // Missing effector tracks mean bind weights, not the previous clip's flags.
    for (const node of this.bodyIK.effectors) {
      const bind = node.userData.bindTRS;
      out.set(node, { p: bind.p.toArray(), q: bind.q.clone(), s: bind.s.toArray() });
    }

    for (const t of boneTracks) {
      const obj = (t.boneName && this.nameToNode[t.boneName]) || this.nodes.get(t.node);
      if (!obj || rig.byNode.has(obj)) continue;
      let e = out.get(obj);
      if (!e) { e = {}; out.set(obj, e); }
      if (t.prop === 'position') e.p = [t.value[0], t.value[1], -t.value[2]];
      else if (t.prop === 'scale') e.s = [t.value[0], t.value[1], t.value[2]];
      else if (t.prop === 'rotation') e.q = new THREE.Quaternion(t.value[0], t.value[1], -t.value[2], -t.value[3]);
    }
    out.muscles = m;
    return out;
  }

  /** Write a pose to the rig, optionally blending from another pose (w=1 -> b). */
  applyPose(a, b, w = 1) {
    this._restoreFinalTwist();
    this.swing.restorePose();
    this.quartz.restorePose();
    this.bodyIK.restorePose();
    const am = a?.muscles, bm = b?.muscles;
    if (am && bm) {
      for (let i = 0; i < this.muscles.length; i++) this.muscles[i] = am[i] + (bm[i] - am[i]) * w;
    } else {
      this.muscles.set(bm || am || this.tposeMuscles);
    }
    const objs = new Set();
    if (a) for (const o of a.keys()) objs.add(o);
    if (b) for (const o of b.keys()) objs.add(o);
    const pa = new THREE.Vector3(), pb = new THREE.Vector3();
    for (const obj of objs) {
      const ea = a ? a.get(obj) : null;
      const eb = b ? b.get(obj) : null;
      const ww = eb ? w : 0;
      if (ea && eb) {
        if (ea.q && eb.q) obj.quaternion.copy(ea.q).slerp(eb.q, ww);
        else if (eb.q) obj.quaternion.copy(eb.q);
        if (ea.p && eb.p) {
          pa.fromArray(ea.p); pb.fromArray(eb.p);
          obj.position.copy(pa).lerp(pb, ww);
        } else if (eb.p) obj.position.fromArray(eb.p);
        if (ea.s && eb.s) {
          pa.fromArray(ea.s); pb.fromArray(eb.s);
          obj.scale.copy(pa).lerp(pb, ww);
        } else if (eb.s) obj.scale.fromArray(eb.s);
      } else if (eb) {
        if (eb.q) obj.quaternion.copy(eb.q);
        if (eb.p) obj.position.fromArray(eb.p);
        if (eb.s) obj.scale.fromArray(eb.s);
      } else if (ea) {
        if (ea.q) obj.quaternion.copy(ea.q);
        if (ea.p) obj.position.fromArray(ea.p);
        if (ea.s) obj.scale.fromArray(ea.s);
      }
    }
  }

  apply(muscleValues, boneTracks = [], root = null) {
    this.applyPose(null, this.poseFrom(muscleValues, boneTracks, root), 1);
  }

  resetPose() {
    this._restoreFinalTwist();
    this.swing.restorePose();
    this.quartz.restorePose();
    this.bodyIK.restorePose();
    this.muscles.set(this.tposeMuscles);
    for (const n of this.nodes.values()) {
      if (n.userData.bindTRS) {
        n.position.copy(n.userData.bindTRS.p);
        n.quaternion.copy(n.userData.bindTRS.q);
        n.scale.copy(n.userData.bindTRS.s);
      }
    }
  }

  // ---------------- Post-FK Rig Pass: IKCorrection + QuartzDriver + ActorSwing ----------------
  _initSwingAndIK() {
    this.bodyIK = new BodyIKCorrection(this.nodes, this.humanRig, this.meta, this.nameToNode);
    this.enableIK = true;
    this.enableSwing = true;
    this.quartz = new QuartzDriver(this.nodes, this.meta);
    this.swing = new ActorSwing(this.nodes, this.meta, this.nameToNode.Hips);
  }

  resetSwing() {
    this._restoreFinalTwist();
    this.swing.reset();
  }

  /**
   * Run custom stream IK, Quartz and ActorSwing on the pre-twist skeleton.
   * EvaluateAvatarEnd redistributes humanoid twist only after these jobs.
   */
  updatePostRig(simTime = 0) {
    this._restoreFinalTwist();
    this.swing.restorePose();
    this.quartz.restorePose();
    this.bodyIK.restorePose();
    const hips = this.nameToNode.Hips;
    if (!hips) return;
    let root = hips;
    while (root.parent) root = root.parent;
    root.updateMatrixWorld(true);
    if (this.enableIK !== false) this.bodyIK.update();
    this.quartz.update(this.muscles);
    this.swing.update(simTime, this.enableSwing !== false);
    this._applyFinalTwist();
  }

  _restoreFinalTwist() {
    if (!this._twistCaptured) return;
    for (const { node, rotation } of this._twistSources) {
      node.quaternion.copy(rotation);
      node.updateMatrix();
    }
    this._twistCaptured = false;
  }

  _applyFinalTwist() {
    const rig = this.humanRig, outer = this._rigRoot.parent;
    this._rigRoot.updateWorldMatrix(true, true);
    if (outer) this._twistOuterInverse.copy(outer.matrixWorld).invert();
    else this._twistOuterInverse.identity();
    const rotations = new Map(), positions = new Map(), world = new Map();
    // Local quaternion products exclude scene placement and remain valid through
    // zero-scale weight handles; matrix decomposition would lose their rotation.
    const currentRotation = node => {
      if (!node || !this.bind.has(node)) return new THREE.Quaternion();
      if (!world.has(node)) world.set(node, currentRotation(node.parent).clone().multiply(node.quaternion));
      return world.get(node);
    };
    for (const { node, rotation } of this._twistSources) {
      rotation.copy(node.quaternion);
      const bone = rig.byNode.get(node), q = currentRotation(node);
      rotations.set(bone, [-q.x, -q.y, q.z, q.w]);
      node.getWorldPosition(this._twistPosition).applyMatrix4(this._twistOuterInverse);
      positions.set(bone, [this._twistPosition.x, this._twistPosition.y, -this._twistPosition.z]);
    }
    const state = new HumanIKPose(rig, rotations, positions);
    applyHumanTwist(state);
    world.clear();
    const finalRotation = node => {
      if (!node || !this.bind.has(node)) return new THREE.Quaternion();
      if (!world.has(node)) {
        const bone = rig.byNode.get(node), q = bone && state.worldRotations.get(bone);
        world.set(node, q ? convQ(q) : finalRotation(node.parent).clone().multiply(node.quaternion));
      }
      return world.get(node);
    };
    for (const { node } of this._twistSources) {
      node.quaternion.copy(finalRotation(node.parent)).invert().multiply(finalRotation(node));
      node.updateMatrix();
    }
    this._twistCaptured = true;
    this._rigRoot.updateWorldMatrix(false, true);
  }
}
