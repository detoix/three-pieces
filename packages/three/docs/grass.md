# Independent grass API

Import from `@detoix/three-pieces/grass`; `src/grass/index.d.ts` describes its public types. There is no React Three Fiber adapter yet. Rendering depends only on Three.js and modules/assets inside `grass-webgpu/`. Walking controls, terrain generation and authored turf discovery belong to the host.

The current target is an **initialized Three.js 0.185.0 WebGPU renderer**, with compute, storage/indirect drawing and readback support. There is no WebGL fallback. Coordinates use **metres, +Y up**, with terrain in the XZ plane. Keep the grass group's world transform at identity. Use a perspective camera and update its projection/world matrices before calling `grass.update(camera)` and rendering. Each grass instance maintains one current camera visibility list; update again before rendering a different camera.

## Two-stage composition

`await createLawnSurface({ renderer, ... })` creates shared grass/ground shading and loads bundled PBR textures unless supplied. `createGrass({ renderer, heightMap, surface, ... })` creates the blade group and compute resources. The host adds `grass.group` to its scene and assigns `grass.groundMaterial` to its own terrain meshes. Use the same palette and matching projected-canopy settings for both stages.

```js
import * as THREE from 'three/webgpu';
import { createGrass, createLawnSurface, lawnColorsFor } from '@detoix/three-pieces/grass';

// The host has created renderer, scene, lights and a PerspectiveCamera.
await renderer.init();
camera.coordinateSystem = renderer.coordinateSystem;
camera.updateProjectionMatrix();
const greens = lawnColorsFor(92);
const surface = await createLawnSurface({ renderer, greens });
const texture = new THREE.DataTexture(
  new Uint16Array(4), 2, 2, THREE.RedFormat, THREE.HalfFloatType,
);
texture.minFilter = texture.magFilter = THREE.LinearFilter;
texture.needsUpdate = true;
const heightMap = {
  texture, extent: 20, minimum: 0, scale: 1, texelWorldSize: 40,
  packingMinimum: 0, packingRange: 1,
};
const keepAt = THREE.TSL.Fn(([xz]) =>
  xz.x.abs().lessThanEqual(20).and(xz.y.abs().lessThanEqual(20)));
const grass = createGrass({ renderer, heightMap, surface, greens, keepAt });
const geometry = new THREE.PlaneGeometry(40, 40);
geometry.rotateX(-Math.PI / 2);
const ground = new THREE.Mesh(geometry, grass.groundMaterial);
ground.receiveShadow = true;
scene.add(ground, grass.group);

function renderFrame() { // Call from the host's frame loop.
  camera.updateMatrixWorld(true);
  grass.update(camera);
  renderer.render(scene, camera);
}
function disposeLawn() { // Stop invoking renderFrame first.
  scene.remove(ground, grass.group);
  grass.dispose();
  surface.dispose();
  texture.dispose();
  geometry.dispose();
}
```

## Terrain and coverage contract

`heightMap` takes one of two forms. The **texture form** below covers a centred square and clamps outside it. The **function form** has no edge, for unbounded or camera-following terrain: `{ heightAt, normalStep, packingMinimum, packingRange }`, where `heightAt(worldXZNode) → floatNode` is a TSL function evaluated in the placement compute pass (once per placed crown, plus four samples `normalStep` metres apart for its normal), and the packing interval must contain every height it returns. Passing both `heightAt` and `texture` is rejected. `hills.html` uses the function form.

For matching ground, give `createLawnSurface` the same function as `heightAt`. Both ground materials then lift a flat XZ grid onto it in the vertex stage and shade with its slope (`groundNormalStep`, default 0.25 m). The ground mesh's transform must be a pure translation, and its CPU bounds cannot see the displacement, so disable its frustum culling or give it bounds that hold the heights. `surface.displaced` reports which kind of surface was built. Without `heightAt`, both materials are the same flat ones as before.

All descriptor numbers must be finite. The height texture must support filtering and red-channel sampling in compute, use linear data with no color-space conversion, and be uploaded before use. The bundled examples use `RedFormat` / `HalfFloatType`.

| Field | Meaning |
| --- | --- |
| `texture` | Host-owned GPU height texture; grass does not dispose it |
| `extent` | Positive half-width of a square centered at world XZ origin; UV is `clamp(worldXZ / (2 * extent) + 0.5, 0, 1)` |
| `minimum`, `scale` | Height in metres is `sample.r * scale + minimum` |
| `texelWorldSize` | Positive world distance used for normal finite differences; match the source height-map spacing |
| `packingMinimum`, `packingRange` | Crown-height packing interval; range must be positive and contain every decoded height |

