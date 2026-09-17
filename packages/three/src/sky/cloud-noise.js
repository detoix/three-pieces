// CPU-generated, periodic cloud textures. Coordinates passed to the sampler are
// measured in repeat tiles (so x and x + 1 describe the same location).
const DEFAULT_SEED = 0x43f6a21d;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const fade = (value) => value * value * value * (value * (value * 6 - 15) + 10);
const mix = (a, b, t) => a + (b - a) * t;
const byte = (value) => Math.round(clamp01(value) * 255);
const wrap = (value, period) => ((value % period) + period) % period;

function hash(x, y, z, seed) {
  let value = seed ^ Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function validateSize(size, name) {
  if (!Number.isInteger(size) || size < 1 || size > 256) {
    throw new RangeError(`${name} must be an integer from 1 to 256`);
  }
}

// Reusable evaluator, also useful when examining the textures without a GPU.
// Perlin and inverted Worley outputs are both in [0, 1]. Lattice coordinates
// are wrapped before hashing; interpolated gradients and feature points are
// therefore periodic in all three axes, including across negative coordinates.
export function createTileableNoiseSampler({ cells = 4, seed = DEFAULT_SEED } = {}) {
  validateSize(cells, 'cells');
  const count = cells ** 3;
  const gradients = new Uint8Array(count);
  const points = new Float32Array(count * 3);
  for (let z = 0; z < cells; z++) {
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const index = (z * cells + y) * cells + x;
        gradients[index] = hash(x, y, z, seed) % 12;
        // A small inset keeps a single neighboring-cell search sufficient and
        // avoids especially thin, needle-like cells in the cloud shape.
        points[index * 3] = 0.15 + 0.7 * hash(x, y, z, seed ^ 0x68bc21eb) / 4294967296;
        points[index * 3 + 1] = 0.15 + 0.7 * hash(x, y, z, seed ^ 0x02e5be93) / 4294967296;
        points[index * 3 + 2] = 0.15 + 0.7 * hash(x, y, z, seed ^ 0x967a889b) / 4294967296;
      }
    }
  }
  const gradientX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
  const gradientY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
  const gradientZ = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];
  function gradient(x, y, z, dx, dy, dz) {
    const index = gradients[(z * cells + y) * cells + x];
    return gradientX[index] * dx + gradientY[index] * dy + gradientZ[index] * dz;
  }
  function perlin(x, y, z) {
    x = wrap(x, 1) * cells;
    y = wrap(y, 1) * cells;
    z = wrap(z, 1) * cells;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const nx = (ix + 1) % cells, ny = (iy + 1) % cells, nz = (iz + 1) % cells;
    const dx = x - ix, dy = y - iy, dz = z - iz;
    const u = fade(dx), v = fade(dy), w = fade(dz);
    const lower = mix(
      mix(gradient(ix, iy, iz, dx, dy, dz), gradient(nx, iy, iz, dx - 1, dy, dz), u),
      mix(gradient(ix, ny, iz, dx, dy - 1, dz), gradient(nx, ny, iz, dx - 1, dy - 1, dz), u), v);
    const upper = mix(
      mix(gradient(ix, iy, nz, dx, dy, dz - 1), gradient(nx, iy, nz, dx - 1, dy, dz - 1), u),
      mix(gradient(ix, ny, nz, dx, dy - 1, dz - 1), gradient(nx, ny, nz, dx - 1, dy - 1, dz - 1), u), v);
    return clamp01(0.5 + mix(lower, upper, w) * 0.65);
  }
  function worley(x, y, z) {
    x = wrap(x, 1) * cells;
    y = wrap(y, 1) * cells;
    z = wrap(z, 1) * cells;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    let distanceSquared = 3;
    for (let dz = -1; dz <= 1; dz++) {
      const layer = wrap(iz + dz, cells) * cells;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (layer + wrap(iy + dy, cells)) * cells;
        for (let dx = -1; dx <= 1; dx++) {
          const index = (row + wrap(ix + dx, cells)) * 3;
          const px = dx + points[index] - fx;
          const py = dy + points[index + 1] - fy;
          const pz = dz + points[index + 2] - fz;
          distanceSquared = Math.min(distanceSquared, px * px + py * py + pz * pz);
        }
      }
    }
    return clamp01(1 - Math.sqrt(distanceSquared) / 1.05);
  }
  return { perlin, worley };
}

/**
 * RGBA8 volume, x-fastest, sampled at voxel centers for repeat/linear filtering.
 * R: broad Perlin-Worley shape, with a useful density threshold around 0.4–0.6.
 * G/B/A: inverted Worley at 4/8/16 cells per tile (1 = feature point center).
 * Suggested shader: threshold/remap R with weather coverage, then subtract a
 * small amount of (1 - weighted GBA) at the boundary to erode fluffy edges.
 */
export function createCloudNoiseData({ size = 64, seed = DEFAULT_SEED } = {}) {
  validateSize(size, 'size');
  const data = new Uint8Array(size ** 3 * 4);
  const low = createTileableNoiseSampler({ cells: 4, seed });
  const middle = createTileableNoiseSampler({ cells: 8, seed: seed ^ 0x51f15e });
  const high = createTileableNoiseSampler({ cells: 16, seed: seed ^ 0x739b1 });
  let index = 0;
  for (let z = 0; z < size; z++) {
    const pz = (z + 0.5) / size;
    for (let y = 0; y < size; y++) {
      const py = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const px = (x + 0.5) / size;
        const w0 = low.worley(px, py, pz);
        const w1 = middle.worley(px, py, pz);
        const w2 = high.worley(px, py, pz);
        const perlin = low.perlin(px, py, pz) * 0.8 + middle.perlin(px, py, pz) * 0.2;
        // A gentle contrast expansion retains smooth rounded cellular forms
        // while giving the shader enough range to carve open sky.
        const shape = 0.5 + (perlin * 0.6 + w0 * 0.4 - 0.5) * 1.55;
        data[index++] = byte(shape);
        data[index++] = byte(w0);
        data[index++] = byte(w1);
        data[index++] = byte(w2);
      }
    }
  }
  return { data, width: size, height: size, depth: size };
}

/**
 * RGBA8 periodic weather map. R is coverage, remapped to make clear and cloudy
 * patches. G is cloud type/thickness potential (higher = taller cumulus).
 * B is an unthresholded broad humidity field; A is 255. Shader coverage is
 * normally multiplied by the user's global cloud amount before remapping R
 * from the volume texture. World X/Z should map to the texture's X/Y axes.
 */
export function createCloudWeatherData({ size = 128, seed = DEFAULT_SEED } = {}) {
  validateSize(size, 'size');
  const data = new Uint8Array(size * size * 4);
  const broad = createTileableNoiseSampler({ cells: 3, seed: seed ^ 0x3613a9 });
  const detail = createTileableNoiseSampler({ cells: 7, seed: seed ^ 0x71e934 });
  let index = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size, py = (y + 0.5) / size;
      const humidity = broad.perlin(px, py, 0.371);
      const field = humidity * 0.85 + detail.perlin(px, py, 0.619) * 0.15;
      const coverage = clamp01((field - 0.34) / 0.32);
      const thickness = broad.perlin(px + 0.317, py - 0.231, 0.713);
      data[index++] = byte(coverage * coverage * (3 - 2 * coverage));
      data[index++] = byte(0.15 + thickness * 0.85);
      data[index++] = byte(humidity);
      data[index++] = 255;
    }
  }
  return { data, width: size, height: size };
}
