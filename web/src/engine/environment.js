import * as THREE from 'three';

// Unity's baked cubemaps already contain roughness-filtered mip levels. Keep
// both their radiance range and mip chain; a PNG or a second PMREM loses them.
export function createEnvironmentProbes(meta, textures, ownedTextures) {
  const cubes = new Map();
  const upload = (probe) => {
    let texture = cubes.get(probe.cubeRef);
    if (!texture) {
      const source = textures.get(probe.cubeRef);
      if (!source?.isCubemap || source.type !== 'half-float') {
        throw new Error(`Missing HDR reflection cubemap: ${probe.cubeRef}`);
      }
      const images = source.mipmaps.map((level) => level.faces.map((data) =>
        new THREE.DataTexture(data, level.width, level.height, THREE.RGBAFormat, THREE.HalfFloatType)));
      texture = new THREE.CubeTexture(images[0]);
      texture.name = probe.cubeRef;
      texture.type = THREE.HalfFloatType;
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = images.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.mipmaps = images.slice(1).map((image) => ({ image }));
      texture.needsUpdate = true;
      cubes.set(probe.cubeRef, texture);
      ownedTextures.add(texture);
    }
    return { ...probe, texture, maxMip: texture.mipmaps.length };
  };
  return {
    probes: (meta.reflectionProbes || []).map(upload),
    defaultReflection: meta.defaultReflection ? upload(meta.defaultReflection) : null,
  };
}

function coverage(bounds, min, max) {
  let weight = 1;
  for (let axis = 0; axis < 3; axis++) {
    const extent = bounds.max[axis] - bounds.min[axis];
    if (extent <= 1e-6) {
      if (bounds.min[axis] < min[axis] || bounds.min[axis] > max[axis]) return 0;
    } else {
      weight *= Math.max(0, Math.min(bounds.max[axis], max[axis])
        - Math.max(bounds.min[axis], min[axis])) / extent;
    }
  }
  return weight;
}


// The shipped Environment/Default LIGHTMAP_ON variant samples only SpecCube0:
// it has no reflection-probe-blending variant. Keep selection renderer-local.
export function selectEnvironmentProbe(probes, reflection) {
  if (!reflection || reflection.usage === 0) return null;
  const bounds = reflection.bounds || { min: reflection.anchor, max: reflection.anchor };
  if (!bounds.min || !bounds.max) return null;
  let selected = null, bestCoverage = 0, bestVolume = Infinity;
  for (const probe of probes) {
    const weight = coverage(bounds, probe.boxMin, probe.boxMax);
    if (weight <= 0) continue;
    const volume = (probe.boxMax[0] - probe.boxMin[0]) * (probe.boxMax[1] - probe.boxMin[1])
      * (probe.boxMax[2] - probe.boxMin[2]);
    if (!selected || probe.importance > selected.importance
      || (probe.importance === selected.importance
        && (weight > bestCoverage || (weight === bestCoverage && volume < bestVolume)))) {
      selected = probe;
      bestCoverage = weight;
      bestVolume = volume;
    }
  }
  return selected;
}

