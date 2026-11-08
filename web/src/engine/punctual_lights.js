import * as THREE from 'three';
import { NATIVE_RENDER_PIPELINE } from '../runtime/rendering_defaults.js';

// Environment/Default Forward+ 296/392 and Campus/StencilDeferred 107/359.
// A texture-backed light list avoids uniform limits without dropping lights.
const LIGHT_TEXELS = 8;
const MIN_DISTANCE_SQUARED = 0.00006103515625;

export function nativeDistanceAttenuation(distanceSquared, range) {
  const d2 = Math.max(distanceSquared, MIN_DISTANCE_SQUARED);
  const fade = Math.max(1 - (d2 / (range * range)) ** 2, 0);
  return fade * fade / d2;
}

export function nativeSpotAttenuation(cosine, outerAngle, innerAngle) {
  const outer = Math.cos(outerAngle * Math.PI / 360);
  const inner = Math.cos(innerAngle * Math.PI / 360);
  const cone = Math.max(0, Math.min(1, (cosine - outer) / Math.max(inner - outer, 0.001)));
  return cone * cone;
}

// AdditionalLightsShadowCasterPass.GetPointLightShadowFrustumFovBias, native
// 0x187A679E0. Its supported-size table deliberately retains the native fallback.
export function nativePointShadowFovBias(resolution, soft) {
  if (resolution <= 8 || resolution > 1024) return 4;
  if (resolution <= 16) return 43;
  if (resolution <= 32) return 18.55 + (soft ? 9.35 : 0);
  if (resolution <= 64) return 8.63 + (soft ? 4.07 : 0);
  if (resolution <= 128) return 4.13 + (soft ? 1.77 : 0);
  if (resolution <= 256) return 2.03 + (soft ? 0.85 : 0);
  if (resolution <= 512) return 1 + (soft ? 0.39 : 0);
  return 0.5 + (soft ? 0.17 : 0);
}