`keepAt(worldXZNode) → booleanNode` is an optional TSL function evaluated during culling, not a JavaScript predicate evaluated per blade. To build one from surfaces in a loaded model, see [Growing on a loaded model](#growing-on-a-loaded-model). The host owns its textures/uniforms. Without it, grass can grow throughout the fixed rings, including beyond the height texture's domain where sampling clamps to its edge. Optional `coverageBounds` supplies a conservative union of XZ rectangles for coarse rejection; it does not itself mask grass. Optional `groundBounds` must conservatively bound decoded heights.

Call `invalidateCulling()` after changing mask uniforms or coverage bounds. Terrain samples and surface appearance are cached during placement: recreate grass after changing those inputs. Construction options are not live controls; changing the supplied objects does not consistently update an existing instance.

## Options and diagnostics

`createGrass` exposes physical `size`, `bend`, `posture`, `tillers`, `minBladePixels`, `canopy`, `heightCorrelation`, `greens`, `shadows` and `backlight`, plus `coarseCulling`, `cullHysteresis`, `subgroupCulling`, `poseCache`, `projectedCanopy` and `diffuseOnly`. See the declarations for their exact structures. Defaults describe the current maintained lawn. Every tuning option is optional, but a supplied one is checked before allocation: flags must be booleans, `backlight` a boolean or `'blade'`/`'view'`/`'off'`, `tillers` a whole number of at least 1, nested objects complete with finite numbers, `size` positive and ordered, `heightCorrelation` finite and non-negative, and `greens` four colors plus a three-channel non-negative `groundTint`. Malformed values throw `TypeError`; out-of-range values throw `RangeError`. Physical limits such as the clump-pull margin and canopy-pull ceiling remain enforced. `GRASS_RINGS` fixes its four allocation/LOD ranges; exported `LAWN` fields are authored defaults, not a runtime density/radius configuration.

Surface options include `underlay`, `textures`, `ownTextures`, `greens`, `flatten`, `macroTint`, `proxy`, `projectedProxy`, `proxyBladeWidth`, `groundAO`, `grainStrength`, `variation` and `backlight`. `surface.setMode('solid' | 'lawn')` changes its selected material. Existing meshes retain their material until the host reassigns `mesh.material = grass.groundMaterial`. Surface TSL helpers form a shared shading contract; advanced custom surfaces must supply the `GrassSurface` interface.

`stats()` returns the **same live diagnostic object**, including a live visible-count `Uint32Array`; treat both as read-only. It is cheap enough for a per-frame HUD. `snapshotStats()` returns a deep-frozen copy for keeping — `storage` copied, `visible` as a plain array — which later updates and readbacks do not change; it remains callable after disposal and returns the last values. Capacities and byte counts are estimates, not measured total VRAM. `sampleVisibleCounts()` explicitly reads GPU draw counts after the first update; `visible` and `triangles` otherwise remain stale. It returns false while another readback is pending or after disposal, and rejects active renderer/readback failures. Readback can affect performance, so it is not required every frame. `surface.stats` describes the bundled asset sizes even when custom textures are supplied.

The entry point also exports `LAWN_UNDERLAY`, `normalizeLawnUnderlay`, `LAWN_COLORS`, `LAWN_TARGET_HUE`, `lawnColorsFor`, `CANOPY_PULL_MAX`, `CLUMP_PULL_MARGIN`, `GRASS_BACKLIGHT` and `normalizeBacklight`. Backlight normalization selects `off` for false/`'off'`, `view` for `'view'`, and `blade` otherwise. The exported `canopy` constant is an internal aggregate lighting mode, not a separate normalized blade mode.

## Ownership and remaining limits

Grass borrows the renderer, height map, surface and mask. Its idempotent `dispose()` releases blade materials, geometry, storage, compute and readback resources; detach its group first. `disposed` becomes true, `update()` and `invalidateCulling()` become no-ops, and pending readbacks release results without updating diagnostics. It does not remove host objects or stop the host's loop.

**A surface owns its materials, and by default its PBR textures, including caller-supplied textures.** Supplied textures are configured in place (color space, wrapping, filtering, anisotropy, name) and disposed by `surface.dispose()`. Pass `ownTextures: false` with `textures` to keep them host-owned: the surface still releases its own materials, and the host disposes the textures after every surface using them has been disposed. `surface.ownsTextures` reports which applies. `ownTextures: false` without `textures` is rejected before loading, because bundled maps a surface loads itself are always owned. Borrowing surfaces configure the same texture objects identically, so sharing them does not change their settings. Dispose grass and detach ground materials before disposing the surface; retain borrowed height/mask resources until their consumers are finished. `loadLawnPBRTextures()` alone returns caller-owned textures; a failed batch releases any successfully loaded sibling texture.

The host handles cancellation around asynchronous surface creation: if its scene is removed while loading, dispose the returned surface instead of attaching it. There is no built-in abort signal, animation/weather API or automatic performance policy. The r185 storage/readback compatibility workarounds and browser GPU behavior require retesting before a Three.js upgrade. Package distribution and R3F work are tracked in the repository's [docs/roadmap.md](../../../docs/roadmap.md).

## Growing on a loaded model

The lawn can grow on surfaces of a model somebody exported instead of on
procedural ground. Grass has no opinion about where it may grow: it fills the
fixed rings around the camera unless it is given a `keepAt` mask. These four
functions build that mask out of a loaded scene, so the lawn can be dropped onto
a building, a garden or a park rather than an open field.

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  createFlatHeightMap, createGrass, createLawnMask, createLawnSurface, readLawnAreas,
} from '@detoix/three-pieces/grass';

