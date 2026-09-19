import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3, TSL } from 'three/webgpu';
import {
  CLOUD_SHADOW, CloudShadowSchedule, SHADOW_REACH_KM, SHADOW_TEXEL_KM, WIND_Z,
  cloudDrift, shadowCastDirection, shadowCentreFor, shadowGround, shadowOffset,
  shadowSlope, shadowSteps, shadowUV, shadowWeight,
} from '../src/sky/cloud-shadow.js';
import { cloudLayerDistance, createVolumetricClouds } from '../src/sky/clouds.js';
import { sunDirectionFrom } from '../src/sky/atmosphere.js';

const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
// The demo's sun, and the cloud layer's base and top in clouds.js.
const DEMO_SUN = shadowCastDirection(sunDirectionFrom(49.1, 54.7));
const BASE_KM = 1.35;
const TOP_KM = 2.65;

test('the shadow drifts with the clouds overhead, not against them', () => {
  // The sky shows a snapshot marched at `snapshot` seconds, advected to the
  // display time: what is on screen over world point w is the field point
  // (w + wind since the snapshot) + drift at the snapshot. The shadow reads
  // w + drift at the display time. They must be the same point, for any
  // snapshot, or the shadow slides out from under its cloud.
  const windSpeed = 12;
  for (const [display, snapshot] of [[0, 0], [30, 25], [3600, 3599.2]]) {
    const w = [0.37, -1.9];
    const lag = (display - snapshot) * windSpeed / 1000;
    const [dx, dz] = cloudDrift(snapshot, windSpeed);
    const sky = [w[0] + lag + dx, w[1] + lag * WIND_Z + dz];
    const [sx, sz] = cloudDrift(display, windSpeed);
    close(sky[0], w[0] + sx, 1e-9, 'x');
    close(sky[1], w[1] + sz, 1e-9, 'z');
  }
  assert.deepEqual(cloudDrift(0, 12), [0, 0]);
  const [x, z] = cloudDrift(100, 12);
  close(x, 1.2, 1e-12, 'drift is metres per second over a thousand');
  close(z / x, WIND_Z, 1e-12, 'and runs along the shared direction');
});

test('everything on one ray to the sun reads the same point of the map', () => {
  for (const sun of [DEMO_SUN, shadowCastDirection([0, 1, 0]), shadowCastDirection([0.9, 0.2, -0.3])]) {
    close(Math.hypot(...sun), 1, 1e-12, 'unit cast direction');
    const ground = [120, 0, -40];
    close(shadowGround(ground, sun)[0], 0.12, 1e-12, 'ground x is itself');
    close(shadowGround(ground, sun)[1], -0.04, 1e-12, 'ground z is itself');
    for (const metres of [1.7, 30, 800]) {
      const raised = ground.map((value, axis) => value + sun[axis] * metres / sun[1]);
      const [x, z] = shadowGround(raised, sun);
      close(x, 0.12, 1e-12, `x at ${metres} m up the ray`);
      close(z, -0.04, 1e-12, `z at ${metres} m up the ray`);
    }
  }
});

test('the sun is never lower than the projection can bear', () => {
  const high = sunDirectionFrom(49.1, 54.7);
  assert.deepEqual(shadowCastDirection(high).map(v => Number(v.toFixed(12))),
    high.map(v => Number(v.toFixed(12))), 'a high sun is its own cast direction');
  for (const elevation of [2, 0, -30]) {
    const cast = shadowCastDirection(sunDirectionFrom(elevation, 10));
    close(Math.hypot(...cast), 1, 1e-12, 'unit');
    assert.ok(cast[1] >= CLOUD_SHADOW.minSunHeight * 0.99, `raised at ${elevation} degrees`);
  }
});