export const PUNCTUAL_DECLARATIONS = /* glsl */`
#ifdef ENV_PUNCTUAL
uniform sampler2D uPunctualData;
uniform sampler2D uPunctualMatrices;
uniform highp sampler2DArray uPunctualShadows;
uniform int uPunctualCount;
uniform int uEnvRenderingLayer;
uniform int uEnvUnityLayer;
uniform bool uEnvReceiveShadows;
uniform bool uEnvHasShadowMask;
uniform float uPunctualShadowTexel;
uniform vec2 uPunctualShadowFade;
uniform int uPunctualMainIndex;
vec4 envLightData(int index, int field) {
  return texelFetch(uPunctualData, ivec2(field, index), 0);
}
float envShadowCompare(vec3 uv, float depth) {
  vec4 packedDepth = texture(uPunctualShadows, uv);
  return step(depth, dot(packedDepth, vec4(0.99609375 / 16777216.0,
    0.99609375 / 65536.0, 0.99609375 / 256.0, 0.99609375)));
}
void envTentWeights(float s, out float weights[6]) {
  float end = (s + 0.5) * (s + 0.5);
  weights[0] = 0.16 * (0.5 * end - s);
  weights[1] = 0.16 * (1.0 - s);
  weights[2] = 0.16 * (2.0 - s - min(s, 0.0) * min(s, 0.0));
  weights[3] = 0.16 * (2.0 + s - max(s, 0.0) * max(s, 0.0));
  weights[4] = 0.16 * (1.0 + s);
  weights[5] = 0.08 * end;
}
float envRealtimeShadow(int index, vec3 position, vec3 fromLight) {
  vec4 settings = envLightData(index, 6);
  float uvScale = settings.w;
  if (!uEnvReceiveShadows || settings.x < 0.0) return 1.0;
  int slice = int(settings.x);
  if (envLightData(index, 0).w == 2.0) {
    vec3 a = abs(fromLight);
    if (a.x >= a.y && a.x >= a.z) slice += fromLight.x >= 0.0 ? 0 : 1;
    else if (a.y >= a.z) slice += fromLight.y >= 0.0 ? 2 : 3;
    else slice += fromLight.z >= 0.0 ? 4 : 5;
  }
  mat4 shadowMatrix = mat4(texelFetch(uPunctualMatrices, ivec2(0, slice), 0),
    texelFetch(uPunctualMatrices, ivec2(1, slice), 0),
    texelFetch(uPunctualMatrices, ivec2(2, slice), 0),
    texelFetch(uPunctualMatrices, ivec2(3, slice), 0));
  vec4 clip = shadowMatrix * vec4(position, 1.0);
  vec3 p = clip.xyz / clip.w * 0.5 + 0.5;
  if (clip.w <= 0.0 || p.z <= 0.0 || p.z >= 1.0
    || any(lessThan(p.xy, vec2(0.0))) || any(greaterThan(p.xy, vec2(1.0)))) return 1.0;
  p.xy *= uvScale;
  float shadow = 0.0;
  if (settings.z > 1.5) {
    // Exact integrated 5x5 tent from native359, expanded from nine hardware
    // bilinear comparison fetches into their 36 underlying depth comparisons.
    vec2 texel = p.xy / uPunctualShadowTexel;
    vec2 center = floor(texel + 0.5);
    float wx[6], wy[6];
    envTentWeights(texel.x - center.x, wx);
    envTentWeights(texel.y - center.y, wy);
    for (int y = 0; y < 6; y++) for (int x = 0; x < 6; x++) {
      vec2 uv = (center + vec2(float(x), float(y)) - 2.5) * uPunctualShadowTexel;
      shadow += wx[x] * wy[y] * envShadowCompare(vec3(clamp(uv,
        vec2(uPunctualShadowTexel * 0.5), vec2(uvScale - uPunctualShadowTexel * 0.5)), float(slice)), p.z);
    }
  } else shadow = envShadowCompare(vec3(p.xy, float(slice)), p.z);
  return mix(1.0, shadow, settings.y);
}
vec3 envPunctualLighting(vec3 position, vec3 N, vec3 V, vec3 diffuse,
  vec3 specular, float roughness, float roughness2, vec3 baked, vec3 inputColor) {
  vec3 additional = vec3(0.0);
  vec3 multiplier = vec3(1.0);
  vec4 bakedMask = vec4(1.0);
  if (uEnvHasShadowMask) bakedMask = texture2D(uShadowMask, vEnvLightUv);
  vec3 cameraDelta = position - cameraPosition;
  float shadowFade = clamp(dot(cameraDelta, cameraDelta) * uPunctualShadowFade.x + uPunctualShadowFade.y, 0.0, 1.0);
  float mainShadow = uPunctualMainIndex >= 0
    ? mix(envRealtimeShadow(uPunctualMainIndex, position, vec3(0.0)), 1.0, shadowFade) : 1.0;
  for (int i = 0; i < uPunctualCount; i++) {
    vec4 positionType = envLightData(i, 0);
    vec4 lightColor = envLightData(i, 1);
    vec4 directionRange = envLightData(i, 2);
    vec4 attenuation = envLightData(i, 3);
    vec4 properties = envLightData(i, 4);
    vec4 layers = envLightData(i, 5);
    uint layerMask = uint(layers.x);
    uint cullingMask = uint(layers.y) | (uint(layers.z) << 16u);
    if (lightColor.w == 0.0 || (layerMask & 1u) == 0u
      || ((layerMask >> 4u) & uint(uEnvRenderingLayer)) == 0u
      || (cullingMask & (1u << uint(uEnvUnityLayer))) == 0u) continue;
    bool directional = positionType.w == 1.0;
    vec3 delta = directional ? -directionRange.xyz : positionType.xyz - position;
    float d2 = max(dot(delta, delta), 0.00006103515625);
    if (!directional && d2 > 1.0 / directionRange.w) continue;
    vec3 L = delta * inversesqrt(d2);
    float bakedShadow = attenuation.z >= 0.0 && uEnvReceiveShadows ? bakedMask[int(attenuation.z)] : 1.0;
    float shadow = bakedShadow;
    #ifdef ENV_NATIVE_DEFERRED
      if (envLightData(i, 7).z > 0.5) {
        shadow = envRealtimeShadow(i, position, -delta);
        shadow = envLightData(i, 7).x > 0.5 ? min(mix(shadow, 1.0, shadowFade), bakedShadow)
          : mix(shadow, bakedShadow, shadowFade);
      }
      if (properties.y > 0.0) shadow *= mix(1.0, mainShadow, properties.y);
    #endif
    uint flags = uint(properties.w);
    vec3 indirect = (flags & 16u) != 0u ? baked : vec3(1.0);
    #ifdef ENV_NATIVE_DEFERRED
    if (!directional && (flags & 2u) != 0u) {
      // The native multiply pass uses Zero/SrcColor blending inside its light
      // volume. It has neither inverse-square falloff nor a soft cone edge.
      if (positionType.w != 0.0 || dot(-directionRange.xyz, L) >= envLightData(i, 7).y) {
        multiplier *= mix(lightColor.rgb, vec3(1.0), shadow);
      }
      continue;
    }
    #endif
    float cone = clamp(dot(-directionRange.xyz, L) * attenuation.x + attenuation.y, 0.0, 1.0);
    cone *= cone;
    bool emissionLight = (flags & 1u) != 0u;
    #ifdef ENV_NATIVE_DEFERRED
      emissionLight = emissionLight && !directional;
    #endif
    if (emissionLight) {
      additional += diffuse * indirect * lightColor.rgb * cone * shadow;
      continue;
    }
    float rangeFactor = d2 * directionRange.w;
    float fade = max(1.0 - rangeFactor * rangeFactor, 0.0);
    float distanceAttenuation = directional ? 1.0 : fade * fade / d2;
    vec3 brdf = diffuse * indirect;
    if (properties.z > 0.0) {
      vec3 halfVector = V + L;
      vec3 H = halfVector * inversesqrt(max(dot(halfVector, halfVector), 1e-20));
      float NoH = clamp(dot(N, H), 0.0, 1.0);
      float LoH = clamp(dot(L, H), 0.0, 1.0);
      float d = NoH * NoH * (roughness2 - 1.0) + 1.00001;
      float spec = roughness2 / ((4.0 * roughness + 2.0) * d * d * max(LoH * LoH, 0.1));
      brdf += indirect * specular * spec * properties.z;
    }
    float NoL = clamp(dot(N, L), 0.0, 1.0);
    float back = clamp(dot(N, -L) * 0.5 + 0.5, 0.0, 1.0) * properties.x;
    vec3 direct = brdf * lightColor.rgb * (NoL + back)
      * distanceAttenuation * cone * shadow * attenuation.w;
    #ifndef ENV_NATIVE_DEFERRED
      direct = clamp(direct, vec3(0.0), vec3(100.0));
    #endif
    additional += direct;
  }
  return (inputColor + additional) * multiplier;
}
#endif
`;

