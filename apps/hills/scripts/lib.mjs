/**
 * Shared plumbing for the measurement scripts in this directory.
 *
 * The rules these helpers enforce are the ones `docs/measuring.md` names: a
 * loopback URL, the full Chromium channel rather than the GPU-less headless
 * shell, a hardware adapter check, and a source hash on both sides of a run so
 * a file that changed mid-run invalidates it.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(APP_ROOT, '..', '..');

/**
 * Everything a run serves: the demo, and the package it links from the
 * workspace. Hashing only the demo would let a change to the sky or the grass
 * -- which is most of what gets measured -- slip through a run unnoticed.
 */
export const SOURCE_ROOTS = [APP_ROOT, join(REPO_ROOT, 'packages', 'three')];

/** `--key value` and `--key=value`; positionals collect in `_`. */
export function parseArgs(argv, { values = [] } = {}) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=');
    if (!values.includes(name)) throw new Error(`Unknown option --${name}`);
    const value = inline ?? argv[index + 1];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    args[name] = value;
    if (inline === undefined) index += 1;
  }
  return args;
}

/** Only a loopback HTTP URL is measured; anything else is a different machine. */
export function loopbackUrl(base = 'http://127.0.0.1:5173/') {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`Use an HTTP loopback URL, not ${url.href}`);
  }
  return url;
}

export function appUrl(url, params = {}) {
  for (const [name, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(name, String(value));
  }
  return url;
}

/**
 * The full Chromium build, not Playwright's default headless shell, which has
 * no GPU process and therefore no WebGPU at all.
 */
export async function launchBrowser() {
  return chromium.launch({
    channel: 'chromium',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--ignore-gpu-blocklist',
      '--enable-gpu',
    ],
  });
}

export async function openHills(browser, url, viewport = { width: 1280, height: 720 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));
  page.on('console', (message) => {
    // The demo has no favicon; a 404 for one is not a page error.
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      console.error('[page]', message.text());
    }
  });
  await page.goto(url.href, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
  return { context, page };
}

/**
 * What actually rendered, from the renderer's own device rather than a
 * preflight adapter request. A software classification is fatal; an unknown
 * one is recorded and allowed, because a real device can carry a name no
 * keyword list knows.
 */
export async function adapterOf(page) {
  return page.evaluate(() => {
    const info = window.__hills?.renderer?.backend?.device?.adapterInfo;
    if (!info) return null;
    const fields = [
      'vendor', 'architecture', 'device', 'description',
      'subgroupMinSize', 'subgroupMaxSize', 'isFallbackAdapter',
    ];
    const plain = Object.fromEntries(
      fields.filter((key) => info[key] !== undefined).map((key) => [key, info[key]]),
    );
    const text = Object.values(plain).join(' ').toLowerCase();
    const software = info.isFallbackAdapter === true ||
      /swiftshader|llvmpipe|lavapipe|software|microsoft basic render/.test(text);
    const identified =
      /intel|nvidia|amd|radeon|apple|qualcomm|mali|iris|arc|0x8086|0x10de|0x1002/.test(text);
    return {
      classification: software ? 'software' : identified ? 'hardware' : 'unknown',
      info: plain,
    };
  });
}

export async function requireHardwareAdapter(page) {
  const adapter = await adapterOf(page);
  if (!adapter) throw new Error('The renderer exposed no adapter info; cannot trust this run.');
  if (adapter.classification === 'software') {
    throw new Error(`A software adapter rendered this run: ${JSON.stringify(adapter.info)}`);
  }
  if (adapter.classification === 'unknown') {
    console.warn(`[adapter] Could not classify ${JSON.stringify(adapter.info)}; recording it as unknown.`);
  }
  return adapter;
}

/**
 * The fixed looks every visual tool shares, so their numbers and pictures are
 * of the same framings: the opening view (null = as the page opens), along
 * the horizon toward the sun, across it and away from it, and two raised
 * views. Elevation and azimuth in degrees; `SUN_AZIMUTH` is the demo's sun.
 */
export const SUN_AZIMUTH = 54.689;
export const FIXED_VIEWS = Object.freeze([
  ['default', null, null],
  ['sun-horizon', 6, SUN_AZIMUTH],
  ['across-horizon', 6, SUN_AZIMUTH + 90],
  ['away-horizon', 6, SUN_AZIMUTH + 180],
  ['across-30', 30, SUN_AZIMUTH - 90],
  ['away-50', 50, SUN_AZIMUTH + 180],
]);

