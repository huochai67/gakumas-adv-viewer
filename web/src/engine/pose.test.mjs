import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'three'
      ? new URL('../../vendor/three.module.js', import.meta.url).href : specifier, context);
  },
});
const THREE = await import('../../vendor/three.module.js');
const { PoseSolver } = await import('./pose.js');

// Amao casl-0000 bind skeleton, collapsed to mapped body bones. No asset cache
// dependency. The idle-001 endpoint activates only the left wrist body avoidance.
// Rows: humanoid name, parent row, Unity bind world position/quaternion.
const BIND = [
  ["Hips",-1,[0,0.918838620185852,0.014164209365844727],[0,0,0,-1]],
  ["LeftUpperLeg",0,[-0.07055339962244034,0.8624194823205471,0.002060092054307461],[0.5033075212570846,0.49667097845854374,0.5033069720076291,0.4966704716490682]],
  ["RightUpperLeg",0,[0.07055339962244034,0.8624191731214523,0.0020600929856300354],[0.49667049726883156,-0.5033069976251916,0.4966710037383181,-0.5033074956395223]],
  ["LeftLowerLeg",1,[-0.07055340355367834,0.5029349382304247,-0.0027116724615621045],[0.515752690685456,0.4837351393712272,0.5157521291469811,0.48373464508264147]],
  ["RightLowerLeg",2,[0.07055340355367085,0.5029354336231752,-0.002711660850161962],[0.4837346700638908,-0.5157521540002978,0.4837351627628806,-0.5157526657510964]],
  ["LeftFoot",3,[-0.07055342969310323,0.0943666675685007,-0.02891466038172602],[4.027003414479127e-9,-0.7071071545316109,1.9708690626253056e-9,-0.7071064078412869]],
  ["RightFoot",4,[0.07055342969313946,0.09436719163077972,-0.02891464686291187],[-0.7071064169591835,-2.0205057364325192e-8,-0.7071071454137231,-2.2261172698582458e-8]],
  ["Spine",0,[0,0.9887899979948997,0.014164209365844727],[0,0,0,-1]],
  ["Chest",7,[0,1.0717800930142403,0.014164209365844727],[0,0,0,-1]],
  ["UpperChest",8,[0,1.1491432711482048,0.014164209365844727],[0,0,0,-1]],
  ["Neck",9,[0,1.2922543212771416,-0.01571962609887123],[0,0,0,-1]],
  ["Head",10,[0,1.3439683988690376,-0.01571962609887123],[0,0,0,-1]],
  ["LeftShoulder",9,[-0.015532201156020164,1.239652968943119,-0.021955173462629318],[0,0,0,-1]],
  ["RightShoulder",9,[0.015532201156020164,1.239652968943119,-0.021955128759145737],[1,0,0,6.123234262925839e-17]],
  ["LeftUpperArm",12,[-0.110009690746665,1.239652968943119,-0.021955173462629318],[0,0,0,-1]],
  ["RightUpperArm",13,[0.11000959388911724,1.239652968943119,-0.021955128759145737],[1,0,0,6.123234262925839e-17]],
  ["LeftLowerArm",14,[-0.3162230905145407,1.239652968943119,-0.021955173462629318],[0,0,0,-1]],
  ["RightLowerArm",15,[0.3162229936569929,1.239652968943119,-0.021955128759145737],[1,0,0,6.123234262925839e-17]],
  ["LeftHand",16,[-0.5182034876197577,1.239652968943119,-0.021955173462629318],[0,0,0,-1]],
  ["RightHand",17,[0.5182033907622099,1.239652968943119,-0.021955128759145737],[1,0,0,6.123234262925839e-17]],
  ["LeftToes",5,[-0.07055332101574104,0.03500267201529452,0.0751253339876788],[4.027003414479127e-9,-0.7071071545316109,1.9708690626253056e-9,-0.7071064078412869]],
  ["RightToes",6,[0.07055332101576842,0.035003201483976905,0.07512534750649295],[-0.7071064169591835,-2.0205057364325192e-8,-0.7071071454137231,-2.2261172698582458e-8]],
];
const MUSCLES = new Float32Array([0,-0.06309,0,0,-0.0907,0,0.00049,-0.11625,-0.02428,-0.0357,0.03939,0.42541,0.06256,0.09234,0.16524,-0.02,0,-0.02,0,0,0,0.55574,-0.13699,-0.23828,0.96358,-0.10154,0.01839,0.10182,0,0.5162,0.10485,-0.02946,0.81552,0.13166,-0.19185,-0.1425,0,0,0,0.07537,0.56874,-0.57509,-0.45401,-0.20388,0.0678,-0.47144,-0.30194,0,-0.81333,0.317,0.59982,0.62419,-0.05739,0.21555,-0.03768,-0.8039,-1.29884,0.17154,1.08896,0.98851,-0.87627,0.6014,0.78054,0.90944,-1.17228,0.4766,0.63129,0.93213,-0.6686,0.40763,0.59082,0.82607,-0.84244,0.70563,0.3619,-1.82883,0.2462,0.0267,0.1747,0.43932,-0.88097,0.17091,0.57679,0.32617,-1.10311,-0.15598,0.24838,0.26328,-0.88039,-0.08281,0.29319,0.45483,-0.72744,-0.42287,0.27119]);
const ROOT = {"rootT":[-0.00049,0.97727,-0.00087],"rootQ":[-0.00307,-0.21058,-0.00686,0.97755],"lfT":[-0.03938,-0.97769,-0.01922],"lfQ":[-0.60017,0.59627,-0.37202,0.38191],"rfT":[0.10098,-0.97542,-0.08263],"rfQ":[-0.5504,0.5477,-0.44041,0.45069],"lhT":[-0.1727,0.12813,-0.00027],"lhQ":[0.7749,0.0521,0.36123,-0.51607],"rhT":[0.24181,-0.03986,-0.04345],"rhQ":[-0.27037,0.11561,-0.38853,0.87326]};
// Original UnityPlayer 7A967673EA4F48258125F6D6920C5CDD age 1 machine code:
// RetargetTo B87F80 -> FullBodySolve B88A60 (left collision .75, rotation 0)
// -> TwistSolve B8A320. These are final bone transforms, not helper call counts.
const EXPECTED = {"LeftHand":{"p":[-0.1620308756828308,1.0177297592163086,-0.07816815376281738],"q":[0.11151036620140076,-0.6719024181365967,-0.48269060254096985,-0.5505701303482056]},"LeftLowerArm":{"p":[-0.20370101928710938,1.1500658988952637,-0.22495821118354797],"q":[0.04991644620895386,-0.5338051915168762,-0.5640974640846252,-0.6279805302619934]},"RightHand":{"p":[0.217249795794487,0.8557043075561523,0.05425107479095459],"q":[0.8745036721229553,-0.4430866837501526,0.07021602988243103,0.18436990678310394]}};

