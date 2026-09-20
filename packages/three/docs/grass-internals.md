# Grass internals

The public contract is in [grass.md](grass.md). This is the design record behind
it: how the lawn is placed, culled and drawn, why the numbers are what they
are, what it costs, and where the techniques came from. How a number about it
is measured is in [`docs/measuring.md`](../../../docs/measuring.md). An earlier
version of this document described three rings and a different culling pass;
this one was reconciled against the code and is the one to trust.

## Scope

A realistic, short, mown residential lawn with **no wind**: blades a few
centimetres tall, narrow and close together, seen from a walking eye height.
Blades cast no shadows; they receive the scene's when the host asks for it
(`shadows`, on by default in the package). The hills demo turns it on for the
clouds' shadows, which reach the blades through the sun's light rather than
through a shadow map. The host owns the renderer,
terrain, camera and frame loop; the package owns blade geometry, placement,
culling, storage and the shared lawn surface.

## Data flow

```text
four persistent camera-centred rings (close / near / mid / far)
                down only when a ring crosses its own cell boundary
snapped integer world cells -> deterministic placement + terrain sampling
                            + one shared lawn-macro sample per crown
                            + one patch-scale health sample per crown
                            + one 3x3 Voronoi clump search per crown
                down every frame
reset four indirect instance counts
                down
coarse 32x32-cell tile pre-pass -> exact per-crown sphere test -> atomic append
                down
four fixed visible-ID buffers
                down
four drawIndexedIndirect calls (one blade geometry per ring)
```

Nothing is allocated, destroyed or repacked as the camera moves. Each crown
keeps the same slot in the same GPU buffers; a world cell keeps its physical
slot until it leaves the ring window. Snapping changes only a ring's
two-number origin, and only newly exposed strips are re-placed. Integer world
cells seed all jitter, height, width, yaw and thinning, so leaving a place and
returning reconstructs exactly the same lawn.

A candidate is a **crown**, not a blade. Each grows `LAWN.tillers` blades, so
blade density is that multiple of the numbers below while slots, records,
placement work and culling work stay per crown. Tillering is the same on every
ring on purpose: the rings hand over at matched densities, and tillering one
harder than its neighbour would put a visible step at 2 m, 8 m or 24 m. A
tiller stands off the crown centre, fans off its facing and may be shorter than
it, all from the crown's own hash.

| Ring | Distance | Candidate spacing | Fixed slots | Blade segments | Geometry | Base target density |
| --- | --- | --- | ---: | ---: | --- | --- |
| close | 0-2 m | 2.5 cm | 26,244 | 3 | Curved mown leaf, morphs to ribbon over 1.2-1.8 m | 1,600 -> 177.78 /m2 |
| near | 2-8 m | 2.5 cm | 412,164 | 2 | Compact ribbon | 1,600 -> 177.78 /m2 |
| mid | 8-24 m | 7.5 cm | 412,164 | 2 | Compact ribbon | 177.78 -> 25 /m2 |
| far | 24-52 m | 20 cm | 272,484 | 1 | Single triangle | 25 -> 0 /m2 |

The four rings hold **1,123,056 fixed candidate slots**. Their seven-word
placement records and four-byte visible IDs occupy about 35.9 MB (34.3 MiB) of
typed-array data on the CPU and the same as storage on the GPU, before renderer
overhead. Close and near share one world grid, one seed stream and one density
curve, so only the owning ring and the blade geometry change at 2 m. Density
falls continuously inside every band and the far ring reaches zero, so real
geometry changes LOD and then hands off to the textured ground without a
density step or a hard outer edge.

The record is seven 32-bit words: exact world X/Z float bits plus packed
ground/blade height, upper-hemisphere terrain normal X/Z, yaw/width, tint and
macro variation, and one clump word (16 bits of clump heading, 8 of
shortening, 8 of health). X and Z are two scalar `u32` fields and not the
`uvec2` they read as: WGSL rounds an array's stride up to its element's
alignment and a `uvec2` aligns to eight bytes, so with the pair the six words
of fields would stride at six and seven at **eight**. The padding word is
silent -- only `getLength()` reports it -- and the clump word costs 4.2 MiB
across the rings instead of 8.4.

