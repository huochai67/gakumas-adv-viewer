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

// Fallback 1x1 white & neutral textures so shader uniforms are never null
function solidTex(r, g, b, a = 255, srgb = false) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
const WHITE_SRGB = solidTex(255, 255, 255, 255, true);
const DEF_NEUTRAL = solidTex(128, 0, 0, 0, false); // R=0.5 (no shadow bias), B=0, A=0
const RAMP_DEFAULT = solidTex(255, 255, 255, 0, true);

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
function viewDirFromAngles(yawXDeg, elevYDeg) {
  const D2R = Math.PI / 180;
  const ax = yawXDeg * D2R;
  const ay = elevYDeg * D2R;
  return new THREE.Vector3(
    Math.sin(ax) * Math.cos(ay),
    Math.sin(ay),
    Math.cos(ax) * Math.cos(ay),
  ).normalize();
}

const DEFAULT_ACTOR_LIGHT = {
  lightDirView: viewDirFromAngles(-10, 30),
  rimDirView: viewDirFromAngles(10, 30),
  shadowAngles: { x: 10, y: 3 },
  shadowStrength: 1.0,
  lightColor: new THREE.Color(0.985, 0.985, 0.985),
  shadeMultiply: new THREE.Color(0.83, 0.69, 0.68),
  rimPower: 32.0,
  rimIntensity: 0.45,
  rimBaseRatio: 0.85,
};

// ---------------- Hair-to-Face Depth Shadow Pass GLSL ----------------
const SHADOW_CASTER_VERT = /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform mat4 uActorShadowMatrix;
varying vec2 vUv;
varying float vShadowDepth;
void main() {
  vUv = uv;
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinbase_vertex>
  #include <skinning_vertex>
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vec4 clip = uActorShadowMatrix * wp;
  vShadowDepth = clip.z * 0.5 + 0.5;
  gl_Position = clip;
}
`;

const SHADOW_CASTER_FRAG = /* glsl */`
#include <common>
#include <packing>
uniform sampler2D uBaseMap;
varying vec2 vUv;
varying float vShadowDepth;
void main() {
  // Translucent eye-covering bang tips (base.a > 0.12) do not cast dark blocks under eyes
  if (texture2D(uBaseMap, vUv).a > 0.12) discard;
  gl_FragColor = packDepthToRGBA(clamp(vShadowDepth, 0.0, 1.0));
}
`;
// ---------------- Campus/Actor/Default GLSL ----------------
const ACTOR_VERT = /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>

attribute vec4 color;
uniform vec3 uHeadCenterWorld;
varying vec2 vUv;
varying vec3 vNormalView;
varying vec3 vViewDir;
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
  vViewDir = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const ACTOR_FRAG = /* glsl */`
#include <common>
#include <packing>

uniform sampler2D uBaseMap;
uniform sampler2D uShadeMap;
uniform sampler2D uDefMap;
uniform sampler2D uRampMap;
uniform sampler2D uHighlightMap;
uniform sampler2D uLayerMap;
uniform sampler2D uActorShadowMap;
uniform mat4 uActorShadowMatrix;
uniform vec4 uBaseColor;
uniform vec3 uLightDirView;
uniform vec3 uRimDirView;
uniform vec3 uLightColor;
uniform vec3 uShadeMultiply;
uniform vec3 uHeadCenterView;
uniform vec3 uHeadFrontView;
uniform vec3 uHeadRightView;

uniform float uShaderType;
uniform float uAlphaClip;
uniform float uCutoff;
uniform float uSpecThreshold;
uniform float uRimPower;
uniform float uRimIntensity;
uniform float uRimBaseRatio;
uniform float uBangsTranslucency;
uniform float uHasShade;
uniform float uHasDef;
uniform float uHasHighlight;
uniform float uCheekWeight;
uniform float uShadowStrength;
uniform float uReceiveActorShadow;
varying vec2 vUv;
varying vec3 vNormalView;
varying vec3 vViewDir;
varying vec3 vWorldPos;
varying vec4 vColor;

