import assert from 'node:assert/strict';
import test from 'node:test';
import { GRASS_RINGS, hashUint, ringForDistance, targetDensityAt, worldCellSeed } from '../src/grass/grid.js';
import { GRASS_BASE_DENSITY, GRASS_BASE_SPACING,
  crownRetentionWord, nestedCrownCell } from '../src/grass/placement.js';

const [close, near, mid, far] = GRASS_RINGS;
const rankOf = crown => (crownRetentionWord(crown.x, crown.z) + .5) / 65_536 * GRASS_BASE_DENSITY;
const same = (a, b) => a.x === b.x && a.z === b.z;

function representedIn(ring, crown) {
  if (ring.id === 'close' || ring.id === 'near') return true;
  const midX = Math.floor(crown.x / 3), midZ = Math.floor(crown.z / 3);
  if (ring.id === 'mid') return same(crown, nestedCrownCell(ring, midX, midZ));
  return same(crown, nestedCrownCell(ring,
    Math.floor((midX * 3 + 1.5) / 8), Math.floor((midZ * 3 + 1.5) / 8)));
}

test('every coarse crown has the same fine identity and seeded appearance in finer rings', () => {
  for (const ring of [mid, far]) {
    for (let z = -60; z <= 60; z++) for (let x = -60; x <= 60; x++) {
      const crown = nestedCrownCell(ring, x, z);
      assert.deepEqual(nestedCrownCell(near, crown.x, crown.z), crown);
      assert.deepEqual(nestedCrownCell(close, crown.x, crown.z), crown);
      assert.ok(representedIn(mid, crown));
      if (ring === far) assert.ok(representedIn(far, crown));
      const again = nestedCrownCell(ring, x, z);
      assert.equal(worldCellSeed(crown.x, crown.z), worldCellSeed(again.x, again.z));
      assert.equal(crownRetentionWord(crown.x, crown.z), crownRetentionWord(again.x, again.z));
    }
  }
});

test('nested jitter stays inside its original allocation cell and existing tile bounds', () => {
  for (const ring of GRASS_RINGS) {
    const seen = new Set();
    for (const z of [-20_011, -81, -9, -2, -1, 0, 1, 2, 9, 81, 20_011]) {
      for (let x = -121; x <= 121; x++) {
        const crown = nestedCrownCell(ring, x, z);
        const key = `${crown.x},${crown.z}`;
        assert.ok(!seen.has(key), 'allocation cells must not alias the same crown');
        seen.add(key);
        const seed = worldCellSeed(crown.x, crown.z);
        const wx = (crown.x + .1 + .8 * hashUint(seed + 11)) * GRASS_BASE_SPACING;
        const wz = (crown.z + .1 + .8 * hashUint(seed + 23)) * GRASS_BASE_SPACING;
        assert.ok(wx >= x * ring.spacing - 1e-9 && wx < (x + 1) * ring.spacing + 1e-9);
        assert.ok(wz >= z * ring.spacing - 1e-9 && wz < (z + 1) * ring.spacing + 1e-9);
      }
    }
  }
});

test('packed rank cohorts keep exactly the nested candidates at ownership boundaries', () => {
  const cohorts = [0, 0, 0];
  const histogram = new Uint32Array(16);
  for (let z = -240; z < 240; z++) for (let x = -240; x < 240; x++) {
    const crown = { x, z };
    const word = crownRetentionWord(x, z), rank = rankOf(crown);
    assert.ok(Number.isInteger(word) && word >= 0 && word < 65_536);
    // An exactly representable midpoint survives the production pack/decode.
    assert.equal(Math.floor(Math.fround((word + .5) / 65_536) * 65_536), word);
    const inMid = representedIn(mid, crown), inFar = representedIn(far, crown);
    assert.equal(rank <= mid.densityNear, inMid, '8 m handover must preserve every crown');
    assert.equal(rank <= far.densityNear, inFar, '24 m handover must preserve every crown');
    assert.ok(rank > 0 && rank < GRASS_BASE_DENSITY, 'zero/full density must remove/keep all crowns');
    cohorts[inFar ? 0 : inMid ? 1 : 2]++;
    histogram[Math.floor(word / 4096)]++;
  }
  // 12 x 12 metres contains exactly 1/9 as many mid crowns and 1/64 as
  // many far crowns. No extra candidates or draw instances are introduced.
  assert.deepEqual(cohorts, [3600, 22_000, 204_800]);
  const total = 480 ** 2, expected = total / histogram.length;
  for (const count of histogram) assert.ok(Math.abs(count - expected) < 5 * Math.sqrt(expected),
    `rank distribution ${count} deviated from ${expected}`);
});

test('approaching only adds crowns through all rings and macro-density values', () => {
  const distances = [52, 51, 45, 35, 24.15, 24.001, 24, 23.999, 23.85,
    16, 8.15, 8.001, 8, 7.999, 7.85, 4, 2.15, 2.001, 2, 1.999, 1.85, 0];
  let retainedFar = 0, addedNear = 0;
  for (const macro of [.78, .89, 1]) {
    for (let z = -72; z <= 72; z++) for (let x = -72; x <= 72; x++) {
      const crown = { x, z }, rank = rankOf(crown);
      let wasVisible = false;
      for (const distance of distances) {
        const ring = ringForDistance(distance);
        const visible = ring !== null && representedIn(ring, crown) &&
          rank <= targetDensityAt(ring, distance) * macro;
        assert.ok(!wasVisible || visible,
          `existing crown ${x},${z} disappeared approaching ${distance} m at macro ${macro}`);
        if (visible && !wasVisible) {
          if (ring === far) retainedFar++;
          if (ring === near || ring === close) addedNear++;
        }
        wasVisible = visible;
      }
    }
  }
  assert.ok(retainedFar > 500 && addedNear > 30_000, 'exercise both retained and newly added crowns');
});
