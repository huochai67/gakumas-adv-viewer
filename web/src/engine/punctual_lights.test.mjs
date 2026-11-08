import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') specifier = new URL('../../vendor/three.module.js', import.meta.url).href;
    return nextResolve(specifier, context);
  },
});
const { createPunctualLighting, nativeDistanceAttenuation, nativeSpotAttenuation,
  nativePointShadowFovBias } = await import('./punctual_lights.js');

const spot = (overrides = {}) => ({
  type: 0, position: [0, 2, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 30,
  range: 4, spotAngle: 65, innerSpotAngle: 50, renderingLayerMask: 1, shaderLayerMask: 17,
  shadows: 0, bakeType: 4, customProperties: [0, 0, 0.3, 0], ...overrides,
});

test('native range attenuation reaches zero at the source range without a hard inner cutoff', () => {
  assert.equal(nativeDistanceAttenuation(0, 4), nativeDistanceAttenuation(2 ** -14, 4));
  assert.ok(nativeDistanceAttenuation(15.99, 4) > 0);
  assert.equal(nativeDistanceAttenuation(16, 4), 0);
  assert.equal(nativeDistanceAttenuation(16.01, 4), 0);
  assert.equal(nativeDistanceAttenuation(4, 4), (1 - (4 / 16) ** 2) ** 2 / 4);
});

test('native spot attenuation is zero outside the outer cone and one inside the inner cone', () => {
  const outer = Math.cos(65 * Math.PI / 360), inner = Math.cos(50 * Math.PI / 360);
  assert.equal(nativeSpotAttenuation(outer - 0.001, 65, 50), 0);
  assert.equal(nativeSpotAttenuation(outer, 65, 50), 0);
  assert.equal(nativeSpotAttenuation(inner, 65, 50), 1);
  assert.equal(nativeSpotAttenuation(1, 65, 50), 1);
  assert.ok(Math.abs(nativeSpotAttenuation((outer + inner) / 2, 65, 50) - 0.25) < 1e-12);
});

test('point shadow face guard follows the native resolution table', () => {
  assert.equal(nativePointShadowFovBias(512, false), 1);
  assert.ok(Math.abs(nativePointShadowFovBias(512, true) - 1.39) < 1e-12);
  assert.ok(Math.abs(nativePointShadowFovBias(1024, true) - 0.67) < 1e-12);
  assert.equal(nativePointShadowFovBias(16, true), 43);
  assert.equal(nativePointShadowFovBias(2048, true), 4);
});

test('light texture retains every source light and full culling-mask halves', () => {
  const lighting = createPunctualLighting({ lights: Array.from({ length: 300 }, () => spot({ cullingMask: 0x80000001 })) });
  assert.equal(lighting.uniforms.uPunctualCount.value, 300);
  const texture = lighting.uniforms.uPunctualData.value;
  assert.equal(texture.image.height, 300);
  assert.equal(texture.image.width, 8);
  assert.equal(texture.image.data[20], 17);
  assert.equal(texture.image.data[21], 1);
  assert.equal(texture.image.data[22], 32768);
  assert.equal(texture.image.data[11], 1 / 16);
  lighting.dispose();
});

test('baked lights are omitted, subtractive lights are gated and texture disposal is idempotent', () => {
  const lighting = createPunctualLighting({ lights: [spot({ bakeType: 2 }),
    spot({ bakeType: 1, isBaked: true, mixedLightingMode: 1 }), spot({ enabled: false })] });
  assert.equal(lighting.uniforms.uPunctualCount.value, 2);
  const data = lighting.uniforms.uPunctualData.value.image.data;
  assert.equal(data[7], 0);
  assert.equal(data[32 + 7], 0);
  let disposed = 0;
  lighting.uniforms.uPunctualData.value.addEventListener('dispose', () => disposed++);
  lighting.uniforms.uPunctualMatrices.value.addEventListener('dispose', () => disposed++);
  lighting.dispose();
  lighting.dispose();
  assert.equal(disposed, 2);
});

test('actor shadow availability follows the native caster layer and enabled state', () => {
  const light = spot({ shadows: 2, shadowRenderingLayerMask: 4, customProperties: [0, 1, 1, 2] });
  const lighting = createPunctualLighting({ lights: [light] });
  assert.equal(lighting.hasActorShadows, true);
  light.enabled = false;
  assert.equal(lighting.hasActorShadows, false);
  light.enabled = true;
  light.shadowRenderingLayerMask = 1;
  assert.equal(lighting.hasActorShadows, false);
  light.shadowRenderingLayerMask = 4;
  lighting.dispose();
  assert.equal(lighting.hasActorShadows, false);
});