const ENV_VERTEX = /* glsl */`
#include <common>
#ifndef USE_UV1
attribute vec2 uv1;
#endif
#ifdef ENV_TANGENT
#ifndef USE_TANGENT
attribute vec4 tangent;
#endif
varying vec4 vEnvTangent;
#endif
varying vec2 vEnvUv;
varying vec2 vEnvLightUv;
varying vec3 vEnvPosition;
varying vec3 vEnvNormal;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vEnvPosition = world.xyz;
  vEnvNormal = inverseTransformDirection(normalMatrix * normal, viewMatrix);
  #ifdef ENV_TANGENT
    vEnvTangent = vec4(normalize(mat3(modelMatrix) * tangent.xyz), tangent.w);
  #endif
  vEnvUv = uv;
  vEnvLightUv = uv1;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

// Ported from shipped Environment/Default, Universal Forward, LIGHTMAP_ON
// fragment blob 280. DefMap is R metallic, G emission, B indirect mask, A
// smoothness; _Metallic/_Smoothness are stale saved properties, not uniforms.
const ENV_FRAGMENT = /* glsl */`
#include <common>
uniform sampler2D uBaseMap;
uniform sampler2D uNormalMap;
uniform sampler2D uDefMap;
uniform sampler2D uLightmap;
uniform vec4 uUvTransform;
uniform vec4 uBaseColor;
uniform vec4 uDefValue;
uniform vec3 uEmissionColor;
uniform float uEmissionAlbedoScale;
uniform float uBumpScale;
uniform float uCutoff;
uniform float uLightmapIntensity;
uniform vec3 uLightmapColor;
uniform vec3 uMainDirection;
uniform vec3 uMainColor;
uniform vec4 uMainProperties;
uniform float uMixedAttenuation;
#ifdef ENV_SHADOWMASK
uniform sampler2D uShadowMask;
uniform vec4 uOcclusionChannel;
#endif
#ifdef ENV_PROBE
uniform samplerCube uProbe;
uniform vec3 uProbePosition;
uniform vec3 uProbeBoxMin;
uniform vec3 uProbeBoxMax;
uniform float uProbeIntensity;
uniform bool uBoxProjection;
#endif
varying vec2 vEnvUv;
varying vec2 vEnvLightUv;
varying vec3 vEnvPosition;
varying vec3 vEnvNormal;
#ifdef ENV_TANGENT
varying vec4 vEnvTangent;
#endif