const CASTER_VERTEX = /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform vec3 uShadowLightPosition;
uniform vec3 uShadowLightDirection;
uniform bool uShadowPunctual;
uniform vec2 uShadowBias;
uniform vec4 uCasterUvTransform;
#ifdef CASTER_TANGENT_NORMAL
#ifndef USE_TANGENT
attribute vec4 tangent;
#endif
#endif
varying vec2 vCasterUv;
void main() {
  #include <beginnormal_vertex>
  #ifdef CASTER_TANGENT_NORMAL
    objectNormal = tangent.xyz;
  #else
    #include <morphnormal_vertex>
  #endif
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #ifdef USE_INSTANCING
    transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
    objectNormal = mat3(instanceMatrix) * objectNormal;
  #endif
  vec3 world = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec3 normalWorld = normalize(inverseTransformDirection(normalMatrix * objectNormal, viewMatrix));
  vec3 L = uShadowPunctual ? normalize(uShadowLightPosition - world) : uShadowLightDirection;
  world += L * uShadowBias.x + normalWorld * (1.0 - clamp(dot(L, normalWorld), 0.0, 1.0)) * uShadowBias.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  // Programs 913/919 clamp reversed D3D clip Z to the constant 1, not W.
  // zGL = w - 2*zReversed, so retain that distinction for punctual cameras.
  gl_Position.z = max(gl_Position.z, gl_Position.w - 2.0);
  vCasterUv = uv * uCasterUvTransform.xy + uCasterUvTransform.zw;
}`;
const CASTER_FRAGMENT = /* glsl */`
#include <packing>
uniform sampler2D uCasterMap;
uniform bool uCasterHasMap;
uniform float uCasterOpacity;
uniform float uCasterCutoff;
varying vec2 vCasterUv;
void main() {
  float alpha = uCasterOpacity;
  if (uCasterHasMap) alpha *= texture2D(uCasterMap, vCasterUv).a;
  if (alpha < uCasterCutoff) discard;
  gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
}`;

const FACE_DIRECTIONS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_UP = [[0, -1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, -1, 0]];

// All coordinates are the exporter's Three/RH coordinates. Raw Unity layer
// masks select casters; converted shader masks select receivers, not vice versa.
export function createPunctualLighting(meta) {
  const pipeline = { ...NATIVE_RENDER_PIPELINE, ...meta.renderPipeline };
  const lights = (meta.lights || []).filter(light => light.type >= 0 && light.type <= 2 && light.bakeType !== 2);
  const data = new Float32Array(Math.max(1, lights.length) * LIGHT_TEXELS * 4);
  const dataTexture = new THREE.DataTexture(data, LIGHT_TEXELS, Math.max(1, lights.length), THREE.RGBAFormat, THREE.FloatType);
  const slices = [];
  const records = lights.map((light, index) => {
    const position = new THREE.Vector3(...(light.position || [0, 0, 0]));
    const direction = new THREE.Vector3(...(light.direction || [0, -1, 0])).normalize();
    const resolution = light.shadowResolution > 0 ? light.shadowResolution : light.type === 1
      ? pipeline.mainShadowmapResolution
      : pipeline.additionalShadowResolutionTiers[light.shadowResolutionTier ?? 2];
    const firstSlice = light.shadows > 0 ? slices.length : -1;
    const record = { light, index, position, direction, resolution, firstSlice };
    if (firstSlice >= 0) for (let face = 0; face < (light.type === 2 ? 6 : 1); face++) {
      const camera = light.type === 1 ? new THREE.OrthographicCamera() : new THREE.PerspectiveCamera();
      camera.layers.enableAll();
      slices.push({ record, face, camera, matrix: new THREE.Matrix4() });
    }
    return record;
  });
  const resolution = records.reduce((maximum, record) => record.firstSlice >= 0
    ? Math.max(maximum, record.resolution) : maximum, 1);
  const shadowTarget = new THREE.WebGLArrayRenderTarget(resolution, resolution, Math.max(1, slices.length), { depthBuffer: true, stencilBuffer: false });
  shadowTarget.texture.minFilter = THREE.NearestFilter;
  shadowTarget.texture.magFilter = THREE.NearestFilter;
  shadowTarget.texture.generateMipmaps = false;
  shadowTarget.texture.colorSpace = THREE.NoColorSpace;
  const matrixData = new Float32Array(Math.max(1, slices.length) * 16);
  const matrixTexture = new THREE.DataTexture(matrixData, 4, Math.max(1, slices.length), THREE.RGBAFormat, THREE.FloatType);
  const shadowDistance = pipeline.shadowDistance ?? 15;
  const fadeBorder = pipeline.cascadeBorder ?? 0.2;
  const fadeStart = shadowDistance * (1 - fadeBorder);
  const fadeScale = fadeBorder < 0.0001 ? 1000
    : 1 / (shadowDistance * shadowDistance - fadeStart * fadeStart);
  let mainIndex = -1;
  for (let i = 0; i < lights.length; i++) if (lights[i].type === 1
    && (mainIndex < 0 || lights[i].intensity > lights[mainIndex].intensity)) mainIndex = i;
  const uniforms = {
    uPunctualData: { value: dataTexture }, uPunctualMatrices: { value: matrixTexture },
    uPunctualShadows: { value: shadowTarget.texture }, uPunctualCount: { value: lights.length },
    uPunctualShadowTexel: { value: 1 / resolution },
    uPunctualShadowFade: { value: new THREE.Vector2(fadeScale,
      -(fadeBorder < 0.0001 ? shadowDistance * shadowDistance : fadeStart * fadeStart) * fadeScale) },
    uPunctualMainIndex: { value: mainIndex },
  };
  const materialCache = new Map();
  const color = new THREE.Color(), target = new THREE.Vector3();
  const bounds = new THREE.Box3(), center = new THREE.Vector3(), size = new THREE.Vector3();
  const savedViewport = new THREE.Vector4(), savedScissor = new THREE.Vector4(), savedClearColor = new THREE.Color();
  const savedCurrentViewport = new THREE.Vector4(), savedCurrentScissor = new THREE.Vector4();
  const savedTargetViewport = new THREE.Vector4(), savedTargetScissor = new THREE.Vector4();
  const savedMeshes = [];
  let disposed = false;
  let checkedRenderer = null;
  const noCallback = () => {};
  const identityUv = new THREE.Vector4(1, 1, 0, 0);

  function updateLights() {
    const hasAdditionalShadows = records.some(({ light, firstSlice }) => firstSlice >= 0
      && light.type !== 1 && light.shadows > 0 && light.enabled !== false && light.enabled !== 0);
    for (const record of records) {
      const { light, index, position, direction, firstSlice, resolution: lightResolution } = record;
      position.fromArray(light.position || [0, 0, 0]);
      direction.fromArray(light.direction || [0, -1, 0]).normalize();
      const offset = index * LIGHT_TEXELS * 4;
      const outer = (light.spotAngle ?? 30) * Math.PI / 360;
      const inner = light.innerSpotAngle == null ? Math.atan(Math.tan(outer) * 46 / 64) : light.innerSpotAngle * Math.PI / 360;
      const coneScale = light.type === 0 ? 1 / Math.max(Math.cos(inner) - Math.cos(outer), 0.001) : 0;
      color.fromArray(light.color || [1, 1, 1]).convertSRGBToLinear().multiplyScalar(light.intensity ?? 1);
      const culling = (light.cullingMask ?? 0xffffffff) >>> 0;
      const rawLayers = light.renderingLayerMask ?? 1;
      const mask = light.shaderLayerMask ?? ((rawLayers & 0xf00) ? rawLayers : rawLayers | 0x10);
      const mixed = light.isBaked && light.bakeType === 1 && light.mixedLightingMode === 1;
      data.set([position.x, position.y, position.z, light.type,
        color.r, color.g, color.b,
        light.enabled === false || light.enabled === 0 || (mixed && index !== mainIndex) ? 0 : 1,
        direction.x, direction.y, direction.z, light.type === 1 ? 0 : 1 / (light.range * light.range),
        coneScale, light.type === 0 ? -Math.cos(outer) * coneScale : 1,
        light.bakeType === 1 ? light.occlusionMaskChannel ?? -1 : -1, mixed ? 0 : 1,
        ...(light.customProperties || [0, 0, 1, 0]),
        mask, culling & 65535, culling >>> 16, 0,
        light.shadows > 0 && light.enabled !== false && light.enabled !== 0 ? firstSlice : -1,
        // Native stencil punctual107/359 always uses its integrated 5x5 filter;
        // the screen-space main-light pass has a separate hard-shadow variant.
        light.shadowStrength ?? 1, light.type === 1 ? light.shadows ?? 0 : 2, lightResolution / resolution,
        pipeline.shadowmaskMode === 0 ? 1 : 0, Math.cos(outer),
        light.type === 1 ? (light.shadows > 0 ? 1 : 0) : hasAdditionalShadows ? 1 : 0, 0], offset);
    }
    dataTexture.needsUpdate = true;
  }

  function casterMaterial(source, mode) {
    let variants = materialCache.get(source);
    if (!variants) {
      variants = new Map();
      materialCache.set(source, variants);
      variants.onSourceDispose = () => {
        for (const material of variants.values()) material.dispose();
        materialCache.delete(source);
        source.removeEventListener('dispose', variants.onSourceDispose);
      };
      source.addEventListener('dispose', variants.onSourceDispose);
    }
    let material = variants.get(mode);
    if (!material) {
      material = new THREE.ShaderMaterial({
        name: `${source.name}:native-shadow`, vertexShader: CASTER_VERTEX, fragmentShader: CASTER_FRAGMENT,
        defines: source.userData.nativeShadowCaster?.tangentNormal ? { CASTER_TANGENT_NORMAL: 1 } : {},
        side: mode === 2 ? THREE.DoubleSide : source.side, toneMapped: false, blending: THREE.NoBlending,
        uniforms: {
          uShadowLightPosition: { value: new THREE.Vector3() }, uShadowLightDirection: { value: new THREE.Vector3() },
          uShadowPunctual: { value: false }, uShadowBias: { value: new THREE.Vector2() },
          uCasterUvTransform: { value: new THREE.Vector4(1, 1, 0, 0) },
          uCasterMap: { value: null }, uCasterHasMap: { value: false },
          uCasterOpacity: { value: 1 }, uCasterCutoff: { value: 0 },
        },
      });
      variants.set(mode, material);
    }
    const u = source.uniforms || {}, shadow = source.userData.nativeShadowCaster;
    material.visible = source.visible;
    material.uniforms.uCasterMap.value = shadow?.map ?? u.uBaseMap?.value ?? source.map ?? null;
    material.uniforms.uCasterHasMap.value = !!material.uniforms.uCasterMap.value;
    material.uniforms.uCasterOpacity.value = shadow?.opacity ?? u.uBaseColor?.value?.w ?? source.opacity ?? 1;
    material.uniforms.uCasterCutoff.value = shadow?.cutoff ?? (u.uAlphaClip ? (u.uAlphaClip.value > 0.5 ? u.uCutoff.value : 0) : source.alphaTest || 0);
    material.uniforms.uCasterUvTransform.value.copy(shadow?.uvTransform ?? u.uUvTransform?.value ?? identityUv);
    return material;
  }

  function renderShadows(renderer, scene, camera) {
    if (disposed) return;
    updateLights();
    if (checkedRenderer !== renderer) {
      const gl = renderer.getContext();
      if (!renderer.capabilities.isWebGL2 || slices.length > gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)
        || resolution > renderer.capabilities.maxTextureSize || lights.length > renderer.capabilities.maxTextureSize) {
        throw new Error('Native environment lighting exceeds this renderer\'s texture capacity');
      }
      checkedRenderer = renderer;
    }
    if (!slices.length) return;
    scene.updateMatrixWorld(true);
    bounds.makeEmpty();
    scene.traverseVisible(object => {
      if (!object.isMesh && !object.isLine && !object.isPoints && !object.isSprite) return;
      if (object.isMesh && (object.userData.castShadows !== undefined || object.userData.receiveShadows !== undefined)) {
        bounds.expandByObject(object);
      }
      savedMeshes.push({ object, material: object.material, layerMask: object.layers.mask,
        frustumCulled: object.frustumCulled, before: object.onBeforeRender, after: object.onAfterRender });
    });
    if (bounds.isEmpty()) bounds.setFromCenterAndSize(camera.position, size.set(1, 1, 1));
    bounds.getCenter(center); bounds.getSize(size);
    const oldTarget = renderer.getRenderTarget(), oldFace = renderer.getActiveCubeFace(), oldMip = renderer.getActiveMipmapLevel();
    renderer.getViewport(savedViewport); renderer.getScissor(savedScissor); renderer.getClearColor(savedClearColor);
    const oldScissorTest = renderer.getScissorTest(), oldClearAlpha = renderer.getClearAlpha();
    let oldTargetScissorTest, oldCurrentScissorTest;
    if (oldTarget) {
      const gl = renderer.getContext();
      renderer.getCurrentViewport(savedCurrentViewport);
      savedCurrentScissor.fromArray(gl.getParameter(gl.SCISSOR_BOX));
      oldCurrentScissorTest = gl.isEnabled(gl.SCISSOR_TEST);
      savedTargetViewport.copy(oldTarget.viewport); savedTargetScissor.copy(oldTarget.scissor);
      oldTargetScissorTest = oldTarget.scissorTest;
    }
    const oldAutoClear = renderer.autoClear, oldXr = renderer.xr.enabled;
    const oldShadowAuto = renderer.shadowMap.autoUpdate, oldShadowEnabled = renderer.shadowMap.enabled;
    const oldBackground = scene.background, oldOverride = scene.overrideMaterial;
    try {
      renderer.xr.enabled = false; renderer.autoClear = false;
      renderer.shadowMap.autoUpdate = false; renderer.shadowMap.enabled = false;
      scene.background = null; scene.overrideMaterial = null;
      renderer.setClearColor(0xffffff, 1);
      for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex++) {
        const { record, face, camera: shadowCamera, matrix } = slices[sliceIndex];
        const { light, position, direction } = record;
        if (light.shadows <= 0 || light.enabled === false || light.enabled === 0) continue;
        let frustumSize;
        if (light.type === 1) {
          const radius = Math.max(size.length() * 0.5, 0.01);
          shadowCamera.position.copy(center).addScaledVector(direction, -radius * 2);
          shadowCamera.up.set(0, Math.abs(direction.y) > 0.99 ? 0 : 1, Math.abs(direction.y) > 0.99 ? 1 : 0);
          shadowCamera.lookAt(center);
          shadowCamera.left = shadowCamera.bottom = -radius;
          shadowCamera.right = shadowCamera.top = radius;
          shadowCamera.near = light.shadowNearPlane ?? 0.1; shadowCamera.far = radius * 4;
          frustumSize = radius * 2;
        } else {
          shadowCamera.position.copy(position);
          if (light.type === 2) {
            target.fromArray(FACE_DIRECTIONS[face]).add(position);
            shadowCamera.up.fromArray(FACE_UP[face]);
          } else {
            target.copy(position).add(direction);
            shadowCamera.up.set(0, Math.abs(direction.y) > 0.99 ? 0 : 1, Math.abs(direction.y) > 0.99 ? 1 : 0);
          }
          shadowCamera.lookAt(target);
          shadowCamera.fov = light.type === 2
            ? 90 + nativePointShadowFovBias(record.resolution, light.shadows === 2) : light.spotAngle;
          shadowCamera.aspect = 1; shadowCamera.near = light.shadowNearPlane ?? 0.1;
          shadowCamera.far = light.range;
          frustumSize = Math.tan(shadowCamera.fov * Math.PI / 360) * light.range;
        }
        shadowCamera.updateProjectionMatrix(); shadowCamera.updateMatrixWorld(true);
        matrix.multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
        matrix.toArray(matrixData, sliceIndex * 16);
        const texelSize = frustumSize / record.resolution;
        const quality = light.softShadowQuality || pipeline.softShadowQuality || 2;
        const kernel = light.shadows === 2 ? quality === 1 ? 1.5 : quality === 3 ? 3.5 : 2.5 : 1;
        const usePipeline = light.usePipelineShadowSettings;
        const depthBias = -(usePipeline ? pipeline.shadowDepthBias ?? 1 : light.shadowBias ?? 1) * texelSize * kernel;
        const normalBias = light.type === 2 ? 0
          : -(usePipeline ? pipeline.shadowNormalBias ?? 0.1 : light.shadowNormalBias ?? 0.1) * texelSize * kernel;
        for (const saved of savedMeshes) {
          const object = saved.object, userData = object.userData;
          const mode = userData.castShadows ?? 0;
          const casterLayers = userData.renderingLayerMask ?? 1;
          const shadowLayers = light.shadowRenderingLayerMask ?? light.renderingLayerMask ?? 1;
          const culling = (light.cullingMask ?? 0xffffffff) >>> 0;
          const casts = object.isMesh && mode !== 0 && (casterLayers & shadowLayers) !== 0
            && (culling & (1 << (userData.unityLayer ?? 0))) !== 0;
          // Camera layers suppress only this drawable, unlike visible=false,
          // which would incorrectly suppress independently selected children.
          object.layers.mask = casts ? -1 : 0;
          object.onBeforeRender = object.onAfterRender = noCallback;
          object.frustumCulled = false;
          if (!casts) continue;
          const convert = source => {
            const material = casterMaterial(source, mode), u = material.uniforms;
            u.uShadowLightPosition.value.copy(position); u.uShadowLightDirection.value.copy(direction).negate();
            u.uShadowPunctual.value = light.type !== 1; u.uShadowBias.value.set(depthBias, normalBias);
            return material;
          };
          object.material = Array.isArray(saved.material) ? saved.material.map(convert) : convert(saved.material);
        }
        renderer.setRenderTarget(shadowTarget, sliceIndex);
        renderer.setViewport(0, 0, record.resolution, record.resolution); renderer.setScissorTest(false);
        renderer.clear(true, true, false); renderer.render(scene, shadowCamera);
      }
      matrixTexture.needsUpdate = true;
    } finally {
      for (const saved of savedMeshes) {
        saved.object.material = saved.material; saved.object.layers.mask = saved.layerMask;
        saved.object.frustumCulled = saved.frustumCulled;
        saved.object.onBeforeRender = saved.before; saved.object.onAfterRender = saved.after;
      }
      savedMeshes.length = 0;
      scene.background = oldBackground; scene.overrideMaterial = oldOverride;
      renderer.autoClear = oldAutoClear; renderer.xr.enabled = oldXr;
      renderer.shadowMap.autoUpdate = oldShadowAuto; renderer.shadowMap.enabled = oldShadowEnabled;
      renderer.setViewport(savedViewport); renderer.setScissor(savedScissor); renderer.setScissorTest(oldScissorTest);
      // setViewport changes Three's global viewport, while setRenderTarget
      // restores a separate target-local viewport. Preserve both, including
      // callers rendering to an already-bound postprocessing target.
      if (oldTarget) {
        oldTarget.viewport.copy(savedCurrentViewport); oldTarget.scissor.copy(savedCurrentScissor);
        oldTarget.scissorTest = oldCurrentScissorTest;
        try { renderer.setRenderTarget(oldTarget, oldFace, oldMip); }
        finally {
          oldTarget.viewport.copy(savedTargetViewport); oldTarget.scissor.copy(savedTargetScissor);
          oldTarget.scissorTest = oldTargetScissorTest;
        }
      } else renderer.setRenderTarget(null, oldFace, oldMip);
      renderer.setClearColor(savedClearColor, oldClearAlpha);
    }
  }
  updateLights();
  return { uniforms, renderShadows,
    get hasActorShadows() {
      return !disposed && records.some(({ light, firstSlice }) => firstSlice >= 0
        && light.enabled !== false && light.enabled !== 0 && light.shadows > 0 && (light.shadowStrength ?? 1) > 0
        && ((light.shadowRenderingLayerMask ?? light.renderingLayerMask ?? 1) & 4) !== 0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      shadowTarget.dispose(); dataTexture.dispose(); matrixTexture.dispose();
      for (const [source, variants] of materialCache) {
        source.removeEventListener('dispose', variants.onSourceDispose);
        for (const material of variants.values()) material.dispose();
      }
      materialCache.clear(); savedMeshes.length = 0;
    },
  };
}
