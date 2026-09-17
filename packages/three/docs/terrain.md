# Terrain

`@detoix/three-pieces/terrain` is the unbounded ground the lawn and sky demo stands on. It
is not required by either of the other two: grass takes any height function or
height texture, and the sky does not know the ground exists.

## One formula, two evaluators

A walker's eye, a test and the GPU must agree on one surface, and a scalar
function with a hand-written shader twin is two copies that drift. So the hills
are written once against a small arithmetic interface. `SCALAR_OPS` runs it on
numbers; `hillsNodeOps(THREE.TSL)` builds the same expression as shader nodes.
Only f32 against f64 separates the two.

```js
import * as THREE from 'three/webgpu';
import { createHillsHeightNode, hillsHeightAt, hillsHeightBounds } from '@detoix/three-pieces/terrain';

const scale = 0.7;                                   // vertical scale in metres
const heightAt = createHillsHeightNode(THREE.TSL, scale);   // for the GPU
const eye = hillsHeightAt(camera.position.x, camera.position.z, scale) + 1.7;
const bounds = hillsHeightBounds(scale);             // exact, for height packing
```

The shape is a domain-warped sum of rotated sine-cosine products: no hash, no
texture and no lookup, so it has no edge, no tile and no precision cliff at any
distance a person walks. Each octave's product lies in [-1, 1], so
`hillsHeightBounds()` is exact rather than sampled -- which is what the grass
needs for `packingMinimum` / `packingRange`. At the default scale the median
slope is 10 degrees and the steepest is 30.

## The ground mesh

`createHillsGroundMesh(THREE, { material, radius, segments, innerSpacing, heightBounds })`
returns a flat XZ grid for a displaced lawn surface (`createLawnSurface({ heightAt })`),
which lifts it onto the hills in the vertex stage. Cells grow with distance --
half a metre under the grass, tens of metres at the horizon -- so one mesh
covers both without the seams nested rings would need skirts to hide.

Call `follow(camera)` before each render: the mesh is re-centred on the camera,
snapped to `innerSpacing` so its vertices do not swim. Its frustum culling is
off, because the CPU never sees the displaced surface. `dispose()` releases the
geometry and not the borrowed material.
