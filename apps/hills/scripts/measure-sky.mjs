/**
 * Measure the rendered sky and the fully fogged far band, on the real adapter.
 *
 * The atmosphere is solved with the sun's irradiance set to 1, so
 * `SKY_EXPOSURE` is the one number that decides how bright the whole image is,
 * and nothing on the CPU can check it: `pnpm test` never runs a draw, and the
 * sky's three lookup tables are written by compute passes. This drives the flat
 * ground (`hills=0`) in headless Chromium on hardware WebGPU, points the camera
 * along known directions and reads the pixels back.
 *
 * The far band is the calibration. Past the haze's far distance the haze has
 * taken over entirely, so those rows *are* the fog colour, and the fog colour
 * is the sky. The lawn's hue is calibrated over depth, so the far band is the
 * one thing an exposure change must not move.
 *
 * The hills haze reaches 1100 m, and from standing eye height (1.7 m) the
 * ground at that distance is less than one screen row below the horizon: the
 * fully fogged band is sub-pixel. So the instrument stands higher (`eye=10`,
 * `--eye` to change it), which puts the fog at a few resolvable rows and does
 * not change the sky or the fog colour:
 *
 *   node scripts/measure-sky.mjs --label flat --url 'http://127.0.0.1:5173/?sky=flat'
 *   node scripts/measure-sky.mjs --label atmosphere
 *
 * With `sky=flat` in the URL, the far band is the luminance the flat
 * `#b8c9b5` control has; rendered luminance is very nearly linear in the
 * exposure, so one run of each gives the exposure that holds the band still.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  appUrl, defaultLabel, launchBrowser, loopbackUrl, openHills, outputDir,
  parseArgs, requireHardwareAdapter, sanitizeLabel, hex, luminance, writeJson,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['url', 'out', 'label', 'width', 'height', 'eye'],
});
const label = sanitizeLabel(args.label ?? defaultLabel('sky'));
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const eye = Number(args.eye ?? 10);
const url = appUrl(loopbackUrl(args.url), { ui: 0, hills: 0, eye });
const directory = join(await outputDir(args.out), label);
await mkdir(directory, { recursive: true });

const browser = await launchBrowser();
let result;
let adapter;
try {
  const { page } = await openHills(browser, url, { width, height });
  adapter = await requireHardwareAdapter(page);
  result = await page.evaluate(async ({ width, height }) => {
    const { camera, lawn, options } = window.__hills;
    const canvas = document.querySelector('canvas');
    for (const node of document.body.querySelectorAll('*')) {
      if (node !== canvas && !node.contains(canvas)) node.style.display = 'none';
    }
    const sunAzimuth = lawn.sunAzimuth;
    const sunElevation = lawn.sunElevation;
    // The disk is a tenth of a degree of clipped white and says nothing; the
    // Mie lobe around it is the whole reason the sky is not a gradient.
    const looks = [
      ['zenith', 89, sunAzimuth],
      ['45 deg toward sun', 45, sunAzimuth],
      ['5 deg off the sun', sunElevation - 5, sunAzimuth],
      ['horizon toward sun', 2, sunAzimuth],
      ['horizon across', 2, sunAzimuth + 90],
      ['horizon away', 2, sunAzimuth + 180],
      ['45 deg away', 45, sunAzimuth + 180],
    ];

    camera.position.set(0, options.eye, 0);
    camera.rotation.order = 'YXZ';
    const flat = document.createElement('canvas');
    flat.width = width;
    flat.height = height;
    const context = flat.getContext('2d', { willReadFrequently: true });

    const shoot = async (elevation, azimuth) => {
      const pitch = (elevation * Math.PI) / 180;
      const yaw = Math.PI + (azimuth * Math.PI) / 180;
      camera.rotation.set(pitch, yaw, 0);
      camera.updateMatrixWorld(true);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      camera.rotation.set(pitch, yaw, 0);
      camera.updateMatrixWorld(true);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      context.drawImage(canvas, 0, 0, width, height);
      return context.getImageData(0, 0, width, height).data;
    };

    const centre = (data) => {
      const out = [0, 0, 0];
      let count = 0;
      for (let y = height / 2 - 4; y <= height / 2 + 4; y += 1) {
        for (let x = width / 2 - 4; x <= width / 2 + 4; x += 1) {
          const index = (y * width + x) * 4;
          out[0] += data[index];
          out[1] += data[index + 1];
          out[2] += data[index + 2];
          count += 1;
        }
      }
      return out.map((channel) => channel / count);
    };

    const sky = [];
    for (const [name, elevation, azimuth] of looks) {
      sky.push([name, centre(await shoot(elevation, azimuth))]);
    }

    // Rows whose ground distance is past the haze: whatever colour they are is
    // the colour the haze ends at.
    const half = Math.tan((62 * Math.PI) / 360);
    const distanceOfRow = (y) => {
      const ndc = 1 - (2 * (y + 0.5)) / height;
      const angle = Math.atan(ndc * half);
      return angle >= 0 ? Infinity : options.eye / Math.tan(-angle);
    };
    const farRows = [];
    for (let y = Math.floor(height / 2) + 1; y < height; y += 1) {
      if (distanceOfRow(y) > options.hazeFar * 1.01) farRows.push(y);
    }
    // If no row reaches the haze, the farthest visible row is the closest
    // thing to it; report that rather than silently averaging nothing.
    let farFallback = false;
    if (farRows.length === 0) {
      let bestRow = Math.floor(height / 2) + 1;
      let bestDistance = -1;
      for (let y = Math.floor(height / 2) + 1; y < height; y += 1) {
        const distance = distanceOfRow(y);
        if (Number.isFinite(distance) && distance > bestDistance) {
          bestDistance = distance;
          bestRow = y;
        }
      }
      farRows.push(bestRow);
      farFallback = true;
    }

    const band = [0, 0, 0];
    let samples = 0;
    for (const azimuth of [0, 90, 180, 270]) {
      const level = await shoot(0, azimuth);
      for (const y of farRows) {
        for (let x = 0; x < width; x += 4) {
          const index = (y * width + x) * 4;
          band[0] += level[index];
          band[1] += level[index + 1];
          band[2] += level[index + 2];
          samples += 1;
        }
      }
    }
    return {
      sky,
      band: band.map((channel) => channel / samples),
      samples,
      farRows: farRows.length,
      farDistance: distanceOfRow(farRows[farRows.length - 1]),
      farFallback,
      hazeFar: options.hazeFar,
      options: { ...options, ...lawn },
    };
  }, { width, height });
} finally {
  await browser.close();
}

const sky = result.sky.map(([name, colour]) => ({
  direction: name,
  srgb: hex(colour),
  luminance: luminance(colour),
}));
const report = {
  label,
  url: url.href,
  at: new Date().toISOString(),
  canvas: { width, height },
  adapter,
  options: result.options,
  sky,
  instrumentEyeMetres: eye,
  farBand: {
    hazeFarMetres: result.hazeFar,
    farDistanceMetres: result.farDistance,
    fallbackRow: result.farFallback,
    rows: result.farRows,
    samples: result.samples,
    srgb: hex(result.band),
    luminance: luminance(result.band),
  },
};
const path = await writeJson(directory, 'sky.json', report);

console.log(`${url.href}  ${width}x${height}`);
console.log(`${'direction'.padEnd(20)} ${'sRGB'.padEnd(9)} luminance`);
for (const entry of sky) {
  console.log(`${entry.direction.padEnd(20)} ${entry.srgb.padEnd(9)} ${entry.luminance.toFixed(4)}`);
}
console.log(
  `\nfar band (eye ${eye} m, haze far ${result.hazeFar} m, farthest row ${result.farDistance.toFixed(0)} m, ` +
  `${result.farRows} rows, four headings, ${result.samples} samples)\n` +
  `  ${hex(result.band)}  luminance ${luminance(result.band).toFixed(4)}` +
  (result.farFallback ? '  [fallback: no row reached the haze]' : ''),
);
console.log(`\nreport ${path}`);
