/**
 * The field sky's dependency-free scattering contract.
 *
 * This module is the scalar twin of `sky-nodes.js`, in the same relationship
 * `bedKeepsLawnAt` has to `bed-lawn-mask.js`: the arithmetic is written once
 * here, in plain JavaScript that `node --test` can run, and transcribed into
 * TSL there. Everything the shader needs to agree about -- the medium, the
 * ray/sphere geometry, and above all the three lookup-table parameterizations
 * -- lives in this file, because a lookup table whose write mapping and read
 * mapping disagree produces a sky that is merely *wrong* rather than broken,
 * and nothing on the GPU will say so.
 *
 * Units are kilometres and the planet is a sphere, so a direction only ever
 * enters through three cosines: `mu` against the local up, `muSun` for the sun
 * against the same up, and `nu` between view and sun. That reduction is what
 * makes a 2D sky-view table sufficient for a camera that stays on the ground.
 */

/**
 * Earth, as the real-time atmosphere literature parameterizes it: Rayleigh and
 * ozone coefficients from Bruneton's precomputed-scattering model, Mie as the
 * single clear-air haze term that model uses. Scattering and absorption are
 * per kilometre; scale heights are kilometres.
 */
export const ATMOSPHERE = Object.freeze({
  bottomRadius: 6360,
  topRadius: 6460,

  rayleighScattering: Object.freeze([5.802e-3, 13.558e-3, 33.1e-3]),
  rayleighScaleHeight: 8,

  // Mie extinction exceeds Mie scattering: haze absorbs as well as scatters,
  // and the difference is what keeps a hazy horizon from reading as a light
  // source.
  mieScattering: 3.996e-3,
  mieExtinction: 4.44e-3,
  mieScaleHeight: 1.2,
  mieAnisotropy: 0.8,

  // Ozone scatters nothing. It only absorbs, in a tent-shaped layer around
  // 25 km, and it is the reason a clear zenith is blue rather than violet.
  ozoneAbsorption: Object.freeze([0.65e-3, 1.881e-3, 0.085e-3]),
  ozoneCentre: 25,
  ozoneWidth: 15,

  // What the multiple-scattering table bounces light off. This page stands on
  // a lawn, so the ground under it is not Bruneton's neutral 0.3 grey: a green
  // planet puts green back into the sky near the horizon, which is the half of
  // the horizon colour that is not Rayleigh.
  groundAlbedo: Object.freeze([0.12, 0.18, 0.1]),

  // Above the atmosphere the sun is white by construction. Every warm cast the
  // field sees is Rayleigh taking blue out of the beam on the way down, which
  // is the whole point of transmitting it rather than authoring it.
  solarIrradiance: Object.freeze([1, 1, 1]),
});

/**
 * Table sizes and sample counts. The three together are 424 KiB of RGBA16F and
 * are written once at startup, which is the entire steady-state cost of this
 * sky: a lit fragment pays one bilinear fetch of `skyView`.
 */
export const SKY_LUT = Object.freeze({
  transmittance: Object.freeze({ width: 256, height: 64, steps: 40 }),
  multiScatter: Object.freeze({
    width: 32,
    height: 32,
    steps: 20,
    sqrtSamples: 8,
  }),
  skyView: Object.freeze({ width: 256, height: 144, steps: 48 }),
});

/** Angular radius of the solar disk, radians. */
export const SUN_ANGULAR_RADIUS = 0.004675;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// --- the medium ------------------------------------------------------------

/** Rayleigh, Mie and ozone densities at `height` km above the ground. */
export function densitiesAt(height) {
  const h = Math.max(0, height);
  return {
    rayleigh: Math.exp(-h / ATMOSPHERE.rayleighScaleHeight),
    mie: Math.exp(-h / ATMOSPHERE.mieScaleHeight),
    ozone: Math.max(
      0,
      1 - Math.abs(h - ATMOSPHERE.ozoneCentre) / ATMOSPHERE.ozoneWidth,
    ),
  };
}

