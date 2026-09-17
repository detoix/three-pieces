import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import { createGrass, GRASS_RINGS, LAWN, LAWN_COLORS } from '../src/grass/index.js';
import { createFlatHeightTexture } from './helpers/height-maps.js';

const { Fn, mix, vec3 } = THREE.TSL;

// The lawn only touches the renderer in update() and sampleVisibleCounts(), so
// building and disposing one needs no device -- just the attribute bookkeeping
// dispose() reaches into.
function buildLawn(t, rendererOverrides = {}) {
  const released = [];
  const renderer = {
    _attributes: { delete: (attribute) => released.push(attribute) },
    compute() {},
    getDrawingBufferSize: target => target.set(1920, 1080),
    getArrayBufferAsync: async () => { throw new Error('Unexpected readback'); },
    ...rendererOverrides,
  };
  const surface = {
    material: new THREE.MeshBasicNodeMaterial(),
    macroAt: Fn(([worldXZ]) => worldXZ.x.mul(0).add(0.5)),
    healthAt: Fn(([worldXZ]) => worldXZ.x.mul(0).add(0.6)),
    tintFrom: Fn(([macro]) => vec3(macro, macro, macro)),
    densityFrom: Fn(([macro]) => mix(0.78, 1, macro)),
    dryAt: Fn(([health]) => health.oneMinus()),
    dryTintFrom: Fn(([dry]) => vec3(dry, dry, dry)),
  };
  const heightMap = createFlatHeightTexture({ resolution: 8 });
  const options = {
    renderer,
    heightMap,
    surface,
    shadows: false,
  };
  const grass = createGrass(options);
  t.after(() => { grass.dispose(); heightMap.texture.dispose(); surface.material.dispose(); });
  return { grass, released, options };
}

test('disposing the lawn frees every storage buffer exactly once and stops later work', async t => {
  const { grass, released, options } = buildLawn(t);
  let borrowedDisposals = 0;
  options.heightMap.texture.addEventListener('dispose', () => borrowedDisposals++);
  options.surface.material.addEventListener('dispose', () => borrowedDisposals++);
  assert.equal(grass.groundMaterial, options.surface.material);

  assert.deepEqual(released, []);
  grass.dispose();
  grass.dispose();
  assert.equal(grass.disposed, true);
  grass.update(null);
  grass.invalidateCulling();
  assert.equal(await grass.sampleVisibleCounts(), false);
  assert.equal(borrowedDisposals, 0, 'grass must not dispose host terrain or surface');

  assert.deepEqual(
    released.map((attribute) => attribute.name),
    [
      'Grass indirect draw commands',
      ...GRASS_RINGS.flatMap((ring) => [
        `Grass ${ring.id} records`,
        `Grass ${ring.id} visible IDs`,
      ]),
    ],
  );
  assert.equal(new Set(released).size, released.length);
});

test('no other owner would free those buffers', t => {
  const { grass, released } = buildLawn(t);
  const geometries = grass.group.children.map((mesh) => mesh.geometry);

  grass.dispose();

  // The regression this guards: `BufferAttribute.dispose()` only dispatches an
  // event, and in the WebGPU path the sole listener is the one `Geometries`
  // registers for a geometry's own attributes. None of these is one -- the
  // records and visible IDs are bound as storage nodes, and the draw commands
  // arrive through setIndirect(), which that listener also skips -- so leaving
  // them to `dispose()` leaks their GPU buffers.
  for (const geometry of geometries) {
    const owned = [...Object.values(geometry.attributes), geometry.index];
    for (const attribute of released) {
      assert.equal(owned.includes(attribute), false);
    }
    assert.equal(geometry.indirect, released[0]);
  }
});

test('public terrain and surface contracts reject incomplete inputs before allocation', t => {
  const { options } = buildLawn(t);
  for (const key of ['extent', 'minimum', 'scale', 'texelWorldSize', 'packingMinimum', 'packingRange']) {
    assert.throws(() => createGrass({ ...options, heightMap: { ...options.heightMap, [key]: NaN } }), TypeError);
  }
  for (const key of ['extent', 'texelWorldSize', 'packingRange']) {
    assert.throws(() => createGrass({ ...options, heightMap: { ...options.heightMap, [key]: 0 } }), RangeError);
  }
  assert.throws(() => createGrass({ ...options, renderer: { ...options.renderer, initialized: false } }), /initialized/);
  assert.throws(() => createGrass({ ...options, renderer: { ...options.renderer, backend: { isWebGLBackend: true } } }), /WebGPU/);
  assert.throws(() => createGrass({ ...options, surface: {} }), /surface/);
  assert.throws(() => createGrass({ ...options, keepAt: true }), /keepAt/);
});

test('a procedural heightAt terrain builds without a texture and is validated as its own form', t => {
  const { options } = buildLawn(t);
  const heightAt = Fn(([worldXZ]) => worldXZ.x.sin().mul(2));
  const procedural = { heightAt, normalStep: 0.25, packingMinimum: -2.01, packingRange: 4.02 };
  const grass = createGrass({ ...options, heightMap: procedural });
  assert.equal(grass.group.children.length, GRASS_RINGS.length);
  grass.dispose();

  assert.throws(() => createGrass({ ...options, heightMap: { ...procedural, heightAt: 3 } }), /heightAt/);
  assert.throws(() => createGrass({ ...options, heightMap: { ...procedural, texture: options.heightMap.texture } }), /not both/);
  assert.throws(() => createGrass({ ...options, heightMap: { ...procedural, normalStep: undefined } }), /normalStep/);
  assert.throws(() => createGrass({ ...options, heightMap: { ...procedural, packingRange: 0 } }), RangeError);
  assert.throws(() => createGrass({ ...options, heightMap: {} }), /texture or a heightAt/);
});

