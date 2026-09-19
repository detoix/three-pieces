import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANOPY_PULL_MAX,
  CLUMP_PULL_MARGIN,
  LAWN,
  LAWN_UNDERLAY,
  normalizeLawnUnderlay,
} from '@detoix/three-pieces/grass';
import { sunAnglesOf } from '@detoix/three-pieces/sky';
import { HILLS_DEFAULT_SCALE } from '@detoix/three-pieces/terrain';

import { readHillsOptions, readSceneOptions } from '../src/options.js';
import { describeWebGPUSupport } from '../src/webgpu-capability.js';

// The dials this demo puts on the package, and the gate that keeps an
// unsupported browser out of the runtime bundle.

test('the sky defaults leave the shipped sun exactly where it was', () => {
  const options = readSceneOptions('');
  const { elevation, azimuth } = sunAnglesOf([24, 34, 17]);
  assert.equal(options.sky, 'atmosphere');
  assert.equal(options.sunElevation, elevation);
  assert.equal(options.sunAzimuth, azimuth);
  assert.equal(options.skyMultiScatter, 1);

  // `?sky=flat` is the control and must reach back to the flat scene, which
  // means it may not quietly keep the atmosphere alive behind it.
  assert.equal(readSceneOptions('?sky=flat').sky, 'flat');
  assert.equal(readSceneOptions('?sky=anything').sky, 'atmosphere');

  const moved = readSceneOptions('?sunelevation=12&sunazimuth=-100&skyms=0');
  assert.equal(moved.sunElevation, 12);
  assert.equal(moved.sunAzimuth, -100);
  assert.equal(moved.skyMultiScatter, 0);
});

test('the sky exposure is clamped rather than allowed to black the image out', () => {
  assert.ok(readSceneOptions('?skyexposure=0').skyExposure >= 0.5);
  assert.ok(readSceneOptions('?skyexposure=1000').skyExposure <= 60);
  assert.equal(
    readSceneOptions('?skyexposure=nonsense').skyExposure,
    readSceneOptions('').skyExposure,
  );
});

test('the lighting A/B is reachable and defaults to on', () => {
  assert.equal(readSceneOptions('').skyLights, true);
  assert.equal(readSceneOptions('?skylights=off').skyLights, false);
  // Anything that is not the word `off` leaves the sky driving the lights, the
  // same way `?sky=` does, so a typo is a look and not a silent revert.
  assert.equal(readSceneOptions('?skylights=0').skyLights, true);
});

test('GPU timestamps are off unless a measurement asks for them by name', () => {
  // Timestamp capture and readback change cadence, so ordinary playback must
  // never pay for them: only the exact word `on` turns them on.
  assert.equal(readSceneOptions('').gpuTiming, false);
  assert.equal(readSceneOptions('?gputiming=on').gpuTiming, true);
  for (const value of ['1', 'true', 'yes', 'ON', '']) {
    assert.equal(readSceneOptions(`?gputiming=${value}`).gpuTiming, false, value);
  }
});

test('the posture dials cannot ask for a heading with no direction', () => {
  // `?clumppull=` and `?tillerfan=` are the A/B for how correlated
  // neighbouring blades are. The pull has the same forbidden band the preset
  // does -- within a tenth of 1 an opposed crown and clump cancel -- and
  // `createGPUDrivenGrass` throws on it, so the dial has to step over the band
  // rather than clamp into it.
  const posture = (search) => {
    const { clumpPull, tillerFan } = readSceneOptions(search, 1);
    return { clumpPull, tillerFan };
  };
  assert.deepEqual(posture(''), {
    clumpPull: 0.15,
    tillerFan: 1.8,
  });
  assert.deepEqual(posture('?clumppull=1.2&tillerfan=0.7'), {
    clumpPull: 1.2,
    tillerFan: 0.7,
  });
  for (const search of [
    '?clumppull=1',
    '?clumppull=0.95',
    '?clumppull=1.05',
    '?clumppull=1.09',
  ]) {
    const { clumpPull } = posture(search);
    assert.ok(
      Math.abs(clumpPull - 1) >= CLUMP_PULL_MARGIN,
      `${search} reached the shader as ${clumpPull}, inside the band where a ` +
        'crown heading opposed to its clump has nothing to normalize',
    );
  }
  assert.equal(posture('?clumppull=0').clumpPull, 0, 'zero is independent');
  assert.equal(posture('?tillerfan=0').tillerFan, 0, 'zero is a parallel tuft');
});

