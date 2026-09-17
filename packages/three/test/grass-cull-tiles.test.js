import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import {
  GRASS_CULL_TILE_SIDE, GRASS_CULL_TILE_LANES, cullTileCapacity, selectCullTiles,
} from '../src/grass/cull-tiles.js';
import {
  GRASS_RINGS, createRingState, snapRingState, slotForWorldCell, hashUint, worldCellSeed,
} from '../src/grass/grid.js';
import { BLADE_CULL_CENTRE, bladeCullRadiusFactor } from '../src/grass/blade-arc.js';
import { createGPUDrivenGrass } from '../src/grass/grass.js';
import { createFlatHeightMap } from './helpers/height-maps.js';
import { LAWN } from '../src/grass/preset.js';

const key = (x, z) => `${x},${z}`;
const makeRing = (side = 65, spacing = .2, inner = 0, outer = 1e9) =>
  ({ side, capacity: side * side, spacing, inner, outer, index: 0 });
const unconstrained = {
  camera: { x: 0, y: 0, z: 0 }, planes: [],
  groundBounds: { minimum: 0, maximum: 0 },
  marginXZ: 0, marginBelow: 0, marginAbove: 0,
};

function selectedCells(data, count) {
  const cells = new Map();
  for (let tile = 0; tile < count; tile++) {
    const [x, z, width, height] = data.subarray(tile * 4, tile * 4 + 4);
    for (let lane = 0; lane < GRASS_CULL_TILE_LANES; lane++) {
      const column = lane % GRASS_CULL_TILE_SIDE;
      const row = Math.floor(lane / GRASS_CULL_TILE_SIDE);
      if (column >= width || row >= height) continue;
      const cellKey = key(x + column, z + row);
      assert.equal(cells.has(cellKey), false, 'each physical record is visited once');
      cells.set(cellKey, { x: x + column, z: z + row });
    }
  }
  return cells;
}

test('tiles cover clipped ring edges exactly at negative and positive origins', () => {
  for (const side of [1, 31, 32, 33, 64, 65, 642]) {
    const ring = makeRing(side, 1);
    const state = { ring, originCellX: -3 * side - 7, originCellZ: 2 * side + 13 };
    const data = new Float32Array(cullTileCapacity(ring) * 4);
    const result = selectCullTiles(state, unconstrained, data);
    assert.equal(result.count, cullTileCapacity(ring));
    assert.equal(result.dispatchCandidates, result.count * 1024);
    const cells = selectedCells(data, result.count);
    assert.equal(cells.size, ring.capacity);
    assert.equal(new Set([...cells.values()].map(c => slotForWorldCell(ring, c.x, c.z))).size, ring.capacity);
    for (const { x, z } of cells.values()) {
      assert.ok(x >= state.originCellX && x < state.originCellX + side);
      assert.ok(z >= state.originCellZ && z < state.originCellZ + side);
    }
    assert.equal(selectCullTiles(state, unconstrained, data).changed, false);
  }
});

test('annulus and coverage rejection never discard an eligible jittered root', () => {
  const ring = makeRing(96, .2, 3, 8);
  const state = createRingState(ring);
  const data = new Float32Array(cullTileCapacity(ring) * 4);
  const coverageBounds = [{ minX: -6, minZ: -6, maxX: -.5, maxZ: 6 },
    { minX: .5, minZ: -6, maxX: 6, maxZ: 6 }];
  for (const [cameraX, cameraZ] of [[0, 0], [-3.4, -5.7], [11.25, -1.6]]) {
    snapRingState(state, cameraX, cameraZ);
    const options = { ...unconstrained, camera: { x: cameraX, z: cameraZ }, coverageBounds };
    const result = selectCullTiles(state, options, data);
    const retained = selectedCells(data, result.count);
    for (let z = state.originCellZ; z < state.originCellZ + ring.side; z++) {
      for (let x = state.originCellX; x < state.originCellX + ring.side; x++) {
        for (const [jx, jz] of [[.1, .1], [.9, .1], [.1, .9], [.9, .9], [.5, .5]]) {
          const wx = (x + jx) * ring.spacing, wz = (z + jz) * ring.spacing;
          const distance = Math.hypot(wx - cameraX, wz - cameraZ);
          if (distance < ring.inner || distance >= ring.outer) continue;
          if (!coverageBounds.some(b => wx >= b.minX && wx <= b.maxX && wz >= b.minZ && wz <= b.maxZ)) continue;
          assert.ok(retained.has(key(x, z)), `eligible root ${wx},${wz} was culled`);
        }
      }
    }
  }
  assert.equal(selectCullTiles(state, { ...unconstrained, coverageBounds: [] }, data).count, 0);
  assert.throws(() => selectCullTiles(state, unconstrained, new Float32Array(4)), RangeError);
});

