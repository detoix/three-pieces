import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import { LAWN } from '../src/grass/preset.js';
import {
  GRASS_RINGS,
  TOTAL_GRASS_CANDIDATES,
} from '../src/grass/grid.js';
import {
  GRASS_RECORD_BYTES,
  GRASS_RECORD_WORDS,
  GRASS_VISIBLE_ID_BYTES,
  grassStorageFootprint,
} from '../src/grass/record-layout.js';

const UNORM16_MAX = 65_535;
const UNORM8_MAX = 255;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function unormRoundTrip(value, steps) {
  return Math.round(clamp(value, 0, 1) * steps) / steps;
}

function snorm16RoundTrip(value) {
  return Math.round(clamp(value, -1, 1) * 32_767) / 32_767;
}

function retentionRoundTrip(value) {
  const word = Math.min(Math.floor(clamp(value, 0, 1) * 65_536), UNORM16_MAX);
  return (word + 0.5) / 65_536;
}

function degreesBetween(a, b) {
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  return (Math.acos(dot) * 180) / Math.PI;
}

test('packed grass records have the promised fixed storage budget', () => {
  assert.equal(GRASS_RECORD_WORDS, 7);
  assert.equal(GRASS_RECORD_BYTES, 28);
  assert.equal(GRASS_VISIBLE_ID_BYTES, 4);

  const total = grassStorageFootprint(TOTAL_GRASS_CANDIDATES);
  assert.deepEqual(total, {
    recordBytes: 31_445_568,
    visibleIdBytes: 4_492_224,
    totalBytes: 35_937_792,
  });
  assert.deepEqual(
    GRASS_RINGS.map((ring) => grassStorageFootprint(ring.capacity).totalBytes),
    [839_808, 13_189_248, 13_189_248, 8_719_488],
  );
  assert.throws(() => grassStorageFootprint(-1), RangeError);
  assert.throws(() => grassStorageFootprint(1.5), RangeError);
});

test('world X/Z float bits survive the uint storage representation exactly', () => {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  for (const value of [-123.456, -0, 0, 0.025, 52.125, 1_024.75]) {
    view.setFloat32(0, value, true);
    const expected = view.getFloat32(0, true);
    const bits = view.getUint32(0, true);
    view.setUint32(0, bits, true);
    assert.ok(Object.is(view.getFloat32(0, true), expected));
  }
});

test('height, blade, yaw and appearance quantization stay below lawn-scale error budgets', () => {
  // A terrain spanning ±4.84 m, as a representative packing interval.
  const bounds = { minimum: -4.84, maximum: 4.84, span: 9.68 };

  const groundUnit = 0.438_271;
  const decodedGround =
    bounds.minimum + unormRoundTrip(groundUnit, UNORM16_MAX) * bounds.span;
  const exactGround = bounds.minimum + groundUnit * bounds.span;
  assert.ok(Math.abs(decodedGround - exactGround) <= bounds.span / 131_070);

  const bladeUnit = 0.728_319;
  const exactBlade =
    LAWN.minHeight + bladeUnit * (LAWN.maxHeight - LAWN.minHeight);
  const decodedBlade =
    LAWN.minHeight +
    unormRoundTrip(bladeUnit, UNORM16_MAX) * (LAWN.maxHeight - LAWN.minHeight);
  assert.ok(Math.abs(decodedBlade - exactBlade) <= 0.000_000_31);

  const yawUnit = 0.318_271;
  const yawError =
    Math.abs(unormRoundTrip(yawUnit, UNORM16_MAX) - yawUnit) * 360;
  assert.ok(yawError <= 0.002_75);

  for (const value of [0, 0.137, 0.5, 0.918, 1]) {
    assert.ok(Math.abs(unormRoundTrip(value, UNORM8_MAX) - value) <= 1 / 510);
  }
});

