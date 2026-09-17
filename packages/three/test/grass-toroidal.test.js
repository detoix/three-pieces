import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import {
  GRASS_RINGS, TOTAL_GRASS_CANDIDATES, createRingState, snapRingState,
  slotForWorldCell, worldCellForSlot, worldCellSeed,
} from '../src/grass/grid.js';
import { createGPUDrivenGrass } from '../src/grass/grass.js';
import { createFlatHeightMap } from '../src/grass/index.js';

const ring = { side: 8, capacity: 64, spacing: 1, index: 0 };
const key = (x, z) => `${x},${z}`;

function windowCells(state) {
  const cells = new Map();
  for (let z = state.originCellZ; z < state.originCellZ + state.ring.side; z++) {
    for (let x = state.originCellX; x < state.originCellX + state.ring.side; x++) {
      cells.set(key(x, z), { x, z });
    }
  }
  return cells;
}

function updatedCells(state) {
  const cells = [];
  for (const rect of state.updateRects) {
    for (let z = rect.z; z < rect.z + rect.height; z++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) cells.push({ x, z });
    }
  }
  return cells;
}

test('new strips exactly equal the new window minus the old one in every direction', () => {
  // Includes all +/- diagonals, zero components, partial overlap, a whole
  // side of movement, and teleports. Negative origins cross modulo seams.
  for (const [startX, startZ] of [[0, 0], [-11, -9], [7, -3]]) {
    for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) {
      const state = createRingState(ring);
      snapRingState(state, startX + .25, startZ + .25);
      const before = windowCells(state);
      const moved = snapRingState(state, startX + dx + .25, startZ + dz + .25);
      const after = windowCells(state);
      const expected = [...after.keys()].filter(cell => !before.has(cell)).sort();
      const actual = updatedCells(state).map(({ x, z }) => key(x, z));
      assert.equal(moved, dx !== 0 || dz !== 0);
      assert.equal(new Set(actual).size, actual.length, 'no duplicate corner writes');
      assert.deepEqual(actual.sort(), expected, `move ${dx},${dz} from ${startX},${startZ}`);
      assert.equal(state.updateCount, actual.length);
      assert.ok(state.updateRects.length <= 2);
      assert.equal(state.fullRefill, Math.abs(dx) >= ring.side || Math.abs(dz) >= ring.side);
    }
  }
});

test('initialization fills every slot and unchanged snapped cells schedule no work', () => {
  const state = createRingState(ring);
  assert.equal(snapRingState(state, -.75, 2.25), true);
  assert.equal(state.fullRefill, true);
  assert.equal(state.updateCount, ring.capacity);
  assert.equal(new Set(updatedCells(state).map(({ x, z }) => slotForWorldCell(ring, x, z))).size, ring.capacity);
  assert.equal(snapRingState(state, -.01, 2.99), false);
  assert.equal(state.updateCount, 0);
  assert.deepEqual(state.updateRects, []);
});

test('overlapping cells preserve their slot and seeded record across movement and return', () => {
  const state = createRingState(ring);
  const records = new Array(ring.capacity);
  const path = [[-9, -9], [-8, -8], [-7, -10], [0, 0], [1, -1], [2, 4],
    [2, 4], [40, -60], [-9, -9], [-10, -8]];
  const recordFor = ({ x, z }) => ({ x, z, seed: worldCellSeed(x, z, 97_531) });
  for (const [x, z] of path) {
    const previous = records.slice();
    snapRingState(state, x + .25, z + .25);
    const updates = updatedCells(state);
    const changedSlots = new Set(updates.map(cell => slotForWorldCell(ring, cell.x, cell.z)));
    for (const cell of updates) records[slotForWorldCell(ring, cell.x, cell.z)] = recordFor(cell);
    const seen = new Set();
    for (let slot = 0; slot < ring.capacity; slot++) {
      const cell = worldCellForSlot(state, slot);
      assert.equal(slotForWorldCell(ring, cell.x, cell.z), slot);
      seen.add(key(cell.x, cell.z));
      assert.deepEqual(records[slot], recordFor(cell), 'partial fill equals full seeded rebuild');
      if (!changedSlots.has(slot)) assert.strictEqual(records[slot], previous[slot]);
    }
    assert.equal(seen.size, ring.capacity);
    assert.deepEqual([...seen].sort(), [...windowCells(state).keys()].sort());
  }
});