/**
 * Scattering and extinction at `height`, split by species because the two
 * scatter into different lobes and only their extinction adds.
 */
export function mediumAt(height) {
  const { rayleigh, mie, ozone } = densitiesAt(height);
  const scatteringRayleigh = [
    ATMOSPHERE.rayleighScattering[0] * rayleigh,
    ATMOSPHERE.rayleighScattering[1] * rayleigh,
    ATMOSPHERE.rayleighScattering[2] * rayleigh,
  ];
  const scatteringMie = ATMOSPHERE.mieScattering * mie;
  const extinctionMie = ATMOSPHERE.mieExtinction * mie;
  return {
    scatteringRayleigh,
    scatteringMie,
    extinction: [
      scatteringRayleigh[0] +
        extinctionMie +
        ATMOSPHERE.ozoneAbsorption[0] * ozone,
      scatteringRayleigh[1] +
        extinctionMie +
        ATMOSPHERE.ozoneAbsorption[1] * ozone,
      scatteringRayleigh[2] +
        extinctionMie +
        ATMOSPHERE.ozoneAbsorption[2] * ozone,
    ],
  };
}

// --- ray geometry ----------------------------------------------------------

/** Distance along (r, mu) to the outer shell. Always positive inside it. */
export function distanceToTop(r, mu) {
  const discriminant =
    r * r * (mu * mu - 1) + ATMOSPHERE.topRadius * ATMOSPHERE.topRadius;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, discriminant)));
}

/** Distance along (r, mu) to the ground, or -1 when the ray misses it. */
export function distanceToGround(r, mu) {
  const discriminant =
    r * r * (mu * mu - 1) + ATMOSPHERE.bottomRadius * ATMOSPHERE.bottomRadius;
  if (discriminant < 0 || mu >= 0) return -1;
  return Math.max(0, -r * mu - Math.sqrt(discriminant));
}

/** How far a ray travels before it leaves the medium, ground or shell. */
export function marchLength(r, mu) {
  const ground = distanceToGround(r, mu);
  return ground >= 0 ? ground : distanceToTop(r, mu);
}

/** Radius at distance `d` along (r, mu). */
export function radiusAt(r, mu, d) {
  return Math.sqrt(Math.max(0, d * d + 2 * r * mu * d + r * r));
}

// --- phase functions -------------------------------------------------------

export function rayleighPhase(cosTheta) {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
}

/**
 * Cornette-Shanks, not plain Henyey-Greenstein: at g = 0.8 the two agree in
 * the forward lobe and disagree at right angles, which is most of the sky.
 */
export function miePhase(cosTheta, g = ATMOSPHERE.mieAnisotropy) {
  const k = (3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g));
  const denominator = Math.pow(1 + g * g - 2 * g * cosTheta, 1.5);
  return (k * (1 + cosTheta * cosTheta)) / Math.max(1e-4, denominator);
}

// --- transmittance ---------------------------------------------------------

