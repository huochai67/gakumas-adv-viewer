# Gakumas ADV Viewer

Browser-native re-implementation of the game's ADV (adventure) scene player:
the browser directly parses the game's raw UnityFS `.bundle` packages
(`cache/bundles/*.bundle`) and CRI `.acb` voice containers
(`cache/resources/*.acb`) in-memory via a 103 KB Rust WebAssembly module
(`web/wasm/gakumas_core.wasm`), constructing Three.js meshes, skeletons,
materials, animations, and WebAudio PCM + 60 Hz AIUEO lip-sync on the fly
with zero pre-exported `.glb`, `.png`, or `.mp3` files required.

## Run (React + Vite Studio UI)

```bash
pnpm run dev                  # Vite dev server on http://127.0.0.1:8777
pnpm run build                # Production build into web/dist
pnpm run serve                # Serve production build on http://127.0.0.1:8777
```

The React + Vite frontend (`web/src/`) provides a top multi-tab navigation bar
and a left-sidebar / right-viewport split workspace sharing a single persistent
WebGL renderer (`web/src/engine/ViewerEngine.js`):

* **Tab 1 — 资产浏览器 (Asset Browser)**: browse and switch characters, costumes
  (`body`/`hair`/`face`), body motion clips, facial expression clips, manual
  BlendShape overrides, IK/Swing physics toggles, character position/orientation
  controls (sliders, presets, 3D viewport gizmo, and `WASD`/`QE` shortcuts), and
  2D/3D stages (with on-demand Octo bundle fetching via `/api/ensure`).
* **Tab 2 — 剧情浏览器 (Story Browser)**: select built-in or local/pasted `.txt`
  ADV scripts, jump directly to any dialogue cue on the timeline, and render the
  full 2D/3D stage, character animations, DOF bokeh, Bloom, and CRI `.acb` voice
  lip-sync. Deep-linking via `?tab=story` or `/story.html?script=...` opens
  directly in Story Browser mode.

### Resource lifetime

Character switches dispose the previous actor's textures, skeleton/bone textures,
materials (including the separate hair-shadow pass), geometry and shadow render
target. Texture ownership is per character; loading another actor cannot overwrite
or dispose textures still used by a character in the current story. The shared
white/black fallback textures (`WHITE_SRGB` / `BLACK_SRGB`) survive character
disposal. The disposal exclusion list must match these live fallbacks; obsolete
constants would throw during cleanup and prevent character replacement.

The viewer retains only the selected asset scene and backgrounds referenced by
the current story, so timeline seeking remains immediate. Other 3D stages release
their geometry, materials, textures and sky render targets; unused 2D backgrounds
release textures, DOM images and blob URLs. Replacing a story also releases its
extra actors, ground shadows and voice URLs. Stale character loads are disposed,
and overlapping loads of the same background share one pending request.

Raw Unity bundles/CABs are scoped to each build instead of accumulating in the
shared browser environment. Lazy texture sources are released after material
construction. Sampled animations use a 64-entry LRU cache; compressed voice sheets
use a 2-entry LRU cache. Disk/HTTP caches remain available for subsequent loads.

Run `node --test web/src/engine/*.test.mjs` for regression checks. For browser
memory checks, repeatedly switch characters and 2D/3D scenes, return to the same
scene, and compare `viewerEngine.renderer.info.memory` in DevTools. After warm-up,
GPU resource counts should return to the same baseline. Browser allocators and
WebAssembly linear memory may retain their high-water allocation; immediate OS
memory reduction is not required for released objects to be collectable.

Character-switch smoke check: select `krnh`, switch back to `amao`, then select
`krnh` again. Each switch must finish loading, display the selected character,
and produce no `Failed to load character parts` / `ReferenceError` in the console.

## Project Structure

