// ActorAnimationManagePropertyData layout/defaults: ManageProperty.Get, 0x1809AA590.
// Keep serialized Unity field names at the boundary, rather than exposing solver
// implementation names (e.g. speed is the native swingPowerWeight).
export const ANIMATION_MANAGE_DEFAULTS = Object.freeze({
  weight: 1, modelingPoseWeight: 0, swingPowerWeight: 1,
  swingBreastPowerWeight: 1, swingBreastCorrectionPowerWeight: 1,
  rootWeight: 1, rootHorizontalWeight: 1, rootVerticalWeight: 1,
  'globalForce.x': 0, 'globalForce.y': 0, 'globalForce.z': 0,
  'windDirection.x': 0, 'windDirection.y': 0, 'windDirection.z': 0,
  windPower: 0, windFluctuation: 0, windWaveAmplitude: 0, windWaveFrequency: 1,
  windWavePhase: 0, windRangeMax: 10, windRangeMin: -10,
  windRangeFrequency: 0, windRangePhase: 0, randomPower: 0,
  randomFluctuation: 0, prewarmCount: 30,
});
export const ANIMATION_MANAGE_FIELDS = Object.freeze([...new Set(
  Object.keys(ANIMATION_MANAGE_DEFAULTS).map((name) => name.split('.')[0]),
)]);

function propertyValue(source, name) {
  if (source?.[name] !== undefined) return source[name];
  const dot = name.indexOf('.');
  return dot < 0 ? undefined : source?.[name.slice(0, dot)]?.[name.slice(dot + 1)];
}

/** Apply scene properties and sampled channels without retaining prior-frame values. */
export function applyAnimationManage(swing, scene = null, sampled = null, volume = null) {
  const value = (name) => propertyValue(sampled, name) ?? propertyValue(scene, name) ??
    propertyValue(volume, name) ?? ANIMATION_MANAGE_DEFAULTS[name];
  const p = swing.parameters, wind = p.wind;
  p.weight = value('weight');
  p.localBlend = value('modelingPoseWeight');
  p.speed = value('swingPowerWeight');
  p.breastPower = value('swingBreastPowerWeight');
  p.breastCorrection = value('swingBreastCorrectionPowerWeight');
  p.root = value('rootWeight');
  p.rootXZ = value('rootHorizontalWeight');
  p.rootY = value('rootVerticalWeight');
  wind.power.set(value('globalForce.x'), value('globalForce.y'), value('globalForce.z'));
  wind.direction.set(value('windDirection.x'), value('windDirection.y'), -value('windDirection.z'));
  wind.noisePower = value('windPower');
  wind.noiseSpeed = value('windFluctuation');
  wind.sinePower = value('windWaveAmplitude');
  wind.sineSpeed = value('windWaveFrequency');
  wind.sinePhase = value('windWavePhase');
  wind.limit = value('windRangeMax');
  wind.minimum = value('windRangeMin');
  wind.blendSpeed = value('windRangeFrequency');
  wind.blendPhase = value('windRangePhase');
  wind.directionNoisePower = value('randomPower');
  wind.directionNoiseSpeed = value('randomFluctuation');
}

export function blendAnimationManage(previous, current, weight, scene = null, volume = null) {
  const out = {};
  for (const [key, fallback] of Object.entries(ANIMATION_MANAGE_DEFAULTS)) {
    const neutral = propertyValue(scene, key) ?? propertyValue(volume, key) ?? fallback;
    const a = propertyValue(previous, key) ?? neutral;
    const b = propertyValue(current, key) ?? neutral;
    if (previous?.[key] !== undefined || current?.[key] !== undefined) out[key] = a + (b - a) * weight;
  }
  return out;
}