const gltf = await new GLTFLoader().loadAsync('/site.glb');
const areas = readLawnAreas(gltf.scene);                 // the authored tag
const mask = createLawnMask(areas);                      // owns a coverage texture
const heightMap = createFlatHeightMap(areas.elevation); // flat, at that height

const surface = await createLawnSurface({ renderer });
const grass = createGrass({ renderer, heightMap, surface, keepAt: mask.keepAt });
for (const mesh of areas.meshes) mesh.material = grass.groundMaterial;
scene.add(gltf.scene, grass.group);
```

Dispose in the order they borrow each other: `grass`, then `mask`, then
`surface` and `heightMap.texture`.

### Choosing the surfaces

`readLawnAreas(root, { select })` takes any convention. `select(object)`
returns an id string, `true` to use the object's name, or a falsy value to skip
it. It may also throw, which is how a selector rejects a tag it recognises but
cannot read, instead of silently growing no grass.

```js
readTurfRegions(scene, { select: (o) => o.name.startsWith('Lawn') });
readTurfRegions(scene, { select: (o) => o.userData.material === 'grass' && o.name });
```

The default is `landscapeLawnTag`, which reads `userData.landscape` --
`{ version: 1, id, role }` -- from a glTF node's `extras`, accepting `lawn` or its
older spelling `turf`. That is the convention this project's authoring side
writes; nothing else depends on it.

Every id must be unique, and each selected object must contain at least one
mesh. Both are errors rather than warnings: a duplicate id means the export is
ambiguous about which surface is which, and an empty selection means the model
changed under a selector that still matches its name.

### What version 1 accepts

**Static, horizontal surfaces at one elevation.** Skinned and instanced meshes,
non-triangulated geometry, non-finite coordinates and any vertex off the shared
height are all rejected, with the elevation held to 0.1 mm.

That narrowness is deliberate. A sloped lawn wants the procedural height
form above (`heightMap.heightAt`) rather than a flat map, and a
stacked lawn -- a roof terrace over a garden -- needs more than one height per
point, which a height map cannot hold. Approximating either would put blades
through the floor somewhere, so they raise an error instead.

### How the mask works

The regions are collected as world-space XZ triangles, wound counter-clockwise.
`createLawnMask` bakes them into a coverage raster, where a texel is 255 when
its whole cell is inside a triangle, 128 when the cell straddles a boundary, and
0 outside. In the culling pass the interior costs one texture fetch; only
boundary texels run exact point-in-triangle tests, over every triangle.

So cost scales with the boundary rather than the area, but it *does* scale with
triangle count: a lawn area of a thousand triangles puts a thousand edge tests
in the shader for every boundary blade. Keep authored areas coarse -- these are
the outlines of lawns, not terrain meshes.

`areas.contains(x, z)` is the same test on the CPU, for walking and for
anything placed outside the shader.
