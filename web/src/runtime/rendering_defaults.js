/** Shipped CampusRenderPipelineHighAsset: the viewer's consistent shadow-quality baseline. */
export const NATIVE_RENDER_PIPELINE = Object.freeze({
  shadowDistance: 15,
  cascadeBorder: 0.2,
  shadowDepthBias: 1,
  shadowNormalBias: 0.1,
  mainShadowmapResolution: 2048,
  additionalShadowmapResolution: 512,
  additionalShadowResolutionTiers: Object.freeze([128, 256, 512]),
  softShadowQuality: 2,
});