test('the map is centred on the observer, on its own texel grid', () => {
  close(SHADOW_TEXEL_KM, 0.02, 1e-12, '20 m texels');
  for (const field of [[0, 0], [0.013, -0.029], [431.7771, -12.30001]]) {
    const centre = shadowCentreFor(field);
    for (const axis of [0, 1]) {
      close(Math.abs(centre[axis] - field[axis]), 0, SHADOW_TEXEL_KM / 2 + 1e-9, 'within half a texel');
      close(centre[axis] / SHADOW_TEXEL_KM, Math.round(centre[axis] / SHADOW_TEXEL_KM), 1e-6, 'on the grid');
    }
  }
  const drift = cloudDrift(40, 12);
  const observer = [250, 0, -730];
  const field = [observer[0] / 1000 + drift[0], observer[2] / 1000 + drift[1]];
  const [u, v] = shadowUV(observer, DEMO_SUN, drift, field);
  close(u, 0.5, 1e-12, 'u');
  close(v, 0.5, 1e-12, 'v');
  const [u2] = shadowUV([observer[0] + 20, 0, observer[2]], DEMO_SUN, drift, field);
  close(u2 - u, 1 / CLOUD_SHADOW.resolution, 1e-12, 'one texel over');
});

test('the lookup the shader folds into two uniforms is the geometry, unfolded', () => {
  // The shader reads (x - slope * y, z - slope * y) * scale + offset, with the
  // sun's slope set at each bake and the offset every frame. That has to be
  // the ground point, drifted and measured from the map's centre.
  const drift = cloudDrift(5400, 30);
  const centre = shadowCentreFor([drift[0] + 0.25, drift[1] - 1.1]);
  for (const cast of [DEMO_SUN, shadowCastDirection(sunDirectionFrom(4, 200))]) {
    for (const position of [[250, 0, -1100], [-730.5, 41.2, 12], [0, 800, 0]]) {
      const [gx, gz] = shadowGround(position, cast);
      const [u, v] = shadowUV(position, cast, drift, centre);
      close(u, (gx + drift[0] - centre[0]) / CLOUD_SHADOW.extentKm + 0.5, 1e-9, 'u');
      close(v, (gz + drift[1] - centre[1]) / CLOUD_SHADOW.extentKm + 0.5, 1e-9, 'v');
    }
  }
  const [slopeX, slopeZ] = shadowSlope(DEMO_SUN);
  close(slopeX, DEMO_SUN[0] / DEMO_SUN[1], 1e-12, 'slope x');
  close(slopeZ, DEMO_SUN[2] / DEMO_SUN[1], 1e-12, 'slope z');
  assert.deepEqual(shadowOffset(centre, centre), [0.5, 0.5], 'the centre drifted onto itself');
});

test('shadow strength is whole inside the map and fades to nothing at its edge', () => {
  const half = CLOUD_SHADOW.extentKm / 2;
  const uvAt = km => [0.5 + km / CLOUD_SHADOW.extentKm, 0.5];
  assert.equal(shadowWeight([0.5, 0.5]), 1);
  assert.equal(shadowWeight(uvAt(half - CLOUD_SHADOW.fadeKm)), 1);
  assert.equal(shadowWeight(uvAt(half - SHADOW_TEXEL_KM / 2)), 0,
    'none at the last texel, so the edge clamp reads none beyond it');
  assert.equal(shadowWeight(uvAt(half)), 0);
  assert.equal(shadowWeight([1.7, 0.5]), 0, 'past the map, no shadow');
  let previous = 1;
  for (let km = half - CLOUD_SHADOW.fadeKm; km <= half; km += 0.01) {
    const weight = shadowWeight(uvAt(km));
    assert.ok(weight <= previous + 1e-12, 'monotonic through the fade');
    previous = weight;
  }
  close(SHADOW_REACH_KM, half - CLOUD_SHADOW.fadeKm - CLOUD_SHADOW.jumpKm, 1e-12, 'reach');
  assert.ok(SHADOW_REACH_KM > 1.45, 'past the demo far plane');
});

