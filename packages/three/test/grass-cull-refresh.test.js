import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { CULL_TRANSLATION_LIMIT, CULL_ROTATION_LIMIT, CullRefreshTracker,
  cullMotionMargin, isRigidCameraMatrix } from '../src/grass/cull-refresh.js';
import { selectCullTiles, cullTileCapacity } from '../src/grass/cull-tiles.js';
import { GRASS_RINGS, createRingState, snapRingState } from '../src/grass/grid.js';
import { createGPUDrivenGrass } from '../src/grass/grass.js';
import { createFlatHeightMap } from './helpers/height-maps.js';

const makeCamera = () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 100);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.position.set(0, 1.7, 0);
  camera.updateMatrixWorld(true);
  return camera;
};
const frustumFor = camera => new THREE.Frustum().setFromProjectionMatrix(
  new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  camera.coordinateSystem);

test('refresh is cumulative from the last cull, with projection/system/invalidation overrides', () => {
  const camera = makeCamera();
  const tracker = new CullRefreshTracker(true);
  assert.equal(tracker.needsRefresh(camera), true);
  tracker.commit(camera);
  for (const x of [.04, .08, .12, .15]) {
    camera.position.x = x;
    camera.rotation.y = CULL_ROTATION_LIMIT;
    camera.updateMatrixWorld(true);
    assert.equal(tracker.needsRefresh(camera), false);
  }
  camera.position.x = .15001;
  camera.updateMatrixWorld(true);
  assert.equal(tracker.needsRefresh(camera), true);
  tracker.commit(camera);
  camera.rotation.y += CULL_ROTATION_LIMIT + .00001;
  camera.updateMatrixWorld(true);
  assert.equal(tracker.needsRefresh(camera), true);
  tracker.commit(camera);
  camera.fov = 61;
  camera.updateProjectionMatrix();
  assert.equal(tracker.needsRefresh(camera), true);
  tracker.commit(camera);
  camera.coordinateSystem = THREE.WebGLCoordinateSystem;
  assert.equal(tracker.needsRefresh(camera), true);
  tracker.commit(camera);
  assert.equal(tracker.needsRefresh(camera), false);
  tracker.invalidate();
  assert.equal(tracker.needsRefresh(camera), true);
});

test('world-space parent motion is tracked and non-rigid transforms use exact invalidation', () => {
  for (const mode of ['disabled', 'scaled', 'sheared', 'rigid']) {
    const camera = makeCamera();
    const parent = new THREE.Group();
    parent.add(camera);
    if (mode === 'scaled') parent.scale.set(1.00001, 1, 1);
    if (mode === 'sheared') {
      parent.matrixAutoUpdate = false;
      parent.matrix.elements[4] = .00001;
    }
    parent.updateMatrixWorld(true);
    const tracker = new CullRefreshTracker(mode !== 'disabled');
    tracker.commit(camera);
    assert.equal(isRigidCameraMatrix(camera.matrixWorld), mode !== 'scaled' && mode !== 'sheared');
    camera.position.z += .02;
    parent.updateMatrixWorld(true);
    assert.equal(tracker.needsRefresh(camera), mode !== 'rigid');
    tracker.commit(camera);
    if (mode === 'sheared') parent.matrix.elements[12] = .2;
    else parent.position.x = .2;
    parent.updateMatrixWorld(true);
    assert.equal(tracker.needsRefresh(camera), true, 'local camera position alone misses a moving parent');
  }
});

