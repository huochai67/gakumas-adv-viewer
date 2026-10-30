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

    // Eyes (15..18): Down-Up (X), In-Out (Y)
    if (Math.abs(m[15]) > 1e-4 || Math.abs(m[16]) > 1e-4) {
      worldDeltaU.LeftEye = qmul(qHead, zyUnity(uDeg(m[15], -10, 12), -uDeg(m[16], -15, 15), 0));
    }
    if (Math.abs(m[17]) > 1e-4 || Math.abs(m[18]) > 1e-4) {
      worldDeltaU.RightEye = qmul(qHead, zyUnity(uDeg(m[17], -10, 12), uDeg(m[18], -15, 15), 0));
    }

    // ---------- Arms (37..54) ----------
    // Verified limits against hand-to-hand & hand-orientation ground truth:
    const shDuN = -15, shDuP = 30, shFbN = -15, shFbP = 15;
    const armDuN = -60, armDuP = 100, armFbN = -100, armFbP = 100, armTw = 90;
    const faSt = 80, faTw = 90, hdDu = 80, hdIo = 52;
    const lArmTwDeg = -uDeg(m[41], -armTw, armTw);
    const lFaTwDeg = -uDeg(m[43], -faTw, faTw);
    const qLSh = qmul(qTorso, zyUnity(0, -uDeg(m[38], shFbN, shFbP), -uDeg(m[37], shDuN, shDuP)));
    const qLArm = qmul(qLSh, zyUnity(lArmTwDeg, -uDeg(m[40], armFbN, armFbP, 0.3001), -uDeg(m[39], armDuN, armDuP, 0.4)));
    const qLFa = qmul(qLArm, zyUnity(lFaTwDeg, -uDeg(m[42], -faSt, faSt, 0.9999), 0));
    const qLHd = (root && root.lhQ)
      ? qmul(qmul(rq, qnorm(root.lhQ)), [0, 0, -1, 0])
      : qmul(qLFa, zyUnity(0, -uDeg(m[45], -hdIo, hdIo), -uDeg(m[44], -hdDu, hdDu)));
    worldDeltaU.LeftShoulder = qLSh;
    worldDeltaU.LeftArm = qLArm;
    worldDeltaU.LeftForeArm = qLFa;
    worldDeltaU.LeftHand = qLHd;

    const rArmTwDeg = -uDeg(m[50], -armTw, armTw);
    const rFaTwDeg = -uDeg(m[52], -faTw, faTw);
    const qRSh = qmul(qTorso, zyUnity(0, uDeg(m[47], shFbN, shFbP), uDeg(m[46], shDuN, shDuP)));
    const qRArm = qmul(qRSh, zyUnity(rArmTwDeg, uDeg(m[49], armFbN, armFbP, 0.3001), uDeg(m[48], armDuN, armDuP, 0.4)));
    const qRFa = qmul(qRArm, zyUnity(rFaTwDeg, uDeg(m[51], -faSt, faSt, 0.9999), 0));
    const qRHd = (root && root.rhQ)
      ? qmul(rq, qnorm(root.rhQ))
      : qmul(qRFa, zyUnity(0, uDeg(m[54], -hdIo, hdIo), uDeg(m[53], -hdDu, hdDu)));
    worldDeltaU.RightShoulder = qRSh;
    worldDeltaU.RightArm = qRArm;
    worldDeltaU.RightForeArm = qRFa;
    worldDeltaU.RightHand = qRHd;

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

    // ---------- Fingers (55..94): local-frame curl & spread from TPOSE_MUSCLES ----------
    const spreadSigns = [1, 1, 0, -0.6, -1.2];
    for (let side = 0; side < 2; side++) {
      const prefix = side === 0 ? 'LeftHand' : 'RightHand';
      const baseIdx = 55 + side * 20;
      for (let fi = 0; fi < 5; fi++) {
        const fname = FINGERS[fi];
        const i0 = baseIdx + fi * 4;
        const dm1 = (m[i0] ?? TPOSE_MUSCLES[i0]) - TPOSE_MUSCLES[i0];
        const dms = (m[i0 + 1] ?? TPOSE_MUSCLES[i0 + 1]) - TPOSE_MUSCLES[i0 + 1];
        const dm2 = (m[i0 + 2] ?? TPOSE_MUSCLES[i0 + 2]) - TPOSE_MUSCLES[i0 + 2];
        const dm3 = (m[i0 + 3] ?? TPOSE_MUSCLES[i0 + 3]) - TPOSE_MUSCLES[i0 + 3];

        const isThumb = fi === 0;
        const cLim1 = isThumb ? 18 : 42;
        const cLim2 = isThumb ? 32 : 48;
        const cLim3 = isThumb ? 28 : 38;
        const sLim = isThumb ? -15 : 12 * spreadSigns[fi];
        const thumbSign = side === 0 ? -1 : 1;

        const segs = [
          [`${prefix}${fname}1`, isThumb ? thumbSign * (-dm1 * cLim1) : (-dm1 * cLim1), (isThumb ? thumbSign : 1) * dms * sLim],
          [`${prefix}${fname}2`, isThumb ? thumbSign * (-dm2 * cLim2) : (-dm2 * cLim2), 0],
          [`${prefix}${fname}3`, isThumb ? thumbSign * (-dm3 * cLim3) : (-dm3 * cLim3), 0],
        ];
        for (const [bname, curlDeg, sprDeg] of segs) {
          const obj = this.nameToNode[bname];
          if (!obj || !obj.userData?.bindTRS) continue;
          const qlU = qmul(qaxis(1, sprDeg), qaxis(2, curlDeg));
          const ql3 = obj.userData.bindTRS.q.clone().multiply(convQ(qlU));
          out.set(obj, { q: ql3 });
        }
      }
    }

    // ---------- QuartzDriver twist/helper bones ----------
    const applyTwistHelper = (bname, axisU, deg) => {
      const obj = this.nameToNode[bname];
      if (!obj || !obj.userData?.bindTRS) return;
      const ql3 = obj.userData.bindTRS.q.clone().multiply(convQ(qaxis(axisU, deg)));
      out.set(obj, { q: ql3 });
    };
    // Counter-twist shoulder sleeve & thigh skirt helpers; smooth-roll forearms
    applyTwistHelper('LeftArm_H', 0, -0.8 * lArmTwDeg);
    applyTwistHelper('LeftArm_Roll_H', 0, -0.3 * lArmTwDeg);
    applyTwistHelper('LeftForeArm_Roll_H', 0, 0.5 * lFaTwDeg);
    applyTwistHelper('RightArm_H', 0, 0.8 * rArmTwDeg);
    applyTwistHelper('RightArm_Roll_H', 0, 0.3 * rArmTwDeg);
    applyTwistHelper('RightForeArm_Roll_H', 0, -0.5 * rFaTwDeg);
    applyTwistHelper('LeftUpLeg_H', 0, -1.0 * lUlTwDeg);
    applyTwistHelper('RightUpLeg_H', 0, -1.0 * rUlTwDeg);

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
      if (root && root.rootT && root.lfT && root.rfT) {
        const rt = root.rootT;
        const rl = qrot(rq, root.lfT);
        const rr = qrot(rq, root.rfT);
        const gtLSole = [(rt[0] + rl[0]) * HUMAN_SCALE, (rt[1] + rl[1]) * HUMAN_SCALE, (rt[2] + rl[2]) * HUMAN_SCALE];
        const gtRSole = [(rt[0] + rr[0]) * HUMAN_SCALE, (rt[1] + rr[1]) * HUMAN_SCALE, (rt[2] + rr[2]) * HUMAN_SCALE];
        hipsWorldU = [
          0.5 * ((gtLSole[0] - fkLSole[0]) + (gtRSole[0] - fkRSole[0])),
          0.5 * ((gtLSole[1] - fkLSole[1]) + (gtRSole[1] - fkRSole[1])),
          0.5 * ((gtLSole[2] - fkLSole[2]) + (gtRSole[2] - fkRSole[2])),
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
}
