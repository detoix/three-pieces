# Roadmap

What is planned beyond the current sky and lawn, in four parts: distribution,
the cloud look, the open grass items, and the performance target. Nothing here
is a promise; each item is a change to make deliberately, with the measurement
that judges it named alongside.

## 1. Distribution

The intended shape is one repository containing both independently usable
packages -- which is this repository. Each feature has one canonical
implementation. An npm package and a shadcn-style source-copy installation
would both be generated from that source: source copy gives consumers editable
local code, npm gives them versioned dependencies, and neither feature
requires the other. Optional thin React Three Fiber adapters would handle
React lifecycle, scene attachment and frame scheduling; algorithms, GPU
resources and public data contracts stay in the vanilla Three.js cores.

Done:

- Sky is consumed through its public entry point, with diagnostics available
  without importing implementation modules.
- Grass has a public `createGrass` boundary with typed terrain/surface
  contracts, a matching ground material, idempotent disposal and
  stale-readback suppression. Tuning inputs are validated before allocation,
  and `snapshotStats()` returns immutable diagnostic snapshots.
- The repository extraction itself: `packages/three` is the package and
  `apps/hills` is the demo, and neither imports from anywhere else.

Remaining, in order:

1. Consumer examples that use only the public APIs: sky alone, grass alone, and
   both on one shared renderer, including resource replacement and teardown.
2. Package manifests, exports, peer dependencies, declarations and asset
   inclusion. Generate npm artifacts and source-copy registry entries from the
   same tagged revision.
3. Thin React Three Fiber adapters with explicit WebGPU initialization,
   camera-matrix/update ordering, ownership and demand-render scheduling.
   Animated clouds need continued invalidation with demand rendering; static
   clouds may sleep. Strict Mode and unmount during asynchronous initialization
   must reject stale completion and restore only state the adapter still owns.
4. Validate installed tarballs and copied output in clean consumer projects
   before publishing. A source checkout alone cannot establish distribution
   correctness.

The consumer validation matrix:

| Installation | Host | Required checks |
| --- | --- | --- |
| npm package | Vanilla Three.js | Public imports, asset loading, initialized WebGPU renderer, updates and disposal |
| Source copy | Vanilla Three.js | Copied imports/assets/types, editable local source and the same rendering lifecycle |
| npm package | React Three Fiber | WebGPU setup, asynchronous mount/unmount, Strict Mode and demand rendering |
| Source copy | React Three Fiber | Copy-mode asset/import correctness plus the same React lifecycle checks |

For all four combinations, exercise independent and combined use, resize,
camera movement, repeated mounting/replacement and cleanup. Keep sky and grass
GPU attribution separate, and measure ordinary playback separately from
timestamp instrumentation.

## 2. The cloud look

The demo exists so the sky and lawn can be recorded and posted; the look is
the point, and dropped frames read as stutter. A 1080p review of the hills
found the opening framing good and four problems when looking up or at large
clouds:

1. **Soft, out-of-focus clouds above about 20 degrees.** Edges blur over
   20-40 pixels. Most of that is the density field: `densityAt` in
   `packages/three/src/sky/clouds.js` ramps density linearly up from its
   threshold, so the boundary spans roughly 50-100 m. The 1536x512 cache adds
   a few pixels per texel at mid elevations.
2. **Dirty blue-grey insides on large clouds.** In `march()`, once optical
   depth grows, blue sky ambient dominates because multiple scattering is
   under-weighted.
3. **A repeating band at the horizon.** Shape noise repeats every 3.6 km
   (`q.div(3.6)`), so at 25-50 km the same puffs tile along the band.
4. **The ground does not react to clouds.** No cloud shadows, no cloud
   attenuation of the lighting probe.

The plan, one commit per step, each judged with before/after `shoot.mjs`
frames plus a timing check. The hills demo already drops frames, so steps 1-3
must add no cost.

1. **Lighting.** Multiple-scattering octaves for bright, neutral insides;
   "powder" darkening on edges facing away from the sun; ground bounce on
   cloud bases. Same sample count as now.
2. **Crisp silhouettes.** Steeper density at the boundary and stronger fine
   erosion at the edges. Watch for banding on long rays; it may need a fixed
   per-texel jitter.
3. **Break the horizon repetition.** A second shape sample at a period that
   does not line up with 3.6 km, or a weather-driven offset, on far rays only.
4. **Cloud shadows on the ground**, keeping the pieces independent:
   - the sky exposes a small top-down sun-transmittance map as a TSL node;
   - `GrassLightingModel.direct()` in `src/grass/blade-lighting.js` takes an
     optional sun-visibility node. Blades and the ground surface both use it,
     so that one hook covers both;
   - the demo connects the two.

Known limits that this plan does not remove:

- no cloud attenuation of the lighting probe;
- 60 m/s wind doubles cloud edges, so the default stays 12 m/s;
- coverage and wind cannot change while running;
- sun changes are not atomic visual transitions.

## 3. Open grass items

- **Leaf contrast, aliasing and LOD transitions while moving.** Reviewing
  motion captures found fine leaf contrast and moving LOD transitions the
  remaining visual items; they need review against a capture path rather than
  a still.
- **Blades cast no shadows.** A few hundred thousand shadow-casting slivers
  costs more than it returns at 4-8 cm, so root and ground occlusion stand in
  for it. Cloud shadows (part 2) are the larger missing shadow.
- **No wind.** Short mown blades have no animation node and no time-dependent
  deformation. Anything that adds wind also needs to answer what it does to
  the culling spheres and the far-field proxy.
- **Lawn areas version 1 is flat surfaces at one elevation.** Sloped lawns
  want the procedural height form, and stacked lawns want more than one height
  per point; approximating either would put blades through the floor, so they
  raise an error instead. A version that supports either has to carry its
  height model through placement, the ground surface and walking.

## 4. The performance target

The target is **1920x1080 at 60 FPS on an integrated laptop GPU**, with
capacity left for the rest of the scene. Sustained 60 FPS across all tested
views is not yet established for the hills demo, and the earlier numbers were
measured in a scene with a building, not on the hills (see
[measuring.md](measuring.md) for the last known figures and their caveats).
The target is an acceptance goal, not a guarantee of the packages.

Two rules for pursuing it: prefer exact counts (triangles, visible crowns,
storage bytes) over timing when a claim will be written down, and re-run the
fixed camera paths before and after any change rather than arguing from one
run.
