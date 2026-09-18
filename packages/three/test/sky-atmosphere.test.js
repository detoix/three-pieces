import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ATMOSPHERE,
  SKY_LUT,
  buildTransmittanceLUT,
  cosAzimuthToSun,
  distanceToGround,
  distanceToTop,
  fromTexCoord,
  mediumAt,
  miePhase,
  multiScatterParams,
  multiScatterUV,
  rayleighPhase,
  sampleLUT,
  skyRadiance,
  skyViewParams,
  skyViewUV,
  sunAnglesOf,
  sunDirectionFrom,
  sunRadianceAtGround,
  toTexCoord,
  transmittance,
  transmittanceParams,
  transmittanceUV,
} from '../src/sky/atmosphere.js';
import {
  AUTHORED_SKY,
  AUTHORED_SUN,
  SKY_ANCHOR,
  SUN_ANCHOR,
  relativeLuminance,
} from '../src/sky/lights.js';

/**
 * `atmosphere.js` is the scalar twin of the sky's TSL: the arithmetic lives
 * once in plain JavaScript these tests can run and is transcribed into the
 * shader. They cover what a GPU cannot be asked about from here.
 *
 * The three lookup-table parameterizations get the most attention, because
 * they are the failure nobody sees: a table whose write mapping and read
 * mapping disagree still renders a smooth, plausible, wrong sky, and there is
 * no error anywhere. Everything else here is a physical invariant -- that the
 * air thins upward, that a longer path through it transmits less, that the
 * zenith is bluer than the horizon -- which is all a CPU can check about a
 * picture it will never draw.
 */

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// --- the medium ------------------------------------------------------------

test('the atmosphere thins upward and ozone sits in a layer', () => {
  const ground = mediumAt(0);
  const high = mediumAt(20);
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(
      high.extinction[channel] < ground.extinction[channel],
      `extinction should fall with height in channel ${channel}`,
    );
  }

  // Rayleigh scatters blue hardest. That ordering is the sky's colour and
  // nothing downstream recovers if it is ever inverted.
  assert.ok(ground.scatteringRayleigh[2] > ground.scatteringRayleigh[1]);
  assert.ok(ground.scatteringRayleigh[1] > ground.scatteringRayleigh[0]);

  // Mie absorbs as well as scattering, so it can never be a source of light.
  assert.ok(ATMOSPHERE.mieExtinction > ATMOSPHERE.mieScattering);

  // Ozone is a tent, not an exponential: it peaks well above the ground.
  const ozoneAt = (height) =>
    mediumAt(height).extinction[1] - mediumAt(height).scatteringRayleigh[1];
  assert.ok(mediumAt(25).extinction[1] > 0);
  assert.equal(
    ozoneAt(ATMOSPHERE.ozoneCentre + ATMOSPHERE.ozoneWidth) <= 1e-12,
    true,
  );
  assert.ok(ozoneAt(25) > ozoneAt(45));
});

// --- ray geometry ----------------------------------------------------------

test('a ray to the top is longest along the horizon and shortest straight up', () => {
  const r = ATMOSPHERE.bottomRadius;
  const up = distanceToTop(r, 1);
  const grazing = distanceToTop(r, 0);
  assert.ok(Math.abs(up - (ATMOSPHERE.topRadius - r)) < 1e-6);
  assert.ok(grazing > up * 10, `${grazing} should dwarf ${up}`);
});

test('the ground is only ever hit by a ray pointing into it', () => {
  const r = ATMOSPHERE.bottomRadius + 0.0017;
  assert.equal(distanceToGround(r, 0.5), -1);
  assert.equal(distanceToGround(r, 0), -1);
  // At 1.7 m the horizon is 90.003 degrees, so a ray a thousandth below level
  // still misses and one a hundredth below does not.
  assert.equal(distanceToGround(r, -1e-6), -1);
  assert.ok(distanceToGround(r, -0.01) > 0);
});

// --- transmittance ---------------------------------------------------------

test('transmittance falls with path length and keeps red longest', () => {
  const r = ATMOSPHERE.bottomRadius;
  const zenith = transmittance(r, 1);
  const low = transmittance(r, 0.1);
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(zenith[channel] > low[channel]);
    assert.ok(zenith[channel] > 0 && zenith[channel] <= 1);
  }
  // The whole reason the sun is warm at the bottom of the air rather than
  // authored warm: blue is taken out of the beam, not added to the light.
  assert.ok(zenith[0] > zenith[1] && zenith[1] > zenith[2]);
  assert.ok(low[0] / low[2] > zenith[0] / zenith[2]);
});

