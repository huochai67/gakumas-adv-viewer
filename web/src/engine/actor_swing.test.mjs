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
const { ActorSwing } = await import('./actor_swing.js');

function rig() {
  const root = new THREE.Object3D(), hips = new THREE.Object3D();
  const hair = new THREE.Object3D(), tip = new THREE.Object3D();
  root.add(hips); hips.position.y = 1;
  hips.add(hair); hair.add(tip); tip.position.y = -.5;
  const nodes = new Map([root, hips, hair, tip].map((node, i) => {
    node.userData.bindTRS = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
    return [i, node];
  }));
  const cfg = node => ({
    node, dynamicType: 0, enabled: true, colType: 0, mask: 0,
    offset: [0, 0, 0], vB: [0, 0, 0], radius: .01, radiusSub: .01,
    rootWeight: 1, stiffness: .01, damping: .5, spring: .5, mass: 0,
    pendulum: 0, pendulumRange: 1, useWindGlobalForce: false,
    useLimit: false, seatDynamicCorrection: 0,
  });
  root.updateMatrixWorld(true);
  const swing = new ActorSwing(nodes, { swing: { dynamicBones: [cfg(2), cfg(3)] } }, hips);
  return { root, hips, hair, tip, swing, parent: swing.boneByNode.get(2), child: swing.boneByNode.get(3) };
}

for (const weight of [0, .5, 1]) {
  test(`swing weight ${weight} preserves the solved bend through reconstruction and writeback`, () => {
    const { hair, tip, swing, parent, child } = rig();
    const bend = Math.PI / 3;
    swing.parameters.weight = weight;
    parent.position.set(0, 1, 0);
    child.position.set(Math.sin(bend) * .5, 1 - Math.cos(bend) * .5, 0);
    swing._solveTransform(parent);
    swing._writePose();
    hair.updateWorldMatrix(true, true);
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), bend * weight);
    assert.ok(hair.quaternion.angleTo(expected) < 1e-7);
    const actualTip = tip.getWorldPosition(new THREE.Vector3());
    const expectedTip = new THREE.Vector3(0, -.5, 0).applyQuaternion(expected).add(new THREE.Vector3(0, 1, 0));
    assert.ok(actualTip.distanceTo(expectedTip) < 1e-9);
    assert.ok(child.position.distanceTo(expectedTip) < 1e-9);
  });
}

test('swing motion survives a moving parent and continues after the parent stops', () => {
  const { root, hips, hair, swing } = rig();
  swing.update(0);
  swing.restorePose();
  hips.position.x = .1;
  root.updateMatrixWorld(true);
  swing.update(1 / 60);
  const moving = hair.quaternion.clone();
  assert.ok(moving.angleTo(new THREE.Quaternion()) > .01);
  for (let frame = 2; frame <= 10; frame++) {
    swing.restorePose();
    root.updateMatrixWorld(true);
    swing.update(frame / 60);
  }
  assert.ok(hair.quaternion.angleTo(moving) > .001);
  assert.ok(Math.abs(hair.quaternion.length() - 1) < 1e-7);
});
