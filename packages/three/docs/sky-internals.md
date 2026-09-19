# Sky internals

The public contract is in [sky.md](sky.md). This is the design record behind it:
how the atmosphere and clouds work and why, what the angular cache costs, what
the implementation deliberately does not do, and where the techniques came
from. How a number about any of it is measured is in
[`docs/measuring.md`](../../../docs/measuring.md).

## Scope

A ground-level daylight sky with scattered cumulus, for a camera that walks a
small site. The sun and the weather are fixed at construction; the sun can be
rebaked, asynchronously. The camera stays at eye height. Cloud fly-through,
scene/cloud intersections, dynamic weather, cloud ground shadows and night
content are outside the implemented scope. Everything below serves that scope.

## The atmosphere

The clear atmosphere follows Hillaire's low-frequency lookup-table model: a
compact transmittance table, a small multiple-scattering table and a sky-view
table, all written once by compute passes at startup, plus a solar disk
composited separately. Planet and medium parameters are fixed internally
(Rayleigh and ozone coefficients from Bruneton's precomputed-scattering model,
Mie as the clear-air haze term) and the observer height is an input but does
not rebake.

The three tables are 256x64, 32x32 and 256x144 -- 424 KiB of RGBA16F in total.
They are the entire steady-state cost of the atmosphere: each background pixel
pays one bilinear fetch of the sky-view table, and each fogged fragment one
more. The sun does not move and a metre of eye height is nothing against a
hundred kilometres of air, so the tables are as valid on the last frame as on
the first; `?sunelevation=` and `?sunazimuth=` rebake the sky-view table and
the clouds but not the invariant transmittance and multiple-scattering tables.

`atmosphere.js` is the dependency-free scalar contract and `sky-nodes.js` is
its TSL twin. Every constant and every table mapping is written in the scalar
module, which `node --test` can read, and transcribed into TSL. When the two
disagree the scalar side is right. The table mappings get the most test
attention because that is the failure nobody sees: a write mapping and a read
mapping that disagree still render a smooth, plausible, wrong sky, with no
error anywhere.

Two things are easy to get wrong and are load-bearing:

- **The sun is one direction, not two.** The directional light that shades the
  scene and the atmosphere that scatters must be aimed from the same angles.
  A sun disk that is not where the shadows say it is looks wrong in a way
  nobody can name.
- **Multiple scattering is not a uniform dimming.** With `?skyms=0` the zenith
  loses 39% of its luminance, the horizon across the sun 34%, the horizon into
  the sun 19% and the far haze 28%, because the zenith has the least single
  scattering to begin with. Without it a clear horizon reads as dusk at noon.

The fog is sky-coloured linear distance haze, not volumetric aerial
perspective. Clear air extinguishes two parts in a thousand over 100 m, so a
ramp is not Rayleigh; it stands in for humidity and aerosol the model has no
business resolving at this scale. The shape is therefore a plain ramp between
the host's `near` and `far`, and only the colour changes, to the sky each
fragment is standing in front of. That is why the background could not be
replaced on its own: a blue sky over a green horizon haze reads as a bug.

## The clouds

Clouds are a procedural three-dimensional density field integrated into a
hemispherical cache. The layer is curved, about 1.35-2.65 km above local
ground, and rays are truncated at 70 km. Integration runs in kilometres; the
observer position arrives in metres.

Density comes from deterministic periodic RGBA8 noise: shape and erosion
volumes, with a 2D weather map controlling coverage and the vertical profile.
Shape repeats over 3.6 km and boundary erosion over 0.55 km. Coverage is a
weather parameter, not a promise that that fraction of the image is cloudy and
not an opacity multiplier. A smooth density feather over local weather coverage
0.08-0.25 makes density approach zero at clear-region boundaries; without it
the early-out can clip dense billows into vertical walls. The feather applies
during both view and shadow integration and changes edge optical depth, not
final compositing opacity.

Each ray uses fixed midpoint quadrature. The primary count is
`min(256, max(presetMinimum, ceil(rayLengthKm / 0.05)))`: about 50 m target
spacing, finer on short rays, possibly wider at the 256-sample cap, with early
opacity termination performing fewer samples. Midpoints replace persistent
spatial jitter to reduce stippling. This adapts the count to ray length; it is
not occupancy-driven empty-space skipping or signed-distance traversal.

A sample footprint is estimated from the larger of the primary step length and
the angular-cache texel extent at the sample distance. Unresolved fine erosion
octaves blend toward their measured texture means, which keeps the mean noise
input closer than removing erosion does -- but nonlinear thresholding means
density and coverage can still change. Broad shape noise is always sampled at
its base level.

