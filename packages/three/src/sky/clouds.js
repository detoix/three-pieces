import * as THREE from 'three/webgpu';
import { createCloudNoiseData, createCloudWeatherData } from './cloud-noise.js';
import { CLOUD_LIGHTING } from './cloud-lighting.js';
import { CLOUD_SHADOW, WIND_Z, cloudDrift, createCloudShadowMap } from './cloud-shadow.js';

const { Fn, If, Loop, Break, float, uint, vec2, vec3, vec4, uvec2,
  uniform, instanceIndex, texture, texture3D, storageTexture, mix, atan,
  cameraPosition } = THREE.TSL;

// Kilometres throughout the volume. This is a ground-view renderer: the cache
// is angular, independent of the camera, and is not a cloud fly-through volume.
export const CLOUD_PRESETS = Object.freeze({
  low: Object.freeze({ width: 768, height: 256, steps: 32, slices: 128 }),
  balanced: Object.freeze({ width: 1536, height: 512, steps: 48, slices: 256 }),
  high: Object.freeze({ width: 2048, height: 768, steps: 64, slices: 384 }),
});
const EARTH = 6360;
/** How far a still sky's observer may move before its snapshots are remarched. */
export const OBSERVER_REFRESH_KM = 0.1;
const BASE = 1.35;
const TOP = 2.65;
// The cloud body. Real cumulus have a sharp boundary and a nearly uniform
// inside, so density rises steeply over the first `EDGE` of the shape field and
// only slowly after it; `EXTINCTION` is per kilometre per unit density. The
// edge is never sharper than the cache can hold: a boundary narrower than one
// texel is point-sampled into a staircase, so it widens with the sample's
// footprint, at `EDGE_PER_KM` shape units per kilometre of it.
const EDGE = 0.12;
const EDGE_PER_KM = 30;
// ...but never so wide that a distant cloud never reaches its body: past this
// the edge is the whole cloud, it thins out, and every ray through it runs on.
const EDGE_MAX = 1;
// The footprint at which the edge is at its crispest, `EDGE`: the shadow map's.
const SHADOW_FOOTPRINT = EDGE / EDGE_PER_KM;
const DENSITY_BASE = 3;
const DENSITY_SLOPE = 2;
const EXTINCTION = 14;
// What a long sun segment reads instead: the smooth shape, not the sharp body,
// because a few hundred metres of path average over a cloud and its gaps.
const SMOOTH_DENSITY = 3;
// The primary march. Coarse steps cross empty sky; a coarse step that lands in
// cloud backs up and walks the interval it jumped at a quarter of the step, so
// the boundary is found to a quarter step instead of banding at a whole one.
// Fine steps continue until the ray has been out of cloud for `EXIT_RUN`
// samples, or is deep enough that what lies behind barely shows.
const FINE_FRACTION = 0.25;
const DEEP_TRANSMITTANCE = 0.3;
const EXIT_RUN = 6;
const MAX_ITERATIONS = 320;
// Refinement is skipped only where one texel spans more than two coarse
// steps, where the filtered edge is wider than the step anyway. It is not
// skipped merely because a texel is wider than a step: along the horizon a
// dense body sampled at whole steps bands from one cache row to the next, and
// the band of distant clouds came out striped.
const REFINE_RATIO = 0.5;
// A ray stops once what lies behind would show through at under half a
// percent; the last fraction of a cloud's depth changes nothing visible.
const OPAQUE = 0.005;
// Sun optical depth is reused across this many occupied samples: two coarse
// ones, or eight fine ones, which together span about the same distance.
const LIGHT_REUSE_COARSE = 2;
const LIGHT_REUSE_FINE = 8;
// Sun samples: six, at the midpoints of segments growing 2.45x from 15 m, which
// reaches 1.3 km -- the path from a cumulus's underside, 1 km below its top,
// to a 49-degree sun. At 2.1x it reached 0.6 km, and undersides seen toward
// the sun were lit as though half the cloud above them were not there. The
// first two read the full body with erosion, the rest the smooth shape.
const LIGHT_FIRST_KM = 0.015;
const LIGHT_GROWTH = 2.45;
const LIGHT_DETAILED = 2;
// How far, in shape tiles, the humidity field slides the shape pattern.
const SHAPE_SLIDE = 0.35;
// A cumulus's base is flat because it is the height at which rising air
// condenses, the same for every thermal under it; every cloud in the
// reference photographs (docs/measuring.md) shows one, grey under a white
// top, and far off a flat-bottomed lens. The 3D billows that carve a cloud
// grow in over the lower `BILLOW_RISE` of its height, so its footprint there is
// the smooth low-frequency shape, cut off over the bottom `BASE_CUT` and not
// eroded below `SMOOTH_BASE`. With billows everywhere the undersides were as
// lumpy as the tops, and the horizon a band of popcorn. Shaping the density
// instead -- thin at the base, dense at the top, as Guerrilla's density
// recipes do -- brought back the soft look the dense body was made to remove.
const BILLOW_RISE = 0.4;
const BASE_CUT = 0.045;
const SMOOTH_BASE = 0.1;

