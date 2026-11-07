/** Unity VolumeParameter defaults for the exported scene-lighting/postprocess subset. */
export const SCENE_VOLUME_DEFAULTS = {
  lightmap: { intensity: 1, color: {r: 1, g: 1, b: 1, a: 1}, reflectionScale: 1 },
  bloom: { intensity: 0, threshold: 1, diffusion: 10, color: {r: 1, g: 1, b: 1, a: 1} },
  colorAdjustments: { postExposure: 0, contrast: 0, saturation: 0, hueShift: 0, colorFilter: {r: 1, g: 1, b: 1, a: 1} },
};

function colliderShape(c, m) {
  const center = c.center ?? {x: 0, y: 0, z: 0};
  const axes = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
  const scale = axes.map(a => Math.hypot(...a));
  if (scale.some(s => s === 0)) throw new Error('Singular local-volume collider transform');
  axes.forEach((a, i) => { for (let j = 0; j < 3; j++) a[j] /= scale[i]; });
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    if (Math.abs(axes[i][0] * axes[j][0] + axes[i][1] * axes[j][1] + axes[i][2] * axes[j][2]) > 1e-4) throw new Error('Sheared local-volume collider transform is unsupported');
  }
  const shape = { type: c.type, axes,
    center: [m[0] * center.x + m[1] * center.y + m[2] * center.z + m[3], m[4] * center.x + m[5] * center.y + m[6] * center.z + m[7], m[8] * center.x + m[9] * center.y + m[10] * center.z + m[11]],
    half: [0, 0, 0], radius: 0, direction: c.direction ?? 1, segment: 0 };
  if (c.type === 'BoxCollider') shape.half = [Math.abs(c.size.x * scale[0]) / 2, Math.abs(c.size.y * scale[1]) / 2, Math.abs(c.size.z * scale[2]) / 2];
  else if (c.type === 'SphereCollider') shape.radius = c.radius * Math.max(...scale);
  else if (c.type === 'CapsuleCollider') {
    const d = shape.direction;
    shape.radius = c.radius * Math.max(scale[(d + 1) % 3], scale[(d + 2) % 3]);
    shape.segment = Math.max(0, c.height * scale[d] / 2 - shape.radius);
  } else throw new Error(`Unsupported local-volume collider ${c.type}`);
  return shape;
}

function distanceSquared(shape, x, y, z) {
  x -= shape.center[0]; y -= shape.center[1]; z -= shape.center[2];
  if (shape.type === 'SphereCollider') return Math.max(0, Math.hypot(x, y, z) - shape.radius) ** 2;
  let squared = 0;
  for (let i = 0; i < 3; i++) {
    const a = shape.axes[i];
    let v = Math.abs(x * a[0] + y * a[1] + z * a[2]);
    if (shape.type === 'BoxCollider') v = Math.max(0, v - shape.half[i]);
    else if (i === shape.direction) v = Math.max(0, v - shape.segment);
    squared += v * v;
  }
  return shape.type === 'BoxCollider' ? squared : Math.max(0, Math.sqrt(squared) - shape.radius) ** 2;
}

/** Construct once per scene. update(cameraPosition) mutates and returns a stable volumes object.
 * Input camera coordinates are viewer world coordinates; exported collider matrices are Unity world.
 * Only overridden fields appear in volumeStack components. Equal priorities retain source order.
 */
export class SceneVolumeResolver {
  constructor(meta) {
    this.volumes = structuredClone(SCENE_VOLUME_DEFAULTS);
    this.defaults = [];
    const slots = new Map();
    const flatten = (source, target, prefix, output) => {
      for (const key of Object.keys(source)) {
        const value = source[key], path = `${prefix}.${key}`;
        if (typeof value === 'number') {
          const slot = { target, key, value, previous: NaN };
          output.push(slot); slots.set(path, slot);
        } else flatten(value, target[key], path, output);
      }
    };
    flatten(SCENE_VOLUME_DEFAULTS, this.volumes, '', this.defaults);
    this.revision = 0;
    this.stack = (meta.volumeStack ?? []).slice().sort((a, b) => a.priority - b.priority).map(v => {
      const overrides = [];
      const collect = (source, prefix) => {
        for (const key of Object.keys(source)) {
          const value = source[key], path = `${prefix}.${key}`;
          if (typeof value === 'number') {
            const slot = slots.get(path);
            if (slot) overrides.push({ target: slot.target, key: slot.key, value });
          } else collect(value, path);
        }
      };
      collect(v.components, '');
      return { ...v, overrides, shapes: v.isGlobal ? [] : v.colliders.map(c => colliderShape(c, v.matrix)) };
    });
    // Old metadata has no stack; its already-resolved values remain usable.
    if (!meta.volumeStack) {
      const collect = (source, prefix) => {
        for (const key of Object.keys(source)) {
          const value = source[key], path = `${prefix}.${key}`;
          if (typeof value === 'number') { const slot = slots.get(path); if (slot) slot.value = value; }
          else if (value && typeof value === 'object') collect(value, path);
        }
      };
      collect(meta.volumes ?? {}, '');
    }
  }

  update(position) {
    for (const s of this.defaults) s.target[s.key] = s.value;
    const x = position.x ?? position[0], y = position.y ?? position[1], z = -(position.z ?? position[2]);
    for (const v of this.stack) {
      let weight = v.weight;
      if (!v.isGlobal) {
        let distance = Infinity;
        for (const shape of v.shapes) distance = Math.min(distance, distanceSquared(shape, x, y, z));
        const blendSquared = v.blendDistance * v.blendDistance;
        if (distance > blendSquared) continue;
        if (blendSquared > 0) weight *= 1 - distance / blendSquared;
      }
      if (weight <= 0) continue;
      for (const s of v.overrides) {
        const value = s.target[s.key] + (s.value - s.target[s.key]) * weight;
        s.target[s.key] = s.key === 'diffusion' ? Math.trunc(value) : value;
      }
    }
    let changed = false;
    for (const s of this.defaults) {
      if (s.previous !== s.target[s.key]) changed = true;
      s.previous = s.target[s.key];
    }
    if (changed) this.revision++;
    return this.volumes;
  }
}
