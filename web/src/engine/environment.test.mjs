import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') specifier = new URL('../../vendor/three.module.js', import.meta.url).href;
    return nextResolve(specifier, context);
  },
});
const { selectEnvironmentProbe } = await import('./environment.js');

function probe(id, min, max, importance = 1) {
  return { id, boxMin: min, boxMax: max, importance };
}
function selection(probes, min, max, usage = 1) {
  return selectEnvironmentProbe(probes, { usage, bounds: { min, max } })?.id ?? null;
}

test('shared floor materials retain renderer-local probe selection, including planar bounds', () => {
  const probes = [probe('left', [-4, -1, -2], [0, 3, 2]), probe('right', [0, -1, -2], [4, 3, 2])];
  assert.equal(selection(probes, [-3, 0, -1], [-1, 0, 1]), 'left');
  assert.equal(selection(probes, [1, 0, -1], [3, 0, 1]), 'right');
  assert.equal(selection(probes, [-1, 0, -1], [2, 0, 1]), 'right');
});

test('local probe importance and containment take precedence over an enclosing room', () => {
  const probes = [probe('room', [-5, -2, -5], [5, 4, 5]), probe('alcove', [0, -1, -1], [2, 2, 1])];
  assert.equal(selection(probes, [0.5, 0, -0.5], [1.5, 0, 0.5]), 'alcove');
  assert.equal(selection(probes, [-1, 0, -0.5], [1, 0, 0.5]), 'room');
  probes[1].importance = 2;
  assert.equal(selection(probes, [-1, 0, -0.5], [1, 0, 0.5]), 'alcove');
  assert.equal(selection(probes, [6, 0, -0.5], [7, 0, 0.5]), null);
  assert.equal(selection(probes, [0.5, 0, -0.5], [1.5, 0, 0.5], 0), null);
});