```text
gakumas-adv-viewer/
├── wasm/                         # Rust WebAssembly core (compiled to web/wasm/gakumas_core.wasm)
│   ├── lib.rs
│   ├── lz4_bcn.rs                # Octo XOR unmasking, LZ4, BC1/BC3/BC6H/BC7 decoders
│   └── clhca.rs                  # CRI HCA v3.0 audio decoder + 60 Hz AIUEO lip-sync FFT
├── pipeline/                     # CLI asset fetcher & offline exporter tools
│   ├── fetch.ts                  # Octo manifest loader & bundle dependency downloader
│   ├── assets.ts                 # Node Unity bundle environment
│   ├── export_{char,clips,env,bg,voices}.ts
│   ├── decode_hca.mjs
│   ├── clhca/                    # C HCA reference decoder
│   └── core/                     # Low-level binary/format codecs for CLI pipeline
│       ├── bcn_png.ts
│       ├── gltf.ts
│       ├── lz4.ts
│       ├── masked_bundle.ts
│       ├── serialized_file.ts
│       ├── unity_anim.ts
│       └── unity_fs.ts
└── web/                          # React + Vite Web Application
    ├── index.html                # Vite HTML entry
    ├── assets/                   # Built-in .txt ADV scripts
    ├── wasm/                     # Compiled gakumas_core.wasm binary
    ├── vendor/                   # Vendored Three.js r170 ES modules
    ├── server/                   # HTTP server & Vite/standalone API middleware
    │   ├── serve.ts              # Standalone production HTTP server
    │   └── api.ts                # /cache/* & /api/{catalog,ensure} middleware
    └── src/                      # Frontend source code
        ├── main.jsx              # React root entry
        ├── App.jsx               # Top multi-tab bar + split-pane workspace shell
        ├── styles.css            # Studio UI stylesheet
        ├── components/           # React UI panels
        │   ├── ActorTransformControl.jsx
        │   ├── AssetBrowserPanel.jsx
        │   ├── StoryBrowserPanel.jsx
        │   └── ViewportPane.jsx
        ├── engine/               # 3D Character, Stage, PostFX, Animation & Story Engine
        │   ├── ViewerEngine.js   # Unified Asset/Story WebGL engine & state store
        │   ├── adv.js            # ADV script parser & timeline builder
        │   ├── bloom.js          # 3D/2D Vogel bokeh DOF & Bloom post-processing
        │   ├── camera.js         # Unity camera FOV & transform adapter
        │   ├── char.js           # Campus/Actor/Default character & shader builder
        │   ├── clips.js          # AnimationClip 30 Hz evaluator
        │   └── pose.js           # 95-muscle Mecanim FK, IK & ActorSwing physics solver
        └── runtime/              # Browser WASM & UnityFS/ACB asset loaders
            ├── wasm_bridge.js    # JS <-> gakumas_core.wasm bridge
            ├── bundle_env.js     # Browser UnityFS, SerializedFile & ACB container reader
            └── bundle_loaders.js # In-memory GLB, Texture2D, Clip & Voice builders
```

## Browser WASM Runtime & Optional CLI Pipeline

At runtime, the web app loads raw bundles and `.acb` cue sheets directly from
`/cache/bundles/*` and `/cache/resources/*` (indexed by `/cache/index.json` in
`web/server/api.ts`) using `web/wasm/gakumas_core.wasm`:

* **WASM primitives (`web/wasm/gakumas_core.wasm`)**: Octo `0x100`-byte XOR
  header unmasking, raw LZ4 block decompression, `RGB24`/`RGBA32`/`DXT1`/`DXT5`/`BC6H`
  (14 modes)/`BC7` (8 modes) texture decoding, CRI HCA v3.0 audio decoding, and
  2048-point radix-2 FFT 60 Hz 5-vowel (`A/I/U/E/O`) lip-sync extraction.
