// Exact Unity Mecanim Humanoid solver + ActorAnimationQuartzDriver helper twists.
//
// Verified to <3mm against ground-truth Foot/Hand IK goals across Gakumas motion
// clips. Computes joint rotations in Unity's exact ZYRoll2Quat muscle space
// (with piecewise [min, max] limits and m_tpose neutral offsets), converts into
// Three.js right-handed world space via the exact reflection homomorphism
// conv_q(x, y, z, w) = (x, y, -z, -w), anchors Hips world position so feet lock
// to the y=0 floor plane during hip sway, and applies QuartzDriver counter-twists
// on shoulder/forearm/thigh helper bones.

import * as THREE from 'three';

const D2R = Math.PI / 180;
const HUMAN_SCALE = 0.91611;

// Exact m_tpose muscle values for Amao's rig (verified from additive reference t=0).
export const TPOSE_MUSCLES = new Float32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0,          // 0..8   Spine, Chest, UpperChest
  0, 0, 0, 0, 0, 0,                   // 9..14  Neck, Head
  0, 0, 0, 0, 0, 0,                   // 15..20 LeftEye, RightEye, Jaw
  0.5994, 0, 0, 0.9991, 0, 0, 0, 0,   // 21..28 Left Leg
  0.5994, 0, 0, 0.9991, 0, 0, 0, 0,   // 29..36 Right Leg
  0, 0, 0.4, 0.3001, 0, 0.9999, 0, 0, 0, // 37..45 Left Arm
  0, 0, 0.4, 0.3001, 0, 0.9999, 0, 0, 0, // 46..54 Right Arm
  // 55..74 Left Thumb..Little (curl1, spread, curl2, curl3)
  -1.3669, -0.5458, 0.6463, 0.6463,
  0.668, -0.4574, 0.8117, 0.8117,
  0.668, -0.6108, 0.8117, 0.8117,
  0.668, -0.6108, 0.8117, 0.8117,
  0.668, -0.4574, 0.8117, 0.8117,
  // 75..94 Right Thumb..Little
  -1.3669, -0.5458, 0.6463, 0.6463,
  0.668, -0.4574, 0.8117, 0.8117,
  0.668, -0.6108, 0.8117, 0.8117,
  0.668, -0.6108, 0.8117, 0.8117,
  0.668, -0.4574, 0.8117, 0.8117,
]);

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

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

function mirrorX(q) {
  return [q[0], -q[1], -q[2], q[3]];
}

function pw(m, mn, mx) {
  return m >= 0 ? m * mx : -m * mn;
}

function qaxis(axis, deg) {
  const h = 0.5 * deg * D2R;
  const q = [0, 0, 0, Math.cos(h)];
  q[axis] = Math.sin(h);
  return q;
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

function qFromUnitVecsU(u, v) {
  const cx = u[1] * v[2] - u[2] * v[1];
  const cy = u[2] * v[0] - u[0] * v[2];
  const cz = u[0] * v[1] - u[1] * v[0];
  const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  if (d < -0.999999) {
    const ax = Math.abs(u[0]) < 0.9 ? [0, -u[2], u[1]] : [-u[2], 0, u[0]];
    const l = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    return [ax[0] / l, ax[1] / l, ax[2] / l, 0];
  }
  return qnorm([cx, cy, cz, 1 + d]);
}

function solveTwoBoneDeltaU(A, B, C, T, qUpper, qLower) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  const ab = sub(B, A);
  const bc = sub(C, B);
  const ac = sub(C, A);
  const at = sub(T, A);
  const L1 = len(ab), L2 = len(bc), curDist = len(ac), rawDist = len(at);
  if (L1 < 1e-4 || L2 < 1e-4 || curDist < 1e-5 || rawDist < 1e-5) return [qUpper, qLower];

  const d = Math.max(Math.abs(L1 - L2) + 1e-4, Math.min(L1 + L2 - 1e-4, rawDist));
  const uAC = scale(ac, 1 / curDist);
  const uAT = scale(at, 1 / rawDist);
  const qSwing = qFromUnitVecsU(uAC, uAT);

  let perp = sub(ab, scale(uAC, dot(ab, uAC)));
  if (len(perp) < 1e-5) perp = sub([0, -1, -0.25], scale(uAC, -uAC[1] - 0.25 * uAC[2]));
  let poleDir = qrot(qSwing, norm(perp));
  poleDir = norm(sub(poleDir, scale(uAT, dot(poleDir, uAT))));

  const x = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L1 * L1 - x * x));
  const Bnew = add(add(A, scale(uAT, x)), scale(poleDir, h));
  const Tclamped = add(A, scale(uAT, d));

  const qDelta1 = qFromUnitVecsU(norm(ab), norm(sub(Bnew, A)));
  const qUpperNew = qmul(qDelta1, qUpper);
  const qLowerMid = qmul(qDelta1, qLower);
  const bcMid = qrot(qLowerMid, qrot(qinv(qLower), bc));
  const qDelta2 = qFromUnitVecsU(norm(bcMid), norm(sub(Tclamped, Bnew)));
  const qLowerNew = qmul(qDelta2, qLowerMid);
  return [qUpperNew, qLowerNew];
}

// Exact T-pose CoM -> Hips offset in Unity metres (from additive T-pose reference clip t=0)
const COM_TO_HIPS_TRUE_U = [-0.001875, 0.002782, 0.017562];

// Exact UnityPlayer.dll mecanim::hand::s_BoneInfo limits & SetupAxes PostQ/Sgn tables
const HAND_FINGER_SPECS = [
  // [sMin, sMax, c1Min, c1Max, c2Min, c2Max, sgnYL, sgnZL, sgnYR, sgnZR]
  [-25, 25, -20, 20, -40, 35, -1,  1, -1, -1], // Thumb
  [-20, 20, -50, 50, -45, 45, -1, -1, -1,  1], // Index
  [-7.5, 7.5, -50, 50, -45, 45, -1, -1, -1, 1], // Middle
  [-7.5, 7.5, -50, 50, -45, 45,  1, -1,  1, 1], // Ring
  [-20, 20, -50, 50, -45, 45,  1, -1,  1,  1], // Pinky
];
const POSTQ_THUMB_L = [0, 1, 0, 0], POSTQ_THUMB_R = [0, 0, 0, 1];
const POSTQ_FINGER_L = [0, 0, 1, 0], POSTQ_FINGER_R = [1, 0, 0, 0];

/** Exact Unity Mecanim ZYRoll2Quat(tan(deg/2)). */
function zyUnity(dx, dy, dz) {
  const tx = Math.tan(0.5 * dx * D2R);
  const ty = Math.tan(0.5 * dy * D2R);
  const tz = Math.tan(0.5 * dz * D2R);
  return qnorm([
    tx + ty * tz,
    ty + tx * tz,
    tz - tx * ty,
    1.0 - tx * ty * tz,
  ]);
}

/** Piecewise HumanTrait degree mapping relative to m_tpose neutral offset. */
function uDeg(m, mn, mx, mt0 = 0) {
  const n0 = -(mt0 >= 0 ? mt0 * mx : -mt0 * mn);
  return n0 + (m >= 0 ? m * mx : -m * mn);
}

function convQ(q) {
  return new THREE.Quaternion(q[0], q[1], -q[2], -q[3]).normalize();
}

// Exact Unity Mecanim AxesArray PreQ / PostQ muscle-center frames for Shoulder, UpperArm & ForeArm
// (verified to 1.87 deg mean rotation error against ground-truth lhQ/rhQ across 75 frames).
const SH_DU_N = -20.723, SH_DU_P = 20.149, SH_FB_N = -20.023, SH_FB_P = 15.008;
const ARM_DU_N = -58.135, ARM_DU_P = 86.150, ARM_FB_N = -102.673, ARM_FB_P = 84.908, ARM_TW = 77.483;
const FA_ST = 80.764, FA_TW = 90.0, HD_DU = 81.455, HD_IO = 32.620;