test('the sun-ward march takes 50 m steps where it can', () => {
  const path = mu => cloudLayerDistance(mu, TOP_KM) - cloudLayerDistance(mu, BASE_KM);
  close(path(1), 1.3, 1e-9, 'straight up, the layer is 1.3 km');
  assert.equal(shadowSteps(path(1)), 26);
  assert.equal(shadowSteps(path(DEMO_SUN[1])), 35, 'the demo sun, 1.72 km');
  assert.equal(shadowSteps(path(CLOUD_SHADOW.minSunHeight)), CLOUD_SHADOW.maxSteps,
    'the lowest sun crosses 23 km of layer and is capped');
  assert.equal(shadowSteps(0.2), CLOUD_SHADOW.minSteps);
});

test('a still observer under a still sky marches nothing after the first map', () => {
  const schedule = new CloudShadowSchedule();
  assert.equal(schedule.next([0, 0]), null, 'nothing before a map is shown');
  schedule.show(shadowCentreFor([0, 0]));
  for (let frame = 0; frame < 10000; frame++) assert.equal(schedule.next([0.3, -0.49]), null);
});

test('drifting clouds re-march the map in slices, one whole map at a time', () => {
  const schedule = new CloudShadowSchedule();
  schedule.show(shadowCentreFor([0, 0]));
  const windSpeed = 12;
  const recentres = [];
  let marching = null;
  for (let frame = 0; frame < 60 * 180; frame++) {
    const step = schedule.next(cloudDrift(frame / 60, windSpeed));
    if (step === null) continue;
    assert.equal(step.full, false, 'the demo wind never needs a whole map at once');
    if (step.first) marching = { frame, centre: step.centre, slices: [] };
    assert.deepEqual(step.centre, marching.centre, 'one map per march');
    marching.slices.push(step.slice);
    if (step.last) {
      assert.deepEqual(schedule.shown, step.centre, 'shown on its last slice');
      recentres.push(marching);
    }
  }
  assert.equal(recentres.length, 4, 'every 0.5 km of drift over three minutes');
  for (const { slices } of recentres) {
    assert.deepEqual(slices, Array.from({ length: CLOUD_SHADOW.slices }, (_, i) => i));
  }
  close((recentres[1].frame - recentres[0].frame) / 60, 500 / 12, 0.1, 'seconds apart');
});

