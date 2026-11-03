// Post-processing pipeline: Unity VLDOF (thin-lens 5-blade Vogel bokeh DoF for
// both 3D stages and 2D ClippingRectFitter backgrounds) + URP Bloom + grading.

import * as THREE from 'three';

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// 2D background pass: maps screen UV -> 2D artwork UV via ClippingRectFitter matrix,
// converts sRGB -> linear, runs 48-tap 5-blade Vogel disc bokeh in linear light when DoF is active,
// and caches the result until background / transform / CoC changes.
const BG2D_FRAG = /* glsl */`
uniform sampler2D tBg;
uniform mat3 uUvMat;
uniform vec2 uTexel;
uniform float uCocPx;
varying vec2 vUv;

vec3 srgb2lin(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

float ngonRadius(float theta) {
  // Soft 5-blade aperture (bladeCount=5, bladeCurvature=1.0 -> gentle pentagonal-circular bokeh)
  const float N = 5.0;
  const float PI = 3.14159265;
  float a = mod(theta, 2.0 * PI / N) - PI / N;
  float poly = cos(PI / N) / max(0.2, cos(a));
  return mix(poly, 1.0, 0.72);
}

void main() {
  // vUv has y=0 bottom, y=1 top; screen px origin in story.js is top-left (x, 1-y)
  vec2 scr = vec2(vUv.x, 1.0 - vUv.y);
  vec2 baseUv = (uUvMat * vec3(scr, 1.0)).xy;
  if (uCocPx < 0.75) {
    vec3 s = texture2D(tBg, clamp(baseUv, vec2(0.0005), vec2(0.9995))).rgb;
    gl_FragColor = vec4(srgb2lin(s), 1.0);
    return;
  }
  // Convert screen-pixel disc step into UV delta through linear part of uUvMat
  vec2 duvX = (uUvMat * vec3(uTexel.x, 0.0, 0.0)).xy;
  vec2 duvY = (uUvMat * vec3(0.0, uTexel.y, 0.0)).xy;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  const int TAPS = 48;
  const float GOLDEN = 2.39996323;
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i);
    float r = sqrt((fi + 0.5) / float(TAPS)) * uCocPx;
    float th = fi * GOLDEN;
    r *= ngonRadius(th);
    vec2 offPx = vec2(cos(th), sin(th)) * r;
    vec2 uvS = clamp(baseUv + duvX * offPx.x + duvY * offPx.y, vec2(0.0005), vec2(0.9995));
    vec3 lin = srgb2lin(texture2D(tBg, uvS).rgb);
    // Slight HDR highlight preservation matching URP VLDOF bokeh energy
    float luma = dot(lin, vec3(0.2126, 0.7152, 0.0722));
    float w = 1.0 + 0.35 * smoothstep(0.55, 1.0, luma);
    acc += lin * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / max(wsum, 1e-4), 1.0);
}`;

// 3D VLDOF Pass 1 (half-res): bilateral CoC-aware downsample from full-res color + hardware depth.
const DOF_PREFILTER_FRAG = /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uFullTexel;
uniform float uNear;
uniform float uFar;
uniform float uFocalPoint;
uniform float uFocalSize;
uniform float uCocInfPx;
uniform float uMaxCocPx;
varying vec2 vUv;

float linearDepth(float d) {
  return (uNear * uFar) / max(1e-5, uFar - d * (uFar - uNear));
}

float calcCoc(float d) {
  if (d >= 0.99995) return clamp(uCocInfPx, -uMaxCocPx, uMaxCocPx);
  float z = max(0.05, linearDepth(d));
  // Unity VLDOF focalSize slab: [P - 0.45*focalSize, P + 0.10*focalSize] stays at CoC = 0
  float nearFocus = max(0.05, uFocalPoint - 0.45 * uFocalSize);
  float farFocus = uFocalPoint + 0.10 * uFocalSize;
  float raw = 0.0;
  if (z < nearFocus) {
    raw = uCocInfPx * (1.0 - nearFocus / z);
  } else if (z > farFocus) {
    raw = uCocInfPx * (1.0 - uFocalPoint / z) * smoothstep(farFocus, farFocus + 0.20, z);
  }
  return clamp(raw, -uMaxCocPx, uMaxCocPx);
}

