import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRASS_RINGS,
  TOTAL_GRASS_CANDIDATES,
  createRingState,
  ringDistance,
  ringForDistance,
  snapRingState,
  targetDensityAt,
  worldCellForSlot,
  worldCellRandom,
  worldCellSeed,
  slotForWorldCell,
  retentionAt,
  bladeTriangleCount,
  bladeVertexCount,
  grassTriangleCount,
} from '../src/grass/grid.js';
import { LAWN } from '../src/grass/preset.js';

test('the four persistent grids have fixed capacities', () => {
  assert.deepEqual(
    GRASS_RINGS.map(({ id, side, capacity, segments }) => ({
      id,
      side,
      capacity,
      segments,
    })),
    [
      { id: 'close', side: 162, capacity: 26_244, segments: 3 },
      { id: 'near', side: 642, capacity: 412_164, segments: 2 },
      { id: 'mid', side: 642, capacity: 412_164, segments: 2 },
      { id: 'far', side: 522, capacity: 272_484, segments: 1 },
    ],
  );
  assert.equal(TOTAL_GRASS_CANDIDATES, 1_123_056);
});

test('snapping mutates one control object only at cell boundaries', () => {
  const ring = GRASS_RINGS[0];
  const state = createRingState(ring);
  const identity = state;

  assert.equal(snapRingState(state, 0.001, -0.001), true);
  const origin = [state.originCellX, state.originCellZ];
  assert.equal(snapRingState(state, 0.024, -0.024), false);
  assert.deepEqual([state.originCellX, state.originCellZ], origin);

  assert.equal(snapRingState(state, 0.025, -0.024), true);
  assert.strictEqual(state, identity);
  assert.equal(state.originCellX, origin[0] + 1);
  assert.equal(state.originCellZ, origin[1]);
});

test('returning to a camera cell restores exactly the same world cells', () => {
  const state = createRingState(GRASS_RINGS[1]);
  snapRingState(state, 3.4, -9.2);
  const first = worldCellForSlot(state, 93_217, {});
  const remembered = { ...first };

  // Move beyond the whole window: overlapping cells now deliberately retain
  // their physical slot, so a shorter move need not replace this record.
  snapRingState(state, 131.7, 118.6);
  assert.notDeepEqual(worldCellForSlot(state, 93_217, {}), remembered);

  snapRingState(state, 3.4, -9.2);
  assert.deepEqual(worldCellForSlot(state, 93_217, {}), remembered);
});

test('world-cell randomness is deterministic and camera-history independent', () => {
  const a = worldCellRandom(-10, 4, 97);
  assert.equal(a, worldCellRandom(-10, 4, 97));
  assert.equal(a, 0.272232158575207);
  assert.notEqual(a, worldCellRandom(-9, 4, 97));
  assert.notEqual(a, worldCellRandom(-10, 4, 98));
});

test('every covered distance belongs to exactly one concentric ring', () => {
  assert.equal(ringDistance(3, 4), 5);
  for (let distance = 0; distance < 52; distance += 0.125) {
    const owners = GRASS_RINGS.filter(
      (ring) => distance >= ring.inner && distance < ring.outer,
    );
    assert.equal(owners.length, 1, `distance ${distance}`);
    assert.strictEqual(ringForDistance(distance), owners[0]);
  }
  assert.equal(ringForDistance(52), null);
  assert.equal(ringForDistance(-1), null);
});

test('target lawn density falls continuously with camera distance', () => {
  let previous = Infinity;
  for (let distance = 0; distance < 52; distance += 0.05) {
    const ring = ringForDistance(distance);
    const density = targetDensityAt(ring, distance);
    assert.ok(
      density <= previous + 1e-9,
      `${density} exceeded ${previous} at ${distance}`,
    );
    previous = density;
  }
  for (let i = 1; i < GRASS_RINGS.length; i++) {
    const previous = GRASS_RINGS[i - 1];
    const next = GRASS_RINGS[i];
    assert.ok(Math.abs(targetDensityAt(previous, previous.outer) -
      targetDensityAt(next, next.inner)) < 1e-9);
  }
  const far = GRASS_RINGS.at(-1);
  assert.equal(targetDensityAt(far, far.outer), 0);
});

