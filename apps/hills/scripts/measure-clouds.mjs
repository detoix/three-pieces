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
 *   cover   cloud pixels as a share of sky pixels (the ground is excluded),
 *           found by rendering each view again with `clouds=off` and taking
 *           the pixels the clouds changed -- geometry, whatever their shading
 *   luma    display luma of cloud pixels at the 10th, 50th and 90th percentile
 *   sat     saturation of cloud pixels at the 50th and 90th percentile
 *   shaded  mean colour and hue of the darkest 15% of cloud pixels
 *
 * and, pooled over the views, the luma spread (10th over 90th percentile) and
 * saturation that `measure-photos.mjs` reports for photographs. Those use the
 * colour classifier `cloudPixels` in `lib.mjs`, shared with that tool so a
 * render and a photograph are measured the same way; cover does not, because
 * that classifier calls a cloud shaded blue enough sky, and a change to the
 * lighting would read as a change to the amount of cloud. Cloud shadows are
 * off in both renders, so the ground cannot change with the clouds.
 *
 *   node scripts/measure-clouds.mjs --label before
 *   node scripts/measure-clouds.mjs --label cover-06 --url 'http://127.0.0.1:5173/?cloudcoverage=0.6'
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FIXED_VIEWS, aimCamera, appUrl, cloudLook, cloudPixelsSource, defaultLabel,
  histogramQuantiles, launchBrowser, loopbackUrl, openHills, outputDir,
  parseArgs, requireHardwareAdapter, sanitizeLabel, writeJson,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['url', 'out', 'label', 'width', 'height'],
});
const label = sanitizeLabel(args.label ?? defaultLabel('clouds'));
const width = Number(args.width ?? 1920);
const height = Number(args.height ?? 1080);
const url = appUrl(loopbackUrl(args.url), { ui: 0, cloudwind: 0, cloudshadows: 'off' });
const clear = appUrl(new URL(url.href), { clouds: 'off' });
const directory = join(await outputDir(args.out), label);
await mkdir(directory, { recursive: true });

// One frame of the view in front of the camera: the colour classifier's
// statistics at full resolution, and every fourth pixel in both directions as
// RGBA bytes for comparing the two renders.
async function frame(page) {
  return page.evaluate(async (source) => {
    // `capture` resolves with the frame drawn next, read in the same task as
    // the draw -- the one moment a WebGPU canvas is certain to hold it.
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
    const cloudPixels = new Function(`return ${source}`)();
    const sampled = [];
    for (let y = 0; y < canvas.height; y += 4) {
      for (let x = 0; x < canvas.width; x += 4) {
        const index = (y * canvas.width + x) * 4;
        sampled.push(data[index], data[index + 1], data[index + 2]);
      }
    }
    return { stats: cloudPixels(data, canvas.width, canvas.height), sampled };
  }, cloudPixelsSource);
}

async function render(browser, target) {
  const { page } = await openHills(browser, target, { width, height });
  const adapter = await requireHardwareAdapter(page);
  const options = await page.evaluate(() => ({ ...window.__hills.options, ...window.__hills.lawn }));
  const frames = [];
  for (const [, elevation, azimuth] of FIXED_VIEWS) {
    await aimCamera(page, elevation, azimuth);
    frames.push(await frame(page));
  }
  await page.context().close();
  return { adapter, options, frames };
}

const browser = await launchBrowser();
let cloudy;
let reference;
try {
  cloudy = await render(browser, url);
  reference = await render(browser, clear);
} finally {
  await browser.close();
}
const { adapter, options } = cloudy;

// A pixel is cloud when the clouds moved any channel by more than 6 of 255,
// and ground when it is clearly green without them, as `cloudPixels` has it.
const views = FIXED_VIEWS.map(([name, elevation, azimuth], index) => {
  const a = cloudy.frames[index].sampled;
  const b = reference.frames[index].sampled;
  let sky = 0;
  let cloud = 0;
  for (let i = 0; i < a.length; i += 3) {
    const [r, g, bl] = [b[i] / 255, b[i + 1] / 255, b[i + 2] / 255];
    const max = Math.max(r, g, bl);
    const saturation = max > 0 ? (max - Math.min(r, g, bl)) / max : 0;
    if (g > r * 1.15 && g > bl * 1.15 && saturation > 0.3) continue;
    sky += 1;
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 6) cloud += 1;
  }
  return { name, elevation, azimuth, cover: sky ? cloud / sky : 0, ...cloudy.frames[index].stats };
});

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
  reference: clear.href,
  at: new Date().toISOString(),
  canvas: { width, height },
  adapter,
  options,
  pooled: cloudLook(views.filter((view) => view.clouds >= 30)),
  views: views.map(({ lumaHistogram, saturationHistogram, ...view }) => ({
    ...view,
    luma: view.clouds >= 30 ? histogramQuantiles(lumaHistogram, [0.1, 0.5, 0.9]) : null,
    saturation: view.clouds >= 30 ? histogramQuantiles(saturationHistogram, [0.5, 0.9]) : null,
    shadedHue: view.shaded && view.clouds >= 30 ? hue(view.shaded) : null,
  })),
};
const path = await writeJson(directory, 'clouds.json', report);

console.log(`${url.href}  ${width}x${height}  wind stopped`);
console.log(`${'view'.padEnd(15)} ${'cover'.padStart(6)}  luma p10/p50/p90  sat p50/p90  shaded rgb          hue`);
for (const view of report.views) {
  const cover = `${(100 * view.cover).toFixed(1)}%`.padStart(6);
  if (!view.luma) {
    console.log(`${view.name.padEnd(15)} ${cover}  (too little cloud to say more)`);
    continue;
  }
  const luma = view.luma.map((value) => value.toFixed(2)).join('/');
  const saturation = view.saturation.map((value) => value.toFixed(2)).join('/');
  const shaded = view.shaded.map((value) => value.toFixed(2)).join(',');
  console.log(`${view.name.padEnd(15)} ${cover}  ${luma.padEnd(16)}  ${saturation.padEnd(11)}  (${shaded})   ${view.shadedHue.toFixed(1)}`);
}
const { luma, contrast, saturation } = report.pooled;
console.log(`${'pooled'.padEnd(15)} ${''.padStart(6)}  ${luma.map((v) => v.toFixed(2)).join('/').padEnd(16)}  ` +
  `${saturation.map((v) => v.toFixed(2)).join('/').padEnd(11)}  p10/p90 ${contrast.toFixed(2)}`);
console.log(`\nreport ${path}`);