float sampleActorShadow(vec3 worldPos, float defBias) {
  if (uReceiveActorShadow < 0.5 || uShadowStrength <= 0.001) return 1.0;
  vec4 sc = uActorShadowMatrix * vec4(worldPos, 1.0);
  vec3 ndc = sc.xyz / max(sc.w, 1e-5);
  vec2 suv = ndc.xy * 0.5 + 0.5;
  float curZ = ndc.z * 0.5 + 0.5;
  if (suv.x < 0.01 || suv.x > 0.99 || suv.y < 0.01 || suv.y > 0.99 || curZ < 0.0 || curZ > 1.0) {
    return 1.0;
  }
  // 4-tap rotated Poisson / box PCF (1024x1024 ortho RT around Head)
  const float texel = 1.0 / 1024.0;
  const float bias = 0.0045;
  float d0 = unpackRGBAToDepth(texture2D(uActorShadowMap, suv + vec2(-0.75, -0.25) * texel));
  float d1 = unpackRGBAToDepth(texture2D(uActorShadowMap, suv + vec2( 0.25, -0.75) * texel));
  float d2 = unpackRGBAToDepth(texture2D(uActorShadowMap, suv + vec2( 0.75,  0.25) * texel));
  float d3 = unpackRGBAToDepth(texture2D(uActorShadowMap, suv + vec2(-0.25,  0.75) * texel));
  float cZ = curZ - bias;
  float lit = (cZ <= d0 ? 0.25 : 0.0) + (cZ <= d1 ? 0.25 : 0.0) + (cZ <= d2 ? 0.25 : 0.0) + (cZ <= d3 ? 0.25 : 0.0);
  float s = lit + max(defBias, 0.0) * 0.30;
  // Face skin hair-drop-shadow stays a soft ~45% warm peach tint ([230,208,200]), not full neck-shadow dark
  float effStrength = abs(uShaderType - 9.0) < 0.5 ? uShadowStrength * 0.52 : uShadowStrength * 0.65;
  s = mix(1.0, clamp(s, 0.0, 1.0), effStrength);
  return clamp(s * s * (3.0 - 2.0 * s), 0.0, 1.0);
}

