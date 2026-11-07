import { mul, inv, rotate } from './human_rig.js';
import { adjustLimbLength, solveLimbIK, adjustLimbHint } from './human_limb_ik.js';
import { reachGoalRotation } from './human_twist.js';

const IDENTITY = [0, 0, 0, 1];
const CHAINS = [[1, 3, 5], [2, 4, 6], [14, 16, 18], [15, 17, 19]];
const PREFIXES = ['lf', 'rf', 'lh', 'rh'];
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = q => { const length = Math.hypot(...q); return q.map(v => v / length); };
const clampWeight = w => Math.max(0, Math.min(1, w));
function nlerp(a, b, w) {
  const sign = a.reduce((sum, v, i) => sum + v * b[i], 0) < 0 ? -1 : 1;
  return norm(a.map((v, i) => v + (sign * b[i] - v) * w));
}

// Native SkeletonPose local/global buffers, in Unity actor coordinates. The
// renderer's scene placement is deliberately outside this solver's space.
export class HumanIKPose {
  constructor(rig, rotations, positions) {
    this.rig = rig;
    this.worldRotations = new Map(rotations);
    this.worldPositions = new Map(positions);
    this.localRotations = new Map();
    this.localPositions = new Map();
    for (const bone of rig.bones) {
      const parent = bone.parent, inverse = inv(parent ? rotations.get(parent) : IDENTITY);
      this.localRotations.set(bone, norm(mul(inverse, rotations.get(bone))));
      this.localPositions.set(bone, parent
        ? rotate(inverse, sub(positions.get(bone), positions.get(parent)))
        : positions.get(bone).slice());
    }
  }

  updateWorld() {
    this.worldRotations.clear();
    this.worldPositions.clear();
    const update = bone => {
      if (this.worldRotations.has(bone)) return;
      const parent = bone.parent;
      if (parent) update(parent);
      const q = parent ? this.worldRotations.get(parent) : IDENTITY;
      this.worldRotations.set(bone, norm(mul(q, this.localRotations.get(bone))));
      const p = rotate(q, this.localPositions.get(bone));
      this.worldPositions.set(bone, parent ? add(this.worldPositions.get(parent), p) : p);
    };
    for (const bone of this.rig.bones) update(bone);
  }

}

// Clip Goal T/Q channels are normalized body-space targets. Foot positions
// address the sole (HumanGetGoalXform B7DD90), not the ankle pivot.
export function clipHumanGoals(state, root, bodyRotation, bodyPosition) {
  return PREFIXES.map((prefix, index) => {
    const end = state.rig.body[CHAINS[index][2]];
    if (!end) return null;
    const t = root?.[`${prefix}T`], q = root?.[`${prefix}Q`];
    if (!t && !q) return null;
    const rotation = q ? norm(mul(bodyRotation, norm(q)))
      : mul(state.worldRotations.get(end), end.post);
    let position = t ? add(bodyPosition, rotate(bodyRotation, t.map(v => v * state.rig.humanScale))) : null;
    if (position && index < 2) position = sub(position, rotate(rotation, [end.length, 0, 0]));
    return { position, rotation, positionWeight: t ? 1 : 0, rotationWeight: q ? 1 : 0 };
  });
}

export function solveHumanGoals(state, goals) {
  // FullBodySolve B88A60: all position/stretch/hint passes precede all goal
  // rotations. No look-at inputs are synthesized from the clip's Goal curves.
  for (let index = 0; index < 4; index++) {
    const goal = goals[index];
    const [upper, lower, end] = CHAINS[index].map(i => state.rig.body[i]);
    if (!goal || !upper || !lower || !end) continue;
    const weight = clampWeight(goal.positionWeight ?? 0);
    if (weight > 0 && goal.position) {
      const current = state.worldPositions.get(end);
      const target = current.map((v, i) => v + (goal.position[i] - v) * weight);
      // HumanCtor B7BD60: arm/leg stretch .05. This ramp changes translations;
      // it is not a fixed chain-length clamp or an extra collision iteration.
      adjustLimbLength(state, upper, lower, end, target, weight * 0.05);
      solveLimbIK(state, upper, lower, end, goal.position, weight);
    }
    const hintWeight = clampWeight(goal.hintWeight ?? 0);
    if (hintWeight > 0 && goal.hint) adjustLimbHint(state, upper, lower, end, goal.hint, hintWeight);
  }
  for (let index = 0; index < 4; index++) {
    const goal = goals[index], end = state.rig.body[CHAINS[index][2]];
    const weight = clampWeight(goal?.rotationWeight ?? 0);
    if (!end || !goal?.rotation || weight <= 0) continue;
    const current = mul(state.worldRotations.get(end), end.post);
    const desired = nlerp(current, goal.rotation, weight);
    reachGoalRotation(state, index, mul(desired, inv(end.post)));
  }
  return state;
}
