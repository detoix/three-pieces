import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { createGPUDrivenGrass } from '../src/grass/grass.js';
import { createBladeGeometry } from '../src/grass/blade-geometry.js';
import { GRASS_RINGS, hashUint } from '../src/grass/grid.js';
import { LAWN } from '../src/grass/preset.js';
import { GRASS_POSE_BYTES, GRASS_POSE_FLOATS, GrassBladePose, poseCrownCapacity } from '../src/grass/pose-cache.js';
import { createFlatHeightMap } from './helpers/height-maps.js';

test('pose storage stays within 8 MiB and overflow has room in the original crown buffers', () => {
  assert.equal(GRASS_POSE_BYTES, 64);
  assert.equal(GrassBladePose.getLength(), GRASS_POSE_FLOATS);
  for (const tillers of [1, 2, 3, 4, 8, 12, 101]) {
    const bytes = GRASS_RINGS.reduce((sum, ring) => sum + poseCrownCapacity(ring, tillers) * tillers * GRASS_POSE_BYTES, 0);
    assert.ok(bytes <= 8 * 1024 * 1024);
    for (const ring of GRASS_RINGS) assert.ok(poseCrownCapacity(ring, tillers) <= ring.capacity);
  }
  assert.deepEqual(GRASS_RINGS.map(ring => poseCrownCapacity(ring, 4)), [0, 24576, 8192, 0]);
  assert.ok(GRASS_RINGS.find(r => r.id === 'near').capacity > 24576);
  assert.throws(() => poseCrownCapacity(GRASS_RINGS[0], 0), RangeError);
});

test('pose expansion follows all culls in one batch, stays idle, invalidates and frees bounded storage', () => {
  const { Fn, float, vec3 } = THREE.TSL;
  const surface = { macroAt: Fn(() => float(.5)), healthAt: Fn(() => float(.6)),
    tintFrom: Fn(() => vec3(1)), densityFrom: Fn(() => float(1)),
    dryAt: Fn(() => float(.2)), dryTintFrom: Fn(() => vec3(1)) };
  for (const coverageBounds of [null, []]) {
    let batches = [], height = 1080;
    const released = [], disposed = [];
    const renderer = {
      getDrawingBufferSize: target => target.set(1920, height),
      compute: nodes => batches.push(nodes.slice()),
      _attributes: { delete: attribute => released.push(attribute) },
    };
    const heightMap = createFlatHeightMap(0);
    const grass = createGPUDrivenGrass({ renderer, surface, heightMap, poseCache: true,
      coarseCulling: true, coverageBounds });
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, .05, 170);
    camera.position.set(.0125, 1.7, .0125);
    camera.updateMatrixWorld(true);
    try {
      grass.update(camera);
      assert.equal(batches.length, 1);
      const first = batches[0];
      const expansion = first.filter(node => node.name.startsWith('Expand'));
      const expectedNames = coverageBounds ? [] : ['Expand near grass poses', 'Expand mid grass poses'];
      assert.deepEqual(expansion.map(node => node.name), expectedNames);
      for (const node of expansion) node.addEventListener('dispose', () => disposed.push(node));
      if (expansion.length) {
        assert.deepEqual(first.slice(-2), expansion);
        assert.deepEqual(expansion.map(node => node.count), [98304, 32768]);
      }
      assert.equal(grass.stats().poseCandidates, expansion.reduce((sum, node) => sum + node.count, 0));
      assert.equal(grass.stats().poseCacheBytes, 8 * 1024 * 1024);
      batches = [];
      grass.update(camera);
      assert.deepEqual(batches, []);
      assert.equal(grass.stats().poseCandidates, 0);
      height = 720;
      grass.update(camera);
      assert.deepEqual(batches, [], 'view-dependent widening stays live without rebuilding static poses');
      grass.invalidateCulling();
      grass.update(camera);
      assert.equal(batches.length, 1);
      assert.deepEqual(batches[0].filter(node => node.name.startsWith('Expand')), expansion);
      assert.ok(batches[0].every(node => !node.name.startsWith('Place')));
      // A teleport refills records and reuses the same pose nodes/buffers.
      batches = [];
      camera.position.set(-200, 1.7, -120);
      camera.updateMatrixWorld(true);
      grass.update(camera);
      assert.equal(batches.length, 1);
      assert.deepEqual(batches[0].filter(node => node.name.startsWith('Expand')), expansion);
      for (const mesh of grass.group.children) {
        const ring = GRASS_RINGS.find(r => mesh.name.endsWith(r.id));
        assert.equal(mesh.geometry.instanceCount, ring.capacity, 'cache never truncates indirect draw capacity');
      }
    } finally { grass.dispose(); heightMap.texture.dispose(); }
    const caches = released.filter(attribute => attribute.name.endsWith('visible poses'));
    assert.equal(caches.length, 2);
    assert.equal(caches.reduce((sum, a) => sum + a.array.byteLength, 0), 8 * 1024 * 1024);
    assert.equal(new Set(released).size, released.length);
    assert.equal(disposed.length, coverageBounds ? 0 : 2);
  }
});