void main() {
  vec2 o = uFullTexel * 0.5;
  vec2 u0 = vUv + vec2(-o.x, -o.y);
  vec2 u1 = vUv + vec2( o.x, -o.y);
  vec2 u2 = vUv + vec2(-o.x,  o.y);
  vec2 u3 = vUv + vec2( o.x,  o.y);

  float c0 = calcCoc(texture2D(tDepth, u0).x);
  float c1 = calcCoc(texture2D(tDepth, u1).x);
  float c2 = calcCoc(texture2D(tDepth, u2).x);
  float c3 = calcCoc(texture2D(tDepth, u3).x);

  vec3 s0 = texture2D(tColor, u0).rgb;
  vec3 s1 = texture2D(tColor, u1).rgb;
  vec3 s2 = texture2D(tColor, u2).rgb;
  vec3 s3 = texture2D(tColor, u3).rgb;

  // Strictly exclude sharp foreground taps (|c| < 0.5) at depth discontinuities so foreground outlines never leak
  float mCoc = max(max(abs(c0), abs(c1)), max(abs(c2), abs(c3)));
  float g0 = mCoc > 1.0 ? step(0.5, abs(c0)) : 1.0;
  float g1 = mCoc > 1.0 ? step(0.5, abs(c1)) : 1.0;
  float g2 = mCoc > 1.0 ? step(0.5, abs(c2)) : 1.0;
  float g3 = mCoc > 1.0 ? step(0.5, abs(c3)) : 1.0;
  float w0 = g0 / (1.0 + max(s0.r, max(s0.g, s0.b)) * 0.25);
  float w1 = g1 / (1.0 + max(s1.r, max(s1.g, s1.b)) * 0.25);
  float w2 = g2 / (1.0 + max(s2.r, max(s2.g, s2.b)) * 0.25);
  float w3 = g3 / (1.0 + max(s3.r, max(s3.g, s3.b)) * 0.25);
  float ws = max(1e-4, w0 + w1 + w2 + w3);
  vec3 col = (s0 * w0 + s1 * w1 + s2 * w2 + s3 * w3) / ws;
  float coc = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / ws;
  gl_FragColor = vec4(col, coc);
}`;

// 3D VLDOF Pass 2 (half-res): 48-tap 5-blade Vogel disc bokeh with foreground/background anti-halo guard.
const DOF_BOKEH_FRAG = /* glsl */`
uniform sampler2D tPrefilter;
uniform vec2 uFullTexel;
uniform float uMaxCocPx;
uniform float uFgExtrude;
varying vec2 vUv;

float ngonRadius(float theta) {
  const float N = 5.0;
  const float PI = 3.14159265;
  float a = mod(theta, 2.0 * PI / N) - PI / N;
  float poly = cos(PI / N) / max(0.2, cos(a));
  return mix(poly, 1.0, 0.72);
}

