import * as THREE from 'three/webgpu';
import { createCloudNoiseData, createCloudWeatherData } from './cloud-noise.js';

const { Fn, If, Loop, Break, float, uint, vec2, vec3, vec4, uvec2,
  uniform, instanceIndex, texture, texture3D, storageTexture, mix, atan,
  cameraPosition } = THREE.TSL;

// Kilometres throughout the volume. This is a ground-view renderer: the cache
// is angular, independent of the camera, and is not a cloud fly-through volume.
export const CLOUD_PRESETS = Object.freeze({
  low: Object.freeze({ width: 768, height: 256, steps: 40, slices: 128 }),
  balanced: Object.freeze({ width: 1536, height: 512, steps: 72, slices: 256 }),
  high: Object.freeze({ width: 2048, height: 768, steps: 96, slices: 384 }),
});
const EARTH = 6360;
/** How far a still sky's observer may move before its snapshots are remarched. */
export const OBSERVER_REFRESH_KM = 0.1;
const BASE = 1.35;
const TOP = 2.65;

/** Stable positive root from an eye on the ground to a spherical cloud layer. */
export function cloudLayerDistance(mu, height) {
  const c = height * (2 * EARTH + height);
  return c / (Math.sqrt(EARTH * EARTH * mu * mu + c) + EARTH * mu);
}

/** Polar warp allocates more samples to the horizon; azimuth is periodic. */
export function cloudDirection(u, v) {
  const phi = u * Math.PI * 2;
  const elevation = v * v * Math.PI / 2;
  return [Math.sin(phi) * Math.cos(elevation), Math.sin(elevation), Math.cos(phi) * Math.cos(elevation)];
}

function cacheTexture(width, height, name) {
  const t = new THREE.StorageTexture(width, height);
  t.name = name;
  t.type = THREE.HalfFloatType;
  t.format = THREE.RGBAFormat;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = t.mipmapsAutoUpdate = false;
  return t;
}

/**
 * True volumetric density + Beer integration, cached in sky space. Three maps
 * keep incomplete writes out of the displayed image: blend two complete skies
 * while filling the third. Slow wind needs no screen-space history, so rapid
 * camera rotations do not produce disocclusion trails. Approximate parallax is
 * valid within about a kilometre of the observer a snapshot was marched from,
 * not for aircraft or distant camera teleports.
 *
 * That observer is the origin unless `update()` is given one. Each snapshot
 * then records where the observer stood when it started, marches the same
 * world-fixed clouds from there, and is displayed with parallax relative to
 * that point -- exactly as it records and corrects for its own wind time. A
 * walker is never more than about two cycles from a snapshot's origin, so the
 * sky follows them across any distance. Moved no further than
 * `OBSERVER_REFRESH_KM`, a still sky does no compute at all.
 */
