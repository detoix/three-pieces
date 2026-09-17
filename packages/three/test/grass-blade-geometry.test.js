import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
  bladeUniqueVertexCount,
  createBladeGeometry,
} from '../src/grass/blade-geometry.js';
import { createGPUDrivenGrass } from '../src/grass/grass.js';
import {
  GRASS_RINGS,
  bladeVertexCount,
  grassTriangleCount,
} from '../src/grass/grid.js';
import { LAWN } from '../src/grass/preset.js';
import { createFlatHeightTexture } from './helpers/height-maps.js';

/** The original non-indexed triangle stream, retained as the equivalence oracle. */
function originalPositions(segments, tillers) {
  const positions = [];
  for (let tiller = 0; tiller < tillers; tiller += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const y0 = segment / segments;
      const y1 = (segment + 1) / segments;
      const half0 = (1 - y0) ** LAWN.taper * 0.5;
      const half1 = (1 - y1) ** LAWN.taper * 0.5;
      positions.push(-half0, y0, 0, half0, y0, 0, -half1, y1, 0);
      if (segment < segments - 1) {
        positions.push(half0, y0, 0, half1, y1, 0, -half1, y1, 0);
      }
    }
  }
  return new Float32Array(positions);
}

test('indexed blades expand to exactly the original triangles and tillers', () => {
  for (const segments of [1, 2, 3, 8]) {
    for (const tillers of [1, 3, 5]) {
      const geometry = createBladeGeometry(segments, tillers, { mown: false });
      const expanded = geometry.toNonIndexed();
      assert.deepEqual(
        expanded.attributes.position.array,
        originalPositions(segments, tillers),
      );
      assert.equal(geometry.attributes.position.count,
        bladeUniqueVertexCount(segments) * tillers);
      assert.equal(geometry.index.count, bladeVertexCount(segments) * tillers);
      // Blade shading uses local position.x/y rather than texture UVs. Keep
      // that input stream identical instead of introducing different UVs.
      assert.equal(geometry.attributes.uv, undefined);
      for (let drawVertex = 0; drawVertex < geometry.index.count; drawVertex += 1) {
        const originalTiller = Math.floor(drawVertex / bladeVertexCount(segments));
        const indexedTiller = Math.floor(
          geometry.index.getX(drawVertex) / bladeUniqueVertexCount(segments),
        );
        assert.equal(indexedTiller, originalTiller);
      }
      expanded.dispose();
      geometry.dispose();
    }
  }
});

test('each geometry LOD has its exact unique-vertex and submitted-index budget', () => {
  assert.deepEqual(GRASS_RINGS.map((ring) => bladeUniqueVertexCount(ring.segments, ring)),
    [7, 4, 4, 3]);
  assert.deepEqual(GRASS_RINGS.map((ring) => bladeVertexCount(ring.segments, ring)),
    [15, 6, 6, 3]);
});

test('mown profiles keep the draw budget and separate clipped tips from young leaves', () => {
  for (const segments of [1, 2, 3, 8]) {
    const geometry = createBladeGeometry(segments, 4);
    const positions = geometry.attributes.position;
    const perTiller = bladeUniqueVertexCount(segments);
    assert.equal(positions.count, perTiller * 4);
    assert.equal(geometry.index.count, bladeVertexCount(segments) * 4);
    for (let tiller = 0; tiller < 4; tiller += 1) {
      const tips = [];
      for (let vertex = tiller * perTiller; vertex < (tiller + 1) * perTiller; vertex += 1) {
        const x = positions.getX(vertex);
        const y = positions.getY(vertex);
        assert.ok(Math.abs(x) <= .5 && y >= 0 && y <= 1,
          'the original width and height culling bounds still contain the blade');
        if (y === 1) tips.push(x);
      }
      const clipped = segments > 1 && tiller < 3;
      assert.equal(tips.length, clipped ? 2 : 1);
      if (clipped) assert.ok(tips[0] < -.25 && tips[1] > .25);
      else assert.equal(Math.abs(tips[0]), 0);
    }
    // Every emitted triangle stays non-degenerate and consistently wound.
    for (let triangle = 0; triangle < geometry.index.count; triangle += 3) {
      const ids = [0, 1, 2].map((offset) => geometry.index.getX(triangle + offset));
      const [a, b, c] = ids.map((id) => [positions.getX(id), positions.getY(id)]);
      const twiceArea = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      assert.ok(twiceArea > 0);
      assert.equal(new Set(ids.map((id) => Math.floor(id / perTiller))).size, 1);
    }
    geometry.dispose();
  }
});

test('clipped strips have no holes through their full retained width', () => {
  const inside = (x, y, triangle) => triangle.every((point, index) => {
    const next = triangle[(index + 1) % 3];
    return (next[0] - point[0]) * (y - point[1]) -
      (next[1] - point[1]) * (x - point[0]) >= -1e-8;
  });
  for (const segments of [2, 3, 8]) {
    const geometry = createBladeGeometry(segments, 1);
    const positions = geometry.attributes.position;
    const triangles = [];
    for (let at = 0; at < geometry.index.count; at += 3) {
      triangles.push([0, 1, 2].map((offset) => {
        const index = geometry.index.getX(at + offset);
        return [positions.getX(index), positions.getY(index)];
      }));
    }
    // The clipped profile retains at least half its original width at the
    // top; its interior must be covered at every height, including the cut.
    for (let row = 0; row <= 100; row += 1) {
      for (let column = 0; column <= 20; column += 1) {
        const x = -.25 + column * .025;
        const y = row / 100;
        assert.ok(triangles.some((triangle) => inside(x, y, triangle)),
          `uncovered point ${x}, ${y} in ${segments}-segment blade`);
      }
    }
    geometry.dispose();
  }
});

