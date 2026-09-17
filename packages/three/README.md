# @detoix/three-pieces

Three.js WebGPU pieces, usable on their own or together:

| Import | What it is |
| --- | --- |
| [`@detoix/three-pieces/sky`](docs/sky.md) | A physical atmosphere with volumetric clouds, a background and fog node, and a lighting probe |
| [`@detoix/three-pieces/grass`](docs/grass.md) | A GPU-driven lawn: persistent storage, compute placement and culling, indirect LOD draws, a matching ground surface, and the lawn areas it reads from a loaded model |
| [`@detoix/three-pieces/terrain`](docs/terrain.md) | Unbounded procedural hills and a camera-following ground grid |

Each entry point depends on Three.js and on files inside its own directory, and
on nothing else. Sky does not need grass, grass does not need terrain, and a
host can use any one of them alone. Grass understands two kinds of ground: a
procedural height function, which is what terrain provides, or surfaces read out
of a loaded model. Neither is required to use it.

## Reading the comments

These modules carry their calibration in comments: why a number is what it is,
and what it was measured against. Two conventions there. A `?dial=` names a URL
parameter of the demo in `apps/hills`, which exposes these options for A/B
comparison -- the package itself reads plain option objects. And "measured"
means measured off a render on real hardware, mostly at 1280x720 on an
integrated GPU; the sweeps themselves live in the repository this code grew up
in, which is a plant generator rather than a renderer.

## Requirements

An initialized **Three.js 0.185.0 WebGPU renderer**, with compute, storage and
indirect drawing. There is no WebGL fallback: "vanilla Three.js" here means the
WebGPU renderer rather than React, not WebGL support. Three.js is a peer
dependency and must resolve to a single installation across host and package.

The host owns the renderer, scene, camera, lights and frame loop. These modules
own their own GPU resources and release them from `dispose()`.

## Status

Published from source: the package ships `src/` and is consumed as ES modules by
a bundler. npm publishing, shadcn-style source-copy installation and React Three
Fiber adapters are not done yet. The public entry points are settled enough to
build against; everything reached through a deeper path may move.

## Licence

MIT. The bundled lawn textures are CC0 from ambientCG; provenance, hashes and
the commands that produced the runtime derivatives are in
`src/grass/assets/grass004/README.md`.
