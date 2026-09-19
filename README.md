# three-pieces

Three.js things, in one place: a package of WebGPU pieces and the demos that
show them off. Each piece stands alone; nothing here is a framework.

```
packages/three   @detoix/three-pieces — sky, grass and terrain (see its README)
apps/hills       the demo: unbounded lawn and hills under a physical sky
```

```sh
pnpm install
pnpm dev     # the hills demo on http://127.0.0.1:5173
pnpm test    # node --test across the workspace
```

The demo needs a WebGPU-capable browser on localhost or HTTPS. Walk with
**WASD**, look with the mouse, hold **Shift** to run, **Esc** to release the
pointer; on touch, the left half of the screen walks and the right half looks.
There is no edge to the lawn, the hills or the sky.

## Demo dials

`?ui=0` hides the overlay for recording. `hills` is the vertical scale of the
terrain (0 is flat), `eye` the eye height in metres, `walk` and `run` the
speeds, `x`/`z`/`heading` the starting framing, `hazenear`/`hazefar` the haze
band. The package's own A/B dials also apply, for example `?sunelevation=16`
for a low sun, `?clouds=off`, `?sky=flat`, `?backlight=off`, `?canopy=0`,
`?underlay=solid`, `?lawnhue=`, `?bladeheight=`, `?cloudshadows=off`, which
takes the clouds' shadows off the lawn and the hills, and `?msaa=off`, which
trades the lawn's edge smoothing for about a quarter of the ground-view frame
time. They are read in `apps/hills/src/options.js`, which is demo code rather
than package API.

## Docs

`packages/three/docs/` holds each piece's public API and design record:
[sky](packages/three/docs/sky.md) and
[sky internals](packages/three/docs/sky-internals.md),
[grass](packages/three/docs/grass.md) and
[grass internals](packages/three/docs/grass-internals.md), and
[terrain](packages/three/docs/terrain.md). `docs/` at the root has the
[roadmap](docs/roadmap.md) and [how to measure](docs/measuring.md).

## Why a monorepo

One version, one changelog and one place to look, with the pieces kept
independent behind separate entry points -- the shape drei uses for its
components. New Three.js work arrives as another entry point here rather than
as another repository.

## Licence

MIT, except the CC0 lawn textures noted in the package README.