void main() {
  vec4 center = texture2D(tPrefilter, vUv);
  float centerCoc = center.a;

  vec3 bgAcc = vec3(0.0);
  float bgW = 0.0;
  vec3 fgAcc = vec3(0.0);
  float fgW = 0.0;

  const int TAPS = 48;
  const float GOLDEN = 2.39996323;
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i);
    float rNorm = sqrt((fi + 0.5) / float(TAPS));
    float th = fi * GOLDEN;
    float distPx = rNorm * uMaxCocPx * ngonRadius(th);
    vec2 uvS = clamp(vUv + vec2(cos(th), sin(th)) * distPx * uFullTexel, vec2(0.001), vec2(0.999));
    vec4 tap = texture2D(tPrefilter, uvS);
    float tapCoc = tap.a;
    float luma = dot(tap.rgb, vec3(0.2126, 0.7152, 0.0722));
    float hdrW = 1.0 + 0.35 * smoothstep(0.65, 1.2, luma);

    if (tapCoc > 0.5) {
      // Far field: only accept background taps whose own CoC covers distPx (blocks sharp foreground halo!)
      float spreadCmp = smoothstep(0.0, 1.75, tapCoc - distPx + 1.25);
      float depthCmp = centerCoc > 0.5 ? smoothstep(-1.5, 0.5, tapCoc - centerCoc) : 1.0;
      float w = spreadCmp * mix(0.25, 1.0, depthCmp) * hdrW;
      bgAcc += tap.rgb * w;
      bgW += w;
    } else if (tapCoc < -0.5) {
      // Near field (foreground objects closer than focalPoint): extrude smoothly over midground
      float fgRad = abs(tapCoc) * uFgExtrude;
      float w = smoothstep(0.0, 1.75, fgRad - distPx + 1.25) * hdrW;
      fgAcc += tap.rgb * w;
      fgW += w;
    }
  }

  if (bgW <= 1e-4 && fgW <= 1e-4) {
    // Pure in-focus interior texel: mark sentinel a = -1 so post-filter never blurs foreground into bokeh
    gl_FragColor = vec4(center.rgb, -1.0);
    return;
  }
  vec3 bgCol = bgW > 1e-4 ? (bgAcc / bgW) : center.rgb;
  vec3 fgCol = fgW > 1e-4 ? (fgAcc / fgW) : bgCol;
  float fgAlpha = clamp((fgW / float(TAPS)) * 2.2, 0.0, 1.0);
  vec3 outCol = mix(bgCol, fgCol, fgAlpha);
  gl_FragColor = vec4(outCol, fgAlpha);
}`;

// 3D VLDOF Pass 2b (half-res): 3x3 tent filter (URP BokehPostBlurMRT) to eliminate Vogel tap stipple.
const DOF_POST_FRAG = /* glsl */`
uniform sampler2D tBokeh;
uniform vec2 uHalfTexel;
varying vec2 vUv;
void main() {
  vec2 o = uHalfTexel * 0.85;
  vec4 c0 = texture2D(tBokeh, vUv);
  vec3 acc = vec3(0.0);
  float aAcc = 0.0;
  float wsum = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec4 t = texture2D(tBokeh, vUv + vec2(float(dx), float(dy)) * o);
      if (t.a < -0.5) continue;
      float kw = (dx == 0 ? 2.0 : 1.0) * (dy == 0 ? 2.0 : 1.0);
      acc += t.rgb * kw;
      aAcc += max(0.0, t.a) * kw;
      wsum += kw;
    }
  }
  if (wsum <= 1e-4) {
    gl_FragColor = vec4(c0.rgb, 0.0);
    return;
  }
  gl_FragColor = vec4(acc / wsum, aAcc / wsum);
}`;

// 3D VLDOF Pass 3 (full-res): combines 4x-MSAA sharp scene with half-res bokeh using full-res depth CoC.
const DOF_COMBINE_FRAG = /* glsl */`
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tBokeh;
uniform float uNear;
uniform float uFar;
uniform float uFocalPoint;
uniform float uFocalSize;
uniform float uCocInfPx;
uniform float uMaxCocPx;
varying vec2 vUv;

float linearDepth(float d) {
  return (uNear * uFar) / max(1e-5, uFar - d * (uFar - uNear));
}

