// Rig debug page: one character, one clip, free camera.
//
// The story player (story.js) is the user-facing viewer; this page exists to
// inspect the exported rig, materials and clip sampling in isolation.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadCharacter } from './char.js';
import { getClip, evalClip } from './clips.js';
import { applyCameraSetting } from './camera.js';

const statusEl = document.getElementById('status');
const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 1.3, 1.6);

const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(0.4, 0.9, 0.8);
scene.add(key);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x404050, 1.6));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enabled = false;
controls.target.set(0, 1.05, 0);

let char = null;
let poseClip = null;
let facialClip = null;
let playing = true;
let currentTime = 0;
let duration = 4;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/** Sample a clip and push it onto the rig. */
function applyClip(clip, time, blend = 1) {
  if (!clip || !char) return null;
  const f = evalClip(clip, time);
  const pose = char.solver.poseFrom(f.muscles, f.bones, f.root);
  char.solver.applyPose(null, pose, blend);
  return f;
}

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') || 'anim';

async function boot() {
  try {
    char = await loadCharacter(scene);
    poseClip = await getClip('mot_all_chr_cmmn_talk-015_pose_b');
    facialClip = await getClip('mot_all_chr_amao_facial-all-default_in_f');
    statusEl.textContent =
      `char loaded: ${char.nodeByIndex.size} nodes, ` +
      `${Object.keys(char.meta.parts || {}).length} parts, ` +
      `${char.morphMeshes.length} morph meshes`;
    frame();
    viewer.frame();
  } catch (e) {
    statusEl.textContent = 'ERROR ' + e.message;
    console.error(e);
  }
}

const seek = document.getElementById('seek');
seek.addEventListener('input', () => { currentTime = (seek.value / 1000) * duration; });
document.getElementById('play').addEventListener('click', () => { playing = !playing; });
document.getElementById('orbit').addEventListener('click', () => { controls.enabled = !controls.enabled; });

function frame() {
  if (!char) return;
  char.solver.resetPose();
  const A = window.__anim || { enabled: true };
  if (MODE !== 'bind' && A.enabled !== false) {
    const body = A.bodyClip ?? poseClip;
    const facial = A.facialClip ?? facialClip;
    applyClip(body, A.t || 0);
    applyClipFacial(facial, 0);
  }
  if (controls.enabled) controls.update();
  char.update(camera);
  renderer.render(scene, camera);
}
function applyClipFacial(clip, t) {
  // facial clips carry only blend-shape curves; they must not reset the body
  if (!clip || !char) return;
  const f = evalClip(clip, t);
  const map = new Map();
  for (const [i, v] of f.morph) map.set(i, v);
  char.setMorph(map);
}

let last = performance.now();
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (playing) {
    currentTime = (currentTime + dt) % duration;
    seek.value = String(Math.round((currentTime / duration) * 1000));
  }
  frame();
}

boot();
tick();

// ---------- automation hooks ----------
window.setClip = async (name, t) => {
  const clip = name ? await getClip(name) : null;
  window.__anim = { enabled: !!name, bodyClip: clip, t: t || 0 };
  return !!clip;
};
window.viewer = {
  scene, camera, applyCameraSetting, THREE,
  get solver() { return char ? char.solver : null; },
  get meta() { return char ? char.meta : null; },
  measure() {
    const out = {};
    const keys = ['Hips', 'Head', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot',
      'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'Spine2', 'Neck',
      'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg'];
    const solver = char && char.solver;
    if (!solver) return out;
    for (const n of keys) {
      const o = solver.nameToNode[n];
      if (!o) continue;
      out[n] = o.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3));
    }
    return out;
  },
  bbox() {
    const b = new THREE.Box3().setFromObject(scene);
    return { min: b.min.toArray(), max: b.max.toArray() };
  },
  frame() {
    const b = new THREE.Box3().setFromObject(scene);
    const c = b.getCenter(new THREE.Vector3());
    const s = b.getSize(new THREE.Vector3());
    const d = Math.max(s.x, s.y, s.z) * 1.6;
    camera.position.set(c.x + d * 0.2, c.y + s.y * 0.1, c.z + d);
    camera.lookAt(c);
    camera.fov = 45; camera.updateProjectionMatrix();
    controls.target.copy(c);
    return { center: c.toArray(), size: s.toArray(), min: b.min.toArray(), max: b.max.toArray() };
  },
};
