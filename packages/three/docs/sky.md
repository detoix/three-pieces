# Independent sky API

`@detoix/three-pieces/sky` exports `createSky(options)`. Everything it imports is either Three.js or another file in `sky/`; it does not import viewer code, grass, DOM, URL state, controls or scene lighting. This is a local package boundary, not a published npm package. The complete `sky/` directory can be moved together. `index.d.ts` describes the public interface for TypeScript consumers using matching Three.js type definitions.

The implementation is validated against **Three.js 0.185.0** and its WebGPU renderer. Treat that version as the peer dependency when extracting it. The renderer must already be initialized, must support compute/storage textures and readback, and remains owned by the host. There is no WebGL fallback in this API.

A host consumes only this entry point. That entry also exports the pure coordinate helpers `sunDirectionFrom(elevationDegrees, azimuthDegrees)` and `sunAnglesOf([x, y, z])` for aligning host lights. Supply finite degree values and a finite, nonzero direction; +Y is up and azimuth runs from +Z toward +X. The inverse returns azimuth in [-180, 180] degrees. `sky.stats.tables` exposes frozen `{ name, width, height }` diagnostics so consumers do not need internal LUT constants. These dimensions are observations, not configuration knobs. The intended repository and distribution structure is recorded in the repository README.

```js
import * as THREE from 'three/webgpu';
import { createSky } from '@detoix/three-pieces/sky';

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setSize(1920, 1080);
document.body.append(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1920 / 1080, 0.1, 1000);
camera.position.set(0, 1.7, 0);
camera.lookAt(0, 30, -100);
const sky = createSky({
  renderer,
  sunElevation: 45,
  sunAzimuth: 30,
  exposure: 7.1,
  cloudQuality: 'balanced',
  cloudCoverage: 0.48,
});

const probe = await sky.bake();
scene.backgroundNode = sky.backgroundNode;
scene.fogNode = sky.fogNodeFor({ near: 100, far: 170 });
// The host may use probe.sun and probe.sky to drive its own scene lights.
renderer.setAnimationLoop(milliseconds => {
  sky.update(milliseconds / 1000);
  renderer.render(scene, camera);
});

// On teardown:
// renderer.setAnimationLoop(null);
// scene.backgroundNode = null;
// scene.fogNode = null;
// sky.dispose();
// renderer.dispose(); // Only if the host is also finished with the renderer.
```

World coordinates are **+Y up, one scene unit per metre** for cloud parallax. The atmosphere uses a fixed observer height in kilometres. Sun azimuth runs from +Z toward +X. `update` accepts absolute, nonnegative, monotonic **seconds**, not a delta or milliseconds. Call it once before each frame, even if multiple cameras are rendered. Each sky owns an independent cache and clock; the host coordinates a shared renderer.

## Options

Options other than the sun are fixed at construction; make a new instance to change them. Number inputs must be finite numbers; strings are not coerced. Invalid inputs fail before sky resources are allocated. Cloud options are validated even when clouds are disabled.

| Option | Default | Contract |
| --- | --- | --- |
| `renderer` | required | Initialized Three.js WebGPU renderer with compute and readback support |
| `sunElevation` | `45` | Degrees in `[-90, 90]`; daylight ground views are the validated use case |
| `sunAzimuth` | `0` | Degrees, normalized modulo 360 |
| `exposure` | `1` | Nonnegative linear multiplier applied to rendered atmosphere and clouds; excluded from the lighting probe |
| `multiScatter` | `1` | Nonnegative scale for atmospheric multiple scattering |
| `eyeHeightKm` | `0.0017` | Fixed atmosphere eye height in `[0, 100)` km; this range is input validity, not an altitude-rendering guarantee |
| `clouds` | `true` | Boolean; `false` avoids allocating the cloud volume/cache |
| `cloudQuality` | `'balanced'` | `'low'`, `'balanced'` or `'high'`; current resolution and minimum steps are reported in `clouds.stats` |
| `cloudCoverage` | `0.48` | Weather parameter in `[0, 1]`; not a promise that this fraction of the image is cloudy |
| `cloudWindSpeed` | `12` | Drift parameter in `[0, 100]` m/s; the current fixed wind direction also has a smaller +Z component |
| `cloudSeed` | `0x43f6a21d` | Unsigned 32-bit integer; deterministic shape and weather textures |

`exposure: 1` preserves the model's normalized radiance scale. The demo uses `7.1` to fit its scene's authored lighting and tone mapping; this is not a photographic exposure value. The host owns tone mapping, output color space and any conversion of probe values into its light intensities.

## Public surface and lifecycle