void main() {
  vec4 sharp = texture2D(tScene, vUv);
  float d = texture2D(tDepth, vUv).x;
  float raw = 0.0;
  if (d >= 0.99995) {
    raw = uCocInfPx;
  } else {
    float z = max(0.05, linearDepth(d));
    float nearFocus = max(0.05, uFocalPoint - 0.45 * uFocalSize);
    float farFocus = uFocalPoint + 0.10 * uFocalSize;
    if (z < nearFocus) raw = uCocInfPx * (1.0 - nearFocus / z);
    else if (z > farFocus) raw = uCocInfPx * (1.0 - uFocalPoint / z) * smoothstep(farFocus, farFocus + 0.20, z);
  }
  float absCoc = clamp(abs(raw), 0.0, uMaxCocPx);
  vec4 bokeh = texture2D(tBokeh, vUv);
  float bgBlend = smoothstep(0.35, 2.0, absCoc);
  float blend = max(bgBlend, max(0.0, bokeh.a));
  gl_FragColor = vec4(mix(sharp.rgb, bokeh.rgb, blend), sharp.a);
}`;

const BRIGHT_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float f = smoothstep(uThreshold, uThreshold + uKnee, l);
  gl_FragColor = vec4(c * f, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(tSrc, vUv).rgb * 0.227027;
  s += (texture2D(tSrc, vUv + uDir * 1.3846).rgb + texture2D(tSrc, vUv - uDir * 1.3846).rgb) * 0.3162162;
  s += (texture2D(tSrc, vUv + uDir * 3.2308).rgb + texture2D(tSrc, vUv - uDir * 3.2308).rgb) * 0.0702702;
  gl_FragColor = vec4(s, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tBg2d;
uniform float uHasBg2d;
uniform float uStrength;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
varying vec2 vUv;
vec3 lin2srgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
vec3 grade3d(vec3 lin) {
  vec3 c = lin2srgb(max(lin * uExposure, vec3(0.0)));
  c = (c - 0.5) * uContrast + 0.5;
  c = max(c, vec3(0.0));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return clamp(mix(vec3(l), c, uSaturation), 0.0, 1.0);
}
void main() {
  vec4 s = texture2D(tScene, vUv);
  vec3 b = texture2D(tBloom, vUv).rgb * uStrength;
  if (uHasBg2d > 0.5) {
    // 2D artwork is pre-graded; preserve 1:1 sRGB background color + linear Vogel bokeh while
    // compositing graded 3D character (premultiplied/OVER alpha) and additive bloom on top.
    vec3 bgLin = texture2D(tBg2d, vUv).rgb;
    vec3 bgSrgb = clamp(lin2srgb(max(bgLin + b * 0.55, vec3(0.0))), 0.0, 1.0);
    if (s.a <= 0.0005) {
      gl_FragColor = vec4(bgSrgb, 1.0);
      return;
    }
    // Un-premultiply if needed on semi-transparent wispy hair fringes, grade actor, OVER composite
    vec3 fgLin = s.rgb / max(s.a, 0.02);
    vec3 fgSrgb = grade3d(fgLin + b);
    gl_FragColor = vec4(mix(bgSrgb, fgSrgb, clamp(s.a, 0.0, 1.0)), 1.0);
    return;
  }
  gl_FragColor = vec4(grade3d(s.rgb + b), s.a);
}`;

function pass(frag, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
  });
}

/** Compute physical thin-lens Circle-of-Confusion radius at infinity & max cap (in pixels of `screenH`). */
export function computeVldofRadii(dof, focalLengthMm, screenH) {
  if (!dof || !dof.active) {
    return { active: false, cocInfPx: 0, maxCocPx: 0, focalPoint: 2.0, focalSize: 1.0, fgExtrude: 1.15 };
  }
  const f = Math.max(8, focalLengthMm || 55) * 0.001;
  const fNumber = Math.max(0.2, dof.fNumber ?? 3.0);
  const focalPoint = Math.max(f + 0.02, dof.focalPoint ?? 2.0);
  const focalSize = Math.max(0.0, dof.focalSize ?? 1.0);
  const maxBlurSpread = Math.max(0.1, dof.maxBlurSpread ?? 3.0);
  // Physical CoC radius on Unity's 24mm vertical sensor: 0.5 * f^2 / (N * (P - f) * 0.024) * H
  const cocInfPx = 0.5 * (f * f) / (fNumber * (focalPoint - f) * 0.024) * screenH;
  const maxCocPx = maxBlurSpread * (7.4 / 1920) * screenH;
  return {
    active: maxCocPx > 0.75 && cocInfPx > 0.75,
    cocInfPx,
    maxCocPx,
    focalPoint,
    focalSize,
    fgExtrude: dof.foregroundBlurExtrude ?? 1.15,
  };
}

