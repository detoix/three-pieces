import assert from 'node:assert/strict';
import test from 'node:test';
import { createBladeGeometry, bladeUniqueVertexCount,
  CLOSE_RIBBON_MORPH_FROM, CLOSE_RIBBON_MORPH_TO } from '../src/grass/blade-geometry.js';
import { bladeArcAt, bladeCullRadiusFactor, BLADE_CULL_CENTRE } from '../src/grass/blade-arc.js';
import { CULL_TRANSLATION_LIMIT } from '../src/grass/cull-refresh.js';
import { GRASS_RINGS } from '../src/grass/grid.js';
import { LAWN } from '../src/grass/preset.js';

const close = GRASS_RINGS.find(r => r.id === 'close');
const near = GRASS_RINGS.find(r => r.id === 'near');
const mix = (a, b, t) => a + (b - a) * t;
const almost = (a, b, message = '') => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} != ${b}`);

function targets(tillers = 4) {
  const detailed = createBladeGeometry(close.segments, tillers, { ...close, morphToRibbon: true });
  const ribbon = createBladeGeometry(near.segments, tillers, near);
  return { detailed, ribbon };
}

function targetAt(geometry, vertex, bend, morph) {
  const p = geometry.attributes.position, r = geometry.attributes.grassRibbonShape;
  const along = p.getY(vertex);
  const arc = bladeArcAt(bend, along), tip = bladeArcAt(bend, 1);
  return [mix(p.getX(vertex), r.getX(vertex), morph),
    mix(arc.rise, tip.rise * along, morph), mix(arc.reach, tip.reach * along, morph)];
}

function normalAt(x, along, bend) {
  const splay = x * 2 * LAWN.normalSpread;
  return [Math.sin(splay), -Math.sin(bend * along) * Math.cos(splay), Math.cos(bend * along) * Math.cos(splay)];
}

test('morph preserves topology and reaches the near silhouette before either hysteretic handover', () => {
  assert.ok(CLOSE_RIBBON_MORPH_FROM > 0 && CLOSE_RIBBON_MORPH_FROM < CLOSE_RIBBON_MORPH_TO);
  assert.ok(CLOSE_RIBBON_MORPH_TO + CULL_TRANSLATION_LIMIT + LAWN.tillerSpread * .5 < close.outer,
    'even the closest live eye/root pair at a frozen 2 m handover must finish morphing');
  const { detailed, ribbon } = targets();
  const control = createBladeGeometry(close.segments, 4, close);
  try {
    assert.deepEqual(detailed.index.array, control.index.array);
    assert.deepEqual(detailed.attributes.position.array, control.attributes.position.array);
    assert.equal(detailed.attributes.grassRibbonShape.count, detailed.attributes.position.count);
    assert.equal(detailed.attributes.grassRibbonShape.itemSize, 4);
    assert.equal(ribbon.attributes.grassRibbonShape, undefined, 'near ribbon receives no extra morph attribute or work');
    for (const ring of GRASS_RINGS.filter(r => r.id !== 'close')) {
      const geometry = createBladeGeometry(ring.segments, 4, ring);
      assert.equal(geometry.attributes.grassRibbonShape, undefined);
      geometry.dispose();
    }
  } finally { detailed.dispose(); ribbon.dispose(); control.dispose(); }
});

test('morph endpoints preserve close roots/tips and make every edge coincide with the actual near ribbon', () => {
  for (const tillers of [1, 4, 7]) {
    const { detailed, ribbon } = targets(tillers);
    const p = detailed.attributes.position, r = ribbon.attributes.position;
    const stride = bladeUniqueVertexCount(close.segments, close);
    try {
      for (let vertex = 0; vertex < p.count; vertex++) {
        const tiller = Math.floor(vertex / stride), side = p.getX(vertex) > 0 ? 1 : 0;
        const y = p.getY(vertex);
        const rootX = r.getX(tiller * 4 + side), tipX = r.getX(tiller * 4 + 2 + side);
        for (const bend of [0, LAWN.minBend, LAWN.maxBend, 1.6, 2.2]) {
          const original = bladeArcAt(bend, y);
          const unmodified = targetAt(detailed, vertex, bend, 0);
          almost(unmodified[0], p.getX(vertex)); almost(unmodified[1], original.rise); almost(unmodified[2], original.reach);
          const full = targetAt(detailed, vertex, bend, 1);
          const root = bladeArcAt(bend, 0), tip = bladeArcAt(bend, 1);
          almost(full[0], mix(rootX, tipX, y), 'full morph follows a straight near edge');
          almost(full[1], mix(root.rise, tip.rise, y)); almost(full[2], mix(root.reach, tip.reach, y));
          if (y === 0 || y === 1) for (const t of [.1, .25, .5, .75, 1]) {
            targetAt(detailed, vertex, bend, t).forEach((value, axis) => almost(value, unmodified[axis], 'root/tip stays fixed'));
          }
        }
      }
      // Full morph keeps consistent triangle winding and exactly the near
      // trapezoid/triangle area: no disappearing slices, overlaps or holes.
      for (let tiller = 0; tiller < tillers; tiller++) {
        let area = 0;
        const indices = detailed.index, shape = detailed.attributes.grassRibbonShape;
        for (let i = 0; i < indices.count; i += 3) {
          const ids = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
          if (Math.floor(ids[0] / stride) !== tiller) continue;
          const [a, b, c] = ids.map(id => [shape.getX(id), p.getY(id)]);
          const twiceArea = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          assert.ok(twiceArea > 0, 'full-morph triangle keeps its winding');
          area += twiceArea / 2;
        }
        const topWidth = r.getX(tiller * 4 + 3) - r.getX(tiller * 4 + 2);
        almost(area, (1 + topWidth) / 2, 'same full ribbon silhouette area');
      }
    } finally { detailed.dispose(); ribbon.dispose(); }
  }
});

test('morphed edge normals reproduce the near ribbon endpoint interpolation', () => {
  const { detailed, ribbon } = targets();
  const p = detailed.attributes.position, shape = detailed.attributes.grassRibbonShape, r = ribbon.attributes.position;
  const stride = bladeUniqueVertexCount(close.segments, close);
  try {
    for (let vertex = 0; vertex < p.count; vertex++) {
      const tiller = Math.floor(vertex / stride), side = p.getX(vertex) > 0 ? 1 : 0, along = p.getY(vertex);
      for (const bend of [0, .3, .55, 1.6]) {
        const root = normalAt(r.getX(tiller * 4 + side), 0, bend);
        const tip = normalAt(r.getX(tiller * 4 + 2 + side), 1, bend);
        // The precomputed fixed splay factors plus the live bend are the
        // shader's close-only endpoint representation, independent of width.
        const actualRoot = [shape.getY(vertex), 0, Math.cos(LAWN.normalSpread)];
        const actualTip = [shape.getW(vertex), -Math.sin(bend) * shape.getZ(vertex), Math.cos(bend) * shape.getZ(vertex)];
        for (let axis = 0; axis < 3; axis++) almost(mix(actualRoot[axis], actualTip[axis], along), mix(root[axis], tip[axis], along));
      }
    }
  } finally { detailed.dispose(); ribbon.dispose(); }
});

test('every morph weight remains within the existing crown sphere without height overshoot', () => {
  const { detailed, ribbon } = targets();
  const positions = detailed.attributes.position;
  try {
    for (const maxBend of [.2, LAWN.maxBend, 1.1, 1.6, 2.2]) {
      for (const bend of [0, maxBend * .5, maxBend]) {
        for (const sizeScale of [.65, 1, 2]) {
          const height = LAWN.maxHeight * sizeScale, width = LAWN.maxWidth * sizeScale;
          const offset = LAWN.tillerSpread * .5;
          const radius = height * bladeCullRadiusFactor(maxBend) + width * .5 * LAWN.maxThicken + offset;
          for (const shorten of [LAWN.tillerShortest * LAWN.clumpShortest, 1]) {
            for (let vertex = 0; vertex < positions.count; vertex++) {
              const arc = bladeArcAt(bend, positions.getY(vertex));
              for (const weight of [0, .1, .25, .5, .75, .9, 1]) {
                const [x, rise, reach] = targetAt(detailed, vertex, bend, weight);
                assert.ok(rise <= arc.rise + 1e-10, 'chord interpolation cannot raise a blade above its original curve');
                const distance = Math.hypot(x * width * LAWN.maxThicken,
                  rise * height * shorten - BLADE_CULL_CENTRE * height,
                  reach * height * shorten) + offset;
                assert.ok(distance <= radius + 1e-9, 'morphed vertex escaped the unchanged crown sphere');
              }
            }
          }
        }
      }
    }
  } finally { detailed.dispose(); ribbon.dispose(); }
});
