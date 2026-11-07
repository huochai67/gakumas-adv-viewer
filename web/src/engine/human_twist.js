import { mul, inv, rotate } from './human_rig.js';

// UnityPlayer 7A967673EA4F48258125F6D6920C5CDD1:
// TwistSolve B8A320, HumanFixTwist B84E80, ReachGoalRotation B860E0,
// HumanFixEndDoF B85A40, SkeletonAlign B8C5C0. Quaternions are Unity XYZW.
const IDENTITY = [0, 0, 0, 1];
const X_AXIS = [1, 0, 0];
const TWIST_PAIRS = [[16, 18], [14, 16], [17, 19], [15, 17], [3, 5], [1, 3], [4, 6], [2, 4]];
// Native table 181C6BAC0: [goal bone, upper limb, lower limb, endpoint].
// Thus Goal indices are LeftFoot, RightFoot, LeftHand, RightHand, not body indices.
const GOAL_CHAINS = [[5, 1, 3, 5], [6, 2, 4, 6], [18, 14, 16, 18], [19, 15, 17, 19]];
const TAN_HALF_LIMIT = 1.5707954168319702; // 181D7D8C0 / negated 181D7E160.
const AXES_EPSILON = 0.0000009999999974752427; // float32 at 181D7D110.

function normalize(q) {
  const length = Math.hypot(...q);
  return q.map(value => value / length);
}

// B34C80 uses this cosine polynomial for both numerator and denominator,
// after wrapping the angle and clamping its half-angle short of +/- pi/2.
// Keep that behavior rather than using Euler angles or an unbounded tan().
function cosinePolynomial(turns) {
  const x = 0.25 - Math.abs(turns - Math.trunc(turns));
  const x2 = x * x, x4 = x2 * x2;
  return ((x2 * -76.56862 + 81.60182) * x4 + x2 * -41.34166 + 6.283185 +
    x4 * x4 * 39.657032) * x;
}

export function tanHalf(angle) {
  const shifted = Math.abs(angle) + 3.1415927410125732;
  const wrapped = shifted - Math.trunc(shifted / 6.2831854820251465) * 6.2831854820251465 -
    3.1415927410125732;
  const half = Math.max(-TAN_HALF_LIMIT, Math.min(TAN_HALF_LIMIT, (angle < 0 ? -wrapped : wrapped) * 0.5));
  const turns = half * 0.15915493667125702;
  return cosinePolynomial(turns - 0.25) / cosinePolynomial(turns);
}

// AxesUnapply B34EA0 / AxesApply B34FA0. All axes built by HumanRig use
// native type=1 (ZYRoll); the sign and asymmetric limits belong to that frame.
export function axesUnapply(bone, localQuaternion) {
  return normalize(mul(inv(bone.pre), mul(localQuaternion, bone.post)));
}

export function axesApply(bone, axisQuaternion) {
  return normalize(mul(bone.pre, mul(axisQuaternion, inv(bone.post))));
}

function rollSwingTangents(q) {
  const w = Math.abs(q[3]) < AXES_EPSILON ? AXES_EPSILON : q[3];
  const x = q[0] / w, y = q[1] / w, z = q[2] / w, denominator = 1 + x * x;
  return [x, (y - x * z) / denominator, (z + x * y) / denominator];
}

// B35090 / B8C4D0: normalized DoFs, not degrees and not generic XYZ Euler.
// A limit with the opposite sign is the native unrestricted-angle sentinel;
// zero denotes a locked axis. Projection itself does not clamp to [-1, 1].
export function axesProject(bone, localQuaternion) {
  const tangents = rollSwingTangents(axesUnapply(bone, localQuaternion));
  return tangents.map((tangent, axis) => {
    const angle = 2 * Math.atan(tangent * bone.sign[axis]);
    const limit = angle < 0 ? bone.min[axis] : bone.max[axis];
    if (angle < 0) return limit < 0 ? -angle / limit : limit > 0 ? angle : 0;
    return limit > 0 ? angle / limit : limit < 0 ? angle : 0;
  });
}

// B7B330 / B8A5B0: the type=1 swing/roll product is [x,y+x*z,z-x*y,1].
export function axesUnproject(bone, muscles) {
  const tangents = muscles.map((muscle, axis) => {
    const limit = muscle < 0 ? bone.min[axis] : bone.max[axis];
    const angle = muscle < 0
      ? (limit < 0 ? -muscle * limit : limit > 0 ? muscle : 0)
      : (limit > 0 ? muscle * limit : limit < 0 ? muscle : 0);
    return tanHalf(angle) * bone.sign[axis];
  });
  const [x, y, z] = tangents;
  return axesApply(bone, normalize([x, y + x * z, z - x * y, 1]));
}