- `backgroundNode`: TSL RGB node containing atmospheric radiance, the solar disk and cloud composition. Install it on `scene.backgroundNode` after the first successful bake. Nodes remain owned by the sky; treat them as opaque render inputs.
- `skyRadianceNode(directionNode)`: TSL RGB sampling function for **clear atmospheric radiance** in a world direction, including exposure but excluding the solar disk and clouds. Intended for material composition, not as a complete environment map.
- `fogNodeFor({ near, far })`: creates a TSL fog node with sky-colored linear distance fog. Distances must satisfy `0 <= near < far`. This is an artistic haze approximation, not volumetric aerial perspective or cloud fog.
- `sunDirection`: a frozen `[x, y, z]` snapshot. Set the sun through `setSun`; changing a returned array cannot alter internal uniforms.
- `bake() → Promise<{ sun, sky }>`: initializes atmosphere LUTs, reads the lighting probe and submits complete cloud initialization. Later bakes reuse invariant atmosphere tables. Successful completion makes `ready` true; GPU queue ordering makes initialization available to subsequent rendering. This promise is not a request to idle the entire GPU.
- `setSun(elevationDegrees, azimuthDegrees) → Promise<{ sun, sky }>`: validates the angles and serializes an atmosphere/probe/cloud rebake. It also initializes all LUTs when called before `bake()`. It is intended for occasional sun changes, not per-frame animation.
- `update(seconds, observer?) → boolean`: accepts one frame update when clouds are available. `observer` is the camera's world position in metres (only `x` and `z` are read). When given, each cloud snapshot is marched from where the observer stands as it begins, and parallax is measured from that point, so the sky stays correct however far the camera walks. A new position reaches the display within two cache cycles. With zero wind, snapshots are remarched only after the observer moves 100 m. Omitted, the observer is the world origin, as before. Returns false before a successful bake, while a bake is in progress, after a failed bake, with clouds disabled, or after disposal. True means the update was accepted; zero wind or zero coverage skips incremental compute after initialization. Time must not go backwards between successful bakes. Long clock gaps are currently clamped internally to 0.1 seconds of cloud simulation per update. A successful bake resets the input clock guard.
- `ready` and `disposed`: read-only lifecycle state. Once work begins, `ready` remains false until that operation succeeds. Rendering should begin after awaiting initialization; it need not poll this flag.
- `stats`: frozen snapshot with estimated texture `bytes` and atmosphere LUT `passes` (3). Byte estimates exclude pipelines, driver allocations, probe/readback buffers and retained CPU texture data; this is not measured total VRAM use.
- `clouds`: null when disabled; otherwise a read-only diagnostic facade with a frozen `stats` snapshot. This exposes cache resolution, slices, generation, last update size, cycle duration, texture byte estimate and compute node IDs for timestamp attribution. `steps` is the minimum primary ray-march count; traversal adapts toward `targetStepKm` (currently 0.05 km / 50 m), with a cap of `maxSteps` (currently 256). The cap means long rays can use wider spacing, and early termination can perform fewer samples. These are algorithm settings, not measured executed-step counts. Cycle duration is not GPU execution time. Internal cloud `bake`, `update` and `dispose` methods are not exposed.
- `dispose()`: idempotently releases the owned background node, compute passes, textures and probe resources. The background-node event also lets Three.js release its generated background geometry and material. Detach sky nodes from every scene/material before calling it. It does not modify or dispose the renderer, scene, camera, lights or loop. `update` becomes harmless; new asynchronous operations reject, and work already pending rejects after its current asynchronous step returns.

`bake` and `setSun` form one queue per sky, including the probe readback and cloud initialization. A rejected request does not poison subsequent queued requests. Invalid sun input rejects without changing state. An execution failure leaves cloud frame updates disabled until a later successful rebake; the host should catch errors and decide whether to retry or replace the sky.

**Sun changes are not atomic visual transitions.** Shared uniforms and atlas textures change while the asynchronous operation runs. To avoid displaying an intermediate frame, pause host rendering, await `setSun`, update host-owned lights from its returned probe, then resume. Serialization protects resource and lighting consistency between requests; it does not create a second complete atmosphere for crossfading.

The returned probe contains linear RGB values in normalized model units: above-atmosphere solar irradiance is `[1, 1, 1]`; `sun` is direct irradiance on a surface facing the sun and `sky` is clear-sky irradiance integrated over an upward hemisphere. Neither includes `exposure`. Cloud ground shadows and cloud attenuation of the lighting probe are not implemented. The API makes no assumptions about the host's directional-light or hemisphere-light calibration.

## Scope and extraction limits

Cloud density is ray-marched through a curved layer approximately 1.35–2.65 km above ground and cached in angular radiance/transmittance textures plus extinction-weighted distance textures. Each snapshot uses its sampled distance for a single wind/translation correction. These mean distances improve the estimate but do not store multiple visible cloud layers or resolve disocclusions. The cache supports ground-level views with approximate parallax around the observer a snapshot was marched from. Without an `observer`, that point is the world origin, and clouds visibly stretch beyond about a kilometre from it. Camera rotation does not use screen-space history, but updates still have a finite cadence and blend between cached states. Cloud fly-through, exact depth/parallax, orbital views, scene-cloud intersections, dynamic weather, cloud shadows and night-sky content are outside the implemented scope.

The atmosphere currently fixes the planet, scattering coefficients, ozone profile and ground albedo internally. Its lookup table covers the upper hemisphere, and its fog model is a distance ramp. Moving the camera to another elevation does not rebake atmospheric observer height. These constraints must remain explicit in a future package description.

Three.js r185 currently needs two contained lifecycle compatibility details inside `sky-nodes.js`: releasing probe storage through `renderer._attributes`, and clearing readback mapped state after failure. Both touch implementation details. Keep the peer version pinned and rerun lifecycle plus real-browser GPU validation before upgrading Three.js. The host handles device loss, adapter selection, resizing and quality policy; this API does not silently reduce quality to meet a frame-rate promise.

The r185 renderer attaches its background-mesh cleanup listener only to the first background node used by each scene. Disposing that node releases the generated geometry and material, but later sky replacements in the same retained scene do not receive a new listener. This is a renderer-side lifecycle limit; the sky API does not inspect or mutate the renderer's scene caches.

CPU tests exercise validation, first-use initialization, queue ordering, error recovery, frame-update suppression, static-cloud compute suppression, complete cache-cycle cadence, clock-gap clamping and disposal during both atmosphere and cloud work. A background lifecycle regression uses Three.js's real background manager to verify material/geometry cleanup across multiple scenes. GPU work uses a fake renderer, so these tests do not validate shader output, uniform snapshot alignment or GPU timings. Browser and hardware evidence is documented separately in `docs/sky-rendering.md` and the benchmark reports.
