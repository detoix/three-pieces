# Sky internals

The public contract is in [sky.md](sky.md). This is the design record behind it:
how the atmosphere and clouds work and why, what the angular cache costs, what
the implementation deliberately does not do, and where the techniques came
from. How a number about any of it is measured is in
[`docs/measuring.md`](../../../docs/measuring.md).

## Scope

A ground-level daylight sky with scattered cumulus, for a camera that walks a
small site, and the clouds' shadows on the ground it stands on. The sun and
the weather are fixed at construction; the sun can be rebaked, asynchronously.
The camera stays at eye height. Cloud fly-through, scene/cloud intersections,
dynamic weather and night content are outside the implemented scope.
Everything below serves that scope.

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
not an opacity multiplier.

**The body has an edge.** Real cumulus have a sharp boundary and a nearly
uniform inside, so density rises steeply over the first `EDGE` (0.12) of the
shape field and only slowly after it, to an extinction of about 40-70 per
kilometre -- a mean free path of 15-25 m. The previous field ramped up linearly
from nothing, to a quarter of that, and the result was what you would expect
of a boundary spread over a hundred metres: clouds that looked out of focus at
every distance, their shading averaged away over the depth the eye was
looking through.

**The edge is never sharper than the cache can hold.** A boundary narrower
than one cache texel is point-sampled into a staircase, and the texel-sized
steps showed at 4-5 pixels a side at 1080p. The edge widens with the sample's
angular footprint, at `EDGE_PER_KM` (30) shape units per kilometre of it, and
stops widening at `EDGE_MAX` (1), past which a distant cloud would be all edge,
never reach its body, and let every ray through it run on. This is the same
idea as the fine-erosion filtering below: never ask the cache for detail
narrower than it has texels for.

**Thin coverage shrinks a cloud rather than fading it.** The weather feather
scales the shape before its threshold, over local coverage 0.08-0.15, so a
cloud near a clear region keeps a crisp boundary and gets smaller; it still
reaches zero at the 0.08 early-out, so billows cannot be cut into vertical
walls along weather contours. (It used to scale density after the threshold,
which faded clouds instead.)

**A cumulus has a flat base.** It is the height at which rising air
condenses, the same for every thermal under the cloud, and every cloud in the
reference photographs (`docs/measuring.md`) shows one: grey under a white top,
and far off a flat-bottomed lens. The billow octaves that carve a cloud now
grow in over the lower 40% of its height, the cut at its base is 4.5% of it
deep (from 6.5%), and erosion fades out below 10%. So the base's footprint is
the smooth low-frequency shape, cut off flat. With billows everywhere the
undersides were as lumpy as the tops, and the horizon a band of popcorn.
Guerrilla's recipes (Schneider 2015, 2017) shape the density with height
instead -- thin at the base, dense at the top -- and in this renderer that
brought back the soft look the body with an edge was made to remove; a dome
taper alone made rounder but blobbier clouds. Cover falls by up to 1.7 points
in the fixed views, where lobes used to hang below the bases, and the cloud
compute is unchanged.

**The pattern slides.** The weather map's broad humidity channel shifts the
shape lookup by up to 0.35 of a tile across its roughly 8 km cells, so the
3.6 km repeat no longer lines the horizon with the same puffs. The stretch
this introduces is under a third, and it is free: the weather texel is already
fetched.

A sample footprint is estimated from the larger of the step length and the
angular-cache texel extent at the sample distance. Unresolved fine erosion
octaves blend toward their measured texture means, which keeps the mean noise
input closer than removing erosion does -- but nonlinear thresholding means
density and coverage can still change. Broad shape noise is always sampled at
its base level.

**The march is coarse in clear sky and fine at a boundary.** Coarse steps
target 50 m, at least the preset's minimum count and at most 256 across the
layer, at midpoints so no persistent jitter stipples the cache. A body with an
edge 15-25 m deep would band at a 50 m step, so when a coarse step lands in
cloud the ray backs up over the interval it jumped and walks it at a quarter
of the step, locating the boundary to a quarter step. Fine steps continue
until the ray has been out of cloud for six samples, or is deep enough
(transmittance under 0.3) that what lies behind barely shows; then it returns
to coarse steps. The ray stops at transmittance 0.005, and 320 samples is the
hard cap on coarse and fine together. This is the coarse/fine pattern with a
step back on a hit (Loboda et al. §3.2); like the coarse march before it, it
does not skip a whole coarse step it has not sampled, so it is no less
conservative than a plain march at the coarse step.

