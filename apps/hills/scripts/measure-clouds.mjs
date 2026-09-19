/**
 * Measure the cloud look, on the real adapter: how much of the sky is cloud,
 * how bright the clouds are, and what colour their shaded parts are.
 *
 * The cloud density and lighting are judged by eye, and an eye drifts: a
 * change that crisps the edges can quietly shrink every cloud, and one that
 * brightens the shaded sides can quietly turn them cyan. None of it is
 * visible to `pnpm test`, which never runs a draw. This renders the six
 * `FIXED_VIEWS` that `shoot.mjs` also uses, with the wind stopped
 * (`cloudwind=0`) so every run sees the same clouds, and reports per view:
 *
 *   cover   cloud pixels as a share of sky pixels (the ground is excluded)
 *   luma    display luma of cloud pixels at the 10th, 50th and 90th percentile
 *   shaded  mean colour and hue of the darkest 15% of cloud pixels
 *
 * A pixel is ground when it is clearly green, cloud when it is nearly
 * unsaturated and bright, sky otherwise. The classifier is crude on purpose:
 * it is the same crude classifier every run, so a change in its numbers is a
 * change in the image.
 *
 *   node scripts/measure-clouds.mjs --label before
 *   node scripts/measure-clouds.mjs --label cover-06 --url 'http://127.0.0.1:5173/?cloudcoverage=0.6'
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FIXED_VIEWS, aimCamera, appUrl, defaultLabel, launchBrowser, loopbackUrl,
  openHills, outputDir, parseArgs, requireHardwareAdapter, sanitizeLabel,
  writeJson,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['url', 'out', 'label', 'width', 'height'],
});
const label = sanitizeLabel(args.label ?? defaultLabel('clouds'));
const width = Number(args.width ?? 1920);
const height = Number(args.height ?? 1080);
const url = appUrl(loopbackUrl(args.url), { ui: 0, cloudwind: 0 });
const directory = join(await outputDir(args.out), label);
await mkdir(directory, { recursive: true });

const browser = await launchBrowser();
const views = [];
let adapter;
let options;
try {
  const { page } = await openHills(browser, url, { width, height });
  adapter = await requireHardwareAdapter(page);
  options = await page.evaluate(() => ({ ...window.__hills.options, ...window.__hills.lawn }));
  for (const [name, elevation, azimuth] of FIXED_VIEWS) {
    await aimCamera(page, elevation, azimuth);
    const stats = await page.evaluate(async () => {
      // `capture` resolves with the frame drawn next, read in the same task
      // as the draw -- the one moment a WebGPU canvas is certain to hold it.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const dataUrl = await window.__hills.capture();
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

      let sky = 0;
      const lumas = [];
      const pixels = [];
      // Every other pixel in both directions: a quarter of a 1080p frame is
      // still half a million samples.
      for (let y = 0; y < canvas.height; y += 2) {
        for (let x = 0; x < canvas.width; x += 2) {
          const index = (y * canvas.width + x) * 4;
          const r = data[index] / 255;
          const g = data[index + 1] / 255;
          const b = data[index + 2] / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const saturation = max > 0 ? (max - min) / max : 0;
          if (g > r * 1.15 && g > b * 1.15 && saturation > 0.3) continue;
          sky += 1;
          if (saturation < 0.22 && max > 0.45) {
            lumas.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
            pixels.push(r, g, b);
          }
        }
      }
      const clouds = lumas.length;
      if (clouds < 30) return { sky, clouds };
      const sorted = [...lumas].sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(clouds - 1, Math.floor(q * clouds))];
      const cutoff = at(0.15);
      const shaded = [0, 0, 0];
      let count = 0;
      for (let i = 0; i < clouds; i += 1) {
        if (lumas[i] > cutoff) continue;
        shaded[0] += pixels[i * 3];
        shaded[1] += pixels[i * 3 + 1];
        shaded[2] += pixels[i * 3 + 2];
        count += 1;
      }
      return {
        sky,
        clouds,
        luma: [at(0.1), at(0.5), at(0.9)],
        shaded: shaded.map((channel) => channel / count),
      };
    });
    views.push({ name, elevation, azimuth, ...stats });
  }
} finally {
  await browser.close();
}

function hue([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const report = {
  label,
  url: url.href,
  at: new Date().toISOString(),
  canvas: { width, height },
  adapter,
  options,
  views: views.map((view) => ({
    ...view,
    cover: view.sky ? view.clouds / view.sky : 0,
    shadedHue: view.shaded ? hue(view.shaded) : null,
  })),
};
const path = await writeJson(directory, 'clouds.json', report);

console.log(`${url.href}  ${width}x${height}  wind stopped`);
console.log(`${'view'.padEnd(15)} ${'cover'.padStart(6)}  luma p10/p50/p90    shaded rgb          hue`);
for (const view of report.views) {
  const cover = `${(100 * view.cover).toFixed(1)}%`.padStart(6);
  if (!view.luma) {
    console.log(`${view.name.padEnd(15)} ${cover}  (too little cloud to say more)`);
    continue;
  }
  const luma = view.luma.map((value) => value.toFixed(2)).join('/');
  const shaded = view.shaded.map((value) => value.toFixed(2)).join(',');
  console.log(`${view.name.padEnd(15)} ${cover}  ${luma.padEnd(18)} (${shaded})   ${view.shadedHue.toFixed(1)}`);
}
console.log(`\nreport ${path}`);