const vector = a => new THREE.Vector3(...a);
const mix = (a, b, t) => a + (b - a) * t;
const u16 = word => [word & 65535, word >>> 16].map(x => x / 65535);
const snorm = word => Math.max(-1, ((word << 16) >> 16) / 32767);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Independent scalar reference of the original analytic vertex expansion.
// Test the cache's float layout against positions/normals, not just values
// written and immediately read. This is not a substitute for GPU image parity.
function originalPose(words, tiller, tillers) {
  const bits = new Uint32Array(words), floats = new Float32Array(bits.buffer);
  const groundBlade = u16(words[2]), yawWidth = u16(words[4]);
  const ground = new THREE.Vector3(snorm(words[3]), 0, snorm(words[3] >>> 16));
  ground.y = Math.sqrt(Math.max(0, 1 - ground.x ** 2 - ground.z ** 2)); ground.normalize();
  const clump = [(words[6] & 65535) / 65535, ((words[6] >>> 16) & 255) / 255, (words[6] >>> 24) / 255];
  const yaw = yawWidth[0] * Math.PI * 2, clumpYaw = clump[0] * Math.PI * 2;
  const heading = new THREE.Vector3(Math.cos(yaw) + .3 * Math.cos(clumpYaw), 0, Math.sin(yaw) + .3 * Math.sin(clumpYaw));
  const forward0 = heading.clone().addScaledVector(ground, -heading.dot(ground)).normalize();
  const side0 = new THREE.Vector3().crossVectors(ground, forward0).normalize();
  const seed = (Math.imul(words[0], 1664525) + Math.imul(words[1], 1013904223) + Math.imul(tiller, 2654435761)) >>> 0;
  const rand = salt => hashUint((seed + salt) >>> 0);
  const fan = (rand(149) - .5) * 1.8;
  const forward = forward0.clone().multiplyScalar(Math.cos(fan)).addScaledVector(side0, Math.sin(fan));
  const side = side0.clone().multiplyScalar(Math.cos(fan)).addScaledVector(forward0, -Math.sin(fan));
  const angle = tiller * 2 * Math.PI / tillers + yaw;
  const offset = side0.clone().multiplyScalar(Math.cos(angle)).addScaledVector(forward0, Math.sin(angle))
    .multiplyScalar(Math.sqrt(rand(167)) * LAWN.tillerSpread * .5);
  const base = new THREE.Vector3(floats[0], groundBlade[0] * 4 - 2, floats[1]).add(offset);
  const height = mix(LAWN.minHeight, LAWN.maxHeight, groundBlade[1]) * mix(LAWN.clumpShortest, 1, clump[1]) * mix(LAWN.tillerShortest, 1, rand(181));
  const dry = Math.min(1, smooth(LAWN.dryOnset, LAWN.dryFull, 1 - clump[2]) * mix(1 - LAWN.dryScatter, 1 + LAWN.dryScatter, rand(193))) * LAWN.dryStrength;
  return { base, height, forward, width: mix(LAWN.minWidth, LAWN.maxWidth, yawWidth[1]), side,
    bend: mix(.2, 1.4, rand(131)), ground, dry };
}

function sample(p, x, y, thicken) {
  const rise = y - p.bend ** 2 * y ** 3 / 6, reach = p.bend * y ** 2 / 2;
  const position = p.base.clone().addScaledVector(p.side, x * p.width * thicken)
    .addScaledVector(p.ground, rise * p.height).addScaledVector(p.forward, reach * p.height);
  const normal = p.forward.clone().multiplyScalar(Math.cos(p.bend * y))
    .addScaledVector(p.ground, -Math.sin(p.bend * y)).multiplyScalar(Math.cos(x * 2 * LAWN.normalSpread))
    .addScaledVector(p.side, Math.sin(x * 2 * LAWN.normalSpread));
  return { position, normal };
}

test('64-byte poses preserve all blade samples for packed negative roots, slopes, seeds and overflow', () => {
  const geometry = createBladeGeometry(3, 4);
  const positions = geometry.getAttribute('position');
  let maximumPositionError = 0, maximumNormalError = 0;
  for (let i = 0; i < 180; i++) {
    const words = new Uint32Array(7), floats = new Float32Array(words.buffer);
    floats[0] = (i % 30 - 15) * 3.71; floats[1] = (Math.floor(i / 30) - 3) * 12.17;
    for (let word = 2; word < 7; word++) words[word] = Math.floor(hashUint(i * 61 + word) * 4294967296);
    // Bounded slopes avoid the horizon singularity in projected headings.
    words[3] = (Math.round(Math.sin(i) * .3 * 32767) & 65535) | ((Math.round(Math.cos(i) * .3 * 32767) & 65535) << 16);
    for (let tiller = 0; tiller < 4; tiller++) {
      const p = originalPose(words, tiller, 4);
      const cache = new Float32Array([...p.base, p.height, ...p.forward, p.width, ...p.side, p.bend, ...p.ground, p.dry]);
      assert.equal(cache.byteLength, GRASS_POSE_BYTES);
      const cached = { base: vector(cache.slice(0, 3)), height: cache[3], forward: vector(cache.slice(4, 7)), width: cache[7],
        side: vector(cache.slice(8, 11)), bend: cache[11], ground: vector(cache.slice(12, 15)), dry: cache[15] };
      for (let v = 0; v < 7; v++) for (const thicken of [1, LAWN.maxThicken]) {
        const x = positions.getX(tiller * 7 + v), y = positions.getY(tiller * 7 + v);
        const expected = sample(p, x, y, thicken), actual = sample(cached, x, y, thicken);
        maximumPositionError = Math.max(maximumPositionError, expected.position.distanceTo(actual.position));
        maximumNormalError = Math.max(maximumNormalError, expected.normal.distanceTo(actual.normal));
      }
      // Capacity is only a choice of source. Overflow keeps the analytic pose.
      const capacity = 3;
      const chosen = i < capacity ? cached : p;
      if (i >= capacity) assert.strictEqual(chosen, p);
    }
  }
  geometry.dispose();
  assert.ok(maximumPositionError < 0.00001, `${maximumPositionError} m`);
  assert.ok(maximumNormalError < 0.000001, `${maximumNormalError} normal error`);
});
