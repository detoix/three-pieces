/**
 * Measure photographs the way `measure-clouds.mjs` measures the render: the
 * same classifier (`cloudPixels` in `lib.mjs`), the same luma spread and
 * saturation, per photograph and pooled. A render's numbers only mean
 * something beside a real sky's; this is how the cloud look is grounded.
 *
 * Photographs are not kept in this repository. `docs/measuring.md` lists the
 * reference set by Wikimedia Commons title and licence; download each at about
 * 1280 px wide and pass the files. Auto-exposure and processing move a
 * photograph's absolute luma, so compare the spread (10th over 90th
 * percentile) and the saturation, which they move much less.
 *
 *   node scripts/measure-photos.mjs --label cumulus ~/cloud-photos/*.jpg
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  cloudLook, cloudPixelsSource, defaultLabel, launchBrowser,
  outputDir, parseArgs, sanitizeLabel, writeJson,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { values: ['out', 'label'] });
const label = sanitizeLabel(args.label ?? defaultLabel('photos'));
const files = args._;
if (!files.length) throw new Error('Pass the photographs to measure.');
const directory = join(await outputDir(args.out), label);

const browser = await launchBrowser();
const photos = [];
try {
  const page = await browser.newPage();
  for (const file of files) {
    const base64 = (await readFile(file)).toString('base64');
    const stats = await page.evaluate(async ({ base64, source }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const cloudPixels = new Function(`return ${source}`)();
      return { width: bitmap.width, height: bitmap.height, ...cloudPixels(data, bitmap.width, bitmap.height) };
    }, { base64, source: cloudPixelsSource });
    photos.push({ file: basename(file), ...stats });
  }
} finally {
  await browser.close();
}

const usable = photos.filter((photo) => photo.clouds >= 30);
const report = {
  label,
  at: new Date().toISOString(),
  pooled: usable.length ? cloudLook(usable) : null,
  photos: photos.map(({ lumaHistogram, saturationHistogram, ...photo }) => ({
    ...photo,
    ...(photo.clouds >= 30 ? cloudLook([{ lumaHistogram, saturationHistogram }]) : {}),
  })),
};
const path = await writeJson(directory, 'photos.json', report);

const numbers = ({ luma, contrast, saturation }) =>
  `${luma.map((v) => v.toFixed(2)).join('/').padEnd(16)}  ${contrast.toFixed(2).padStart(7)}  ` +
  `${saturation.map((v) => v.toFixed(2)).join('/')}`;
console.log(`${'photograph'.padEnd(28)} luma p10/p50/p90  p10/p90  sat p50/p90`);
for (const photo of report.photos) {
  console.log(`${photo.file.slice(0, 27).padEnd(28)} ${photo.luma ? numbers(photo) : '(too little cloud)'}`);
}
if (report.pooled) console.log(`${'pooled'.padEnd(28)} ${numbers(report.pooled)}`);
console.log(`\nreport ${path}`);
