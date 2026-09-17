import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudNoiseData, createCloudWeatherData, createTileableNoiseSampler } from '../src/sky/cloud-noise.js';

function channelStats(data, channel) {
  const values = Array.from({ length: data.length / 4 }, (_, index) => data[index * 4 + channel]);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min: Math.min(...values), max: Math.max(...values), mean,
    deviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
    values,
  };
}

test('cloud textures have deterministic bytes, dimensions, and seed variation', () => {
  for (const create of [createCloudNoiseData, createCloudWeatherData]) {
    const first = create({ size: 12, seed: 123 });
    assert.deepEqual(first, create({ size: 12, seed: 123 }));
    assert.notDeepEqual(first.data, create({ size: 12, seed: 456 }).data);
    assert.ok(first.data instanceof Uint8Array);
    assert.equal(first.width, 12);
    assert.equal(first.height, 12);
    assert.equal(first.data.length, 12 * 12 * (first.depth ?? 1) * 4);
  }
});

test('gradient and cellular evaluators repeat continuously across every tile boundary', () => {
  const sampler = createTileableNoiseSampler({ cells: 7, seed: 42 });
  for (const evaluate of Object.values(sampler)) {
    const point = [0.193, 0.487, -0.239];
    const original = evaluate(...point);
    for (let axis = 0; axis < 3; axis++) {
      const translated = [...point];
      translated[axis] += 3;
      assert.ok(Math.abs(original - evaluate(...translated)) < 1e-12);
      const left = [...point], right = [...point];
      left[axis] = 1 - 1e-7;
      right[axis] = 1e-7;
      assert.ok(Math.abs(evaluate(...left) - evaluate(...right)) < 1e-5);
    }
    assert.ok(original >= 0 && original <= 1);
  }
});

test('volume channels contain distinct nondegenerate shape and erosion fields', () => {
  const { data } = createCloudNoiseData({ size: 24 });
  for (let channel = 0; channel < 4; channel++) {
    const stats = channelStats(data, channel);
    assert.ok(stats.max - stats.min > 100);
    assert.ok(stats.mean > 40 && stats.mean < 200);
    assert.ok(stats.deviation > 20);
  }
  assert.notDeepEqual(channelStats(data, 1).values, channelStats(data, 2).values);
  assert.notDeepEqual(channelStats(data, 2).values, channelStats(data, 3).values);
});

test('weather has substantial clear and cloudy patches, varying thickness, and opaque alpha', () => {
  const { data } = createCloudWeatherData({ size: 64 });
  const coverage = channelStats(data, 0);
  assert.ok(coverage.values.filter((value) => value < 35).length > coverage.values.length * 0.05);
  assert.ok(coverage.values.filter((value) => value > 220).length > coverage.values.length * 0.05);
  assert.ok(channelStats(data, 1).deviation > 10);
  assert.ok(channelStats(data, 2).deviation > 10);
  assert.ok(channelStats(data, 3).values.every((value) => value === 255));
});

test('texture sizes reject invalid or unbounded allocations', () => {
  for (const create of [createCloudNoiseData, createCloudWeatherData]) {
    for (const size of [0, -1, 2.5, Infinity, 257]) {
      assert.throws(() => create({ size }), RangeError);
    }
  }
});