void main() {
  vec4 base = texture2D(uBaseMap, vUv) * uBaseColor;
  if (uAlphaClip > 0.5 && base.a < uCutoff) discard;

  // Type 4: Eye iris (straight alpha in PNG, stencil-clipped to sclera 68)
  if (abs(uShaderType - 4.0) < 0.5) {
    if (base.a < 0.01) discard;
    vec3 eyeCol = base.rgb * uLightColor;
    gl_FragColor = vec4(eyeCol, base.a);
    #include <colorspace_fragment>
    return;
  }

  // Type 5: Eye catchlight (additive RGB)
  if (abs(uShaderType - 5.0) < 0.5) {
    vec3 hl = base.rgb * base.a;
    if (max(hl.r, max(hl.g, hl.b)) < 0.005) discard;
    gl_FragColor = vec4(hl, 1.0);
    #include <colorspace_fragment>
    return;
  }

  // Type 3 (eye sclera) & Type 6 (eyebrows / eyelashes / mouth interior)
  if (abs(uShaderType - 3.0) < 0.5 || abs(uShaderType - 6.0) < 0.5) {
    vec3 col = base.rgb * uLightColor;
    if (abs(uShaderType - 3.0) < 0.5 && uHasShade > 0.5) {
      vec4 defS = uHasDef > 0.5 ? texture2D(uDefMap, vUv) : vec4(0.5, 0.5, 0.0, 0.0);
      vec4 sdwS = texture2D(uShadeMap, vUv);
      float lidSdw = clamp((0.5 - defS.r) * 1.6, 0.0, 0.55) * sdwS.a;
      col = mix(col, sdwS.rgb * uLightColor, lidSdw);
    }
    // Type 6 mouth highlight corner boost in DXBC PS_ASM (vUv > 0.96875)
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
    return;
  }

  // Type 1 (m_hirco wispy forehead/side hair strands): soft alpha blend
  bool isWisps = abs(uShaderType - 1.0) < 0.5;
  if (isWisps && base.a < 0.01) discard;

  // Lit toon surfaces: Type 0 (Body), Type 9 (Face skin), Type 8 (Hair), Type 1 (Hair wisps)
  vec3 N = normalize(vNormalView);
  if (!gl_FrontFacing) N = -N;

  vec4 defTex = uHasDef > 0.5 ? texture2D(uDefMap, vUv) : vec4(0.5, 0.5, 0.0, 0.0);
  vec4 shadeTex = uHasShade > 0.5 ? texture2D(uShadeMap, vUv) : vec4(base.rgb * 0.82, 1.0);

  vec3 litAlbedo = base.rgb;
  // Optional _LayerMap overlay ONLY when _LayerWeight > 0 (concert sweat/blush override)
  if (uCheekWeight > 0.001) {
    vec4 lyr = texture2D(uLayerMap, vUv);
    litAlbedo = mix(litAlbedo, lyr.rgb, lyr.a * uCheekWeight);
  }

  // Exact DXBC PS_ASM lines 107-116:
  // r2.w = defTex.r * 2.0 - 1.0; halfL = clamp(0.5 * dot(N, L) + defTex.r, 0.0, 1.0)
  float defBias = 2.0 * defTex.r - 1.0;
  float litTerm;
  if (abs(uShaderType - 9.0) < 0.5) {
    // Face (_ShaderType == 9): smooth head-front stabilization + DXBC Head-X reflection symmetry
    // weighted by defTex.b so cheeks/forehead light cleanly while nose/chin shadows stay crisp
    vec3 faceN = normalize(mix(N, normalize(uHeadFrontView * 0.62 + N * 0.38), clamp(defTex.b * 0.75 + 0.35, 0.0, 0.88)));
    vec3 reflN = normalize(faceN - 2.0 * dot(faceN, uHeadRightView) * uHeadRightView);
    float halfL = clamp(0.5 * dot(faceN, uLightDirView) + defTex.r, 0.0, 1.0);
    float halfLRefl = clamp(0.5 * dot(reflN, uLightDirView) + defTex.r, 0.0, 1.0);
    litTerm = mix(halfL, max(halfL, halfLRefl), defTex.b);
  } else {
    litTerm = clamp(0.5 * dot(N, uLightDirView) + defTex.r, 0.0, 1.0);
  }

  float actorShadow = sampleActorShadow(vWorldPos, defBias);

  // Hair (_ShaderType == 8): angel-ring highlight from _DefMap.a * _HighlightMap (DXBC lines 163-191)
  if (abs(uShaderType - 8.0) < 0.5 && uHasHighlight > 0.5) {
    vec3 H = normalize(uLightDirView + vec3(0.0, 0.0, 1.0));
    float ndh = max(dot(N, H), 0.0);
    float uvMask = (vUv.x > 0.75 && vUv.y < 0.25) ? 0.0 : 1.0;
    float specMask = min(actorShadow, defTex.a) * uvMask;
    float spec = smoothstep(uSpecThreshold, uSpecThreshold + 0.04, pow(ndh, 4.0)) * specMask;
    vec3 hhl = texture2D(uHighlightMap, vUv).rgb;
    litAlbedo = mix(litAlbedo, hhl, clamp(spec * 0.92, 0.0, 1.0));
  }

  float rampU = clamp(min(actorShadow, litTerm), 0.01, 0.99);
  vec4 ramp = texture2D(uRampMap, vec2(rampU, 0.5));

  // Exact DXBC PS_ASM lines 203-216 _ShadeMap.a blend:
  // shadeTex.a == 0 (cloth & hair): mix(litAlbedo, shadeTex.rgb * clothShadeMul, ramp.a)
  // shadeTex.a == 1 (skin): litAlbedo * mix(ramp.rgb, ramp.rgb * uShadeMultiply, ramp.a)
  vec3 clothShadeMul = abs(uShaderType - 8.0) < 0.5
    ? mix(vec3(1.0), uShadeMultiply, 0.65)
    : mix(vec3(1.0), uShadeMultiply, 0.28);
  vec3 modeA = mix(litAlbedo, shadeTex.rgb * clothShadeMul, ramp.a);
  vec3 rampMul = mix(ramp.rgb, ramp.rgb * uShadeMultiply, ramp.a);
  vec3 modeB = litAlbedo * rampMul;
  vec3 shaded = (uHasShade > 0.5 ? mix(modeA, modeB, shadeTex.a) : modeB) * uLightColor;

  // Exact DXBC PS_ASM lines 281-293 rim light (body & hair; crisp uRimPower = 32 edge)
  if (abs(uShaderType - 9.0) > 0.5 && !isWisps) {
    float ndv = clamp(dot(N, vViewDir), 0.0, 1.0);
    float rimSide = smoothstep(0.0, 0.55, dot(N, uRimDirView));
    float rim = pow(1.0 - ndv, max(4.0, uRimPower * 0.35)) * rimSide * min(2.0 * defTex.r, 1.0) * (1.0 - ramp.a * 0.7);
    vec3 rimCol = mix(vec3(1.0), litAlbedo, uRimBaseRatio) * (uRimIntensity * 0.45);
    shaded += rimCol * rim * clamp(defTex.g + 0.25, 0.0, 1.0);
  }

  float outAlpha = isWisps ? base.a : 1.0;
  if (uBangsTranslucency > 0.5) {
    // Exact DXBC PS_ASM lines 192-201: bangs translucency over eyes/brows (stencil > 64),
    // fading smoothly to opaque as head turns into side/back view
    float frontDot = dot(uHeadFrontView, vec3(0.0, 0.0, 1.0));
    float rightAbs = abs(dot(uHeadRightView, vec3(0.0, 0.0, 1.0)));
    float sideFade = max(clamp((0.45 - frontDot) * 2.5, 0.0, 1.0), clamp((rightAbs - 0.65) * 3.0, 0.0, 1.0));
    outAlpha = clamp(1.0 - base.a * (1.0 - sideFade), 0.45, 1.0);
  }

  gl_FragColor = vec4(shaded, outAlpha);
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
  const shadeMap = loadMap(resources, desc, '_ShadeMap', true);
  const defMap = loadMap(resources, desc, '_DefMap', false);
  const rampMap = loadMap(resources, desc, '_RampMap', true, true) || RAMP_DEFAULT;
  const hlMap = loadMap(resources, desc, '_HighlightMap', true);
  const layerWeight = desc.floats._LayerWeight ?? 0.0;
  const layerMap = ((desc.floats._EnableLayerMap ?? 0) >= 0.5 && layerWeight > 0.001)
    ? loadMap(resources, desc, '_LayerMap', true)
    : null;
  const bc = desc.colors._BaseColor || [1, 1, 1, 1];
  const specTh = (desc.colors._SpecularThreshold && desc.colors._SpecularThreshold[0]) ?? 0.15;
  const isWisps = mname === 'm_hirco' || stype === 1;
  const cullZero = (desc.floats._Cull === 0) || isWisps || mname === 'm_eye';
  const receiveShadow = (mname === 'm_fce' || mname === 'm_bdy') ? 1.0 : 0.0;

  const uniforms = {
    uBaseMap: { value: baseMap },
    uShadeMap: { value: shadeMap || WHITE_SRGB },
    uDefMap: { value: defMap || DEF_NEUTRAL },
    uRampMap: { value: rampMap },
    uHighlightMap: { value: hlMap || WHITE_SRGB },
    uLayerMap: { value: layerMap || WHITE_SRGB },
    uActorShadowMap: sharedUniforms.uActorShadowMap,
    uActorShadowMatrix: sharedUniforms.uActorShadowMatrix,
    uBaseColor: { value: new THREE.Vector4(bc[0], bc[1], bc[2], bc[3]) },
    uLightDirView: sharedUniforms.uLightDirView,
    uRimDirView: sharedUniforms.uRimDirView,
    uLightColor: sharedUniforms.uLightColor,
    uShadeMultiply: sharedUniforms.uShadeMultiply,
    uHeadCenterView: sharedUniforms.uHeadCenterView,
    uHeadFrontView: sharedUniforms.uHeadFrontView,
    uHeadRightView: sharedUniforms.uHeadRightView,
    uShaderType: { value: stype },
    uAlphaClip: { value: (!isWisps && (desc.floats._AlphaClip ?? 0) >= 0.5) ? 1.0 : 0.0 },
    uCutoff: { value: desc.floats._Cutoff ?? 0.45 },
    uSpecThreshold: { value: specTh },
    uRimPower: sharedUniforms.uRimPower,
    uRimIntensity: sharedUniforms.uRimIntensity,
    uRimBaseRatio: sharedUniforms.uRimBaseRatio,
    uBangsTranslucency: { value: bangsPass ? 1.0 : 0.0 },
    uHasShade: { value: shadeMap ? 1.0 : 0.0 },
    uHasDef: { value: defMap ? 1.0 : 0.0 },
    uHasHighlight: { value: hlMap ? 1.0 : 0.0 },
    uCheekWeight: { value: layerMap ? layerWeight : 0.0 },
    uShadowStrength: sharedUniforms.uShadowStrength,
    uReceiveActorShadow: { value: receiveShadow },
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

  mat.userData.desc = desc;
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
function cloneSkinnedPass(mesh, mat, suffix, order) {
  const o = new THREE.SkinnedMesh(mesh.geometry, mat);
  o.name = `${mesh.name}_${suffix}`;
  o.bindMode = mesh.bindMode;
  o.bind(mesh.skeleton, mesh.bindMatrix);
  o.morphTargetInfluences = mesh.morphTargetInfluences;
  o.morphTargetDictionary = mesh.morphTargetDictionary;
  o.frustumCulled = false;
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
  return cloneSkinnedPass(mesh, mat, 'outline', RENDER_ORDER.outline);
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
  const disposedTextures = new Set([WHITE_SRGB, DEF_NEUTRAL, RAMP_DEFAULT]);
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
    uHeadCenterView: { value: new THREE.Vector3(0, 0, -1.5) },
    uHeadFrontView: { value: new THREE.Vector3(0, 0, 1) },
    uHeadRightView: { value: new THREE.Vector3(1, 0, 0) },
    uRimPower: { value: DEFAULT_ACTOR_LIGHT.rimPower },
    uRimIntensity: { value: DEFAULT_ACTOR_LIGHT.rimIntensity },
    uRimBaseRatio: { value: DEFAULT_ACTOR_LIGHT.rimBaseRatio },
    uActorShadowMap: { value: WHITE_SRGB },
    uActorShadowMatrix: { value: new THREE.Matrix4() },
    uShadowStrength: { value: DEFAULT_ACTOR_LIGHT.shadowStrength },
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
  const OUTLINED_WIDTH = {
    m_bdy: 0.0022,
    m_fce: 0.0016,
    m_hir: 0.0018,
  };
  root.traverse((o) => {
    if (!o.isMesh) return;
    const desc = descFor(o.material);
    if (!desc) return;

    // Ensure COLOR_0 attribute exists so vertex shader never reads undefined
    if (!o.geometry.attributes.color) {
      const cnt = o.geometry.attributes.position.count;
      const arr = new Float32Array(cnt * 4);
      for (let i = 0; i < cnt; i++) arr[i * 4 + 2] = 8 / 255; // default width nibble = 8
      o.geometry.setAttribute('color', new THREE.BufferAttribute(arr, 4));
    }

    o.material = createActorMaterial(desc, sharedUniforms, resources, false);
    o.renderOrder = RENDER_ORDER[desc.name] ?? 10;
    o.frustumCulled = false;

    if (o.isSkinnedMesh) {
      if (o.morphTargetInfluences && o.morphTargetInfluences.length) morphMeshes.push(o);
      if (desc.name === 'm_hir') {
        const bangsMat = createActorMaterial(desc, sharedUniforms, resources, true);
        extraPasses.push([o.parent, cloneSkinnedPass(o, bangsMat, 'bangs', RENDER_ORDER.m_hir_bangs)]);

        const sMat = new THREE.ShaderMaterial({
          name: 'm_hir_shadow_caster',
          uniforms: {
            uBaseMap: { value: loadMap(resources, desc, '_BaseMap', false) || WHITE_SRGB },
            uActorShadowMatrix: sharedUniforms.uActorShadowMatrix,
          },
          vertexShader: SHADOW_CASTER_VERT,
          fragmentShader: SHADOW_CASTER_FRAG,
          side: THREE.DoubleSide,
          depthWrite: true,
          depthTest: true,
        });
        resources.materials.add(sMat);
        const sMesh = cloneSkinnedPass(o, sMat, 'shadow', 0);
        sMesh.matrixAutoUpdate = false;
        shadowScene.add(sMesh);
        shadowCasters.push([o, sMesh]);
      }
      if (OUTLINE_SCALE > 0 && desc.name in OUTLINED_WIDTH) {
        extraPasses.push([o.parent, createOutlineMesh(o, desc, OUTLINED_WIDTH[desc.name], resources)]);
      }
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
  const _viewMat3 = new THREE.Matrix3();
  const _camMat3 = new THREE.Matrix3();
  const _shadowDirW = new THREE.Vector3();
  const _shadowEyeW = new THREE.Vector3();
  const _shadowTargetW = new THREE.Vector3();
  const _shadowUpW = new THREE.Vector3(0, 1, 0);
  const _shadowView = new THREE.Matrix4();
  const _shadowProj = new THREE.Matrix4().makeOrthographic(-0.20, 0.20, 0.20, -0.20, 0.02, 0.72);
  const _prevClearColor = new THREE.Color();

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

      _viewMat3.setFromMatrix4(camera.matrixWorldInverse);
      sharedUniforms.uHeadCenterView.value.copy(_headPosW).applyMatrix4(camera.matrixWorldInverse);
      sharedUniforms.uHeadFrontView.value.copy(_headFrontW).applyMatrix3(_viewMat3).normalize();
      sharedUniforms.uHeadRightView.value.copy(_headRightW).applyMatrix3(_viewMat3).normalize();

      // VL.Rendering.ActorShadowPass: camera-space Euler(+y, -x, 0) ortho light centered on Head
      _camMat3.setFromMatrix4(camera.matrixWorld);
      _shadowDirW.copy(viewDirFromAngles(-(shadowAngles.x ?? 10), shadowAngles.y ?? 3))
        .applyMatrix3(_camMat3).normalize();
      _shadowTargetW.copy(_headPosW).addScaledVector(_headFrontW, 0.02);
      _shadowTargetW.y += 0.06;
      _shadowEyeW.copy(_shadowTargetW).addScaledVector(_shadowDirW, 0.34);
      _shadowUpW.set(0, 1, 0).applyMatrix3(_camMat3).normalize();
      _shadowView.lookAt(_shadowEyeW, _shadowTargetW, _shadowUpW).setPosition(_shadowEyeW).invert();
      sharedUniforms.uActorShadowMatrix.value.multiplyMatrices(_shadowProj, _shadowView);

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
    },
    /** Render hair caster into _ActorShadowmapTexture before main render pass. */
    renderShadow(renderer) {
      if (resources.disposed || !renderer || !shadowCasters.length || !root.visible) return;
      for (const [srcMesh, dstMesh] of shadowCasters) {
        dstMesh.matrixWorld.copy(srcMesh.matrixWorld);
        dstMesh.matrix.copy(srcMesh.matrixWorld);
      }
      const prevTarget = renderer.getRenderTarget();
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(_prevClearColor);
      renderer.setRenderTarget(actorShadowRT);
      renderer.setClearColor(0xffffff, 1.0); // packDepthToRGBA(1.0) -> far depth = unoccluded!
      renderer.clear(true, true, false);
      renderer.render(shadowScene, shadowCamera);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(_prevClearColor, prevAlpha);
      sharedUniforms.uActorShadowMap.value = actorShadowRT.texture;
    },
    /** Apply VLActorParameter & VLActorShadow overrides from 3D stage or 2D bg volume. */
    applyActorVolume(volOrParam) {
      sharedUniforms.uLightDirView.value.copy(DEFAULT_ACTOR_LIGHT.lightDirView);
      sharedUniforms.uRimDirView.value.copy(DEFAULT_ACTOR_LIGHT.rimDirView);
      sharedUniforms.uLightColor.value.copy(DEFAULT_ACTOR_LIGHT.lightColor);
      sharedUniforms.uShadeMultiply.value.copy(DEFAULT_ACTOR_LIGHT.shadeMultiply);
      sharedUniforms.uRimPower.value = DEFAULT_ACTOR_LIGHT.rimPower;
      sharedUniforms.uRimIntensity.value = DEFAULT_ACTOR_LIGHT.rimIntensity;
      sharedUniforms.uRimBaseRatio.value = DEFAULT_ACTOR_LIGHT.rimBaseRatio;
      sharedUniforms.uShadowStrength.value = DEFAULT_ACTOR_LIGHT.shadowStrength;
      shadowAngles = { ...DEFAULT_ACTOR_LIGHT.shadowAngles };
      if (!volOrParam) return;
      const ap = volOrParam.actorParam || volOrParam;
      const as = volOrParam.actorShadow || null;
      if (ap.mainLightAngle) {
        sharedUniforms.uLightDirView.value.copy(
          viewDirFromAngles(ap.mainLightAngle.x ?? -10, ap.mainLightAngle.y ?? 30),
        );
      }
      if (ap.rimAngle) {
        sharedUniforms.uRimDirView.value.copy(
          viewDirFromAngles(ap.rimAngle.x ?? 10, ap.rimAngle.y ?? 30),
        );
      }
      if (ap.lightColor) {
        sharedUniforms.uLightColor.value.setRGB(ap.lightColor.r, ap.lightColor.g, ap.lightColor.b);
      }
      if (ap.shadeColorMultiply) {
        sharedUniforms.uShadeMultiply.value.setRGB(
          0.14 + 0.86 * ap.shadeColorMultiply.r,
          0.14 + 0.86 * ap.shadeColorMultiply.g,
          0.14 + 0.86 * ap.shadeColorMultiply.b,
        );
      }
      if (typeof ap.rimPower === 'number') sharedUniforms.uRimPower.value = ap.rimPower;
      if (typeof ap.rimBaseColorRatio === 'number') sharedUniforms.uRimBaseRatio.value = ap.rimBaseColorRatio;
      if (ap.rimColor) {
        sharedUniforms.uRimIntensity.value = Math.max(ap.rimColor.r ?? 0.5, ap.rimColor.g ?? 0.5, ap.rimColor.b ?? 0.5);
      }
      if (as) {
        if (as.lightDirectional) {
          shadowAngles = { x: as.lightDirectional.x ?? 10, y: as.lightDirectional.y ?? 3 };
        }
        if (typeof as.shadowStrength === 'number') {
          sharedUniforms.uShadowStrength.value = as.shadowStrength;
        }
      }
    },
    reset() { solver.resetPose(); },
    dispose() {
      if (resources.disposed) return;
      if (root.parent) root.parent.remove(root);
      sharedUniforms.uActorShadowMap.value = WHITE_SRGB;
      shadowScene.clear();
      shadowCasters.length = 0;
      disposeCharacterResources(resources);
    },
  };
  return char;
}