test('coarse frustum bounds retain every exact sphere hit across slopes and translated scenes', () => {
  const ring = makeRing(96, .2, 2, 9.5);
  const state = createRingState(ring);
  const data = new Float32Array(cullTileCapacity(ring) * 4);
  const minHeight = .04, maxHeight = .6, maxWidth = .013;
  const radiusFactor = bladeCullRadiusFactor(1.4);
  const radiusMax = maxHeight * radiusFactor + maxWidth * .5 * LAWN.maxThicken + LAWN.tillerSpread * .5;
  const groundBounds = { minimum: -1.25, maximum: 1.75 };
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, .5, 12);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  let accepted = 0;
  for (const translation of [0, -70.5, 12000]) for (const yaw of [-2.1, -.7, .2, 1.6]) {
    camera.position.set(translation - .17, 2.1, translation + .23);
    camera.lookAt(camera.position.x + Math.sin(yaw), -.4, camera.position.z - Math.cos(yaw));
    camera.updateMatrixWorld(true);
    snapRingState(state, camera.position.x, camera.position.z);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
    );
    const result = selectCullTiles(state, {
      camera: camera.position, planes: frustum.planes, groundBounds,
      marginXZ: radiusMax + maxHeight * BLADE_CULL_CENTRE,
      marginBelow: radiusMax, marginAbove: radiusMax + maxHeight * BLADE_CULL_CENTRE,
    }, data);
    const retained = selectedCells(data, result.count);
    // Quantize the same frustum uniforms the GPU receives.
    const planes = frustum.planes.map(p => ({
      x: Math.fround(p.normal.x), y: Math.fround(p.normal.y),
      z: Math.fround(p.normal.z), w: Math.fround(p.constant),
    }));
    for (let z = state.originCellZ; z < state.originCellZ + ring.side; z++) {
      for (let x = state.originCellX; x < state.originCellX + ring.side; x++) {
        const seed = worldCellSeed(x, z);
        const wx = Math.fround((x + .1 + .8 * hashUint(seed + 11)) * ring.spacing);
        const wz = Math.fround((z + .1 + .8 * hashUint(seed + 23)) * ring.spacing);
        const distance = Math.hypot(wx - camera.position.x, wz - camera.position.z);
        if (distance < ring.inner || distance >= ring.outer) continue;
        const h = minHeight + (maxHeight - minHeight) * hashUint(seed + 41);
        const gy = groundBounds.minimum + (groundBounds.maximum - groundBounds.minimum) * hashUint(seed + 43);
        const normal = new THREE.Vector3(hashUint(seed + 47) * 2 - 1,
          hashUint(seed + 53), hashUint(seed + 59) * 2 - 1).normalize();
        const centre = new THREE.Vector3(wx, gy, wz).addScaledVector(normal, h * BLADE_CULL_CENTRE);
        const radius = h * radiusFactor + maxWidth * .5 * LAWN.maxThicken + LAWN.tillerSpread * .5;
        if (planes.every(p => p.x * centre.x + p.y * centre.y + p.z * centre.z + p.w >= -radius)) {
          accepted++;
          assert.ok(retained.has(key(x, z)), `sphere retained by GPU was rejected at ${x},${z}`);
        }
      }
    }
  }
  assert.ok(accepted > 1000, 'exercise substantial visible sets, not only empty frustums');
});

