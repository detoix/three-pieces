import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { createGPUDrivenGrass } from '../src/grass/grass.js';
import { cullDispatchSize } from '../src/grass/subgroup-compaction.js';
import { GRASS_RINGS } from '../src/grass/grid.js';
import { createFlatHeightMap } from '../src/grass/index.js';

// A scalar model of independent subgroup reservations in arbitrary execution
// order. Verify membership and uniqueness, not globally deterministic ordering.
function compact(mask, width, order) {
  const output = [];
  let count = 0, atomics = 0;
  for (const group of order) {
    const start = group * width;
    const emits = Array.from({ length: width }, (_, lane) => Number(mask[start + lane] === true));
    const total = emits.reduce((sum, value) => sum + value, 0);
    const base = count;
    if (total) { count += total; atomics++; }
    let offset = 0;
    for (let lane = 0; lane < width; lane++) {
      if (emits[lane]) {
        assert.equal(output[base + offset], undefined, 'duplicate output address');
        output[base + offset] = start + lane;
      }
      offset += emits[lane];
    }
  }
  return { output, count, atomics };
}

test('subgroup reservation preserves the exact visible set through masks, tails and scheduling', () => {
  let seed = 34729;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (const width of [8, 16, 32, 64, 128]) {
    for (const length of [0, 1, width - 1, width, width + 1, 257]) {
      for (const kind of ['none', 'all', 'alternating', 'sparse', 'random']) {
        const mask = Array.from({ length }, (_, i) => kind === 'all' ||
          (kind === 'alternating' && i % 2 === 1) ||
          (kind === 'sparse' && i % 67 === 2) || (kind === 'random' && random() < .6));
        const expected = mask.flatMap((keep, i) => keep ? [i] : []);
        const order = Array.from({ length: Math.ceil(length / width) }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        const actual = compact(mask, width, order);
        assert.equal(actual.count, expected.length);
        assert.equal(actual.output.length, expected.length);
        assert.deepEqual(actual.output.sort((a, b) => a - b), expected);
        assert.ok(actual.atomics <= Math.min(order.length, expected.length));
      }
    }
  }
});

function fixture({ supported = true, requested = true, coarse = true } = {}) {
  const { Fn, float, vec3, context } = THREE.TSL;
  const surface = { macroAt: Fn(() => float(.5)), healthAt: Fn(() => float(.6)),
    tintFrom: Fn(() => vec3(1)), densityFrom: Fn(() => float(1)),
    dryAt: Fn(() => float(0)), dryTintFrom: Fn(() => vec3(1)) };
  let nodes = [];
  const renderer = {
    contextNode: context({}),
    hasFeature: name => supported && name === 'subgroups',
    backend: { capabilities: { getUniformBufferLimit: () => 65536 },
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) } },
    compute: value => { nodes = value.slice(); },
    getDrawingBufferSize: target => target.set(1920, 1080),
    _attributes: { delete() {} },
  };
  const heightMap = createFlatHeightMap(0);
  const grass = createGPUDrivenGrass({ renderer, heightMap, surface,
    subgroupCulling: requested, coarseCulling: coarse,
    keepAt: Fn(([xz]) => xz.x.greaterThan(-50)),
    groundBounds: { minimum: 0, maximum: 0 } });
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 100);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.position.set(0, .3, 0);
  camera.updateMatrixWorld(true);
  grass.update(camera);
  return { renderer, grass, camera, nodes, heightMap,
    dispose: () => { grass.dispose(); heightMap.texture.dispose(); } };
}

function assertCollectivesConverged(shader) {
  const main = shader.slice(shader.indexOf('fn main('));
  let depth = 0, checked = 0;
  for (const line of main.split('\n')) {
    // Structural check of the actual generated entry point, including Three's
    // wrappers: collectives must sit directly in main, outside every branch.
    if (/\bsubgroup(?:ExclusiveAdd|Add|Elect|BroadcastFirst)\(/.test(line)) {
      assert.equal(depth, 1, `collective nested in divergent flow: ${line}`);
      checked++;
    }
    for (const char of line.replace(/\/\/.*$/, '')) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
  }
  assert.equal(checked, 4);
  assert.doesNotMatch(main, /\breturn\b/, 'no early return may remove padded lanes');
}

test('actual cull WGSL keeps collectives converged and fixes r185 broadcast arity', () => {
  for (const coarse of [false, true]) {
    const f = fixture({ coarse });
    try {
      const culls = f.nodes.filter(node => node.name.startsWith('Cull'));
      assert.equal(culls.length, GRASS_RINGS.length);
      assert.equal(f.grass.stats().subgroupCulling, true);
      for (const node of culls) {
        assert.equal(node.count, null, 'explicit dispatch has no implicit count return');
        assert.ok(node.dispatchSize[0] > 0);
        const builder = new THREE.WGSLNodeBuilder(node, f.renderer).build();
        const shader = builder.computeShader;
        assert.match(shader, /enable subgroups;/);
        assertCollectivesConverged(shader);
        assert.match(shader, /subgroupBroadcastFirst\(\s*grassSubgroupBase\s*\)/);
        assert.match(shader, /grassEmit = 0u;/);
        assert.equal((shader.match(/atomicAdd\(/g) || []).length, 1);
        const candidateGuard = shader.indexOf('if ( ( instanceIndex <');
        assert.ok(candidateGuard > 0, 'explicit candidate bound precedes storage reads');
        assert.ok(shader.indexOf('packedGroundBlade =') > candidateGuard);
      }
      const submitted = culls.reduce((sum, node) => sum + node.dispatchSize[0] * 64, 0);
      const expected = f.grass.stats().cullCandidates;
      assert.ok(submitted >= expected && submitted - expected < GRASS_RINGS.length * 64);
      // Placement retains Three's usual exact count guard.
      assert.ok(f.nodes.filter(node => node.name.startsWith('Place')).every(node => node.count > 0));
    } finally { f.dispose(); }
  }
});

test('unsupported and opt-out renderers preserve per-crown atomics and original counted dispatch', () => {
  for (const settings of [{ supported: false }, { requested: false }]) {
    for (const coarse of [false, true]) {
      const f = fixture({ ...settings, coarse });
      try {
        assert.equal(f.grass.stats().subgroupCulling, false);
        const culls = f.nodes.filter(node => node.name.startsWith('Cull'));
        for (const node of culls) {
          assert.equal(node.dispatchSize, null);
          assert.ok(node.count > 0);
          const shader = new THREE.WGSLNodeBuilder(node, f.renderer).build().computeShader;
          assert.doesNotMatch(shader, /subgroup(?:ExclusiveAdd|Add|Elect|BroadcastFirst)\(/);
          assert.match(shader, /atomicAdd\([^\n]+, 1u \)/);
        }
        assert.equal(f.grass.stats().cullCandidates, culls.reduce((sum, node) => sum + node.count, 0));
      } finally { f.dispose(); }
    }
  }
  assert.deepEqual(cullDispatchSize(65), [2, 1, 1]);
});