test('tuning options accept the maintained lawn and reject malformed values before allocation', t => {
  const { options } = buildLawn(t);
  const valid = {
    ...options,
    coarseCulling: true, cullHysteresis: true, subgroupCulling: false,
    projectedCanopy: true, poseCache: false, diffuseOnly: true,
    backlight: 'view', tillers: 3, minBladePixels: 1.1,
    bend: { min: LAWN.minBend, max: LAWN.maxBend },
    posture: { clumpPull: 0.15, tillerFan: 1.8 },
    canopy: { near: LAWN.canopyNormalNear, far: LAWN.canopyNormalFar },
    greens: LAWN_COLORS, heightCorrelation: 2,
    size: { minHeight: LAWN.minHeight, maxHeight: LAWN.maxHeight, minWidth: LAWN.minWidth, maxWidth: LAWN.maxWidth },
  };
  for (const backlight of [true, false, 'blade', 'off']) {
    createGrass({ ...valid, backlight }).dispose();
  }
  createGrass({ ...valid, greens: { ...LAWN_COLORS, top: new THREE.Color(0x44aa33), ground: 0x335522 } }).dispose();

  const rejects = [
    [{ shadows: 'off' }, TypeError, /shadows/],
    [{ poseCache: 1 }, TypeError, /poseCache/],
    [{ backlight: 'canopy' }, RangeError, /backlight/],
    [{ tillers: 2.5 }, RangeError, /tillers/],
    [{ minBladePixels: Infinity }, RangeError, /minBladePixels/],
    [{ heightCorrelation: NaN }, TypeError, /heightCorrelation/],
    [{ heightCorrelation: -0.1 }, RangeError, /heightCorrelation/],
    [{ bend: null }, TypeError, /bend/],
    [{ bend: { min: 0 } }, TypeError, /bend\.max/],
    [{ bend: { min: 0, max: Infinity } }, TypeError, /bend\.max/],
    [{ posture: { clumpPull: 0.15, tillerFan: Infinity } }, TypeError, /tillerFan/],
    [{ canopy: [0.2, 0.4] }, TypeError, /canopy/],
    [{ size: { ...valid.size, maxWidth: undefined } }, TypeError, /maxWidth/],
    [{ size: { ...valid.size, minHeight: 0 } }, RangeError, /positive/],
    [{ size: { ...valid.size, maxHeight: valid.size.minHeight / 2 } }, RangeError, /ordered/],
    [{ greens: { ...LAWN_COLORS, top: undefined } }, TypeError, /greens\.top/],
    [{ greens: { ...LAWN_COLORS, groundTint: [1, 1] } }, TypeError, /groundTint/],
    [{ greens: { ...LAWN_COLORS, groundTint: [1, NaN, 1] } }, TypeError, /groundTint/],
  ];
  for (const [override, type, message] of rejects) {
    assert.throws(() => createGrass({ ...valid, ...override }), error =>
      error instanceof type && message.test(error.message), JSON.stringify(override));
  }
});

test('snapshotStats keeps a frozen copy while stats() stays live', async t => {
  const counts = GRASS_RINGS.map((ring) => (ring.index + 1) * 10);
  const { grass } = buildLawn(t, {
    getArrayBufferAsync: async () => {
      const words = new Uint32Array(GRASS_RINGS.length * 5);
      for (const ring of GRASS_RINGS) words[ring.index * 5 + 1] = counts[ring.index];
      return { buffer: words.buffer, release() {} };
    },
  });
  const before = grass.snapshotStats();
  assert.notEqual(before, grass.stats());
  assert.deepEqual({ ...before, visible: [...before.visible] },
    { ...grass.stats(), storage: { ...grass.stats().storage }, visible: [...grass.stats().visible] });

  assert.equal(await grass.sampleVisibleCounts(), true);
  assert.deepEqual([...grass.stats().visible], counts);
  assert.ok(grass.stats().triangles > 0);
  assert.deepEqual(before.visible, GRASS_RINGS.map(() => 0), 'the snapshot must not follow the readback');
  assert.equal(before.triangles, 0);

  const after = grass.snapshotStats();
  assert.deepEqual(after.visible, counts);
  for (const frozen of [after, after.storage, after.visible]) assert.ok(Object.isFrozen(frozen));
  assert.throws(() => { after.visible[0] = 0; }, TypeError);
  assert.throws(() => { after.storage.totalBytes = 0; }, TypeError);
  assert.deepEqual([...grass.stats().visible], counts, 'the live counts are not the snapshot\'s array');

  grass.dispose();
  assert.deepEqual(grass.snapshotStats().visible, counts);
});

test('disposal during readback ignores stale data and handles readback cancellation', async t => {
  for (const fails of [false, true]) {
    let resolve, reject, releases = 0;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const { grass } = buildLawn(t, { getArrayBufferAsync: () => pending });
    const sample = grass.sampleVisibleCounts();
    assert.equal(await grass.sampleVisibleCounts(), false, 'only one readback may be pending');
    grass.dispose();
    if (fails) reject(new Error('Buffer destroyed during mapAsync'));
    else resolve({ buffer: new Uint32Array(GRASS_RINGS.length * 5).fill(100).buffer, release() { releases++; } });
    assert.equal(await sample, false);
    assert.equal(releases, fails ? 0 : 1);
    assert.equal(grass.stats().triangles, 0);
    assert.deepEqual([...grass.stats().visible], GRASS_RINGS.map(() => 0));
  }
});
