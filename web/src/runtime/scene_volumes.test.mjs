import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SceneVolumeResolver } from './scene_volumes.js';

const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 5, 0, 0, 0, 1];
const globalVolume = { isGlobal: true, priority: 0, weight: 1,
  components: { lightmap: { intensity: 1 }, colorAdjustments: { contrast: 5.5 } } };
const corridor = { isGlobal: false, priority: 1, weight: 1, blendDistance: 2, matrix,
  colliders: [{ type: 'BoxCollider', center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 } }],
  components: { lightmap: { intensity: 0.5 }, colorAdjustments: { postExposure: -0.1 } } };

test('camera volume blend uses mirrored world Z, squared distance and restores global state', () => {
  const resolver = new SceneVolumeResolver({ volumeStack: [corridor, globalVolume] });
  const inside = resolver.update([0, 0, -5]);
  assert.equal(inside.lightmap.intensity, 0.5);
  assert.equal(inside.colorAdjustments.contrast, 5.5);
  assert.equal(inside.colorAdjustments.postExposure, -0.1);
  const revision = resolver.revision;
  resolver.update([0.5, 0, -5]);
  assert.equal(resolver.revision, revision);
  resolver.update([2, 0, -5]);
  assert.equal(inside.lightmap.intensity, 0.625);
  assert.ok(Math.abs(inside.colorAdjustments.postExposure + 0.075) < 1e-12);
  assert.ok(resolver.revision > revision);
  resolver.update([3, 0, -5]);
  assert.equal(inside.lightmap.intensity, 1);
  assert.equal(inside.colorAdjustments.postExposure, 0);
  resolver.update([0, 0, 5]);
  assert.equal(inside.lightmap.intensity, 1);
});

test('zero-distance local boundary and higher priority override do not reset unrelated fields', () => {
  const resolver = new SceneVolumeResolver({ volumeStack: [
    globalVolume, { ...corridor, blendDistance: 0 },
    { isGlobal: true, priority: 5, weight: 0.5, components: { lightmap: { intensity: 0.8 } } },
  ] });
  assert.equal(resolver.update([1, 0, -5]).lightmap.intensity, 0.65);
  assert.equal(resolver.volumes.colorAdjustments.postExposure, -0.1);
  assert.equal(resolver.update([1.001, 0, -5]).lightmap.intensity, 0.9);
  assert.equal(resolver.volumes.colorAdjustments.postExposure, 0);
  assert.equal(resolver.volumes.colorAdjustments.contrast, 5.5);
});

test('actor profiles remain distinct and enum, bool and cube overrides switch without interpolation', () => {
  const resolver = new SceneVolumeResolver({ volumeStack: [
    { ...globalVolume, components: {
      actorParam: { mainLightAngle: { x: 25, y: 24 }, mainLightSpace: 0, reflectionTexture: 'global.cube.json' },
      litActor: { mainLightAngle: { x: 22, y: 22 } },
      actorShadow: { directionalType: 0, useOffset: true },
    } },
    { ...corridor, weight: 0.25, components: {
      actorParam: { mainLightAngle: { x: 65, y: 64 }, mainLightSpace: 1, reflectionTexture: null },
      actorShadow: { directionalType: 2, useOffset: false },
    } },
  ] });
  const volumes = resolver.update([0, 0, -5]);
  assert.deepEqual(volumes.actorParam.mainLightAngle, { x: 35, y: 34 });
  assert.deepEqual(volumes.litActor.mainLightAngle, { x: 22, y: 22 });
  assert.equal(volumes.actorParam.mainLightSpace, 1);
  assert.equal(volumes.actorParam.reflectionTexture, null);
  assert.equal(volumes.actorShadow.directionalType, 2);
  assert.equal(volumes.actorShadow.useOffset, false);
  const revision = resolver.revision;
  resolver.update([0.5, 0, -5]);
  assert.equal(resolver.revision, revision);
  resolver.update([3, 0, -5]);
  assert.deepEqual(volumes.actorParam.mainLightAngle, { x: 25, y: 24 });
  assert.equal(volumes.actorParam.mainLightSpace, 0);
  assert.equal(volumes.actorParam.reflectionTexture, 'global.cube.json');
  assert.equal(volumes.actorShadow.directionalType, 0);
  assert.equal(volumes.actorShadow.useOffset, true);
});