// --- the three parameterizations ------------------------------------------

test('texel-centre mapping round-trips', () => {
  for (const size of [32, 64, 144, 256]) {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      assert.ok(Math.abs(fromTexCoord(toTexCoord(x, size), size) - x) < 1e-9);
    }
    // The ends address the first and last texel centres, never the border.
    assert.ok(Math.abs(toTexCoord(0, size) - 0.5 / size) < 1e-12);
    assert.ok(Math.abs(toTexCoord(1, size) - (1 - 0.5 / size)) < 1e-12);
  }
});

test('the transmittance mapping round-trips over the whole table', () => {
  const { width, height } = SKY_LUT.transmittance;
  let worstR = 0;
  let worstMu = 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const u = (column + 0.5) / width;
      const v = (row + 0.5) / height;
      const { r, mu } = transmittanceParams(u, v);
      assert.ok(
        r >= ATMOSPHERE.bottomRadius - 1e-6 && r <= ATMOSPHERE.topRadius + 1e-6,
        `radius ${r} left the atmosphere`,
      );
      const back = transmittanceUV(r, mu);
      worstR = Math.max(worstR, Math.abs(back.v - v));
      worstMu = Math.max(worstMu, Math.abs(back.u - u));
    }
  }
  assert.ok(worstR < 1e-6, `radius round-trip drifted ${worstR}`);
  assert.ok(worstMu < 1e-6, `cosine round-trip drifted ${worstMu}`);
});

test('the multiple-scattering mapping round-trips', () => {
  const { width, height } = SKY_LUT.multiScatter;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const u = (column + 0.5) / width;
      const v = (row + 0.5) / height;
      const { r, muSun } = multiScatterParams(u, v);
      const back = multiScatterUV(r, muSun);
      assert.ok(Math.abs(back.u - u) < 1e-9);
      assert.ok(Math.abs(back.v - v) < 1e-9);
    }
  }
});

test('the sky-view mapping round-trips and bunches its rows at the horizon', () => {
  const { width, height } = SKY_LUT.skyView;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const u = (column + 0.5) / width;
      const v = (row + 0.5) / height;
      const { mu, cosAzimuthToSun: cosAzimuth } = skyViewParams(u, v);
      const back = skyViewUV(mu, cosAzimuth);
      assert.ok(Math.abs(back.u - u) < 1e-6, `azimuth drifted at ${u}`);
      assert.ok(Math.abs(back.v - v) < 1e-6, `zenith drifted at ${v}`);
    }
  }

  // The warps are the point. Half the columns cover the quarter-turn nearest
  // the sun, and the last rows are worth a fraction of a degree each.
  const halfway = skyViewParams(0.5, 0.5);
  assert.ok(
    (halfway.azimuth * 180) / Math.PI < 50,
    'half the columns should be inside 50 degrees of the sun',
  );
  const lastRow = skyViewParams(0.5, (height - 0.5) / height);
  const penultimate = skyViewParams(0.5, (height - 1.5) / height);
  const firstStep =
    ((skyViewParams(0.5, 1.5 / height).zenith -
      skyViewParams(0.5, 0.5 / height).zenith) *
      180) /
    Math.PI;
  const lastStep = ((lastRow.zenith - penultimate.zenith) * 180) / Math.PI;
  assert.ok(
    lastStep < firstStep / 10,
    `${lastStep} should be far finer than ${firstStep}`,
  );
  assert.ok(Math.abs((lastRow.zenith * 180) / Math.PI - 90) < 0.05);
});

