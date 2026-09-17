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
`?underlay=solid`, `?lawnhue=`, `?bladeheight=`. They are read in
`apps/hills/src/options.js`, which is demo code rather than package API.

## Why a monorepo

One version, one changelog and one place to look, with the pieces kept
independent behind separate entry points -- the shape drei uses for its
components. New Three.js work arrives as another entry point here rather than
as another repository.

## Licence

MIT, except the CC0 lawn textures noted in the package README.
