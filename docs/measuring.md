# Measuring

`pnpm test` runs `node --test`, and those tests never execute WebGPU: they
cannot see a pixel, a draw or a GPU millisecond. Everything about the rendered
image -- cloud edges, lawn coverage, the hue a real pixel lands on, frame
cadence, pass timings -- has to be measured in a hardware-WebGPU browser.
`apps/hills/scripts/` holds the tools that do it. This document says what each
one answers, when to re-run it, and when a number it prints counts.

The tools assume a development server you started yourself, and they take its
URL (default `http://127.0.0.1:5173/`). They never start or stop a server; if
you start one only for a run, record its process id and stop exactly that
process when done.

## The tools

| Tool | What it answers | Re-run when |
| --- | --- | --- |
| `shoot.mjs` | Fixed-view 1080p frames: six elevations/azimuths around the sun and away from it | Any visual change to sky, clouds, terrain or grass; before/after judgement for each change |
| `benchmark.mjs` | GPU pass time and frame cadence along fixed camera paths, with or without timestamp instrumentation; the sky's cloud compute and the cloud shadow march are attributed separately | Any change to shaders, quality, density, or render scheduling |
| `record-motion.mjs` | 10-second WebM captures of fixed motion paths (static, turn/walk stress, seam, zenith) | Any change to the angular cache, wind handling, culling or LOD that should be reviewed in motion |
| `measure-sky.mjs` | Rendered sky radiance and the fully fogged far band's luminance, with the instrument eye raised so the band is resolvable | `SKY_EXPOSURE`, the sun, the medium or the tone mapper move |
| `measure-lawn-hue.mjs` | Rendered hue, saturation and luminance over six depth bands, with cloud shadows off | The underlay, occlusion, lights, palette or blade coverage move (these interact, so re-sweep together) |
| `measure-lawn-coverage.mjs` | Fraction of bare ground by distance, with the underlay painted emissive and cloud shadows off | Blade height, blade width, tillering or ring density move |
| `measure-clouds.mjs` | Cloud cover (against the same views rendered without clouds), luma spread, saturation and the colour of the shaded parts over the six fixed views, wind stopped | Anything in the cloud density, march or lighting; the look was tuned against these numbers |
| `measure-photos.mjs` | The same luma spread and saturation for photographs, through the same classifier | When the reference set changes; its numbers are the target for the cloud look |
| `measure-cloud-shadows.mjs` | How much of the lawn in view is shaded and how dark, over the six fixed views, against the same views with `?cloudshadows=off`, wind stopped | The shadow map, the cloud density, the sun, or the balance of the lights |

Every tool checks the renderer's `adapterInfo` and refuses to report a number
for a software device. Every one prints its findings and writes them as JSON
under its output directory. None of them approximates the other: a cadence run
says nothing about GPU headroom, a GPU pass time says nothing about displayed
frames, and a recording perturbs both.

## When a number counts

- **Fixed camera paths, warmup, then sampling.** Every path starts from a known
  pose and runs a warmup before its sample window, so first-frame compilation
  and cache filling are not in the sample.
- **At least three trials, alternating variants.** Run A/B/A/B/A when drift is
  plausible, and compare distributions, not single values. A median near one
  refresh interval can coexist with frequent misses; look at the tail and the
  fraction over 20 ms too.
- **GPU-timestamp runs and ordinary-cadence runs are kept separate.** Timestamp
  capture and readback change cadence, and a cadence run has no GPU numbers at
  all. Never add a pass total to an FPS figure, and never call a cadence run
  evidence of headroom.
- **Check which adapter actually rendered.** Hardware identity comes from the
  renderer's device, not from a `requestAdapter()` preflight, and a software
  adapter renders everything at a speed that measures nothing.
- **Hash the source before and after each run.** If any served file changed
  during the run, the run is invalid and the tools say so.
- **Check what the server is serving, not only what is on disk.** The hash is
  of the files; the dev server can keep serving a module it missed a change
  to. Swapping source with `git stash` under a running Vite did exactly that
  once, and a whole round of shots rendered the old clouds. After swapping
  source for an A/B, fetch the module from the server (`curl
  http://127.0.0.1:5173/@fs/<absolute path>`) and check it is the version you
  meant, or restart the server.
- **CPU tests see no GPU work.** Passing `pnpm test` is a precondition, never
  evidence about a shader or a frame.

Headless Chromium can do the measuring, but only through the full browser:
Playwright's default headless shell has no GPU process and therefore no
WebGPU. The scripts launch with `channel: 'chromium'` and WebGPU flags for
this reason. Recording, encoding and bitmap readback all perturb playback, so
captures are visual evidence and none of them is a performance run.

## Commands

From `apps/hills`, with a server already running:

```sh
# Fixed views into ./shots/
node scripts/shoot.mjs --label before --url http://127.0.0.1:5173/

# GPU-timed runs along the fixed paths
node scripts/benchmark.mjs --label sky-before --mode timed \
  --cases sky,skyturn,skywalk,zenith,seam,sun
# Ordinary cadence, no timestamps
node scripts/benchmark.mjs --label sky-ordinary --mode cadence \
  --cases idle,walk,turn,skywalk,skyturn

# Motion captures
node scripts/record-motion.mjs --path stress --label wind-12
node scripts/record-motion.mjs --path seam --label seam-before

# The three sweeps
node scripts/measure-sky.mjs --label sky-071
node scripts/measure-lawn-hue.mjs --label hue-92
node scripts/measure-lawn-coverage.mjs --label blades-055-0105

# The cloud look, and the shadows it casts
node scripts/measure-clouds.mjs --label clouds-before
node scripts/measure-cloud-shadows.mjs --label shadows-before
# ...and what a real sky measures (see "Reference photographs" below)
node scripts/measure-photos.mjs --label cumulus ~/cloud-photos/*.jpg

# The shadow march only runs when a map is re-marched; a fast wind makes that
# every five seconds, so a sample catches it
node scripts/benchmark.mjs --label shadow-march --mode timed --cases idle \
  --sample 20000 --url 'http://127.0.0.1:5173/?cloudwind=100'
```

Each writes under `apps/hills/measurements/<label>/` unless `--out` says
otherwise. Query options can be appended to `--url` directly, for example
`--url 'http://127.0.0.1:5173/?ui=0&cloudquality=balanced&underlay=solid'`;
tools that need a specific control add it themselves and say so in their
output.

## First hills numbers

Measured 2026-09-18 with the tools above, on an integrated laptop GPU at
1920x1080 (the sweeps at 1280x720), **one trial each**. By the rules above a
single trial is an indication and not a result, so treat these as the current
reference points to re-measure, not as acceptance evidence. They replace the
earlier building-scene figures, which are no longer the reference.

- Timed ground paths (idle, walk, turn): about 44 FPS with GPU p95
  21.2-23.1 ms and cloud compute 3.3 ms median. The sky paths hold 60 FPS with
  GPU p95 9.4-14.1 ms and cloud compute 1.4-1.6 ms.
- Ordinary cadence, no timestamps: the same ground paths about 41-44 FPS; the
  sky paths 59.7 FPS.
- Bare ground, at the demo's own blade size (0.65 of the preset's height and
  width): 59.5% at 2-3 m, 57.2% at 3-4 m, 77.2% at 6-8 m, 80.3% at 8-12 m,
  97.3% at 16-24 m and 99.9% past 24 m. The far ring is still not grass. The
  preset's own figures, in the `canopyProxyFrom` comment, are for full-size
  blades and are lower near the camera; compare like with like.
- Rendered lawn hue, at the demo's default dials: mean 99.2 over six bands,
  drifting +5.1 degrees from near to far, at the palette target of 92. The
  target was swept to land 99 over flat ground at the preset's blade size;
  a degree and a half on a different framing is not a reason to move it. It
  read 100.4 until the sky light began following the clouds (2026-09-20, two
  alternating runs of each); that light is now weather-dependent, and the
  same lawn reads 95.3 and 36% brighter at the sky's default coverage of
  0.48. Sweep this at the demo's coverage, which is what the constant is
  calibrated at.
- Sky exposure: the fully fogged band reads 0.6077 against the flat control's
  0.6080 at `skyexposure=7.1`, so the exposure still holds the far band.
- The 1920x1080 / 60 FPS target is not met on the ground paths. The next
  day the same code held about 59 FPS; see the breakdown below for why a
  single day's figure is not the answer.

The numbers move with the dials -- blade height and width, tillering, ring
density, the palette, the haze -- so report what a re-run lands on; do not
silently change a constant to match an older number.

## Where a ground-view frame goes

Measured 2026-09-19 with `benchmark.mjs --mode timed`, on the same integrated
laptop GPU at 1920x1080, 3 s warmup and 8-10 s samples, one variant switched
at a time. The multisampling rows are three alternating trials each; every
other row is one trial. Numbers are GPU pass time per frame, render plus
compute, median.

| Variant | Walk | Change |
| --- | ---: | ---: |
| Baseline (4x MSAA, balanced clouds) | 15.9-16.1 ms | -- |
| `?msaa=off` | 11.3-11.4 ms | -4.6 ms |
| 1440x810 canvas instead of 1920x1080 | 11.5 ms | -4.6 ms |
| `?tillers=2` instead of 4 | 12.2 ms | -3.9 ms |
| `?sky=flat` (no atmosphere, no clouds) | 12.8 ms | -3.3 ms |
| `?underlay=solid` (no PBR lawn surface) | 13.1 ms | -3.0 ms |
| `?clouds=off` | 13.7 ms | -2.4 ms |
| `?canopylod=0` | 15.8 ms | -0.3 ms |
| `?cloudquality=low` | 16.0 ms | -0.2 ms |
| Blades drawn before the ground | 15.9 ms | 0 |

