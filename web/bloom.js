// Minimal additive bloom, built from core three only.
//
// The game's ADV frames are graded with a soft glow: windows and lamps bleed
// into the room and the whole frame picks up a haze. A full EffectComposer is
// not vendored here, so this runs the four passes by hand:
//   scene -> HDR target -> bright pass (1/4 res) -> separable blur x2 ->
//   composite with the scene and sRGB encode.

import * as THREE from 'three';

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
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
void main() {
  vec4 s = texture2D(tScene, vUv);
  vec3 b = texture2D(tBloom, vUv).rgb;
  vec3 lin = (s.rgb + b * uStrength) * uExposure;
  vec3 c = lin2srgb(max(lin, vec3(0.0)));
  // URP ColorAdjustments contrast & saturation
  c = (c - 0.5) * uContrast + 0.5;
  c = max(c, vec3(0.0));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), s.a);
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
  const hdrType = THREE.HalfFloatType;
  const rtScene = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: hdrType, samples: 4, depthBuffer: true, stencilBuffer: true,
  });
  const rtA = new THREE.WebGLRenderTarget(1, 1, { type: hdrType, depthBuffer: false });
  const rtB = new THREE.WebGLRenderTarget(1, 1, { type: hdrType, depthBuffer: false });

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
    uStrength: { value: strength },
    uExposure: { value: exposure },
    uContrast: { value: contrast },
    uSaturation: { value: saturation },
  });
  function draw(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  return {
    setSize(w, h) {
      const dpr = renderer.getPixelRatio();
      rtScene.setSize(Math.max(1, Math.floor(w * dpr)), Math.max(1, Math.floor(h * dpr)));
      const bw = Math.max(1, Math.floor(w * dpr / 4));
      const bh = Math.max(1, Math.floor(h * dpr / 4));
      rtA.setSize(bw, bh);
      rtB.setSize(bw, bh);
      blurMat.uniforms.uDir.value.set(1 / bw, 0);
    },
    /** Render `scene` through the bloom chain into the canvas. */
    render(scene, camera) {
      renderer.setRenderTarget(rtScene);
      renderer.clear();
      renderer.render(scene, camera);

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

      compMat.uniforms.tBloom.value = rtB.texture;
      draw(compMat, null);
      renderer.setRenderTarget(null);
    },
  };
}