function fixture({ intermediate = false } = {}) {
  const outer = new THREE.Object3D(), root = new THREE.Object3D();
  outer.add(root);
  const nodes = new Map([[0, root]]), humanoid = {}, boneNodes = {};
  const worldQ = [], worldP = [], bones = [];
  const toQ = q => new THREE.Quaternion(-q[0], -q[1], q[2], q[3]);
  for (const [i, [name, parentIndex, p, q]] of BIND.entries()) {
    const node = new THREE.Object3D(); node.name = name;
    const parent = parentIndex < 0 ? root : bones[parentIndex];
    const pq = parentIndex < 0 ? new THREE.Quaternion() : worldQ[parentIndex];
    const pp = parentIndex < 0 ? new THREE.Vector3() : worldP[parentIndex];
    worldQ[i] = toQ(q); worldP[i] = new THREE.Vector3(p[0], p[1], -p[2]);
    node.quaternion.copy(pq).invert().multiply(worldQ[i]);
    node.position.copy(worldP[i]).sub(pp).applyQuaternion(pq.clone().invert());
    parent.add(node); bones.push(node);
    nodes.set(i + 1, node); humanoid[name] = i + 1; boneNodes[i + 1] = name;
  }
  if (intermediate) {
    // A real hierarchy can contain unmapped transforms between human bones.
    const hand = bones[18], parent = hand.parent, spacer = new THREE.Object3D();
    spacer.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), .37);
    parent.add(spacer); spacer.add(hand);
    hand.position.applyQuaternion(spacer.quaternion.clone().invert());
    hand.quaternion.premultiply(spacer.quaternion.clone().invert());
    nodes.set(nodes.size, spacer);
  }
  for (const name of ['IKGoal_LeftHand', 'IKHint_LeftElbow', 'IKGoal_RightHand', 'IKHint_RightElbow']) {
    const node = new THREE.Object3D(); node.name = name; root.add(node);
    node.scale.set(0, name === 'IKHint_LeftElbow' ? 1 : 0, 0);
    const index = nodes.size; nodes.set(index, node); boneNodes[index] = name;
  }
  for (const node of nodes.values()) {
    node.userData.bindTRS = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
  }
  root.updateMatrixWorld(true);
  const solver = new PoseSolver(nodes, { humanoid, boneNodes, ikCorrection: {
    colliders: [{ node: 1, name: 'Hips', type: 1, weight: .75, radius: .125,
      radiusSub: .15000000596046448, length: .17000000178813934, dampArea: .009999999776482582,
      offset: [0, 0, 0], rotation: [0, 0, 0] }],
    goals: [2, 3].map(goal => ({ goal, enable: 1, radius: .05999999865889549, offset: [0, 0, 0] })),
  } });
  const render = () => { solver.apply(MUSCLES, [], ROOT); solver.updatePostRig(0); };
  return { solver, outer, root, render };
}