Placement computes the clump, patch health, terrain normal and macro sample
once per crown because all four are functions of where the crown stands and
none of them ever changes. The clump search is a 3x3 Voronoi search that used
to run per *vertex* -- 405 hash-and-compare sequences for every one of a near
crown's 45 vertices -- for a value identical at all of them.

## Culling

Two passes, in order:

- A **coarse tile pre-pass** on the CPU considers the ring window in 32x32-cell
  tiles, rejects tiles outside the ring's radial annulus, rejects tiles that do
  not overlap any supplied coverage bounds, and tests each tile's conservative
  bounding box against the frustum planes using the support point furthest
  along each normal. The bounds describe all possible crown culling spheres,
  not just roots or blade triangles, so the tile pass never discards a crown
  the exact pass would have kept.
- An **exact pass** runs on the GPU over the surviving tiles. Each retained
  crown's culling sphere is tested against the six normalized frustum planes;
  survivors are appended atomically to the ring's visible-ID buffer, and its
  indirect instance count is the append counter.

**Guarded reuse.** An unchanged camera and projection skip grass compute
entirely. Small movements -- under 0.15 m of translation and under 4 degrees of
rotation -- reuse the retained visibility list while the live camera still
controls drawing; the motion margin (which bounds plane-distance change rather
than position) keeps the retained list conservative. A projection change, a
non-rigid camera matrix or an explicit `invalidateCulling()` forces a refresh.
Visible-pose caching (`poseCache`) and subgroup culling (`subgroupCulling`)
exist but are off by default.

## Blade geometry and lighting

The close ring draws a curved, clipped mown blade in three segments and morphs
it into the compact near ribbon over 1.2-1.8 m, before the 2 m ownership
handover. The near and mid rings draw a two-triangle ribbon; the far ring one
triangle. Most leaves have clipped tips with one pointed younger leaf per four
tillers. Tiller identity is kept even where local positions coincide, because
the vertex stage derives each tiller's bend, heading and crown offset from the
vertex index. Receiving shadows is the `shadows` option, which sets the
blades' `receiveShadow`; it costs whatever the light's shadow costs per blade
fragment, and only when a light casts shadows. In the hills demo that light is
the sun carrying the sky's cloud shadow node, a single texture read, and the
light through the blades is shaded with the rest because
`GrassLightingModel` reads the already shadowed light colour.

Lighting is diffuse plus transmission, with three deliberate departures from a
stock `PhysicalLightingModel`:

- **Transmission is gated on the blade's own normal**, not on the camera's
  heading. The term shipped as `pow(dot(-light, view), 4)` alone, which under a
  directional sun is one number for the whole lawn: turning the head lit or
  unlit every exposed tip together, as a sheet. `-dot(bladeNormal,
  lightDirection)` asks instead whether the light reaches the face of *this*
  blade that the eye cannot see. `backscatterAbsorb` carries Beer-Lambert over
  the slant, `backscatterView` leaves the old forward lobe 0.4 of the term, and
  the transmission starts above `rootOcclusionHeight` so the blade never
  lights up at the point the occlusion term just darkened.
- **The shading normal is pulled toward the ground's**, by
  `canopyNormalNear` close up and `canopyNormalFar` far off, ramped between 4 m
  and 28 m. A 3 mm blade past a few metres is narrower than a pixel, and
  shading each by its literal facing turns the clumps that happen to face the
  sun into bright slabs beside dark ones. The transmission term keeps the
  blade's own normal regardless, and the mix falls back below
  `CANOPY_PULL_FLOOR` because it can otherwise cancel to a zero vector.
- **The ground between the blades is occluded by `rootOcclusion`**, which is
  the same value as `groundCanopyAO`: a blade's base and the ground under it
  stand under the same neighbours and receive the same light, and letting the
  two differ puts a step in brightness at every blade. It multiplies albedo
  rather than arriving through `aoNode`, so it takes the sun out too.