* **Browser runtime (`web/src/runtime/bundle_env.js`, `web/src/runtime/bundle_loaders.js`)**:
  `UnityFS` + `SerializedFile` v22 + embedded `TypeTree` parser, cross-bundle
  `PPtr` & `.resS` resolver, lazy `LazyTextureMap` `THREE.DataTexture` uploader,
  in-memory GLB + `ClipSampler` builder, and `@UTF`/`AFS2` `.acb` voice loader.

To rebuild `web/wasm/gakumas_core.wasm` or fetch/export offline assets via CLI:

```bash
pnpm run build:wasm           # compile wasm/lib.rs -> web/wasm/gakumas_core.wasm
pnpm run fetch:all            # download ALL bundles (26k+) + resources (22k+) concurrently
pnpm run fetch:adv            # download all ADV viewer assets (chars, motions, envs, scripts, voices)
pnpm run fetch:scripts        # download all 3,900+ ADV .txt scripts into cache/resources/
pnpm run fetch "mdl_chr_hski-*" "adv_dear_hski_*.txt" -j 12
pnpm run export:all           # optional CLI export of .glb / .png / .mp3 / .json
```
Extra bundles are pulled by name from `cache/OctoManifest.json` (or
`GAKUMAS_OCTO_MANIFEST`); `fetch.ts` resolves the dependency closure. All
`SerializedFile` v22 objects and `MonoBehaviour`s embed complete `TypeTree`
blobs directly in the bundles — no `DummyDll`, `UnityPy`, or Python installation
is required.

### Asset conventions that are easy to get wrong

* Load **all** bundles into one `AssetEnvironment` (`loadEnv()` in `pipeline/assets.ts`)
  so cross-bundle `PPtr`s and `.resS` streams resolve.
* Unity matrices are row-major: transpose and mirror Z to reach glTF/three
  (`p = (x, y, -z)`, `q = (x, y, -z, -w)`), so a Unity yaw of `t` is a three yaw
  of `-t`, and the character faces `-Z`. Texture `UV0` V is flipped (`1 - v`) on
  export for glTF `flipY = false`, while lightmap `UV1` keeps Unity's bottom-up V
  paired with `lmap.flipY = true`.
* Env geometry excludes the `occlusion` cull proxy, inactive GameObjects,
  disabled `MeshRenderer`s, and `LOD1+` duplicates. Buckets retain rendering-layer
  masks, source tangents and renderer-local probe bounds/anchors; renderers that
  can select different reflection probes are not merged by material alone.
* Clip bundles carry a variant suffix (`_b` body, `_f` face) that the ADV script
  omits; `story.js` resolves both.
* ADV script grammar: one bracketed command per line, values are JSON (with
  `\"`, `\{` escaped), nested command lists (`layouts=[actorlayout ...]`) or bare
  tokens; repeated keys are legal (`backgrounds=` appears once per background).
  `adv.js` normalises bracket values to arrays and unescapes `\n`.

## Stage rendering

The 3D stage combines static lightmapped architecture with dynamically lit 3D
props, HDR emissive lamps, skybox, and raycast-snapped `DecalProjector` quads:

* **Lightmapped Environment/Default**: `environment.js` ports the shipped baked
  surface equations, including `_Tiling`/`_Offset` with the exported V flip,
  RG/AG normal decoding and source tangent handedness. `_DefMap * _DefValue`
  supplies metallic (R), emission (G), indirect mask (B), and smoothness (A).
  Stale saved `_Metallic`/`_Smoothness` floats are not shader inputs. Emission uses
  `max(G - 0.02, 0) * _EmissionColor` and `_EmissionAlbedoScale`; indirect diffuse
  and Fresnel/roughness reflection use the native equations, not Three's BRDF.