test('the canopy dial reaches its cap and stops there', () => {
  const canopyOf = (search) => readSceneOptions(search, 1).canopy;
  assert.equal(canopyOf(''), 1.3, 'the maintained lawn aggregates unresolved blade normals');
  assert.equal(canopyOf('?canopy=0'), 0, 'zero is the blade-facing control');

  // The dial multiplies the preset pair, and the mix weight it produces has to
  // land inside the range `createGPUDrivenGrass` accepts however far it is
  // wound. It has to reach the cap, too, or the cap is not the dial's ceiling.
  const far = (search) => LAWN.canopyNormalFar * canopyOf(search);
  assert.ok(
    far('?canopy=99') >= CANOPY_PULL_MAX,
    'the dial cannot reach the pull the guard allows, so its ceiling is a ' +
      'number nobody chose',
  );
  assert.ok(
    Math.min(far('?canopy=99'), CANOPY_PULL_MAX) === CANOPY_PULL_MAX,
    'past the cap the runtime clamps rather than throwing at the guard',
  );
});

test('underlay modes are whitelisted with the PBR lawn as the default', () => {
  assert.equal(normalizeLawnUnderlay('solid'), 'solid');
  assert.equal(normalizeLawnUnderlay('lawn'), 'lawn');
  assert.equal(normalizeLawnUnderlay(''), 'lawn');
  assert.equal(normalizeLawnUnderlay('photographic'), 'lawn');

  assert.equal(readSceneOptions('', 2).underlay, 'lawn');
  assert.equal(
    readSceneOptions('?underlay=solid&terrain=flat', 2).underlay,
    'solid',
  );
  assert.equal(readSceneOptions('?underlay=unknown', 2).underlay, 'lawn');
});

test('tillering is a dial, and it is the cheap density lever', () => {
  assert.equal(readSceneOptions('', 1).tillers, LAWN.tillers);
  assert.equal(readSceneOptions('?tillers=3', 1).tillers, 3);
  assert.equal(readSceneOptions('?tillers=1', 1).tillers, 1);
  // Whole blades only, and clamped at both ends.
  assert.equal(readSceneOptions('?tillers=4.6', 1).tillers, 5);
  assert.equal(readSceneOptions('?tillers=0', 1).tillers, 1);
  assert.equal(readSceneOptions('?tillers=99', 1).tillers, 12);
  assert.equal(readSceneOptions('?tillers=abc', 1).tillers, LAWN.tillers);
});

test('capability gate explains HTTPS and WebGPU failures separately', () => {
  assert.deepEqual(
    describeWebGPUSupport({ secureContext: false, gpu: undefined }),
    {
      supported: false,
      code: 'insecure-context',
      message:
        'WebGPU requires HTTPS. Open this page through an HTTPS URL (or localhost), then reload it.',
    },
  );
  assert.equal(
    describeWebGPUSupport({ secureContext: true, gpu: undefined }).code,
    'webgpu-unavailable',
  );
  assert.equal(
    describeWebGPUSupport({ secureContext: true, gpu: {} }).supported,
    true,
  );
});

test('hills dials default to a walkable demo and clamp what a URL can ask for', () => {
  const defaults = readHillsOptions('');
  assert.equal(defaults.hills, HILLS_DEFAULT_SCALE);
  assert.equal(defaults.eye, 1.7);
  assert.equal(defaults.ui, true);
  assert.ok(defaults.hazeFar > defaults.hazeNear);

  const asked = readHillsOptions('?hills=9&eye=abc&ui=0&hazenear=500&hazefar=100');
  assert.equal(asked.hills, 2);
  assert.equal(asked.eye, 1.7);
  assert.equal(asked.ui, false);
  assert.ok(asked.hazeFar > asked.hazeNear, 'haze far is kept past haze near');
});
