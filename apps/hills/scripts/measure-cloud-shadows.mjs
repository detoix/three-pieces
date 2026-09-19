/**
 * Measure the clouds' shadows on the real adapter: how much of the lawn in view
 * is shaded, and how dark a shadow is.
 *
 * Those are the two numbers the look turns on, and `pnpm test` can see
 * neither: it never runs a draw. This renders the six `FIXED_VIEWS` that
 * `shoot.mjs` also uses, twice, with the wind stopped (`cloudwind=0`) so both
 * renders see the same clouds -- once as the page ships and once with
 * `cloudshadows=off` -- and compares them pixel by pixel:
 *
 *   lawn     share of the frame that is lawn in the sunlit render
 *   shaded   share of lawn pixels below 80% of their sunlit luminance
 *   depth    those pixels' median luminance as a share of sunlit
 *   edge     share of lawn pixels between 80% and 97%: penumbra and thin cloud
 *   other    share of the rest of the frame that changed by over 3%: distant,
 *            hazy lawn the classifier does not call green. Never sky.
 *
 * Luminance is linear. A pixel is lawn when it is clearly green in the sunlit
 * render, by the classifier `measure-clouds.mjs` uses for ground. How dark a
 * shadow gets is the lights' balance, not the clouds': here the sun delivers
 * 1.34 times the sky's irradiance on flat ground, where a real one delivers
 * about ten (`packages/three/src/sky/lights.js`), so moving that balance moves
 * `depth`. How much is shaded is the clouds' and the sun's, and it depends on
 * where the camera stands in the weather: the demo's opening view looks into
 * a large shadowed region at the start of the clock.
 *
 *   node scripts/measure-cloud-shadows.mjs --label shipped
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FIXED_VIEWS, aimCamera, appUrl, defaultLabel, hashTree, launchBrowser,
  loopbackUrl, openHills, outputDir, parseArgs, requireHardwareAdapter,
  sanitizeLabel, writeJson,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['url', 'out', 'label', 'width', 'height'],
});
const label = sanitizeLabel(args.label ?? defaultLabel('cloud-shadows'));
const width = Number(args.width ?? 1920);
const height = Number(args.height ?? 1080);
const shaded = appUrl(loopbackUrl(args.url), { ui: 0, cloudwind: 0 });
const sunlit = appUrl(new URL(shaded.href), { cloudshadows: 'off' });
const directory = join(await outputDir(args.out), label);
await mkdir(directory, { recursive: true });

const SHADED_BELOW = 0.8;
const LIT_ABOVE = 0.97;

/** Every view's frame, as a PNG and as linear luminance and a lawn flag for
 *  every fourth pixel in both directions (130 000 of a 1080p frame). */
async function render(browser, url, tag) {
  const { page } = await openHills(browser, url, { width, height });
  const adapter = await requireHardwareAdapter(page);
  const frames = [];
  for (const [name, elevation, azimuth] of FIXED_VIEWS) {
    await aimCamera(page, elevation, azimuth);
    const frame = await page.evaluate(async () => {
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
      const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const luminance = [];
      const lawn = [];
      for (let y = 0; y < canvas.height; y += 4) {
        for (let x = 0; x < canvas.width; x += 4) {
          const index = (y * canvas.width + x) * 4;
          const r = data[index] / 255;
          const g = data[index + 1] / 255;
          const b = data[index + 2] / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const saturation = max > 0 ? (max - min) / max : 0;
          lawn.push(g > r * 1.15 && g > b * 1.15 && saturation > 0.3 ? 1 : 0);
          luminance.push(0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b));
        }
      }
      return { dataUrl, luminance, lawn };
    });
    await writeFile(join(directory, `${name}-${tag}.png`), Buffer.from(frame.dataUrl.split(',')[1], 'base64'));
    frames.push({ name, elevation, azimuth, luminance: frame.luminance, lawn: frame.lawn });
  }
  await page.context().close();
  return { adapter, frames };
}

const before = await hashTree();
const browser = await launchBrowser();
let lit;
let dark;
try {
  lit = await render(browser, sunlit, 'sunlit');
  dark = await render(browser, shaded, 'shaded');
} finally {
  await browser.close();
}
const after = await hashTree();

const views = lit.frames.map((frame, index) => {
  const other = dark.frames[index];
  const ratios = [];
  let rest = 0;
  let changed = 0;
  let edge = 0;
  for (let i = 0; i < frame.luminance.length; i += 1) {
    const ratio = other.luminance[i] / Math.max(frame.luminance[i], 1e-6);
    if (!frame.lawn[i]) {
      rest += 1;
      if (Math.abs(ratio - 1) > 0.03) changed += 1;
      continue;
    }
    ratios.push(ratio);
    if (ratio >= SHADED_BELOW && ratio <= LIT_ABOVE) edge += 1;
  }
  const inShadow = ratios.filter((ratio) => ratio < SHADED_BELOW).sort((a, b) => a - b);
  return {
    name: frame.name,
    elevation: frame.elevation,
    azimuth: frame.azimuth,
    lawn: ratios.length / frame.luminance.length,
    shaded: ratios.length ? inShadow.length / ratios.length : null,
    depth: inShadow.length ? inShadow[Math.floor(inShadow.length / 2)] : null,
    edge: ratios.length ? edge / ratios.length : null,
    other: rest ? changed / rest : 0,
  };
});

const warnings = [];
if (before !== after) warnings.push('The source tree changed during the run; this run is invalid.');
const report = {
  label,
  urls: { shaded: shaded.href, sunlit: sunlit.href },
  at: new Date().toISOString(),
  canvas: { width, height },
  adapter: lit.adapter,
  sourceUnchanged: before === after,
  thresholds: { shadedBelow: SHADED_BELOW, litAbove: LIT_ABOVE },
  views,
  warnings,
};
const path = await writeJson(directory, 'cloud-shadows.json', report);

const percent = (value) => (value === null ? '—' : `${(100 * value).toFixed(1)}%`);
console.log(`${shaded.href}  against ?cloudshadows=off  ${width}x${height}  wind stopped`);
console.log(`${'view'.padEnd(15)} ${'lawn'.padStart(6)} ${'shaded'.padStart(7)} ${'depth'.padStart(6)} ${'edge'.padStart(6)} ${'other'.padStart(6)}`);
for (const view of views) {
  console.log(
    `${view.name.padEnd(15)} ${percent(view.lawn).padStart(6)} ${percent(view.shaded).padStart(7)} ` +
    `${(view.depth === null ? '—' : view.depth.toFixed(2)).padStart(6)} ${percent(view.edge).padStart(6)} ` +
    `${percent(view.other).padStart(6)}`,
  );
}
if (warnings.length) {
  console.log('\nwarnings');
  for (const warning of warnings) console.log(`  ${warning}`);
}
console.log(`\nreport ${path}`);
