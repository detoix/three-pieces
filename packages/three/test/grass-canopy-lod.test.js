import assert from 'node:assert/strict';
import test from 'node:test';
import { canopyWeightAt } from '../src/grass/canopy-lod.js';
import { GRASS_RINGS, ringForDistance, targetDensityAt } from '../src/grass/grid.js';

const pixelsPerMetreAtDepthOne = 1080 / (2 * Math.tan(62 * Math.PI / 360));
const base = {
  bladeWidth: 0.0034125,
  pixelScale: 1 / pixelsPerMetreAtDepthOne,
};
const weight = distance => canopyWeightAt({ ...base,
  horizontalDistance: distance, viewDepth: Math.hypot(distance, 1.7) });

test('canopy coverage is continuous across every geometric LOD boundary', () => {
  for (const ring of GRASS_RINGS) {
    const left = weight(ring.outer - 1e-5);
    const right = weight(ring.outer + 1e-5);
    assert.ok(Math.abs(left - right) < 1e-5, `${ring.id}: ${left} -> ${right}`);
  }
  let previous = 0;
  for (let distance = 0; distance <= 60; distance += 0.05) {
    const next = weight(distance);
    assert.ok(next >= 0 && next <= 1);
    assert.ok(next >= previous - 1e-10, 'retreating from turf cannot resolve more detail');
    previous = next;
  }
});

test('unrepresented geometry has a canopy even at high resolution', () => {
  for (const distance of [3, 4, 6, 8, 12, 24, 40, 52]) {
    const ring = ringForDistance(distance);
    const density = ring ? targetDensityAt(ring, distance) : 0;
    const missing = 1 - density / GRASS_RINGS[0].densityNear;
    const actual = canopyWeightAt({ ...base, horizontalDistance: distance,
      viewDepth: Math.hypot(distance, 1.7), pixelScale: base.pixelScale / 100 });
    assert.ok(Math.abs(actual - missing) < 1e-12);
  }
  assert.ok(weight(4) > 0.5, 'the former bare 3–8 m zone must receive canopy');
  assert.ok(weight(8) > 0.99);
});

test('physical projected size responds consistently to resolution and blade width', () => {
  const pose = { horizontalDistance: 3, viewDepth: 3.5 };
  const reference = canopyWeightAt({ ...base, ...pose });
  const doubleWidth = canopyWeightAt({ ...base, ...pose, bladeWidth: base.bladeWidth * 2 });
  const doubleResolution = canopyWeightAt({ ...base, ...pose, pixelScale: base.pixelScale / 2 });
  assert.equal(doubleWidth, doubleResolution);
  assert.ok(doubleResolution < reference, 'more resolved blades need less canopy proxy');
  assert.equal(canopyWeightAt({ ...base, ...pose,
    bladeWidth: base.bladeWidth * 2, pixelScale: base.pixelScale * 2 }), reference);
});
