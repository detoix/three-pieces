import assert from 'node:assert/strict';
import test from 'node:test';

import { ATMOSPHERE, sunDirectionFrom } from '../src/sky/atmosphere.js';
import {
  CLOUD_LIGHTING,
  cloudAmbient,
  cloudGroundBounce,
  cloudInScattering,
  cloudMultiPhase,
  cloudPhase,
  cloudSunScattering,
  phaseHG,
} from '../src/sky/cloud-lighting.js';

// The scalar contract `clouds.js` transcribes. No test here runs a shader:
// these hold the properties the look was tuned on, so a constant that breaks
// one of them fails here instead of in a recording.

// The probe the demo's shipped sun produces (see `lights.js`).
const SUN = [0.923, 0.83, 0.7];
const SKY = [0.0314, 0.0646, 0.127];
const SUN_HEIGHT = sunDirectionFrom(49.139, 54.689)[1];

/** Integral over the sphere of a phase function of the cosine alone. */
function overSphere(phase, steps = 40000) {
  let sum = 0;
  for (let i = 0; i < steps; i += 1) sum += phase(-1 + ((i + 0.5) * 2) / steps);
  return 2 * Math.PI * sum * (2 / steps);
}

test('every phase lobe integrates to one over the sphere', () => {
  for (const g of [CLOUD_LIGHTING.forwardG, CLOUD_LIGHTING.backG, CLOUD_LIGHTING.msG, 0]) {
    assert.ok(Math.abs(overSphere((mu) => phaseHG(mu, g)) - 1) < 1e-3, `g ${g}`);
  }
  assert.ok(Math.abs(overSphere(cloudPhase) - 1) < 1e-3, 'the dual lobe is a mix of normalized lobes');
  // The multiple-scattering phase carries its weight, and nothing else.
  assert.ok(Math.abs(overSphere(cloudMultiPhase) - CLOUD_LIGHTING.msWeight) < 1e-3);
});

test('single scattering keeps its silver lining toward the sun', () => {
  assert.ok(cloudPhase(0.95) > 5 * cloudPhase(-0.5));
  // Thin cloud against the sun outshines the same cloud seen from the sun's
  // side: that is the lining, and the multiple scattering must not drown it.
  const edge = { opticalDepth: 0.2, density: 0.5 };
  assert.ok(cloudSunScattering({ ...edge, mu: 0.95 }) > 1.5 * cloudSunScattering({ ...edge, mu: -0.5 }));
});

test('sunlight inside a cloud never grows with depth toward the sun', () => {
  for (const mu of [-1, -0.5, 0, 0.5, 0.95]) {
    for (const density of [0.05, 0.5, 3]) {
      let previous = Infinity;
      for (let tau = 0; tau <= 60; tau += 0.25) {
        const value = cloudSunScattering({ opticalDepth: tau, density, mu });
        assert.ok(value <= previous + 1e-12, `mu ${mu} density ${density} tau ${tau}`);
        previous = value;
      }
    }
  }
});

test('a shaded side stays lit by diffused light, not by Beer alone', () => {
  // An exponential in the optical depth to the sun is what let one far sun
  // sample stamp a dark patch. Diffusion falls off algebraically: twenty
  // optical depths in, a body still keeps a tangible share of its lit face --
  // 2.5% or more seen from the side or with the sun behind the eye, and less
  // looking into the sun, where the lit face carries the silver lining and a
  // backlit cumulus shows its darkest core against its brightest rim.
  for (const [mu, floor] of [[-1, 0.025], [-0.5, 0.025], [0.3, 0.025], [0.9, 0.01], [1, 0.005]]) {
    const lit = cloudSunScattering({ opticalDepth: 0, density: 3, mu });
    const shaded = cloudSunScattering({ opticalDepth: 20, density: 3, mu });
    const ratio = shaded / lit;
    assert.ok(ratio > floor, `mu ${mu}: ${ratio} of the lit face is a black hole, not a shaded side`);
    assert.ok(ratio < 0.3, `mu ${mu}: ${ratio} of the lit face has no shading left`);
    assert.ok(ratio > 1e6 * Math.exp(-20), 'algebraic, not exponential');
  }
});

