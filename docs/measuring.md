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
| `measure-sky.mjs` | Rendered sky radiance and the fully fogged far band's luminance, with the instrument eye raised so the band is resolvable | `SKY_EXPOSURE`, the sun, the medium or the tone mapper move |
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
- Bare ground: 59.5% at 2-3 m, 57.2% at 3-4 m, 77.2% at 6-8 m, 97.3% at
  16-24 m and 100% past 24 m. The far ring is still not grass.
- Rendered lawn hue: mean 100.4 over six bands, drifting +5.1 degrees from
  near to far, at the shipped palette target of 92.
- Sky exposure: the fully fogged band reads 0.6077 against the flat control's
  0.6080 at `skyexposure=7.1`, so the exposure still holds the far band.
- The 1920x1080 / 60 FPS target is not met on the ground paths.

The numbers move with the dials -- blade height and width, tillering, ring
density, the palette, the haze -- so report what a re-run lands on; do not
silently change a constant to match an older number.