/** Transmittance from (r, mu) to wherever that ray leaves the medium. */
export function transmittance(r, mu, steps = SKY_LUT.transmittance.steps) {
  const length = marchLength(r, mu);
  const step = length / steps;
  const depth = [0, 0, 0];
  for (let index = 0; index < steps; index += 1) {
    const d = (index + 0.5) * step;
    const { extinction } = mediumAt(
      radiusAt(r, mu, d) - ATMOSPHERE.bottomRadius,
    );
    depth[0] += extinction[0] * step;
    depth[1] += extinction[1] * step;
    depth[2] += extinction[2] * step;
  }
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

// --- lookup-table parameterizations ----------------------------------------
//
// These six functions are the contract. Each pair must round-trip, and the
// texel-centre corrections must be applied on both sides, or the horizon row
// of every table is read from somewhere it was never written.

/** Unit range -> texture coordinate, addressing texel centres. */
export function toTexCoord(x, size) {
  return 0.5 / size + x * (1 - 1 / size);
}

/** Texture coordinate -> unit range. */
export function fromTexCoord(u, size) {
  return (u - 0.5 / size) / (1 - 1 / size);
}

const horizonChord = () =>
  Math.sqrt(
    ATMOSPHERE.topRadius * ATMOSPHERE.topRadius -
      ATMOSPHERE.bottomRadius * ATMOSPHERE.bottomRadius,
  );

/**
 * Bruneton's transmittance mapping: `v` is how far up the shell the sample is
 * and `u` is how long the ray to the top is, between the shortest possible
 * (straight up) and the longest (grazing the horizon). Mapping by *distance*
 * rather than by the cosine is what gives the horizon its resolution.
 */
export function transmittanceUV(r, mu) {
  const H = horizonChord();
  const rho = Math.sqrt(
    Math.max(0, r * r - ATMOSPHERE.bottomRadius * ATMOSPHERE.bottomRadius),
  );
  const d = distanceToTop(r, mu);
  const dMin = ATMOSPHERE.topRadius - r;
  const dMax = rho + H;
  return {
    u: toTexCoord(
      clamp((d - dMin) / Math.max(1e-6, dMax - dMin), 0, 1),
      SKY_LUT.transmittance.width,
    ),
    v: toTexCoord(clamp(rho / H, 0, 1), SKY_LUT.transmittance.height),
  };
}

/** The inverse of `transmittanceUV`, used when filling the table. */
export function transmittanceParams(u, v) {
  const H = horizonChord();
  const rho = clamp(fromTexCoord(v, SKY_LUT.transmittance.height), 0, 1) * H;
  const r = Math.sqrt(
    rho * rho + ATMOSPHERE.bottomRadius * ATMOSPHERE.bottomRadius,
  );
  const dMin = ATMOSPHERE.topRadius - r;
  const dMax = rho + H;
  const d =
    dMin +
    clamp(fromTexCoord(u, SKY_LUT.transmittance.width), 0, 1) * (dMax - dMin);
  const mu =
    d <= 0 ? 1 : clamp((H * H - rho * rho - d * d) / (2 * r * d), -1, 1);
  return { r, mu };
}

/** Multiple scattering is tabulated on sun elevation and altitude, linearly. */
export function multiScatterUV(r, muSun) {
  const height =
    (r - ATMOSPHERE.bottomRadius) /
    (ATMOSPHERE.topRadius - ATMOSPHERE.bottomRadius);
  return {
    u: toTexCoord(clamp(muSun * 0.5 + 0.5, 0, 1), SKY_LUT.multiScatter.width),
    v: toTexCoord(clamp(height, 0, 1), SKY_LUT.multiScatter.height),
  };
}

export function multiScatterParams(u, v) {
  const muSun =
    clamp(fromTexCoord(u, SKY_LUT.multiScatter.width), 0, 1) * 2 - 1;
  const height =
    clamp(fromTexCoord(v, SKY_LUT.multiScatter.height), 0, 1) *
    (ATMOSPHERE.topRadius - ATMOSPHERE.bottomRadius);
  return { r: ATMOSPHERE.bottomRadius + height, muSun: clamp(muSun, -1, 1) };
}

/**
 * The sky-view mapping, for one eye height and one sun.
 *
 * `u` is the azimuth away from the sun, warped by a square root so half the
 * columns cover the quarter-turn nearest the sun, where the Mie lobe lives.
 * `v` is the zenith angle, warped the other way so the rows bunch at the
 * horizon, where a hundred kilometres of air are compressed into a degree.
 *
 * Only the upper hemisphere is tabulated. At a 1.7 m eye the horizon is at
 * 90.003 degrees, so a "below the horizon" direction is looking at ground a
 * few metres away -- the terrain, the backdrop and the lawn are all in front
 * of it. Clamping to the horizon row costs nothing and removes the second,
 * ground-intersecting branch of the mapping entirely.
 */
export function skyViewUV(mu, cosAzimuthToSun) {
  const zenith = Math.acos(clamp(mu, -1, 1));
  const azimuth = Math.acos(clamp(cosAzimuthToSun, -1, 1));
  const x = Math.sqrt(azimuth / Math.PI);
  const upward = clamp(zenith / (Math.PI / 2), 0, 1);
  const y = 1 - Math.sqrt(Math.max(0, 1 - upward));
  return {
    u: toTexCoord(x, SKY_LUT.skyView.width),
    v: toTexCoord(y, SKY_LUT.skyView.height),
  };
}

export function skyViewParams(u, v) {
  const x = clamp(fromTexCoord(u, SKY_LUT.skyView.width), 0, 1);
  const y = clamp(fromTexCoord(v, SKY_LUT.skyView.height), 0, 1);
  const azimuth = x * x * Math.PI;
  const oneMinusY = 1 - y;
  const zenith = (1 - oneMinusY * oneMinusY) * (Math.PI / 2);
  return {
    zenith,
    azimuth,
    mu: Math.cos(zenith),
    cosAzimuthToSun: Math.cos(azimuth),
  };
}

// --- the tables ------------------------------------------------------------

/** Fills the transmittance table as the compute pass does, for tests. */
export function buildTransmittanceLUT() {
  const { width, height, steps } = SKY_LUT.transmittance;
  const data = new Float32Array(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const { r, mu } = transmittanceParams(
        (column + 0.5) / width,
        (row + 0.5) / height,
      );
      const value = transmittance(r, mu, steps);
      const offset = (row * width + column) * 3;
      data[offset] = value[0];
      data[offset + 1] = value[1];
      data[offset + 2] = value[2];
    }
  }
  return { data, width, height };
}