test('powder darkens a thin fringe seen from the sun side, and only then', () => {
  const at = (density, mu) => cloudSunScattering({ opticalDepth: 1, density, mu });
  // Away from the sun a wisp is well below the body behind it...
  assert.ok(at(0.05, -1) < 0.5 * at(3, -1));
  // ...and looking straight at the sun density makes no difference at all.
  assert.equal(at(0.05, 1), at(3, 1));
  // The darkening is a fraction of the light, never more than all of it.
  assert.ok(at(0, -1) > 0);
});

test('bases see the lit lawn and tops see the sky', () => {
  const ground = cloudGroundBounce({ sun: SUN, sky: SKY, sunHeight: SUN_HEIGHT });
  const base = cloudAmbient({ sky: SKY, ground, height: 0 });
  const top = cloudAmbient({ sky: SKY, ground, height: 1 });
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(
      Math.abs(base[channel] - (SKY[channel] * CLOUD_LIGHTING.skyAmbientBase + ground[channel])) < 1e-12,
      'the base takes the whole ground term',
    );
    assert.ok(
      Math.abs(top[channel] - SKY[channel] * CLOUD_LIGHTING.skyAmbientTop) < 1e-12,
      'the top takes none of it',
    );
  }
  // The lawn is green, so what it sends up is too, and it is the reason a
  // base is less blue than a top.
  assert.ok(ground[1] > ground[0] && ground[1] > ground[2]);
  assert.ok(base[2] / base[0] < top[2] / top[0]);
});

test('the ground bounce is the atmosphere\'s own lawn, and goes with the sun', () => {
  assert.deepEqual([...CLOUD_LIGHTING.groundAlbedo], [...ATMOSPHERE.groundAlbedo]);
  const noon = cloudGroundBounce({ sun: SUN, sky: SKY, sunHeight: 1 });
  const low = cloudGroundBounce({ sun: SUN, sky: SKY, sunHeight: 0.2 });
  const set = cloudGroundBounce({ sun: SUN, sky: SKY, sunHeight: -0.3 });
  const skyOnly = cloudGroundBounce({ sun: [0, 0, 0], sky: SKY, sunHeight: 1 });
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(noon[channel] > low[channel] && low[channel] > set[channel]);
    assert.ok(Math.abs(set[channel] - skyOnly[channel]) < 1e-12, 'a set sun lights no lawn');
  }
});

test('a sample is sunlight scattered to the eye plus the ambient it sits in', () => {
  const sample = { opticalDepth: 3, density: 2, mu: 0.4, height: 0.6, sun: SUN, sky: SKY, sunHeight: SUN_HEIGHT };
  const scattered = cloudSunScattering(sample);
  const ambient = cloudAmbient({ sky: SKY, ground: cloudGroundBounce(sample), height: 0.6 });
  const lit = cloudInScattering(sample);
  const dark = cloudInScattering({ ...sample, sunUp: 0 });
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(Math.abs(lit[channel] - (SUN[channel] * scattered + ambient[channel])) < 1e-12);
    assert.ok(Math.abs(dark[channel] - ambient[channel]) < 1e-12, 'below the horizon only ambient is left');
  }
});

test('the lighting constants stay in the ranges their comments argue for', () => {
  const L = CLOUD_LIGHTING;
  assert.ok(Object.isFrozen(L));
  assert.ok(L.forwardG > 0 && L.backG < 0 && L.forwardWeight > 0.5 && L.forwardWeight < 1);
  assert.ok(L.msFalloff > 0 && L.msWeight > 0);
  assert.ok(L.powder > 0 && L.powderStrength >= 0 && L.powderStrength <= 1);
  assert.ok(L.skyAmbientBase < L.skyAmbientTop);
  assert.ok(L.groundShadow > 0 && L.groundShadow <= 1);
});
