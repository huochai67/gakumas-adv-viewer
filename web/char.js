// Authentic Campus/Actor/Default character renderer.
//
// Implements the game's actual cel-shading, stencil face/eye/bangs pipeline,
// vertex-color 12-bit artist outlines along TANGENT.xyz, hair _DefMap.a specular
// highlight band, smooth head-normal face shading, and CampusActorFaceCorrection
// view-angle profile morph targets.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PoseSolver } from './pose.js';

const OUTLINE_SCALE = parseFloat(new URLSearchParams(location.search).get('outline') ?? '1.0');
const STENCIL_MASK = 108; // 0x6C (bits 2, 3, 5, 6 used by Campus/Actor/Default)

const TEX_CACHE = new Map();
let TEX_BASE = './assets/';

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

function loadMap(desc, key, srgb, clamp = false) {
  const rel = desc && desc.maps && desc.maps[key];
  if (!rel) return null;
  const url = TEX_BASE + rel;
  const ckey = `${url}|${srgb ? 1 : 0}|${clamp ? 1 : 0}`;
  let tex = TEX_CACHE.get(ckey);
  if (!tex) {
    tex = new THREE.TextureLoader().load(url);
    tex.flipY = false;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.anisotropy = 4;
    TEX_CACHE.set(ckey, tex);
  }
  return tex;
}

// View-space light direction from VLActorParameter Euler angles (deg)
function viewDirFromAngles(pitchDeg, yawDeg) {
  const D2R = Math.PI / 180;
  const px = pitchDeg * D2R;
  const py = yawDeg * D2R;
  // In Three.js camera view space (+X right, +Y up, +Z towards viewer):
  // key light from front-upper-left (yaw=+30 -> -X/+Z, pitch=-10 -> +Y/+Z)
  return new THREE.Vector3(
    -Math.sin(py) * Math.cos(px),
    -Math.sin(px) * 1.35 + 0.22,
    Math.cos(py) * Math.cos(px),
  ).normalize();
}

const DEFAULT_ACTOR_LIGHT = {
  lightDirView: viewDirFromAngles(-10, 28),
  rimDirView: new THREE.Vector3(0.45, 0.55, 0.70).normalize(),
  lightColor: new THREE.Color(0.985, 0.985, 0.985),
  shadeMultiply: new THREE.Color(0.84, 0.72, 0.71),
  rimPower: 24.0,
  rimIntensity: 0.35,
  rimBaseRatio: 0.85,
};

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

