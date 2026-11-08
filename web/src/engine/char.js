// Authentic Campus/Actor/Default character renderer.
//
// Implements the game's actual cel-shading, stencil face/eye/bangs pipeline,
// vertex-color 12-bit artist outlines along TANGENT.xyz, hair _DefMap.a specular
// highlight band, smooth head-normal face shading, and CampusActorFaceCorrection
// view-angle profile morph targets.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PoseSolver } from './pose.js';
import { getBrowserEnv } from '../runtime/bundle_env.js';
import { buildCharFromBundles } from '../runtime/bundle_loaders.js';

const OUTLINE_SCALE = parseFloat(new URLSearchParams(location.search).get('outline') ?? '1.0');
const STENCIL_MASK = 108; // 0x6C (bits 2, 3, 5, 6 used by Campus/Actor/Default)

// Shared 1x1 white & black fallbacks; never disposed with character-owned textures.
function solidTex(r, g, b, a = 255, srgb = false) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
const WHITE_SRGB = solidTex(255, 255, 255, 255, true);
const BLACK_SRGB = solidTex(0, 0, 0, 255, true);

/**
 * Wrap a decoded bundle texture (row 0 = top of the source image, exactly like
 * a TextureLoader image with flipY = false) in a character-owned THREE.DataTexture.
 */
function texFromBundle(resources, rel, srgb, clamp = false) {
  const ckey = `${rel}|${srgb ? 1 : 0}|${clamp ? 1 : 0}`;
  let tex = resources.textureCache.get(ckey);
  if (!tex) {
    const entry = resources.bundleTextures?.get(rel);
    if (!entry) return null;
    tex = new THREE.DataTexture(entry.data, entry.width, entry.height, THREE.RGBAFormat);
    resources.textureCache.set(ckey, tex);
    tex.flipY = false;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
  }
  return tex;
}

function loadMap(resources, desc, key, srgb, clamp = false) {
  const rel = desc && desc.maps && desc.maps[key];
  if (!rel) return null;
  return texFromBundle(resources, rel, srgb, clamp);
}

// View-space light direction from VLActorParameter / VLActorShadow angles (deg):
// x = horizontal yaw (+x -> viewer's right +X), y = vertical elevation (+y -> up +Y).
function viewDirFromAngles(yawXDeg, elevYDeg, target = new THREE.Vector3()) {
  const D2R = Math.PI / 180;
  const ax = yawXDeg * D2R;
  const ay = elevYDeg * D2R;
  return target.set(
    Math.sin(ax) * Math.cos(ay),
    Math.sin(ay),
    Math.cos(ax) * Math.cos(ay),
  ).normalize();
}

// Constructor defaults of VLActorParameter and VLActorShadow.
const DEFAULT_ACTOR_LIGHT = {
  lightDirView: viewDirFromAngles(-7, 7),
  rimDirView: viewDirFromAngles(0, 0),
  shadowAngles: { x: 0, y: 0 },
  lightColor: new THREE.Color(1, 1, 1),
  shadeMultiply: new THREE.Color(1, 1, 1),
  rimPower: 8,
  rimBaseRatio: 1,
};

// Campus/Actor/Default ShadowCaster: artist tangent normal, no alpha test
// unless the material enables the native _ALPHATEST_ON variant.
const SHADOW_CASTER_VERT = /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
attribute vec4 tangent;
uniform mat4 uActorShadowMatrix;
uniform vec3 uShadowLightDirection;
uniform vec2 uShadowBias;
varying vec2 vUv;
void main() {
  vUv = uv;
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinbase_vertex>
  #include <skinning_vertex>
  vec3 artistNormal = normalize(tangent.xyz);
  #ifdef USE_SKINNING
    mat4 skinMatrix = skinWeight.x * boneMatX + skinWeight.y * boneMatY
      + skinWeight.z * boneMatZ + skinWeight.w * boneMatW;
    artistNormal = (bindMatrixInverse * skinMatrix * bindMatrix * vec4(artistNormal, 0.0)).xyz;
  #endif
  vec3 normalWorld = normalize(normalMatrix * artistNormal);
  vec3 positionWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  positionWorld += uShadowLightDirection * uShadowBias.x;
  positionWorld += normalWorld * (1.0 - clamp(dot(uShadowLightDirection, normalWorld), 0.0, 1.0)) * uShadowBias.y;
  gl_Position = uActorShadowMatrix * vec4(positionWorld, 1.0);
  gl_Position.z = max(gl_Position.z, -gl_Position.w);
}
`;

const SHADOW_CASTER_FRAG = /* glsl */`
#include <common>
#include <packing>
uniform sampler2D uBaseMap;
uniform float uAlphaClip;
uniform float uCutoff;
varying vec2 vUv;
void main() {
  if (uAlphaClip > 0.5 && texture2D(uBaseMap, vUv).a < uCutoff) discard;
  gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
}
`;
// ---------------- Campus/Actor/Default GLSL ----------------
const ACTOR_VERT = /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>

attribute vec4 color;
varying vec2 vUv;
varying vec3 vNormalView;
varying vec3 vWorldPos;
varying vec4 vColor;

void main() {
  vUv = uv;
  vColor = color;

  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>

  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorldPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  vNormalView = normalize(transformedNormal);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const ACTOR_FRAG = /* glsl */`
#include <common>
#include <packing>
uniform sampler2D uBaseMap, uShadeMap, uDefMap, uRampMap, uHighlightMap, uLayerMap;
uniform sampler2D uActorShadowMap;
uniform samplerCube uReflectionCube, uEyeReflectionCube;
uniform mat4 uActorShadowMatrix;
uniform mat3 uViewToWorld;
uniform vec4 uBaseColor, uMultiplyColor, uFadeParam, uDefValue;
uniform vec3 uLightDirView, uLightColor, uShadeMultiply, uShadeAdditive;
uniform vec3 uRimDirView, uRimColor, uHeadFrontView, uHeadRightView, uHeadUpView;
uniform vec3 uReflectionColor, uEyeReflectionColor, uEyeHighlightColor;
uniform vec3 uSH[9];
uniform vec4 uShadowParams;
uniform vec2 uShadowTexelSize, uSpecThreshold;
uniform float uShaderType, uAlphaClip, uCutoff, uRimPower, uRimBaseRatio;
uniform float uOpaqueCoverage, uHasShade, uHasDef, uCheekWeight;
uniform float uReceiveActorShadow, uMatCapOffset, uShadeRatio, uSkinSaturation;
uniform float uGIScale, uAdditionalScale, uAdditionalSpecularScale, uWorldLight;
uniform float uHasReflection, uHasEyeReflection, uReflectionMode, uOrthographic;
uniform int uSceneLightCount;
uniform vec4 uSceneLightPositions[8], uSceneLightColors[8];
uniform vec4 uSceneLightAttenuations[8], uSceneLightDirections[8];
uniform float uSceneLightEnabled[8];
varying vec2 vUv;
varying vec3 vNormalView, vWorldPos;
varying vec4 vColor;