export function createVolumetricClouds({ renderer, sunDirection, exposure,
  quality = 'balanced', coverage = 0.48, windSpeed = 12, seed = 0x43f6a21d,
  skyRadianceNode }) {
  const preset = CLOUD_PRESETS[quality];
  if (!preset) throw new RangeError(`Unknown cloud quality: ${quality}`);
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) throw new RangeError('Cloud coverage must be in [0, 1].');
  if (!Number.isFinite(windSpeed) || windSpeed < 0 || windSpeed > 100) throw new RangeError('Cloud wind speed must be in [0, 100] m/s.');
  const { width, height, steps, slices } = preset;
  const noiseData = createCloudNoiseData({ seed });
  const noise = new THREE.Data3DTexture(noiseData.data, noiseData.width, noiseData.height, noiseData.depth);
  noise.name = 'Periodic cloud shape and erosion';
  noise.format = THREE.RGBAFormat;
  noise.type = THREE.UnsignedByteType;
  noise.minFilter = noise.magFilter = THREE.LinearFilter;
  noise.wrapS = noise.wrapT = noise.wrapR = THREE.RepeatWrapping;
  noise.unpackAlignment = 1;
  noise.needsUpdate = true;
  const weatherData = createCloudWeatherData({ seed });
  const weather = new THREE.DataTexture(weatherData.data, weatherData.width, weatherData.height, THREE.RGBAFormat);
  weather.name = 'Cloud weather coverage';
  weather.minFilter = weather.magFilter = THREE.LinearFilter;
  weather.wrapS = weather.wrapT = THREE.RepeatWrapping;
  weather.needsUpdate = true;
  const shapeNode = texture3D(noise);
  const noiseMeans = [1, 2, 3].map(channel => {
    let total = 0;
    for (let i = channel; i < noiseData.data.length; i += 4) total += noiseData.data[i];
    return total / (noiseData.data.length / 4 * 255);
  });
  const weatherNode = texture(weather);
  const maps = [0, 1, 2].map(i => cacheTexture(width, height, `Cloud radiance + transmittance ${i}`));
  // RGBA16F also for depth keeps filtering/storage portable on baseline WebGPU.
  // Only R is used; this trades memory for a better motion/parallax estimate.
  const depths = [0, 1, 2].map(i => cacheTexture(width, height, `Cloud extinction-weighted distance ${i}`));
  const previous = texture(maps[0]);
  const current = texture(maps[1]);
  const destination = storageTexture(maps[2]);
  const previousDepth = texture(depths[0]);
  const currentDepth = texture(depths[1]);
  const destinationDepth = storageTexture(depths[2]);
  const blend = uniform(0);
  const cacheReady = uniform(0);
  const slice = uniform(0, 'uint');
  const snapshotTime = uniform(0);
  const displayTime = uniform(0);
  const previousTime = uniform(0);
  const currentTime = uniform(0);
  // Observer ground position in kilometres (x, z) for each role, as the times above.
  const snapshotOrigin = uniform(new THREE.Vector2());
  const previousOrigin = uniform(new THREE.Vector2());
  const currentOrigin = uniform(new THREE.Vector2());
  const amount = uniform(coverage);
  const sunColor = uniform(new THREE.Vector3(0.923, 0.830, 0.700));
  const skyColor = uniform(new THREE.Vector3(0.0314, 0.0646, 0.127));

  const densityAt = Fn(([p, detail, footprint]) => {
    const altitude = p.y.add(p.xz.dot(p.xz).div(2 * EARTH));
    const h = altitude.sub(BASE).div(TOP - BASE).toVar();
    const density = float(0).toVar();
    If(h.greaterThan(0).and(h.lessThan(1)).and(amount.greaterThan(0)), () => {
      const drift = vec3(snapshotTime.mul(windSpeed / 1000), 0, snapshotTime.mul(windSpeed / 1000 * 0.32));
      // Curvature above is the observer's; the clouds themselves are world-fixed.
      const q = p.add(drift).add(vec3(snapshotOrigin.x, 0, snapshotOrigin.y)).toVar();
      const w = weatherNode.sample(q.xz.div(24).add(vec2(0.17, 0.43))).level(0).rg.toVar();
      // Coverage changes the amount of occupied sky, not cloud transparency.
      const c = w.x.add(amount).sub(0.48).clamp(0, 1).toVar();
      If(c.greaterThan(0.08), () => {
        const n = shapeNode.sample(q.div(3.6)).level(0).toVar();
        const profileHeight = altitude.sub(BASE).div(mix(float(0.75), float(TOP - BASE), w.y)).toVar();
        const baseProfile = profileHeight.smoothstep(0, 0.065).mul(profileHeight.smoothstep(0.58, 1).oneMinus()).toVar();
        const threshold = c.mul(0.52).oneMinus().mul(0.76).toVar();
        const billows = n.r.add(n.b.sub(0.5).mul(0.8)).add(n.a.sub(0.5).mul(0.35)).toVar();
        const shape = billows.mul(baseProfile).sub(threshold).div(threshold.oneMinus().max(0.01)).max(0).toVar();
        If(shape.greaterThan(0), () => {
          const erosion = float(0).toVar();
          If(detail.greaterThan(0), () => {
            // Stop unresolved octaves from sparkling at distant silhouettes.
            // Filter toward their measured mean, preserving mean erosion rather
            // than making distant clouds denser by simply removing erosion.
            const fineRaw = shapeNode.sample(q.div(0.55)).level(0).gba;
            const unresolved = vec3(footprint).div(vec3(0.55 / 4, 0.55 / 8, 0.55 / 16)).smoothstep(0.4, 1.2);
            const fine = mix(fineRaw, vec3(...noiseMeans), unresolved);
            erosion.assign(fine.dot(vec3(0.65, 0.25, 0.1)).oneMinus().mul(0.5).sub(0.08).max(0).mul(mix(float(1), float(0.35), shape.clamp(0, 1))));
          });
          // Fade density to zero before the weather early-out; otherwise dense
          // billows turn XZ weather contours into vertical cloud walls.
          density.assign(shape.sub(erosion).max(0).mul(2.4).mul(c.smoothstep(0.08, 0.25)));
        });
      });
    });
    return density;
  });

  const phaseHG = (mu, g) => float((1 - g * g) / (4 * Math.PI))
    .div(float(1 + g * g).sub(mu.mul(2 * g)).max(0.001).pow(1.5));
  const layerDistance = (mu, altitude) => {
    const c = altitude * (2 * EARTH + altitude);
    const b = mu.mul(EARTH);
    return float(c).div(b.mul(b).add(c).sqrt().add(b));
  };
  const march = direction => {
    const start = layerDistance(direction.y, BASE).toVar();
    const end = layerDistance(direction.y, TOP).min(70).toVar();
    const radiance = vec3(0).toVar();
    const transmittance = float(1).toVar();
    const weightedDistance = float(0).toVar();
    If(end.greaterThan(start).and(amount.greaterThan(0)), () => {
      // Invariant along the ray: one atmospheric lookup, not one per step.
      const atmosphereColor = skyRadianceNode(direction).toVar();
      const sampleCount = end.sub(start).div(0.05).ceil().max(steps).min(256).toVar();
      const step = end.sub(start).div(sampleCount).toVar();
      const mu = direction.dot(sunDirection).toVar();
      const phase = phaseHG(mu, 0.65).mul(0.8).add(phaseHG(mu, -0.2).mul(0.2)).toVar();
      // Midpoint quadrature avoids persistent spatial stippling. The longer
      // grazing rays receive extra samples, bounded to 256 for predictable cost.
      const distance = start.add(step.mul(0.5)).toVar();
      const elevation = direction.y.asin();
      const angularTexel = elevation.cos().mul(2 * Math.PI / width)
        .max(elevation.div(Math.PI / 2).sqrt().mul(Math.PI / height));
      const opticalDepth = float(0).toVar();
      const lightingAge = uint(2).toVar();
      Loop(256, ({ i }) => {
        If(i.greaterThanEqual(sampleCount), () => { Break(); });
        If(transmittance.lessThan(0.001), () => { transmittance.assign(0); Break(); });
        const p = direction.mul(distance).toVar();
        const footprint = distance.mul(angularTexel).max(step).toVar();
        const density = densityAt(p, float(1), footprint).toVar();
        If(density.lessThanEqual(0.001), () => { lightingAge.assign(2); });
        If(density.greaterThan(0.001), () => {
          // Six exponentially spaced sun samples. Cheap shape-only density
          // preserves broad self-shadowing; only the first two use erosion.
          // Reuse broad transport across two occupied view samples. Density and
          // transmittance still integrate every sample; entering cloud refreshes
          // immediately so clear gaps cannot inherit another cloud's lighting.
          If(lightingAge.greaterThanEqual(2), () => {
            opticalDepth.assign(0);
            const lightDistance = float(0.04).toVar();
          const previousDistance = float(0).toVar();
          Loop(6, ({ i }) => {
            opticalDepth.addAssign(densityAt(p.add(sunDirection.mul(lightDistance)), i.lessThan(2).select(float(1), float(0)), lightDistance.sub(previousDistance)).mul(lightDistance.sub(previousDistance)).mul(14));
            previousDistance.assign(lightDistance);
            lightDistance.mulAssign(1.85);
          });
          lightingAge.assign(0);
          });
          lightingAge.addAssign(1);
          const beer = opticalDepth.negate().exp().toVar();
          // Low-order multiple scattering approximation broadens light in the
          // interior while leaving the direct forward lobe at the edges.
          const direct = beer.mul(phase)
            .add(opticalDepth.mul(-0.28).exp().mul(0.05))
            .add(opticalDepth.mul(-0.07).exp().mul(0.065)).toVar();
          const h = p.y.add(p.xz.dot(p.xz).div(2 * EARTH)).sub(BASE).div(TOP - BASE).clamp(0, 1);
          const ambient = skyColor.mul(mix(float(0.15), float(0.75), h)).add(vec3(0.004));
          const source = sunColor.mul(direct).mul(sunDirection.y.smoothstep(-0.08, 0.08)).add(ambient).mul(exposure);
          const segmentT = density.mul(step).mul(-14).exp().toVar();
          // Atmosphere between eye and cloud: avoid an opaque white horizon.
          const aerial = distance.mul(-0.027).exp().toVar();
          const fogged = source.mul(aerial).add(atmosphereColor.mul(aerial.oneMinus()));
          weightedDistance.addAssign(transmittance.mul(segmentT.oneMinus()).mul(distance));
          radiance.addAssign(transmittance.mul(segmentT.oneMinus()).mul(fogged));
          transmittance.mulAssign(segmentT);
        });
        distance.addAssign(step);
      });
    });
    const depth = transmittance.lessThan(0.9999).select(
      weightedDistance.div(transmittance.oneMinus().max(0.0001)),
      layerDistance(direction.y, (BASE + TOP) / 2));
    return { color: vec4(radiance, transmittance), depth: vec4(depth, 0, 0, 1) };
  };

  const texelsPerSlice = width * height / slices;
  const makePass = full => Fn(() => {
    // Interleave each update over the whole hemisphere instead of processing
    // a dense horizon band in one frame. The displayed maps remain untouched.
    const coord = full ? uvec2(instanceIndex.mod(width), instanceIndex.div(width))
      : uvec2(instanceIndex.mod(width / 8).mul(8).add(slice.mod(8)),
        instanceIndex.div(width / 8).mul(slices / 8).add(slice.div(8)));
    const uv = vec2(coord).add(0.5).div(vec2(width, height));
    const phi = uv.x.mul(2 * Math.PI);
    const elevation = uv.y.mul(uv.y).mul(Math.PI / 2);
    const direction = vec3(phi.sin().mul(elevation.cos()), elevation.sin(), phi.cos().mul(elevation.cos()));
    const result = march(direction);
    destination.store(coord, result.color).toWriteOnly();
    destinationDepth.store(coord, result.depth).toWriteOnly();
  })().compute(full ? width * height : texelsPerSlice, [64])
    .setName(full ? 'Initialize volumetric cloud sky' : 'Update volumetric cloud sky slice');
  const initializePass = makePass(true);
  const updatePass = makePass(false);

  const directionUV = d => vec2(atan(d.x, d.z).div(2 * Math.PI).fract(),
    d.y.clamp(0, 1).asin().div(Math.PI / 2).sqrt());
  const cacheUV = Fn(([d, time, depth, origin]) => {
    // Advect each complete snapshot to the same display time before blending.
    // Without this correction moving silhouettes appear twice for a full cycle.
    const windDelta = displayTime.sub(time).mul(windSpeed / 1000);
    const wind = vec3(windDelta, 0, windDelta.mul(0.32));
    const offset = cameraPosition.div(1000).sub(vec3(origin.x, 0, origin.y));
    const view = d.mul(depth).add(offset).add(wind).normalize().toVar();
    return directionUV(view);
  });
  const sampleNode = Fn(([direction]) => {
    const result = vec4(0, 0, 0, 1).toVar();
    If(cacheReady.greaterThan(0).and(direction.y.greaterThan(0)), () => {
      const d = direction.normalize().toVar();
      const uv = directionUV(d).toVar();
      result.assign(mix(previous.sample(cacheUV(d, previousTime, previousDepth.sample(uv).level(0).r, previousOrigin)).level(0),
        current.sample(cacheUV(d, currentTime, currentDepth.sample(uv).level(0).r, currentOrigin)).level(0), blend));
    });
    return result;
  });

  let ready = false;
  let disposed = false;
  let frame = 0;
  let generation = 0;
  let lastNow = null;
  let elapsed = 0;
  let cycleStart = 0;
  let cycleDuration = slices / 60;
  let previousIndex = 0, currentIndex = 1, writeIndex = 2;
  const snapshotTimes = [0, cycleDuration, 2 * cycleDuration];
  const snapshotOrigins = [[0, 0], [0, 0], [0, 0]];
  const observerKm = [0, 0];
  const stats = { quality, width, height, steps, slices, coverage, windSpeed,
    maxSteps: 256, targetStepKm: 0.05,
    computeNodeIds: [initializePass.id, updatePass.id],
    bytes: width * height * 8 * 6 + noiseData.data.byteLength + weatherData.data.byteLength,
    generation: 0, updatedTexels: 0, cacheLatencySeconds: cycleDuration,
    /** Observer ground position (x, z) in km that the snapshot being written is marched from. */
    cacheOriginKm: [0, 0],
    representation: 'triple-buffered hemispherical radiance/transmittance + extinction-weighted distance; ground views' };

  function beginSnapshot(index) {
    snapshotOrigins[index] = [observerKm[0], observerKm[1]];
    snapshotOrigin.value.set(observerKm[0], observerKm[1]);
    stats.cacheOriginKm = [observerKm[0], observerKm[1]];
  }

  function readObserver(observer) {
    if (observer == null) return;
    const x = observer.x / 1000;
    const z = observer.z / 1000;
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new TypeError('Cloud observer must have finite x and z in metres.');
    }
    observerKm[0] = x;
    observerKm[1] = z;
  }

  async function bake(probe) {
    if (disposed) return;
    if (probe) { sunColor.value.set(...probe.sun); skyColor.value.set(...probe.sky); }
    beginSnapshot(0);
    snapshotTime.value = elapsed;
    snapshotTimes[0] = elapsed;
    destination.value = maps[0];
    destinationDepth.value = depths[0];
    await renderer.computeAsync(initializePass);
    if (disposed) return;
    destination.value = maps[1];
    destinationDepth.value = depths[1];
    snapshotTime.value = elapsed + cycleDuration;
    snapshotTimes[1] = snapshotTime.value;
    beginSnapshot(1);
    await renderer.computeAsync(initializePass);
    if (disposed) return;
    previousIndex = 0; currentIndex = 1; writeIndex = 2;
    previous.value = maps[0]; current.value = maps[1]; destination.value = maps[2];
    previousDepth.value = depths[0]; currentDepth.value = depths[1]; destinationDepth.value = depths[2];
    snapshotTime.value = elapsed + 2 * cycleDuration;
    snapshotTimes[2] = snapshotTime.value;
    beginSnapshot(2);
    previousTime.value = snapshotTimes[0]; currentTime.value = snapshotTimes[1];
    previousOrigin.value.set(...snapshotOrigins[0]); currentOrigin.value.set(...snapshotOrigins[1]);
    displayTime.value = elapsed;
    blend.value = 0;
    cacheReady.value = 1;
    frame = 0; cycleStart = elapsed; lastNow = null; ready = true;
  }

  return { sampleNode, stats, bake,
    update(nowSeconds, observer) {
      if (!ready || disposed) return;
      readObserver(observer);
      if (lastNow !== null) elapsed += Math.min(Math.max(nowSeconds - lastNow, 0), 0.1);
      lastNow = nowSeconds;
      displayTime.value = elapsed;
      stats.updatedTexels = 0;
      if (coverage === 0) return;
      // Both initialized skies are identical without wind: no updates needed
      // until the observer walks far enough that the parallax estimate would
      // stretch. A cycle in progress always completes. Idle, the blend rests
      // at 0 and `previous` is what is displayed, so that is the snapshot to
      // measure from -- it takes two cycles for a new origin to reach it.
      if (windSpeed === 0 && frame === 0) {
        const origin = snapshotOrigins[previousIndex];
        const moved = Math.hypot(observerKm[0] - origin[0], observerKm[1] - origin[1]);
        if (moved < OBSERVER_REFRESH_KM) return;
      }
      // A snapshot is marched from where the observer stands as its first
      // slice starts, not where they stood when the last one finished.
      if (frame === 0) beginSnapshot(writeIndex);
      slice.value = frame;
      renderer.compute(updatePass);
      stats.updatedTexels = texelsPerSlice;
      blend.value = Math.min(1, (frame + 1) / slices);
      frame++;
      if (frame === slices) {
        // Queue order guarantees the final slice finishes before next render.
        const spare = previousIndex;
        previousIndex = currentIndex; currentIndex = writeIndex; writeIndex = spare;
        previous.value = maps[previousIndex]; current.value = maps[currentIndex]; destination.value = maps[writeIndex];
        previousDepth.value = depths[previousIndex]; currentDepth.value = depths[currentIndex]; destinationDepth.value = depths[writeIndex];
        previousTime.value = snapshotTimes[previousIndex];
        currentTime.value = snapshotTimes[currentIndex];
        previousOrigin.value.set(...snapshotOrigins[previousIndex]);
        currentOrigin.value.set(...snapshotOrigins[currentIndex]);
        cycleDuration = Math.max(0.05, elapsed - cycleStart);
        cycleStart = elapsed;
        snapshotTime.value = elapsed + 2 * cycleDuration;
        snapshotTimes[writeIndex] = snapshotTime.value;
        blend.value = 0;
        frame = 0;
        stats.generation = ++generation;
        stats.cacheLatencySeconds = cycleDuration;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; ready = false;
      initializePass.dispose(); updatePass.dispose();
      noise.dispose(); weather.dispose(); maps.forEach(t => t.dispose()); depths.forEach(t => t.dispose());
    },
  };
}
