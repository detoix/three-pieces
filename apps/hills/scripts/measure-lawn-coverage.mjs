/**
 * Measure the lawn's bare ground against distance, on the real adapter.
 *
 * Coverage is the whole argument for blade height, blade width, tillering and
 * ring density, and none of it is visible to `pnpm test`: the CPU tests never
 * run a draw. This drives the flat ground (`hills=0`) in headless Chromium on
 * hardware WebGPU, paints the solid underlay control emissive blue so every
 * pixel of ground no blade covers is unmistakable, and counts them by screen
 * row -- which, for a known camera over flat terrain, is a known ground
 * distance.
 *
 *   node scripts/measure-lawn-coverage.mjs --label shipped
 *   node scripts/measure-lawn-coverage.mjs --label width-1 --query 'bladewidth=1'
 *   node scripts/measure-lawn-coverage.mjs --label check --pitch 22
 *
 * A cross-check worth repeating when the row-to-distance mapping is in doubt:
 * run it level and again pitched down; the overlapping bands must agree.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  appUrl, defaultLabel, launchBrowser, loopbackUrl, openHills, outputDir,
  parseArgs, requireHardwareAdapter, sanitizeLabel, writeJson,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['url', 'out', 'label', 'pitch', 'width', 'height'],
});
const label = sanitizeLabel(args.label ?? defaultLabel('lawn-coverage'));
const pitch = Number(args.pitch ?? 0);
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const url = appUrl(loopbackUrl(args.url), { ui: 0, hills: 0, underlay: 'solid' });
const directory = join(await outputDir(args.out), label);
await mkdir(directory, { recursive: true });

const EYE = 1.7;
const FOV = 62;
const BANDS = [
  [0.8, 1.5], [1.5, 2], [2, 3], [3, 4], [4, 6], [6, 8],
  [8, 12], [12, 16], [16, 24], [24, 32], [32, 52],
];

function distanceOfRow(y, pitchDegrees) {
  const half = Math.tan((FOV * Math.PI) / 360);
  const ndc = 1 - (2 * (y + 0.5)) / height;
  const angle = Math.atan(ndc * half) - (pitchDegrees * Math.PI) / 180;
  return angle >= 0 ? Infinity : EYE / Math.tan(-angle);
}

const browser = await launchBrowser();
let rows;
let adapter;
try {
  const { page } = await openHills(browser, url, { width, height });
  adapter = await requireHardwareAdapter(page);
  rows = await page.evaluate(async ({ pitchDegrees, width, height }) => {
    const { camera, surface } = window.__hills;
    const canvas = document.querySelector('canvas');
    for (const node of document.body.querySelectorAll('*')) {
      if (node !== canvas && !node.contains(canvas)) node.style.display = 'none';
    }
    // Ground in one colour no blade can wear: emissive, so neither the sun,
    // the shadow nor the tone mapper can turn a lit blade into it.
    const solid = surface.solidMaterial;
    solid.color.set('#000000');
    solid.emissive.set('#0000ff');
    solid.emissiveIntensity = 1;
    solid.needsUpdate = true;
    camera.position.set(0, 1.7, 0);
    camera.rotation.order = 'YXZ';
    camera.rotation.set((-pitchDegrees * Math.PI) / 180, 0, 0);
    camera.updateMatrixWorld(true);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    camera.rotation.set((-pitchDegrees * Math.PI) / 180, 0, 0);
    camera.updateMatrixWorld(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const flat = document.createElement('canvas');
    flat.width = width;
    flat.height = height;
    const context = flat.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const bare = [];
    for (let y = 0; y < height; y += 1) {
      let blue = 0;
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        if (data[index + 2] > data[index + 1]) blue += 1;
      }
      bare.push(blue / width);
    }
    return bare;
  }, { pitchDegrees: pitch, width, height });
} finally {
  await browser.close();
}

if (rows.every((value) => value === 0)) {
  throw new Error('Every row reads as covered; the ground never came back blue.');
}

const bands = [];
for (const [low, high] of BANDS) {
  const ys = [];
  for (let y = 0; y < height; y += 1) {
    const distance = distanceOfRow(y, pitch);
    if (distance >= low && distance < high) ys.push(y);
  }
  if (ys.length < 2) continue;
  bands.push({
    band: `${low}-${high}`,
    rows: ys.length,
    bare: ys.reduce((total, y) => total + rows[y], 0) / ys.length,
  });
}
const report = {
  label,
  url: url.href,
  at: new Date().toISOString(),
  canvas: { width, height },
  pitch,
  adapter,
  bands,
};
const path = await writeJson(directory, 'coverage.json', report);

console.log(`${url.href}  pitch ${pitch}deg  ${width}x${height}`);
console.log(`${'band (m)'.padEnd(12)} ${'rows'.padStart(5)}  bare ground`);
for (const row of bands) {
  console.log(
    `${row.band.padEnd(12)} ${String(row.rows).padStart(5)}  ` +
    `${(100 * row.bare).toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(row.bare * 40))}`,
  );
}
console.log(`\nreport ${path}`);