Lighting uses six exponentially spaced sun-density samples, with erosion in the
first two and cheaper shape-only density after. Their accumulated optical depth
is reused for two consecutive occupied primary samples; empty space forces a
refresh on the next hit. Density, Beer transmittance and radiance still
integrate every primary sample. The sun march reaches about 0.87 km and does
not provide complete long-range inter-cloud shadows. A dual Henyey-Greenstein
phase, a low-order multiple-scattering approximation, a height-dependent
ambient term and exponential cloud aerial haze provide the visible lighting.
These are rendering approximations, not an energy-validated scattering model or
a meteorological simulation.

## The angular cache, motion and memory

Each of three cloud states contains two RGBA16F textures: radiance RGB plus
transmittance in A, and a distance texture with only R used. Six full-size maps
are allocated. Two complete states are displayed while the third is filled in
interleaved slices across the hemisphere. Periodic azimuth and quadratic
elevation mapping allocate more latitude samples near the horizon.

| Preset | Dimensions | Minimum primary samples | Update slices | Texels updated/frame | Cycle at 60 updates/s | Six cache maps |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| low | 768x256 | 40 | 128 | 1,536 | 2.13 s | 9 MiB |
| balanced | 1536x512 | 72 | 256 | 3,072 | 4.27 s | 36 MiB |
| high | 2048x768 | 96 | 384 | 4,096 | 6.40 s | 72 MiB |

All presets share the 256-sample upper bound. Add 1 MiB for the 64^3 RGBA8
noise and 64 KiB for weather, plus the atmosphere tables. These are calculated
texture sizes and exclude driver allocations, pipelines, CPU copies and
probe/readback storage. Static clouds still allocate the resources and
initialize two complete states; zero wind or zero coverage stops subsequent
cloud compute.

Cached distance is the ray mean weighted by visible extinction:
`sum(T_before * (1 - T_segment) * distance) / (1 - T_final)`. Nearly
transparent texels use the spherical mid-layer intersection as a fallback. This
is one representative distance for an integrated cloud contribution, not a
first surface, a complete depth distribution or a terrain depth.

Each state's distance is sampled at the unwarped view direction. Distance,
camera position and the display/snapshot time difference provide one
first-order reprojection into that state's colour texture; corrected completed
states are then blended. Wind correction aligns bulk movement better than
cross-fading unshifted silhouettes, and the per-ray mean distance improves on
the initial single-altitude estimate. Depth is not iteratively resampled at the
corrected coordinate: several clouds along a ray collapse to one value, and
bilinear filtering across clear/cloud boundaries mixes their distances. That
cannot reconstruct hidden structure or newly revealed content, and reprojection
moves cached lighting and haze with density although those terms depend on the
current view and sun. Residual edge doubling, distortion or brightness changes
remain possible with large translations, fast wind or long cache intervals.

Snapshot times are recorded independently of cache indices; blend weight
follows update progress and new snapshot times are predicted from the last
cycle duration. Cycle duration is cache latency, not GPU time and not a
guaranteed maximum response delay. Long clock gaps advance the simulation by at
most 0.1 seconds per update. With an `observer`, each snapshot is marched from
where it stands, so parallax is measured from that point; a new position
reaches the display within two cache cycles, and with zero wind snapshots are
remarched only after the observer moves 100 m.

## The lighting probe and the lights

A lighting probe runs as a fourth compute pass -- one invocation, 1,024
cosine-weighted directions sampling the sky-view table, read back once -- and
reports the sun's beam and the hemisphere's irradiance in the model's own
units, where the sun above the atmosphere is 1.

`lights.js` anchors a directional light and a hemisphere light to that probe.
What is taken is the **colour**: the sun's warmth and the sky's blue are the
air's rather than an author's. What is not taken is the balance. Measured off
the probe, a real sun at the shipped elevation delivers 10.2 times the
irradiance of its own sky onto flat ground, while the authored pair delivers
1.34; adopting the real ratio would deepen every shadow sevenfold and move the
grass palette's backlight, canopy and occlusion calibrations along with its
hue. So each light's luminance is scaled by an anchor that reproduces the
authored value exactly at the shipped sun, and both then dim and redden with
the sky as the sun moves. Making the balance physical too is a separate
change. Cloud attenuation of the probe is not implemented.

## Known limits

- **Softness.** Edges of large clouds blur over tens of pixels at mid
  elevations. Most of that is the density ramp in `densityAt`: a linear ramp
  from threshold then x2.4 with x14/km extinction, so the boundary spans
  roughly 50-100 m. The cache resolution adds a few pixels per texel.
- **Dirty interiors.** In `march()`, once optical depth grows, blue sky ambient
  dominates because multiple scattering is under-weighted; large clouds can
  read blue-grey inside.