/** Bilinear read, matching the sampler the shader uses. */
export function sampleLUT(lut, u, v) {
  const { data, width, height } = lut;
  const x = clamp(u * width - 0.5, 0, width - 1);
  const y = clamp(v * height - 0.5, 0, height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const out = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const a = data[(y0 * width + x0) * 3 + channel];
    const b = data[(y0 * width + x1) * 3 + channel];
    const c = data[(y1 * width + x0) * 3 + channel];
    const d = data[(y1 * width + x1) * 3 + channel];
    out[channel] =
      (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  return out;
}

/** Transmittance towards the sun from (r, muSun), zero once the ground is in the way. */
export function sunTransmittance(lut, r, muSun) {
  if (distanceToGround(r, muSun) >= 0) return [0, 0, 0];
  const { u, v } = transmittanceUV(r, muSun);
  return lut ? sampleLUT(lut, u, v) : transmittance(r, muSun);
}

/**
 * One texel of the multiple-scattering table.
 *
 * Hillaire's construction: march the sphere of directions from the sample with
 * an isotropic phase, collecting both the second-order radiance `L` and the
 * fraction `f` of light a uniform field would have rescattered, then sum the
 * series as `L / (1 - f)`. It is the cheapest term that stops a clear horizon
 * from reading as dusk at noon.
 */
export function multiScatterAt(lut, r, muSun) {
  const { sqrtSamples, steps } = SKY_LUT.multiScatter;
  const sun = [Math.sqrt(Math.max(0, 1 - muSun * muSun)), muSun, 0];
  const radiance = [0, 0, 0];
  const rescattered = [0, 0, 0];
  const directions = sqrtSamples * sqrtSamples;

  for (let i = 0; i < sqrtSamples; i += 1) {
    for (let j = 0; j < sqrtSamples; j += 1) {
      const theta = (2 * Math.PI * (i + 0.5)) / sqrtSamples;
      const phi = Math.acos(1 - (2 * (j + 0.5)) / sqrtSamples);
      const dir = [
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ];
      const mu = dir[1];
      const nu = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
      const length = marchLength(r, mu);
      const step = length / steps;
      const throughput = [1, 1, 1];

      for (let sample = 0; sample < steps; sample += 1) {
        const d = (sample + 0.3) * step;
        const rd = radiusAt(r, mu, d);
        const muSunAt = clamp((r * muSun + d * nu) / Math.max(1e-6, rd), -1, 1);
        const medium = mediumAt(rd - ATMOSPHERE.bottomRadius);
        const sunT = sunTransmittance(lut, rd, muSunAt);
        for (let channel = 0; channel < 3; channel += 1) {
          const scattering =
            medium.scatteringRayleigh[channel] + medium.scatteringMie;
          const extinction = Math.max(1e-9, medium.extinction[channel]);
          const stepT = Math.exp(-extinction * step);
          // Analytic integral of scattering * transmittance across the step,
          // which is stable where a midpoint sample is not.
          const integrated = (scattering * (1 - stepT)) / extinction;
          radiance[channel] +=
            throughput[channel] *
            integrated *
            sunT[channel] *
            ATMOSPHERE.solarIrradiance[channel] *
            (1 / (4 * Math.PI));
          rescattered[channel] += throughput[channel] * integrated;
          throughput[channel] *= stepT;
        }
      }

      if (distanceToGround(r, mu) >= 0) {
        const groundMu = clamp(
          (r * muSun + length * nu) / ATMOSPHERE.bottomRadius,
          -1,
          1,
        );
        if (groundMu > 0) {
          const sunT = sunTransmittance(lut, ATMOSPHERE.bottomRadius, groundMu);
          for (let channel = 0; channel < 3; channel += 1) {
            radiance[channel] +=
              throughput[channel] *
              sunT[channel] *
              groundMu *
              (ATMOSPHERE.groundAlbedo[channel] / Math.PI) *
              ATMOSPHERE.solarIrradiance[channel];
          }
        }
      }
    }
  }

  const out = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const L = radiance[channel] / directions;
    const f = rescattered[channel] / directions;
    out[channel] = L / Math.max(1e-4, 1 - f);
  }
  return out;
}

/** Fills the multiple-scattering table as the compute pass does. */
export function buildMultiScatterLUT(transmittanceLut) {
  const { width, height } = SKY_LUT.multiScatter;
  const data = new Float32Array(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const { r, muSun } = multiScatterParams(
        (column + 0.5) / width,
        (row + 0.5) / height,
      );
      const value = multiScatterAt(transmittanceLut, r, muSun);
      const offset = (row * width + column) * 3;
      data[offset] = value[0];
      data[offset + 1] = value[1];
      data[offset + 2] = value[2];
    }
  }
  return { data, width, height };
}

