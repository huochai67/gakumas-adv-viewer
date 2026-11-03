# Gakumas ADV Viewer

Browser-native re-implementation of the game's ADV (adventure) scene player:
the browser directly parses the game's raw UnityFS `.bundle` packages
(`cache/bundles/*.bundle`) and CRI `.acb` voice containers
(`cache/resources/*.acb`) in-memory via a 103 KB Rust WebAssembly module
(`web/wasm/gakumas_core.wasm`), constructing Three.js meshes, skeletons,
materials, animations, and WebAudio PCM + 60 Hz AIUEO lip-sync on the fly
with zero pre-exported `.glb`, `.png`, or `.mp3` files required.

## Run

```bash
bun run serve                 # 127.0.0.1:8777, keep-alive (web/serve.ts)
```

`web/serve.ts` answers with HTTP/1.1 keep-alive: the page pulls a few hundred files
and a per-request-connection server exhausts the Windows ephemeral port range
(`ERR_ADDRESS_IN_USE` mid-load).

* `http://127.0.0.1:8777/story.html` — the ADV player (this is the deliverable)
* `http://127.0.0.1:8777/story.html?script=./assets/other.txt` — other script
* `http://127.0.0.1:8777/story.html?faceuv=uv0` — face UV fallback
* `http://127.0.0.1:8777/story.html?bloom=0` — disable the bloom pass
* `http://127.0.0.1:8777/index.html` — rig/material/clip debug page

Controls: space = play/pause, arrows = +-1 s, "next msg" jumps to the next
dialogue line, slider scrubs.

## Browser WASM Runtime & Optional CLI Pipeline

At runtime, `story.html` and `index.html` load raw bundles and `.acb` cue sheets
directly from `/cache/bundles/*` and `/cache/resources/*` (indexed by
`/cache/index.json` in `web/serve.ts`) using `web/wasm/gakumas_core.wasm`
(built from `wasm/lib.rs`, `wasm/lz4_bcn.rs`, and `wasm/clhca.rs`):

* **WASM primitives (`web/wasm/gakumas_core.wasm`)**: Octo `0x100`-byte XOR
  header unmasking, raw LZ4 block decompression, `RGB24`/`RGBA32`/`DXT1`/`DXT5`/`BC6H`
  (14 modes)/`BC7` (8 modes) texture decoding, CRI HCA v3.0 audio decoding, and
  2048-point radix-2 FFT 60 Hz 5-vowel (`A/I/U/E/O`) lip-sync extraction.
* **Browser runtime (`web/runtime/bundle_env.js`, `web/runtime/bundle_loaders.js`)**:
  `UnityFS` + `SerializedFile` v22 + embedded `TypeTree` parser, cross-bundle
  `PPtr` & `.resS` resolver, lazy `LazyTextureMap` `THREE.DataTexture` uploader,
  in-memory GLB + `ClipSampler` builder, and `@UTF`/`AFS2` `.acb` voice loader.

To rebuild `web/wasm/gakumas_core.wasm` or fetch/export offline assets via CLI:

```bash
bun run build:wasm               # compile wasm/lib.rs -> web/wasm/gakumas_core.wasm
bun pipeline/fetch.ts mdl_chr_amao-casl-0000_body env_3d_adv_classroom-00-00-noon ...
bun run export:all               # optional CLI export of .glb / .png / .mp3 / .json
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
  disabled `MeshRenderer`s, and `LOD1+` duplicates, and merges static geometry
  into buckets keyed by `material|lightmap|OverrideBaseColor`.
* Clip bundles carry a variant suffix (`_b` body, `_f` face) that the ADV script
  omits; `story.js` resolves both.
* ADV script grammar: one bracketed command per line, values are JSON (with
  `\"`, `\{` escaped), nested command lists (`layouts=[actorlayout ...]`) or bare
  tokens; repeated keys are legal (`backgrounds=` appears once per background).
  `adv.js` normalises bracket values to arrays and unescapes `\n`.

## Stage rendering

The 3D stage combines static lightmapped architecture with dynamically lit 3D
props, HDR emissive lamps, skybox, and raycast-snapped `DecalProjector` quads:

* **Lightmaps**: Lightmapped buckets render with `MeshBasicMaterial` + `lightMap`
  (`channel = 1`, `flipY = true`, sRGB) scaled by `1.45 * Math.PI * intensity`
  to cancel Three.js's built-in `RECIPROCAL_PI` factor and match Unity URP
  baked irradiance, tinted by per-object `OverrideBaseColor`.
* **Emissive fixtures**: Materials with HDR `_EmissionColor` (e.g. fluorescent
  ceiling tubes) add `_DefMap.g * _EmissionColor` in `onBeforeCompile` so they
  bloom naturally above the warm ceiling.
* **Dynamic props & skybox**: Non-lightmapped 3D props (chairs, teapots, cups,
  desk items) use `MeshStandardMaterial` lit by the scene's directional +
  hemisphere lights and equirectangular skybox (`t_sky_noon-00.png`).
* **Decals**: `DecalProjector` boxes (whiteboard marker drawings, blackboard
  chalk, monitor screen, prop contact shadows) are raycast-snapped (`2.2 mm`
  normal offset) onto the stage surface triangles at export time.

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
    bangs over eyebrows/eyes/creases with `1 - _BaseMap.a` so facial features
    show softly through the bangs.
  * `m_hirco` (`2450`): alpha-clipped (`_Cutoff 0.5`) wispy hair strands.
* **Shading & outlines**: Directly implements the DXBC `Campus/Actor/Default`
  `_ShadeMap.a` split (`_ShadeMap.a < 0.5` clothing/hair cel ramp + `_RampMap` +
  `_DefMap` specular/rim vs `_ShadeMap.a >= 0.5` smooth skin ramp + nose line),
  plus smoothed-normal outlines from `TANGENT.xyz` and `COLOR_0` 12-bit thickness
  encoding (`(COLOR_0.r * 64 + COLOR_0.g) * (63/64)`).
* **Face skinning & profile correction**: `export_char.ts` decodes
  `VLActorFaceModel.boneWeightAndIndices` across all 7 face bones (`Head`,
  `Eye_L/R`, `EyeHighlight_L/R_a/b`) and exports `CampusActorFaceCorrection`
  morph indices (`[84..87]`), which `char.js` drives each frame from head-to-camera
  angle for clean side profiles.
* **Mecanim humanoid pose & helper bones**: `export_clips.ts` shifts Unity
  humanoid muscle attributes `42..136 -> 0..94` (fixing cubic `StreamedFrames`
  evaluation in `unity_anim.ts`) and exports `RootT/RootQ` + foot/hand IK tracks.
  `pose.js` solves exact Unity `zyRoll` muscle Swing-Twist rotations relative to
  `TPOSE_MUSCLES`, anchors `Hips` height from foot sole `lfT/rfT`, curls/spreads
  fingers in local bone frames, and drives `QuartzDriver` helper twist bones.
  Full-body `actormotion` cues cross-fade directly over `transition` seconds,
  while `actoradditivemotion` subtracts its `t = 0` reference pose (`add(t) - add(0)`).

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