// Bilinear comparison filtering, not bilinear interpolation of packed depths.
float shadowCompare(vec2 uv, float depth) {
  vec2 pixel = uv / uShadowTexelSize - 0.5;
  vec2 f = fract(pixel);
  vec2 p = (floor(pixel) + 0.5) * uShadowTexelSize;
  float a = step(depth, unpackRGBAToDepth(texture2D(uActorShadowMap, p)));
  float b = step(depth, unpackRGBAToDepth(texture2D(uActorShadowMap, p + vec2(uShadowTexelSize.x, 0.0))));
  float c = step(depth, unpackRGBAToDepth(texture2D(uActorShadowMap, p + vec2(0.0, uShadowTexelSize.y))));
  float d = step(depth, unpackRGBAToDepth(texture2D(uActorShadowMap, p + uShadowTexelSize)));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float sampleActorShadow(float defBias) {
  if (uReceiveActorShadow < 0.5) return 1.0;
  vec3 sc = (uActorShadowMatrix * vec4(vWorldPos, 1.0)).xyz * 0.5 + 0.5;
  vec2 t = uShadowTexelSize * 0.5;
  float s = 0.25 * (shadowCompare(sc.xy + vec2(-t.x, -t.y), sc.z)
    + shadowCompare(sc.xy + vec2(t.x, -t.y), sc.z)
    + shadowCompare(sc.xy + vec2(-t.x, t.y), sc.z)
    + shadowCompare(sc.xy + vec2(t.x, t.y), sc.z));
  if (abs(sc.z - 0.5) > 0.5) s = 1.0;
  vec3 cameraDelta = vWorldPos - cameraPosition;
  float fade = clamp(dot(cameraDelta, cameraDelta) * uShadowParams.z + uShadowParams.w, 0.0, 1.0);
  s = mix(s, 1.0, fade * fade);
  s += max(defBias, 0.0) * uShadowParams.y;
  s = mix(1.0, s, uShadowParams.x);
  return clamp(s * (s * (4.0 * s - 6.0) + 3.0), 0.0, 1.0);
}
float specularTerm(vec3 N, vec3 L, vec3 V, float roughness2, float normalization) {
  vec3 H = normalize(L + V);
  float nh = clamp(dot(N, H), 0.0, 1.0);
  float lh = clamp(dot(L, H), 0.0, 1.0);
  float d = nh * nh * (roughness2 - 1.0) + 1.00001;
  return roughness2 / (d * d * max(0.1, lh * lh) * normalization);
}
void main() {
  vec4 base = texture2D(uBaseMap, vUv);
  if (uAlphaClip > 0.5 && base.a < uCutoff) discard;
  vec3 Nview = normalize(vNormalView);
  vec3 N = normalize(uViewToWorld * Nview);
  vec3 pointView = normalize(cameraPosition - vWorldPos);
  vec3 V = uOrthographic > 0.5 ? uViewToWorld[2] : pointView;
  vec3 cameraUp = uViewToWorld * vec3(0.0, 1.0, 0.0);
  vec3 right = cross(cameraUp, V);
  vec3 up = cross(V, right);
  vec3 matcapNormal = vec3(dot(right, N), dot(up, N), dot(V, N));
  vec3 L = uLightDirView;
  vec3 lightingNormal = uWorldLight > 0.5 ? N : matcapNormal;
  vec4 def = uHasDef > 0.5 ? texture2D(uDefMap, vUv) : uDefValue;
  vec4 shade = uHasShade > 0.5 ? texture2D(uShadeMap, vUv) : vec4(base.rgb, 0.0);
  float defBias = 2.0 * def.r - 1.0;
  float litTerm = clamp(dot(lightingNormal, L) * 0.5 + def.r - uMatCapOffset * 0.5, 0.0, 1.0);
  float metallic = def.b;
  if (uShaderType == 9.0) {
    vec3 headRight = normalize(uViewToWorld * uHeadRightView);
    vec3 reflected = N - 2.0 * dot(N, headRight) * headRight;
    vec3 reflectedLightNormal = uWorldLight > 0.5 ? reflected
      : vec3(dot(right, reflected), dot(up, reflected), dot(V, reflected));
    float reflectedLit = clamp(dot(reflectedLightNormal, L) * 0.5 + def.r - uMatCapOffset * 0.5, 0.0, 1.0);
    litTerm = mix(litTerm, max(litTerm, reflectedLit), def.b);
    metallic = 0.0;
  }
  float shadow = sampleActorShadow(defBias);
  float specMask = min(shadow, def.a);
  if (uShaderType == 8.0) {
    bool corner = vUv.x > 0.75 && vUv.y < 0.25; // GLTF stores 1 - Unity V.
    float nh = max(dot(matcapNormal, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0);
    float highlight = smoothstep(uSpecThreshold.x - uSpecThreshold.y,
      uSpecThreshold.x + uSpecThreshold.y, nh * nh * nh * nh) * specMask;
    if (!corner) base.rgb = mix(base.rgb, texture2D(uHighlightMap, vUv).rgb, highlight);
    specMask *= corner ? 1.0 : 0.0;
  }
  if (uCheekWeight > 0.0) {
    vec4 layer = texture2D(uLayerMap, vUv);
    base.rgb = mix(base.rgb, layer.rgb, layer.a * uCheekWeight);
  }
  vec4 ramp = uHasShade > 0.5 ? texture2D(uRampMap, vec2(min(shadow, litTerm), 1.0)) : vec4(1.0, 1.0, 1.0, 0.0);
  vec3 modeA = mix(base.rgb, shade.rgb * uShadeMultiply, ramp.a * uShadeRatio);
  vec3 modeB = base.rgb * mix(vec3(1.0), mix(ramp.rgb, ramp.rgb * uShadeMultiply, ramp.a), uShadeRatio);
  vec3 albedo = uHasShade > 0.5 ? mix(modeA, modeB, shade.a) : base.rgb;
  float luminance = dot(albedo, vec3(0.212673, 0.715152, 0.072175));
  albedo = mix(vec3(luminance), albedo, mix(1.0, uSkinSaturation, shade.a)) * uBaseColor.rgb;
  if (uShaderType == 5.0) albedo *= uEyeHighlightColor;
  float smoothness = min(def.g, 1.0);
  float perceptualRoughness = 1.0 - smoothness;
  float roughness = max(perceptualRoughness * perceptualRoughness, 0.0078125);
  float roughness2 = roughness * roughness;
  float normalization = 4.0 * roughness + 2.0;
  float reflectivity = 1.0 - 0.96 * (1.0 - metallic);
  vec3 diffuse = albedo * (0.96 * (1.0 - metallic));
  vec3 specular = mix(vec3(0.04), albedo, metallic);
  float grazing = clamp(smoothness + reflectivity, 0.0, 1.0);
  if (uShaderType == 4.0) {
    diffuse = albedo * 0.96;
    specular = albedo;
    grazing = clamp(smoothness + 0.04, 0.0, 1.0);
  }
  vec3 reflection = vec3(0.0);
  vec3 reflectedView = reflect(-pointView, N);
  reflectedView.z = -reflectedView.z; // Raw Unity cubemap face orientation.
  float mip = perceptualRoughness * (1.7 - 0.7 * perceptualRoughness) * 6.0;
  if (uReflectionMode == 2.0 && uHasEyeReflection > 0.5) reflection = textureCubeLodEXT(uEyeReflectionCube, reflectedView, mip).rgb * uEyeReflectionColor;
  else if (uReflectionMode == 1.0 && uHasReflection > 0.5) reflection = textureCubeLodEXT(uReflectionCube, reflectedView, mip).rgb * uReflectionColor;
  float fresnel = pow(1.0 - clamp(matcapNormal.z, 0.0, 1.0), 4.0);
  vec3 environmentBRDF = mix(specular, vec3(grazing), fresnel) / (roughness2 + 1.0);
  float directSpecular = specularTerm(matcapNormal, L, vec3(0.0, 0.0, 1.0), roughness2, normalization)
    * clamp(dot(matcapNormal, L), 0.0, 1.0);
  vec3 direct = (reflection * environmentBRDF + environmentBRDF * directSpecular) * specMask;
  if (uShaderType == 6.0 && vUv.x > 0.96875 && vUv.y < 0.03125) direct += 2.0 * albedo;
  direct += diffuse;
  vec3 sh = uSH[0] + uSH[1] * N.y + uSH[2] * N.z + uSH[3] * N.x
    + uSH[4] * N.x * N.y + uSH[5] * N.y * N.z + uSH[6] * (3.0 * N.z * N.z - 1.0)
    + uSH[7] * N.x * N.z + uSH[8] * (N.x * N.x - N.y * N.y);
  vec3 shaded = direct * uLightColor + diffuse * max(sh, vec3(0.0)) * uGIScale;
  float rimMask = floor(vColor.a * 255.0 / 16.0 + 0.03125) / 15.0;
  float rim = min(pow(clamp(1.0 - dot(Nview, uRimDirView), 0.0, 1.0), uRimPower), 1.0)
    * min(2.0 * def.r, 1.0) * rimMask;
  shaded += mix(vec3(1.0), albedo, uRimBaseRatio) * uRimColor * rim;
  shaded += uShadeAdditive * ramp.a;
  vec3 additional = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uSceneLightCount) break;
    if (uSceneLightEnabled[i] < 0.5) continue;
    vec3 delta = uSceneLightPositions[i].xyz - vWorldPos * uSceneLightPositions[i].w;
    float distance2 = max(dot(delta, delta), 0.00006103515625);
    vec3 lightDir = delta * inversesqrt(distance2);
    vec4 attenuation = uSceneLightAttenuations[i];
    float cone = clamp(dot(uSceneLightDirections[i].xyz, lightDir) * attenuation.z + attenuation.w, 0.0, 1.0);
    cone *= cone;
    if (uSceneLightDirections[i].w == 1.0) {
      additional += direct * uSceneLightColors[i].rgb * cone;
    } else {
      float range = distance2 * attenuation.x;
      float fade = max(1.0 - range * range, 0.0);
      float nl = max(dot(N, lightDir), 0.0);
      float halfL = 0.5 * nl + 0.5;
      float toon = clamp((halfL * halfL * 2.35619449 - (uMatCapOffset - 0.00048828125)) * 1024.170410, 0.0, 1.0);
      toon = clamp(toon * toon * (3.0 - 2.0 * toon) + uShadeRatio, 0.0, 1.0);
      float spec = specularTerm(N, lightDir, V, roughness2, normalization) * min(nl, 1.0)
        * specMask * uAdditionalSpecularScale;
      additional += (direct + specular * spec) * uSceneLightColors[i].rgb * (fade * fade / distance2) * cone * toon;
    }
  }
  shaded += additional * uAdditionalScale;
  float alpha = base.a;
  if (uShaderType == 8.0) {
    vec3 viewDirection = vec3(dot(uViewToWorld[0], V), dot(uViewToWorld[1], V), dot(uViewToWorld[2], V));
    float frontFade = clamp((uFadeParam.x - dot(uHeadFrontView, viewDirection)) * uFadeParam.y, 0.0, 1.0);
    float verticalFade = clamp((abs(dot(uHeadUpView, viewDirection)) - uFadeParam.z) * uFadeParam.w, 0.0, 1.0);
    alpha = 1.0 - base.a * (1.0 - max(frontFade, verticalFade));
  }
  float coverage = uOpaqueCoverage > 0.5 ? 1.0 : alpha * uMultiplyColor.a;
  gl_FragColor = vec4(clamp(shaded * uMultiplyColor.rgb, vec3(0.00001), vec3(100.0)), coverage);
  #include <colorspace_fragment>
}
`;

// ---------------- Inverted-Hull Outline GLSL (TANGENT.xyz + 12-bit COLOR_0) ----------------
const OUTLINE_VERT = /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>

attribute vec4 tangent;
attribute vec4 color;
uniform float uOutlineWidth;
varying vec2 vUv;
varying vec3 vOutlineColor;

void main() {
  vUv = uv;

  // Unpack 4-bit nibbles from vertex COLOR_0 (R, G, B bytes)
  float rByte = floor(clamp(color.r, 0.0, 1.0) * 255.0 + 0.5);
  float gByte = floor(clamp(color.g, 0.0, 1.0) * 255.0 + 0.5);
  float bByte = floor(clamp(color.b, 0.0, 1.0) * 255.0 + 0.5);

  float cr = floor(rByte / 16.0) / 15.0;
  float cg = mod(rByte, 16.0) / 15.0;
  float cb = floor(gByte / 16.0) / 15.0;
  vOutlineColor = vec3(cr, cg, cb);

  float widthWeight = mod(bByte, 16.0) / 15.0;
  float zBiasWeight = floor(bByte / 16.0);

  // Smooth outline extrusion direction lives in TANGENT.xyz (fallback to normal)
  vec3 objectNormal = length(tangent.xyz) > 0.1 ? tangent.xyz : normal;
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>

  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vec3 worldOutDir = normalize(mat3(modelMatrix) * objectNormal);
  vec4 mvPos = viewMatrix * wp;
  // Mild distance compensation so close-ups and full-body shots keep crisp ~1px lines
  float distScale = clamp(-mvPos.z * 0.55, 0.55, 1.35);
  wp.xyz += worldOutDir * (uOutlineWidth * widthWeight * distScale);

  vec4 clipPos = projectionMatrix * (viewMatrix * wp);
  clipPos.z += zBiasWeight * 0.000067 * clipPos.w;
  gl_Position = clipPos;
}
`;