uniform sampler2D uBaseMap;
uniform sampler2D uShadeMap;
uniform sampler2D uDefMap;
uniform sampler2D uRampMap;
uniform sampler2D uHighlightMap;
uniform sampler2D uLayerMap;
uniform vec4 uBaseColor;
uniform vec3 uLightDirView;
uniform vec3 uRimDirView;
uniform vec3 uLightColor;
uniform vec3 uShadeMultiply;
uniform vec3 uHeadCenterView;
uniform vec3 uHeadFrontView;

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
varying vec2 vUv;
varying vec3 vNormalView;
varying vec3 vViewDir;
varying vec3 vWorldPos;
varying vec4 vColor;

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

  // Type 5: Eye catchlight (additive)
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
      // Subtle upper-lid sclera shadow from _ShadeMap where _DefMap.r < 0.45
      vec4 defS = uHasDef > 0.5 ? texture2D(uDefMap, vUv) : vec4(0.5, 0.5, 0.0, 0.0);
      vec4 sdwS = texture2D(uShadeMap, vUv);
      float lidSdw = clamp((0.5 - defS.r) * 1.6, 0.0, 0.55) * sdwS.a;
      col = mix(col, sdwS.rgb * uLightColor, lidSdw);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
    return;
  }

  // Lit toon surfaces: Type 0 (Body), Type 9 (Face skin), Type 8 (Hair), Type 1 (Hair wisps)
  vec3 N = normalize(vNormalView);
  if (!gl_FrontFacing) N = -N;

  vec4 defTex = uHasDef > 0.5 ? texture2D(uDefMap, vUv) : vec4(0.5, 0.5, 0.0, 0.0);
  vec4 shadeTex = uHasShade > 0.5 ? texture2D(uShadeMap, vUv) : vec4(base.rgb * 0.82, 1.0);

  // Face skin (_ShaderType == 9): blend smooth head-sphere normal by _DefMap.b
  // so anime cheeks/nose light smoothly without harsh polygon shadow creases
  if (abs(uShaderType - 9.0) < 0.5) {
    vec3 vpPos = -vViewDir; // fallback
    vec3 headN = normalize(mix(N, normalize(uHeadFrontView * 0.55 + N * 0.45), 0.72));
    N = normalize(mix(N, headN, clamp(defTex.b * 0.85 + 0.35, 0.0, 0.92)));
  }

  // Hair (_ShaderType == 8): angel-ring highlight from _DefMap.a * _HighlightMap
  vec3 litAlbedo = base.rgb;
  // Face (_ShaderType == 9): rosy anime cheek blush from _LayerMap left tile (0..0.5 U)
  if (uCheekWeight > 0.001) {
    vec4 cheek = texture2D(uLayerMap, vec2(vUv.x * 0.5, vUv.y));
    litAlbedo = mix(litAlbedo, cheek.rgb, cheek.a * uCheekWeight);
  }
  if (abs(uShaderType - 8.0) < 0.5 && uHasHighlight > 0.5) {
    vec3 H = normalize(uLightDirView + vViewDir);
    float ndh = max(dot(N, H), 0.0);
    // Notice Unity UV V was flipped (vUv.y = 1.0 - v_unity), so v_unity > 0.75 is vUv.y < 0.25
    float uvMask = (vUv.x > 0.75 && vUv.y < 0.25) ? 0.0 : 1.0;
    float spec = smoothstep(uSpecThreshold, uSpecThreshold + 0.04, pow(ndh, 4.0)) * defTex.a * uvMask;
    vec3 hhl = texture2D(uHighlightMap, vUv).rgb;
    litAlbedo = mix(litAlbedo, hhl, clamp(spec * 0.9, 0.0, 1.0));
  }

  // DefMap.r shadow threshold bias (0.5 = neutral, <0.5 = AO/crevice, >0.5 = stays lit)
  float defBias = 2.0 * defTex.r - 1.0;
  float ndl = dot(N, uLightDirView);
  float ndlShift = abs(uShaderType - 9.0) < 0.5 ? 0.02 : 0.14;
  float rampU = clamp(0.5 * (ndl - ndlShift) * 1.45 + 0.50 + 0.95 * defBias, 0.01, 0.99);
  vec4 ramp = texture2D(uRampMap, vec2(rampU, 0.5));

  // Authentic DXBC Campus/Actor/Default _ShadeMap.a mask:
  // shadeTex.a == 0 -> cloth & hair: use artist-painted shadeTex.rgb (cool grey on white pants, berry on hair)
  // shadeTex.a == 1 -> skin: blend warm subsurface ramp.rgb * uShadeMultiply
  vec3 clothMul = abs(uShaderType - 8.0) < 0.5 ? mix(vec3(1.0), uShadeMultiply, 0.55) : mix(vec3(1.0), uShadeMultiply, 0.16);
  vec3 nonSkinShadow = shadeTex.rgb * clothMul;
  vec3 skinShadow = mix(shadeTex.rgb, litAlbedo * ramp.rgb, 0.58) * mix(vec3(1.0), uShadeMultiply, 0.78);
  vec3 shadowTarget = uHasShade > 0.5 ? mix(nonSkinShadow, skinShadow, shadeTex.a) : (litAlbedo * ramp.rgb * uShadeMultiply);
  vec3 shaded = mix(litAlbedo, shadowTarget, ramp.a) * uLightColor;

  // Subtle view-space rim light on lit edges (body & hair)
  if (abs(uShaderType - 9.0) > 0.5) {
    float ndv = clamp(dot(N, vViewDir), 0.0, 1.0);
    float rimDir = clamp(dot(N, uRimDirView), 0.0, 1.0);
    float rim = pow(1.0 - ndv, uRimPower * 0.24) * smoothstep(0.15, 0.75, rimDir) * (1.0 - ramp.a * 0.75);
    vec3 rimCol = mix(vec3(1.0), litAlbedo, uRimBaseRatio) * (uRimIntensity * 0.65);
    shaded += rimCol * rim * defTex.g;
  }

  float outAlpha = 1.0;
  if (uBangsTranslucency > 0.5) {
    // Pass 2 of m_hir over eyes/brows (stencil > 64): artist painted bangs alpha in base.a (0..0.37)
    outAlpha = clamp(1.0 - base.a * 1.15, 0.48, 0.92);
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

function createActorMaterial(desc, sharedUniforms, bangsPass = false) {
  const mname = desc.name;
  const stype = desc.floats._ShaderType ?? 0;
  const baseMap = loadMap(desc, '_BaseMap', true) || WHITE_SRGB;
  const shadeMap = loadMap(desc, '_ShadeMap', true);
  const defMap = loadMap(desc, '_DefMap', false);
  const rampMap = loadMap(desc, '_RampMap', true, true) || RAMP_DEFAULT;
  const hlMap = loadMap(desc, '_HighlightMap', true);
  const layerMap = (desc.floats._EnableLayerMap ?? 0) >= 0.5 ? loadMap(desc, '_LayerMap', true) : null;
  const bc = desc.colors._BaseColor || [1, 1, 1, 1];
  const specTh = (desc.colors._SpecularThreshold && desc.colors._SpecularThreshold[0]) ?? 0.15;
  const isWisps = mname === 'm_hirco' || stype === 1;
  const cullZero = (desc.floats._Cull === 0) || isWisps || mname === 'm_eye';

  const uniforms = {
    uBaseMap: { value: baseMap },
    uShadeMap: { value: shadeMap || WHITE_SRGB },
    uDefMap: { value: defMap || DEF_NEUTRAL },
    uRampMap: { value: rampMap },
    uHighlightMap: { value: hlMap || WHITE_SRGB },
    uLayerMap: { value: layerMap || WHITE_SRGB },
    uBaseColor: { value: new THREE.Vector4(bc[0], bc[1], bc[2], bc[3]) },
    uLightDirView: sharedUniforms.uLightDirView,
    uRimDirView: sharedUniforms.uRimDirView,
    uLightColor: sharedUniforms.uLightColor,
    uShadeMultiply: sharedUniforms.uShadeMultiply,
    uHeadCenterView: sharedUniforms.uHeadCenterView,
    uHeadFrontView: sharedUniforms.uHeadFrontView,
    uShaderType: { value: stype },
    uAlphaClip: { value: isWisps ? 1.0 : 0.0 },
    uCutoff: { value: desc.floats._Cutoff ?? 0.45 },
    uSpecThreshold: { value: specTh },
    uRimPower: sharedUniforms.uRimPower,
    uRimIntensity: sharedUniforms.uRimIntensity,
    uRimBaseRatio: sharedUniforms.uRimBaseRatio,
    uBangsTranslucency: { value: bangsPass ? 1.0 : 0.0 },
    uHasShade: { value: shadeMap ? 1.0 : 0.0 },
    uHasDef: { value: defMap ? 1.0 : 0.0 },
    uHasHighlight: { value: hlMap ? 1.0 : 0.0 },
    uCheekWeight: { value: layerMap ? 0.24 : 0.0 },
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

  // Configure exact Unity queue + stencil states
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
    // Pass 1: Opaque hair everywhere EXCEPT over eyes/brows (stencil <= 64)
    mat.stencilWrite = true;
    mat.stencilRef = 64;
    mat.stencilFunc = THREE.LessEqualStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = 0;
    mat.stencilZPass = THREE.KeepStencilOp;
  } else if (mname === 'm_hir' && bangsPass) {
    // Pass 2: Translucent bangs ONLY over eyes/brows (stencil > 64)
    mat.transparent = true;
    mat.depthWrite = true;
    mat.stencilWrite = true;
    mat.stencilRef = 64;
    mat.stencilFunc = THREE.GreaterStencilFunc;
    mat.stencilFuncMask = STENCIL_MASK;
    mat.stencilWriteMask = 0;
    mat.stencilZPass = THREE.KeepStencilOp;
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
  m_hirco: 18,
  outline: 19,
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

function createOutlineMesh(mesh, desc, baseWidth) {
  const isWisps = desc.name === 'm_hirco' || (desc.floats._ShaderType === 1);
  const baseMap = loadMap(desc, '_BaseMap', true) || WHITE_SRGB;
  const shadeMap = loadMap(desc, '_ShadeMap', true);
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
  // Hair outlines must not draw dark lines across eyes/brows inside bangs
  if (desc.part === 'hair') {
    mat.stencilWrite = true;
    mat.stencilRef = 64;
    mat.stencilFunc = THREE.LessEqualStencilFunc;
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

/**
 * Load the actor model, build its authentic Campus/Actor/Default materials,
 * stencil passes, outlines, and Mecanim PoseSolver.
 */
export async function loadCharacter(scene, opts = {}) {
  const metaUrl = opts.metaUrl || './assets/char.json';
  const url = opts.url || './assets/char.glb';
  TEX_BASE = opts.texBase || metaUrl.replace(/char\.json.*$/, '');
  const meta = await (await fetch(metaUrl)).json();
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;

  const nodeByIndex = new Map();
  for (const [obj, assoc] of gltf.parser.associations) {
    if (assoc && typeof assoc.nodes === 'number') nodeByIndex.set(assoc.nodes, obj);
  }
  for (const n of nodeByIndex.values()) {
    n.userData.bindTRS = { p: n.position.clone(), q: n.quaternion.clone(), s: n.scale.clone() };
  }

  const sharedUniforms = {
    uLightDirView: { value: DEFAULT_ACTOR_LIGHT.lightDirView.clone() },
    uRimDirView: { value: DEFAULT_ACTOR_LIGHT.rimDirView.clone() },
    uLightColor: { value: DEFAULT_ACTOR_LIGHT.lightColor.clone() },
    uShadeMultiply: { value: DEFAULT_ACTOR_LIGHT.shadeMultiply.clone() },
    uHeadCenterView: { value: new THREE.Vector3(0, 0, -1.5) },
    uHeadFrontView: { value: new THREE.Vector3(0, 0, 1) },
    uRimPower: { value: DEFAULT_ACTOR_LIGHT.rimPower },
    uRimIntensity: { value: DEFAULT_ACTOR_LIGHT.rimIntensity },
    uRimBaseRatio: { value: DEFAULT_ACTOR_LIGHT.rimBaseRatio },
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
  const OUTLINED_WIDTH = {
    m_bdy: 0.0022,
    m_fce: 0.0017,
    m_hir: 0.0019,
    m_hirco: 0.0014,
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

    o.material = createActorMaterial(desc, sharedUniforms, false);
    o.renderOrder = RENDER_ORDER[desc.name] ?? 10;
    o.frustumCulled = false;

    if (o.isSkinnedMesh) {
      if (o.morphTargetInfluences && o.morphTargetInfluences.length) morphMeshes.push(o);
      if (desc.name === 'm_hir') {
        const bangsMat = createActorMaterial(desc, sharedUniforms, true);
        extraPasses.push([o.parent, cloneSkinnedPass(o, bangsMat, 'bangs', RENDER_ORDER.m_hir_bangs)]);
      }
      if (OUTLINE_SCALE > 0 && desc.name in OUTLINED_WIDTH) {
        extraPasses.push([o.parent, createOutlineMesh(o, desc, OUTLINED_WIDTH[desc.name])]);
      }
    }
  });

  for (const [parent, child] of extraPasses) parent.add(child);
  scene.add(root);

  const solver = new PoseSolver(nodeByIndex, meta);
  const headNode = solver.nameToNode.Head || null;
  const faceCorr = meta.faceCorrection || null;
  const userMorph = new Map();

  // Temp vectors for per-frame view-space head normal & CampusActorFaceCorrection
  const _headPosW = new THREE.Vector3();
  const _headQuatW = new THREE.Quaternion();
  const _camPosW = new THREE.Vector3();
  const _toCamLocal = new THREE.Vector3();
  const _headFrontW = new THREE.Vector3();
  const _viewMat3 = new THREE.Matrix3();

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
    root, solver, nodeByIndex, meta, morphMeshes, sharedUniforms,
    setMorph(map) {
      userMorph.clear();
      if (map) {
        for (const [i, v] of map) userMorph.set(i, v);
      }
      syncMorphTargets();
    },
    /** Update view-space head uniforms & CampusActorFaceCorrection profile blendshapes. */
    update(camera) {
      if (!camera || !headNode) return;
      root.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);

      headNode.getWorldPosition(_headPosW);
      headNode.getWorldQuaternion(_headQuatW);
      // In Three.js right-handed converted space, character faces -Z in local Head space
      _headFrontW.set(0, 0, -1).applyQuaternion(_headQuatW).normalize();

      _viewMat3.setFromMatrix4(camera.matrixWorldInverse);
      sharedUniforms.uHeadCenterView.value.copy(_headPosW).applyMatrix4(camera.matrixWorldInverse);
      sharedUniforms.uHeadFrontView.value.copy(_headFrontW).applyMatrix3(_viewMat3).normalize();

      // CampusActorFaceCorrection: compute camera azimuth/elevation in Head local frame
      if (faceCorr && faceCorr.indices && faceCorr.curves) {
        camera.getWorldPosition(_camPosW);
        _toCamLocal.copy(_camPosW).sub(_headPosW).applyQuaternion(_headQuatW.clone().invert()).normalize();
        // Forward is -Z, character left is -X, character right is +X?
        // Wait: in Unity character faces +Z, LeftArm is at -X, RightArm is at +X;
        // after conv_v (x, y, -z), character faces -Z, LeftArm is at -X, RightArm is at +X!
        const yawDeg = Math.atan2(_toCamLocal.x, -_toCamLocal.z) * (180 / Math.PI);
        const elevDeg = Math.asin(Math.max(-1, Math.min(1, _toCamLocal.y))) * (180 / Math.PI);
        const absYaw = Math.abs(yawDeg);
        const corr = [
          [faceCorr.indices[0], evalSimpleCurve(faceCorr.curves[0], elevDeg)], // 84: under045
          [faceCorr.indices[1], evalSimpleCurve(faceCorr.curves[1], absYaw)],  // 85: side090
          [faceCorr.indices[2], evalSimpleCurve(faceCorr.curves[2], yawDeg)],  // 86: side045r
          [faceCorr.indices[3], evalSimpleCurve(faceCorr.curves[3], yawDeg)],  // 87: side045l
        ];
        syncMorphTargets(corr);
      }
    },
    /** Apply VLActorParameter overrides from 3D stage volume if present. */
    applyActorVolume(ap) {
      if (!ap) return;
      if (ap.mainLightAngle) {
        sharedUniforms.uLightDirView.value.copy(
          viewDirFromAngles(ap.mainLightAngle.x ?? -10, ap.mainLightAngle.y ?? 28),
        );
      }
      if (ap.lightColor) {
        sharedUniforms.uLightColor.value.setRGB(ap.lightColor.r, ap.lightColor.g, ap.lightColor.b);
      }
      if (ap.shadeColorMultiply) {
        // Soften raw linear multiply slightly to account for indirect stage GI bounce
        sharedUniforms.uShadeMultiply.value.setRGB(
          0.18 + 0.82 * ap.shadeColorMultiply.r,
          0.18 + 0.82 * ap.shadeColorMultiply.g,
          0.18 + 0.82 * ap.shadeColorMultiply.b,
        );
      }
    },
    reset() { solver.resetPose(); },
  };
  return char;
}