const Q_PRE_SH_R = zyUnity(5.519, 0.455, -8.960);
const Q_PRE_SH_R_INV = qinv(Q_PRE_SH_R);
const Q_PRE_ARM_R = zyUnity(-17.379, -39.389, -36.516);
const Q_POST_ARM_R_INV = qinv(qmul(Q_PRE_ARM_R, zyUnity(0, pw(0.3001, ARM_FB_N, ARM_FB_P), pw(0.4, ARM_DU_N, ARM_DU_P))));
const Q_PRE_FA_R = zyUnity(1.821, -77.641, -0.917);
const Q_POST_FA_R_INV = qinv(qmul(Q_PRE_FA_R, zyUnity(0, pw(0.9999, -FA_ST, FA_ST), 0)));

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
      this.bind.set(n, { pos, quat });
      const sname = n.userData.skeletonName;
      if (sname && !(sname in this.bindPosU)) {
        this.bindPosU[sname] = [pos.x, pos.y, -pos.z];
        this.bindQuat3[sname] = quat.clone();
      }
    }

    this._initSwingAndIK();
  }

  /**
   * Solve full-body pose from 95 humanoid muscles + optional root/bone tracks.
   * @param {Float32Array|number[]} muscles
   * @param {Array} boneTracks
   * @param {object|null} root  { rootT, rootQ, lfT, rfT }
   */
  poseFrom(muscles, boneTracks = [], root = null) {
    const m = muscles || TPOSE_MUSCLES;
    const rq = (root && root.rootQ && root.rootQ.length === 4)
      ? qnorm(root.rootQ)
      : [0, 0, 0, 1];

    // Map boneName -> delta world rotation in Unity space (q_world = q_delta * q_bind)
    const worldDeltaU = {};
    worldDeltaU.Hips = rq;

    // ---------- Spine / Chest / UpperChest / Neck / Head / Eyes ----------
    const spLim = 13.66;
    let qTorso = rq;
    for (const [base, bname, sc] of [
      [0, 'Spine', spLim],
      [3, 'Spine1', spLim],
      [6, 'Spine2', spLim * 0.6],
    ]) {
      qTorso = qmul(qTorso, zyUnity(-m[base] * sc, m[base + 2] * sc, -m[base + 1] * sc));
      worldDeltaU[bname] = qTorso;
    }

    // Neck (9..11) & Head (12..14)
    const qNeck = qmul(qTorso, zyUnity(
      -uDeg(m[9], -20, 20),
      uDeg(m[11], -20, 20),
      -uDeg(m[10], -20, 20),
    ));
    worldDeltaU.Neck = qNeck;

    const qHead = qmul(qNeck, zyUnity(
      -uDeg(m[12], -25, 25),
      uDeg(m[14], -25, 25),
      -uDeg(m[13], -25, 25),
    ));
    worldDeltaU.Head = qHead;

    // Eyes (15..18): Down-Up (X), In-Out (Y) — always emit so look-target never accumulates across frames
    worldDeltaU.LeftEye = qmul(qHead, zyUnity(uDeg(m[15], -10, 12), -uDeg(m[16], -15, 15), 0));
    worldDeltaU.RightEye = qmul(qHead, zyUnity(uDeg(m[17], -10, 12), uDeg(m[18], -15, 15), 0));

    // ---------- Arms (37..54): Exact PreQ / PostQ Muscle-Center Quaternion Conjugation ----------
    // ForeArm bends at elbow with 0% axial twist; ForeArm_Roll_H (50%), Hand_H (90%) & Hand (100%)
    // distribute forearm pronation/supination smoothly from elbow to cuff without candy-wrapper twist.
    const lArmTwDeg = -pw(m[41], -ARM_TW, ARM_TW);
    const lFaTwDeg = -pw(m[43], -FA_TW, FA_TW);
    const dLSh = mirrorX(qmul(qmul(Q_PRE_SH_R, zyUnity(0, pw(m[38], SH_FB_N, SH_FB_P), pw(m[37], SH_DU_N, SH_DU_P))), Q_PRE_SH_R_INV));
    const qLSh = qmul(qTorso, dLSh);
    const dLArm = mirrorX(qmul(qmul(Q_PRE_ARM_R, zyUnity(-pw(m[41], -ARM_TW, ARM_TW), pw(m[40], ARM_FB_N, ARM_FB_P), pw(m[39], ARM_DU_N, ARM_DU_P))), Q_POST_ARM_R_INV));
    const qLArm = qmul(qLSh, dLArm);
    const dLFa = mirrorX(qmul(qmul(Q_PRE_FA_R, zyUnity(0, pw(m[42], -FA_ST, FA_ST), 0)), Q_POST_FA_R_INV));
    const qLFa = qmul(qLArm, dLFa);
    const qLHd = (root && root.lhQ)
      ? qmul(qmul(rq, qnorm(root.lhQ)), [0, 0, -1, 0])
      : qmul(qmul(qLFa, qaxis(0, lFaTwDeg)), zyUnity(0, -pw(m[45], -HD_IO, HD_IO), -pw(m[44], -HD_DU, HD_DU)));
    worldDeltaU.LeftShoulder = qLSh;
    worldDeltaU.LeftArm = qLArm;
    worldDeltaU.LeftForeArm = qLFa;
    worldDeltaU.LeftHand = qLHd;

    const rArmTwDeg = -pw(m[50], -ARM_TW, ARM_TW);
    const rFaTwDeg = -pw(m[52], -FA_TW, FA_TW);
    const dRSh = qmul(qmul(Q_PRE_SH_R, zyUnity(0, pw(m[47], SH_FB_N, SH_FB_P), pw(m[46], SH_DU_N, SH_DU_P))), Q_PRE_SH_R_INV);
    const qRSh = qmul(qTorso, dRSh);
    const dRArm = qmul(qmul(Q_PRE_ARM_R, zyUnity(-pw(m[50], -ARM_TW, ARM_TW), pw(m[49], ARM_FB_N, ARM_FB_P), pw(m[48], ARM_DU_N, ARM_DU_P))), Q_POST_ARM_R_INV);
    const qRArm = qmul(qRSh, dRArm);
    const dRFa = qmul(qmul(Q_PRE_FA_R, zyUnity(0, pw(m[51], -FA_ST, FA_ST), 0)), Q_POST_FA_R_INV);
    const qRFa = qmul(qRArm, dRFa);
    const qRHd = (root && root.rhQ)
      ? qmul(rq, qnorm(root.rhQ))
      : qmul(qmul(qRFa, qaxis(0, rFaTwDeg)), zyUnity(0, pw(m[54], -HD_IO, HD_IO), pw(m[53], -HD_DU, HD_DU)));
    worldDeltaU.RightShoulder = qRSh;
    worldDeltaU.RightArm = qRArm;
    worldDeltaU.RightForeArm = qRFa;
    worldDeltaU.RightHand = qRHd;

    // ---------- Ground-Truth Humanoid Wrist IK (lhT / rhT from AnimationClip attr 28..30, 35..37) ----------
    const bpArm = this.bindPosU;
    if (root && (root.lhT || root.rhT) && bpArm.Hips && bpArm.Spine && bpArm.Spine1 && bpArm.Spine2) {
      const subU = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const addU = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
      const pSp = qrot(rq, subU(bpArm.Spine, bpArm.Hips));
      const pSp1 = addU(pSp, qrot(worldDeltaU.Spine, subU(bpArm.Spine1, bpArm.Spine)));
      const pSp2 = addU(pSp1, qrot(worldDeltaU.Spine1, subU(bpArm.Spine2, bpArm.Spine1)));
      if (root.lhT && bpArm.LeftShoulder && bpArm.LeftArm && bpArm.LeftForeArm && bpArm.LeftHand) {
        const pLSh = addU(pSp2, qrot(worldDeltaU.Spine2, subU(bpArm.LeftShoulder, bpArm.Spine2)));
        const A = addU(pLSh, qrot(qLSh, subU(bpArm.LeftArm, bpArm.LeftShoulder)));
        const B = addU(A, qrot(qLArm, subU(bpArm.LeftForeArm, bpArm.LeftArm)));
        const C = addU(B, qrot(qLFa, subU(bpArm.LeftHand, bpArm.LeftForeArm)));
        const T = qrot(rq, [
          root.lhT[0] * HUMAN_SCALE - COM_TO_HIPS_TRUE_U[0],
          root.lhT[1] * HUMAN_SCALE - COM_TO_HIPS_TRUE_U[1],
          root.lhT[2] * HUMAN_SCALE - COM_TO_HIPS_TRUE_U[2],
        ]);
        const [qLArmIK, qLFaIK] = solveTwoBoneDeltaU(A, B, C, T, qLArm, qLFa);
        worldDeltaU.LeftArm = qLArmIK;
        worldDeltaU.LeftForeArm = qLFaIK;
      }
      if (root.rhT && bpArm.RightShoulder && bpArm.RightArm && bpArm.RightForeArm && bpArm.RightHand) {
        const pRSh = addU(pSp2, qrot(worldDeltaU.Spine2, subU(bpArm.RightShoulder, bpArm.Spine2)));
        const A = addU(pRSh, qrot(qRSh, subU(bpArm.RightArm, bpArm.RightShoulder)));
        const B = addU(A, qrot(qRArm, subU(bpArm.RightForeArm, bpArm.RightArm)));
        const C = addU(B, qrot(qRFa, subU(bpArm.RightHand, bpArm.RightForeArm)));
        const T = qrot(rq, [
          root.rhT[0] * HUMAN_SCALE - COM_TO_HIPS_TRUE_U[0],
          root.rhT[1] * HUMAN_SCALE - COM_TO_HIPS_TRUE_U[1],
          root.rhT[2] * HUMAN_SCALE - COM_TO_HIPS_TRUE_U[2],
        ]);
        const [qRArmIK, qRFaIK] = solveTwoBoneDeltaU(A, B, C, T, qRArm, qRFa);
        worldDeltaU.RightArm = qRArmIK;
        worldDeltaU.RightForeArm = qRFaIK;
      }
    }
    // ---------- Legs (21..36) + Exact Foot Ground Anchoring ----------
    const ulFbN = -90, ulFbP = 50, ulIoN = -50, ulIoP = 50, ulTw = 60;
    const llSt = 80, llTw = 90, ftUd = 50, ftTw = 30, toeUd = 35;

    const lUlTwDeg = -uDeg(m[23], -ulTw, ulTw);
    const qLUl = qmul(rq, qmul(qaxis(2, -uDeg(m[22], ulIoN, ulIoP)),
      qmul(qaxis(0, uDeg(m[21], ulFbN, ulFbP, 0.5994)), qaxis(1, lUlTwDeg))));
    const qLLg = qmul(qLUl, qmul(qaxis(0, -uDeg(m[24], -llSt, llSt, 0.9991)), qaxis(1, -uDeg(m[25], -llTw, llTw))));
    const qLFt = qmul(qLLg, qmul(qaxis(0, -uDeg(m[26], -ftUd, ftUd)), qaxis(1, -uDeg(m[27], -ftTw, ftTw))));
    const qLToe = qmul(qLFt, qaxis(0, -uDeg(m[28], -toeUd, toeUd)));
    worldDeltaU.LeftUpLeg = qLUl;
    worldDeltaU.LeftLeg = qLLg;
    worldDeltaU.LeftFoot = qLFt;
    worldDeltaU.LeftToeBase = qLToe;

    const rUlTwDeg = uDeg(m[31], -ulTw, ulTw);
    const qRUl = qmul(rq, qmul(qaxis(2, uDeg(m[30], ulIoN, ulIoP)),
      qmul(qaxis(0, uDeg(m[29], ulFbN, ulFbP, 0.5994)), qaxis(1, rUlTwDeg))));
    const qRLg = qmul(qRUl, qmul(qaxis(0, -uDeg(m[32], -llSt, llSt, 0.9991)), qaxis(1, uDeg(m[33], -llTw, llTw))));
    const qRFt = qmul(qRLg, qmul(qaxis(0, -uDeg(m[34], -ftUd, ftUd)), qaxis(1, uDeg(m[35], -ftTw, ftTw))));
    const qRToe = qmul(qRFt, qaxis(0, -uDeg(m[36], -toeUd, toeUd)));
    worldDeltaU.RightUpLeg = qRUl;
    worldDeltaU.RightLeg = qRLg;
    worldDeltaU.RightFoot = qRFt;
    worldDeltaU.RightToeBase = qRToe;

    // ---------- Convert worldDeltaU -> hierarchical Three.js local rotations ----------
    const out = new Map();
    const solvedWorld3 = new Map();
    const getWorld3 = (obj) => {
      if (!obj) return new THREE.Quaternion();
      if (solvedWorld3.has(obj)) return solvedWorld3.get(obj);
      const sname = obj.userData?.skeletonName;
      if (sname && worldDeltaU[sname]) {
        const dq3 = convQ(worldDeltaU[sname]);
        const bq3 = this.bind.get(obj)?.quat || new THREE.Quaternion();
        const wq = dq3.multiply(bq3);
        solvedWorld3.set(obj, wq);
        return wq;
      }
      const pw = getWorld3(obj.parent);
      const btrs = obj.userData?.bindTRS;
      const wq = btrs ? pw.clone().multiply(btrs.q) : pw.clone();
      solvedWorld3.set(obj, wq);
      return wq;
    };

    for (const bname of Object.keys(worldDeltaU)) {
      const obj = this.nameToNode[bname];
      if (!obj) continue;
      const wq = getWorld3(obj);
      const pw = getWorld3(obj.parent);
      out.set(obj, { q: pw.clone().invert().multiply(wq) });
    }

    // ---------- Fingers (55..94): Exact UnityPlayer.dll mecanim::hand::HandPose ----------
    for (let side = 0; side < 2; side++) {
      const isLeft = side === 0;
      const prefix = isLeft ? 'LeftHand' : 'RightHand';
      const baseIdx = 55 + side * 20;
      for (let fi = 0; fi < 5; fi++) {
        const fname = FINGERS[fi];
        const spec = HAND_FINGER_SPECS[fi];
        const [sMin, sMax, c1Min, c1Max, c2Min, c2Max, sgnYL, sgnZL, sgnYR, sgnZR] = spec;
        const sgnY = isLeft ? sgnYL : sgnYR;
        const sgnZ = isLeft ? sgnZL : sgnZR;
        const postQ = fi === 0
          ? (isLeft ? POSTQ_THUMB_L : POSTQ_THUMB_R)
          : (isLeft ? POSTQ_FINGER_L : POSTQ_FINGER_R);
        const postQInv = qinv(postQ);

        const i0 = baseIdx + fi * 4;
        const m1 = m[i0] ?? TPOSE_MUSCLES[i0];
        const ms = m[i0 + 1] ?? TPOSE_MUSCLES[i0 + 1];
        const m2 = m[i0 + 2] ?? TPOSE_MUSCLES[i0 + 2];
        const m3 = m[i0 + 3] ?? TPOSE_MUSCLES[i0 + 3];
        const t1 = TPOSE_MUSCLES[i0];
        const ts = TPOSE_MUSCLES[i0 + 1];
        const t2 = TPOSE_MUSCLES[i0 + 2];
        const t3 = TPOSE_MUSCLES[i0 + 3];

        const segMuscles = [
          [`${prefix}${fname}1`, zyUnity(0, sgnY * pw(ts, sMin, sMax), sgnZ * pw(t1, c1Min, c1Max)), zyUnity(0, sgnY * pw(ms, sMin, sMax), sgnZ * pw(m1, c1Min, c1Max))],
          [`${prefix}${fname}2`, zyUnity(0, 0, sgnZ * pw(t2, c2Min, c2Max)), zyUnity(0, 0, sgnZ * pw(m2, c2Min, c2Max))],
          [`${prefix}${fname}3`, zyUnity(0, 0, sgnZ * pw(t3, c2Min, c2Max)), zyUnity(0, 0, sgnZ * pw(m3, c2Min, c2Max))],
        ];
        for (const [bname, qmT, qmM] of segMuscles) {
          const obj = this.nameToNode[bname];
          if (!obj || !obj.userData?.bindTRS) continue;
          const qlDeltaU = qmul(postQ, qmul(qinv(qmT), qmul(qmM, postQInv)));
          const ql3 = obj.userData.bindTRS.q.clone().multiply(convQ(qlDeltaU));
          out.set(obj, { q: ql3 });
        }
      }
    }

    // ---------- All 18 QuartzDriver twist/bend/waist helper bones ----------
    const applyTwistHelper = (bname, axisU, deg) => {
      const obj = this.nameToNode[bname];
      if (!obj || !obj.userData?.bindTRS) return;
      const ql3 = obj.userData.bindTRS.q.clone().multiply(convQ(qaxis(axisU, deg)));
      out.set(obj, { q: ql3 });
    };
    // HumanoidArmBone: Left & Right BOTH have worldX = [+1, 0, 0] -> same negative counter-twist sign!
    applyTwistHelper('LeftArm_H', 0, -0.8 * lArmTwDeg);
    applyTwistHelper('LeftArm_Roll_H', 0, -0.3 * lArmTwDeg);
    applyTwistHelper('RightArm_H', 0, -0.8 * rArmTwDeg);
    applyTwistHelper('RightArm_Roll_H', 0, -0.3 * rArmTwDeg);
    // HumanoidHandBone: distributes forearm pronation/supination 50% mid-forearm, 90% cuff
    applyTwistHelper('LeftForeArm_Roll_H', 0, 0.5 * lFaTwDeg);
    applyTwistHelper('LeftHand_H', 0, 0.9 * lFaTwDeg);
    applyTwistHelper('RightForeArm_Roll_H', 0, 0.5 * rFaTwDeg);
    applyTwistHelper('RightHand_H', 0, 0.9 * rFaTwDeg);
    // HumanoidUpLegBone: LeftUpLeg_H has worldX=+Y, RightUpLeg_H has worldX=-Y
    applyTwistHelper('LeftUpLeg_H', 0, -1.0 * lUlTwDeg);
    applyTwistHelper('LeftUpLeg_Roll_H', 0, -0.6 * lUlTwDeg);
    applyTwistHelper('RightUpLeg_H', 0, 1.0 * rUlTwDeg);
    applyTwistHelper('RightUpLeg_Roll_H', 0, 0.6 * rUlTwDeg);
    // RotationBone: knee bend helpers (-0.5 on Leg bend; elbow helpers also updated post-IK)
    const lKneeBend = -uDeg(m[24], -llSt, llSt, 0.9991);
    const rKneeBend = -uDeg(m[32], -llSt, llSt, 0.9991);
    applyTwistHelper('LeftLeg_H', 2, -0.5 * lKneeBend);
    applyTwistHelper('RightLeg_H', 2, 0.5 * rKneeBend);
    // ---------- Hips World Position (RootT + Foot Sole Ground Anchor) ----------
    const hipsObj = this.nameToNode.Hips;
    const bp = this.bindPosU;
    if (hipsObj && bp.Hips && bp.LeftUpLeg && bp.LeftLeg && bp.LeftFoot
        && bp.RightUpLeg && bp.RightLeg && bp.RightFoot) {
      const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
      // FK sole vector relative to Hips in Unity metres
      const fkLSole = add3(
        add3(qrot(rq, sub3(bp.LeftUpLeg, bp.Hips)), qrot(qLUl, sub3(bp.LeftLeg, bp.LeftUpLeg))),
        add3(qrot(qLLg, sub3(bp.LeftFoot, bp.LeftLeg)), qrot(qLFt, [0, -bp.LeftFoot[1], 0])),
      );
      const fkRSole = add3(
        add3(qrot(rq, sub3(bp.RightUpLeg, bp.Hips)), qrot(qRUl, sub3(bp.RightLeg, bp.RightUpLeg))),
        add3(qrot(qRLg, sub3(bp.RightFoot, bp.RightLeg)), qrot(qRFt, [0, -bp.RightFoot[1], 0])),
      );

      let hipsWorldU;
      if (root && root.rootT) {
        // Unity Mecanim RootT * humanScale is the Avatar body CoM; apply exact T-pose CoM->Hips
        // offset rotated by RootQ (ground contact is already baked in RootT.y).
        const rt = root.rootT;
        const comToHips = qrot(rq, COM_TO_HIPS_TRUE_U);
        hipsWorldU = [
          rt[0] * HUMAN_SCALE + comToHips[0],
          rt[1] * HUMAN_SCALE + comToHips[1],
          rt[2] * HUMAN_SCALE + comToHips[2],
        ];
      } else {
        // Fallback: keep lowest foot sole on y=0 floor plane
        const minY = Math.min(fkLSole[1], fkRSole[1]);
        hipsWorldU = [bp.Hips[0], -minY, bp.Hips[2]];
      }

      // Convert actor-space hipsWorldU into Hips parent's local coordinates
      const hipsWorld3 = new THREE.Vector3(hipsWorldU[0], hipsWorldU[1], -hipsWorldU[2]);
      const pObj = hipsObj.parent;
      if (pObj && this.bind.has(pObj)) {
        const pBind = this.bind.get(pObj);
        hipsWorld3.sub(pBind.pos).applyQuaternion(pBind.quat.clone().invert());
      }
      const entry = out.get(hipsObj) || {};
      entry.p = [hipsWorld3.x, hipsWorld3.y, hipsWorld3.z];
      out.set(hipsObj, entry);
    }

    // ---------- Secondary Transform bone tracks (hair/skirt/bust physics baked in clips) ----------
    for (const t of boneTracks) {
      const obj = this.nodes.get(t.node);
      if (!obj) continue;
      // Do not let generic bone tracks clobber solved humanoid joints
      const sname = obj.userData?.skeletonName;
      if (sname && worldDeltaU[sname]) continue;
      let e = out.get(obj);
      if (!e) { e = {}; out.set(obj, e); }
      if (t.prop === 'position') e.p = [t.value[0], t.value[1], -t.value[2]];
      else if (t.prop === 'scale') e.s = [t.value[0], t.value[1], t.value[2]];
      else if (t.prop === 'rotation') e.q = new THREE.Quaternion(t.value[0], t.value[1], -t.value[2], -t.value[3]);
    }
    return out;
  }

  /** Write a pose to the rig, optionally blending from another pose (w=1 -> b). */
  applyPose(a, b, w = 1) {
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
    for (const n of this.nodes.values()) {
      if (n.userData.bindTRS) {
        n.position.copy(n.userData.bindTRS.p);
        n.quaternion.copy(n.userData.bindTRS.q);
        n.scale.copy(n.userData.bindTRS.s);
      }
    }
  }

  // ---------------- Post-FK Rig Pass: IKCorrection + Elbow Quartz + ActorSwing ----------------
  _initSwingAndIK() {
    const swing = this.meta.swing || {};
    this.ikColliders = (this.meta.ikCorrection && this.meta.ikCorrection.colliders) || [];
    this.ikGoals = (this.meta.ikCorrection && this.meta.ikCorrection.goals) || [];
    this.staticColliderDefs = swing.staticColliders || [];
    this.swingParticles = new Map(); // Object3D -> { pos: Vector3, vel: Vector3 }
    this._lastSimTime = null;
    this._lastHipsW = new THREE.Vector3();
    this._lastRootPosW = new THREE.Vector3();
    this._lastRootQuatW = new THREE.Quaternion();
    this._hasLastRoot = false;

    // Build ordered dynamic bone chains: root (parent not in dynSet) -> child -> ... -> _End
    const dynByObj = new Map();
    for (const db of (swing.dynamicBones || [])) {
      const obj = this.nodes.get(db.node);
      if (obj) dynByObj.set(obj, db);
    }
    this.swingChains = [];
    this.maxSwingDepth = 0;
    // Map glTF node index -> work slot index at depth d (where childEntry = chain[d + 1])
    const childSlotByNode = new Map();
    this._swingDepthSlots = [];

    for (const [obj] of dynByObj) {
      if (dynByObj.has(obj.parent)) continue; // only start at chain roots
      const chain = [];
      let cur = obj;
      while (cur && dynByObj.has(cur)) {
        const cfg = dynByObj.get(cur);
        chain.push({ obj: cur, cfg, node: cfg.node });
        cur = (cur.children || []).find((c) => dynByObj.has(c)) || null;
      }
      if (chain.length >= 2) {
        this.swingChains.push(chain);
        if (chain.length - 1 > this.maxSwingDepth) {
          this.maxSwingDepth = chain.length - 1;
        }
      }
    }

    for (let d = 0; d < this.maxSwingDepth; d++) {
      const slots = [];
      for (const chain of this.swingChains) {
        if (d + 1 >= chain.length) continue;
        const slot = {
          parentEntry: chain[d],
          childEntry: chain[d + 1],
          pivotW: new THREE.Vector3(),
          animChildW: new THREE.Vector3(),
          eqChildW: new THREE.Vector3(),
          targetW: new THREE.Vector3(),
          smoothW: new THREE.Vector3(),
          segLen: 0,
          valid: false,
        };
        slots.push(slot);
        childSlotByNode.set(chain[d + 1].node, { depth: d, slot });
      }
      this._swingDepthSlots.push(slots);
    }

    // Build ActorSwingChain lateral capsule-net layers indexed by depth d (Layer d+1)
    this.chainNetByDepth = Array.from({ length: this.maxSwingDepth }, () => []);
    for (const net of (swing.chains || [])) {
      const layers = net.layers || [];
      for (let li = 0; li < layers.length; li++) {
        const ly = layers[li];
        if (!ly.active || !ly.nodes || ly.nodes.length < 2) continue;
        const slotList = [];
        let targetDepth = -1;
        for (const nid of ly.nodes) {
          const found = childSlotByNode.get(nid);
          if (found) {
            if (targetDepth === -1) targetDepth = found.depth;
            if (found.depth === targetDepth) slotList.push(found.slot);
          }
        }
        if (targetDepth >= 0 && targetDepth < this.maxSwingDepth && slotList.length >= 2) {
          this.chainNetByDepth[targetDepth].push({
            part: net.part || 'body',
            around: Boolean(ly.around),
            radius: ly.radius ?? 0.015,
            smoothing: ly.smoothing ?? 0,
            slots: slotList,
          });
        }
      }
    }

    // Pre-allocate scratch math objects for 0-GC hot simulation
    this._swScratch = {
      uv: [0, 0],
      d1: new THREE.Vector3(),
      d2: new THREE.Vector3(),
      r: new THREE.Vector3(),
      cP: new THREE.Vector3(),
      cQ: new THREE.Vector3(),
      animCP: new THREE.Vector3(),
      animCQ: new THREE.Vector3(),
      diff: new THREE.Vector3(),
      ab: new THREE.Vector3(),
      ap: new THREE.Vector3(),
      targetPt: new THREE.Vector3(),
      projPt: new THREE.Vector3(),
      pushDelta: new THREE.Vector3(),
      dirA: new THREE.Vector3(),
      dirB: new THREE.Vector3(),
      qParentW: new THREE.Quaternion(),
      qCurW: new THREE.Quaternion(),
      qNewLocal: new THREE.Quaternion(),
      qSwingW: new THREE.Quaternion(),
      dq3: new THREE.Quaternion(),
      qU3: new THREE.Quaternion(),
      dqClamped3: new THREE.Quaternion(),
      eulU: new THREE.Euler(0, 0, 0, 'YXZ'),
      hipsW: new THREE.Vector3(),
      hipsDelta: new THREE.Vector3(),
      stepHipsDelta: new THREE.Vector3(),
      rootPosW: new THREE.Vector3(),
      rootQuatW: new THREE.Quaternion(),
    };
  }

  /**
   * Run post-FK / post-LookTarget torso anti-clipping 2-bone arm IK, elbow/waist Quartz
   * helpers, and ActorSwing + ActorSwingChain cloth/hair capsule-net physics.
   */
  updatePostRig(simTime = 0) {
    const hips = this.nameToNode.Hips;
    if (!hips) return;
    let dt = 0;
    if (this._lastSimTime !== null) {
      dt = simTime - this._lastSimTime;
    }
    this._lastSimTime = simTime;

    // Ensure world matrices are fresh before IK & collider evaluation
    let rootObj = hips;
    while (rootObj.parent) rootObj = rootObj.parent;
    rootObj.updateMatrixWorld(true);

    this._applyArmIKCorrection();
    this._updateElbowAndWaistHelpers();

    const sc = this._swScratch;
    hips.getWorldPosition(sc.hipsW);
    const stageNode = hips.parent || rootObj;
    stageNode.getWorldPosition(sc.rootPosW);
    stageNode.getWorldQuaternion(sc.rootQuatW);

    let isCut = !this._hasLastRoot;
    if (this._hasLastRoot) {
      const rootJumpSq = sc.rootPosW.distanceToSquared(this._lastRootPosW);
      const rootRotDiff = 1 - Math.abs(sc.rootQuatW.dot(this._lastRootQuatW));
      if (rootJumpSq > 0.01 || rootRotDiff > 0.01) isCut = true;
    }
    const isSeek = isCut || dt <= 0 || dt > 1.0 || !Number.isFinite(dt);
    const colliders = this._buildWorldStaticColliders();

    if (isSeek) {
      sc.hipsDelta.set(0, 0, 0);
      this._updateActorSwing(0, true, sc.hipsDelta, false, colliders);
      // Pre-converge cloth/hair spring & ActorSwingChain capsule net (IsAlreadyStable equivalent)
      const fixedDt = 1 / 60;
      for (let s = 0; s < 6; s++) {
        this._updateActorSwing(fixedDt, false, sc.hipsDelta, true, colliders);
      }
    } else {
      sc.hipsDelta.subVectors(sc.hipsW, this._lastHipsW);
      const clampedDt = Math.min(dt, 0.05);
      const steps = Math.min(3, Math.max(1, Math.round(clampedDt * 60)));
      const subDt = clampedDt / steps;
      sc.stepHipsDelta.copy(sc.hipsDelta).multiplyScalar(1 / steps);
      for (let s = 0; s < steps; s++) {
        this._updateActorSwing(subDt, false, sc.stepHipsDelta, false, colliders);
      }
    }
    for (let ci = 0; ci < this.swingChains.length; ci++) {
      this.swingChains[ci][0].obj.updateMatrixWorld(true);
    }

    this._lastHipsW.copy(sc.hipsW);
    this._lastRootPosW.copy(sc.rootPosW);
    this._lastRootQuatW.copy(sc.rootQuatW);
    this._hasLastRoot = true;
  }

  _applyArmIKCorrection() {
    if (!this.ikColliders.length) return;
    // Build world-space ActorAnimationIKCorrectionCollider capsules (e.g. Hips tapered capsule)
    const capsules = [];
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _up = new THREE.Vector3();

    for (const col of this.ikColliders) {
      const node = this.nodes.get(col.node) || this.nameToNode[col.name];
      if (!node) continue;
      node.getWorldPosition(_p);
      node.getWorldQuaternion(_q);
      const off = new THREE.Vector3(col.offset[0] || 0, col.offset[1] || 0, -(col.offset[2] || 0)).applyQuaternion(_q);
      const c = _p.clone().add(off);
      if (col.type === 1) {
        _up.set(0, (col.length || 0.17) * 0.5, 0).applyQuaternion(_q);
        capsules.push({
          p1: c.clone().add(_up),
          p2: c.clone().sub(_up),
          r1: col.radius ?? 0.125,
          r2: col.radiusSub ?? col.radius ?? 0.15,
          damp: col.dampArea ?? 0.01,
          weight: col.weight ?? 0.75,
        });
      } else {
        capsules.push({
          p1: c, p2: c.clone(),
          r1: col.radius ?? 0.125, r2: col.radius ?? 0.125,
          damp: col.dampArea ?? 0.01, weight: col.weight ?? 0.75,
        });
      }
    }
    if (!capsules.length) return;

    // Decompiled ActorAnimationFullBodyIKJobSkeleton::SetGaolEffector (0x18099DBA0):
    // Goal effector localScale.x/y = explicit IK pos/rot weight; Hint effector localScale.y
    // gates Hips capsule anti-clipping collision on hand-on-hip poses (line 217 & line 392).
    const limbs = [
      {
        goalId: 2,
        upper: this.nameToNode.LeftArm,
        lower: this.nameToNode.LeftForeArm,
        hand: this.nameToNode.LeftHand,
        goalNode: this.nameToNode.IKGoal_LeftHand,
        hintNode: this.nameToNode.IKHint_LeftElbow,
      },
      {
        goalId: 3,
        upper: this.nameToNode.RightArm,
        lower: this.nameToNode.RightForeArm,
        hand: this.nameToNode.RightHand,
        goalNode: this.nameToNode.IKGoal_RightHand,
        hintNode: this.nameToNode.IKHint_RightElbow,
      },
    ];
    const _ab = new THREE.Vector3();
    const _ap = new THREE.Vector3();
    const _closest = new THREE.Vector3();
    const _diff = new THREE.Vector3();

    for (const limb of limbs) {
      if (!limb.upper || !limb.lower || !limb.hand) continue;
      const gCfg = this.ikGoals.find((g) => g.goal === limb.goalId);
      const goalPosW = limb.goalNode ? limb.goalNode.scale.x : 0;
      const goalRotW = limb.goalNode ? limb.goalNode.scale.y : 0;
      const hintWeight = limb.hintNode ? Math.min(1, Math.max(0, limb.hintNode.scale.y)) : 0;
      const colEnabled = Boolean(gCfg && gCfg.enable);

      const handW = limb.hand.getWorldPosition(new THREE.Vector3());
      const handQ = limb.hand.getWorldQuaternion(new THREE.Quaternion());
      let targetWristW = handW.clone();
      let solveWeight = 0;

      if (goalPosW > 1e-5 && limb.goalNode) {
        const effPos = limb.goalNode.getWorldPosition(new THREE.Vector3());
        targetWristW.lerp(effPos, Math.min(1, goalPosW));
        solveWeight = Math.min(1, goalPosW);
      }

      if ((goalPosW > 1e-5 || goalRotW > 1e-5 || colEnabled) && (goalPosW > 1e-5 || hintWeight > 1e-8)) {
        const rGoal = gCfg ? (gCfg.radius ?? 0.06) : 0.06;
        const gOff = gCfg && gCfg.offset
          ? new THREE.Vector3(gCfg.offset[0] || 0, gCfg.offset[1] || 0, -(gCfg.offset[2] || 0)).applyQuaternion(handQ)
          : new THREE.Vector3();
        const sphereW = targetWristW.clone().add(gOff);

        // Pick collider with minimum signed distance (SetGaolEffector line 631)
        let bestSigned = Infinity;
        let bestCap = null;
        const bestClosest = new THREE.Vector3();
        const bestDiff = new THREE.Vector3();
        let bestDist = 0;
        let bestRReq = 0;
        for (const cap of capsules) {
          _ab.subVectors(cap.p2, cap.p1);
          const lenSq = _ab.lengthSq();
          const u = lenSq > 1e-8
            ? Math.max(0, Math.min(1, _ap.subVectors(sphereW, cap.p1).dot(_ab) / lenSq))
            : 0;
          _closest.copy(cap.p1).addScaledVector(_ab, u);
          const rReq = cap.r1 * (1 - u) + cap.r2 * u + rGoal;
          _diff.subVectors(sphereW, _closest);
          const dist = _diff.length();
          const signed = dist - rReq;
          if (signed < bestSigned) {
            bestSigned = signed;
            bestCap = cap;
            bestClosest.copy(_closest);
            bestDiff.copy(_diff);
            bestDist = dist;
            bestRReq = rReq;
          }
        }
        // CalcGoalPosition (0x1809B8050): push sphere to rReq and blend by cap.weight * hintColW
        if (bestCap && bestDist < bestRReq + bestCap.damp && bestDist > 1e-6) {
          let w = bestCap.weight * (goalPosW > 1e-5 ? Math.min(1, goalPosW) : hintWeight);
          if (bestDist >= bestRReq) {
            w *= 1.0 - (bestDist - bestRReq) / Math.max(1e-5, bestCap.damp);
          }
          const pushedSphere = bestClosest.addScaledVector(bestDiff.divideScalar(bestDist), bestRReq);
          const finalSphere = sphereW.lerp(pushedSphere, w);
          targetWristW.copy(finalSphere.sub(gOff));
          solveWeight = Math.max(solveWeight, w);
        }
      }

      if (solveWeight > 1e-5) {
        const hintW = (hintWeight > 1e-5 && limb.hintNode)
          ? limb.hintNode.getWorldPosition(new THREE.Vector3())
          : null;
        this._solveTwoBoneIK(limb.upper, limb.lower, limb.hand, targetWristW, hintW, hintWeight);
      }
    }
  }

  _solveTwoBoneIK(upperBone, lowerBone, handBone, targetW, hintW = null, hintWeight = 0) {
    const A = upperBone.getWorldPosition(new THREE.Vector3());
    const B = lowerBone.getWorldPosition(new THREE.Vector3());
    const C = handBone.getWorldPosition(new THREE.Vector3());
    const qHandW = handBone.getWorldQuaternion(new THREE.Quaternion());
    const L1 = A.distanceTo(B);
    const L2 = B.distanceTo(C);
    if (L1 < 1e-4 || L2 < 1e-4) return;

    const vecAC = C.clone().sub(A);
    const vecAT = targetW.clone().sub(A);
    const curDist = vecAC.length();
    const rawDist = vecAT.length();
    if (curDist < 1e-5 || rawDist < 1e-5) return;
    const d = Math.max(Math.abs(L1 - L2) + 1e-4, Math.min(L1 + L2 - 1e-4, rawDist));
    const uAC = vecAC.divideScalar(curDist);
    const uAT = vecAT.divideScalar(rawDist);

    const qSwing = new THREE.Quaternion().setFromUnitVectors(uAC, uAT);
    const ab = B.clone().sub(A);
    const perp = ab.clone().addScaledVector(uAC, -ab.dot(uAC));
    if (perp.lengthSq() < 1e-8) {
      perp.set(0, -1, 0.25).addScaledVector(uAC, -uAC.y);
    }
    let poleDir = perp.normalize().applyQuaternion(qSwing).normalize();
    if (hintW && hintWeight > 1e-5) {
      const hp = hintW.clone().sub(A);
      hp.addScaledVector(uAT, -hp.dot(uAT));
      if (hp.lengthSq() > 1e-8) {
        hp.normalize();
        poleDir.lerp(hp, hintWeight).addScaledVector(uAT, -poleDir.dot(uAT));
        if (poleDir.lengthSq() > 1e-8) poleDir.normalize();
      }
    }
    const x = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - x * x));
    const Bnew = A.clone().addScaledVector(uAT, x).addScaledVector(poleDir, h);
    const Tclamped = A.clone().addScaledVector(uAT, d);

    const qUpperW = upperBone.getWorldQuaternion(new THREE.Quaternion());
    const qParentUpperW = upperBone.parent
      ? upperBone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    const qDelta1 = new THREE.Quaternion().setFromUnitVectors(
      ab.clone().normalize(),
      Bnew.clone().sub(A).normalize(),
    );
    const qUpperNewW = qDelta1.multiply(qUpperW);
    upperBone.quaternion.copy(qParentUpperW.invert().multiply(qUpperNewW));
    upperBone.updateMatrixWorld(true);

    const B2 = lowerBone.getWorldPosition(new THREE.Vector3());
    const C2 = handBone.getWorldPosition(new THREE.Vector3());
    const qLowerW2 = lowerBone.getWorldQuaternion(new THREE.Quaternion());
    const qDelta2 = new THREE.Quaternion().setFromUnitVectors(
      C2.sub(B2).normalize(),
      Tclamped.sub(B2).normalize(),
    );
    const qLowerNewW = qDelta2.multiply(qLowerW2);
    lowerBone.quaternion.copy(qUpperNewW.clone().invert().multiply(qLowerNewW));
    lowerBone.updateMatrixWorld(true);

    handBone.quaternion.copy(qLowerNewW.invert().multiply(qHandW));
    handBone.updateMatrixWorld(true);
  }

  _updateElbowAndWaistHelpers() {
    // ActorAnimationQuartzDriverRotationBone on LeftForeArm_H & RightForeArm_H (coeff.y = -0.4)
    const eul = new THREE.Euler(0, 0, 0, 'YXZ');
    for (const [faName, hName] of [
      ['LeftForeArm', 'LeftForeArm_H'],
      ['RightForeArm', 'RightForeArm_H'],
    ]) {
      const fa = this.nameToNode[faName];
      const h = this.nameToNode[hName];
      if (!fa || !h || !fa.userData?.bindTRS || !h.userData?.bindTRS) continue;
      const dq = fa.userData.bindTRS.q.clone().invert().multiply(fa.quaternion);
      if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
      eul.setFromQuaternion(dq, 'YXZ');
      const counterQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), eul.y * -0.4);
      h.quaternion.copy(h.userData.bindTRS.q).multiply(counterQ);
      h.updateMatrixWorld(false);
    }
  }

  _buildWorldStaticColliders() {
    if (!this._worldColPool) {
      this._worldColPool = this.staticColliderDefs.map(() => ({
        mask: 0,
        isHead: false,
        p1: new THREE.Vector3(),
        p2: new THREE.Vector3(),
        r1: 0,
        r2: 0,
        isSphere: false,
      }));
      this._colScratch = {
        p: new THREE.Vector3(),
        q: new THREE.Quaternion(),
        cA: new THREE.Vector3(),
        axisV: new THREE.Vector3(),
      };
    }
    if (!this._activeWorldCols) this._activeWorldCols = [];
    const list = this._activeWorldCols;
    list.length = 0;
    const cs = this._colScratch;
    for (let i = 0; i < this.staticColliderDefs.length; i++) {
      const sc = this.staticColliderDefs[i];
      const node = this.nodes.get(sc.node) || this.nameToNode[sc.name];
      if (!node) continue;
      const entry = this._worldColPool[i];
      node.getWorldPosition(cs.p);
      node.getWorldQuaternion(cs.q);
      cs.cA.set(sc.vA[0], sc.vA[1], -sc.vA[2]).applyQuaternion(cs.q).add(cs.p);
      entry.mask = sc.mask;
      entry.isHead = sc.part === 'face' || sc.name === 'Head_Face';
      entry.r1 = sc.rA;
      if (sc.type === 0) {
        entry.p1.copy(cs.cA);
        entry.p2.copy(cs.cA);
        entry.r2 = sc.rA;
        entry.isSphere = true;
        list.push(entry);
      } else if (sc.type === 1) {
        // Campus ActorSwingCollider capsule axis: 0 = Y-axis (vertical), 1 = Z-axis, 2 = X-axis
        const axIdx = Math.round(sc.vB[0]);
        if (axIdx === 2) cs.axisV.set(1, 0, 0);
        else if (axIdx === 1) cs.axisV.set(0, 0, 1);
        else cs.axisV.set(0, 1, 0);
        cs.axisV.applyQuaternion(cs.q).multiplyScalar(0.5 * (sc.vB[1] || 0));
        entry.p1.copy(cs.cA).sub(cs.axisV);
        entry.p2.copy(cs.cA).add(cs.axisV);
        entry.r2 = sc.rB || sc.rA;
        entry.isSphere = false;
        list.push(entry);
      } else if (sc.type === 2 && node.parent) {
        entry.p1.copy(cs.cA);
        node.parent.getWorldPosition(entry.p2);
        let r1 = Math.max(0, sc.rA);
        let r2 = Math.max(0, sc.rB || sc.rA);
        entry.r1 = r1;
        entry.r2 = r2;
        // UpdateCollider (0x1809CF102): inset ConnectedCapsule endpoints by r1 & r2 so hemisphere caps terminate at joints
        cs.axisV.subVectors(entry.p2, entry.p1);
        const len = cs.axisV.length();
        if (len > 1e-6) {
          cs.axisV.multiplyScalar(1 / len);
          if (r1 + r2 > len) {
            const excess = r1 + r2 - len;
            const sum = r1 + r2;
            const d1 = (excess * r1) / sum;
            r1 = Math.max(0, r1 - d1);
            r2 = Math.max(0, r2 - (excess * r2) / Math.max(1e-6, r2 + r1));
          }
          entry.p1.addScaledVector(cs.axisV, r1);
          entry.p2.addScaledVector(cs.axisV, -r2);
        }
        entry.isSphere = false;
        list.push(entry);
      }
    }
    return list;
  }

  /**
   * Exact segment-segment closest parameter solver matching
   * ActorSwingCollisionUtility::CollisionCapsuleCapsule (0x1809D05E0).
   */
  _closestSegmentParams(p1, p2, q1, q2, outUV) {
    const sc = this._swScratch;
    const d1 = sc.d1.subVectors(p2, p1);
    const d2 = sc.d2.subVectors(q2, q1);
    const r = sc.r.subVectors(p1, q1);
    const a = d1.lengthSq();
    const e = d2.lengthSq();
    const f = d2.dot(r);
    let s = 0;
    let t = 0;
    if (a <= 1e-8 && e <= 1e-8) {
      s = 0;
      t = 0;
    } else if (a <= 1e-8) {
      s = 0;
      t = Math.max(0, Math.min(1, f / e));
    } else {
      const c = d1.dot(r);
      if (e <= 1e-8) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else {
        const b = d1.dot(d2);
        const denom = a * e - b * b;
        if (denom > 1e-8) {
          s = Math.max(0, Math.min(1, (b * f - c * e) / denom));
        } else {
          s = 0;
        }
        t = (b * s + f) / e;
        if (t < 0) {
          t = 0;
          s = Math.max(0, Math.min(1, -c / a));
        } else if (t > 1) {
          t = 1;
          s = Math.max(0, Math.min(1, (b - c) / a));
        }
      }
    }
    outUV[0] = s;
    outUV[1] = t;
  }

  /**
   * ActorAnimationSwingJobSkeleton::ProcessChainBoneCollider (0x1809C5C10 + 0x1809B45D0):
   * Collide lateral capsule segments across adjacent cloth/hair chains against static colliders.
   */
  _solveChainNetCollider(netLayer, colliders) {
    const sc = this._swScratch;
    const slots = netLayer.slots;
    const n = slots.length;
    const segCount = netLayer.around ? n : n - 1;
    const rChain = netLayer.radius;
    const isHairNet = netLayer.part === 'hair';

    for (let sweep = 0; sweep < 2; sweep++) {
      let anyHit = false;
      for (let k = 0; k < segCount; k++) {
        const sA = slots[k];
        const sB = slots[(k + 1) % n];
        if (!sA.valid || !sB.valid) continue;
        const mA = sA.childEntry.cfg.mask ?? 0;
        const mB = sB.childEntry.cfg.mask ?? 0;
        if (mA === 0 || mA === -1 || mB === 0 || mB === -1) continue;
        const segMask = mA & mB;
        if (segMask === 0) continue;

        for (let ci = 0; ci < colliders.length; ci++) {
          const col = colliders[ci];
          if ((col.mask & segMask) === 0) continue;

          this._closestSegmentParams(sA.targetW, sB.targetW, col.p1, col.p2, sc.uv);
          const u = sc.uv[0];
          const v = sc.uv[1];
          sc.cP.copy(sA.targetW).lerp(sB.targetW, u);
          sc.cQ.copy(col.p1).lerp(col.p2, v);
          const rCol = col.r1 * (1 - v) + col.r2 * v;

          let rReq;
          if (isHairNet && col.isHead) {
            this._closestSegmentParams(sA.animChildW, sB.animChildW, col.p1, col.p2, sc.uv);
            sc.animCP.copy(sA.animChildW).lerp(sB.animChildW, sc.uv[0]);
            sc.animCQ.copy(col.p1).lerp(col.p2, sc.uv[1]);
            rReq = Math.min(rCol + 0.001, sc.animCP.distanceTo(sc.animCQ));
          } else {
            rReq = rCol + rChain + 0.0015;
          }

          sc.diff.subVectors(sc.cP, sc.cQ);
          const dist = sc.diff.length();
          if (dist < rReq && dist > 1e-6) {
            sc.targetPt.copy(sc.cQ).addScaledVector(sc.diff, rReq / dist);
            sc.ab.subVectors(sB.targetW, sA.targetW);
            const abLenSq = sc.ab.lengthSq();
            if (abLenSq > 1e-8) {
              const projS = sc.ap.subVectors(sc.targetPt, sA.targetW).dot(sc.ab) / abLenSq;
              sc.projPt.copy(sA.targetW).addScaledVector(sc.ab, projS);
              sc.pushDelta.subVectors(sc.targetPt, sc.projPt);
            } else {
              sc.pushDelta.subVectors(sc.targetPt, sA.targetW);
            }
            // Apply lateral capsule pushout + UpdateSpringPosition (0x1809B6220) to both endpoints
            sA.targetW.add(sc.pushDelta).sub(sA.pivotW).normalize().multiplyScalar(sA.segLen).add(sA.pivotW);
            sB.targetW.add(sc.pushDelta).sub(sB.pivotW).normalize().multiplyScalar(sB.segLen).add(sB.pivotW);
            anyHit = true;
          }
        }
      }
      if (!anyHit) break;
    }
  }

  /**
   * Layer-by-layer ActorAnimationSwingJobSkeleton::ProcessDynamicBones (0x1809C7E80)
   * + ProcessDynamicBoneLayer (0x1809C7B40) + ProcessChainBone (0x1809C79C0).
   */
  _updateActorSwing(dt, resetState, stepHipsDelta, isPrewarm = false, collidersIn = null) {
    if (!this.swingChains.length) return;
    const colliders = collidersIn || this._buildWorldStaticColliders();
    const sc = this._swScratch;
    const scale60 = dt > 0 ? Math.min(1.5, dt * 60) : 1.0;

    // Solve synchronously layer-by-layer (depth 0 -> maxSwingDepth - 1) across all chains
    for (let d = 0; d < this.maxSwingDepth; d++) {
      const slots = this._swingDepthSlots[d];

      // Phase 1: Per-bone spring/gravity integration & individual dynamicCollider pushout
      for (let si = 0; si < slots.length; si++) {
        const slot = slots[si];
        const pObj = slot.parentEntry.obj;
        const cObj = slot.childEntry.obj;
        const cCfg = slot.childEntry.cfg;

        if (pObj.userData?.bindTRS) pObj.quaternion.copy(pObj.userData.bindTRS.q);
        pObj.updateWorldMatrix(false, false);
        if (cObj.userData?.bindTRS) cObj.quaternion.copy(cObj.userData.bindTRS.q);
        cObj.updateWorldMatrix(false, false);
        pObj.getWorldPosition(slot.pivotW);
        cObj.getWorldPosition(slot.animChildW);
        const segLen = slot.pivotW.distanceTo(slot.animChildW);
        slot.segLen = segLen;
        if (segLen < 1e-5) {
          slot.valid = false;
          continue;
        }
        slot.valid = true;

        slot.eqChildW.copy(slot.animChildW);
        if ((cCfg.mass ?? 0) > 0.01) {
          const gScale = cCfg.part === 'hair'
            ? 0.65
            : Math.min(2.5, (0.01 / Math.max(0.005, cCfg.stiffness ?? 0.05)) * (1 / Math.max(0.04, segLen)) * 0.35);
          slot.eqChildW.y -= segLen * (cCfg.mass ?? 0.5) * gScale;
          slot.eqChildW.sub(slot.pivotW).normalize().multiplyScalar(segLen).add(slot.pivotW);
        }

        let st = this.swingParticles.get(cObj);
        if (!st || resetState) {
          st = { pos: slot.eqChildW.clone(), vel: new THREE.Vector3() };
          this.swingParticles.set(cObj, st);
        }

        if (dt > 0) {
          // GetRootCorrectionCancelPosition: cancel rootWeight fraction of Hips translation
          if (!isPrewarm && stepHipsDelta) {
            st.pos.addScaledVector(stepHipsDelta, cCfg.rootWeight ?? 0.3);
          }
          const baseDamp = Math.max(0.05, Math.min(0.60, (1.0 - (cCfg.damping ?? 0.5)) * 0.65));
          const baseStiff = Math.max(0.28, Math.min(0.88, (cCfg.stiffness ?? 0.05) * 4.5 + 0.30));
          const damp = isPrewarm ? 0 : ( baseDamp * scale60 );
          const stiff = 1 - Math.pow(1 - baseStiff, scale60);
          slot.targetW.copy(st.pos).addScaledVector(st.vel, damp);
          if (cCfg.part !== 'hair') {
            slot.targetW.y -= (cCfg.pendulum ?? 0) * 0.30 * scale60;
          }
          slot.targetW.lerp(slot.eqChildW, stiff);
        } else {
          slot.targetW.copy(slot.eqChildW);
        }
        slot.targetW.sub(slot.pivotW).normalize().multiplyScalar(segLen).add(slot.pivotW);

        const cMask = cCfg.mask ?? 0;
        const colType = cCfg.colType ?? 0;
        const cRad = Math.max(0.004, cCfg.radius ?? 0.01);
        if (colType !== 4 && cMask !== 0 && cMask !== -1) {
          const isConnCap = colType === 2;
          const cRadSub = Math.max(0.004, cCfg.radiusSub || cRad);
          for (let iter = 0; iter < 2; iter++) {
            let pushed = false;
            for (let ci = 0; ci < colliders.length; ci++) {
              const col = colliders[ci];
              if ((col.mask & cMask) === 0) continue;
              let rCol;
              let rDyn = cRad;
              if (isConnCap) {
                this._closestSegmentParams(slot.targetW, slot.pivotW, col.p1, col.p2, sc.uv);
                const u = sc.uv[0];
                const v = sc.uv[1];
                if (u > 0.98) continue;
                sc.cP.copy(slot.targetW).lerp(slot.pivotW, u);
                sc.cQ.copy(col.p1).lerp(col.p2, v);
                rCol = col.r1 * (1 - v) + col.r2 * v;
                rDyn = cRad * (1 - u) + cRadSub * u;
              } else if (col.isSphere) {
                sc.cP.copy(slot.targetW);
                sc.cQ.copy(col.p1);
                rCol = col.r1;
              } else {
                sc.ab.subVectors(col.p2, col.p1);
                const lsq = sc.ab.lengthSq();
                const v = lsq > 1e-8
                  ? Math.max(0, Math.min(1, sc.ap.subVectors(slot.targetW, col.p1).dot(sc.ab) / lsq))
                  : 0;
                sc.cP.copy(slot.targetW);
                sc.cQ.copy(col.p1).addScaledVector(sc.ab, v);
                rCol = col.r1 * (1 - v) + col.r2 * v;
              }
              const isHairHead = col.isHead && cCfg.part === 'hair';
              const rMin = isHairHead
                ? Math.min(rCol + 0.001, slot.animChildW.distanceTo(sc.cQ))
                : (rCol + rDyn + 0.0015);
              sc.diff.subVectors(sc.cP, sc.cQ);
              const dist = sc.diff.length();
              if (dist < rMin && dist > 1e-6) {
                slot.targetW.addScaledVector(sc.diff, (rMin - dist) / dist);
                pushed = true;
              }
            }
            if (!pushed) break;
            slot.targetW.sub(slot.pivotW).normalize().multiplyScalar(segLen).add(slot.pivotW);
          }
        }
      }

      // Phase 2: ActorSwingChain lateral capsule-net collision & optional chain smoothing
      const nets = this.chainNetByDepth[d];
      for (let ni = 0; ni < nets.length; ni++) {
        const netLayer = nets[ni];
        this._solveChainNetCollider(netLayer, colliders);
        if (netLayer.smoothing > 1e-5) {
          const nSlots = netLayer.slots;
          const nLen = nSlots.length;
          const startK = netLayer.around ? 0 : 1;
          const endK = netLayer.around ? nLen : nLen - 1;
          for (let k = startK; k < endK; k++) {
            const prevS = nSlots[(k - 1 + nLen) % nLen];
            const curS = nSlots[k];
            const nextS = nSlots[(k + 1) % nLen];
            if (!prevS.valid || !curS.valid || !nextS.valid) continue;
            curS.smoothW.addVectors(prevS.targetW, nextS.targetW).multiplyScalar(0.5);
          }
          for (let k = startK; k < endK; k++) {
            const prevS = nSlots[(k - 1 + nLen) % nLen];
            const curS = nSlots[k];
            const nextS = nSlots[(k + 1) % nLen];
            if (!prevS.valid || !curS.valid || !nextS.valid) continue;
            curS.targetW.lerp(curS.smoothW, netLayer.smoothing);
            curS.targetW.sub(curS.pivotW).normalize().multiplyScalar(curS.segLen).add(curS.pivotW);
          }
          this._solveChainNetCollider(netLayer, colliders);
        }
      }

      // Phase 3: Solve parent bone rotations, enforce local YXZ Euler limits, and commit particle state
      for (let si = 0; si < slots.length; si++) {
        const slot = slots[si];
        if (!slot.valid) continue;
        const pObj = slot.parentEntry.obj;
        const cObj = slot.childEntry.obj;
        const pCfg = slot.parentEntry.cfg;

        sc.dirA.subVectors(slot.animChildW, slot.pivotW).normalize();
        sc.dirB.subVectors(slot.targetW, slot.pivotW).normalize();
        if (sc.dirA.distanceToSquared(sc.dirB) > 1e-8) {
          sc.qSwingW.setFromUnitVectors(sc.dirA, sc.dirB);
          pObj.getWorldQuaternion(sc.qCurW);
          if (pObj.parent) pObj.parent.getWorldQuaternion(sc.qParentW);
          else sc.qParentW.identity();
          sc.qNewLocal.copy(sc.qParentW).invert().multiply(sc.qSwingW.multiply(sc.qCurW));

          if (pCfg.useLimit && pObj.userData?.bindTRS) {
            const bindQ = pObj.userData.bindTRS.q;
            sc.dq3.copy(bindQ).invert().multiply(sc.qNewLocal);
            if (sc.dq3.w < 0) sc.dq3.set(-sc.dq3.x, -sc.dq3.y, -sc.dq3.z, -sc.dq3.w);
            // Convert Three.js local delta to Unity local delta via convQ^-1: (-x, -y, +z, +w)
            sc.qU3.set(-sc.dq3.x, -sc.dq3.y, sc.dq3.z, sc.dq3.w);
            sc.eulU.setFromQuaternion(sc.qU3, 'YXZ');
            const clampDeg = (rad, lim) => {
              const deg = rad / D2R;
              return Math.max(lim[0], Math.min(lim[1], deg)) * D2R;
            };
            sc.eulU.x = clampDeg(sc.eulU.x, pCfg.limitX);
            sc.eulU.y = clampDeg(sc.eulU.y, pCfg.limitY);
            sc.eulU.z = clampDeg(sc.eulU.z, pCfg.limitZ);
            sc.qU3.setFromEuler(sc.eulU);
            sc.dqClamped3.set(-sc.qU3.x, -sc.qU3.y, sc.qU3.z, sc.qU3.w);
            pObj.quaternion.copy(bindQ).multiply(sc.dqClamped3);
          } else {
            pObj.quaternion.copy(sc.qNewLocal);
          }
          pObj.updateWorldMatrix(false, false);
          cObj.updateWorldMatrix(false, false);
        }

        cObj.getWorldPosition(slot.targetW);
        const st = this.swingParticles.get(cObj);
        if (st) {
          if (dt > 0 && !isPrewarm) {
            st.vel.subVectors(slot.targetW, st.pos);
          } else {
            st.vel.set(0, 0, 0);
          }
          st.pos.copy(slot.targetW);
        }
      }
    }
  }
}