test('a table read back where it was written reproduces the analytic answer', () => {
  // The mapping and the sampler are only correct together. Filling the table
  // through one and reading it through the other is the only way to catch a
  // half-texel offset, which is exactly the bug that renders as a plausible
  // sky nobody questions.
  const lut = buildTransmittanceLUT();
  let worst = 0;
  for (const r of [
    ATMOSPHERE.bottomRadius,
    ATMOSPHERE.bottomRadius + 2,
    ATMOSPHERE.bottomRadius + 30,
  ]) {
    for (let mu = -0.2; mu <= 1; mu += 0.05) {
      if (distanceToGround(r, mu) >= 0) continue;
      const { u, v } = transmittanceUV(r, mu);
      const sampled = sampleLUT(lut, u, v);
      const exact = transmittance(r, mu);
      for (let channel = 0; channel < 3; channel += 1) {
        worst = Math.max(worst, Math.abs(sampled[channel] - exact[channel]));
      }
    }
  }
  assert.ok(
    worst < 0.02,
    `table and analytic transmittance differ by ${worst}`,
  );
});

// --- phase functions -------------------------------------------------------

test('both phase functions integrate to one over the sphere', () => {
  for (const phase of [rayleighPhase, miePhase]) {
    let total = 0;
    const steps = 20000;
    for (let index = 0; index < steps; index += 1) {
      // Uniform in cos(theta): d(omega) = 2 * pi * d(cos theta).
      const cosTheta = -1 + (2 * (index + 0.5)) / steps;
      total += phase(cosTheta) * 2 * Math.PI * (2 / steps);
    }
    assert.ok(Math.abs(total - 1) < 0.02, `phase integrated to ${total}`);
  }
  // Mie is the forward lobe; Rayleigh is symmetric.
  assert.ok(miePhase(1) > miePhase(-1) * 50);
  assert.ok(Math.abs(rayleighPhase(1) - rayleighPhase(-1)) < 1e-12);
});

// --- the sky it makes ------------------------------------------------------

test('the zenith is blue, the horizon is pale, and the horizon is brighter', () => {
  const lut = buildTransmittanceLUT();
  const sun = sunDirectionFrom(49.135, 54.68);
  const at = (direction) =>
    skyRadiance({ direction, sunDirection: sun, transmittanceLut: lut });

  const zenith = at([0, 1, 0]);
  const horizon = at([
    Math.sin((54.68 * Math.PI) / 180),
    0.02,
    Math.cos((54.68 * Math.PI) / 180),
  ]);

  assert.ok(
    zenith[2] > zenith[1] && zenith[1] > zenith[0],
    'the zenith is blue',
  );
  assert.ok(
    zenith[2] / zenith[0] > 3,
    'the zenith should be strongly blue, not faintly',
  );
  assert.ok(
    horizon[2] / horizon[0] < zenith[2] / zenith[0],
    'a long path through air washes the blue out',
  );
  assert.ok(
    luminance(horizon) > luminance(zenith) * 2,
    'the horizon carries far more scattered light than the zenith',
  );
});

test('a lower sun reddens what reaches the ground', () => {
  const lut = buildTransmittanceLUT();
  const high = sunRadianceAtGround(sunDirectionFrom(60, 0), lut);
  const low = sunRadianceAtGround(sunDirectionFrom(6, 0), lut);
  assert.ok(luminance(low) < luminance(high));
  assert.ok(low[0] / low[2] > (high[0] / high[2]) * 3);
});

test('the planet shadows the scattering, and not only at the eye', () => {
  const lut = buildTransmittanceLUT();
  const zenith = [0, 1, 0];
  const day = skyRadiance({
    direction: zenith,
    sunDirection: sunDirectionFrom(49.135, 0),
    transmittanceLut: lut,
  });
  const night = skyRadiance({
    direction: zenith,
    sunDirection: sunDirectionFrom(-10, 0),
    transmittanceLut: lut,
  });

  // Not zero, and it should not be: the shadow test is run per sample, so the
  // top of a column 90 km up still sees a sun that has set for the eye. That
  // is the whole reason the test is per sample rather than per ray -- but at
  // ten degrees below the horizon what is left is nine orders down, which is
  // the number that says the test is being applied at all. A single-scattering
  // sky with no shadow test at all comes back within an order of daylight.
  for (const channel of night) assert.ok(channel > 0);
  assert.ok(
    luminance(night) < luminance(day) * 1e-6,
    `dusk came back at ${luminance(night) / luminance(day)} of noon`,
  );

  // Straight down from a 1.7 m eye the ground is 1.7 m away, so there is
  // essentially no air to scatter in.
  const underfoot = skyRadiance({
    direction: [0, -1, 0],
    sunDirection: sunDirectionFrom(49.135, 0),
    transmittanceLut: lut,
  });
  assert.ok(luminance(underfoot) < luminance(day) * 1e-3);
});

