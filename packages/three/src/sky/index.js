import { normalWorldGeometry } from 'three/tsl';
import { ATMOSPHERE, SKY_LUT, sunDirectionFrom } from './atmosphere.js';
import { createFieldSky } from './sky-nodes.js';
import { CLOUD_PRESETS, createVolumetricClouds } from './clouds.js';

// Coordinate utilities let hosts align their lights without importing internals.
export { sunDirectionFrom, sunAnglesOf } from './atmosphere.js';
export {
  AUTHORED_SKY,
  AUTHORED_SUN,
  SKY_ANCHOR,
  SUN_ANCHOR,
  applySkyLighting,
  relativeLuminance,
} from './lights.js';

function finite(name, value, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name} must be in [${min}, ${max}].`);
  }
  return value;
}

function sunAngles(elevation, azimuth) {
  finite('Sun elevation', elevation, -90, 90);
  finite('Sun azimuth', azimuth);
  return [elevation, ((azimuth % 360) + 360) % 360];
}

// Diagnostics contain plain values; copies cannot mutate live cache state.
function snapshot(value) {
  if (value === null || typeof value !== 'object') return value;
  return Object.freeze(Array.isArray(value)
    ? value.map(snapshot)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)])));
}

const atmosphereTables = snapshot(Object.entries(SKY_LUT).map(([name, table]) => ({
  name, width: table.width, height: table.height,
})));

/**
 * Independent Three.js WebGPU sky. The host owns its scene, renderer, lights,
 * camera and frame loop. See docs/sky.md for units and lifecycle semantics.
 */
export function createSky(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Sky options must be an object.');
  }
  const {
    renderer, sunElevation = 45, sunAzimuth = 0, exposure = 1,
    multiScatter = 1, eyeHeightKm = 0.0017, clouds = true,
    cloudQuality = 'balanced', cloudCoverage = 0.48, cloudWindSpeed = 12,
    cloudSeed = 0x43f6a21d,
  } = options;

  // Validate before allocating textures, storage buffers or noise volumes.
  if (!renderer || typeof renderer.computeAsync !== 'function' ||
      typeof renderer.getArrayBufferAsync !== 'function' ||
      (clouds && typeof renderer.compute !== 'function')) {
    throw new TypeError('Sky requires a Three.js WebGPU renderer with compute and readback support.');
  }
  if (renderer.initialized === false) {
    throw new Error('Initialize the sky renderer with await renderer.init() first.');
  }
  if (typeof clouds !== 'boolean') throw new TypeError('Clouds must be a boolean.');
  const [elevation, azimuth] = sunAngles(sunElevation, sunAzimuth);
  finite('Sky exposure', exposure, 0);
  finite('Multiple scattering', multiScatter, 0);
  finite('Eye height', eyeHeightKm, 0);
  if (eyeHeightKm >= ATMOSPHERE.topRadius - ATMOSPHERE.bottomRadius) {
    throw new RangeError('Eye height must be inside the atmosphere (less than 100 km).');
  }
  if (typeof cloudQuality !== 'string' || !Object.hasOwn(CLOUD_PRESETS, cloudQuality)) {
    throw new RangeError(`Unknown cloud quality: ${String(cloudQuality)}`);
  }
  finite('Cloud coverage', cloudCoverage, 0, 1);
  finite('Cloud wind speed', cloudWindSpeed, 0, 100);
  if (!Number.isInteger(cloudSeed) || cloudSeed < 0 || cloudSeed > 0xffffffff) {
    throw new RangeError('Cloud seed must be an unsigned 32-bit integer.');
  }

  const atmosphere = createFieldSky({
    renderer, sunElevation: elevation, sunAzimuth: azimuth,
    exposure, multiScatter, eyeHeightKm,
  });
  let volume = null;
  let backgroundNode;
  try {
    if (clouds) volume = createVolumetricClouds({
      renderer,
      sunDirection: atmosphere.sunDirection,
      exposure: atmosphere.skyExposure,
      skyRadianceNode: atmosphere.skyRadianceNode,
      quality: cloudQuality, coverage: cloudCoverage, windSpeed: cloudWindSpeed,
      seed: cloudSeed,
    });
    const cloud = volume?.sampleNode(normalWorldGeometry);
    backgroundNode = cloud
      ? atmosphere.backgroundNode.mul(cloud.a).add(cloud.rgb)
      : atmosphere.backgroundNode;
  } catch (error) {
    volume?.dispose();
    atmosphere.dispose();
    throw error;
  }

  let disposed = false;
  let ready = false;
  let busy = false;
  let atmosphereReady = false;
  let lastUpdateSeconds = null;
  let pending = Promise.resolve();
  const assertAlive = () => {
    if (disposed) throw new Error('Cannot use a disposed sky.');
  };
  async function bakeAtmosphere() {
    const probe = await atmosphere.bake();
    atmosphereReady = true;
    return probe;
  }
  // Keep sun uniforms, probe readback and all cloud writes in one queue.
  // Failures reject their caller while allowing a later operation to recover.
  function enqueue(operation) {
    if (disposed) return Promise.reject(new Error('Cannot use a disposed sky.'));
    const result = pending.then(async () => {
      assertAlive();
      busy = true;
      ready = false;
      try {
        const probe = await operation();
        assertAlive();
        await volume?.bake(probe);
        assertAlive();
        lastUpdateSeconds = null;
        ready = true;
        return probe;
      } finally {
        busy = false;
      }
    });
    pending = result.catch(() => {});
    return result;
  }
  const cloudDiagnostics = volume ? Object.freeze({
    get stats() { return snapshot(volume.stats); },
  }) : null;

  return Object.freeze({
    backgroundNode,
    skyRadianceNode: atmosphere.skyRadianceNode,
    clouds: cloudDiagnostics,
    // The sun's beam through the clouds to a world position (metres; the
    // fragment's own by default). A host multiplies its sun by it, most simply
    // as that light's shadow; see docs/sky.md.
    cloudShadowNode: volume ? worldPosition => {
      assertAlive();
      return volume.shadowNode(worldPosition);
    } : null,
    get sunDirection() { return Object.freeze(atmosphere.sunDirection.value.toArray()); },
    get ready() { return ready; },
    get disposed() { return disposed; },
    get stats() {
      return Object.freeze({
        ...atmosphere.stats,
        bytes: atmosphere.stats.bytes + (volume?.stats.bytes ?? 0),
        tables: atmosphereTables,
      });
    },
    fogNodeFor(fogOptions = {}) {
      assertAlive();
      if (fogOptions === null || typeof fogOptions !== 'object') {
        throw new TypeError('Fog options must be an object.');
      }
      const { near, far } = fogOptions;
      finite('Fog near distance', near, 0);
      finite('Fog far distance', far, 0);
      if (far <= near) throw new RangeError('Fog far distance must exceed near distance.');
      return atmosphere.fogNodeFor({ near, far });
    },
    bake() { return enqueue(bakeAtmosphere); },
    async setSun(elevationDegrees, azimuthDegrees) {
      assertAlive();
      const [nextElevation, nextAzimuth] = sunAngles(elevationDegrees, azimuthDegrees);
      return enqueue(() => {
        if (atmosphereReady) return atmosphere.setSun(nextElevation, nextAzimuth);
        // setSun is also a valid first operation. Its internal counterpart only
        // writes the view LUT, so initialize the medium tables here first.
        atmosphere.sunDirection.value.set(...sunDirectionFrom(nextElevation, nextAzimuth));
        return bakeAtmosphere();
      });
    },
    update(seconds, observer) {
      if (disposed) return false;
      finite('Sky time', seconds, 0);
      if (observer != null) {
        finite('Sky observer x', observer.x, -Infinity);
        finite('Sky observer z', observer.z, -Infinity);
      }
      if (!ready || busy || !volume) return false;
      if (lastUpdateSeconds !== null && seconds < lastUpdateSeconds) {
        throw new RangeError('Sky time must be monotonic between successful bakes.');
      }
      volume.update(seconds, observer);
      lastUpdateSeconds = seconds;
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ready = false;
      // Three's background renderer listens here to release its generated
      // sphere material and geometry after the host detaches this node.
      backgroundNode.dispose();
      volume?.dispose();
      atmosphere.dispose();
    },
  });
}
