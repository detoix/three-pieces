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
| `benchmark.mjs` | GPU pass time and frame cadence along fixed camera paths, with or without timestamp instrumentation | Any change to shaders, quality, density, or render scheduling |
| `record-motion.mjs` | 10-second WebM captures of fixed motion paths (static, turn/walk stress, seam, zenith) | Any change to the angular cache, wind handling, culling or LOD that should be reviewed in motion |
| `measure-sky.mjs` | Rendered sky radiance and the fully fogged far band's luminance | `SKY_EXPOSURE`, the sun, the medium or the tone mapper move |
| `measure-lawn-hue.mjs` | Rendered hue, saturation and luminance over six depth bands | The underlay, occlusion, lights, palette or blade coverage move (these interact, so re-sweep together) |
| `measure-lawn-coverage.mjs` | Fraction of bare ground by distance, with the underlay painted emissive | Blade height, blade width, tillering or ring density move |

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
```

Each writes under `apps/hills/measurements/<label>/` unless `--out` says
otherwise. Query options can be appended to `--url` directly, for example
`--url 'http://127.0.0.1:5173/?ui=0&cloudquality=balanced&underlay=solid'`;
tools that need a specific control add it themselves and say so in their
output.

## Last known numbers

These were measured in an earlier scene that had a building and a different
haze range, on an integrated laptop GPU. They are kept only until the hills
demo has been measured with the tools above; replace them, do not cite them as
current.

- Sky, balanced clouds, full scene: ordinary-schedule walking about 57.6 FPS,
  turning about 56.3 FPS, with 3.8-6.0% of intervals over 20 ms. Timed runs put
  full-scene GPU p95 at 19.7-20.5 ms and selected cloud compute at about
  2.3 ms median. The 1920x1080 / 60 FPS target was not met.
- Grass in the same scene: idle, walking and turning averaged about 59.9,
  57.8 and 59.8 FPS; GPU p95 stayed at or under 16.8 ms except walking, which
  is the case that missed frames.
- Bare ground on the measured coverage curve: about 40% at 3-4 m, 65% at
  6-8 m, 95% at 16-24 m, and over 99% past 24 m, which is why the far field is
  the underlay.
- Rendered lawn hue: about 99 at the current palette target, against the
  reference photograph's 99; the far field held hue across depth once the
  canopy proxy landed.
- Sky exposure: 7.1 is the value at which the fully fogged far band kept the
  luminance of the flat `#b8c9b5` control (about 0.608).

The hills haze runs 90-1100 m against the earlier scene's narrower band, and
the terrain and framing differ, so a re-run can land on different numbers.
Report them; do not silently change constants to match the old ones.