**Lighting** uses six sun samples, at the midpoints of segments growing 2.45x
from 15 m, which reaches 1.3 km: the path from a cumulus's underside to a
49-degree sun through a kilometre of cloud. The first two read the full body with
erosion; the other four read a smooth density (the shape field, not the sharp
body), because a segment a few hundred metres long averages over a cloud and
its gaps, and a single point there used to decide the shading of a whole patch
-- the blue-grey blotches. The accumulated optical depth is reused across two
coarse or eight fine occupied samples, is not refreshed at all once the ray is
deep, and is always refreshed on entering cloud, so a gap cannot inherit
another cloud's light.

How a sample is then lit is `cloud-lighting.js`, a scalar contract the shader
transcribes term for term and `test/sky-cloud-lighting.test.js` holds:

- **Single scattering**: the beam through the optical depth to the sun, under
  a dual Henyey-Greenstein phase (g 0.65 and -0.2, weighted 0.8 / 0.2) that
  keeps the silver lining toward the sun.
- **Multiple scattering** diffuses rather than dying off like the beam:
  `msWeight / (4 pi)`, isotropic, falling as `1 / (1 + 1.2 tau)`. It is what
  keeps a shaded side grey; an exponential in the optical depth handed it to
  the blue sky ambient instead.
- **Powder**: seen from the sun's side, a thin fringe has had few scattering
  events and is darker than the body behind it, which draws the creases
  between billows. Toward the sun no darkening applies.
- **Ambient**: tops see the sky (0.2 of its irradiance at the base of the
  layer, 0.8 at the top), bases see the sunlit lawn below -- the atmosphere's
  own ground albedo under the sun and sky, cut to a quarter for the cloud
  field's shadow on it. The sky in both is the cloudy sky, not the clear
  probe; the next section is how it is arrived at.
- **Exponential cloud aerial haze** blends distant clouds toward the sky
  behind them, as before.

**The sky a cloud sits in** is the cloudy one. A shaded side is lit as much by
the white cloud beside it as by the blue overhead, and under the clear-sky
probe alone every shaded side drifts blue however bright its neighbours are.
The finished cache is the only place this renderer knows what the neighbours
look like, so one invocation averages it over 256 cosine-weighted directions
of the upper hemisphere -- the cosine weighting in the sampling, so the
integral is a plain mean times pi, as the atmosphere's own probe does it in
`sky-nodes.js` -- into `clear * meanTransmittance + pi * meanCloudRadiance`:
the clear sky as the clouds leave it, plus what they scatter back.
`cloudySkyIrradiance` in `cloud-lighting.js` is the scalar contract. It runs
once a cache cycle, off the snapshot that has just been completed, and twice
at a bake: a bake's first snapshot is a probe, lit by the clear sky because
there is no cloudy one to average yet, and the two displayed snapshots are
then marched again under the average taken off it. One round is enough -- the
second order is a few percent of a term that is itself a fraction of the light
-- and without it the look would depend on the wind, which is what refreshes
the average afterwards: a still sky would keep the clouds it marched before it
knew its own colour.

Measured at 1920x1080 on an integrated laptop GPU, wind stopped. At coverage
0.48 the averaged sky is (0.079, 0.110, 0.165) against the clear probe's
(0.031, 0.065, 0.127): blue over red 2.1, where the clear sky's is 4.0. Over
the six fixed views the darkest quarter of the cloud pixels brightens by
0.04-0.07 in red and about half that in blue -- in the opening framing (0.598,
0.676, 0.735) to (0.658, 0.719, 0.761), closing the gap between blue and red
by a quarter -- and their hue warms 1.2 to 1.6 degrees. At the demo's
coverage, 0.1, there is little beside a cloud to light it: the average is
(0.042, 0.075, 0.137) and no pixel of the six moves by more than ten levels of
255. It costs nothing a frame: over three alternating GPU-timed trials the
cloud compute measured 1.49-1.57 ms looking at the sky and 1.30-1.33 ms
walking under it, old and new alike. The two extra marches move the bake,
which happens at load and whenever the sun does, from about 85 ms to about
120 ms.

These are rendering approximations tuned against the image, not an
energy-validated scattering model or a meteorological simulation. The first
tuning was held to the page's previous character with
`apps/hills/scripts/measure-clouds.mjs`: across the six fixed views, cloud
cover within a point of what it was in five of them (the humidity slide moved
clouds out of the sixth, 22.5% to 18.1%), the same luma spread -- 0.7-0.9
from the 10th to the 90th percentile of cloud pixels -- and the shaded tenth
of the cloud a greyer blue, hue 205 against 209-217.

