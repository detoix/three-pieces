import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3, TSL } from 'three/webgpu';
import { createVolumetricClouds } from '../src/sky/clouds.js';

function createRecordedClouds(options = {}) {
  const initializations = [];
  const updates = [];
  // The shadow map's own passes, kept apart: these tests are about the sky's
  // cache, and `sky-cloud-shadow.test.js` is about the shadows. The ambient
  // average is kept apart for the same reason: it runs once a bake and once a
  // completed cycle, and it reads the cache rather than filling it.
  const shadowMarches = [];
  const ambientAverages = [];
  const disposedPasses = new Map();
  function record(target, pass) {
    if (clouds.stats.shadow?.computeNodeIds.includes(pass.id)) {
      shadowMarches.push({ id: pass.id, count: pass.count });
      return;
    }
    if (pass.name === 'Average the cloudy sky') {
      ambientAverages.push({ id: pass.id, count: pass.count });
      return;
    }
    if (!disposedPasses.has(pass.id)) {
      disposedPasses.set(pass.id, 0);
      pass.addEventListener('dispose', () => {
        disposedPasses.set(pass.id, disposedPasses.get(pass.id) + 1);
      });
    }
    target.push({ id: pass.id, count: pass.count });
  }
  const clouds = createVolumetricClouds({
    renderer: {
      computeAsync: async pass => { record(initializations, pass); },
      compute: pass => { record(updates, pass); },
    },
    sunDirection: TSL.uniform(new Vector3(0, 1, 0)),
    exposure: TSL.uniform(1),
    skyRadianceNode: TSL.Fn(() => TSL.vec3(0.1, 0.2, 0.3)),
    quality: 'low',
    ...options,
  });
  return { clouds, initializations, updates, shadowMarches, ambientAverages, disposedPasses };
}

for (const [condition, options] of [
  ['zero wind', { windSpeed: 0 }],
  ['zero coverage', { coverage: 0 }],
]) {
  test(`${condition} initializes both cloud snapshots but skips all incremental compute`, async () => {
    const { clouds, initializations, updates, shadowMarches, ambientAverages } = createRecordedClouds(options);
    // One whole shadow map a bake, when there are clouds to cast one.
    const shadowsPerBake = options.coverage === 0 ? 0 : 1;
    try {
      clouds.update(0);
      assert.equal(initializations.length + updates.length, 0,
        'no cloud work may run before a bake');
      await clouds.bake();
      // Three marches of the whole hemisphere a bake: a probe, whose clouds
      // are lit by the clear sky because there is no cloudy one to average
      // yet, and the two displayed snapshots, marched again under the average
      // taken off that probe.
      assert.equal(initializations.length, 3);
      assert.equal(ambientAverages.length, 2, 'averaged off the probe, then off the displayed sky');
      assert.ok(initializations.every(pass =>
        pass.id === clouds.stats.computeNodeIds[0] &&
        pass.count === clouds.stats.width * clouds.stats.height));

      for (let frame = 0; frame < clouds.stats.slices * 3; frame++) {
        clouds.update(frame / 60);
      }
      assert.equal(updates.length, 0);
      assert.equal(shadowMarches.length, shadowsPerBake, 'a still sky over a still observer');
      assert.equal(clouds.stats.updatedTexels, 0);
      assert.equal(clouds.stats.generation, 0);

      // Static animation does not prevent an explicit lighting rebake.
      await clouds.bake({ sun: [0.6, 0.5, 0.4], sky: [0.1, 0.2, 0.3] });
      clouds.update(0);
      assert.equal(initializations.length, 6);
      assert.equal(updates.length, 0);
      assert.equal(shadowMarches.length, 2 * shadowsPerBake);
    } finally { clouds.dispose(); }
  });
}

test('a still sky stays idle near its observer and remarches, twice, once they walk away', async () => {
  const { clouds, updates } = createRecordedClouds({ windSpeed: 0 });
  try {
    await clouds.bake();
    const slices = clouds.stats.slices;
    let time = 0;
    const run = (frames, observer) => {
      for (let frame = 0; frame < frames; frame++) clouds.update((time++) / 60, observer);
    };
    run(slices, undefined);
    assert.equal(updates.length, 0, 'no observer is the origin, and the origin never moves');
    assert.deepEqual(clouds.stats.cacheOriginKm, [0, 0]);

    run(slices, { x: 60, z: -60 });
    assert.equal(updates.length, 0, 'inside the refresh distance nothing is remarched');

    const away = { x: 900, z: -400 };
    run(slices, away);
    assert.equal(clouds.stats.generation, 1);
    assert.deepEqual(clouds.stats.cacheOriginKm, [0.9, -0.4]);
    // The displayed snapshot is still an old one: a second cycle brings it in.
    run(slices, away);
    assert.equal(clouds.stats.generation, 2);
    run(slices * 2, away);
    assert.equal(clouds.stats.generation, 2, 'idle again once the displayed snapshot is local');
    assert.equal(updates.length, slices * 2);
    assert.throws(() => clouds.update(time / 60, { x: NaN, z: 0 }), TypeError);
  } finally { clouds.dispose(); }
});

test('windy snapshots record the observer they start from', async () => {
  const { clouds } = createRecordedClouds({ windSpeed: 12 });
  try {
    await clouds.bake();
    const slices = clouds.stats.slices;
    for (let frame = 0; frame < slices; frame++) clouds.update(frame / 60, { x: 2500 + frame, z: 40 });
    assert.equal(clouds.stats.generation, 1);
    assert.deepEqual(clouds.stats.cacheOriginKm, [2.5, 0.04], 'recorded as the cycle began');
  } finally { clouds.dispose(); }
});