test('indexed draw commands and visible-count readback use five-word strides', async () => {
  const { Fn, mix, vec3 } = THREE.TSL;
  const counts = [7, 11, 13, 17];
  const surface = {
    macroAt: Fn(([worldXZ]) => worldXZ.x.mul(0).add(0.5)),
    healthAt: Fn(([worldXZ]) => worldXZ.x.mul(0).add(0.6)),
    tintFrom: Fn(([macro]) => vec3(macro, macro, macro)),
    densityFrom: Fn(([macro]) => mix(0.78, 1, macro)),
    dryAt: Fn(([health]) => health.oneMinus()),
    dryTintFrom: Fn(([dry]) => vec3(dry, dry, dry)),
  };
  let released = false;
  const renderer = {
    async getArrayBufferAsync(attribute, readback, offset, size) {
      assert.equal(offset, 0);
      assert.equal(size, GRASS_RINGS.length * 5 * Uint32Array.BYTES_PER_ELEMENT);
      const words = attribute.array.slice();
      for (const ring of GRASS_RINGS) words[ring.index * 5 + 1] = counts[ring.index];
      return { buffer: words.buffer, release() { released = true; } };
    },
  };
  const heightMap = createFlatHeightTexture({ resolution: 8 });
  const grass = createGPUDrivenGrass({ renderer, heightMap, surface, shadows: false,
    tillers: 3 });
  try {
    const commands = grass.group.children[0].geometry.indirect;
    assert.equal(commands.itemSize, 5);
    assert.equal(commands.count, GRASS_RINGS.length);
    for (const ring of GRASS_RINGS) {
      const geometry = grass.group.children[ring.index].geometry;
      assert.ok(geometry.index, 'Three selects drawIndexedIndirect from this index');
      assert.strictEqual(geometry.indirect, commands);
      assert.equal(geometry.indirectOffset, ring.index * 20);
      assert.deepEqual([...commands.array.slice(ring.index * 5, (ring.index + 1) * 5)],
        [geometry.index.count, 0, 0, 0, 0]);
    }
    assert.equal(await grass.sampleVisibleCounts(), true);
    assert.equal(released, true);
    assert.deepEqual([...grass.stats().visible], counts);
    assert.equal(grass.stats().triangles, grassTriangleCount(counts, 3));
  } finally {
    grass.dispose();
    heightMap.texture.dispose();
  }
});


test('compact ribbons preserve endpoints, tiller identity and valid triangle coverage', () => {
  for (const tillers of [1, 4, 7, 8]) {
    const shape = { ribbon: true };
    const geometry = createBladeGeometry(2, tillers, shape);
    const reference = createBladeGeometry(2, tillers);
    const p = geometry.attributes.position;
    const r = reference.attributes.position;
    const stride = bladeUniqueVertexCount(2, shape);
    assert.equal(stride, 4);
    assert.equal(p.count, stride * tillers);
    assert.equal(geometry.index.count, bladeVertexCount(2, shape) * tillers);
    let degenerate = 0;
    for (let tiller = 0; tiller < tillers; tiller++) {
      const base = tiller * stride;
      for (const y of [0, 1]) {
        const endpoints = [0, 1, 2, 3].map(i => base + i)
          .filter(i => p.getY(i) === y).map(i => p.getX(i));
        const original = [0, 1, 2, 3, 4].map(i => tiller * 5 + i)
          .filter(i => r.getY(i) === y).map(i => r.getX(i));
        assert.ok(Math.min(...endpoints) === Math.min(...original));
        assert.ok(Math.max(...endpoints) === Math.max(...original));
      }
      let twiceArea = 0;
      for (let triangle = tiller * 6; triangle < tiller * 6 + 6; triangle += 3) {
        const ids = [0, 1, 2].map(offset => geometry.index.getX(triangle + offset));
        assert.ok(ids.every(id => Math.floor(id / stride) === tiller));
        const [a, b, c] = ids.map(id => [p.getX(id), p.getY(id)]);
        const signedArea = (b[0] - a[0]) * (c[1] - a[1]) -
          (b[1] - a[1]) * (c[0] - a[0]);
        assert.ok(signedArea >= 0, 'no inverted triangle');
        if (signedArea === 0) {
          assert.equal(tiller % 4, 3, 'only the young leaf has a collapsed tip');
          degenerate++;
        }
        twiceArea += signedArea;
      }
      const tipWidth = p.getX(base + 3) - p.getX(base + 2);
      assert.ok(Math.abs(twiceArea - (1 + tipWidth)) < 1e-7,
        'two triangles cover the complete trapezoid exactly once');
    }
    assert.equal(degenerate, Math.floor(tillers / 4));
    geometry.dispose();
    reference.dispose();
  }
});