function snapshot(solver) {
  return solver.humanRig.bones.flatMap(({ node }) => [
    ...node.position.toArray(), ...node.quaternion.toArray(),
  ]);
}
function nearPose(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-10, 'pose drift at ' + i);
}
function assertNative(solver, outer) {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const node = solver.humanRig.byName.get(name).node;
    const p = outer.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
    const q = outer.getWorldQuaternion(new THREE.Quaternion()).invert()
      .multiply(node.getWorldQuaternion(new THREE.Quaternion())).normalize();
    assert.ok(p.distanceTo(new THREE.Vector3(expected.p[0], expected.p[1], -expected.p[2])) < 1e-5, name + ' position');
    const eq = new THREE.Quaternion(-expected.q[0], -expected.q[1], expected.q[2], expected.q[3]).normalize();
    assert.ok(q.angleTo(eq) < 3e-5, name + ' orientation');
  }
}

test('collision avoidance receives pre-twist arms and final output matches native wrist and elbow', () => {
  const { solver, outer, render } = fixture();
  render(); assertNative(solver, outer);
});

test('final twist never feeds paused redraws, resets, or newly sampled poses', () => {
  const { solver, outer, render } = fixture();
  render(); const first = snapshot(solver);
  for (let i = 0; i < 5; i++) solver.updatePostRig(0);
  nearPose(snapshot(solver), first);
  solver.resetSwing(); solver.updatePostRig(0);
  nearPose(snapshot(solver), first);
  solver.enableIK = false; render();
  solver.enableIK = true; render();
  nearPose(snapshot(solver), first);
  const other = MUSCLES.slice(); other[40] -= .2;
  const a = solver.poseFrom(other, [], ROOT), b = solver.poseFrom(MUSCLES, [], ROOT);
  solver.applyPose(a, b, .5); solver.updatePostRig(0);
  render(); nearPose(snapshot(solver), first); assertNative(solver, outer);
  solver.resetPose();
  for (const node of solver.nodes.values()) {
    assert.deepEqual(node.quaternion.toArray(), node.userData.bindTRS.q.toArray());
    assert.deepEqual(node.position.toArray(), node.userData.bindTRS.p.toArray());
  }
  render(); nearPose(snapshot(solver), first);
});

test('final twist handles intermediate bones and actor placement without changing actor-space pose', () => {
  const { solver, outer, render } = fixture({ intermediate: true });
  outer.position.set(3, -.4, 2); outer.rotation.set(.1, .8, -.2); outer.scale.setScalar(1.1);
  render(); assertNative(solver, outer);
  const first = snapshot(solver);
  render(); nearPose(snapshot(solver), first);
});