test('animated clouds complete every configured slice before advancing and clamp long clock gaps', async () => {
  const { clouds, initializations, updates, disposedPasses } = createRecordedClouds({
    quality: 'balanced', windSpeed: 12, coverage: 0.48,
  });
  try {
    await clouds.bake();
    assert.equal(initializations.length, 3);
    const slices = clouds.stats.slices;
    assert.ok(Number.isInteger(slices) && slices > 1);
    const texels = clouds.stats.width * clouds.stats.height;

    // Incomplete generations must stay incomplete; each finished cycle submits
    // exactly one full atlas worth of work across all of its partial passes.
    for (let cycle = 0; cycle < 2; cycle++) {
      const firstUpdate = updates.length;
      for (let frame = 0; frame < slices - 1; frame++) {
        clouds.update((cycle * slices + frame) / 60);
        assert.equal(clouds.stats.generation, cycle);
      }
      clouds.update((cycle * slices + slices - 1) / 60);
      assert.equal(clouds.stats.generation, cycle + 1);
      assert.equal(updates.length - firstUpdate, slices);
      assert.equal(updates.slice(firstUpdate).reduce((sum, pass) => sum + pass.count, 0), texels);
      assert.ok(Math.abs(clouds.stats.cacheLatencySeconds - slices / 60) < 0.02);
    }
    assert.ok(updates.every(pass => pass.id === clouds.stats.computeNodeIds[1]));
    assert.equal(initializations.length, 3, 'incremental rotation does not rebake the whole atlas');

    // A resumed tab must not report hours of simulation inside the next cache
    // cycle. The long first interval contributes the documented 0.1 s maximum.
    for (let frame = 0; frame < slices; frame++) clouds.update(10000 + frame / 60);
    assert.equal(clouds.stats.generation, 3);
    assert.equal(updates.length, slices * 3);
    assert.ok(Math.abs(clouds.stats.cacheLatencySeconds - (0.1 + (slices - 1) / 60)) < 1e-8);

    clouds.dispose();
    clouds.dispose();
    assert.equal(disposedPasses.size, 2, 'the cache passes; the average and the shadows are counted apart');
    assert.ok([...disposedPasses.values()].every(count => count === 1));
    clouds.update(10002);
    await clouds.bake();
    assert.equal(updates.length, slices * 3);
    assert.equal(initializations.length, 3);
  } finally { clouds.dispose(); }
});

test('the cloudy sky is read off the cache, once written, and keeps its identity', async () => {
  const reads = [];
  // A vec4: the irradiance, and A as the flag `ambientPass` sets once it has
  // a cache to average. Values a float32 holds exactly, so the readback can
  // be compared for what it is.
  let stored = new Float32Array([0, 0, 0, 0]);
  const clouds = createVolumetricClouds({
    renderer: {
      computeAsync: async () => {},
      compute: () => {},
      getArrayBufferAsync: async (attribute, readback, offset, size) => {
        reads.push({ name: attribute.name, offset, size });
        return { buffer: stored.buffer.slice(0), release() {} };
      },
    },
    sunDirection: TSL.uniform(new Vector3(0, 1, 0)),
    exposure: TSL.uniform(1),
    skyRadianceNode: TSL.Fn(() => TSL.vec3(0.1, 0.2, 0.3)),
    quality: 'low',
    windSpeed: 0,
  });
  try {
    assert.equal(clouds.cloudySky, null, 'no sky before a bake');
    await clouds.bake();
    assert.equal(clouds.cloudySky, null, 'an unwritten average is not a sky');
    assert.equal(reads.length, 1, 'one readback a bake');
    assert.equal(reads[0].size, 16, 'one vec4');

    stored = new Float32Array([0.0625, 0.125, 0.25, 1]);
    await clouds.bake();
    assert.deepEqual([...clouds.cloudySky], [0.0625, 0.125, 0.25]);
    assert.ok(Object.isFrozen(clouds.cloudySky));

    const unchanged = clouds.cloudySky;
    await clouds.bake();
    assert.equal(clouds.cloudySky, unchanged, 'a sky that has not moved is the same array');

    stored = new Float32Array([0.0625, 0.125, 0.5, 1]);
    await clouds.bake();
    assert.notEqual(clouds.cloudySky, unchanged, 'a sky that has moved is a new one');
    assert.deepEqual([...clouds.cloudySky], [0.0625, 0.125, 0.5]);
  } finally { clouds.dispose(); }
});

test('a failed readback costs a cycle of freshness, not the bake', async () => {
  const clouds = createVolumetricClouds({
    renderer: {
      computeAsync: async () => {},
      compute: () => {},
      getArrayBufferAsync: async () => { throw new Error('device lost the buffer'); },
    },
    sunDirection: TSL.uniform(new Vector3(0, 1, 0)),
    exposure: TSL.uniform(1),
    skyRadianceNode: TSL.Fn(() => TSL.vec3(0.1, 0.2, 0.3)),
    quality: 'low',
    windSpeed: 0,
  });
  try {
    await clouds.bake();
    assert.equal(clouds.cloudySky, null);
    assert.equal(clouds.stats.generation, 0);
    clouds.update(0);
  } finally { clouds.dispose(); }
});