test('however fast the observer moves, the shown map reaches past the far plane', () => {
  // A hostile walk: the fastest wind the sky accepts, a runner at the demo's
  // top run speed turning every second, frames at 20 Hz, and a teleport now
  // and then. After every frame the observer must stand within `jumpKm` of a
  // complete map's centre, which is what `SHADOW_REACH_KM` is derived from.
  const schedule = new CloudShadowSchedule();
  schedule.show(shadowCentreFor([0, 0]));
  let random = 0x2545f491;
  const next = () => ((random = (random * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const position = [0, 0];
  let heading = 0;
  let full = 0;
  let sliced = 0;
  let marchingFrom = null;
  for (let frame = 0; frame < 20 * 600; frame++) {
    const seconds = frame / 20;
    if (frame % 20 === 0) heading = next() * Math.PI * 2;
    position[0] += Math.cos(heading) * 0.12 / 20;
    position[1] += Math.sin(heading) * 0.12 / 20;
    if (frame % 997 === 0) { position[0] += 40 * (next() - 0.5); position[1] += 40 * (next() - 0.5); }
    const drift = cloudDrift(seconds, 100);
    const field = [position[0] + drift[0], position[1] + drift[1]];
    const shownBefore = schedule.shown;
    const step = schedule.next(field);
    if (step?.full) { full++; marchingFrom = null; }
    else if (step) {
      sliced++;
      if (step.first) marchingFrom = step.centre;
      assert.deepEqual(step.centre, marchingFrom, 'a march is never re-aimed half way');
    }
    if (!step?.last) assert.equal(schedule.shown, shownBefore, 'no map is shown half marched');
    const off = Math.max(Math.abs(field[0] - schedule.shown[0]), Math.abs(field[1] - schedule.shown[1]));
    assert.ok(off <= CLOUD_SHADOW.jumpKm, `frame ${frame}: ${off} km off centre`);
  }
  assert.ok(full > 0 && sliced > 0, 'both kinds of work were exercised');
});

function recordedClouds(options = {}) {
  const calls = [];
  const disposed = new Map();
  const record = kind => async pass => {
    if (!disposed.has(pass.id)) {
      disposed.set(pass.id, 0);
      pass.addEventListener('dispose', () => disposed.set(pass.id, disposed.get(pass.id) + 1));
    }
    calls.push({ kind, id: pass.id, count: pass.count });
  };
  const clouds = createVolumetricClouds({
    renderer: { computeAsync: record('async'), compute: record('frame') },
    sunDirection: TSL.uniform(new Vector3(...sunDirectionFrom(49.1, 54.7))),
    exposure: TSL.uniform(1),
    skyRadianceNode: TSL.Fn(() => TSL.vec3(0.1, 0.2, 0.3)),
    quality: 'low',
    ...options,
  });
  return { clouds, calls, disposed };
}

test('each bake marches one whole shadow map after the sky, and a still sky walks it along', async () => {
  const { clouds, calls, disposed } = recordedClouds({ windSpeed: 0 });
  const shadow = clouds.stats.shadow;
  const [fullId, sliceId] = shadow.computeNodeIds;
  const shadowCalls = () => calls.filter(call => shadow.computeNodeIds.includes(call.id));
  const texels = shadow.resolution * shadow.resolution;
  try {
    await clouds.bake();
    assert.equal(calls.at(-1).id, fullId, 'marched last, once the sky is ready');
    assert.deepEqual(shadowCalls(), [{ kind: 'async', id: fullId, count: texels }]);
    assert.equal(shadow.generation, 1);
    assert.equal(clouds.shadowNode().isNode, true);

    // 0.6 km east: past the recentre distance, so the next map is marched a
    // slice a frame and shown once, whole. (The still sky re-marches its own
    // cache too, having moved more than 0.1 km; that is its own business.)
    for (let frame = 0; frame < CLOUD_SHADOW.slices + 10; frame++) clouds.update(frame / 60, { x: 600, z: 0 });
    const slices = shadowCalls().slice(1);
    assert.equal(slices.length, CLOUD_SHADOW.slices);
    assert.ok(slices.every(call => call.id === sliceId && call.kind === 'frame'));
    assert.equal(slices.reduce((sum, call) => sum + call.count, 0), texels);
    assert.equal(shadow.generation, 2);
    assert.deepEqual(shadow.centreKm.map(v => Number(v.toFixed(9))), [0.6, 0]);

    // A jump is marched whole, at once, inside the frame.
    clouds.update(2, { x: 5000, z: -2000 });
    assert.deepEqual(shadowCalls().at(-1), { kind: 'frame', id: fullId, count: texels });
    assert.equal(shadow.generation, 3);

    await clouds.bake({ sun: [0.6, 0.5, 0.4], sky: [0.1, 0.2, 0.3] });
    assert.deepEqual(shadowCalls().at(-1), { kind: 'async', id: fullId, count: texels },
      'a new sun re-marches the shadows');
    assert.equal(shadow.generation, 4);
    assert.ok(clouds.stats.bytes > shadow.bytes);
  } finally { clouds.dispose(); }
  clouds.dispose();
  assert.equal(disposed.get(fullId), 1);
  assert.equal(disposed.get(sliceId), 1);
});

test('no clouds, no shadow and no shadow work', async () => {
  const { clouds, calls } = recordedClouds({ coverage: 0 });
  try {
    assert.equal(clouds.stats.shadow, null);
    await clouds.bake();
    for (let frame = 0; frame < 200; frame++) clouds.update(frame, { x: frame * 100, z: 0 });
    assert.ok(calls.every(call => clouds.stats.computeNodeIds.includes(call.id)));
    assert.equal(clouds.shadowNode().isNode, true, 'still a node: a constant 1');
  } finally { clouds.dispose(); }
});
