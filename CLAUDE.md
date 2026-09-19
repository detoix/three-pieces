# Working in this repo

`three-pieces` is a public repo with one package and one demo:

- `packages/three` -- `@detoix/three-pieces`, the sky, grass and terrain
  pieces. Each entry point stands alone and imports nothing from outside its
  directory except Three.js.
- `apps/hills` -- the demo: an unbounded lawn and hills under a physical sky,
  plus the measurement scripts.

Sky and grass are what this repo is for; terrain exists so the lawn can be
unbounded. Answer at the scope asked: a question about the sky should not
become an inventory of the terrain, the demo or a screenshot tool. The README
covers the layout and the demo dials; `packages/three/README.md` covers the
package; the API and design docs are in `packages/three/docs/` and `docs/`.

## Run and test

```sh
pnpm install
pnpm dev     # the hills demo on http://127.0.0.1:5173
pnpm test    # node --test across the workspace
```

The demo needs a WebGPU-capable browser on localhost or HTTPS; there is no
WebGL fallback. Three.js is pinned at **0.185.0** and must stay there: the
storage-disposal and readback workarounds depend on r185 internals. `pnpm
test` must stay green after every change.

The user may already be running the demo on 5173. Check before starting your
own server (`ss -ltnp | grep 5173`); if you need one, run the Vite binary
directly on another port, record its PID, and stop exactly that PID when
done. Never pattern-kill (`pkill -f`, `killall`): that has taken down a
server that was not yours.

## The public-repo rules

Committed files carry no machine specifics: no exact GPU model, browser name
or version, display or power details, local paths or usernames. Write "an
integrated laptop GPU" and "a hardware-WebGPU browser" instead. Measurement
outputs are gitignored (`apps/hills/measurements/`, `apps/hills/shots/`);
raw numbers belong in a report or a commit message, always with the
conditions that produced them.

Commits are one per step, in this repo's style: an imperative subject and a
body that explains why. Do not rewrite published history. Do not push
without asking. Do not delete anything outside this repo.

Keep the comment culture: comments carry calibrations and the reasons for
numbers. When rewriting a comment, keep the measured values and the
reasoning; re-word the references rather than deleting the argument. See
"Reading the comments" in `packages/three/README.md`.

## What CPU tests cannot see

`pnpm test` runs `node --test`. It exercises validation, lifecycles, storage
layout, placement and culling contracts, the scalar twins of the shaders and
the palette arithmetic. It **never runs a draw**: no shader output, no GPU
pass time, no frame cadence, no pixel colour. Anything about the rendered
image has to be measured in a hardware-WebGPU browser with the scripts in
`apps/hills/scripts/`. The full procedure and the rules for when a number
counts are in [`docs/measuring.md`](docs/measuring.md).

| Tool | Answers | Re-run when |
| --- | --- | --- |
| `shoot.mjs` | Fixed-view 1080p frames | Any visual change; before/after judging |
| `benchmark.mjs` | GPU pass time (timed) or cadence along nine fixed camera paths | Shaders, quality, density or scheduling change |
| `record-motion.mjs` | 10 s WebM of static/stress/seam/zenith paths | Cache, wind, culling or LOD change |
| `measure-sky.mjs` | Sky directions and the fully fogged far band | `SKY_EXPOSURE`, sun, medium or tone mapper move |
| `measure-lawn-hue.mjs` | Hue/saturation/luminance over six depth bands | Underlay, occlusion, lights, palette or coverage move |
| `measure-lawn-coverage.mjs` | Bare ground by distance | Blade height, width, tillering or ring density move |
| `measure-clouds.mjs` | Cloud cover, luma spread and shaded colour over the six fixed views | Cloud density, march or lighting move |
| `measure-cloud-shadows.mjs` | How much lawn is shaded and how dark, against `?cloudshadows=off` | The shadow map, cloud density, sun or light balance move |
| `measure-photos.mjs` | The same luma spread and saturation for photographs | The reference set in `docs/measuring.md` changes |

Rules that make a number count: warmup before each sample, at least three
trials with variants alternated, timestamp and cadence runs kept separate,
the adapter checked from the renderer's own device, the source hashed before
and after, and no GPU claims from CPU tests or from a recording.

## Calibrated constants, and what moves them

These are measured, not chosen. Change one only with its sweep re-run
before/after, and record the new number in the constant's comment.

| Constant | Value | Moves when |
| --- | --- | --- |
| `LAWN_TARGET_HUE` (`preset.js`) | 92 | Anything that changes what a lawn pixel is made of: palette, underlay, occlusion, lights, canopy proxy. Sweep with `measure-lawn-hue.mjs`. |
| `SKY_EXPOSURE` (`apps/hills/src/options.js`) | 7.1 | The sun, the medium or the tone mapper. It is the value at which the fully fogged far band matches the flat `#b8c9b5` control; sweep with `measure-sky.mjs`. |
| `minHeight`/`maxHeight` (`preset.js`) | 5.5-10.5 cm | Bare-ground coverage. Sweep with `measure-lawn-coverage.mjs`. |
| `minWidth`/`maxWidth` (`preset.js`) | 4.0-6.5 mm | Bare-ground coverage in the 6-16 m band. Sweep with `measure-lawn-coverage.mjs`. |
| Demo blade size (`apps/hills/src/options.js`, `?bladeheight=`/`?bladewidth=`) | 0.65 of the preset | The demo's mown look; the hills coverage and hue numbers in `docs/measuring.md` are at this size, not the preset's, so compare like with like. |
| `canopyProxyFrom`/`To` (`preset.js`) | 8/26 m | Blade resolvability and the coverage curve; both come from measurements, not taste. |
| `canopyProxyOcclusion` (`preset.js`) | 0.75 | The far field's brightness against photographs; moves if the sun, palette or proxy ramp move. Its comment carries the sweep history. |
| Cloud presets (`clouds.js`) | balanced | Visual softness against cost; each preset's cache sizes are in `packages/three/docs/sky-internals.md`. |
| Cloud look (`cloud-lighting.js`; `EDGE`, `DENSITY_*`, feather and threshold in `clouds.js`) | see the files | `msFalloff` is set against photographs: the render's luma spread and saturation (`measure-clouds.mjs`) beside a real sky's (`measure-photos.mjs`, set in `docs/measuring.md`). The rest keeps the cloud cover while making edges crisp. Re-run both tools and `shoot.mjs` before and after, and time the sky paths. `test/sky-cloud-lighting.test.js` holds the lighting's properties. |
| Cloud shadow map (`CLOUD_SHADOW` in `cloud-shadow.js`) | 256 texels over 5.12 km; re-marched at 0.5 km | The texel is the sun's penumbra; the recentre and jump distances give the 1.56 km reach that `test/sky-cloud-shadow.test.js` checks by simulation. Re-run `measure-cloud-shadows.mjs`, and time the march with `benchmark.mjs` at `?cloudwind=100`. |
| Haze band (`apps/hills/src/options.js`) | 90-1100 m | The demo's framing only; it is a linear ramp, not aerial perspective. |
| `SUN_ANCHOR`/`SKY_ANCHOR` (`lights.js`) | 3.3491/23.947 | Any change to the authored light pair; `test/sky-atmosphere.test.js` holds the anchors to the authored luminances. |

The grass, sky and lighting comments in `preset.js`, `clouds.js`,
`sky-nodes.js` and `lights.js` each carry their own derivation; read the
comment before moving the number. `test/grass-blade-bounds.test.js` and
`test/sky-atmosphere.test.js` hold several bounds that exist only to catch a
moved constant.