const OUTLINE_FRAG = /* glsl */`
#include <common>
uniform sampler2D uBaseMap;
uniform sampler2D uShadeMap;
uniform float uAlphaClip;
uniform float uCutoff;
uniform float uHasShade;
varying vec2 vUv;
varying vec3 vOutlineColor;

vec3 srgbToLin(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(2.2));
}

void main() {
  vec4 base = texture2D(uBaseMap, vUv);
  if (uAlphaClip > 0.5 && base.a < uCutoff) discard;
  vec3 sdw = uHasShade > 0.5 ? texture2D(uShadeMap, vUv).rgb : base.rgb;
  // Blend vertex artist outline color (sRGB nibbles) with darkened shade map
  vec3 vLin = srgbToLin(vOutlineColor);
  float vLum = max(vOutlineColor.r, max(vOutlineColor.g, vOutlineColor.b));
  vec3 col = vLum > 0.02 ? mix(vLin, sdw * 0.42, 0.35) : sdw * 0.28;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

function applyPorterDuffOver(mat) {
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.SrcAlphaFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendEquationAlpha = THREE.AddEquation;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
}

function createActorMaterial(desc, sharedUniforms, resources, bangsPass = false) {
  const mname = desc.name;
  const stype = desc.floats._ShaderType ?? 0;
  const baseMap = loadMap(resources, desc, '_BaseMap', true) || WHITE_SRGB;
  const shadeMap = desc.keywords?.includes('_SHADEMAP_OFF') ? null : loadMap(resources, desc, '_ShadeMap', true);
  const defMap = desc.keywords?.includes('_DEFMAP_OFF') ? null : loadMap(resources, desc, '_DefMap', false);
  const rampMap = loadMap(resources, desc, '_RampMap', true, true) || WHITE_SRGB;
  const hlMap = loadMap(resources, desc, '_HighlightMap', true);
  const layerWeight = desc.floats._LayerWeight ?? 0.0;
  const layerMap = ((desc.floats._EnableLayerMap ?? 0) >= 0.5 && layerWeight > 0.001)
    ? loadMap(resources, desc, '_LayerMap', true)
    : null;
  const bc = desc.colors._BaseColor || [1, 1, 1, 1];
  const specTh = desc.colors._SpecularThreshold || [0.6, 0.05];
  const multiply = desc.colors._MultiplyColor || [1, 1, 1, 1];
  const fade = desc.colors._FadeParam || [0.75, 2.0, 0.4, 4.0];
  const defValue = desc.colors._DefValue || [0.5, 0, 1, 0];
  const isWisps = mname === 'm_hirco' || stype === 1;
  const cullZero = (desc.floats._Cull === 0) || isWisps || mname === 'm_eye';
  const receiveShadow = desc.keywords?.includes('_ACTOR_SHADOWS_OFF') ? 0 : 1;

  const uniforms = {
    ...sharedUniforms,
    uBaseMap: { value: baseMap },
    uShadeMap: { value: shadeMap || WHITE_SRGB },
    uDefMap: { value: defMap || WHITE_SRGB },
    uRampMap: { value: rampMap },
    uHighlightMap: { value: hlMap || BLACK_SRGB },
    uLayerMap: { value: layerMap || WHITE_SRGB },
    uActorShadowMap: sharedUniforms.uActorShadowMap,
    uActorShadowMatrix: sharedUniforms.uActorShadowMatrix,
    uBaseColor: { value: new THREE.Vector4(bc[0], bc[1], bc[2], bc[3]) },
    uDefValue: { value: new THREE.Vector4(...defValue) },
    uLightDirView: sharedUniforms.uLightDirView,
    uRimDirView: sharedUniforms.uRimDirView,
    uLightColor: sharedUniforms.uLightColor,
    uShadeMultiply: sharedUniforms.uShadeMultiply,
    uHeadFrontView: sharedUniforms.uHeadFrontView,
    uHeadRightView: sharedUniforms.uHeadRightView,
    uShaderType: { value: stype },
    uAlphaClip: { value: desc.keywords ? Number(desc.keywords.includes('_ALPHATEST_ON')) : Number((desc.floats._AlphaClip ?? 0) >= 0.5) },
    uCutoff: { value: 0.33 }, // Native _ALPHATEST_ON shader constant.
    uSpecThreshold: { value: new THREE.Vector2(specTh[0], specTh[1]) },
    uMultiplyColor: { value: new THREE.Vector4(...multiply) },
    uFadeParam: { value: new THREE.Vector4(...fade) },
    uRimPower: sharedUniforms.uRimPower,
    uRimBaseRatio: sharedUniforms.uRimBaseRatio,
    uHasShade: { value: desc.keywords?.includes('_SHADEMAP_OFF') ? 0 : 1 },
    uHasDef: { value: desc.keywords?.includes('_DEFMAP_OFF') ? 0 : 1 },
    uCheekWeight: { value: layerMap ? layerWeight : 0.0 },
    uReceiveActorShadow: { value: receiveShadow },
    uReflectionMode: { value: desc.keywords?.includes('_USE_EYE_REFLECTION_TEXTURE') ? 2
      : desc.keywords?.includes('_USE_REFLECTION_TEXTURE') ? 1 : 0 },
  };

  const mat = new THREE.ShaderMaterial({
    name: bangsPass ? `${mname}_bangs` : mname,
    uniforms,
    vertexShader: ACTOR_VERT,
    fragmentShader: ACTOR_FRAG,
    side: cullZero ? THREE.DoubleSide : THREE.FrontSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
  resources.materials.add(mat);

  // Configure exact Unity queue + WebGL glStencilFunc ((ref & mask) OP (stencil & mask))
  if (mname === 'm_bdy' || mname === 'm_fce') {
    mat.stencilWrite = true;
    mat.stencilRef = 64;
    mat.stencilFunc = THREE.AlwaysStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = STENCIL_MASK;
    mat.stencilZPass = THREE.ReplaceStencilOp;
  } else if (mname === 'm_ebs') {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    mat.stencilWrite = true;
    mat.stencilRef = 68;
    mat.stencilFunc = THREE.AlwaysStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = STENCIL_MASK;
    mat.stencilZPass = THREE.ReplaceStencilOp;
  } else if (mname === 'm_eye') {
    mat.transparent = true;
    mat.depthWrite = false;
    applyPorterDuffOver(mat);
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    mat.stencilWrite = true;
    mat.stencilRef = 68;
    mat.stencilFunc = THREE.EqualStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = 0;
    mat.stencilZPass = THREE.KeepStencilOp;
  } else if (mname === 'm_fcp') {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -3;
    mat.polygonOffsetUnits = -3;
    mat.stencilWrite = true;
    mat.stencilRef = 72;
    mat.stencilFunc = THREE.AlwaysStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = STENCIL_MASK;
    mat.stencilZPass = THREE.ReplaceStencilOp;
  } else if (mname === 'm_ehl') {
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -4;
    mat.polygonOffsetUnits = -4;
    mat.stencilWrite = true;
    mat.stencilRef = 68;
    mat.stencilFunc = THREE.EqualStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = 0;
    mat.stencilZPass = THREE.KeepStencilOp;
  } else if (mname === 'm_hir' && !bangsPass) {
    // Pass 1: Opaque hair where stencil <= 64 -> WebGL (64 >= stencil) = GreaterEqualStencilFunc!
    mat.stencilWrite = true;
    mat.stencilRef = 64;
    mat.stencilFunc = THREE.GreaterEqualStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = 0;
    mat.stencilZPass = THREE.KeepStencilOp;
  } else if (mname === 'm_hir' && bangsPass) {
    // Pass 2: Translucent bangs ONLY over eyes/brows where stencil > 64 -> WebGL (64 < stencil) = LessStencilFunc!
    mat.transparent = true;
    mat.depthWrite = false;
    applyPorterDuffOver(mat);
    mat.stencilWrite = true;
    mat.stencilRef = 64;
    mat.stencilFunc = THREE.LessStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = 0;
    mat.stencilZPass = THREE.KeepStencilOp;
  } else if (isWisps) {
    // m_hirco: wispy forehead/side hair strands, soft alpha blend, no hard cutout
    mat.transparent = true;
    mat.depthWrite = false;
    applyPorterDuffOver(mat);
  }
  // Unity's opaque framebuffer ignores shader alpha; WebGL canvas compositing
  // requires full coverage even when the source alpha encodes a hair mask.
  uniforms.uOpaqueCoverage = { value: mat.transparent ? 0 : 1 };

  mat.userData.desc = desc;
  mat.userData.nativeShadowCaster = {
    map: baseMap, opacity: 1, cutoff: uniforms.uAlphaClip.value ? uniforms.uCutoff.value : 0,
    tangentNormal: true,
  };
  return mat;
}

const RENDER_ORDER = {
  m_bdy: 10,
  m_fce: 11,
  m_ebs: 12,
  m_eye: 13,
  m_fcp: 14,
  m_ehl: 15,
  m_hir: 16,
  m_hir_bangs: 17,
  outline: 18,
  m_hirco: 19,
};
function cloneActorPass(mesh, mat, suffix, order) {
  const o = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, mat) : new THREE.Mesh(mesh.geometry, mat);
  o.name = `${mesh.name}_${suffix}`;
  if (mesh.isSkinnedMesh) {
    o.bindMode = mesh.bindMode;
    o.bind(mesh.skeleton, mesh.bindMatrix);
  }
  o.morphTargetInfluences = mesh.morphTargetInfluences;
  o.morphTargetDictionary = mesh.morphTargetDictionary;
  o.frustumCulled = false;
  o.layers.mask = mesh.layers.mask;
  o.userData = { ...mesh.userData, castShadows: 0, receiveShadows: false };
  o.renderOrder = order;
  return o;
}

function createOutlineMesh(mesh, desc, baseWidth, resources) {
  const isWisps = desc.name === 'm_hirco' || (desc.floats._ShaderType === 1);
  const baseMap = loadMap(resources, desc, '_BaseMap', true) || WHITE_SRGB;
  const shadeMap = loadMap(resources, desc, '_ShadeMap', true);
  const mat = new THREE.ShaderMaterial({
    name: `${desc.name}_outline`,
    uniforms: {
      uBaseMap: { value: baseMap },
      uShadeMap: { value: shadeMap || WHITE_SRGB },
      uOutlineWidth: { value: baseWidth * OUTLINE_SCALE },
      uAlphaClip: { value: isWisps ? 1.0 : 0.0 },
      uCutoff: { value: desc.floats._Cutoff ?? 0.45 },
      uHasShade: { value: shadeMap ? 1.0 : 0.0 },
    },
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: THREE.BackSide,
    depthWrite: true,
    depthTest: true,
  });
  resources.materials.add(mat);
  // Hair outlines draw over bg (0) and face skin (64), stopping cleanly at eyes/brows (68/72): 64 >= stencil
  if (desc.part === 'hair') {
    mat.stencilWrite = true;
    mat.stencilRef = 64;
    mat.stencilFunc = THREE.GreaterEqualStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = 0;
    mat.stencilZPass = THREE.KeepStencilOp;
  }
  return cloneActorPass(mesh, mat, 'outline', RENDER_ORDER.outline);
}

/** Evaluate piecewise linear/Hermite FaceCorrection curve [{t, v}, ...] at deg. */
function evalSimpleCurve(pts, x) {
  if (!pts || !pts.length) return 0;
  if (x <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (x >= last.t) return last.v;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x >= a.t && x <= b.t) {
      const u = (x - a.t) / Math.max(1e-6, b.t - a.t);
      const s = u * u * (3 - 2 * u);
      return a.v + (b.v - a.v) * s;
    }
  }
  return 0;
}

function disposeCharacterResources(resources) {
  if (resources.disposed) return;
  resources.disposed = true;

  for (const geometry of resources.geometries) geometry.dispose();
  for (const material of resources.materials) material.dispose();

  // Passes share skeletons, and distinct skeletons may share a bone texture.
  const disposedTextures = new Set([WHITE_SRGB, BLACK_SRGB]);
  for (const skeleton of resources.skeletons) {
    const texture = skeleton.boneTexture;
    if (texture) {
      if (disposedTextures.has(texture)) skeleton.boneTexture = null;
      else disposedTextures.add(texture);
    }
    skeleton.dispose();
  }
  for (const texture of resources.textureCache.values()) {
    if (disposedTextures.has(texture)) continue;
    disposedTextures.add(texture);
    texture.dispose();
  }
  resources.actorShadowRT?.dispose();
  resources.actorShadowRT = null;
  resources.geometries.clear();
  resources.materials.clear();
  resources.skeletons.clear();
  resources.textureCache.clear();
}

/**
 * Load the actor model, build its authentic Campus/Actor/Default materials,
 * stencil passes, outlines, and Mecanim PoseSolver.
 */
export async function loadCharacter(scene, parts = null) {
  const env = await getBrowserEnv();
  const { glbBytes, meta, textures } = await buildCharFromBundles(env, parts || undefined);
  const resources = {
    bundleTextures: textures,
    textureCache: new Map(),
    geometries: new Set(),
    materials: new Set(),
    skeletons: new Set(),
    actorShadowRT: null,
    disposed: false,
  };
  let root = null;
  try {
    const gltf = await new GLTFLoader().parseAsync(
      glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength), '');
    root = gltf.scene;
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry) resources.geometries.add(o.geometry);
      if (o.skeleton) resources.skeletons.add(o.skeleton);
      if (Array.isArray(o.material)) {
        for (const material of o.material) resources.materials.add(material);
      } else if (o.material) {
        resources.materials.add(o.material);
      }
    });
    const nodeByIndex = new Map();
    for (const [obj, assoc] of gltf.parser.associations) {
      if (assoc && typeof assoc.nodes === 'number') nodeByIndex.set(assoc.nodes, obj);
    }
    const char = createCharacter(root, nodeByIndex, meta, resources);
    if (scene) scene.add(root);
    return char;
  } catch (error) {
    if (root?.parent) root.parent.remove(root);
    disposeCharacterResources(resources);
    throw error;
  } finally {
    // All lazy maps have been consumed; only character-owned RGBA textures remain.
    textures.clear();
    resources.bundleTextures = null;
  }
}

// Keep returned callbacks outside the loader's scope: neither the GLB/parser nor
// the lazy texture map and its source bundles belong to a live character.
function createCharacter(root, nodeByIndex, meta, resources) {
  const sourceMaterials = new Set(resources.materials);
  for (const n of nodeByIndex.values()) {
    n.userData.bindTRS = { p: n.position.clone(), q: n.quaternion.clone(), s: n.scale.clone() };
  }

  // 1024x1024 RGBA-packed depth render target for crisp hair-to-face drop shadows (_ActorShadowmapTexture)
  const actorShadowRT = new THREE.WebGLRenderTarget(1024, 1024, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  resources.actorShadowRT = actorShadowRT;
  const shadowScene = new THREE.Scene();
  const shadowCamera = new THREE.Camera();
  let shadowAngles = { ...DEFAULT_ACTOR_LIGHT.shadowAngles };

  const sharedUniforms = {
    uLightDirView: { value: DEFAULT_ACTOR_LIGHT.lightDirView.clone() },
    uRimDirView: { value: DEFAULT_ACTOR_LIGHT.rimDirView.clone() },
    uLightColor: { value: DEFAULT_ACTOR_LIGHT.lightColor.clone() },
    uShadeMultiply: { value: DEFAULT_ACTOR_LIGHT.shadeMultiply.clone() },
    uShadeAdditive: { value: new THREE.Color(0, 0, 0) },
    uHeadFrontView: { value: new THREE.Vector3(0, 0, 1) },
    uHeadRightView: { value: new THREE.Vector3(1, 0, 0) },
    uHeadUpView: { value: new THREE.Vector3(0, 1, 0) },
    uViewToWorld: { value: new THREE.Matrix3() },
    uOrthographic: { value: 0 },
    uRimPower: { value: DEFAULT_ACTOR_LIGHT.rimPower },
    uRimColor: { value: new THREE.Color() },
    uRimBaseRatio: { value: DEFAULT_ACTOR_LIGHT.rimBaseRatio },
    uActorShadowMap: { value: WHITE_SRGB },
    uActorShadowMatrix: { value: new THREE.Matrix4() },
    uShadowParams: { value: new THREE.Vector4(1, 1, 0, 0) },
    uShadowTexelSize: { value: new THREE.Vector2(1 / actorShadowRT.width, 1 / actorShadowRT.height) },
    uShadowLightDirection: { value: new THREE.Vector3() },
    uShadowBias: { value: new THREE.Vector2() },
    uMatCapOffset: { value: 0 },
    uShadeRatio: { value: 1 },
    uSkinSaturation: { value: 1 },
    uGIScale: { value: 0 },
    uSH: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
    uAdditionalScale: { value: 1 },
    uAdditionalSpecularScale: { value: 0 },
    uWorldLight: { value: 0 },
    uReflectionCube: { value: null },
    uEyeReflectionCube: { value: null },
    uReflectionColor: { value: new THREE.Color(1, 1, 1) },
    uEyeReflectionColor: { value: new THREE.Color(1, 1, 1) },
    uEyeHighlightColor: { value: new THREE.Color(1, 1, 1) },
    uHasReflection: { value: 0 },
    uHasEyeReflection: { value: 0 },
    uSceneLightCount: { value: 0 },
    uSceneLightPositions: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uSceneLightColors: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uSceneLightAttenuations: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uSceneLightDirections: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uSceneLightEnabled: { value: new Float32Array(8).fill(1) },
  };

  const byName = new Map();
  for (const desc of Object.values(meta.materials)) {
    if (!byName.has(desc.name)) byName.set(desc.name, desc);
  }
  const descFor = (gltfMat) => {
    if (!gltfMat) return null;
    return meta.materials[gltfMat.name] || byName.get(gltfMat.name)
      || byName.get(String(gltfMat.name).split(':').pop()) || null;
  };

  const morphMeshes = [];
  const extraPasses = [];
  const shadowCasters = [];
  const actorMeshes = [];
  const OUTLINED_WIDTH = {
    m_bdy: 0.0022,
    m_fce: 0.0016,
    m_hir: 0.0018,
  };
  root.traverse((o) => {
    if (!o.isMesh) return;
    const desc = descFor(o.material);
    if (!desc) return;
    actorMeshes.push(o);

    // Ensure COLOR_0 attribute exists so vertex shader never reads undefined
    if (!o.geometry.attributes.color) {
      const cnt = o.geometry.attributes.position.count;
      const arr = new Float32Array(cnt * 4);
      for (let i = 0; i < cnt; i++) arr[i * 4 + 2] = 8 / 255; // default width nibble = 8
      o.geometry.setAttribute('color', new THREE.BufferAttribute(arr, 4));
    }

    let controls = o;
    while (controls.parent && controls.userData.renderingLayerMask == null) controls = controls.parent;
    Object.assign(o.userData, {
      renderingLayerMask: controls.userData.renderingLayerMask,
      unityLayer: controls.userData.unityLayer,
      castShadows: controls.userData.castShadows,
      receiveShadows: controls.userData.receiveShadows,
    });
    o.material = createActorMaterial(desc, sharedUniforms, resources, false);
    if (o.userData.receiveShadows === false) o.material.uniforms.uReceiveActorShadow.value = 0;
    o.castShadow = o.userData.castShadows !== 0 && o.userData.castShadows !== false;
    o.receiveShadow = o.userData.receiveShadows !== false;
    if (o.userData.castShadows === 3) o.layers.set(1);
    o.renderOrder = RENDER_ORDER[desc.name] ?? 10;
    o.frustumCulled = false;

    if (o.morphTargetInfluences?.length) morphMeshes.push(o);
    if (o.isSkinnedMesh && desc.name === 'm_hir') {
      const bangsMat = createActorMaterial(desc, sharedUniforms, resources, true);
      extraPasses.push([o.parent, cloneActorPass(o, bangsMat, 'bangs', RENDER_ORDER.m_hir_bangs)]);
    }
    const opaqueQueue = desc.renderQueue == null || desc.renderQueue < 0
      ? !o.material.transparent : desc.renderQueue <= 2500;
    if (o.castShadow && opaqueQueue
        && ((1 << (o.userData.unityLayer ?? 12)) & 4352) !== 0
        && ((o.userData.renderingLayerMask ?? 0) & 0x5000) !== 0) {
      const sMat = new THREE.ShaderMaterial({
        name: `${desc.name}_shadow_caster`,
        uniforms: {
          uBaseMap: o.material.uniforms.uBaseMap,
          uAlphaClip: o.material.uniforms.uAlphaClip,
          uCutoff: o.material.uniforms.uCutoff,
          uActorShadowMatrix: sharedUniforms.uActorShadowMatrix,
          uShadowLightDirection: sharedUniforms.uShadowLightDirection,
          uShadowBias: sharedUniforms.uShadowBias,
        },
        vertexShader: SHADOW_CASTER_VERT,
        fragmentShader: SHADOW_CASTER_FRAG,
        side: desc.floats._Cull === 0 || o.userData.castShadows === 2 ? THREE.DoubleSide : THREE.FrontSide,
        depthWrite: true,
        depthTest: true,
      });
      resources.materials.add(sMat);
      const sMesh = cloneActorPass(o, sMat, 'shadow', 0);
      sMesh.matrixAutoUpdate = false;
      sMesh.layers.set(0);
      shadowScene.add(sMesh);
      shadowCasters.push([o, sMesh]);
    }
    if (o.isSkinnedMesh && OUTLINE_SCALE > 0 && desc.name in OUTLINED_WIDTH) {
      extraPasses.push([o.parent, createOutlineMesh(o, desc, OUTLINED_WIDTH[desc.name], resources)]);
    }
  });

  for (const [parent, child] of extraPasses) parent.add(child);

  // GLTF materials are texture-free placeholders. Release replaced ones once no
  // remaining mesh uses them, including when a source material was shared.
  root.traverse((o) => {
    if (Array.isArray(o.material)) {
      for (const material of o.material) sourceMaterials.delete(material);
    } else {
      sourceMaterials.delete(o.material);
    }
  });
  for (const material of sourceMaterials) {
    resources.materials.delete(material);
    material.dispose();
  }
  sourceMaterials.clear();

  const solver = new PoseSolver(nodeByIndex, meta);
  const headNode = solver.nameToNode.Head || null;
  const faceCorr = meta.faceCorrection || null;
  const userMorph = new Map();

  // Temp vectors/matrices for per-frame view-space head uniforms, FaceCorrection & ActorShadowPass
  const _headPosW = new THREE.Vector3();
  const _headQuatW = new THREE.Quaternion();
  const _camPosW = new THREE.Vector3();
  const _toCamLocal = new THREE.Vector3();
  const _headFrontW = new THREE.Vector3();
  const _headRightW = new THREE.Vector3();
  const _headUpW = new THREE.Vector3();
  const _viewMat3 = new THREE.Matrix3();
  const _camMat3 = new THREE.Matrix3();
  const _shadowDirW = new THREE.Vector3();
  const _shadowEyeW = new THREE.Vector3();
  const _shadowTargetW = new THREE.Vector3();
  const _shadowUpW = new THREE.Vector3(0, 1, 0);
  const _shadowView = new THREE.Matrix4();
  const _shadowProj = new THREE.Matrix4();
  const _boundsWorld = new THREE.Box3();
  const _boundsView = new THREE.Box3();
  const _meshBounds = new THREE.Box3();
  const _boundsLight = new THREE.Box3();
  const _boundsCenter = new THREE.Vector3();
  const _boundsSize = new THREE.Vector3();
  const _viewToLight = new THREE.Matrix4();
  const _frustumCorner = new THREE.Vector3();
  const _zero = new THREE.Vector3();
  const _cameraEuler = new THREE.Euler();
  const _cameraRotation = new THREE.Quaternion();
  const mainLightAngles = new THREE.Vector2(-7, 7);
  const lightColor = new THREE.Color();
  let sceneLights = [];
  const selectedSceneLights = [];
  const _lightPosition = new THREE.Vector3();
  let shadowDirectionalType = 0;
  let hasShadowBounds = false;
  const _prevClearColor = new THREE.Color();
  const _prevViewport = new THREE.Vector4();
  const _prevScissor = new THREE.Vector4();

  function visibleInHierarchy(object) {
    for (let node = object; node; node = node.parent) {
      if (!node.visible) return false;
    }
    return true;
  }

  function syncMorphTargets(corrWeights = null) {
    for (const m of morphMeshes) {
      const inf = m.morphTargetInfluences;
      inf.fill(0);
      for (const [i, v] of userMorph) {
        if (i >= 0 && i < inf.length) inf[i] = v;
      }
      if (corrWeights) {
        for (const [i, v] of corrWeights) {
          if (i >= 0 && i < inf.length) inf[i] = v;
        }
      }
    }
  }

  const char = {
    root, solver, nodeByIndex, meta, morphMeshes, sharedUniforms, actorShadowRT,
    setMorph(map) {
      userMorph.clear();
      if (map) {
        for (const [i, v] of map) userMorph.set(i, v);
      }
      syncMorphTargets();
    },
    /** Update view-space head uniforms, shadow matrix & CampusActorFaceCorrection profile blendshapes. */
    update(camera) {
      if (resources.disposed || !camera || !headNode) return;
      root.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);

      headNode.getWorldPosition(_headPosW);
      headNode.getWorldQuaternion(_headQuatW);
      // In Three.js right-handed converted space, character faces -Z, character's left/right X is ±X
      _headFrontW.set(0, 0, -1).applyQuaternion(_headQuatW).normalize();
      _headRightW.set(1, 0, 0).applyQuaternion(_headQuatW).normalize();
      _headUpW.set(0, 1, 0).applyQuaternion(_headQuatW).normalize();

      _viewMat3.setFromMatrix4(camera.matrixWorldInverse);
      sharedUniforms.uHeadFrontView.value.copy(_headFrontW).applyMatrix3(_viewMat3).normalize();
      sharedUniforms.uHeadRightView.value.copy(_headRightW).applyMatrix3(_viewMat3).normalize();
      sharedUniforms.uHeadUpView.value.copy(_headUpW).applyMatrix3(_viewMat3).normalize();

      _camMat3.setFromMatrix4(camera.matrixWorld);
      sharedUniforms.uViewToWorld.value.copy(_camMat3);
      sharedUniforms.uOrthographic.value = camera.isOrthographicCamera ? 1 : 0;
      camera.getWorldQuaternion(_cameraRotation);
      if (sharedUniforms.uWorldLight.value === 0) {
        _cameraEuler.setFromQuaternion(_cameraRotation, 'YXZ');
        viewDirFromAngles(mainLightAngles.x, mainLightAngles.y, sharedUniforms.uLightDirView.value);
        // Native view-relative matcap cancels camera roll, not camera yaw/pitch.
        sharedUniforms.uLightDirView.value.applyAxisAngle(_zero.set(0, 0, 1), -_cameraEuler.z);
        _zero.set(0, 0, 0);
      }
      viewDirFromAngles(-shadowAngles.x, shadowAngles.y, _shadowDirW).applyMatrix3(_camMat3).normalize();
      if (shadowDirectionalType === 1) {
        _shadowDirW.copy(sharedUniforms.uLightDirView.value);
        if (sharedUniforms.uWorldLight.value === 0) _shadowDirW.applyMatrix3(_camMat3);
      } else if (shadowDirectionalType === 2) {
        const main = sceneLights.find(light => light.type === 1 && light.shadows > 0);
        if (main) _shadowDirW.fromArray(main.direction).negate();
      }
      sharedUniforms.uShadowLightDirection.value.copy(_shadowDirW);

      // CampusActorFaceCorrection: compute camera azimuth/elevation in Head local frame
      if (faceCorr && faceCorr.indices && faceCorr.curves) {
        camera.getWorldPosition(_camPosW);
        _toCamLocal.copy(_camPosW).sub(_headPosW).applyQuaternion(_headQuatW.clone().invert()).normalize();
        const yawDeg = Math.atan2(_toCamLocal.x, -_toCamLocal.z) * (180 / Math.PI);
        const elevDeg = Math.asin(Math.max(-1, Math.min(1, _toCamLocal.y))) * (180 / Math.PI);
        const absYaw = Math.abs(yawDeg);
        const corr = [
          [faceCorr.indices[0], evalSimpleCurve(faceCorr.curves[0], elevDeg)],
          [faceCorr.indices[1], evalSimpleCurve(faceCorr.curves[1], absYaw)],
          [faceCorr.indices[2], evalSimpleCurve(faceCorr.curves[2], yawDeg)],
          [faceCorr.indices[3], evalSimpleCurve(faceCorr.curves[3], yawDeg)],
        ];
        syncMorphTargets(corr);
      }
      // Native ActorShadowPass fits the visible actor AABB in camera space,
      // clips it to the view frustum and a two-metre depth interval, then
      // rotates those extents into the shadow camera. No head-height constants.
      _boundsWorld.makeEmpty();
      for (const mesh of actorMeshes) {
        if (!visibleInHierarchy(mesh)) continue;
        if (mesh.isSkinnedMesh) {
          mesh.skeleton.update();
          mesh.computeBoundingBox();
          _meshBounds.copy(mesh.boundingBox);
        } else {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          _meshBounds.copy(mesh.geometry.boundingBox);
        }
        _meshBounds.applyMatrix4(mesh.matrixWorld);
        _boundsWorld.union(_meshBounds);
      }
      hasShadowBounds = !_boundsWorld.isEmpty();
      if (!hasShadowBounds) return;
      for (let i = 0; i < selectedSceneLights.length; i++) {
        const light = selectedSceneLights[i];
        _lightPosition.fromArray(light.position);
        sharedUniforms.uSceneLightEnabled.value[i] = light.type === 1
          || _boundsWorld.distanceToPoint(_lightPosition) <= light.range ? 1 : 0;
      }
      _boundsView.copy(_boundsWorld).applyMatrix4(camera.matrixWorldInverse);
      const start = Math.max(0, -_boundsView.max.z);
      const end = Math.min(-_boundsView.min.z, start + 2);
      const fadeStart2 = start * start + (end * end - start * start) * 0.7;
      const fadeRange2 = end * end - fadeStart2;
      if (end <= start || fadeRange2 <= 0) {
        hasShadowBounds = false;
        return;
      }
      sharedUniforms.uShadowParams.value.z = 1 / fadeRange2;
      sharedUniforms.uShadowParams.value.w = -fadeStart2 / fadeRange2;
      _boundsView.min.z = -end;
      _boundsView.max.z = -start;
      _frustumCorner.set(-1, -1, 0).applyMatrix4(camera.projectionMatrixInverse);
      if (camera.isPerspectiveCamera) _frustumCorner.multiplyScalar(end / -_frustumCorner.z);
      _boundsView.min.x = Math.max(_boundsView.min.x, _frustumCorner.x);
      _boundsView.min.y = Math.max(_boundsView.min.y, _frustumCorner.y);
      _frustumCorner.set(1, 1, 0).applyMatrix4(camera.projectionMatrixInverse);
      if (camera.isPerspectiveCamera) _frustumCorner.multiplyScalar(end / -_frustumCorner.z);
      _boundsView.max.x = Math.min(_boundsView.max.x, _frustumCorner.x);
      _boundsView.max.y = Math.min(_boundsView.max.y, _frustumCorner.y);
      if (_boundsView.isEmpty()) {
        hasShadowBounds = false;
        return;
      }
      _boundsView.getCenter(_boundsCenter);
      _shadowTargetW.copy(_boundsCenter).applyMatrix4(camera.matrixWorld);
      _shadowEyeW.copy(_shadowTargetW).add(_shadowDirW);
      _shadowUpW.set(0, 1, 0).applyMatrix3(_camMat3);
      _shadowView.lookAt(_shadowEyeW, _shadowTargetW, _shadowUpW).setPosition(_shadowTargetW).invert();
      _viewToLight.multiplyMatrices(_shadowView, camera.matrixWorld);
      _boundsLight.copy(_boundsView).applyMatrix4(_viewToLight);
      _boundsLight.getSize(_boundsSize).multiplyScalar(0.5);
      if (Math.min(_boundsSize.x, _boundsSize.y, _boundsSize.z) <= 0) {
        hasShadowBounds = false;
        return;
      }
      _shadowProj.makeOrthographic(-_boundsSize.x, _boundsSize.x, _boundsSize.y, -_boundsSize.y, -_boundsSize.z, _boundsSize.z);
      sharedUniforms.uActorShadowMatrix.value.multiplyMatrices(_shadowProj, _shadowView);
      const biasTexel = (2 / _shadowProj.elements[0]) / actorShadowRT.width * 2.5;
      sharedUniforms.uShadowBias.value.set(-2 * biasTexel, -0.5 * biasTexel);
    },
    /** Render native opaque actor-layer casters before the main render pass. */
    renderShadow(renderer) {
      if (resources.disposed || !renderer || !shadowCasters.length || !root.visible || !hasShadowBounds) {
        sharedUniforms.uActorShadowMap.value = WHITE_SRGB;
        return;
      }
      for (const [srcMesh, dstMesh] of shadowCasters) {
        dstMesh.visible = visibleInHierarchy(srcMesh);
        dstMesh.matrixWorld.copy(srcMesh.matrixWorld);
        dstMesh.matrix.copy(srcMesh.matrixWorld);
      }
      const prevTarget = renderer.getRenderTarget();
      const prevCubeFace = renderer.getActiveCubeFace();
      const prevMipLevel = renderer.getActiveMipmapLevel();
      renderer.getViewport(_prevViewport);
      renderer.getScissor(_prevScissor);
      const prevScissorTest = renderer.getScissorTest();
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(_prevClearColor);
      const prevAutoClear = renderer.autoClear;
      const prevXrEnabled = renderer.xr.enabled;
      try {
        renderer.xr.enabled = false;
        renderer.autoClear = false;
        renderer.setRenderTarget(actorShadowRT);
        renderer.setScissorTest(false);
        renderer.setClearColor(0xffffff, 1.0);
        renderer.clear(true, true, false);
        renderer.render(shadowScene, shadowCamera);
        sharedUniforms.uActorShadowMap.value = actorShadowRT.texture;
      } finally {
        renderer.setRenderTarget(prevTarget, prevCubeFace, prevMipLevel);
        renderer.setViewport(_prevViewport);
        renderer.setScissor(_prevScissor);
        renderer.setScissorTest(prevScissorTest);
        renderer.setClearColor(_prevClearColor, prevAlpha);
        renderer.autoClear = prevAutoClear;
        renderer.xr.enabled = prevXrEnabled;
      }
    },
    /** Apply VLActorParameter & VLActorShadow overrides from 3D stage or 2D bg volume. */
    applyActorVolume(volOrParam) {
      const ap = volOrParam?.actorParam ?? volOrParam ?? {};
      const as = volOrParam?.actorShadow ?? {};
      const angle = ap.mainLightAngle ?? { x: -7, y: 7 };
      mainLightAngles.set(angle.x, angle.y);
      sharedUniforms.uWorldLight.value = ap.mainLightSpace === 1 ? 1 : 0;
      if (ap.mainLightSpace === 1) {
        // World Euler(-angle.x, angle.y + 180, 0), mirrored from Unity LH.
        sharedUniforms.uLightDirView.value.copy(viewDirFromAngles(angle.y + 180, angle.x));
        sharedUniforms.uLightDirView.value.z *= -1;
      } else sharedUniforms.uLightDirView.value.copy(viewDirFromAngles(angle.x, angle.y));
      const rim = ap.rimAngle ?? { x: 0, y: 0 };
      sharedUniforms.uRimDirView.value.copy(viewDirFromAngles(rim.x, -rim.y));
      for (const [field, uniform, fallback] of [
        ['lightColor', 'uLightColor', 1], ['shadeColorMultiply', 'uShadeMultiply', 1],
        ['shadeColorAdditive', 'uShadeAdditive', 0], ['rimColor', 'uRimColor', 0],
        ['reflectionColor', 'uReflectionColor', 1], ['eyeReflectionColor', 'uEyeReflectionColor', 1],
        ['eyeHighlightColor', 'uEyeHighlightColor', 1],
      ]) {
        const color = ap[field];
        sharedUniforms[uniform].value.setRGB(color?.r ?? fallback, color?.g ?? fallback, color?.b ?? fallback);
      }
      sharedUniforms.uRimPower.value = ap.rimPower ?? 8;
      sharedUniforms.uRimBaseRatio.value = ap.rimBaseColorRatio ?? 1;
      sharedUniforms.uMatCapOffset.value = ap.matCapOffset ?? 0.3;
      sharedUniforms.uShadeRatio.value = ap.shadeApplyRatio ?? 1;
      sharedUniforms.uSkinSaturation.value = 1 + (ap.skinSaturation ?? 0);
      sharedUniforms.uGIScale.value = ap.giScale ?? 0;
      // Unity's shader packing uses (c0-c6), (3*c6), and c8 directly;
      // these SphericalHarmonicsL2 coefficients need no extra basis scaling.
      // Only terms odd in Z change sign when converting Unity world space.
      const ambientSH = volOrParam?.ambientSH;
      const channelMajor = ambientSH?.length === 27;
      for (let i = 0; i < 9; i++) {
        const sign = i === 2 || i === 5 || i === 7 ? -1 : 1;
        sharedUniforms.uSH.value[i].set(
          sign * ((channelMajor ? ambientSH[i] : ambientSH?.[i]?.[0]) ?? 0),
          sign * ((channelMajor ? ambientSH[i + 9] : ambientSH?.[i]?.[1]) ?? 0),
          sign * ((channelMajor ? ambientSH[i + 18] : ambientSH?.[i]?.[2]) ?? 0),
        );
      }
      sharedUniforms.uAdditionalScale.value = ap.additiveLightScale ?? 1;
      sharedUniforms.uAdditionalSpecularScale.value = ap.additiveLightSpecularScale ?? 1;
      sharedUniforms.uReflectionCube.value = ap.reflectionTexture?.isCubeTexture ? ap.reflectionTexture : null;
      sharedUniforms.uEyeReflectionCube.value = ap.eyeReflectionTexture?.isCubeTexture ? ap.eyeReflectionTexture : null;
      sharedUniforms.uHasReflection.value = sharedUniforms.uReflectionCube.value ? 1 : 0;
      sharedUniforms.uHasEyeReflection.value = sharedUniforms.uEyeReflectionCube.value ? 1 : 0;
      sharedUniforms.uShadowParams.value.x = as.shadowStrength ?? 1;
      sharedUniforms.uShadowParams.value.y = as.useOffset ?? 1;
      shadowAngles = { x: as.lightDirectional?.x ?? 0, y: as.lightDirectional?.y ?? 0 };
      shadowDirectionalType = as.directionalType ?? 0;
    },
    /** CampusActorRenderPass selects up to eight raw actor-layer lights. */
    setSceneLights(lights) {
      sceneLights = lights ?? [];
      selectedSceneLights.length = 0;
      sharedUniforms.uSceneLightEnabled.value.fill(1);
      let count = 0;
      for (const light of sceneLights) {
        if ((light.renderingLayerMask & 4) === 0 || light.enabled === false) continue;
        if (count === 8) break;
        selectedSceneLights.push(light);
        const position = light.position;
        const direction = light.direction;
        const directional = light.type === 1;
        sharedUniforms.uSceneLightPositions.value[count].set(
          directional ? -direction[0] : position[0], directional ? -direction[1] : position[1],
          directional ? -direction[2] : position[2], directional ? 0 : 1);
        lightColor.fromArray(light.color).convertSRGBToLinear().multiplyScalar(light.intensity);
        // Color.w is the cookie-data index, never a shadow-map index.
        sharedUniforms.uSceneLightColors.value[count].set(lightColor.r, lightColor.g, lightColor.b, -1);
        let coneScale = 0, coneOffset = 1;
        if (light.type === 0) {
          const outer = light.spotAngle * Math.PI / 360;
          const inner = light.innerSpotAngle == null ? Math.atan(Math.tan(outer) * (46 / 64)) : light.innerSpotAngle * Math.PI / 360;
          coneScale = 1 / Math.max(0.001, Math.cos(inner) - Math.cos(outer));
          coneOffset = -Math.cos(outer) * coneScale;
        }
        sharedUniforms.uSceneLightAttenuations.value[count].set(directional ? 0 : 1 / Math.max(light.range * light.range, 0.0001), 0, coneScale, coneOffset);
        sharedUniforms.uSceneLightDirections.value[count].set(-direction[0], -direction[1], -direction[2], (light.customProperties?.[3] ?? 0) & 15);
        count++;
      }
      sharedUniforms.uSceneLightCount.value = count;
    },
    reset() { solver.resetPose(); },
    dispose() {
      if (resources.disposed) return;
      if (root.parent) root.parent.remove(root);
      sharedUniforms.uActorShadowMap.value = WHITE_SRGB;
      sharedUniforms.uReflectionCube.value = null;
      sharedUniforms.uEyeReflectionCube.value = null;
      sceneLights = [];
      selectedSceneLights.length = 0;
      actorMeshes.length = 0;
      shadowScene.clear();
      shadowCasters.length = 0;
      disposeCharacterResources(resources);
    },
  };
  char.applyActorVolume(null);
  return char;
}