* **Realtime stage lights**: `punctual_lights.js` supplies texture-backed light
  lists and point, spot and directional shadow maps. Opaque surfaces reproduce
  the native deferred-light equations; transparent surfaces use the Forward+
  equations. This ports their lighting math into the WebGL material, not Unity's
  complete deferred renderer. Range/cone attenuation, specular, backlighting,
  Emission/Multiply light modes, baked shadow masks and renderer/light layers
  follow the source controls. Native opaque Multiply shadows deliberately do
  not use the transparent path's distance/cone attenuation.
  Source cast/receive flags, ShadowsOnly renderers, alpha-tested casters, shadow
  bias, filtering and distance fade are retained. Character floor shadows use
  these maps where authored, rather than a duplicate blob. The explicit quality
  baseline is `CampusRenderPipelineHighAsset` (15 m shadow distance, 2048 main
  and 512 additional shadow resolution); it does not read the installed game's
  current quality selection.
* **HDR baked lighting**: BC6H lightmaps are decoded to linear RGBA16F, preserving
  values above one. `_LightmapScaleColor.rgb = color.rgb * intensity`; the old
  RGBA8 clipping, sRGB reinterpretation and empirical `1.45` multiplier are gone.
  Mixed main lights use their authored shadowmask channel and native rendering
  layers/custom-light controls, so blocked sunlight is not added indoors.
* **Room reflections**: enabled local probes and RenderSettings' generated/custom
  default reflection retain all six HDR faces and their original roughness mips;
  BC6H and RGB9E5 sources decode to linear RGBA16F without clipping HDR values.
  The shipped shader samples a single selected probe with box projection and
  native roughness-to-LOD/Fresnel weighting; it does not blend two probes.
  Coordinates mirror world Z without flipping the raw cube faces. Local probe
  selection respects renderer bounds and importance, not merged-material bounds.
* **Scene Volumes and postprocessing**: active referenced profiles are resolved
  by priority, weight and override state; local collider influence follows the
  camera. Lightmap color/intensity and Bloom/grading update together. Native
  VLBloom uses `2^(intensity/10)-1`, gamma-to-linear threshold, diffusion-selected
  downsample levels and additive box reconstruction. Exposure is in stops;
  contrast uses HDR LogC, followed by linear color filter and saturation. Missing
  scene settings reset to neutral defaults, including a return to the studio.
  These grading equations are evaluated directly, not through Unity's 32³ LUT;
  LUT quantization, other grading effects and other environment shader variants
  are not claimed pixel-identical. Existing DOF and 2D artwork compositing remain.
* **Other materials and skybox**: non-lightmapped props retain the existing
  `MeshStandardMaterial` directional/hemisphere/sky approximation; other baked
  shaders retain their Basic-material fallback. The displayed equirectangular
  skybox is separate from the native default reflection cubemap.
* **Decals**: `DecalProjector` boxes (whiteboard marker drawings, blackboard
  chalk, monitor screen, prop contact shadows) are raycast-snapped (`2.2 mm`
  normal offset) onto the stage surface triangles at export time.

The optional CLI exporter writes HDR textures as `.rgba16f` with dimensions in
`env.json.hdrTextures`; cubemap `.cube.json` manifests reference each face/mip.
Browser uploads use the same half-float data in memory. Rebuild WASM after decoder
changes with `pnpm run build:wasm`. Focused regressions:

```bash
node --test pipeline/core/bcn_png.test.mjs web/src/runtime/cubemap.test.mjs web/src/runtime/scene_volumes.test.mjs web/src/engine/environment.test.mjs web/src/engine/punctual_lights.test.mjs
```

2D backgrounds are DOM `<img>` layers behind the canvas, driven by
`backgroundsetting {position, scale, angle}` in 1920x1080 reference pixels.

## Character rendering

`char.js` loads `char.glb` and reproduces the native `Campus/Actor/Default`
shader, hardware stencil pipeline, smoothed-tangent outlines, and face profile
correction:

* **Hardware stencil & renderQueue order**:
  * `m_bdy` / `m_fce` (`2050`): opaque skin & outfit, writes stencil `64`.
  * `m_ebs` (`2055`): 3D eyebrows/lashes, writes stencil `68`.
  * `m_eye` (`2060`): 3D iris/sclera with `Stencil Equal 68`.
  * `m_fcp` (`2065`): mouth interior, nostrils, double-eyelid creases (`72`).
  * `m_ehl` (`2070`): additive eye highlights with `Stencil Equal 68`.
  * `m_hir` (`2550`): two-pass hair — pass 1 (`Stencil <= 64`) draws opaque
    crown/side/back hair; pass 2 (`Stencil > 64`, `depthWrite: false`) blends
    bangs over eyebrows/eyes/creases with the native head-front/head-up fade.
  * `m_hirco` (`2450`): soft alpha-blended wispy hair strands.
  * Opaque passes write coverage alpha 1; transparent passes retain native alpha,
    preventing hair holes in transparent-canvas/2D and exported composites.
* **Shading & outlines**: Directly implements the DXBC `Campus/Actor/Default`
  `_ShadeMap.a` split (`_ShadeMap.a < 0.5` clothing/hair cel ramp + `_RampMap` +
  `_DefMap` specular/rim vs `_ShadeMap.a >= 0.5` smooth skin ramp + nose line),
  plus smoothed-normal outlines from `TANGENT.xyz` and `COLOR_0` 12-bit thickness
  encoding (`(COLOR_0.r * 64 + COLOR_0.g) * (63/64)`).
* **Actor lighting and Volumes**: protagonist `VLActorParameter`, mob
  `CampusLitActor` and `VLActorShadow` remain separate components, with native
  defaults and override/priority blending. Actor and eye reflection cubemaps,
  main-light space/angles, shade colors, rim, GI and additional-light scales are
  applied in asset, story, 3D and 2D modes and reset on scene changes. Up to eight
  actor-layer lights follow the native actor pass. Serialized ambient SH is
  consumed directly with mirrored-Z coefficients; runtime-generated probes or
  SH inferred from ambient/trilight colors are not synthesized.
* **Actor self-shadow**: the projector fits the currently posed body/hair bounds
  instead of a fixed head box. Native caster masks, receiver keywords, tangent
  normal bias, four-tap filtering, depth/distance gates and shadow-strength/
  offset controls allow bangs to shadow the face and hair to self-shadow.
  Shadow resources are stage/character owned and released during replacement.
  These recovered equations do not imply pixel-identical output to an original
  game frame with unmatched camera, pose or runtime lighting state.
* **Face skinning & profile correction**: `export_char.ts` decodes
  `VLActorFaceModel.boneWeightAndIndices` across all 7 face bones (`Head`,
  `Eye_L/R`, `EyeHighlight_L/R_a/b`) and exports `CampusActorFaceCorrection`
  morph indices (`[84..87]`), which `char.js` drives each frame from head-to-camera
  angle for clean side profiles.
