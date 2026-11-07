import * as THREE from 'three';
import { mul, inv, rotate } from './human_rig.js';
import { HumanIKPose, solveHumanGoals } from './human_ik.js';
import { correctionCollisionInfo, correctGoalPosition } from './ik_correction.js';

const IDENTITY = [0, 0, 0, 1];
const HANDS = [
  { goal: 2, end: 18, lower: 16, effector: 'IKGoal_LeftHand', hint: 'IKHint_LeftElbow' },
  { goal: 3, end: 19, lower: 17, effector: 'IKGoal_RightHand', hint: 'IKHint_RightElbow' },
];
const add = (a, b) => a.map((v, i) => v + b[i]);
const lerp = (a, b, w) => a.map((v, i) => v + (b[i] - v) * w);
const toUnityQ = q => [-q.x, -q.y, q.z, q.w];

// ActorAnimationFullBodyIKJobSkeleton.SetGaolEffector 18099DBA0, hand branch.
// Goal scale.x/y controls IK position/rotation; hint scale.y is a DIFFERENT
// weight from hint scale.x (elbow direction, SetHintEffector 18099EC80).
export function handCorrectionGoal(state, index, effector, hint, cfg, colliders) {
  const hand = HANDS[index - 2];
  const end = state.rig.body[hand.end], lower = state.rig.body[hand.lower];
  if (!end || !lower) return null;
  let position = effector?.position || state.worldPositions.get(end);
  let positionWeight = effector?.scale[0] ?? 0;
  const rotationWeight = effector?.scale[1] ?? 0, collisionWeight = hint?.scale[1] ?? 0;
  const firstValid = Boolean(colliders[0]?.position);
  if (effector && cfg && (positionWeight > 1e-5 || rotationWeight > 1e-5 || (firstValid && cfg.enable)) && collisionWeight > 1e-8) {
    // Test the CURRENT wrist + rotated offset, never the effector's target.
    const point = add(state.worldPositions.get(end), rotate(state.worldRotations.get(end), cfg.offset));
    let closest = null;
    for (const collider of colliders) {
      // Native uses radius, not collider weight, as the geometry validity gate.
      if (!collider.position || collider.cfg.radius < 1e-5) continue;
      const info = correctionCollisionInfo(collider.cfg, collider.position, collider.rotation, point, cfg.radius);
      if (info && (!closest || info.distance < closest.distance)) closest = info;
    }
    const correction = closest && correctGoalPosition(closest, point, cfg.radius, collisionWeight);
    // Entering the correction branch replaces explicit position weight even on
    // a miss. On a hit, emit the surface target; do not preblend it or subtract
    // cfg.offset. Native cancels moveDelta here before its final common add.
    positionWeight = correction ? correction.weight : 0;
    if (correction) position = correction.position;
  }
  const hintWeight = hint && hint.scale[0] >= 1e-5 ? hint.scale[0] : 0;
  return {
    position, positionWeight,
    rotation: effector?.rotation || mul(state.worldRotations.get(end), end.post), rotationWeight,
    // StreamGetHintPosition B52F20 derives arm hints from the current elbow.
    hint: hintWeight ? lerp(state.worldPositions.get(lower), hint.position, hintWeight) : null,
    hintWeight,
  };
}

/** Custom post-animation hand avoidance; Quartz and ActorSwing consume its output. */
export class BodyIKCorrection {
  constructor(nodes, rig, meta, nameToNode) {
    this.nodes = new Set(nodes.values());
    this.rig = rig;
    this.hands = HANDS.map(hand => ({
      ...hand,
      effectorNode: nameToNode[hand.effector], hintNode: nameToNode[hand.hint],
      cfg: meta.ikCorrection?.goals?.find(g => g.goal === hand.goal) || null,
    }));
    this.effectors = this.hands.flatMap(h => [h.effectorNode, h.hintNode]).filter(Boolean);
    this.colliders = (meta.ikCorrection?.colliders || []).map(cfg => ({
      cfg, node: nodes.get(cfg.node) || nameToNode[cfg.name],
    }));
    this.source = [];
    this.actorRoot = rig.body[0].node;
    while (this.nodes.has(this.actorRoot.parent)) this.actorRoot = this.actorRoot.parent;
    this.outerInverse = new THREE.Matrix4();
    this.position = new THREE.Vector3();
  }

  restorePose() {
    for (const source of this.source) {
      source.node.position.copy(source.position);
      source.node.quaternion.copy(source.rotation);
      source.node.updateMatrix();
    }
    this.source.length = 0;
  }

  _rotation(node) {
    if (!node || !this.nodes.has(node)) return IDENTITY;
    // Effector localScale stores WEIGHTS and can be zero. Decomposing its
    // matrixWorld would produce a NaN quaternion; Unity reads Transform rotation.
    return mul(this._rotation(node.parent), toUnityQ(node.quaternion));
  }

  _sample(node) {
    if (!node) return null;
    node.getWorldPosition(this.position).applyMatrix4(this.outerInverse);
    return { position: [this.position.x, this.position.y, -this.position.z],
      rotation: this._rotation(node), scale: node.scale.toArray() };
  }

  update() {
    this.actorRoot.updateWorldMatrix(true, true);
    const outer = this.actorRoot.parent;
    this.outerInverse.copy(outer ? outer.matrixWorld : new THREE.Matrix4()).invert();
    const rotations = new Map(), positions = new Map();
    for (const bone of this.rig.bones) {
      const sample = this._sample(bone.node);
      rotations.set(bone, sample.rotation); positions.set(bone, sample.position);
    }
    const state = new HumanIKPose(this.rig, rotations, positions);
    const colliders = this.colliders.map(c => ({ cfg: c.cfg, ...this._sample(c.node) }));
    const goals = [null, null, null, null];
    for (const hand of this.hands) {
      goals[hand.goal] = handCorrectionGoal(state, hand.goal,
        this._sample(hand.effectorNode), this._sample(hand.hintNode), hand.cfg, colliders);
    }
    if (!goals.some(g => g && (g.positionWeight > 0 || g.rotationWeight > 0 || g.hintWeight > 0))) return;
    const localRotations = new Map(state.localRotations), localPositions = new Map(state.localPositions);
    // AnimationHumanStream.SolveIK invokes FullBodySolve, not EvaluateAvatarEnd:
    // no second TwistSolve, no second preblend of the corrected target.
    solveHumanGoals(state, goals);
    for (const bone of this.rig.bones) {
      if (state.localRotations.get(bone) === localRotations.get(bone) &&
          state.localPositions.get(bone) === localPositions.get(bone)) continue;
      const node = bone.node;
      this.source.push({ node, position: node.position.clone(), rotation: node.quaternion.clone() });
      const q = mul(inv(this._rotation(node.parent)), state.worldRotations.get(bone));
      node.quaternion.set(-q[0], -q[1], q[2], q[3]);
      if (state.localPositions.get(bone) !== localPositions.get(bone)) {
        const p = state.worldPositions.get(bone);
        this.position.set(p[0], p[1], -p[2]);
        if (outer) this.position.applyMatrix4(outer.matrixWorld);
        if (node.parent) node.parent.worldToLocal(this.position);
        node.position.copy(this.position);
      }
      node.updateWorldMatrix(false, true);
    }
  }
}