test('one-cell moves update a strip rather than a full production grid', () => {
  for (const ring of GRASS_RINGS) {
    const state = createRingState(ring);
    snapRingState(state, ring.spacing * .25, ring.spacing * .25);
    snapRingState(state, ring.spacing * 1.25, ring.spacing * .25);
    assert.equal(state.updateCount, ring.side);
    snapRingState(state, ring.spacing * 2.25, ring.spacing * 1.25);
    assert.equal(state.updateCount, 2 * ring.side - 1);
  }
});

test('GPU update uses exact dynamic placement counts and caches only unchanged culling', () => {
  const calls = [];
  let submissions = 0;
  let computeGroup;
  let sizeReads = 0;
  let bufferHeight = 1080;
  const renderer = {
    getDrawingBufferSize(target) { sizeReads++; return target.set(1920, bufferHeight); },
    compute(nodes) {
      assert.ok(Array.isArray(nodes), 'all dispatches belong to one compute group');
      computeGroup ??= nodes;
      assert.strictEqual(nodes, computeGroup, 'reuse the compute group identity');
      submissions++;
      for (const node of nodes) calls.push({ name: node.name, count: node.count });
    },
    _attributes: { delete() {} },
  };
  const { Fn, float, vec3 } = THREE.TSL;
  const surface = {
    macroAt: Fn(() => float(.5)), healthAt: Fn(() => float(.6)),
    tintFrom: Fn(() => vec3(1)), densityFrom: Fn(() => float(1)),
    dryAt: Fn(() => float(0)), dryTintFrom: Fn(() => vec3(1)),
  };
  const heightMap = createFlatHeightMap(0);
  const grass = createGPUDrivenGrass({ renderer, surface, heightMap, shadows: false });
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 125);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.position.set(.0125, 1.7, .0125);
  const update = () => {
    calls.length = 0;
    submissions = 0;
    camera.updateMatrixWorld(true);
    grass.update(camera);
    assert.equal(submissions, calls.length ? 1 : 0);
    assert.equal(grass.stats().computeCalls, submissions);
    assert.equal(grass.stats().computeDispatches, calls.length);
    return calls.slice();
  };
  try {
    assert.equal(update().length, GRASS_RINGS.length * 2 + 1);
    assert.deepEqual(calls.map(call => call.name), [
      ...GRASS_RINGS.map(ring => `Place ${ring.id} grass`),
      'Reset grass indirect draws',
      ...GRASS_RINGS.map(ring => `Cull ${ring.id} grass`),
    ], 'placement and counter reset finish before exact culling');
    assert.equal(grass.stats().placementCandidates, TOTAL_GRASS_CANDIDATES);
    assert.equal(grass.stats().placements, GRASS_RINGS.length);
    assert.deepEqual(update(), []);
    assert.equal(grass.stats().computeCalls, 0);
    assert.equal(grass.stats().placementCandidates, 0);

    camera.position.x = .0275; // Close/near share cells; mid/far are unchanged.
    const moved = update();
    assert.deepEqual(moved.slice(0, 2), GRASS_RINGS.slice(0, 2).map(ring =>
      ({ name: `Place ${ring.id} grass`, count: ring.side })));
    assert.equal(calls.length, GRASS_RINGS.length + 3);
    assert.equal(grass.stats().placementCandidates,
      GRASS_RINGS[0].side + GRASS_RINGS[1].side);

    camera.rotation.y += .2;
    assert.equal(update().length, GRASS_RINGS.length + 1, 'rotation reculls without placement');
    camera.position.y += .1;
    assert.equal(update().length, GRASS_RINGS.length + 1, 'height reculls without placement');
    camera.fov = 70;
    camera.updateProjectionMatrix();
    assert.equal(update().length, GRASS_RINGS.length + 1, 'projection reculls');

    const oldReads = sizeReads;
    bufferHeight = 720;
    assert.deepEqual(update(), [], 'resolution alone needs no recull');
    assert.equal(sizeReads, oldReads + 1, 'pixel-scale input remains current while idle');

    camera.position.x = -200;
    assert.equal(update().length, GRASS_RINGS.length * 2 + 1, 'teleport refills all rings');
    assert.equal(grass.stats().placementCandidates, TOTAL_GRASS_CANDIDATES);
    assert.deepEqual(calls.filter(call => call.name.startsWith('Place')).map(call => call.count),
      GRASS_RINGS.map(ring => ring.capacity));
    assert.deepEqual(update(), []);
  } finally {
    grass.dispose();
    heightMap.texture.dispose();
  }
});