test('a blade is counted as the triangles it actually submits', () => {
  // The tip segment closes to a point, so it is one triangle and not a quad:
  // `bladeVertexCount` drops the second, whose two upper vertices would
  // coincide. The two counts have to agree about that, because one builds the
  // indirect draw command and the other is what the HUD reports.
  for (const segments of [1, 2, 3, 8]) {
    assert.equal(bladeVertexCount(segments), bladeTriangleCount(segments) * 3);
    assert.equal(bladeVertexCount(segments, { ribbon: true }),
      bladeTriangleCount(segments, { ribbon: true }) * 3);
  }
  assert.deepEqual(
    GRASS_RINGS.map((ring) => bladeTriangleCount(ring.segments, ring)),
    [5, 2, 2, 1],
  );
});

test('the reported triangle count is per tiller, not per crown', () => {
  // The regression. The HUD used to compute `visible * segments * 2`: it
  // counted the dropped tip quad and it counted one blade where a crown grows
  // `LAWN.tillers`. A near crown reported 6 triangles against the 15 it
  // submits, so every density experiment was judged on a lawn that looked
  // 2.5x cheaper than it is.
  const visible = [1, 1, 1, 1];
  const wrong = GRASS_RINGS.reduce(
    (sum, ring) => sum + visible[ring.index] * ring.segments * 2,
    0,
  );
  assert.equal(wrong, 16);
  assert.equal(grassTriangleCount(visible, 1), 10);
  assert.equal(grassTriangleCount(visible, 3), 30);

  // Count each ring independently, including the restored close silhouette.
  for (const ring of GRASS_RINGS) {
    const single = GRASS_RINGS.map(candidate => Number(candidate === ring));
    assert.equal(grassTriangleCount(single, LAWN.tillers),
      bladeTriangleCount(ring.segments, ring) * LAWN.tillers);
  }
  assert.equal(grassTriangleCount(new Uint32Array(GRASS_RINGS.length), LAWN.tillers), 0);
});


test('close and near share crowns and the original 0–8 m density curve', () => {
  const [close, near, mid, far] = GRASS_RINGS;
  assert.equal(close.spacing, near.spacing);
  assert.equal(close.seedIndex, near.seedIndex);
  assert.equal(close.seedIndex, 0);
  assert.equal(mid.seedIndex, 0, 'mid selects crowns from the shared seed stream');
  assert.equal(far.seedIndex, 0, 'far selects crowns from the shared seed stream');
  const original = { ...near, inner: 0, outer: 8,
    densityInner: undefined, densityOuter: undefined };
  for (let distance = 0; distance <= 8; distance += 0.03125) {
    assert.equal(targetDensityAt(close, distance), targetDensityAt(original, distance));
    assert.equal(targetDensityAt(near, distance), targetDensityAt(original, distance));
    assert.equal(retentionAt(close, distance), retentionAt(near, distance));
  }

  // Different storage windows recover the same signed world cells and seed.
  // Width, yaw, tint, density retention and jitter all derive from this seed;
  // none may change merely because the camera crosses the shape boundary.
  const states = [close, near].map(createRingState);
  for (const state of states) snapRingState(state, -0.137, 0.073);
  for (const [x, z] of [[0, 0], [-50, 45], [20, -22], [-1, -1]]) {
    const seeds = states.map(state => {
      const slot = slotForWorldCell(state.ring, x, z);
      const cell = worldCellForSlot(state, slot);
      assert.deepEqual(cell, { x, z });
      return worldCellSeed(cell.x, cell.z);
    });
    assert.equal(seeds[0], seeds[1]);
    assert.equal(seeds[0], worldCellSeed(x, z, 0));
  }
  assert.strictEqual(ringForDistance(2 - 1e-9), close);
  assert.strictEqual(ringForDistance(2), near);
  assert.strictEqual(ringForDistance(2 + 1e-9), near);
});
