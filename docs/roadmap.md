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
2. Publishing. `packages/three/package.json` already declares the three entry
   points, their type declarations and the pinned Three.js peer; what is left
   is checking that the bundled assets ship (the Grass004 maps under
   `src/grass/assets/`), publishing to npm, and generating the shadcn-style
   source-copy registry entries from the same tagged revision.
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
clouds: soft, out-of-focus clouds; dirty blue-grey insides on large ones; a
repeating band at the horizon; and a ground that does not react to clouds. All
four are now addressed, below.

**Done, 2026-09-19** -- the first three, in one change, because they turned
out to be one problem:

- **Crisp clouds.** The density field ramped up linearly from nothing to a
  quarter of a real cumulus's extinction, so every boundary was a hundred
  metres deep and every cloud looked out of focus. It now has a body with an
  edge, filtered to the width of one cache texel so a crisp boundary is never
  point-sampled into a staircase; and the march is coarse in clear sky and
  steps back to walk a boundary at a quarter step, so a sharp body does not
  band.
- **Grey shadows.** The lighting is `cloud-lighting.js`, a scalar contract
  with its own tests: multiple scattering that diffuses rather than dying off
  like the beam, powder on the fringes seen from the sun side, and the lit lawn
  under the bases. The far sun samples read a smoothed density, so one point
  a few hundred metres away no longer stamps a blue patch.
- **The horizon no longer repeats exactly.** The weather map's humidity
  channel slides the shape pattern between tiles, for free.

It costs what the soft clouds did -- 1.32-1.34 ms of cloud compute a frame
either way over three alternating trials -- and keeps the page's cloud cover
and brightness to within a point in five of the six fixed views
(`measure-clouds.mjs`). `packages/three/docs/sky-internals.md` has the
details, the numbers and what is still limited.

**Done, 2026-09-19: cloud shadows on the ground.** The sky marches a top-down
map of the sun's beam through the clouds and exposes it as a TSL node,
`cloudShadowNode()`; the demo installs that as the sun's shadow
(`?cloudshadows=off` is the A/B). The plan was a sun-visibility hook in
`GrassLightingModel.direct()`. It turned out not to be needed: Three.js r185
multiplies a light's `shadow.shadowNode` into the light's colour before any
lighting model reads it, so the blades, the ground surface, the light through
the blades and the solid-underlay control are all shaded with no change to
the grass package, and the pieces stay independent. The map is of the
drifting cloud field, so it stays exact and is re-marched only after 0.5 km of
walk or wind. A steady frame marches nothing, and the lookup costs about
0.1 ms of a ground frame. `packages/three/docs/sky-internals.md` has the
design and the numbers.

One consequence for the recordings: at the demo's seed the start point stands
on the western edge of an overcast region, in the sun's direction, so the
opening view is shaded, and the wind carries more of that region over it for
the next few minutes. Where a recording starts -- the start point, the
heading, the moment, or the seed -- now decides whether it opens in sun.

Experiments considered, not adopted -- each has to earn its cost in a matched
comparison before it lands:

- **A dense reference first.** Before changing sample counts, skip distances
  or density thresholds, render the same seed and cloud time with a much
  denser march and compare against it at sparse, normal and dense coverage,
  checking thin wisps, grazing horizon rays and sunlit edges. A speed-up that
  comes from skipping visible cloud is not a speed-up.
- **Local light samples every step.** Lighting reuses all six sun samples
  across two coarse or eight fine occupied samples. A variant refreshes the
  first two (local) samples at every step and reuses only the far four, which
  should sharpen sun-facing edges at some cost.
- **Conservative empty-space skipping.** The march now steps back on a hit
  and integrates finely at a boundary (Loboda et al. §3.2), but it still
  samples every coarse step. Skipping further than that needs *max*-bound
  occupancy data: the shape-only density bounds the eroded density at the
  same point, not over a longer step, and averaged noise mipmaps can erase
  small clouds, so neither is a safe bound on its own. Dense overcast may gain
  little, and divergence on an integrated GPU can eat the saving.

Known limits that this plan does not remove:

- no cloud attenuation of the lighting probe, and under a cloud the sky light
  stays the clear sky's;
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
  for it. They do receive one: with `shadows: true` the clouds' shadow (part
  2) reaches them through the sun's light.
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
capacity left for the rest of the scene. On the hills it is **not reliably
met**. The ground paths (standing, walking, turning) sit right at the budget:
about 16 ms of GPU time per frame with a p95 near 17 ms on a cool machine,
holding about 59 FPS, and about 44 FPS on a day the GPU ran hotter. Every
sky-facing path holds 60 FPS. The breakdown in [measuring.md](measuring.md)
says where the ground frame goes: 4x multisampling is the largest single cost
(4.6 ms), then blade count, the lawn surface's texture work and the clouds.
`?msaa=off` holds 60 with room to spare at the price of a grainier lawn; a
recording that needs both a smooth lawn and smooth motion is better rendered
offline than chased in real time. The target is an acceptance goal, not a
guarantee of the packages.

Two rules for pursuing it: prefer exact counts (triangles, visible crowns,
storage bytes) over timing when a claim will be written down, and re-run the
fixed camera paths before and after any change rather than arguing from one
run.