How to read it:

- **The rows do not add up, and are not meant to.** Take any one piece away
  and the rest runs faster, because an integrated GPU shares its clock and
  memory bandwidth across everything in the frame: the same cloud compute
  pass measures 1.3 ms in a light frame, 2.0 ms in the baseline and 3.3 ms in
  the hotter run of the day before. Each row is what that one change buys.
- **Multisampling is the largest single cost**, and it stays on: without it
  the lawn's blades, a pixel or two wide past a few metres, turn to grain that
  crawls with the camera. `?msaa=off` is the lever for frame rate.
- **Most of the rest is proportional to pixels**, which the smaller canvas
  shows: the lawn surface, the blades' fragments and the multisampled
  targets all scale with it.
- **The cloud pass is not bound by its texel count in a ground view.**
  `cloudquality=low` updates half the texels per frame and buys almost
  nothing.
- **The ground's cost is its own texture work, not overdraw.** Drawing the
  blades first, so that ground hidden behind them is rejected early, changes
  nothing.
- **Compare only inside one session.** The same code measured about 44 FPS
  (GPU median 17.3-18.3 ms) on 2026-09-18 and about 59 FPS (16.0 ms) on
  2026-09-19. Clock and thermal state move a frame more than most changes
  do, which is why the rules above ask for alternating trials.

## Reference photographs

The cloud look is compared against photographs, not only against its own
history. The set is ten fair-weather cumulus photographs from Wikimedia
Commons, downloaded at 1280 px wide; they are not kept here, so fetch them by
title to repeat a measurement:

| Commons file | Licence |
| --- | --- |
| Cumulus clouds in fair weather.jpeg | CC BY-SA 2.0 |
| 2021-06-28 11 44 42 Cumulus clouds above a field in the Dulles section of Sterling, Loudoun County, Virginia.jpg | CC BY-SA 4.0 |
| 2021-06-28 11 51 55 Cumulus clouds above a field in the Dulles section of Sterling, Loudoun County, Virginia.jpg | CC BY-SA 4.0 |
| Cumulus humilis clouds.jpg | CC BY-SA 3.0 |
| Cumulus humilis.jpg | CC BY-SA 3.0 |
| Fair weather clouds in California.jpg | CC BY 2.0 |
| Cumulus mediocris-1.jpg | CC BY-SA 3.0 |
| Fair weather clouds.jpg | CC BY-SA 4.0 |
| Cumulus humilis Schönwald im Schwarzwald 20180810.jpg | CC BY-SA 4.0 |
| Cumulus Humilis Clouds 41.jpg | CC BY-SA 4.0 |

Pooled through `measure-photos.mjs`: cloud luma 0.62/0.77/0.90 at the
10th/50th/90th percentile, a spread (10th over 90th) of 0.69, and saturation
0.08/0.19 at the 50th/90th. Photograph to photograph the spread runs
0.63-0.85 and the median saturation 0.03-0.15, so a render inside those
ranges is inside what real skies do. Auto-exposure and processing move a
photograph's absolute luma; the spread and the saturation are what to compare.

What the photographs also show and the numbers do not: every cloud in them
has a flat base, grey under a white top, and a distant cloud is a
flat-bottomed lens. The sky has had those since the flat-base change, judged
by eye: the classifier counts a grey base as sky, so the pooled spread moves
by 0.01 at most for it.

Measured 2026-09-19 through the same classifier, at the sky's default coverage
(0.48) and the demo's (0.1):

| Render | Spread, 0.48 | Saturation, 0.48 | Spread, 0.1 | Saturation, 0.1 |
| --- | ---: | ---: | ---: | ---: |
| Before (falloff 0.4, sun march 0.6 km) | 0.77 | 0.07/0.15 | 0.82 | 0.06/0.17 |
| After (falloff 1.2, sun march 1.3 km) | 0.74 | 0.10/0.20 | 0.79 | 0.08/0.19 |

Cloud cover is unchanged by it -- 48.8/77.8/48.7/49.1/18.3/7.6% at 0.48 --
and so is the sky's compute: 0.91-0.96 ms a frame looking at the sky, three
alternating trials of each on an integrated laptop GPU at 1920x1080.

Measured 2026-09-20, the same way, when the ambient a cloud is lit by became
the cloudy sky instead of the clear one (`packages/three/docs/sky-internals.md`,
"The sky a cloud sits in"):

