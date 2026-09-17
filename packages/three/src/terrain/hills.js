/**
 * Unbounded rolling hills, written once for two evaluators.
 *
 * The walker's eye, the tests and the GPU (grass placement and the ground's
 * vertex displacement) must agree on one surface, and a scalar function with
 * a hand-transcribed TSL twin is two copies that can drift apart. So the
 * formula is written against a small arithmetic interface: `SCALAR_OPS` runs
 * it on numbers, and `hillsNodeOps(TSL)` builds the same expression as shader
 * nodes. Agreement is by construction; only f32 against f64 separates them.
 *
 * The shape is a domain-warped sum of rotated sine-cosine products. It needs
 * no hash, no texture and no lookup table, so it has no edge, no tile and no
 * precision cliff for any distance a person will walk, and its bound is exact:
 * each octave's product lies in [-1, 1], so the height lies within the sum of
 * the amplitudes. Incommensurate wavelengths and per-octave rotations keep any
 * repetition far beyond the view distance.
 */

/** Largest to smallest. Wavelengths in metres, amplitudes in metres at scale 1. */
export const HILL_OCTAVES = Object.freeze([
  { wavelength: 181, amplitude: 7.0, angle: 0.31, stretch: 0.83, phaseU: 1.7, phaseV: 4.1 },
  { wavelength: 83.3, amplitude: 3.0, angle: 1.47, stretch: 1.21, phaseU: 5.3, phaseV: 0.6 },
  { wavelength: 37.1, amplitude: 1.1, angle: 2.63, stretch: 0.91, phaseU: 2.9, phaseV: 3.3 },
  { wavelength: 16.9, amplitude: 0.35, angle: 0.97, stretch: 1.13, phaseU: 0.4, phaseV: 5.9 },
  { wavelength: 7.3, amplitude: 0.08, angle: 2.11, stretch: 0.97, phaseU: 4.6, phaseV: 1.2 },
]);

/** A slow bend in the coordinates, so ridges meander rather than run straight. */
export const HILL_WARP = Object.freeze({ distance: 15, wavelengthX: 397, wavelengthZ: 443, phaseX: 0.8, phaseZ: 2.2 });

/** The default vertical scale: gentle enough to walk, steep enough to read as hills. */
export const HILLS_DEFAULT_SCALE = 0.7;

/** Exact bound on |height| at scale 1. */
export const HILLS_AMPLITUDE_SUM = HILL_OCTAVES.reduce((sum, octave) => sum + octave.amplitude, 0);

export function hillsHeightBounds(scale = HILLS_DEFAULT_SCALE) {
  const extent = Math.abs(scale) * HILLS_AMPLITUDE_SUM;
  return Object.freeze({ minimum: -extent, maximum: extent, span: extent * 2 });
}

export const SCALAR_OPS = Object.freeze({
  num: (value) => value,
  add: (a, b) => a + b,
  mul: (a, b) => a * b,
  sin: Math.sin,
  cos: Math.cos,
});

/** Arithmetic over TSL nodes. `TSL` is `THREE.TSL`, passed in so this module stays dependency-free. */
export function hillsNodeOps(TSL) {
  return Object.freeze({
    num: (value) => TSL.float(value),
    add: (a, b) => a.add(b),
    mul: (a, b) => a.mul(b),
    sin: (a) => TSL.sin(a),
    cos: (a) => TSL.cos(a),
  });
}

const TAU = Math.PI * 2;

/** Height in metres at world (x, z), evaluated with `ops`. */
export function hillsHeightWith(ops, x, z, scale = HILLS_DEFAULT_SCALE) {
  const { num, add, mul, sin, cos } = ops;
  const warpX = add(x, mul(num(HILL_WARP.distance),
    sin(add(mul(z, num(TAU / HILL_WARP.wavelengthZ)), num(HILL_WARP.phaseZ)))));
  const warpZ = add(z, mul(num(HILL_WARP.distance),
    cos(add(mul(x, num(TAU / HILL_WARP.wavelengthX)), num(HILL_WARP.phaseX)))));
  let height = num(0);
  for (const octave of HILL_OCTAVES) {
    const c = Math.cos(octave.angle);
    const s = Math.sin(octave.angle);
    const k = TAU / octave.wavelength;
    const u = add(mul(warpX, num(c * k)), mul(warpZ, num(-s * k)));
    const v = add(mul(warpX, num(s * k * octave.stretch)), mul(warpZ, num(c * k * octave.stretch)));
    height = add(height, mul(num(octave.amplitude * scale),
      mul(sin(add(u, num(octave.phaseU))), cos(add(v, num(octave.phaseV))))));
  }
  return height;
}

export function hillsHeightAt(x, z, scale = HILLS_DEFAULT_SCALE) {
  return hillsHeightWith(SCALAR_OPS, x, z, scale);
}

/** Unit upward normal by central differences, matching the grass's own estimate. */
export function hillsNormalAt(x, z, scale = HILLS_DEFAULT_SCALE, step = 0.25) {
  const dx = hillsHeightAt(x - step, z, scale) - hillsHeightAt(x + step, z, scale);
  const dz = hillsHeightAt(x, z - step, scale) - hillsHeightAt(x, z + step, scale);
  const y = step * 2;
  const length = Math.hypot(dx, y, dz);
  return [dx / length, y / length, dz / length];
}

/** TSL `worldXZ -> height` function for grass placement and ground displacement. */
export function createHillsHeightNode(TSL, scale = HILLS_DEFAULT_SCALE) {
  const ops = hillsNodeOps(TSL);
  return TSL.Fn(([worldXZ]) => hillsHeightWith(ops, worldXZ.x, worldXZ.y, scale));
}