void main() {
  vec2 texUv = vEnvUv * uUvTransform.xy + uUvTransform.zw;
  vec4 base = uBaseColor;
  #ifdef ENV_BASE
    base *= texture2D(uBaseMap, texUv);
  #endif
  #ifdef ENV_ALPHA_CLIP
    if (base.a < uCutoff) discard;
  #endif
  vec3 N = normalize(vEnvNormal);
  #ifdef ENV_NORMAL
    vec4 packedNormal = texture2D(uNormalMap, texUv);
    vec2 nxy = vec2(packedNormal.r * packedNormal.a, packedNormal.g) * 2.0 - 1.0;
    float nz = sqrt(1.0 - min(dot(nxy, nxy), 1.0));
    nz = mix(1.0, nz, clamp(uBumpScale, 0.0, 1.0));
    // Export flips V; its tangent basis therefore has the opposite bitangent.
    vec3 n = vec3(nxy * vec2(uBumpScale, -uBumpScale), nz);
    #ifdef ENV_TANGENT
      vec3 T = vEnvTangent.xyz;
      vec3 B = cross(vEnvNormal, T) * vEnvTangent.w;
      N = normalize(T * n.x + B * n.y + vEnvNormal * n.z);
    #else
      vec3 q0 = dFdx(vEnvPosition), q1 = dFdy(vEnvPosition);
      vec2 st0 = dFdx(vEnvUv), st1 = dFdy(vEnvUv);
      vec3 q1p = cross(q1, N), q0p = cross(N, q0);
      vec3 T = q1p * st0.x + q0p * st1.x;
      vec3 B = q1p * st0.y + q0p * st1.y;
      float basisScale = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
      N = normalize(T * (n.x * basisScale) + B * (n.y * basisScale) + N * n.z);
    #endif
  #endif
  vec4 def = uDefValue;
  #ifdef ENV_DEF
    def *= texture2D(uDefMap, texUv);
  #endif
  float metallic = clamp(def.r, 0.0, 1.0);
  float smoothness = clamp(def.a, 0.0, 1.0);
  float oneMinusReflectivity = 0.96 * (1.0 - metallic);
  vec3 diffuse = base.rgb * oneMinusReflectivity;
  vec3 specular = mix(vec3(0.04), base.rgb, metallic);
  float perceptualRoughness = 1.0 - smoothness;
  float roughness = max(perceptualRoughness * perceptualRoughness, 0.0078125);
  float roughness2 = roughness * roughness;
  vec3 V = isOrthographic ? normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]))
    : normalize(cameraPosition - vEnvPosition);
  vec3 baked = texture2D(uLightmap, vEnvLightUv).rgb;
  vec3 scaleColor = uLightmapColor * uLightmapIntensity;
  vec3 color = baked * scaleColor * diffuse * mix(diffuse, vec3(1.0), def.b);
  #ifdef ENV_PROBE
    vec3 R = reflect(-V, N);
    if (uBoxProjection) {
      // Ray exit from the probe's world-axis-aligned room box. Zero components
      // cannot limit the exit; avoid 0/0 at a wall without changing ray signs.
      vec3 face = mix(uProbeBoxMin, uProbeBoxMax, greaterThan(R, vec3(0.0)));
      vec3 distanceToFace = face - vEnvPosition;
      vec3 travel;
      travel.x = abs(R.x) < 1e-7 ? 1e20 : distanceToFace.x / R.x;
      travel.y = abs(R.y) < 1e-7 ? 1e20 : distanceToFace.y / R.y;
      travel.z = abs(R.z) < 1e-7 ? 1e20 : distanceToFace.z / R.z;
      R = R * min(min(travel.x, travel.y), travel.z) + vEnvPosition - uProbePosition;
    }
    // Raw Unity cubemap faces are unflipped; only the world Z reflection is undone.
    float lod = perceptualRoughness * (1.7 - 0.7 * perceptualRoughness) * 6.0;
    vec3 radiance = textureLod(uProbe, vec3(R.x, R.y, -R.z), lod).rgb * uProbeIntensity;
    float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
    float grazing = clamp(smoothness + 1.0 - oneMinusReflectivity, 0.0, 1.0);
    color += radiance * scaleColor * mix(specular, vec3(grazing), fresnel) * def.b / (roughness2 + 1.0);
  #endif
  #ifdef ENV_MAIN_LIGHT
    vec3 indirect = uMainProperties.w >= 16.0 ? baked : vec3(1.0);
    float flags = mod(uMainProperties.w, 16.0);
    float shadow = 1.0;
    #ifdef ENV_SHADOWMASK
      shadow = min(1.0, 1.0 + dot(texture2D(uShadowMask, vEnvLightUv) - 1.0, uOcclusionChannel));
    #endif
    vec3 direct;
    if (mod(flags, 2.0) >= 1.0) {
      direct = indirect * diffuse * uMainColor * shadow;
    } else {
      vec3 brdf = indirect * diffuse;
      if (uMainProperties.z > 0.0) {
        vec3 H = normalize(V + uMainDirection);
        float NoH = clamp(dot(N, H), 0.0, 1.0);
        float LoH = clamp(dot(uMainDirection, H), 0.0, 1.0);
        float d = NoH * NoH * (roughness2 - 1.0) + 1.00001;
        float spec = roughness2 / ((4.0 * roughness + 2.0) * d * d * max(LoH * LoH, 0.1));
        brdf += indirect * specular * spec * uMainProperties.z;
      }
      direct = clamp(dot(N, uMainDirection), 0.0, 1.0) * uMainColor * brdf;
      direct += brdf * uMainColor * clamp(dot(N, -uMainDirection) * 0.5 + 0.5, 0.0, 1.0) * uMainProperties.x;
      direct *= shadow * uMixedAttenuation;
      direct = clamp(direct, vec3(0.0), vec3(100.0));
    }
    color += direct;
  #endif
  color += max(def.g - 0.02, 0.0) * uEmissionColor * mix(vec3(1.0), base.rgb, uEmissionAlbedoScale);
  #ifdef ENV_BLEND
    gl_FragColor = vec4(color, base.a);
  #else
    gl_FragColor = vec4(color, 1.0);
  #endif
  #include <colorspace_fragment>
}`;

export function createEnvironmentMaterial({ name, description, info, geometry, albedo, normalMap, defMap,
  lightMap, shadowMap, reflections, lighting, tint, opacity, side, transparent, alphaTest, mainLight }) {
  const colors = description.colors || {}, floats = description.floats || {};
  const tiling = colors._Tiling || [1, 1], offset = colors._Offset || [0, 0];
  const probe = selectEnvironmentProbe(reflections.probes, info.reflection) || reflections.defaultReflection;
  const defines = {};
  if (albedo) defines.ENV_BASE = 1;
  if (normalMap) defines.ENV_NORMAL = 1;
  if (defMap) defines.ENV_DEF = 1;
  if (geometry.attributes.tangent) defines.ENV_TANGENT = 1;
  if (probe) defines.ENV_PROBE = 1;
  if (transparent) defines.ENV_BLEND = 1;
  if (alphaTest > 0) defines.ENV_ALPHA_CLIP = 1;
  const lightMask = mainLight?.shaderLayerMask || 0;
  const objectMask = ((info.renderingLayerMask ?? 1) >>> 4 & 254) | 1;
  if ((lightMask & 1) && ((lightMask >>> 4) & objectMask)) defines.ENV_MAIN_LIGHT = 1;
  const channel = mainLight?.occlusionMaskChannel ?? -1;
  const occlusion = new THREE.Vector4(0, 0, 0, 0);
  if (shadowMap && mainLight?.bakeType === 1 && channel >= 0 && channel < 4) {
    defines.ENV_SHADOWMASK = 1;
    occlusion.setComponent(channel, 1);
  }
  const uniforms = {
    ...lighting,
    uBaseMap: { value: albedo }, uNormalMap: { value: normalMap }, uDefMap: { value: defMap },
    uLightmap: { value: lightMap },
    uUvTransform: { value: new THREE.Vector4(tiling[0], tiling[1], offset[0], 1 - tiling[1] - offset[1]) },
    uBaseColor: { value: new THREE.Vector4(tint.r, tint.g, tint.b, opacity) },
    uDefValue: { value: new THREE.Vector4(...(colors._DefValue || [1, 1, 1, 1])) },
    uEmissionColor: { value: new THREE.Vector3(...(colors._EmissionColor || [0, 0, 0])) },
    uEmissionAlbedoScale: { value: floats._EmissionAlbedoScale ?? 0 },
    uBumpScale: { value: floats._BumpScale ?? 1 }, uCutoff: { value: alphaTest },
    uMainDirection: { value: new THREE.Vector3(...(mainLight?.direction || [0, -1, 0])).negate().normalize() },
    uMainColor: { value: new THREE.Color(...(mainLight?.color || [0, 0, 0])).convertSRGBToLinear().multiplyScalar(mainLight?.intensity || 0) },
    uMainProperties: { value: new THREE.Vector4(...(mainLight?.customProperties || [0, 0, 1, 0])) },
    uShadowMask: { value: shadowMap }, uOcclusionChannel: { value: occlusion },
    uMixedAttenuation: { value: mainLight?.isBaked && mainLight.bakeType === 1
      && mainLight.mixedLightingMode === 1 ? 0 : 1 },
  };
  if (probe) Object.assign(uniforms, {
    uProbe: { value: probe.texture },
    uProbePosition: { value: new THREE.Vector3(...(probe.position || [0, 0, 0])) },
    uProbeBoxMin: { value: new THREE.Vector3(...(probe.boxMin || [0, 0, 0])) },
    uProbeBoxMax: { value: new THREE.Vector3(...(probe.boxMax || [0, 0, 0])) },
    uProbeIntensity: { value: probe.intensity }, uBoxProjection: { value: !!probe.boxProjection },
  });
  const material = new THREE.ShaderMaterial({ name, defines, uniforms,
    vertexShader: ENV_VERTEX, fragmentShader: ENV_FRAGMENT, side, transparent,
    depthWrite: !transparent, toneMapped: false });
  material.userData.environmentProbe = probe?.cubeRef || null;
  return material;
}