The second is held to real skies instead. `measure-photos.mjs` puts ten
fair-weather cumulus photographs through the same classifier: pooled, cloud
luma 0.62/0.77/0.90 at the 10th/50th/90th percentile, a spread of 0.69, and
saturation 0.08/0.19 at the 50th/90th. At the sky's default coverage the
render measured 0.68/0.78/0.89, a spread of 0.77 and saturation 0.07/0.15:
flatter and more neutral than any sky in the set. Two changes close most of
it -- the sun march reaching through a whole cloud, and a steeper
multiple-scattering falloff (1.2, from 0.4) -- to 0.65/0.77/0.88, 0.74, and
0.10/0.20, with cloud cover unchanged (`measure-clouds.mjs` now finds cover
by rendering each view again without clouds, so shading cannot pass for less
cloud). At the demo's coverage, 0.1, the spread goes from 0.82 to 0.79 and
the saturation to the photographs' own 0.08/0.19; small clouds have less
depth to shade. Toward the sun the change is plainest: undersides that were
lit white now read grey under bright rims.

**What it costs.** The same as the soft clouds it replaced: over three
alternating GPU-timed trials each at 1920x1080 on an integrated laptop GPU,
the cloud compute measured 1.32-1.34 ms a frame looking at the sky, old and
new alike, and the walking and turning ground frames were indistinguishable.
The two things that made that true, found the hard way: refining only where
it pays is not enough on its own -- a distant cloud filtered to its texel
width never reached its body, and rays crawled through it lit at every step,
which cost 2.5 times as much -- and the deep samples do not need fresh light.

## The angular cache, motion and memory

Each of three cloud states contains two RGBA16F textures: radiance RGB plus
transmittance in A, and a distance texture with only R used. Six full-size maps
are allocated. Two complete states are displayed while the third is filled in
interleaved slices across the hemisphere. Periodic azimuth and quadratic
elevation mapping allocate more latitude samples near the horizon.

| Preset | Dimensions | Minimum coarse samples | Update slices | Texels updated/frame | Cycle at 60 updates/s | Six cache maps |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| low | 768x256 | 32 | 128 | 1,536 | 2.13 s | 9 MiB |
| balanced | 1536x512 | 48 | 256 | 3,072 | 4.27 s | 36 MiB |
| high | 2048x768 | 64 | 384 | 4,096 | 6.40 s | 72 MiB |

All presets share the 256 coarse-sample upper bound, and a cap of 320 coarse and fine samples together. Add 1 MiB for the 64^3 RGBA8
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

## Cloud shadows

`cloud-shadow.js` holds the geometry and the schedule as plain arithmetic with
its own tests, and the GPU plumbing that follows them; the march itself is in
`clouds.js`, because it reads the same density field the sky is drawn from.

**The map.** 256x256 RGBA16F texels (R used) over 5.12 km of ground, 20 m a
texel, two of them: one shown while the other is marched, 1 MiB together. Each
texel marches from its point of the ground, at y = 0, toward the sun through
the layer, in 50 m steps -- 35 at the demo's 49-degree sun, never fewer than 16
or more than 64 -- and stops once the optical depth passes 8. The ground point
is the observer of its own march: the ray starts there and curvature is
measured from there, so a texel's value depends only on where it lies in the
cloud field, and two maps centred in different places agree wherever they
overlap. A world position is projected along the sun onto y = 0 before it is
looked up, so a blade tip, a hillside and anything a host stands on the ground
all read the clouds between them and the sun.

**Why it is cheap.** The map is of the cloud field, not of the ground. The
density model has no motion but drift, so a marched map stays exact, read a
little further along each frame. It is re-marched only when the observer's
field point -- where they stand plus the drift -- is 0.5 km from the map's
centre, 64 slices over 64 frames into the map not shown, which is then shown
whole. At 0.8 km, after a teleport or when frames are too slow for the slices
to keep up, the whole map is marched in one frame. Between them those two rules
keep every point within 1.56 km of the observer on a complete map after every
update; a test walks an observer at the sky's fastest wind and the demo's
fastest run, with teleports, and checks it. New maps are centred on the texel
grid of the old ones, so a swap changes nothing on screen: frames drawn from
consecutive maps, from a fixed camera with the wind stopped and shadow edges in
view, differ by at most one grey level. The lookup where the shadows are drawn
is one texture read and two multiply-adds: the sun's slope is folded into one
uniform at each bake and the drift and centre into another on the CPU every
frame, in doubles, where hours of drift cost no precision; the map's outer
0.2 km fade to no shadow is marched into the texels, so beyond the map the
edge clamp reads none.

**The edge.** A cloud's shadow is the cloud that casts it, so the march reads
the body at its crispest, as the nearest clouds overhead are drawn. Maps read
back from the GPU with the wind stopped, at the demo's start:

| Body edge read by the shadow march | Ground shaded (T < 0.5) | Texels per edge crossing |
| --- | ---: | ---: |
| Filtered to the 50 m step (the sky's rule for a view ray) | 40% | 6.8 (137 m) |
| Filtered to the 20 m texel | 44% | 5.4 (109 m) |
| Crispest, `EDGE` | 49% | 3.2 (63 m) |

The step-filtered body ringed every shadow with a 140 m grey fringe and let
thin cloud through that the sky draws opaque. The crisp one is kept: 20 m
texels, filtered, blur its edge by about the sun's own width -- 0.53 degrees is
17 m from a base 1.8 km up the ray and 33 m from a top 3.5 km up -- and no
banding from the 50 m step showed in the map.

**Measured**, 2026-09-19, on an integrated laptop GPU at 1920x1080, timed runs
with 3 s warmup and 10 s samples:

- The lookup, three alternating trials each: walking 10.77-10.87 ms of GPU
  time a frame without shadows and 10.91-10.95 with them; turning 10.95-11.14
  without and 10.95-11.18 with. About 0.1 ms, or nothing measurable. The
  first version worked the projection, drift and edge fade out per pixel and
  cost 0.2-0.3 ms, which is why they were folded away.
- The march, with the wind at 100 m/s so maps are re-marched every five
  seconds: 0.053 ms median in a frame that marches a slice (p95 0.058), so a
  whole map is about 3.4 ms -- at each bake, and in the one frame after a
  teleport.
- The look, from `measure-cloud-shadows.mjs` at the start point with the wind
  stopped: shaded lawn at 0.22-0.28 of its sunlit luminance. The lights set
  that, not the clouds. Under the authored balance the sun delivers 1.34 times
  the sky's irradiance on flat ground, and with the light through the blades
  gone too, a shadow keeps about a quarter. Under the probe's physical balance,
  10.2 times, a clear sky's shadow would keep under a tenth; `lights.js` says
  why the balance is authored.
- The sky and the shadows agree: at the start point the map reads 5% of the
  sun getting through, and looking at the sun from there, its disk is behind a
  cloud's edge.

## Known limits

- **Edge crispness is capped by the cache, most visibly near the zenith.**
  The body's edge is filtered to one texel, so a cloud is exactly as crisp as
  the 1536x512 cache allows at `balanced`: about 4-5 pixels a texel at 1080p
  over most of the sky. Near the zenith the quadratic elevation mapping puts
  rows 0.3 degrees apart while the columns converge, so texels there are about
  5 pixels by 1-2, and a crisp edge shows their steps. Ground-level framings
  rarely look there; `high` narrows it.
- **The far field is a field of small puffs.** At 25-50 km a cloud's billows
  are a few pixels high, so the band along the horizon reads as texture rather
  than as clouds. The humidity slide keeps neighbouring 3.6 km tiles from
  matching, but the scale of the shape noise is still the scale of the
  horizon's texture.
- **The lighting is tuned, not validated.** The multiple-scattering falloff
  is set against photographs, and powder and the ground bounce against the
  rendered image; none is derived. The sun march reaches 1.3 km and past its
  first two samples (about 40 m) it reads a smoothed density, so one cloud's
  shadow on another is soft and reaches no further than that.
- **Cloud shadows shade the sun, not the sky.** Under a cloud, only the direct
  beam is taken away; the host's sky light is the clear-sky probe's, and
  there is still no cloud attenuation of the probe. Positions above the cloud
  base, and more than 1.56 km from the observer, are not shaded.
- **Where the weather puts the observer decides the scene.** The weather map
  lays out overcast regions several kilometres across, saturated over 18% of
  the world. At the default coverage the demo's start point is on the western
  edge of one, in the sun's direction, so its opening view is shaded. Coverage
  below the default thins every region in proportion (`cloudLocalCoverage`),
  so at the demo's 0.1 the opening is sunlit and 17% of the ground around it
  shaded, against 49% at 0.48, read back from the shadow map. As an offset,
  coverage had left those regions' cores as dense as at the default: at 0.1
  the opening was still 85% shaded.
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
| [Loboda et al., *Real-time volumetric cloud rendering for games and simulations*, 2025](https://lgm.fri.uni-lj.si/wp-content/uploads/2025/10/250771715.pdf), §§3-4 | Weather-controlled coverage and height profile; broad shape evaluated before detail erosion, which only runs where shape is non-zero; an ambient term that is explicitly a non-physical approximation; coarse/fine marching that steps back on a hit (§3.2), as the march section above describes. | Its occupancy data for skipping empty space: this march never skips a coarse step it has not sampled. |
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