// B8C5C0 aligns the candidate's post-frame X direction to the original one,
// preserving its redistributed roll. This is the native cross/dot quaternion,
// left-multiplied onto the candidate, not a look-at or Euler reconstruction.
export function skeletonAlign(referenceLocal, candidateLocal, postQuaternion) {
  const reference = rotate(normalize(mul(referenceLocal, postQuaternion)), X_AXIS);
  const candidate = rotate(normalize(mul(candidateLocal, postQuaternion)), X_AXIS);
  const correction = normalize([
    candidate[1] * reference[2] - candidate[2] * reference[1],
    candidate[2] * reference[0] - candidate[0] * reference[2],
    candidate[0] * reference[1] - candidate[1] * reference[0],
    Math.hypot(...candidate) * Math.hypot(...reference) +
      candidate[0] * reference[0] + candidate[1] * reference[1] + candidate[2] * reference[2],
  ]);
  return mul(correction, candidateLocal);
}

// B8AF00 computes only the requested ancestor-to-descendant chain, with the
// ancestor's parent set to identity in scratch space. Keep every intermediate
// skeleton bone rather than assuming two mapped human bones are adjacent.
function relativeRotation(state, bone, ancestorParent) {
  let rotation = IDENTITY;
  for (let current = bone; current !== ancestorParent; current = current.parent) {
    rotation = normalize(mul(state.localRotations.get(current), rotation));
  }
  return rotation;
}

// B8B1B0 is called with first==last==endpoint: only its local quaternion is
// recomputed. Intermediate local rotations remain untouched by redistribution.
function restoreEndpoint(state, start, end, endpointRotation) {
  const parentRotation = relativeRotation(state, end.parent, start.parent);
  state.localRotations.set(end, normalize(mul(inv(parentRotation), endpointRotation)));
}

function fixTwist(state, start, end) {
  const original = state.localRotations.get(start);
  const endpointRotation = relativeRotation(state, end, start.parent);
  const muscles = axesProject(start, original);
  muscles[0] *= 0.5; // HumanCtor default upper/lower arm and leg twist factors.
  const candidate = axesUnproject(start, muscles);
  state.localRotations.set(start, skeletonAlign(original, candidate, start.post));
  restoreEndpoint(state, start, end, endpointRotation);
}

export function applyHumanTwist(state) {
  // B8A320's order is significant: lower then upper, arms then legs.
  for (const [startIndex, endIndex] of TWIST_PAIRS) {
    const start = state.rig.body[startIndex], end = state.rig.body[endIndex];
    if (start && end) fixTwist(state, start, end);
  }
  state.updateWorld();
}

// ReachGoalRotation requests exactly one iteration of B85A40, with a 0.05
// DEGREE roll tolerance. This is not the similarly-valued limb stretch setting.
function fixEndDoF(state, start, end) {
  const endpointAxes = axesUnapply(end, state.localRotations.get(end));
  const roll = rollSwingTangents(endpointAxes)[0];
  if (Math.abs(2 * Math.atan(roll) * 57.29578) < 0.05) return;

  const original = state.localRotations.get(start);
  const endpointRotation = relativeRotation(state, end, start.parent);
  // Iteration zero starts from both neutral axes poses, not a clamped end pose.
  state.localRotations.set(start, axesApply(start, IDENTITY));
  state.localRotations.set(end, axesApply(end, IDENTITY));
  const neutralEndpoint = relativeRotation(state, end, start.parent);
  const correction = mul(endpointRotation, inv(neutralEndpoint));
  const candidate = normalize(mul(correction, state.localRotations.get(start)));
  state.localRotations.set(start, skeletonAlign(original, candidate, start.post));
  restoreEndpoint(state, start, end, endpointRotation);
}

export function reachGoalRotation(state, goalIndex, targetBoneWorldQuaternion) {
  const chain = GOAL_CHAINS[goalIndex];
  if (!chain) return;
  const goal = state.rig.body[chain[0]], start = state.rig.body[chain[2]], end = state.rig.body[chain[3]];
  if (!goal || !start || !end) return;
  // B860E0 receives a bone-space world orientation, after RemoveAxis; callers
  // must not pass the goal-axis frame quaternion here without that conversion.
  const parentRotation = goal.parent ? state.worldRotations.get(goal.parent) : IDENTITY;
  state.localRotations.set(goal, normalize(mul(inv(parentRotation), targetBoneWorldQuaternion)));
  fixEndDoF(state, start, end);
  state.updateWorld();
}