* **Mecanim humanoid pose & helper bones**: `export_clips.ts` shifts Unity
  humanoid muscle attributes `42..136 -> 0..94` (fixing cubic `StreamedFrames`
  evaluation in `unity_anim.ts`) and exports `RootT/RootQ` + foot/hand IK tracks.
  `human_rig.js` constructs muscle frames, default limits, neutral muscles and
  `humanScale` from each assembled character's bind skeleton using the native
  UnityPlayer axis tables and bone-mass center. `pose.js` retargets the pelvis
  from the current body center/orientation and consumes hand/foot Goal positions
  **and rotations**; it no longer reuses Amao's fitted arm axes or scale.
  `human_ik.js`, `human_limb_ik.js` and `human_twist.js` implement the native
  `FullBodySolve` Goal stages: length adjustment (default stretch `0.05`),
  lower-limb DoF preparation, weighted two-bone solving, hint correction,
  Goal rotation / end-DoF correction. The final `TwistSolve` redistributes roll
  with native default factors `0.5`. Stretch writes local translations as well as rotations;
  unstretched frames restore those translations during seeking and cross-fades.
  Foot targets retain the sole offset and each character's post-axis frame.
  Custom hand/body IK, Quartz and ActorSwing consume the pre-twist skeleton;
  `updatePostRig()` applies twist once at the end, matching `EvaluateAvatarEnd`.
  Applying twist during clip sampling changes the elbow frame used by later
  collision IK and can rotate the wrist even when its position remains close.
  Final-output rotation snapshots are restored before the next sample, redraw
  or reset, so twist never feeds back into simulation. All solves remain
  independent of story placement. The clip adapter treats present T/Q channels as full-weight goals;
  this is not a reconstruction of Unity's complete AnimationStream activation
  flags, playable IK callbacks or look-at solver.
  The Goal math was compared against the matching UnityPlayer machine code:
  four characters at three animation times, fractional/zero weights, position-
  and rotation-only goals, hints, unreachable targets and an intermediate-bone
  chain. JavaScript double arithmetic is not bit-identical to native SIMD floats.
  `node --test web/src/engine/pose.test.mjs` covers the Amao `idle-001` hand
  avoidance endpoint against original native output, repeated redraws/resets,
  cross-fade recovery, intermediate bones and actor-space placement.
  Full-body `actormotion` cues cross-fade directly over `transition` seconds,
  while `actoradditivemotion` subtracts its `t = 0` reference pose (`add(t) - add(0)`).
* **Hand/body avoidance IK**: `body_ik.js` replaces the old post-pose analytical
  arm correction with the shared native `FullBodySolve` Goal path, before Quartz
  and ActorSwing; the final output pass owns `TwistSolve`. Goal locator
  scale X/Y supplies position/rotation weights; elbow Hint scale X supplies the
  hint blend/weight, while Hint scale Y independently enables and weights body
  avoidance. `ik_correction.js` checks the current wrist plus the configured
  offset against serialized spheres/tapered capsules, including capsule rotation.
  The nearest signed-distance contact supplies an unblended surface target and
  a damped weight; a miss in correction mode clears position weight. A rotation-
  only goal remains active even without a collision. Pose snapshots prevent
  paused-frame feedback, and missing effector tracks restore authored bind
  weights instead of retaining the previous clip's flags. Scene placement is
  kept outside the solve. This ports the hand-avoidance branch, not the separate
  custom job's body-pull, move/reference or full-body look-at machinery.
  Collision helpers and an actual `talk-015_pose` correction were checked against
  the matching GameAssembly/UnityPlayer machine code. Regression cases run with
  `node --test web/src/engine/body_ik.test.mjs`.
* **QuartzDriver clothing pose**: `quartz.js` and `quartz_math.js` execute the
  serialized Rotation, Frill, Skirt, Hair, HumanoidHand/Sleeve/UpLeg/Arm, Waist,
  Furisode and Poncho jobs after IK and before ActorSwing. Browser loading and
  CLI export resolve their reference **GameObject** PPtrs to skeleton nodes;
  assembled Head/Neck references are injected into hair jobs as in the game.
  Native axis orders, decomposition, coefficients, limits and setting coordinate
  conversions replace the former fixed-name helper rules. Animation snapshots
  prevent helper feedback during paused renders, blending and seeking. These
  drivers supply the missing sleeve-root animation on `fktn-cstm-0063`; they are
  not a standalone cure for every cloth contact. The JavaScript port preserves
  the recovered formulas, not bit-identical Unity floating-point results.