// --- the sun both systems share --------------------------------------------

test('the shipped sun offset survives the trip through angles', () => {
  const offset = [24, 34, 17];
  const distance = Math.hypot(...offset);
  const { elevation, azimuth } = sunAnglesOf(offset);
  const back = sunDirectionFrom(elevation, azimuth).map((c) => c * distance);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(
      Math.abs(back[axis] - offset[axis]) < 1e-9,
      `axis ${axis} came back as ${back[axis]}`,
    );
  }
  assert.ok(Math.abs(elevation - 49.135) < 0.01);
  assert.ok(Math.abs(azimuth - 54.68) < 0.01);
});

test('the azimuth cosine is pinned rather than undefined straight up', () => {
  const sun = sunDirectionFrom(49.135, 54.68);
  assert.equal(cosAzimuthToSun([0, 1, 0], sun), 1);
  assert.ok(cosAzimuthToSun(sun, sun) > 0.9999);
  const away = sunDirectionFrom(20, 54.68 + 180);
  assert.ok(cosAzimuthToSun(away, sun) < -0.9999);
});

// --- the dials -------------------------------------------------------------

// --- the lights the sky drives ---------------------------------------------

test('the light anchors still describe the lights they were measured from', () => {
  // `SUN_ANCHOR` and `SKY_ANCHOR` exist to reproduce these two luminances
  // exactly, at the shipped sun, from a probe taken on the GPU. Nothing on the
  // CPU can re-run that probe, so what is held here is the other half: the
  // authored values the anchors were divided out of. Change `#fff0cd`, 3.2,
  // `#e8f4e3` or 1.7 and this fails, which is the intended way to find out
  // that the anchors need re-measuring rather than discovering it in the hue.
  const toLinear = (channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const irradiance = (hex, intensity) =>
    [1, 3, 5]
      .map((at) => toLinear(parseInt(hex.slice(at, at + 2), 16) / 255))
      .map((channel) => channel * intensity);

  const sun = irradiance(AUTHORED_SUN.color, AUTHORED_SUN.intensity);
  const sky = irradiance(AUTHORED_SKY.color, AUTHORED_SKY.intensity);

  assert.ok(
    Math.abs(relativeLuminance(sun) - AUTHORED_SUN.luminance) < 1e-3,
    `the authored sun now measures ${relativeLuminance(sun).toFixed(4)}, not ` +
      `the ${AUTHORED_SUN.luminance} the anchor was divided out of`,
  );
  assert.ok(
    Math.abs(relativeLuminance(sky) - AUTHORED_SKY.luminance) < 1e-3,
    `the authored sky now measures ${relativeLuminance(sky).toFixed(4)}, not ` +
      `the ${AUTHORED_SKY.luminance} the anchor was divided out of`,
  );

  // The recorded probe, so the anchors and the luminances stay one statement
  // rather than two numbers that happen to sit near each other.
  assert.ok(Math.abs(SUN_ANCHOR * 0.8407 - AUTHORED_SUN.luminance) < 5e-3);
  assert.ok(Math.abs(SKY_ANCHOR * 0.06205 - AUTHORED_SKY.luminance) < 5e-3);
});

test('the sun stays warmer than the sky it shares an atmosphere with', () => {
  // The reason the lights are worth deriving at all: at every elevation the
  // direct beam is red-leaning and the hemisphere is blue-leaning, because one
  // has had its blue scattered out and the other *is* the blue that was
  // scattered out. An implementation that got this backwards would still
  // produce a plausible-looking sky.
  const lut = buildTransmittanceLUT();
  for (const elevation of [60, 40, 20, 8]) {
    const sun = sunDirectionFrom(elevation, 0);
    const beam = sunRadianceAtGround(sun, lut);
    assert.ok(
      beam[0] / beam[2] > 1,
      `the beam is not red-leaning at ${elevation} degrees`,
    );
    const zenith = skyRadiance({
      direction: [0, 1, 0],
      sunDirection: sun,
      transmittanceLut: lut,
    });
    assert.ok(
      zenith[2] / zenith[0] > 1,
      `the sky is not blue-leaning at ${elevation} degrees`,
    );
  }
});

