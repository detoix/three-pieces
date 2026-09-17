import assert from 'node:assert/strict';
import test from 'node:test';
import { createSky, sunDirectionFrom } from '../src/sky/index.js';

const probe = { sun: [1, 2, 3], sky: [4, 5, 6] };
const fakeRenderer = overrides => ({
  compute() {},
  computeAsync: async () => {},
  getArrayBufferAsync: async () => ({
    buffer: new Float32Array([1, 2, 3, 0, 4, 5, 6, 0]).buffer,
    release() {},
  }),
  ...overrides,
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('sky has independent defaults and rejects unsupported inputs before allocation', () => {
  const renderer = fakeRenderer();
  for (const bad of [undefined, null, [], 'sky']) {
    assert.throws(() => createSky(bad), TypeError);
  }
  assert.throws(() => createSky({ renderer: {}, clouds: false }), /renderer/);
  assert.throws(() => createSky({ renderer: fakeRenderer({ initialized: false }) }), /renderer.init/);
  const invalid = [
    { sunElevation: undefined, sunAzimuth: NaN }, { sunElevation: 91 },
    { sunElevation: '45' }, { exposure: -1 }, { exposure: Infinity },
    { multiScatter: NaN }, { eyeHeightKm: -1 }, { eyeHeightKm: 100 },
    { clouds: 'off' }, { cloudQuality: 'toString' }, { cloudQuality: 'ultra' },
    { cloudCoverage: 1.01 }, { cloudWindSpeed: -1 }, { cloudWindSpeed: 101 },
    { cloudSeed: -1 }, { cloudSeed: 0x100000000 }, { cloudSeed: 1.5 },
  ];
  for (const options of invalid) {
    assert.throws(() => createSky({ renderer, clouds: false, ...options }),
      error => error instanceof TypeError || error instanceof RangeError,
      JSON.stringify(options));
  }
  const sky = createSky({ renderer, clouds: false });
  try {
    assert.deepEqual(sky.sunDirection, sunDirectionFrom(45, 0));
    assert.equal(sky.ready, false);
    assert.equal(sky.clouds, null);
    assert.ok(Object.isFrozen(sky));
    assert.ok(Object.isFrozen(sky.sunDirection));
    assert.equal(sky.skyExposure, undefined);
    assert.equal(sky.multiScatterScale, undefined);
    assert.throws(() => { sky.sunDirection[1] = 10; }, TypeError);
    assert.throws(() => { sky.stats.bytes = 0; }, TypeError);
  } finally { sky.dispose(); }
});

test('setSun can initialize all atmosphere tables and later skips invariant tables', async () => {
  let dispatches = 0;
  const sky = createSky({ renderer: fakeRenderer({
    computeAsync: async () => { dispatches++; },
  }), clouds: false });
  try {
    assert.deepEqual(await sky.setSun(12, -90), probe);
    assert.equal(dispatches, 4, 'first sun must initialize all LUTs and the probe');
    assert.deepEqual(sky.sunDirection, sunDirectionFrom(12, 270));
    assert.equal(sky.ready, true);
    await sky.setSun(30, 40);
    assert.equal(dispatches, 6, 'later sun updates only view LUT and probe');
    assert.equal(sky.update(1), false, 'clear atmosphere has no frame work');
  } finally { sky.dispose(); }
});

test('invalid sun requests cannot mutate state or poison the bake queue', async () => {
  const sky = createSky({ renderer: fakeRenderer(), clouds: false });
  try {
    const initial = sky.sunDirection;
    await assert.rejects(sky.setSun(NaN, 40), TypeError);
    await assert.rejects(sky.setSun(91, 40), RangeError);
    assert.deepEqual(sky.sunDirection, initial);
    assert.deepEqual(await sky.bake(), probe);
    assert.equal(sky.ready, true);
  } finally { sky.dispose(); }
});

test('fog and time validation rejects degenerate shader inputs', () => {
  const sky = createSky({ renderer: fakeRenderer(), clouds: false });
  for (const options of [undefined, null, { near: NaN, far: 10 },
    { near: -1, far: 10 }, { near: 10, far: 10 }, { near: 20, far: 10 }]) {
    assert.throws(() => sky.fogNodeFor(options));
  }
  assert.ok(sky.fogNodeFor({ near: 0, far: 100 }).isNode);
  assert.throws(() => sky.update(NaN), TypeError);
  assert.throws(() => sky.update(-1), RangeError);
  assert.throws(() => sky.update(1, { x: Infinity, z: 0 }), TypeError);
  assert.throws(() => sky.update(1, { x: 0 }), TypeError);
  assert.equal(sky.update(1, { x: 12, z: -3 }), false, 'a valid observer with clouds off is no work');
  sky.dispose();
  assert.equal(sky.ready, false);
  assert.equal(sky.disposed, true);
  assert.equal(sky.update(1), false);
  assert.throws(() => sky.fogNodeFor({ near: 1, far: 2 }), /disposed/);
});

test('cloud frame work is guarded through asynchronous baking, failure and recovery', async () => {
  let updates = 0;
  let fail = false;
  let block = false;
  const started = deferred(), finished = deferred();
  const failure = new Error('Injected GPU failure');
  const sky = createSky({ cloudQuality: 'low', renderer: fakeRenderer({
    compute: () => { updates++; },
    computeAsync: async () => {
      if (fail) throw failure;
      if (block) { started.resolve(); await finished.promise; }
    },
  }) });
  try {
    assert.equal(sky.clouds.bake, undefined);
    assert.equal(sky.clouds.update, undefined);
    assert.equal(sky.clouds.dispose, undefined);
    assert.ok(Object.isFrozen(sky.clouds.stats));
    assert.equal(sky.update(0), false);
    await sky.bake();
    assert.equal(sky.ready, true);
    assert.equal(sky.update(1), true);
    assert.equal(updates, 1);
    assert.throws(() => sky.update(0.5), /monotonic/);
    block = true;
    const baking = sky.bake();
    await started.promise;
    assert.equal(sky.ready, false);
    assert.equal(sky.update(2), false);
    assert.equal(updates, 1);
    block = false;
    finished.resolve();
    await baking;
    assert.equal(sky.update(0), true, 'successful bake can reset the animation clock');
    fail = true;
    await assert.rejects(sky.bake(), error => error === failure);
    assert.equal(sky.ready, false);
    assert.equal(sky.update(3), false);
    fail = false;
    await sky.bake();
    assert.equal(sky.ready, true);
    assert.equal(sky.update(3), true);
    assert.equal(updates, 3);
  } finally { sky.dispose(); }
});

test('disposal during cloud initialization stops all later cloud dispatches', async () => {
  const started = deferred(), finished = deferred();
  let cloudDispatches = 0;
  let cloudDisposals = 0;
  const sky = createSky({ cloudQuality: 'low', renderer: fakeRenderer({
    computeAsync: async pass => {
      if (pass.name !== 'Initialize volumetric cloud sky') return;
      cloudDispatches++;
      pass.addEventListener('dispose', () => { cloudDisposals++; });
      started.resolve();
      await finished.promise;
    },
  }) });
  const baking = sky.bake();
  await started.promise;
  sky.dispose();
  sky.dispose();
  finished.resolve();
  await assert.rejects(baking, /disposed/);
  assert.equal(cloudDispatches, 1);
  assert.equal(cloudDisposals, 1);
  assert.equal(sky.update(2), false);
  await assert.rejects(sky.setSun(20, 10), /disposed/);
});
