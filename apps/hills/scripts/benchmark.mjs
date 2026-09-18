/**
 * GPU pass time and frame cadence along fixed camera paths over the hills.
 *
 * Two modes, kept separate on purpose:
 *
 *   timed    the renderer was created with `trackTimestamp` and `gputiming=on`
 *            was set, so each sampled frame carries GPU render, compute and
 *            cloud-compute pass times. Readback has overhead; this measures
 *            passes, not displayed frames.
 *   cadence  no timestamp instrumentation. This is the ordinary-scheduling
 *            number, and it can say nothing about GPU headroom.
 *
 * The rules this keeps from the harness it replaces: the source tree is hashed
 * before and after the run, the adapter that actually rendered is recorded,
 * every case gets a warmup before its sample window, and the cloud compute
 * figure selects the sky's own compute passes through
 * `clouds.stats.computeNodeIds` rather than guessing from pass names.
 *
 *   node scripts/benchmark.mjs --label sky-timed --mode timed
 *   node scripts/benchmark.mjs --label grass-cadence --mode cadence \
 *     --cases idle,walk,turn
 *
 * Results are written under `measurements/<label>/`. Per-frame rows are
 * retained; the printed table is the summary.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  APP_ROOT, appUrl, defaultLabel, hashTree, launchBrowser, loopbackUrl,
  openHills, outputDir, parseArgs, requireHardwareAdapter, sanitizeLabel,
  summarize, writeJson,
} from './lib.mjs';

const CASES = ['idle', 'walk', 'turn', 'sky', 'skyturn', 'skywalk', 'zenith', 'seam', 'sun'];

const args = parseArgs(process.argv.slice(2), {
  values: ['url', 'out', 'label', 'cases', 'warmup', 'sample', 'mode', 'width', 'height'],
});
const label = sanitizeLabel(args.label ?? defaultLabel('benchmark'));
const mode = args.mode ?? 'timed';
if (!['timed', 'cadence'].includes(mode)) throw new Error('--mode must be timed or cadence.');
const cases = (args.cases ?? 'idle,walk,turn').split(',').map((name) => name.trim());
for (const name of cases) if (!CASES.includes(name)) throw new Error(`Unknown case ${name}.`);
const warmupMs = Number(args.warmup ?? 4000);
const sampleMs = Number(args.sample ?? 12000);
const width = Number(args.width ?? 1920);
const height = Number(args.height ?? 1080);
const timed = mode === 'timed';
const url = appUrl(loopbackUrl(args.url), { ui: 0, gputiming: timed ? 'on' : 'off' });
const directory = join(await outputDir(args.out), label);
await mkdir(directory, { recursive: true });

const before = await hashTree(APP_ROOT);
const browser = await launchBrowser();
let result;
let adapter;
try {
  const { page } = await openHills(browser, url, { width, height });
  adapter = await requireHardwareAdapter(page);
  page.setDefaultTimeout(0);
  result = await page.evaluate(async ({ cases, warmupMs, sampleMs, timed, width, height }) => {
    const hills = window.__hills;
    const { renderer, camera, sky } = hills;
    if (renderer.backend?.isWebGPUBackend !== true) throw new Error('Not the WebGPU backend.');

    const backend = renderer.backend;
    const device = backend.device;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    const gpuSupported = timed && device?.features?.has('timestamp-query') === true &&
      backend.trackTimestamp === true;
    const clouds = sky?.clouds ?? null;
    const cloudStats = clouds?.stats ?? null;
    const nodeIds = cloudStats?.computeNodeIds;
    const skyAvailable = Array.isArray(nodeIds) && nodeIds.length > 0 &&
      nodeIds.every((id) => Number.isSafeInteger(id) && id >= 0);
    const skyIdSet = new Set(skyAvailable ? nodeIds : []);

    const { heading: headingDegrees, eye, startX, startZ } = hills.options;
    const { sunElevation, sunAzimuth } = hills.lawn;
    const heading = (headingDegrees * Math.PI) / 180;
    const forward = { x: Math.sin(heading), z: -Math.cos(heading) };
    const right = { x: -forward.z, z: forward.x };
    const groundAt = hills.groundAt;

    function pose(name, seconds) {
      let x = startX;
      let z = startZ;
      let yaw = Math.PI + heading;
      let pitch = -0.12;
      switch (name) {
        case 'walk': {
          const offset = 8 * Math.sin((seconds * Math.PI) / 8);
          x += forward.x * offset;
          z += forward.z * offset;
          break;
        }
        case 'turn':
          yaw += Math.sin((seconds * Math.PI) / 5) * Math.PI * 0.65;
          break;
        case 'sky':
          pitch = (35 * Math.PI) / 180;
          break;
        case 'skyturn':
          yaw += seconds * ((18 * Math.PI) / 180);
          pitch = (30 * Math.PI) / 180;
          break;
        case 'skywalk': {
          const offset = 8 * Math.sin((seconds * Math.PI) / 8);
          x += right.x * offset;
          z += right.z * offset;
          pitch = (30 * Math.PI) / 180;
          break;
        }
        case 'zenith':
          yaw += seconds * Math.PI * 2;
          pitch = (89.9 * Math.PI) / 180;
          break;
        case 'seam':
          yaw = Math.PI + Math.sin((seconds * Math.PI) / 5) * ((30 * Math.PI) / 180);
          pitch = (30 * Math.PI) / 180;
          break;
        case 'sun':
          yaw = Math.PI + (sunAzimuth * Math.PI) / 180;
          pitch = ((sunElevation - 5) * Math.PI) / 180;
          break;
        default:
          break;
      }
      camera.position.set(x, groundAt(x, z) + eye, z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(pitch, yaw, 0);
      camera.updateMatrixWorld(true);
    }

    const groupEntries = (entries) => {
      const frames = new Map();
      for (const [uid, ms] of entries) {
        if (!Number.isFinite(ms) || ms < 0) continue;
        const match = /:f(\d+)$/.exec(uid);
        if (!match) continue;
        const frame = Number(match[1]);
        frames.set(frame, (frames.get(frame) ?? 0) + ms);
      }
      return frames;
    };

    const gpu = { render: new Map(), compute: new Map() };
    const invalid = { render: new Set(), compute: new Set(), sky: new Set() };
    const skyFrames = new Map();
    const pending = { render: null, compute: null };
    const problems = [];

    function flush(type) {
      if (!gpuSupported) return Promise.resolve();
      if (pending[type]) return pending[type];
      const pool = backend.timestampQueryPool[type];
      if (!pool?.currentQueryIndex) return Promise.resolve();
      const keys = [...pool.queryOffsets.keys()];
      pending[type] = (async () => {
        await renderer.resolveTimestampsAsync(type);
        const entries = keys.map((uid) => [uid, pool.timestamps.get(uid)]);
        const missing = entries.filter(([, value]) => !Number.isFinite(value)).length;
        if (missing) problems.push(`${type}: ${missing} unresolved GPU pass timings`);
        for (const [uid, ms] of entries) {
          const match = /:f(\d+)$/.exec(uid);
          if (match && (!Number.isFinite(ms) || ms < 0)) invalid[type].add(Number(match[1]));
        }
        for (const [frame, ms] of groupEntries(entries)) {
          gpu[type].set(frame, (gpu[type].get(frame) ?? 0) + ms);
        }
        if (type === 'compute' && skyAvailable) {
          const skyEntries = entries.filter(([uid]) => {
            const match = /^(?:c|r):\d+:(\d+):f\d+$/.exec(uid);
            return match !== null && skyIdSet.has(Number(match[1]));
          });
          for (const [uid, ms] of skyEntries) {
            const match = /:f(\d+)$/.exec(uid);
            if (match && (!Number.isFinite(ms) || ms < 0)) invalid.sky.add(Number(match[1]));
          }
          for (const [frame, ms] of groupEntries(skyEntries)) {
            skyFrames.set(frame, (skyFrames.get(frame) ?? 0) + ms);
          }
        }
      })().catch((error) => problems.push(`${type}: ${error.message}`))
        .finally(() => { pending[type] = null; });
      return pending[type];
    }

    const rows = [];

    async function runCase(name) {
      const started = performance.now();
      let previous = null;
      let sinceFlush = 0;
      await new Promise((resolve, reject) => {
        const step = (now) => {
          try {
            const elapsed = now - started;
            pose(name, elapsed / 1000);
            if (elapsed >= warmupMs && document.visibilityState === 'visible') {
              if (previous !== null) {
                rows.push({
                  case: name,
                  t: now,
                  frameId: renderer.info.frame,
                  intervalMs: now - previous,
                  visibilityState: document.visibilityState,
                  hasFocus: document.hasFocus(),
                  computeCalls: renderer.info.compute.frameCalls,
                  drawCalls: renderer.info.render.drawCalls,
                });
              }
              previous = now;
            }
            sinceFlush += 1;
            if (gpuSupported && sinceFlush >= 12) {
              sinceFlush = 0;
              void flush('render');
              void flush('compute');
            }
            if (elapsed >= warmupMs + sampleMs) resolve();
            else requestAnimationFrame(step);
          } catch (error) {
            reject(error);
          }
        };
        requestAnimationFrame(step);
      });
      await Promise.all([pending.render, pending.compute]);
      await Promise.all([flush('render'), flush('compute')]);
      const caseRows = rows.filter((row) => row.case === name);
      for (const row of caseRows) {
        row.gpuRenderMs = invalid.render.has(row.frameId)
          ? null : gpu.render.get(row.frameId) ?? null;
        row.gpuComputeMs = invalid.compute.has(row.frameId)
          ? null
          : row.computeCalls === 0 && gpuSupported
            ? 0 : gpu.compute.get(row.frameId) ?? null;
        row.gpuSkyComputeMs = !gpuSupported || !skyAvailable || invalid.sky.has(row.frameId)
          ? null : skyFrames.get(row.frameId) ?? (row.gpuComputeMs !== null ? 0 : null);
        row.gpuTotalMs = row.gpuRenderMs !== null && row.gpuComputeMs !== null
          ? row.gpuRenderMs + row.gpuComputeMs : null;
      }
      return caseRows;
    }

    const results = {};
    for (const name of cases) results[name] = await runCase(name);

    return {
      href: location.href,
      userAgent: navigator.userAgent,
      canvas: { width: renderer.domElement.width, height: renderer.domElement.height },
      gpuSupported,
      gpuTimestampsRequested: timed,
      skyComputeAttribution: {
        available: skyAvailable,
        cloudsEnabled: clouds !== null,
        computeNodeIds: skyAvailable ? [...skyIdSet] : [],
      },
      cloudStats: cloudStats === null ? null : structuredClone(cloudStats),
      options: { ...hills.options, ...hills.lawn },
      problems,
      results,
    };
  }, { cases, warmupMs, sampleMs, timed, width, height });
} finally {
  await browser.close();
}
const after = await hashTree(APP_ROOT);

const warnings = [...result.problems];
if (before !== after) warnings.push('The source tree changed during the run; this run is invalid.');
if (timed && !result.gpuSupported) warnings.push('Timestamp queries were requested but not available; no GPU numbers.');
if (!timed && Object.values(result.results).some((rows) => rows.some((row) => row.gpuTotalMs !== null))) {
  warnings.push('A cadence run produced GPU numbers, which should be impossible.');
}

const summary = {};
for (const [name, rows] of Object.entries(result.results)) {
  const intervals = rows.map((row) => row.intervalMs);
  const interval = summarize(intervals);
  summary[name] = {
    frames: rows.length,
    meanFps: intervals.length
      ? 1000 / (intervals.reduce((total, value) => total + value, 0) / intervals.length)
      : null,
    intervalMs: interval,
    over20Ms: rows.filter((row) => row.intervalMs > 20).length / Math.max(1, rows.length),
    gpuTotalMs: summarize(rows.map((row) => row.gpuTotalMs)),
    gpuSkyComputeMs: summarize(rows.map((row) => row.gpuSkyComputeMs)),
  };
}

const report = {
  label,
  mode,
  url: url.href,
  startedAt: new Date().toISOString(),
  warmupMs,
  sampleMs,
  adapter,
  sourceHashBefore: before,
  sourceHashAfter: after,
  sourceUnchanged: before === after,
  gpuSupported: result.gpuSupported,
  skyComputeAttribution: result.skyComputeAttribution,
  cloudStats: result.cloudStats,
  options: result.options,
  canvas: result.canvas,
  summary,
  warnings,
  results: result.results,
};
const path = await writeJson(directory, 'benchmark.json', report);

console.log(`${mode} run ${label}  ${result.canvas.width}x${result.canvas.height}  ${url.href}`);
console.log(`adapter ${adapter.classification}  ${JSON.stringify(adapter.info)}`);
console.log(`\n${'case'.padEnd(9)} ${'frames'.padStart(6)} ${'fps'.padStart(7)} ${'p95(ms)'.padStart(8)} ` +
  `${'>20ms'.padStart(6)} ${'gpuMed'.padStart(7)} ${'gpuP95'.padStart(7)} ${'skyMed'.padStart(7)}`);
for (const name of cases) {
  const row = summary[name];
  const value = (number, digits = 2) => (number === null ? '—' : number.toFixed(digits));
  console.log(
    `${name.padEnd(9)} ${String(row.frames).padStart(6)} ${value(row.meanFps, 1).padStart(7)} ` +
    `${value(row.intervalMs.p95).padStart(8)} ${(100 * row.over20Ms).toFixed(1).padStart(5)}% ` +
    `${value(row.gpuTotalMs.median).padStart(7)} ${value(row.gpuTotalMs.p95).padStart(7)} ` +
    `${value(row.gpuSkyComputeMs.median).padStart(7)}`,
  );
}
if (warnings.length) {
  console.log('\nwarnings');
  for (const warning of warnings) console.log(`  ${warning}`);
}
console.log(`\nreport ${path}`);
await writeFile(join(directory, 'source.txt'),
  `before ${before}\nafter  ${after}\nunchanged ${before === after}\n`);
