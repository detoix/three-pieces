import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COVERAGE_REFERENCE, cloudDirection, cloudLayerDistance, cloudLocalCoverage,
} from '../src/sky/clouds.js';
import { createCloudWeatherData } from '../src/sky/cloud-noise.js';

const EARTH_RADIUS_KM = 6360;
const HEIGHTS_KM = [0.001, 1.35, 2.65, 10];
const close = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`);
};

test('cloud atlas directions are unit vectors in the upper hemisphere', () => {
  for (const u of [-3.7, -1, 0, 0.193, 0.5, 0.999, 3.4]) {
    for (const v of [0, 0.001, 0.1, 0.4, 0.8, 0.999, 1]) {
      const direction = cloudDirection(u, v);
      assert.ok(direction.every(Number.isFinite));
      close(Math.hypot(...direction), 1);
      assert.ok(direction[1] >= 0 && direction[1] <= 1);
      if (v === 0) close(direction[1], 0);
      if (v === 1) close(direction[1], 1);
    }
  }
});

test('atlas azimuth wraps and every azimuth converges at zenith', () => {
  for (const u of [-0.73, 0.137, 0.81]) {
    for (const v of [0, 0.19, 0.72, 1]) {
      const direction = cloudDirection(u, v);
      for (const periods of [-5, -1, 1, 7]) {
        cloudDirection(u + periods, v).forEach((component, axis) => close(component, direction[axis]));
      }
    }
    const zenith = cloudDirection(u, 1);
    close(zenith[0], 0);
    close(zenith[1], 1);
    close(zenith[2], 0);
  }
});

test('reported layer intersections land on the specified spherical shell', () => {
  for (const height of HEIGHTS_KM) {
    for (const u of [0, 0.17, 0.53, 0.94]) {
      for (const v of [0, 1e-6, 0.01, 0.1, 0.5, 0.95, 1]) {
        const direction = cloudDirection(u, v);
        const distance = cloudLayerDistance(direction[1], height);
        assert.ok(Number.isFinite(distance) && distance > 0);
        const endpoint = direction.map(component => component * distance);
        endpoint[1] += EARTH_RADIUS_KM;
        close(Math.hypot(...endpoint), EARTH_RADIUS_KM + height, 1e-8);
      }
    }
  }
});

test('layer distance is height at zenith and decreases smoothly toward zenith', () => {
  for (const height of HEIGHTS_KM) {
    close(cloudLayerDistance(1, height), height);
    let previous = Infinity;
    for (const elevation of [0, 1e-9, 1e-6, 0.001, 0.01, 0.1, 0.4, 0.7, 1]) {
      const distance = cloudLayerDistance(elevation, height);
      assert.ok(Number.isFinite(distance));
      assert.ok(distance >= height - 1e-10);
      assert.ok(distance <= previous);
      previous = distance;
    }
  }
});

test('higher spherical layers always follow lower layers along the same sky ray', () => {
  for (const mu of [0, 1e-8, 0.01, 0.3, 0.8, 1]) {
    const distances = HEIGHTS_KM.map(height => cloudLayerDistance(mu, height));
    for (let index = 1; index < distances.length; index++) {
      assert.ok(distances[index] > distances[index - 1]);
    }
  }
});

test('coverage below the default thins every region, not just the edges of humid ones', () => {
  // At the reference the weather map is itself; a clear sky at 0; monotonic
  // in both the option and the map.
  for (const local of [0, 0.3, 0.72, 1]) {
    close(cloudLocalCoverage(local, COVERAGE_REFERENCE), local);
    assert.equal(cloudLocalCoverage(local, 0), 0);
    let previous = -1;
    for (let coverage = 0; coverage <= 1.0001; coverage += 0.02) {
      const value = cloudLocalCoverage(local, coverage);
      assert.ok(value >= previous - 1e-12, `monotonic in coverage at ${local}`);
      previous = value;
    }
  }
  assert.equal(cloudLocalCoverage(0, 1), 1 - COVERAGE_REFERENCE, 'above the reference, dry regions fill');
  assert.equal(cloudLocalCoverage(1, 1), 1);

  // The weather map saturates over a large share of the world. Its densest
  // cloud must still thin out as coverage drops: the shape's own early-out is
  // local coverage 0.08, and its threshold is set by what is left above that.
  const { data } = createCloudWeatherData({});
  const locals = [];
  for (let i = 0; i < data.length; i += 4) locals.push(data[i] / 255);
  const saturated = locals.filter((value) => value > 0.999).length / locals.length;
  assert.ok(saturated > 0.1, `the map saturates over ${(100 * saturated).toFixed(1)}%`);
  const densest = (coverage) => Math.max(...locals.map((local) => cloudLocalCoverage(local, coverage)));
  assert.equal(densest(COVERAGE_REFERENCE), 1);
  close(densest(0.1), 0.1 / COVERAGE_REFERENCE, 1e-9);
});