* **ActorSwing secondary motion**: `actor_swing.js` replaces the approximate
  solver with the native dynamic swing/slide, capsule collision, chain-net
  smoothing, angular/reference limits, root compensation and stabilization
  paths. `swing_breast.js` ports paired breast motion, weighted curves and arm
  correction; the serialized breast collider is not used by the native job.
  Both browser loading and CLI export distinguish the assembled **initial bind
  pose**, used for simulation directions and lengths, from serialized **modeling
  poses**, used by the final modeling-pose blend. Chain rest circumferences are
  measured from the assembled initial skeleton, never from a seeked animation;
  external story layout scaling does not change their actor-space lengths.
  Reference-dependent bones run after the primary bone groups. Swing writes
  only the parent's rotation; slide writes only the child's position, preserving
  the other animated channel. Capsule axes are X/Y/Z = 0/1/2, and their center-line
  half-length is `height / 2 - radiusA`.
  Animation snapshots feed a 60 Hz accumulator; each native integration tick
  uses `0.01667`, including reset-count stabilization (default count: 5). The
  solved quaternion is kept separate from the blend destination, so full physics
  weight preserves the simulated swing rather than replacing it with animation.
  Physics advances on its own elapsed-time clock, independent of clip wrapping
  and playback speed. Short pose loops retain inertia; non-looping asset motions
  hold their final pose while hair/cloth continue settling. Playback stays active
  at that endpoint so the pause button can freeze both animation and physics.
  Explicit pauses and UI-only redraws do not advance physics. Seeking, dialogue
  jumps, voice replay jumps, changing motions/actors or modes, and toggling
  physics reset the state and seed the clock from the selected timeline time.
  `viewerEngine.renderFrame(deltaSeconds)` advances this clock for deterministic
  stepping; omitting the argument redraws without advancing it. The video export
  loop supplies `1 / fps` after frame zero instead of reusing clip time.
  Swing output/weight and inertial carry-over regressions run with
  `node --test web/src/engine/actor_swing.test.mjs`.
  `animation_manage.js` maps native `weight`, `modelingPoseWeight` (default 0),
  swing/breast/root weights and wind fields from scene `ActorAnimationParameter`
  volumes, explicit `viewerEngine.setAnimationManageProperties(properties)`
  overrides, and sampled management tracks. Passing `null` clears the explicit
  override; missing values fall back to the native defaults, not the previous
  frame. `swingPowerWeight` changes secondary-motion force, not playback speed.
  Wind vectors accept Unity-space `{x, y, z}` values. Seated correction remains
  a separate solver parameter; absent scene input defaults to standing.
  Collision uses animated body proxies, not body/cloth mesh triangles, CCD or
  general cloth self-collision. The native order ends with angular limits and
  rigid bone reconstruction after collision; this can leave proxy overlaps.
  There is deliberately no extra final collision iteration or inflated collider
  radius, and this port does not guarantee zero mesh penetration in every motion.

## Timeline

`adv.js` → `buildTimeline` produces time-ordered cues. `story.js`:
replays every cue with `t <= now` each frame to derive state, then applies
camera (`camerasetting`), actor layout (`actorlayoutgroup`), motion
(`actormotion`, cross-faded over `transition` seconds), facial clip and
`actorfacialoverridemotion` blend shapes, background switch
(`backgroundlayoutgroup` / `backgroundsetting`), `fade`, and the `message`
window (name plate hidden for `{user}` monologues, typewriter at 22 cps).
The story clock advances by the real frame delta (capped at 1 s so a backgrounded
tab cannot skip the scene), not by a per-frame animation step: on a software
renderer the frame rate drops far below 60 fps and a clamped clock would play the
whole commu in slow motion.

## Status

Implemented and verified against `adv_cidol-amao-3-000_01.txt`,
`adv_dear_amao_001.txt`, and `adv_dear_amao_002.txt` (329 cues / 288.3 s,
all 25 motion clips + 2D/3D backgrounds resolved): authentic `Campus/Actor/Default`
character shading/outlines/stencil bangs, Mecanim humanoid solver, 3D lightmapped
classroom with emissive lamps, skybox, dynamic props and decals, 2D background
transitions, camera framing, white fades, and dialogue UI.

Voice audio (`[voice]`) is decoded from CRI `.acb` / HCA v3.0 containers into MP3s
with 60 Hz 5-vowel (`A/I/U/E/O`) formant lip-sync envelopes (`voices/lipsync.json`).