export function createBloom(renderer, {
  strength = 0.35, threshold = 0.95, knee = 0.25,
  exposure = 0.96, contrast = 1.04, saturation = 1.06,
} = {}) {
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  quadScene.add(quad);

  const size = new THREE.Vector2();
  renderer.getSize(size);
  const dpr0 = renderer.getPixelRatio();
  const W0 = Math.max(1, Math.floor(size.x * dpr0));
  const H0 = Math.max(1, Math.floor(size.y * dpr0));
  const hdrType = THREE.HalfFloatType;

  const rtScene = new THREE.WebGLRenderTarget(W0, H0, {
    type: hdrType, samples: 4, depthBuffer: true, stencilBuffer: true,
  });

  // Single-sampled depth-stencil target matching rtScene's DEPTH24_STENCIL8 for WebGL2 MSAA depth blit
  const depthTex = new THREE.DepthTexture(W0, H0);
  depthTex.format = THREE.DepthStencilFormat;
  depthTex.type = THREE.UnsignedInt248Type;
  const rtDepthResolve = new THREE.WebGLRenderTarget(W0, H0, {
    type: THREE.UnsignedByteType,
    samples: 0,
    depthBuffer: true,
    stencilBuffer: true,
    depthTexture: depthTex,
  });

  // NearestFilter on prefilter/gather targets prevents bilinear mixing of CoC=0 foreground with CoC>0 background
  const rtDofHalfA = new THREE.WebGLRenderTarget(Math.max(1, W0 >> 1), Math.max(1, H0 >> 1), {
    type: hdrType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const rtDofHalfB = new THREE.WebGLRenderTarget(Math.max(1, W0 >> 1), Math.max(1, H0 >> 1), {
    type: hdrType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const rtDofPost = new THREE.WebGLRenderTarget(Math.max(1, W0 >> 1), Math.max(1, H0 >> 1), {
    type: hdrType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const rtDofFull = new THREE.WebGLRenderTarget(W0, H0, {
    type: hdrType, depthBuffer: false,
  });
  const rtBg2d = new THREE.WebGLRenderTarget(W0, H0, {
    type: hdrType, depthBuffer: false,
  });

  const rtA = new THREE.WebGLRenderTarget(1, 1, { type: hdrType, depthBuffer: false });
  const rtB = new THREE.WebGLRenderTarget(1, 1, { type: hdrType, depthBuffer: false });

  const bg2dMat = pass(BG2D_FRAG, {
    tBg: { value: null },
    uUvMat: { value: new THREE.Matrix3() },
    uTexel: { value: new THREE.Vector2(1 / W0, 1 / H0) },
    uCocPx: { value: 0 },
  });
  const dofPrefilterMat = pass(DOF_PREFILTER_FRAG, {
    tColor: { value: rtScene.texture },
    tDepth: { value: depthTex },
    uFullTexel: { value: new THREE.Vector2(1 / W0, 1 / H0) },
    uNear: { value: 0.1 },
    uFar: { value: 1000 },
    uFocalPoint: { value: 2.0 },
    uFocalSize: { value: 1.0 },
    uCocInfPx: { value: 0 },
    uMaxCocPx: { value: 0 },
  });
  const dofBokehMat = pass(DOF_BOKEH_FRAG, {
    tPrefilter: { value: rtDofHalfA.texture },
    uFullTexel: { value: new THREE.Vector2(1 / W0, 1 / H0) },
    uMaxCocPx: { value: 0 },
    uFgExtrude: { value: 1.15 },
  });
  const dofPostMat = pass(DOF_POST_FRAG, {
    tBokeh: { value: rtDofHalfB.texture },
    uHalfTexel: { value: new THREE.Vector2(2 / W0, 2 / H0) },
  });
  const dofCombineMat = pass(DOF_COMBINE_FRAG, {
    tScene: { value: rtScene.texture },
    tDepth: { value: depthTex },
    tBokeh: { value: rtDofPost.texture },
    uNear: { value: 0.1 },
    uFar: { value: 1000 },
    uFocalPoint: { value: 2.0 },
    uFocalSize: { value: 1.0 },
    uCocInfPx: { value: 0 },
    uMaxCocPx: { value: 0 },
  });

  const brightMat = pass(BRIGHT_FRAG, {
    tSrc: { value: rtScene.texture },
    uThreshold: { value: threshold },
    uKnee: { value: knee },
  });
  const blurMat = pass(BLUR_FRAG, {
    tSrc: { value: null },
    uDir: { value: new THREE.Vector2() },
  });
  const compMat = pass(COMPOSITE_FRAG, {
    tScene: { value: rtScene.texture },
    tBloom: { value: rtA.texture },
    tBg2d: { value: rtBg2d.texture },
    uHasBg2d: { value: 0 },
    uStrength: { value: strength },
    uExposure: { value: exposure },
    uContrast: { value: contrast },
    uSaturation: { value: saturation },
  });

  let dofCfg = null;
  let focalLengthMm = 30;
  let is3dScene = false;
  let bg2dState = { active: false, texture: null, uvMat: new THREE.Matrix3(), key: '' };
  let cachedBgKey = '';

  function draw(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  /** Resolve multisampled rtScene hardware depth into single-sampled depthTex via WebGL2 blitFramebuffer. */
  function blitSceneDepth() {
    const gl = renderer.getContext();
    if (!gl || typeof gl.blitFramebuffer !== 'function') return false;
    // Switch away from rtScene first so Three.js resolves current-frame MSAA color & depth into __webglFramebuffer!
    renderer.setRenderTarget(null);
    const props = renderer.properties;
    if (!props.get(rtDepthResolve).__webglFramebuffer) {
      renderer.setRenderTarget(rtDepthResolve);
      renderer.setRenderTarget(null);
    }
    const srcFb = props.get(rtScene).__webglFramebuffer;
    const dstFb = props.get(rtDepthResolve).__webglFramebuffer;
    if (!srcFb || !dstFb) return false;
    const w = rtScene.width, h = rtScene.height;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dstFb);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    renderer.state.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  return {
    setSize(w, h) {
      const dpr = renderer.getPixelRatio();
      const pw = Math.max(1, Math.floor(w * dpr));
      const ph = Math.max(1, Math.floor(h * dpr));
      rtScene.setSize(pw, ph);
      rtDepthResolve.setSize(pw, ph);
      rtDofFull.setSize(pw, ph);
      rtBg2d.setSize(pw, ph);
      const hw = Math.max(1, pw >> 1);
      const hh = Math.max(1, ph >> 1);
      rtDofHalfA.setSize(hw, hh);
      rtDofHalfB.setSize(hw, hh);
      rtDofPost.setSize(hw, hh);
      const bw = Math.max(1, Math.floor(pw / 4));
      const bh = Math.max(1, Math.floor(ph / 4));
      rtA.setSize(bw, bh);
      rtB.setSize(bw, bh);
      blurMat.uniforms.uDir.value.set(1 / bw, 0);
      bg2dMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      dofPrefilterMat.uniforms.uFullTexel.value.set(1 / pw, 1 / ph);
      dofBokehMat.uniforms.uFullTexel.value.set(1 / pw, 1 / ph);
      dofPostMat.uniforms.uHalfTexel.value.set(1 / hw, 1 / hh);
      cachedBgKey = '';
    },
    setDof(dof, camFocalLengthMm, is3d) {
      dofCfg = dof || null;
      focalLengthMm = camFocalLengthMm || 30;
      is3dScene = !!is3d;
    },
    setBg2D(cfg) {
      if (!cfg || !cfg.active || !cfg.texture) {
        bg2dState.active = false;
        return;
      }
      bg2dState.active = true;
      bg2dState.texture = cfg.texture;
      bg2dState.uvMat.copy(cfg.uvMatrix);
      bg2dState.srcId = cfg.srcId || '';
    },
    /** Render `scene` through VLDOF + Bloom + ColorAdjustments into the canvas. */
    render(scene, camera) {
      const pw = rtScene.width, ph = rtScene.height;
      const vldof = computeVldofRadii(dofCfg, focalLengthMm, ph);

      // 1. Update cached 2D background bokeh buffer when in 2D stage mode
      if (!is3dScene && bg2dState.active && bg2dState.texture) {
        const bgCoc = vldof.active ? Math.min(vldof.cocInfPx, vldof.maxCocPx) : 0;
        const m = bg2dState.uvMat.elements;
        const key = `${bg2dState.srcId}|${pw}x${ph}|${bgCoc.toFixed(2)}|${m.map((v) => v.toFixed(5)).join(',')}`;
        if (key !== cachedBgKey) {
          cachedBgKey = key;
          bg2dMat.uniforms.tBg.value = bg2dState.texture;
          bg2dMat.uniforms.uUvMat.value.copy(bg2dState.uvMat);
          bg2dMat.uniforms.uCocPx.value = bgCoc;
          draw(bg2dMat, rtBg2d);
        }
        compMat.uniforms.uHasBg2d.value = 1;
      } else {
        compMat.uniforms.uHasBg2d.value = 0;
      }

      // 2. Render 3D scene (4x MSAA + hardware stencil) into rtScene
      renderer.setRenderTarget(rtScene);
      renderer.clear();
      renderer.render(scene, camera);

      // 3. Run 3D depth-buffer VLDOF pass when active on a 3D stage
      let sceneColorTex = rtScene.texture;
      if (is3dScene && vldof.active && blitSceneDepth()) {
        dofPrefilterMat.uniforms.uNear.value = camera.near;
        dofPrefilterMat.uniforms.uFar.value = camera.far;
        dofPrefilterMat.uniforms.uFocalPoint.value = vldof.focalPoint;
        dofPrefilterMat.uniforms.uFocalSize.value = vldof.focalSize;
        dofPrefilterMat.uniforms.uCocInfPx.value = vldof.cocInfPx;
        dofPrefilterMat.uniforms.uMaxCocPx.value = vldof.maxCocPx;
        draw(dofPrefilterMat, rtDofHalfA);

        dofBokehMat.uniforms.tPrefilter.value = rtDofHalfA.texture;
        dofBokehMat.uniforms.uMaxCocPx.value = vldof.maxCocPx;
        dofBokehMat.uniforms.uFgExtrude.value = vldof.fgExtrude;
        draw(dofBokehMat, rtDofHalfB);

        dofPostMat.uniforms.tBokeh.value = rtDofHalfB.texture;
        draw(dofPostMat, rtDofPost);

        dofCombineMat.uniforms.uNear.value = camera.near;
        dofCombineMat.uniforms.uFar.value = camera.far;
        dofCombineMat.uniforms.uFocalPoint.value = vldof.focalPoint;
        dofCombineMat.uniforms.uFocalSize.value = vldof.focalSize;
        dofCombineMat.uniforms.uCocInfPx.value = vldof.cocInfPx;
        dofCombineMat.uniforms.uMaxCocPx.value = vldof.maxCocPx;
        dofCombineMat.uniforms.tBokeh.value = rtDofPost.texture;
        draw(dofCombineMat, rtDofFull);
        sceneColorTex = rtDofFull.texture;
      }

      // 4. URP Bloom + ColorAdjustments composite
      brightMat.uniforms.tSrc.value = sceneColorTex;
      draw(brightMat, rtB);

      const bw = rtA.width, bh = rtA.height;
      blurMat.uniforms.tSrc.value = rtB.texture;
      blurMat.uniforms.uDir.value.set(1 / bw, 0);
      draw(blurMat, rtA);
      blurMat.uniforms.tSrc.value = rtA.texture;
      blurMat.uniforms.uDir.value.set(0, 1 / bh);
      draw(blurMat, rtB);
      blurMat.uniforms.tSrc.value = rtB.texture;
      blurMat.uniforms.uDir.value.set(2 / bw, 0);
      draw(blurMat, rtA);
      blurMat.uniforms.tSrc.value = rtA.texture;
      blurMat.uniforms.uDir.value.set(0, 2 / bh);
      draw(blurMat, rtB);

      compMat.uniforms.tScene.value = sceneColorTex;
      compMat.uniforms.tBloom.value = rtB.texture;
      draw(compMat, null);
      renderer.setRenderTarget(null);
    },
  };
}