The far-field underlay also transmits, on a **view** lobe rather than a normal
gate: a canopy nobody can resolve has every normal at once, so only the eye's
direction decides how much backlit grass reaches it. `?backlight=off`,
`?canopy=0`, `?groundao=1`, `?clumppull=1.2&tillerfan=0.7` and `?grain=` are
the A/B controls for these terms.

How much neighbouring blades agree is `LAWN.clumpPull`. It shipped at 1.2,
where a 45 cm clump outvoted each crown's own yaw and a whole patch presented
one normal to the sun, which is meadow grain rather than mown turf. The preset
is 0.3, with `tillerFan` at 1 radian so a crown's own blades supply the
variety. The hills demo goes further and passes 0.15 and 1.8 through
`posture` (its `?clumppull=` and `?tillerfan=` defaults), so what the demo
shows is the looser of the two. A pull within `CLUMP_PULL_MARGIN` of 1 can
cancel an opposed crown and clump to a vector with no direction to normalize,
so `createGrass` rejects it and the demo's dial steps over the band.

## Palette and the ground surface

The palette is drawn around `LAWN_TARGET_HUE`, and the number is measured
rather than chosen. Turfgrass research scores lawn colour with the Dark Green
Colour Index, whose hue transform is `(H - 60) / 60`: 60 degrees is a lawn's
yellow end, 120 its deep-green end, and a reference photograph of a well-fed
lawn measures **99** and holds it at every depth. The lawn first rendered at
**75**, because the blade greens were authored at 87-91, the Grass004 underlay
is 72, and the warm sun took another 5-7 degrees on the way through. So the
palette is not the image: the palette target is **92** while the image is
aimed at 99, and the gap between them is swept rather than derived -- rendered
mean hue is close to linear in the palette number, at about 0.93 degrees of
image per degree of palette. On the hills demo, at its own dials, 92 lands a
mean of 99.2 (two trials, `docs/measuring.md`); it landed 100.4 before the sky
light followed the clouds, which is now one of the things that moves it. The gap has moved in both
directions as the underlay, occlusion and lights changed; the history is in
the `LAWN_TARGET_HUE` comment in `preset.js`, and the constant is re-swept,
never re-derived, when any of them moves. `lawnColorsFor()` rotates every green by one delta
and solves each back to its original linear luminance, because rotating a hue
in HSV alone changes how bright a colour reads. The underlay is a photograph
and cannot be recoloured, so it receives a per-channel `groundTint` carrying
its mean to the target at unchanged luminance. `?lawnhue=86.7` restores the
authored palette exactly.

The underlay is an optimized derivative of ambientCG Grass 004, a CC0 seamless
short-lawn material: a 1024^2 WebP packing sRGB albedo in RGB and coarse linear
roughness in A, and a 512^2 4:4:4 JPEG normal map. Both repeat in world-space
XZ with trilinear mip filtering and up to 8x anisotropy. A rotated, offset,
non-harmonic second sample is blended in to break the obvious 1.4 m repeat, and
its tangent normal is rotated back into the primary frame before blending.
Normal strength fades out with distance, where sub-pixel micro-relief would
alias, while the albedo and roughness stay as the far-field representation.
Roughness is packed because it does not warrant a second allocation; AO and
displacement are deliberately omitted. Provenance, hashes and the conversion
commands are beside the maps in `src/grass/assets/grass004/README.md`.

## The far field is the underlay

Bare ground measures over 99% past 24 m on the measured coverage curve (see
`docs/measuring.md`): the far ring still draws blades and they cover almost
nothing, so whatever the lawn looks like at distance is whatever the underlay
looks like. `canopyProxy` fades the underlay into the grass it stands in for
between 8 m and 26 m. Both ends are measurements: 8 m is where a blade stops
being resolvable (one pixel covers about 0.6 of a blade there, 2.7 by 16 m),
and 26 m is where there is nothing else left on the curve. Below the near end
nothing changes -- a gap at 2 m is centimetres across and what belongs in it is
ground.

