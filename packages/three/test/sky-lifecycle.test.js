import assert from 'node:assert/strict';
import test from 'node:test';
import { Scene } from 'three/webgpu';
import Background from 'three/src/renderers/common/Background.js';
import Color4 from 'three/src/renderers/common/Color4.js';
import { createSky } from '../src/sky/index.js';
import { createFieldSky } from '../src/sky/sky-nodes.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function probeResult(release = () => {}) {
  return { buffer: new Float32Array([1, 2, 3, 0, 4, 5, 6, 0]).buffer, release };
}

function fakeRenderer(overrides = {}) {
  return { computeAsync: async () => {}, getArrayBufferAsync: async () => probeResult(), ...overrides };
}

const options = renderer => ({ renderer, clouds: false, sunElevation: 40, sunAzimuth: 25 });

for (const clouds of [false, true]) {
  test(`sky releases renderer background resources once with clouds ${clouds ? 'on' : 'off'}`, () => {
    const sky = createSky({
      ...options(fakeRenderer({ compute() {} })), clouds, cloudQuality: 'low',
    });
    // Exercise r185's real background-node disposal listener without a GPU.
    // One sky may be installed in multiple host-owned scenes.
    const background = new Background({
      _clearColor: new Color4(),
      xr: { getEnvironmentBlendMode: () => 'opaque' },
      autoClear: false,
    }, { getBackgroundNode: scene => scene.backgroundNode });
    const scenes = [new Scene(), new Scene()];
    const resources = [];
    for (const scene of scenes) {
      scene.backgroundNode = sky.backgroundNode;
      background.update(scene, { unshift(mesh) {
        for (const resource of [mesh.geometry, mesh.material]) {
          const record = { disposals: 0 };
          resource.addEventListener('dispose', () => { record.disposals++; });
          resources.push(record);
        }
      } }, {});
      scene.backgroundNode = null;
    }
    sky.dispose();
    sky.dispose();
    assert.equal(resources.length, 4);
    assert.ok(resources.every(resource => resource.disposals === 1));
    assert.ok(scenes.every(scene => scene.backgroundNode === null));
  });
}

test('sky serializes sun changes behind a pending bake and probe readback', async () => {
  const readStarted = deferred(), readFinished = deferred();
  let reads = 0;
  const renderer = fakeRenderer({
    getArrayBufferAsync: async () => {
      if (++reads === 1) {
        readStarted.resolve();
        await readFinished.promise;
      }
      return probeResult();
    },
  });
  const sky = createSky(options(renderer));
  const initialDirection = sky.sunDirection;
  try {
    const first = sky.bake();
    const second = sky.setSun(10, 120);
    await readStarted.promise;
    assert.deepEqual(sky.sunDirection, initialDirection);
    assert.equal(reads, 1);
    readFinished.resolve();
    assert.deepEqual(await first, { sun: [1, 2, 3], sky: [4, 5, 6] });
    await second;
    assert.equal(reads, 2);
    assert.notDeepEqual(sky.sunDirection, initialDirection);
  } finally {
    sky.dispose();
  }
});

test('failed GPU work rejects its caller without poisoning later queued work', async () => {
  const failure = new Error('GPU dispatch failed');
  let dispatches = 0;
  const sky = createSky(options(fakeRenderer({ computeAsync: async () => {
    if (++dispatches === 1) throw failure;
  } })));
  try {
    const failed = sky.bake();
    const recovered = sky.bake();
    await assert.rejects(failed, error => error === failure);
    assert.deepEqual(await recovered, { sun: [1, 2, 3], sky: [4, 5, 6] });
    assert.equal(dispatches, 5);
  } finally {
    sky.dispose();
  }
});

test('disposal stops a pending bake and queued sun changes before another dispatch', async () => {
  const started = deferred(), finished = deferred();
  let dispatches = 0;
  const sky = createSky(options(fakeRenderer({ computeAsync: async () => {
    dispatches++;
    started.resolve();
    await finished.promise;
  } })));
  const first = sky.bake(), second = sky.setSun(10, 120);
  await started.promise;
  sky.dispose();
  finished.resolve();
  await assert.rejects(first, /disposed/);
  await assert.rejects(second, /disposed/);
  await assert.rejects(sky.bake(), /disposed/);
  await assert.rejects(sky.setSun(20, 40), /disposed/);
  assert.equal(dispatches, 1);
});

test('atmosphere releases all compute passes and probe storage exactly once', async () => {
  const disposed = new Map();
  let deletedBuffers = 0;
  const renderer = fakeRenderer({
    computeAsync: async pass => {
      if (!disposed.has(pass)) {
        disposed.set(pass, 0);
        pass.addEventListener('dispose', () => disposed.set(pass, disposed.get(pass) + 1));
      }
    },
    _attributes: { delete: () => { deletedBuffers++; } },
  });
  const atmosphere = createFieldSky(options(renderer));
  await atmosphere.bake();
  atmosphere.dispose();
  atmosphere.dispose();
  assert.equal(disposed.size, 4);
  assert.ok([...disposed.values()].every(count => count === 1));
  assert.equal(deletedBuffers, 1);
  await assert.rejects(atmosphere.bake(), /disposed/);
  await assert.rejects(atmosphere.setSun(20, 40), /disposed/);
});

test('a readback that completes after disposal is released and rejects clearly', async () => {
  const started = deferred(), finished = deferred();
  let releases = 0;
  const renderer = fakeRenderer({ getArrayBufferAsync: async () => {
    started.resolve();
    await finished.promise;
    return probeResult(() => { releases++; });
  } });
  const atmosphere = createFieldSky(options(renderer));
  const baking = atmosphere.bake();
  await started.promise;
  atmosphere.dispose();
  finished.resolve();
  await assert.rejects(baking, /disposed/);
  assert.equal(releases, 1);
});