- **A repeating band at the horizon.** Shape noise repeats every 3.6 km
  (`q.div(3.6)`), so at 25-50 km the same puffs tile along the band.
- **The ground does not react to clouds.** There are no cloud shadows and no
  cloud attenuation of the lighting probe. The planned shape of the fix is
  recorded in [`docs/roadmap.md`](../../../docs/roadmap.md).
- **Fast wind is not robust.** At 60 m/s cloud edges visibly distort and
  double; the default is 12 m/s.
- **Coverage and wind cannot change while running.** Options other than the sun
  are fixed at construction.
- **Sun changes are not atomic visual transitions.** Shared uniforms and atlas
  textures change while the asynchronous operation runs; pause host rendering
  while awaiting `setSun` if intermediate frames must be avoided.
- **No automatic quality policy.** The host handles device loss, adapter
  selection, resizing and quality policy; the API does not silently reduce
  quality to meet a frame-rate promise.

## Research sources

The architecture is a hybrid of ideas, not a complete implementation of one
publication. The table separates what was adopted -- often adapted, as noted --
from what a source describes that this renderer does **not** do. The second
column matters as much as the first: several of these techniques are the
obvious next experiments, and `docs/roadmap.md` lists them as such.

| Source | Adopted here | Described there, not implemented here |
| --- | --- | --- |
| [Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*, EGSR 2020](https://sebh.github.io/publications/egsr2020.pdf), §§5-7, and the [author's reference implementation](https://github.com/sebh/UnrealEngineSkyAtmosphere) | The transmittance, multiple-scattering and sky-view tables; the horizon-concentrated sky-view mapping; the separately composited solar disk; the isotropy assumption after the second scattering event. | The aerial-perspective volume. The fog here is a linear distance ramp coloured by the sky-view table. |
| [Åsberg, *Real-time Rendering of Dynamic Baked Clouds*, KTH 2024](https://www.diva-portal.org/smash/get/diva2%3A1895803/FULLTEXT01.pdf), §§3.6, 4.2, 5.1 | The hemisphere radiance/transmittance cache, partial updates, and interpolation between two completed states while a third is filled. | Its square-to-disk mapping, which favours the zenith; this cache's quadratic elevation mapping favours the horizon instead. The source's own limits on camera translation, cloud speed and response to a changing sun apply here too, as does its fast-motion ghosting. |
| [Schneider, Guerrilla, *Nubis³*, 2023](https://www.guerrilla-games.com/read/nubis-cubed) | The split between a detailed near light sample and cheaper far ones (here: erosion in the first two of six sun samples, shape-only after), and fading detail noise with distance (here: unresolved erosion octaves fade to their measured means). Both are adaptations. | Voxel cloud profiles, conservative signed-distance traversal, the separately cached far-light volume, and static jitter for distant sampling -- this march uses fixed midpoints instead. |
| [Loboda et al., *Real-time volumetric cloud rendering for games and simulations*, 2025](https://lgm.fri.uni-lj.si/wp-content/uploads/2025/10/250771715.pdf), §§3-4 | Weather-controlled coverage and height profile; broad shape evaluated before detail erosion, which only runs where shape is non-zero; an ambient term that is explicitly a non-physical approximation. | Coarse/fine marching that steps back on a hit (§3.2). |
| [Muth, *Real-Time Volumetric Rendering of Meteorological Cloud Data*, TU Wien, 2026](https://www.cg.tuwien.ac.at/research/publications/2026/muth-2026-clouds/), §§3.4, 4.2 | Transmittance-weighted depth, used here to warp a hemispherical cache rather than to reconstruct a screen-space history; a sample footprint derived from the step and the texel extent to decide which noise is resolvable. | Half-resolution screen-space integration, temporal reprojection with variance clipping. Its ghosting and convergence tradeoffs are why this renderer keeps no screen-space history. |
| [Mueller, *Smolder*, SIGGRAPH 2026 course](https://advances.realtimerendering.com/s2026/index.html) | The idea of lighting at a lower frequency than density integration (here: six sun samples reused for two occupied primary samples), with its caution that shared lighting can damage temporal stability. | Transmittance-dependent rate selection, jittered interpolation of shared lighting, wave operations and asynchronous compute. |

The sources' reported timings come from native renderers and other GPUs; none
of them establishes performance for this browser, GPU class or API. Where a
technique was adapted rather than reproduced -- lighting-sample reuse, the
mean-distance warp, mean-faded erosion -- the sections above describe what
this renderer actually does, and acceptance still requires runs in a
hardware-WebGPU browser.

For the grass side of the same demo, see
[grass-internals.md](grass-internals.md).
