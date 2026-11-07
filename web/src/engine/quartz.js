import * as THREE from 'three';
import * as math from './quartz_math.js';

const RAD_TO_DEG = 180 / Math.PI;
const DOWN = new THREE.Vector3(0, -1, 0);
const LEFT = new THREE.Vector3(-1, 0, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

function rotationU(out, q) { return out.set(-q.x, -q.y, q.z, q.w); }
function positionU(out, p) { return out.set(p.x, p.y, -p.z); }
function setRotation(node, q) { node.quaternion.set(-q.x, -q.y, q.z, q.w); }
function depth(node) {
  let n = 0;
  while (node.parent) { n++; node = node.parent; }
  return n;
}
function worldPosition(out, node) {
  node.getWorldPosition(out);
  out.z = -out.z;
  return out;
}
function worldRotation(out, node) {
  node.getWorldQuaternion(out);
  return rotationU(out, out);
}
function vector(out, value) { return out.set(value.x, value.y, value.z); }
function muscleIndex(part, dof) {
  // Unity HumanPartDof: LeftLeg=2, RightLeg=3, LeftArm=4, RightArm=5.
  const base = part === 2 ? 21 : part === 3 ? 29 : part === 4 ? 37 : part === 5 ? 46 : -1;
  return base < 0 ? -1 : base + dof;
}
function clamp01(v) { return Number.isNaN(v) ? 1 : Math.min(1, Math.max(0, v)); }

function negateSwap(lo, hi, axis) {
  const old = lo[axis]; lo[axis] = -hi[axis]; hi[axis] = -old;
}

// ConvertToUnity runs once while creating native jobs. Keep exported metadata
// immutable so multiple actors can share an asset without applying it twice.
function convertSetting(type, original, referenceName) {
  const s = {};
  for (const key of Object.keys(original)) {
    const value = original[key];
    s[key] = value && typeof value === 'object' ? { ...value } : value;
  }
  if (type === 'Frill' || type === 'HumanoidSleeve') {
    const a = s.outerMinusCoefficient, b = s.innerCoefficient, c = s.outerPlusCoefficient;
    a.x = -a.x; b.x = -b.x; c.x = -c.x;
    for (const axis of ['y', 'z']) {
      b[axis] = -b[axis];
      negateSwap(a, c, axis);
      negateSwap(s.switchMinus, s.switchPlus, axis);
    }
  } else if (type === 'Skirt') {
    if (referenceName.includes('Left')) {
      negateSwap(s.limitMin, s.limitMax, 'y');
      s.innerCoefficient.y = -s.innerCoefficient.y;
      s.outerCoefficient.y = -s.outerCoefficient.y;
    }
    negateSwap(s.limitMin, s.limitMax, 'z');
    s.innerCoefficient.z = -s.innerCoefficient.z;
    s.outerCoefficient.z = -s.outerCoefficient.z;
  } else if (type === 'Hair') {
    s.headTranslateCoefficient.x *= 0.01;
    s.headTranslateCoefficient.y *= 0.01;
    s.headTranslateCoefficient.z *= -0.01;
    for (const axis of ['y', 'z']) negateSwap(s.headTranslateLimitMin, s.headTranslateLimitMax, axis);
    for (const prefix of ['headRotate', 'neckRotate']) {
      const coefficient = s[`${prefix}Coefficient`];
      coefficient.x = -coefficient.x; coefficient.y = -coefficient.y; coefficient.z = -coefficient.z;
      for (const axis of ['y', 'z']) negateSwap(s[`${prefix}LimitMin`], s[`${prefix}LimitMax`], axis);
    }
  }
  return s;
}

/** Native Quartz jobs, in Unity coordinates; Object3D is the AnimationStream adapter. */
export class QuartzDriver {
  constructor(nodes, meta) {
    this.nodes = nodes;
    this.drivers = [];
    this.sources = [];
    this.captured = false;
    this.q0 = new THREE.Quaternion();
    this.q1 = new THREE.Quaternion();
    this.q2 = new THREE.Quaternion();
    this.euler = new THREE.Vector3();
    this.v0 = new THREE.Vector3();
    this.v1 = new THREE.Vector3();
    this.v2 = new THREE.Vector3();
    this.v3 = new THREE.Vector3();
    const sourceByNode = new Map();
    for (const cfg of meta.quartzDrivers || []) {
      const node = nodes.get(cfg.node);
      if (!node || cfg.enabled === false || cfg.enabled === 0) continue;
      const type = cfg.type.replace(/^ActorAnimationQuartzDriver/, '').replace(/Bone$/, '');
      if (!cfg.setting) continue;
      const referenceName = meta.boneNodes?.[cfg.setting.referenceBone] || nodes.get(cfg.setting.referenceBone)?.name || '';
      // CampusActorAnimation.DynamicReference (0x182B1DE00) injects the
      // assembled body's Head/Neck GameObjects before hair jobs are created.
      const original = type === 'Hair' && nodes.has(meta.humanoid?.Head) && nodes.has(meta.humanoid?.Neck)
        ? { ...cfg.setting, referenceHeadBone: meta.humanoid.Head, referenceNeckBone: meta.humanoid.Neck }
        : cfg.setting;
      const setting = convertSetting(type, original, referenceName);
      const d = { node, type, setting, depth: depth(node), refs: {}, initialReference: null };
      for (const key of Object.keys(setting)) {
        if (key.startsWith('reference')) d.refs[key] = nodes.get(setting[key]) || null;
      }
      // Unresolved transform handles fail native IsValid, rather than reading an identity pose.
      if (Object.values(d.refs).some(ref => !ref)) continue;
      if (type === 'Skirt') {
        d.initialReference = rotationU(new THREE.Quaternion(), d.refs.referenceBone.quaternion);
      }
      if (type === 'HumanoidArm' || type === 'HumanoidHand' || type === 'HumanoidUpLeg') {
        const dof = type === 'HumanoidArm' ? 4 : type === 'HumanoidHand' ? 6 : 2;
        d.muscle = muscleIndex(setting.humanPartDof, dof);
        d.limit = type === 'HumanoidArm' ? -90 : type === 'HumanoidHand' ? -66 : -60;
        if (d.muscle < 0) continue;
      }
      if (!sourceByNode.has(node)) {
        const source = { node, position: node.position.clone(), rotation: node.quaternion.clone(), scale: node.scale.clone() };
        sourceByNode.set(node, source);
        this.sources.push(source);
      }
      this.drivers.push(d);
    }
    this.drivers.sort((a, b) => GROUP_ORDER.indexOf(a.type) - GROUP_ORDER.indexOf(b.type) || a.depth - b.depth);
  }

  restorePose() {
    if (!this.captured) return;
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      s.node.position.copy(s.position);
      s.node.quaternion.copy(s.rotation);
      s.node.scale.copy(s.scale);
      s.node.updateMatrix();
    }
    this.captured = false;
  }

  update(muscles) {
    // Capture EVERY target before ANY write, including multi-driver targets.
    // PoseSolver restores before sampling; a repeated render therefore has no output feedback.
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      s.position.copy(s.node.position);
      s.rotation.copy(s.node.quaternion);
      s.scale.copy(s.node.scale);
    }
    this.captured = true;
    for (let i = 0; i < this.drivers.length; i++) {
      const d = this.drivers[i], s = d.setting, node = d.node;
      switch (d.type) {
        case 'Rotation':
          rotationU(this.q0, d.refs.referenceBone.quaternion);
          math.quartzRotation(this.q1, this.q0, s);
          setRotation(node, this.q1);
          break;
        case 'Skirt':
          rotationU(this.q0, d.refs.referenceBone.quaternion);
          math.quartzSkirt(this.q1, d.initialReference, this.q0, s);
          setRotation(node, this.q1);
          break;
        case 'HumanoidArm':
        case 'HumanoidHand':
        case 'HumanoidUpLeg':
          if (!muscles) break;
          rotationU(this.q0, node.quaternion);
          math.quartzUnityEuler(this.euler, this.q0);
          math.quartzQuaternion(this.q1, muscles[d.muscle] * d.limit * s.coefficient,
            this.euler.y, this.euler.z);
          setRotation(node, this.q1);
          break;
        case 'Waist':
          worldPosition(this.v0, d.refs.referenceWaistOffsetBone);
          worldRotation(this.q0, d.refs.referenceWaistOffsetBone);
          worldPosition(this.v1, d.refs.referenceThighOffsetBone);
          this.v2.subVectors(this.v1, this.v0).normalize();
          this.q0.invert();
          this.v2.applyQuaternion(this.q0);
          math.quartzUnityFromTo(this.q1, DOWN, this.v2);
          setRotation(node, this.q1);
          this.v0.lerp(this.v1, s.weight);
          this.v0.z = -this.v0.z;
          if (node.parent) { node.parent.updateWorldMatrix(true, false); node.parent.worldToLocal(this.v0); }
          node.position.copy(this.v0);
          break;
        case 'Frill':
          rotationU(this.q0, d.refs.referenceBone.quaternion);
          math.quartzFrill(this.q1, this.q0, s.rotationOrder, s.outerMinusCoefficient,
            s.innerCoefficient, s.outerPlusCoefficient, s.switchMinus, s.switchPlus,
            s.connectionAxis, s.decomposeType, s.composeType);
          setRotation(node, this.q1);
          break;
        case 'Hair':
          rotationU(this.q0, d.refs.referenceHeadBone.quaternion);
          rotationU(this.q1, d.refs.referenceNeckBone.quaternion);
          math.quartzHair(this.q2, this.v0, this.q0, this.q1, s);
          setRotation(node, this.q2);
          positionU(node.position, this.v0);
          break;
        case 'HumanoidSleeve':
          this.updateSleeve(d, muscles);
          break;
        case 'Furisode':
          this.updateFurisode(d);
          break;
        case 'Poncho':
          this.updatePoncho(d);
          break;
        default:
          throw new Error(`Unsupported QuartzDriver type: ${d.type}`);
      }
      node.updateMatrix();
    }
  }
  // HumanoidSleeveJobBone.Execute removes the raw forearm twist before
  // decomposing the reference's animation rotation. Do not read solved bones as muscles.
  updateSleeve(d, muscles) {
    if (!muscles) return;
    const s = d.setting;
    const angle = muscles[muscleIndex(s.humanPartDof, 6)] * -90 * Math.PI / 180;
    this.q0.setFromAxisAngle(RIGHT, angle);
    rotationU(this.q1, d.refs.referenceBone.quaternion);
    this.q0.multiply(this.q1);
    math.quartzUnityEuler(this.euler, this.q0);
    math.quartzDecompose(this.euler, this.euler.x, this.euler.y, this.euler.z, 1);
    const a = s.outerMinusCoefficient, b = s.innerCoefficient, c = s.outerPlusCoefficient;
    const lo = s.switchMinus, hi = s.switchPlus;
    const x = math.quartzTriple(math.quartzFormatDegree(this.euler.x), a.x, b.x, c.x, lo.x, hi.x) * Math.PI / 180;
    const y = math.quartzTriple(math.quartzFormatDegree(this.euler.y), a.y, b.y, c.y, lo.y, hi.y) * Math.PI / 180;
    const z = math.quartzTriple(math.quartzFormatDegree(this.euler.z), a.z, b.z, c.z, lo.z, hi.z) * Math.PI / 180;
    if (s.composeType === 0) math.quartzBendRoll(this.q2, x, y, z);
    else if (s.composeType === 1) math.quartzRollBend(this.q2, x, y, z);
    else if (s.composeType === 2) math.quartzMatrix(this.q2, -x, -y, -z);
    else {
      math.quartzAxisEuler(this.euler, x, y, z);
      math.quartzQuaternion(this.q2, this.euler.x, this.euler.y, this.euler.z);
      math.quartzEuler(this.euler, this.q2, 0);
      math.quartzQuaternion(this.q2, this.euler.x * RAD_TO_DEG, this.euler.y * RAD_TO_DEG, this.euler.z * RAD_TO_DEG);
    }
    setRotation(d.node, this.q2);
  }

  updateFurisode(d) {
    const s = d.setting;
    worldPosition(this.v0, d.refs.referenceHandBone);
    worldPosition(this.v1, d.refs.referenceForearmBone);
    this.v0.sub(this.v1).normalize();
    const angle = this.v0.lengthSq() < 1e-15 ? 0 : Math.acos(Math.min(1, Math.max(-1, this.v0.dot(DOWN)))) * RAD_TO_DEG;
    const weight = clamp01(1 - angle / s.apexAngle);
    worldRotation(this.q0, d.refs.referenceSpineBone);
    worldRotation(this.q1, d.refs.referenceFurisodeOffsetBone);
    vector(this.v0, s.backWay).applyQuaternion(this.q0);
    math.quartzInverse(this.q0, this.q1);
    this.v0.applyQuaternion(this.q0);
    math.quartzUnityFromTo(this.q2, LEFT, this.v0);
    math.quartzUnityEuler(this.euler, this.q2);
    math.quartzDecompose(this.euler, this.euler.x, this.euler.y, this.euler.z, 1);
    const z = Math.min(s.max, Math.max(s.min, weight * s.coefficient * this.euler.z));
    math.quartzQuaternion(this.q2, 0, 0, z);
    setRotation(d.node, this.q2);
  }

  updatePoncho(d) {
    const s = d.setting;
    worldPosition(this.v0, d.refs.referencePonchoOffsetBone);
    worldRotation(this.q0, d.refs.referencePonchoOffsetBone);
    worldPosition(this.v1, d.refs.referenceArmOffsetBone);
    worldPosition(this.v2, d.refs.referenceBodyOffsetBone);
    vector(this.v3, s.axisWay);
    math.quartzPonchoRotation(this.q2, this.v0, this.q0, this.v1, this.v2, s.lerpCoefficient, this.v3);
    rotationU(this.q0, d.refs.referenceArmBone.quaternion);
    math.quartzUnityEuler(this.euler, this.q0);
    math.quartzDecompose(this.euler, this.euler.x, this.euler.y, this.euler.z, 1);
    const y = this.euler.y;
    if (y > 0) positionU(this.v0, d.refs.referenceInnerOffsetBone.position).multiplyScalar(clamp01(y / s.innerLimit));
    else if (y < 0) positionU(this.v0, d.refs.referenceOuterOffsetBone.position).multiplyScalar(clamp01(y / s.outerLimit));
    else this.v0.set(0, 0, 0);
    positionU(d.node.position, this.v0);
    setRotation(d.node, this.q2);
  }
}

// ProcessQuartzDriver getter offsets, confirmed against CreateQuartzDriver storage.
const GROUP_ORDER = ['Rotation', 'Frill', 'Skirt', 'Hair', 'HumanoidHand', 'HumanoidSleeve', 'HumanoidUpLeg', 'HumanoidArm', 'Waist', 'Furisode', 'Poncho'];