/** The coverage the weather map is drawn for: at it, local coverage is the
 *  map's own. */
export const COVERAGE_REFERENCE = 0.48;

/**
 * Local coverage for a weather-map value `local` in [0, 1] under the sky's
 * `coverage` option. Above the reference, coverage is added, which fills the
 * dry regions until the sky is overcast. Below it, coverage scales, which thins
 * every region alike, down to a clear sky at 0. An offset there would only
 * trim the humid regions' edges: the map is saturated over 18% of the world,
 * so at 0.1 its cores stayed as dense as at the default, and the demo's start
 * point, at the edge of one, was 85% shaded.
 */
export function cloudLocalCoverage(local, coverage) {
  const scaled = local * Math.min(1, coverage / COVERAGE_REFERENCE);
  return Math.min(1, Math.max(0, scaled + Math.max(0, coverage - COVERAGE_REFERENCE)));
}

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

  // `p` is relative to whoever is looking -- curvature is measured from them --
  // and `offset` is where they stand in the drifting field, so `p + offset`
  // is the field point. The sky looks from the observer at its snapshot's
  // time; the shadow map looks up from each point of the ground.
  const densityAt = Fn(([p, detail, footprint, offset]) => {
    const altitude = p.y.add(p.xz.dot(p.xz).div(2 * EARTH));
    const h = altitude.sub(BASE).div(TOP - BASE).toVar();
    const density = float(0).toVar();
    If(h.greaterThan(0).and(h.lessThan(1)).and(amount.greaterThan(0)), () => {
      // Curvature above is the observer's; the clouds themselves are world-fixed.
      const q = p.add(offset).toVar();
      const w = weatherNode.sample(q.xz.div(24).add(vec2(0.17, 0.43))).level(0).rgb.toVar();
      // Coverage changes the amount of occupied sky, not cloud transparency.
      // `cloudLocalCoverage`, transcribed.
      const c = w.x.mul(amount.div(COVERAGE_REFERENCE).min(1))
        .add(amount.sub(COVERAGE_REFERENCE).max(0)).clamp(0, 1).toVar();
      If(c.greaterThan(0.08), () => {
        // The shape volume repeats every 3.6 km, which at 20-50 km lines the
        // horizon with the same puffs. The weather map's broad humidity field
        // (B) slides the pattern by up to a third of a tile across ~8 km cells,
        // so neighbouring tiles no longer match -- at a stretch of under a
        // third, and at no cost: the weather texel is already fetched.
        const slide = vec3(w.z, 0, w.z.mul(0.7)).mul(SHAPE_SLIDE);
        const n = shapeNode.sample(q.div(3.6).add(slide)).level(0).toVar();
        const profileHeight = altitude.sub(BASE).div(mix(float(0.75), float(TOP - BASE), w.y)).toVar();
        const baseProfile = profileHeight.smoothstep(0, BASE_CUT).mul(profileHeight.smoothstep(0.58, 1).oneMinus()).toVar();
        // 0.74, down from 0.76, holds the page's cloud cover now that thin
        // coverage shrinks clouds instead of fading them (measure-clouds.mjs).
        const threshold = c.mul(0.52).oneMinus().mul(0.74).toVar();
        const billows = n.r.add(n.b.sub(0.5).mul(0.8).add(n.a.sub(0.5).mul(0.35))
          .mul(profileHeight.smoothstep(0, BILLOW_RISE))).toVar();
        // Thinning coverage shrinks a cloud rather than fading it: scaling the
        // shape before the threshold keeps its boundary crisp, and the shape
        // still reaches zero at the 0.08 early-out, so billows cannot be cut
        // into vertical walls along weather contours.
        const feather = c.smoothstep(0.08, 0.15);
        const shape = billows.mul(baseProfile).mul(feather).sub(threshold)
          .div(threshold.oneMinus().max(0.01)).max(0).toVar();
        If(shape.greaterThan(0), () => {
          If(detail.greaterThan(0), () => {
            // Stop unresolved octaves from sparkling at distant silhouettes.
            // Filter toward their measured mean, preserving mean erosion rather
            // than making distant clouds denser by simply removing erosion.
            const fineRaw = shapeNode.sample(q.div(0.55)).level(0).gba;
            const unresolved = vec3(footprint).div(vec3(0.55 / 4, 0.55 / 8, 0.55 / 16)).smoothstep(0.4, 1.2);
            const fine = mix(fineRaw, vec3(...noiseMeans), unresolved);
            const erosion = fine.dot(vec3(0.65, 0.25, 0.1)).oneMinus().mul(0.5).sub(0.08).max(0)
              .mul(mix(float(1), float(0.35), shape.clamp(0, 1)))
              .mul(profileHeight.smoothstep(0, SMOOTH_BASE));
            const eroded = shape.sub(erosion).max(0);
            const edge = footprint.mul(EDGE_PER_KM).clamp(EDGE, EDGE_MAX);
            density.assign(eroded.smoothstep(0, edge).mul(eroded.mul(DENSITY_SLOPE).add(DENSITY_BASE)));
          }).Else(() => {
            density.assign(shape.mul(SMOOTH_DENSITY));
          });
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
      // Where the observer stood in the field when this snapshot was marched.
      const drift = snapshotTime.mul(windSpeed / 1000);
      const fieldOffset = vec3(drift.add(snapshotOrigin.x), 0, drift.mul(WIND_Z).add(snapshotOrigin.y)).toVar();
      // Coarse steps target 50 m, at least the preset's minimum count and at
      // most 256 across the layer; fine steps are a quarter of that.
      const coarseCount = end.sub(start).div(0.05).ceil().max(steps).min(256);
      const coarse = end.sub(start).div(coarseCount).toVar();
      const fine = coarse.mul(FINE_FRACTION).toVar();
      const mu = direction.dot(sunDirection).toVar();
      // Everything about the lighting that depends only on the ray, hoisted.
      // `cloud-lighting.js` is the scalar contract these are transcribed from.
      const L = CLOUD_LIGHTING;
      const phase = phaseHG(mu, L.forwardG).mul(L.forwardWeight)
        .add(phaseHG(mu, L.backG).mul(1 - L.forwardWeight)).toVar();
      const multiPhase = phaseHG(mu, L.msG).mul(0.5).add(0.5 / (4 * Math.PI)).mul(L.msWeight).toVar();
      const powderReach = mu.oneMinus().mul(0.5 * L.powderStrength).toVar();
      const sunUp = sunDirection.y.smoothstep(-0.08, 0.08).toVar();
      const groundBounce = vec3(...L.groundAlbedo)
        .mul(sunColor.mul(sunDirection.y.max(0)).add(skyColor))
        .mul(L.groundShadow / Math.PI).toVar();
      // Midpoint quadrature: no persistent spatial jitter to stipple the cache.
      const distance = start.add(coarse.mul(0.5)).toVar();
      const elevation = direction.y.asin();
      const angularTexel = elevation.cos().mul(2 * Math.PI / width)
        .max(elevation.div(Math.PI / 2).sqrt().mul(Math.PI / height));
      const opticalDepth = float(0).toVar();
      // 99 means "refresh on the next occupied sample, whatever the depth".
      const lightingAge = uint(99).toVar();
      const fineMode = uint(0).toVar();
      const emptyRun = uint(0).toVar();
      Loop(MAX_ITERATIONS, () => {
        If(distance.greaterThanEqual(end), () => { Break(); });
        If(transmittance.lessThan(OPAQUE), () => { transmittance.assign(0); Break(); });
        const stepLength = fineMode.equal(1).select(fine, coarse).toVar();
        const p = direction.mul(distance).toVar();
        const lateral = distance.mul(angularTexel);
        const footprint = lateral.max(stepLength).toVar();
        const density = densityAt(p, float(1), footprint, fieldOffset).toVar();
        const refine = coarse.greaterThan(lateral.mul(REFINE_RATIO));
        If(fineMode.equal(0).and(refine).and(density.greaterThan(0.001))
          .and(transmittance.greaterThan(DEEP_TRANSMITTANCE)), () => {
          // A coarse step has just landed in cloud, so the boundary lies in the
          // interval it jumped: back up and walk that interval finely.
          distance.subAssign(coarse.sub(fine.mul(0.5)));
          fineMode.assign(1);
          emptyRun.assign(0);
          lightingAge.assign(99);
        }).Else(() => {
          If(density.lessThanEqual(0.001), () => {
            lightingAge.assign(99);
            emptyRun.addAssign(1);
          }).Else(() => {
            emptyRun.assign(0);
            // Six sun samples, the near two through the full body. Their
            // optical depth is reused across a few occupied view samples and
            // not refreshed at all once the ray is deep, where what it lights
            // barely shows; entering cloud always refreshes it, so a gap
            // cannot inherit another cloud's light.
            const reuse = fineMode.equal(1).select(uint(LIGHT_REUSE_FINE), uint(LIGHT_REUSE_COARSE));
            If(lightingAge.greaterThanEqual(reuse)
              .and(transmittance.greaterThan(DEEP_TRANSMITTANCE).or(lightingAge.greaterThanEqual(99))), () => {
              opticalDepth.assign(0);
              const lightDistance = float(LIGHT_FIRST_KM).toVar();
              const previousDistance = float(0).toVar();
              Loop(6, ({ i }) => {
                const segment = lightDistance.sub(previousDistance);
                const middle = lightDistance.add(previousDistance).mul(0.5);
                opticalDepth.addAssign(densityAt(p.add(sunDirection.mul(middle)),
                  i.lessThan(LIGHT_DETAILED).select(float(1), float(0)), segment, fieldOffset)
                  .mul(segment).mul(EXTINCTION));
                previousDistance.assign(lightDistance);
                lightDistance.mulAssign(LIGHT_GROWTH);
              });
              lightingAge.assign(0);
            });
            lightingAge.addAssign(1);
            // Single scattering through the optical depth to the sun, plus the
            // light that has scattered more than once and diffuses through
            // rather than dying off like the beam. Seen from the sun's side, a
            // thin fringe has had few scattering events and is darker (powder).
            const beer = opticalDepth.negate().exp();
            const diffuse = opticalDepth.mul(L.msFalloff).add(1).reciprocal();
            const powder = density.mul(-L.powder).exp().oneMinus();
            const darkening = powder.sub(1).mul(powderReach).add(1);
            const scattered = beer.mul(phase).add(diffuse.mul(multiPhase)).mul(darkening);
            // Tops see the sky and bases the sunlit lawn below.
            const h = p.y.add(p.xz.dot(p.xz).div(2 * EARTH)).sub(BASE).div(TOP - BASE).clamp(0, 1);
            const ambient = skyColor.mul(mix(float(L.skyAmbientBase), float(L.skyAmbientTop), h))
              .add(groundBounce.mul(h.oneMinus()));
            const source = sunColor.mul(scattered).mul(sunUp).add(ambient).mul(exposure);
            const segmentT = density.mul(stepLength).mul(-EXTINCTION).exp().toVar();
            // Atmosphere between eye and cloud: avoid an opaque white horizon.
            const aerial = distance.mul(-0.027).exp().toVar();
            const fogged = source.mul(aerial).add(atmosphereColor.mul(aerial.oneMinus()));
            weightedDistance.addAssign(transmittance.mul(segmentT.oneMinus()).mul(distance));
            radiance.addAssign(transmittance.mul(segmentT.oneMinus()).mul(fogged));
            transmittance.mulAssign(segmentT);
          });
          // Back to coarse steps once out of cloud for a while, or deep enough
          // that nothing behind will show through.
          If(fineMode.equal(1).and(emptyRun.greaterThanEqual(EXIT_RUN).or(transmittance.lessThan(DEEP_TRANSMITTANCE))), () => {
            fineMode.assign(0);
          });
          distance.addAssign(stepLength);
        });
      });
    });
    const depth = transmittance.lessThan(0.9999).select(
      weightedDistance.div(transmittance.oneMinus().max(0.0001)),
      layerDistance(direction.y, (BASE + TOP) / 2));
    return { color: vec4(radiance, transmittance), depth: vec4(depth, 0, 0, 1) };
  };

  // The sun's beam down to a point of ground, for the shadow map. The ground
  // point is the observer here: the ray starts on it and curvature is measured
  // from it, so a texel's value depends only on where it lies in the field and
  // never on where the map is centred -- one map swapped for the next shows no
  // seam. Its layer is measured from y = 0 and the sky's from the eye, which
  // for a camera at eye height over gentle ground is metres of a 1.35 km base.
  //
  // The body is read at its crispest, as the nearest clouds overhead are
  // drawn: a shadow is the cloud that casts it, and read at the 50 m step its
  // edge widened to the whole cloud -- every shadow ringed by a 140 m grey
  // fringe, and 40% of the ground shaded where the crisp clouds shade 49%. The
  // map's 20 m texels then blur the edge by about the sun's own width.
  // Against the step, a crisp edge can only quantize the shadow's last few
  // tens of metres, and a read-back map showed no banding.
  const transmittanceAt = (ground, cast) => {
    const offset = vec3(ground.x, 0, ground.y);
    const start = layerDistance(cast.y, BASE).toVar();
    const end = layerDistance(cast.y, TOP).toVar();
    const count = end.sub(start).div(CLOUD_SHADOW.targetStepKm).ceil()
      .clamp(CLOUD_SHADOW.minSteps, CLOUD_SHADOW.maxSteps);
    const step = end.sub(start).div(count).toVar();
    const depth = float(0).toVar();
    const distance = start.add(step.mul(0.5)).toVar();
    Loop(CLOUD_SHADOW.maxSteps, () => {
      If(distance.greaterThanEqual(end).or(depth.greaterThan(CLOUD_SHADOW.opaqueDepth)), () => { Break(); });
      depth.addAssign(densityAt(cast.mul(distance), float(1), float(SHADOW_FOOTPRINT), offset)
        .mul(step).mul(EXTINCTION));
      distance.addAssign(step);
    });
    return depth.negate().exp();
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
  // No clouds cast no shadow, and nothing is marched to find that out.
  const shadow = coverage > 0
    ? createCloudShadowMap({ renderer, sunDirection, transmittanceAt })
    : null;

  const directionUV = d => vec2(atan(d.x, d.z).div(2 * Math.PI).fract(),
    d.y.clamp(0, 1).asin().div(Math.PI / 2).sqrt());
  const cacheUV = Fn(([d, time, depth, origin]) => {
    // Advect each complete snapshot to the same display time before blending.
    // Without this correction moving silhouettes appear twice for a full cycle.
    const windDelta = displayTime.sub(time).mul(windSpeed / 1000);
    const wind = vec3(windDelta, 0, windDelta.mul(WIND_Z));
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
    maxSteps: 256, targetStepKm: 0.05, fineStepFraction: FINE_FRACTION, maxIterations: MAX_ITERATIONS,
    computeNodeIds: [initializePass.id, updatePass.id],
    bytes: width * height * 8 * 6 + noiseData.data.byteLength + weatherData.data.byteLength +
      (shadow?.stats.bytes ?? 0),
    shadow: shadow?.stats ?? null,
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
    await shadow?.bake(observerKm, cloudDrift(elapsed, windSpeed));
    if (disposed) return;
    cacheReady.value = 1;
    frame = 0; cycleStart = elapsed; lastNow = null; ready = true;
  }

  return { sampleNode, stats, bake,
    /** Sun transmittance to a world position in metres; see `cloud-shadow.js`. */
    shadowNode: worldPosition => shadow ? shadow.shadowNode(worldPosition) : float(1),
    update(nowSeconds, observer) {
      if (!ready || disposed) return;
      readObserver(observer);
      if (lastNow !== null) elapsed += Math.min(Math.max(nowSeconds - lastNow, 0), 0.1);
      lastNow = nowSeconds;
      displayTime.value = elapsed;
      stats.updatedTexels = 0;
      // Before the still-sky early return below: a walker under a still sky
      // still walks out of the shadow map.
      shadow?.update(observerKm, cloudDrift(elapsed, windSpeed));
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
      shadow?.dispose();
      noise.dispose(); weather.dispose(); maps.forEach(t => t.dispose()); depths.forEach(t => t.dispose());
    },
  };
}