// --- the sky --------------------------------------------------------------

/**
 * In-scattered radiance along a view ray, single scattering plus the tabulated
 * multiple-scattering term. This is the arithmetic the sky-view compute pass
 * runs, once per texel.
 *
 * `mu` is the view's cosine against up, `muSun` the sun's, `nu` the cosine
 * between them.
 */
export function inScattering({
  r,
  mu,
  muSun,
  nu,
  transmittanceLut = null,
  multiScatterLut = null,
  multiScatter = 1,
  steps = SKY_LUT.skyView.steps,
}) {
  const length = marchLength(r, mu);
  const step = length / steps;
  const phaseR = rayleighPhase(nu);
  const phaseM = miePhase(nu);
  const throughput = [1, 1, 1];
  const radiance = [0, 0, 0];

  for (let sample = 0; sample < steps; sample += 1) {
    const d = (sample + 0.3) * step;
    const rd = radiusAt(r, mu, d);
    const muSunAt = clamp((r * muSun + d * nu) / Math.max(1e-6, rd), -1, 1);
    const medium = mediumAt(rd - ATMOSPHERE.bottomRadius);
    const sunT = sunTransmittance(transmittanceLut, rd, muSunAt);
    const ms = multiScatterLut
      ? sampleLUT(
          multiScatterLut,
          ...Object.values(multiScatterUV(rd, muSunAt)),
        )
      : [0, 0, 0];

    for (let channel = 0; channel < 3; channel += 1) {
      const rayleigh = medium.scatteringRayleigh[channel];
      const mie = medium.scatteringMie;
      const extinction = Math.max(1e-9, medium.extinction[channel]);
      const stepT = Math.exp(-extinction * step);
      const source =
        (rayleigh * phaseR + mie * phaseM) *
          sunT[channel] *
          ATMOSPHERE.solarIrradiance[channel] +
        (rayleigh + mie) * ms[channel] * multiScatter;
      radiance[channel] +=
        (throughput[channel] * source * (1 - stepT)) / extinction;
      throughput[channel] *= stepT;
    }
  }

  return radiance;
}