test('dynamic dispatch counts follow retained tiles and empty coverage resets without a cull', () => {
  const { Fn, float, vec3 } = THREE.TSL;
  const surface = {
    macroAt: Fn(() => float(.5)), healthAt: Fn(() => float(.6)),
    tintFrom: Fn(() => vec3(1)), densityFrom: Fn(() => float(1)),
    dryAt: Fn(() => float(0)), dryTintFrom: Fn(() => vec3(1)),
  };
  for (const coverageBounds of [[{ minX: -2, minZ: -2, maxX: 2, maxZ: 2 }], []]) {
    const calls = [], released = [];
    let submissions = 0;
    const renderer = {
      getDrawingBufferSize: target => target.set(1920, 1080),
      compute(nodes) {
        assert.ok(Array.isArray(nodes));
        submissions++;
        for (const node of nodes) calls.push({ name: node.name, count: node.count });
      },
      _attributes: { delete: attribute => released.push(attribute) },
    };
    const heightMap = createFlatHeightMap(0);
    const grass = createGPUDrivenGrass({ renderer, surface, heightMap, coarseCulling: true,
      coverageBounds, groundBounds: { minimum: 0, maximum: 0 } });
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 20);
    camera.position.set(0, 1.7, 0);
    camera.lookAt(0, 0, -3);
    camera.updateMatrixWorld(true);
    try {
      grass.update(camera);
      const culls = calls.filter(call => call.name.startsWith('Cull'));
      const dispatched = culls.reduce((sum, call) => sum + call.count, 0);
      assert.equal(grass.stats().cullCandidates, dispatched);
      assert.equal(grass.stats().cullTiles * 1024, dispatched);
      assert.equal(grass.stats().computeDispatches, calls.length);
      assert.equal(submissions, 1);
      assert.equal(grass.stats().computeCalls, 1);
      assert.deepEqual(calls.slice(0, GRASS_RINGS.length + 1).map(call => call.name), [
        ...GRASS_RINGS.map(ring => `Place ${ring.id} grass`),
        'Reset grass indirect draws',
      ]);
      assert.ok(calls.some(call => call.name.startsWith('Reset')));
      if (coverageBounds.length) {
        assert.ok(dispatched > 0 && dispatched < 100000, `unexpected ${dispatched} lanes`);
        assert.deepEqual(culls.map(call => call.name), ['Cull close grass', 'Cull near grass'],
          'only close and near rings intersect the coverage');
      } else {
        assert.equal(dispatched, 0);
        assert.equal(culls.length, 0);
      }
      calls.length = 0;
      grass.update(camera);
      assert.equal(calls.length, 0);
      assert.equal(submissions, 1, 'idle must not submit an empty group');
      assert.equal(grass.stats().computeCalls, 0);
      assert.equal(grass.stats().computeDispatches, 0);
      assert.equal(grass.stats().cullCandidates, 0);
      assert.equal(grass.stats().cullTiles, 0);
      grass.invalidateCulling();
      grass.update(camera);
      assert.equal(submissions, 2);
      assert.equal(grass.stats().computeCalls, 1);
      assert.equal(grass.stats().computeDispatches, calls.length);
      assert.equal(calls[0].name, 'Reset grass indirect draws');
      assert.ok(calls.some(call => call.name.startsWith('Reset')));
      assert.ok(calls.every(call => !call.name.startsWith('Place')),
        'mask invalidation must not regenerate unchanged placement');
      if (!coverageBounds.length) {
        assert.deepEqual(calls, [{ name: 'Reset grass indirect draws', count: GRASS_RINGS.length }],
          'empty turf still submits its reset, without zero-count dispatches');
      }
    } finally {
      grass.dispose();
      heightMap.texture.dispose();
    }
    const tileBuffers = released.filter(attribute => attribute.name.endsWith('cull tiles'));
    assert.equal(tileBuffers.length, GRASS_RINGS.length);
    assert.equal(tileBuffers.reduce((sum, attribute) => sum + attribute.array.byteLength, 0), grass.stats().cullTileBytes);
  }
});
