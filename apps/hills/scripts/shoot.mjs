/**
 * Fixed-view screenshots of the hills demo.
 *
 * The six looks in `FIXED_VIEWS` (lib.mjs): the opening framing, along the
 * horizon towards the sun, across it and away from it, and two raised views,
 * shared with `measure-clouds.mjs`. The camera is set from the page after the
 * cloud cache has had time for a cycle or two; walk controls only rewrite the
 * camera rotation on mouse input, so a rotation set from here sticks.
 *
 *   node scripts/shoot.mjs --label before
 *   node scripts/shoot.mjs --label after --url 'http://127.0.0.1:5173/?clouds=off'
 *
 * Writes `<out>/<label>/<name>.png`. Visual evidence only; never a benchmark.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  APP_ROOT, FIXED_VIEWS, aimCamera, appUrl, defaultLabel, launchBrowser,
  loopbackUrl, openHills, parseArgs, sanitizeLabel,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['url', 'out', 'label', 'width', 'height'],
});
const label = sanitizeLabel(args.label ?? defaultLabel('shoot'));
const width = Number(args.width ?? 1920);
const height = Number(args.height ?? 1080);
const url = appUrl(loopbackUrl(args.url), { ui: 0 });
const out = resolve(args.out ?? join(APP_ROOT, 'shots'), label);

await mkdir(out, { recursive: true });
const browser = await launchBrowser();
const { page } = await openHills(browser, url, { width, height });

try {
  // Let the cloud cache complete a cycle or two before the first shot.
  await page.waitForTimeout(6000);

  for (const [name, elevation, azimuth] of FIXED_VIEWS) {
    await aimCamera(page, elevation, azimuth);
    await page.evaluate(() => new Promise((resolve) => {
      let frames = 0;
      const step = () => (++frames > 4 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    }));
    const path = join(out, `${name}.png`);
    await page.screenshot({ path });
    console.log(`${name.padEnd(16)} ${path}`);
  }
} finally {
  await browser.close();
}

console.log(`\n${FIXED_VIEWS.length} shots in ${out}`);