/**
 * Sky radiance for a world-space view direction, +Y up.
 *
 * The runtime samples the sky-view table instead; this is the reference the
 * table is held to, and what the HUD reports so the numbers on screen come
 * from the same model the pixels do.
 */
export function skyRadiance({
  direction,
  sunDirection,
  eyeHeightKm = 0.0017,
  transmittanceLut = null,
  multiScatterLut = null,
  multiScatter = 1,
  steps = SKY_LUT.skyView.steps,
}) {
  const r = ATMOSPHERE.bottomRadius + Math.max(0, eyeHeightKm);
  const mu = clamp(direction[1], -1, 1);
  const muSun = clamp(sunDirection[1], -1, 1);
  const nu = clamp(
    direction[0] * sunDirection[0] +
      direction[1] * sunDirection[1] +
      direction[2] * sunDirection[2],
    -1,
    1,
  );
  return inScattering({
    r,
    mu,
    muSun,
    nu,
    transmittanceLut,
    multiScatterLut,
    multiScatter,
    steps,
  });
}

/**
 * The azimuth cosine the sky-view table is indexed by: the view and the sun
 * flattened onto the ground plane. Undefined straight up, where it does not
 * matter and is pinned to 1 so the zenith row stays continuous.
 */
export function cosAzimuthToSun(direction, sunDirection) {
  const vx = direction[0];
  const vz = direction[2];
  const sx = sunDirection[0];
  const sz = sunDirection[2];
  const vLength = Math.hypot(vx, vz);
  const sLength = Math.hypot(sx, sz);
  if (vLength < 1e-6 || sLength < 1e-6) return 1;
  return clamp((vx * sx + vz * sz) / (vLength * sLength), -1, 1);
}

/** Direct sunlight reaching the ground, transmitted through the whole column. */
export function sunRadianceAtGround(sunDirection, transmittanceLut = null) {
  const t = sunTransmittance(
    transmittanceLut,
    ATMOSPHERE.bottomRadius,
    clamp(sunDirection[1], -1, 1),
  );
  return [
    t[0] * ATMOSPHERE.solarIrradiance[0],
    t[1] * ATMOSPHERE.solarIrradiance[1],
    t[2] * ATMOSPHERE.solarIrradiance[2],
  ];
}

/** A unit sun direction from elevation and azimuth in degrees, +Y up. */
export function sunDirectionFrom(elevationDegrees, azimuthDegrees) {
  const elevation = (elevationDegrees * Math.PI) / 180;
  const azimuth = (azimuthDegrees * Math.PI) / 180;
  const horizontal = Math.cos(elevation);
  return [
    horizontal * Math.sin(azimuth),
    Math.sin(elevation),
    horizontal * Math.cos(azimuth),
  ];
}

/** Elevation and azimuth in degrees for a direction, the inverse of the above. */
export function sunAnglesOf(direction) {
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const y = clamp(direction[1] / length, -1, 1);
  return {
    elevation: (Math.asin(y) * 180) / Math.PI,
    azimuth:
      (Math.atan2(direction[0] / length, direction[2] / length) * 180) /
      Math.PI,
  };
}
