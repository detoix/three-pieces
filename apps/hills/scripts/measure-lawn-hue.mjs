/**
 * Measure the lawn's rendered hue, saturation and luminance against depth.
 *
 * `LAWN_TARGET_HUE` is a property of the rendered image, not of the palette:
 * the blades, the Grass004 underlay, the canopy proxy, the ground occlusion
 * and the sun's colour all decide what a pixel of lawn is made of, so the
 * number has to be re-swept after any of them moves. This drives the flat
 * ground (`hills=0`) in headless Chromium on hardware WebGPU, pitches the
 * camera down 28 degrees and averages six depth bands.
 *
 * The mean is the mean *of the band means*, not of the pixels: a pitched
 * camera gives the near field an order of magnitude more rows than the far,
 * and a pixel mean would be a measurement of the camera angle.
 *
 *   node scripts/measure-lawn-hue.mjs --label shipped
 *   node scripts/measure-lawn-hue.mjs --label hue-86 --query 'lawnhue=86.7'
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  appUrl, defaultLabel, launchBrowser, loopbackUrl, openHills, outputDir,
  parseArgs, requireHardwareAdapter, sanitizeLabel, toLinear, writeJson,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['url', 'out', 'label', 'pitch', 'width', 'height'],
});
const label = sanitizeLabel(args.label ?? defaultLabel('lawn-hue'));
const pitch = Number(args.pitch ?? 28);
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const url = appUrl(loopbackUrl(args.url), { ui: 0, hills: 0 });
const directory = join(await outputDir(args.out), label);
await mkdir(directory, { recursive: true });

const EYE = 1.7;
const FOV = 62;
const BANDS = [[1, 2], [2, 4], [4, 8], [8, 16], [16, 24], [24, 52]];

function distanceOfRow(y, pitchDegrees) {
  const half = Math.tan((FOV * Math.PI) / 360);
  const ndc = 1 - (2 * (y + 0.5)) / height;
  const angle = Math.atan(ndc * half) - (pitchDegrees * Math.PI) / 180;
  return angle >= 0 ? Infinity : EYE / Math.tan(-angle);
}

function measurePixel(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const span = high - low;
  if (span === 0) return null;
  let hue;
  if (high === r) hue = ((g - b) / span) % 6;
  else if (high === g) hue = (b - r) / span + 2;
  else hue = (r - g) / span + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return {
    hue,
    saturation: span / high,
    luminance:
      0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue),
  };
}

const browser = await launchBrowser();
let pixels;
let adapter;
try {
  const { page } = await openHills(browser, url, { width, height });
  adapter = await requireHardwareAdapter(page);
  pixels = await page.evaluate(async ({ pitchDegrees, width, height }) => {
    const { camera } = window.__hills;
    const canvas = document.querySelector('canvas');
    for (const node of document.body.querySelectorAll('*')) {
      if (node !== canvas && !node.contains(canvas)) node.style.display = 'none';
    }
    // A known pose: a row is only a distance if the height and pitch are.
    camera.position.set(0, 1.7, 0);
    camera.rotation.order = 'YXZ';
    const aim = () => {
      camera.rotation.set((-pitchDegrees * Math.PI) / 180, 0, 0);
      camera.updateMatrixWorld(true);
    };
    aim();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    aim();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const flat = document.createElement('canvas');
    flat.width = width;
    flat.height = height;
    const context = flat.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0, width, height);
    return Array.from(context.getImageData(0, 0, width, height).data);
  }, { pitchDegrees: pitch, width, height });
} finally {
  await browser.close();
}

const rows = [];
for (const [low, high] of BANDS) {
  let hue = 0;
  let saturation = 0;
  let luminance = 0;
  let counted = 0;
  let scanlines = 0;
  for (let y = 0; y < height; y += 1) {
    const distance = distanceOfRow(y, pitch);
    if (distance < low || distance >= high) continue;
    scanlines += 1;
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * 4;
      const pixel = measurePixel(pixels[index], pixels[index + 1], pixels[index + 2]);
      if (!pixel) continue;
      hue += pixel.hue;
      saturation += pixel.saturation;
      luminance += pixel.luminance;
      counted += 1;
    }
  }
  rows.push({
    band: `${low}-${high}`,
    scanlines,
    hue: counted ? hue / counted : null,
    saturation: counted ? saturation / counted : null,
    luminance: counted ? luminance / counted : null,
  });
}

const filled = rows.filter((row) => row.hue !== null);
if (filled.length === 0) {
  throw new Error('No band caught a single lawn pixel; the page rendered something other than ground.');
}
const mean = (pick) => filled.reduce((total, row) => total + pick(row), 0) / filled.length;
const near = filled[0];
const far = filled[filled.length - 1];
const report = {
  label,
  url: url.href,
  at: new Date().toISOString(),
  canvas: { width, height },
  pitch,
  adapter,
  bands: rows,
  meanHue: mean((row) => row.hue),
  hueDriftNearToFar: far.hue - near.hue,
  luminanceNearToFar: far.luminance / near.luminance - 1,
  saturationNearToFar: far.saturation / near.saturation - 1,
};
const path = await writeJson(directory, 'hue.json', report);

console.log(`${url.href}  pitch ${pitch}deg  ${width}x${height}`);
console.log(`${'band (m)'.padEnd(10)} ${'rows'.padStart(5)}  ${'hue'.padStart(6)}  ${'sat'.padStart(6)}  luminance`);
for (const row of rows) {
  if (row.hue === null) {
    console.log(`${row.band.padEnd(10)} ${String(row.scanlines).padStart(5)}  ${'—'.padStart(6)}`);
    continue;
  }
  console.log(
    `${row.band.padEnd(10)} ${String(row.scanlines).padStart(5)}  ` +
    `${row.hue.toFixed(1).padStart(6)}  ${row.saturation.toFixed(3).padStart(6)}  ` +
    `${row.luminance.toFixed(4)}`,
  );
}
console.log(`\nmean hue over ${filled.length} bands  ${report.meanHue.toFixed(1)}   (a healthy lawn photographs at 99)`);
console.log(`hue drift near to far      ${report.hueDriftNearToFar >= 0 ? '+' : ''}${report.hueDriftNearToFar.toFixed(1)}`);
console.log(`luminance near to far      ${(100 * report.luminanceNearToFar).toFixed(0)}%`);
console.log(`saturation near to far     ${(100 * report.saturationNearToFar).toFixed(0)}%`);
console.log(`\nreport ${path}`);
