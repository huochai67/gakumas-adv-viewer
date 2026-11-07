import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Match the existing Vite alias without installing a second Three.js version.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'three'
      ? new URL('../../vendor/three.module.js', import.meta.url).href : specifier, context);
  },
});
const { handCorrectionGoal } = await import('./body_ik.js');
const { correctionCollisionInfo, correctGoalPosition } = await import('./ik_correction.js');

function inputs() {
  const end = { post: [0, 0, 0, 1] }, lower = {}, body = [];
  body[18] = end; body[16] = lower;
  return {
    state: { rig: { body }, worldPositions: new Map([[end, [.1, 0, 0]], [lower, [0, .5, 0]]]),
      worldRotations: new Map([[end, [0, 0, 0, 1]]]) },
    effector: { position: [9, 8, 7], rotation: [0, 0, 0, 1], scale: [.8, .6, 0] },
    hint: { position: [0, 1, 1], scale: [.25, .5, 0] },
    cfg: { enable: 1, radius: .05, offset: [0, 0, 0] },
    colliders: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], cfg: {
      type: 0, weight: .75, radius: .2, radiusSub: .2, length: 0,
      dampArea: .01, offset: [0, 0, 0], rotation: [0, 0, 0],
    } }],
  };
}
const goal = ({ state, effector, hint, cfg, colliders }) =>
  handCorrectionGoal(state, 2, effector, hint, cfg, colliders);

test('hand avoidance uses current wrist and Hint Y, without preblending the surface target', () => {
  const input = inputs(), corrected = goal(input);
  assert.deepEqual(corrected.position, [.25, 0, 0]);
  assert.equal(corrected.positionWeight, .375);
  assert.deepEqual(corrected.hint, [0, .625, .25]);
  input.hint.scale[1] = 0;
  assert.deepEqual(goal(input).position, [9, 8, 7]);
  assert.equal(goal(input).positionWeight, .8);
});

test('collision-only enable gate and misses replace rather than retain explicit position weight', () => {
  const input = inputs();
  input.effector.scale = [0, 0, 0];
  input.cfg.enable = 0;
  assert.equal(goal(input).positionWeight, 0);
  input.cfg.enable = 1;
  assert.equal(goal(input).positionWeight, .375);
  input.effector.scale = [.8, .6, 0];
  input.colliders[0].position = [20, 0, 0];
  const missed = goal(input);
  assert.equal(missed.positionWeight, 0);
});

test('elbow Hint X remains independent when the goal handle is absent', () => {
  const input = inputs();
  input.effector = null;
  assert.deepEqual(goal(input).hint, [0, .625, .25]);
  input.hint.scale[0] = 0;
  assert.equal(goal(input).hint, null);
});

test('tapered capsules retain endpoint radii after serialized rotation', () => {
  const cfg = { ...inputs().colliders[0].cfg, type: 1, radius: .1, radiusSub: .2,
    length: .4, rotation: [90, 0, 0] };
  const upper = correctionCollisionInfo(cfg, [0, 0, 0], [0, 0, 0, 1], [.15, 0, .3], .05);
  const lower = correctionCollisionInfo(cfg, [0, 0, 0], [0, 0, 0, 1], [.15, 0, -.3], .05);
  assert.equal(upper.radius, .1);
  assert.equal(lower.radius, .2);
  assert.ok(Math.abs(upper.center[2] - .2) < 1e-7);
  assert.ok(Math.abs(lower.center[2] + .2) < 1e-7);
});

test('correction fades only in the outer shell and does not invent a direction at the center', () => {
  const info = { radius: .25, dampArea: .125, center: [0, 0, 0], weight: .75 };
  assert.deepEqual(correctGoalPosition(info, [.5, 0, 0], .25, .5),
    { position: [.5, 0, 0], weight: .375 });
  assert.deepEqual(correctGoalPosition(info, [.5625, 0, 0], .25, .5),
    { position: [.5, 0, 0], weight: .1875 });
  assert.equal(correctGoalPosition(info, [.625, 0, 0], .25, .5), null);
  assert.deepEqual(correctGoalPosition(info, [0, 0, 0], .25, .5),
    { position: [0, 0, 0], weight: .375 });
});