/** Points the demo's camera; null elevation leaves the opening framing. */
export async function aimCamera(page, elevation, azimuth) {
  if (elevation === null) return;
  await page.evaluate(({ elevation, azimuth }) => {
    const camera = window.__hills.camera;
    camera.rotation.order = 'YXZ';
    // YXZ forward is (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch);
    // azimuth runs from +Z toward +X, so yaw = PI + azimuth.
    camera.rotation.set((elevation * Math.PI) / 180, Math.PI + (azimuth * Math.PI) / 180, 0);
    camera.updateMatrixWorld(true);
  }, { elevation, azimuth });
}

/**
 * The cloud classifier, shared by `measure-clouds.mjs` and `measure-photos.mjs`
 * so that a render and a photograph are measured the same way. It runs in the
 * page: hand `cloudPixelsSource` to `page.evaluate` and rebuild it there with
 * `new Function`. Every other pixel in both directions; a pixel is ground when
 * it is clearly green, cloud when it is nearly unsaturated and bright, and sky
 * otherwise. The classifier is crude on purpose -- it is the same crude
 * classifier for every image, so a change in its numbers is a change in the
 * image -- and it has one bias worth knowing: a shaded cloud blue enough to
 * pass saturation 0.22 counts as sky, in a photograph as in a render.
 *
 * Returns the sky and cloud pixel counts, 256-bin histograms of cloud luma and
 * saturation (so views can be pooled), and the mean colour of the darkest 15%
 * of cloud pixels.
 */
export function cloudPixels(data, width, height) {
  let sky = 0;
  const lumaHistogram = new Array(256).fill(0);
  const saturationHistogram = new Array(256).fill(0);
  const cloud = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * 4;
      const r = data[index] / 255;
      const g = data[index + 1] / 255;
      const b = data[index + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max > 0 ? (max - min) / max : 0;
      if (g > r * 1.15 && g > b * 1.15 && saturation > 0.3) continue;
      sky += 1;
      if (saturation < 0.22 && max > 0.45) {
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumaHistogram[Math.min(255, Math.floor(luma * 256))] += 1;
        saturationHistogram[Math.min(255, Math.floor(saturation * 256))] += 1;
        cloud.push(luma, r, g, b);
      }
    }
  }
  const clouds = cloud.length / 4;
  let cutoff = 0;
  for (let count = 0; cutoff < 256 && count < clouds * 0.15; cutoff += 1) count += lumaHistogram[cutoff];
  const shaded = [0, 0, 0];
  let dark = 0;
  for (let i = 0; i < cloud.length; i += 4) {
    if (cloud[i] * 256 >= cutoff) continue;
    shaded[0] += cloud[i + 1];
    shaded[1] += cloud[i + 2];
    shaded[2] += cloud[i + 3];
    dark += 1;
  }
  return {
    sky,
    clouds,
    lumaHistogram,
    saturationHistogram,
    shaded: dark ? shaded.map((channel) => channel / dark) : null,
  };
}
export const cloudPixelsSource = cloudPixels.toString();

/** Quantiles of a 256-bin histogram of values in [0, 1), at bin centres. */
export function histogramQuantiles(histogram, quantiles) {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  return quantiles.map((q) => {
    let seen = 0;
    for (let bin = 0; bin < histogram.length; bin += 1) {
      seen += histogram[bin];
      if (seen >= q * total) return (bin + 0.5) / histogram.length;
    }
    return 1;
  });
}

/** The numbers a look is compared on: luma spread and saturation of cloud. */
export function cloudLook(histograms) {
  const sum = (key) => histograms.reduce((total, item) => total.map((count, bin) => count + item[key][bin]),
    new Array(256).fill(0));
  const luma = histogramQuantiles(sum('lumaHistogram'), [0.1, 0.5, 0.9]);
  const saturation = histogramQuantiles(sum('saturationHistogram'), [0.5, 0.9]);
  return { luma, contrast: luma[0] / luma[2], saturation };
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'measurements', 'shots']);

/** Content hash of every served source file, for before/after checks. */
export async function hashTree(roots = SOURCE_ROOTS) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  for (const root of [roots].flat()) await walk(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(REPO_ROOT, file));
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, median: null, p95: null, p99: null };
  const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { count: sorted.length, median: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) };
}

export function sanitizeLabel(label) {
  if (!/^[a-z0-9_-]+$/i.test(label)) {
    throw new Error('A label may contain only letters, digits, hyphens and underscores.');
  }
  return label;
}

export function defaultLabel(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

export async function outputDir(flag, folder = 'measurements') {
  const directory = resolve(flag ?? join(APP_ROOT, folder));
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function writeJson(directory, name, data) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

export const toLinear = (value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

export const luminance = ([red, green, blue]) =>
  0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);

export const hex = ([red, green, blue]) =>
  `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