test('guarded fine spheres and coarse tiles retain every newly visible sphere in the frozen radial domain', () => {
  const groundBounds = { minimum: -1, maximum: 2 };
  const centreOffset = .15, sphereRadius = .23;
  const camera = makeCamera();
  let seed = 81273, hits = 0, newlyVisible = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let scenario = 0; scenario < 30; scenario++) {
    camera.position.set(random() * 40 - 20, random() * 6 - 1, random() * 40 - 20);
    camera.rotation.set(random() * 2 - 1, random() * 6 - 3, random() * .6 - .3);
    camera.updateMatrixWorld(true);
    const oldPosition = camera.position.clone();
    const oldFrustum = frustumFor(camera);
    const live = camera.clone();
    const axis = new THREE.Vector3(random() - .5, random() - .5, random() - .5).normalize();
    live.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, CULL_ROTATION_LIMIT));
    live.position.addScaledVector(new THREE.Vector3(random() - .5, random() - .5, random() - .5).normalize(), CULL_TRANSLATION_LIMIT);
    live.updateMatrixWorld(true);
    const liveFrustum = frustumFor(live);
    for (const ring of GRASS_RINGS) {
      const state = createRingState(ring);
      snapRingState(state, oldPosition.x, oldPosition.z);
      const guard = cullMotionMargin(ring.outer, oldPosition.y, groundBounds, centreOffset);
      const tiles = new Float32Array(cullTileCapacity(ring) * 4);
      const { count } = selectCullTiles(state, {
        camera: oldPosition, planes: oldFrustum.planes, groundBounds,
        marginXZ: sphereRadius + centreOffset + guard,
        marginBelow: sphereRadius + guard,
        marginAbove: sphereRadius + centreOffset + guard,
      }, tiles);
      for (let sample = 0; sample < 400; sample++) {
        const angle = random() * Math.PI * 2;
        const radius = ring.inner + random() * (ring.outer - ring.inner);
        const root = new THREE.Vector3(oldPosition.x + Math.cos(angle) * radius,
          groundBounds.minimum + random() * (groundBounds.maximum - groundBounds.minimum),
          oldPosition.z + Math.sin(angle) * radius);
        const centre = root.clone().addScaledVector(new THREE.Vector3(random() - .5, random(), random() - .5).normalize(), centreOffset);
        if (!liveFrustum.planes.every(p => p.distanceToPoint(centre) >= -sphereRadius)) continue;
        hits++;
        if (oldFrustum.planes.some(p => p.distanceToPoint(centre) < -sphereRadius)) newlyVisible++;
        assert.ok(oldFrustum.planes.every(p => p.distanceToPoint(centre) >= -(sphereRadius + guard)), 'fine frustum discarded a newly visible sphere');
        const cellX = Math.floor(root.x / ring.spacing), cellZ = Math.floor(root.z / ring.spacing);
        let retained = false;
        for (let i = 0; i < count; i++) {
          const [x, z, width, height] = tiles.subarray(i * 4, i * 4 + 4);
          if (cellX >= x && cellX < x + width && cellZ >= z && cellZ < z + height) retained = true;
        }
        assert.ok(retained, 'coarse tile discarded a newly visible sphere');
      }
    }
  }
  assert.ok(hits > 5000, `only ${hits} visible samples`);
  assert.ok(newlyVisible > 100, `only ${newlyVisible} newly visible samples`);
});

test('grass retains draws/placement within the guard and refreshes all rings together', () => {
  const { Fn, float, vec3 } = THREE.TSL;
  const surface = { macroAt: Fn(() => float(.5)), healthAt: Fn(() => float(.6)),
    tintFrom: Fn(() => vec3(1)), densityFrom: Fn(() => float(1)),
    dryAt: Fn(() => float(0)), dryTintFrom: Fn(() => vec3(1)) };
  let calls = [], sizeReads = 0;
  const renderer = { compute: nodes => calls.push(nodes.slice()),
    getDrawingBufferSize: target => { sizeReads++; return target.set(1920, 1080); },
    _attributes: { delete() {} } };
  const heightMap = createFlatHeightMap(0);
  const grass = createGPUDrivenGrass({ renderer, heightMap, surface,
    cullHysteresis: true, coarseCulling: true, groundBounds: { minimum: 0, maximum: 0 } });
  const camera = makeCamera();
  const update = () => { calls = []; camera.updateMatrixWorld(true); grass.update(camera); return calls; };
  try {
    assert.equal(update().length, 1);
    camera.position.x = .1;
    camera.rotation.y = .01;
    assert.equal(update().length, 0, 'crossing placement cells does not overwrite retained draw IDs');
    assert.equal(grass.stats().placementCandidates, 0);
    assert.equal(grass.stats().computeCalls, 0);
    assert.equal(sizeReads, 2, 'live vertex pixel scale is updated during reuse');
    camera.position.x = .16;
    assert.equal(update().length, 1);
    assert.ok(calls[0].some(node => node.name.startsWith('Place')));
    assert.equal(calls[0].filter(node => node.name.startsWith('Cull')).length, GRASS_RINGS.length);
    grass.invalidateCulling();
    assert.equal(update().length, 1);
    assert.ok(calls[0].every(node => !node.name.startsWith('Place')));
    camera.fov = 75;
    camera.updateProjectionMatrix();
    assert.equal(update().length, 1);
  } finally { grass.dispose(); heightMap.texture.dispose(); }
});
