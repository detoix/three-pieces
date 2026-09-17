# Hills demo

The lawn, the terrain and the sky together, with no building and nothing else:
what `@detoix/three-pieces` looks like on its own. It uses only the package's public entry
points, so it doubles as the integration example.

```sh
pnpm --filter hills dev
```

What this app owns rather than the package: the URL dials (`src/options.js`),
the walking controls (`src/walk-controls.js`), the WebGPU capability gate, the
page and its CSS. What the package owns: the sky and its lights, the lawn
surface and blades, the hills function and the ground grid.

Two things worth knowing if you fork it. The ground mesh is a flat grid that the
lawn surface displaces on the GPU, so it must keep a pure-translation transform,
and `ground.follow(camera)` must run before each render. The camera is passed to
`sky.update(seconds, camera.position)`, which is what keeps the clouds correct
however far you walk.
