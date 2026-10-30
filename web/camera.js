// Unity camera settings -> three.js camera.
//
// The ADV script stores camera transforms in Unity space (left-handed, +Z
// forward, euler angles in degrees, focal length in mm over a 24 mm sensor).

import * as THREE from 'three';

const D2R = Math.PI / 180;

/** Unity Quaternion.Euler(x, y, z): rotations apply Z, then X, then Y. */
export function unityEulerToQuat(x, y, z) {
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x * D2R);
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), y * D2R);
  const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), z * D2R);
  return qy.multiply(qx).multiply(qz);
}

/** Convert a Unity euler rotation to a three.js quaternion (z-mirror). */
export function unityEulerQuat(x, y, z) {
  const q = unityEulerToQuat(x, y, z);
  return new THREE.Quaternion(q.x, q.y, -q.z, -q.w);
}

/** Vertical FOV of a Unity camera given the focal length (mm). */
export function focalToFov(focalLength) {
  return (2 * Math.atan(24 / (2 * focalLength)) * 180) / Math.PI;
}

/**
 * Apply an ADV `camerasetting` payload to a three.js camera.
 * @param {THREE.PerspectiveCamera} camera
 * @param {object} cs parsed `setting` value
 */
export function applyCameraSetting(camera, cs) {
  if (!cs) return;
  const t = cs.transform;
  if (t) {
    camera.position.set(t.position.x, t.position.y, -t.position.z);
    const q = unityEulerQuat(t.rotation.x, t.rotation.y, t.rotation.z);
    camera.quaternion.copy(q);
  }
  if (cs.focalLength) camera.fov = focalToFov(cs.focalLength);
  camera.near = cs.nearClipPlane ?? 0.1;
  camera.far = cs.farClipPlane ?? 1000;
  camera.updateProjectionMatrix();
}