test('packed normals remain unit length and retention cannot survive zero density', () => {
  const original = [0.31, 0.9, -0.3];
  const originalLength = Math.hypot(...original);
  for (let index = 0; index < original.length; index += 1) {
    original[index] /= originalLength;
  }
  const x = snorm16RoundTrip(original[0]);
  const z = snorm16RoundTrip(original[2]);
  const y = Math.sqrt(Math.max(0, 1 - x * x - z * z));
  const decoded = [x, y, z];
  assert.ok(Math.abs(Math.hypot(...decoded) - 1) < 1e-12);
  assert.ok(degreesBetween(original, decoded) < 0.003);

  assert.ok(retentionRoundTrip(0) > 0);
  assert.ok(retentionRoundTrip(1) < 1);
  for (const value of [0, 0.001, 0.5, 0.999, 1]) {
    assert.ok(Math.abs(retentionRoundTrip(value) - value) <= 1 / 131_072);
  }
});

test('the record struct strides at seven words, not the eight a uvec2 costs', () => {
  // The trap this holds shut. WGSL rounds an array's stride up to its
  // element's alignment, and a `uvec2` aligns to eight bytes: the same seven
  // words of fields occupy seven words as scalars and eight with the pair in
  // them. The padding word is silent -- it costs 4.2 MiB across the three
  // rings and reads nowhere -- so the only thing that ever reports it is this.
  const { struct } = THREE.TSL;
  const fields = {
    groundBlade: 'uint',
    normalXZ: 'uint',
    yawWidth: 'uint',
    appearance: 'uint',
    clumpHealth: 'uint',
  };
  const scalarXZ = struct(
    { worldXBits: 'uint', worldZBits: 'uint', ...fields },
    'EzGrassRecordScalarXZ',
  );
  const pairedXZ = struct(
    { worldXZBits: 'uvec2', ...fields },
    'EzGrassRecordPairedXZ',
  );

  assert.equal(scalarXZ.getLength(), GRASS_RECORD_WORDS);
  assert.equal(pairedXZ.getLength(), GRASS_RECORD_WORDS + 1);
  assert.equal(
    (pairedXZ.getLength() - scalarXZ.getLength()) * 4 * TOTAL_GRASS_CANDIDATES,
    4_492_224,
  );
});

test('the clump word keeps a heading finer than the eye and a patch to a byte', () => {
  // Sixteen bits of clump heading, eight of clump shortening, eight of health.
  // The heading is the one that cannot be a byte: every crown in a clump takes
  // it, so quantizing it lands whole patches of lawn on the same step and the
  // open field grows a grain.
  const headingUnit = 0.318_271;
  const headingError =
    Math.abs(unormRoundTrip(headingUnit, UNORM16_MAX) - headingUnit) * 360;
  assert.ok(headingError <= 0.002_75);
  assert.ok(
    360 / UNORM8_MAX > 1,
    'a byte of heading steps more than a degree, which a clump makes visible',
  );

  // Shortening is a fraction of a blade and health is fed straight into a
  // smoothstep. Neither can spend more than a byte usefully.
  //
  // The quantity the byte sets is the *fraction*, not the millimetres. This
  // asserted the millimetres against a constant written for the earlier 4-8 cm
  // blade, so growing the blade to 5.5-10.5 cm failed it --
  // reporting a packing fault when the packing had not changed and the blade
  // had. What a byte has to be fine enough for is the eye, and the eye's limit
  // here is a pixel.
  const shortenStep = (1 - LAWN.clumpShortest) / UNORM8_MAX;
  assert.ok(
    shortenStep <= 0.001,
    `a byte splits the clump range into steps of ${(shortenStep * 100).toFixed(3)}% ` +
      'of a blade, which is a step in length a patch of crowns shares',
  );
  // A pixel covers `2 * tan(fov / 2) / rows` metres per metre of distance:
  // 1.67 mm at a metre, for the scene's 62-degree camera in a 720-row buffer.
  // A metre is about as close as a blade tip is ever rendered, so a step this
  // far under a pixel there is under one everywhere.
  const PIXEL_AT_ONE_METRE = 0.00167;
  const shortenTip = shortenStep * LAWN.maxHeight;
  assert.ok(
    shortenTip <= PIXEL_AT_ONE_METRE / 10,
    `a byte of clump shortening moves a tip by ${(shortenTip * 1000).toFixed(3)} mm, ` +
      `which is ${(shortenTip / PIXEL_AT_ONE_METRE).toFixed(2)} of a pixel at a metre`,
  );
  for (const value of [0, 0.137, 0.5, 0.918, 1]) {
    assert.ok(Math.abs(unormRoundTrip(value, UNORM8_MAX) - value) <= 1 / 510);
  }
});