| Render, wind stopped | Spread, 0.48 | Saturation, 0.48 | Spread, 0.1 | Saturation, 0.1 |
| --- | ---: | ---: | ---: | ---: |
| Clear-sky ambient | 0.75 | 0.10/0.20 | 0.80 | 0.10/0.19 |
| Cloudy-sky ambient | 0.72 | 0.11/0.19 | 0.80 | 0.09/0.19 |

Cover is unchanged to a tenth of a point at either coverage. This tool's
`shaded rgb` column cannot show the change, and that is worth knowing before
reading it for one: it is the mean of the darkest 15% of the cloud pixels a
frame has, so a brighter shaded side simply drags a different set of pixels
into the selection. What shows it is the two renders' shots compared pixel for
pixel (`shoot.mjs`, same label pair, the numbers in `sky-internals.md`).

### The demo's hills, and what that does to these numbers

On 2026-09-20 the demo's terrain scale dropped from the terrain piece's 0.7 to
0.5 (`DEMO_HILLS_SCALE` in `apps/hills/src/options.js`): at 0.7 the ridge over
the start point took the lower two thirds of the opening frame. Cover is a
share of the *sky* pixels, so it barely moves -- at coverage 0.48 the six
views read 48.0/76.4/48.2/48.5/18.3/7.4% against 48.8/77.8/48.7/49.1/18.3/7.6%
before, and the pooled spread and saturation are inside their run-to-run
noise. Absolute cover figures dated before that day were taken at `?hills=0.7`
all the same. The lawn sweeps are unaffected: `measure-lawn-hue.mjs` and
`measure-lawn-coverage.mjs` both drive flat ground.

### How far the sun march has to reach

Measured 2026-09-20, `shoot.mjs` at 1920x1080, wind stopped, coverage 0.48,
comparing the six views pixel for pixel. Marching the sun 8 km instead of
1.3 km changes **nothing** at the demo's 49-degree sun: no pixel of the six
views differs by more than one level of 255. At an 8-degree sun the same
change moves 13-37% of the pixels, by up to 149 levels: the sun's path
through the cloud layer is 1.7 km at 49 degrees but 9.3 km at 8, so a low sun
is where clouds shadow each other at a distance, and where a longer march is
the whole difference between a modelled bank of cloud and an evenly lit haze.

This is the measurement to repeat before building anything that buys reach --
a voxel light grid, a cached far-light volume -- because at the sun the demo
ships with, reach is not what is missing. Timed the same day with
`benchmark.mjs --mode timed`, three alternating trials of the sky path: at 49
degrees, where the march stays at six segments, 1.29-1.45 ms against
1.27-1.42 ms, indistinguishable; at 8 degrees, where it takes eight,
1.31-1.40 ms against 1.38-1.54 ms. A version that instead set one loop's
bound from the sun rendered the identical image and cost 1.54-1.59 ms against
1.33-1.46 ms: worth knowing before writing a loop whose count is a uniform.

## Cloud shadows

Measured 2026-09-19, later the same day, on the same GPU at 1920x1080 with
`benchmark.mjs --mode timed`, 3 s warmup and 10 s samples. The baseline
frame was faster than in the table above -- about 10.8 ms walking, 60 FPS
held -- so these numbers compare only with each other.

| Variant, three alternating trials each | Walk | Turn |
| --- | ---: | ---: |
| `?cloudshadows=off` | 10.77-10.87 ms | 10.95-11.14 ms |
| Cloud shadows (the default) | 10.91-10.95 ms | 10.95-11.18 ms |

About 0.1 ms walking and nothing measurable turning: the lookup is one texture
read where the lawn is drawn. A first version worked the projection out per
pixel and cost 0.2-0.3 ms. The march runs only when a map is re-marched --
every 40 seconds or so at 12 m/s, two minutes at the demo's 4 m/s, over 64 frames -- at 0.053 ms in
each of those frames (p95 0.058, measured with the wind at 100 m/s), about
3.4 ms for a whole map.

`measure-cloud-shadows.mjs` at the start point, wind stopped, at the coverage
the demo then ran at (0.48): 96-100% of the lawn in the five views that show
it is shaded, at 0.22-0.28 of its sunlit
luminance, with at most 1% in a shadow's edge. The start point is under a large
cloud region at the default seed, so every fixed view looks at shade. This is
where the demo's clouds were, not a fault; `packages/three/docs/sky-internals.md`
has the check that the shadow and the sky agree. At the demo's present
coverage (0.1, with coverage below the default thinning every region) no lawn
in the six fixed views is shaded at the start of the clock, and a read-back of
the shadow map shades 17% of the ground around the start, against 49% at
0.48. The lawn hue and coverage
sweeps turn the shadows off, so their numbers above are unchanged by them.