What fades in is the blade's own root-to-tip ramp read toward the tip, the
blades' roughness, and the ground normal. Both ends of the mix take the same
macro tint and dry tint, so ground and canopy are lighter, darker and drier in
the same places the blades are. `canopyProxyOcclusion` is the far field's own
occlusion -- a canopy is darker than a plane painted its colour because light
that gets between the blades mostly does not get back out -- and it is applied
to the canopy end only, since multiplying both ends would occlude the far
field twice. The value in `preset.js` carries its sweep history in its comment;
the sweep measured the render's distance brightening against three CC-BY
photographs (mean +36%), and the constant moved when the canopy's view lobe
arrived. There is no aggregate canopy *orientation* yet: the far field is
correctly-coloured grass lit as a plane, and a lawn-wide orientation field is
the thing it wants next.

`?proxy=0` is the A/B. Measured, it holds hue across every depth instead of
sliding olive as the grass thins out, and side-to-side variation in the far
bands goes up rather than flattening.

## Disposal

`createGrass` returns a `dispose()` that frees its storage buffers itself,
through `renderer._attributes.delete()`. That private field is deliberate:
`BufferAttribute.dispose()` in three r185 only dispatches an event, and the
sole listener in the WebGPU path is registered by `Geometries` for a
geometry's own attributes. The lawn's records and visible IDs are bound as
`storage()` nodes and its indirect commands arrive through `setIndirect()`,
which that listener does not touch. `Attributes.delete()` is the same call the
listener makes -- it destroys the `GPUBuffer` and corrects
`renderer.info.memory` -- and there is no public equivalent.
`renderer.backend.destroyAttribute()` skips the memory accounting and throws
for an attribute that was never uploaded. The cost of getting this wrong
appears when something rebuilds a lawn mid-session: tens of megabytes held
until the page closes. Recheck this workaround when upgrading Three.js.

## Provenance

The architecture was informed by
[momentchan/false-earth](https://github.com/momentchan/false-earth) at commit
`468a0cfd71698400103198a8eb91d5176fe4f59e` (MIT). This is project-native
vanilla three.js/TSL code: no source, shader helper, asset or purchased model
was copied, and False Earth's separately referenced `three-core` submodule was
not vendored or used.

The surface hybrid -- real geometry near the camera, deterministic thinning
with distance, and a ground texture carrying the far field -- follows the same
class of representation as
[Papavasiliou's real-time grass rendering paper](https://jcgt.org/published/0004/01/02/paper.pdf)
and the [Ghost of Tsushima vegetation slides](https://media.gdcvault.com/GDC%2B2021/ghost_streaming_gdc2021.pdf).
False Earth demonstrated the important combination -- camera-centred snapped
placement, compute culling, LOD buffers and indirect draws -- but its sample
keeps a uniform candidate grid. This implementation adds deterministic
continuous distance thinning and independent persistent clipmap-style rings.

## Verification boundary

`node --test` protects the CPU contracts: ring capacities and snapping,
deterministic return-to-place placement, exclusive ownership and monotonic
density, the packed record stride and storage budget, float-bit preservation
and quantization error, blade bounds against the culling sphere, the lighting
and palette arithmetic, and resource disposal. Those tests never execute
WebGPU, and CPU tests cannot see a single blade on screen. Compute, indirect
draws, culling counts, texture sampling and frame time require a hardware
WebGPU browser; headless Chromium works but only through the full browser
(`channel: 'chromium'` in Playwright), not the headless shell, which has no GPU
process at all. Check which adapter actually rendered before believing any
number -- a software adapter will render the lawn at a frame every few hundred
milliseconds.

Frame time on an integrated laptop GPU, on a machine in use, may not resolve a
small difference at all: repeated runs of one configuration have spread over
tens of percent, and a heavier setting has beaten a lighter one. Counts are
exact and time is not, so prefer triangle, visible-crown and memory figures for
anything written down, and treat an FPS figure as a direction rather than a
magnitude.

The sky side of the same demo is in [sky-internals.md](sky-internals.md).
