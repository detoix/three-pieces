import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
  HILLS_DEFAULT_SCALE,
  SCALAR_OPS,
  createHillsHeightNode,
  hillsHeightAt,
  hillsHeightBounds,
  hillsHeightWith,
  hillsNormalAt,
} from '../src/terrain/hills.js';
import {
  createGroundGridArrays,
  groundAxisAt,
  snapGroundCentre,
} from '../src/terrain/ground-grid.js';

function random(seed) {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

test('hill heights stay inside their exact bound, near and far from the origin', () => {
  const next = random(7);
  for (const scale of [0.3, HILLS_DEFAULT_SCALE, 2]) {
    const { minimum, maximum } = hillsHeightBounds(scale);
    let low = Infinity;
    let high = -Infinity;
    for (let index = 0; index < 20_000; index += 1) {
      const reach = index % 2 ? 100 : 200_000;
      const height = hillsHeightAt((next() - 0.5) * reach, (next() - 0.5) * reach, scale);
      assert.ok(Number.isFinite(height));
      low = Math.min(low, height);
      high = Math.max(high, height);
    }
    assert.ok(low >= minimum && high <= maximum, `${scale}: ${low}..${high} outside ${minimum}..${maximum}`);
    // A bound far looser than the terrain would waste the grass's packed height precision.
    assert.ok(high - low > (maximum - minimum) * 0.6, `${scale}: the bound is loose`);
  }
  assert.equal(hillsHeightAt(12, -40, 0), 0, 'scale 0 is a flat lawn');
});

test('the default hills are walkable rolling ground, not cliffs and not a plain', () => {
  const next = random(11);
  const slopes = [];
  for (let index = 0; index < 20_000; index += 1) {
    const [, y] = hillsNormalAt((next() - 0.5) * 20_000, (next() - 0.5) * 20_000);
    slopes.push(Math.acos(y) * 180 / Math.PI);
  }
  slopes.sort((a, b) => a - b);
  const at = (share) => slopes[Math.floor(share * (slopes.length - 1))];
  assert.ok(at(0.5) > 5 && at(0.5) < 15, `median slope ${at(0.5)}`);
  assert.ok(at(0.99) < 28, `99th percentile slope ${at(0.99)}`);
  assert.ok(slopes.at(-1) < 35, `steepest slope ${slopes.at(-1)}`);
});

test('the shader function is the scalar formula over nodes', () => {
  // The formula is shared, so what can differ is the arithmetic interface.
  // Evaluate it through a recording interface shaped like TSL's and compare.
  const traced = {
    float: (value) => ({ value }),
    sin: (node) => ({ value: Math.sin(node.value) }),
    cos: (node) => ({ value: Math.cos(node.value) }),
    Fn: (body) => (xz) => body([xz]),
  };
  const wrap = (node) => Object.assign(node, {
    add(other) { return wrap({ value: this.value + other.value }); },
    mul(other) { return wrap({ value: this.value * other.value }); },
  });
  const tsl = {
    float: (value) => wrap(traced.float(value)),
    sin: (node) => wrap(traced.sin(node)),
    cos: (node) => wrap(traced.cos(node)),
    Fn: traced.Fn,
  };
  const heightAt = createHillsHeightNode(tsl, 1.3);
  for (const [x, z] of [[0, 0], [37.5, -812.25], [-9_000, 4_321]]) {
    const node = heightAt({ x: wrap({ value: x }), y: wrap({ value: z }) });
    assert.ok(Math.abs(node.value - hillsHeightAt(x, z, 1.3)) < 1e-9);
  }
  assert.equal(hillsHeightWith(SCALAR_OPS, 5, 6), hillsHeightAt(5, 6));

  // And it builds real TSL nodes.
  const real = createHillsHeightNode(THREE.TSL)(THREE.TSL.vec2(1, 2));
  assert.equal(real.isNode, true);
});

test('the ground grid is fine under the grass, reaches the horizon and faces up', () => {
  const options = { radius: 1500, segments: 384, innerSpacing: 0.5 };
  const { positions, indices, axis } = createGroundGridArrays(options);
  assert.equal(axis.length, 385);
  assert.ok(Math.abs(axis[0] + 1500) < 1e-3 && Math.abs(axis.at(-1) - 1500) < 1e-3);
  assert.equal(axis[192], 0);
  assert.ok(Math.abs(groundAxisAt(193, options) - 0.5) < 1e-3);
  // Under the far grass ring (52 m) cells stay a few metres or finer.
  for (let index = 192; axis[index] < 52; index += 1) {
    assert.ok(axis[index + 1] - axis[index] < 2.6);
  }
  for (let index = 1; index < axis.length; index += 1) assert.ok(axis[index] > axis[index - 1]);

  const [a, b, c] = [...indices.slice(0, 3)].map((vertex) => new THREE.Vector3().fromArray(positions, vertex * 3));
  const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
  assert.ok(normal.y > 0, 'triangles wind counter-clockwise from above');
  assert.equal(indices.length, 384 * 384 * 6);

  assert.throws(() => createGroundGridArrays({ ...options, segments: 383 }), RangeError);
  assert.throws(() => createGroundGridArrays({ ...options, innerSpacing: 10 }), RangeError);
  assert.deepEqual(snapGroundCentre(10.26, -3.74, 0.5), [10.5, -3.5]);
});

