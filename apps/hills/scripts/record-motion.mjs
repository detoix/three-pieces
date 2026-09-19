/**
 * Ten-second WebM captures along fixed motion paths, for visual review.
 *
 *   node scripts/record-motion.mjs --path static --label wind-12
 *   node scripts/record-motion.mjs --path stress --label before
 *   node scripts/record-motion.mjs --path seam
 *   node scripts/record-motion.mjs --path zenith
 *
 * Playwright drives the camera and the page records its own canvas with
 * MediaRecorder, so the file is exactly the requested ten seconds rather than
 * however long the page happened to be open. Video encoding and PNG capture
 * perturb playback: these captures are visual evidence and never performance
 * numbers.
 */
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  appUrl, defaultLabel, hashTree, launchBrowser, loopbackUrl,
  openHills, outputDir, parseArgs, requireHardwareAdapter, sanitizeLabel,
  writeJson,
} from './lib.mjs';

const PATHS = {
  static: 'Hold a 25 degree sky view for 10 seconds.',
  stress: 'Hold 3 s; pan 60 degrees out and back in 2 s; traverse 16 m and return in 4 s; hold 1 s.',
  seam: 'Two smooth +/-30 degree azimuth sweeps across the +Z wrap seam; 25 degree elevation.',
  zenith: 'Full azimuth turn at 89.9 degree elevation, ground-level observer.',
};

const args = parseArgs(process.argv.slice(2), {
  values: ['url', 'out', 'label', 'path', 'seconds', 'width', 'height'],
});
const label = sanitizeLabel(args.label ?? defaultLabel('motion'));
const pathName = args.path ?? 'static';
if (!Object.hasOwn(PATHS, pathName)) throw new Error(`Unknown --path ${pathName}.`);
const seconds = Number(args.seconds ?? 10);
const width = Number(args.width ?? 1920);
const height = Number(args.height ?? 1080);
const url = appUrl(loopbackUrl(args.url), { ui: 0 });
const output = join(await outputDir(args.out), label);
await mkdir(output, { recursive: true });

const before = await hashTree();
const browser = await launchBrowser();
const videoChunks = [];
const frameImages = new Map();
let result;
let adapter;
try {
  const { page } = await openHills(browser, url, { width, height });
  adapter = await requireHardwareAdapter(page);
  await page.exposeFunction('__motionChunk', (base64) => {
    videoChunks.push(Buffer.from(base64, 'base64'));
  });
  await page.exposeFunction('__motionFrame', (name, dataUrl) => {
    frameImages.set(name, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  });
  page.setDefaultTimeout(0);
  result = await page.evaluate(async ({ pathName, seconds, frameTimes }) => {
    const hills = window.__hills;
    const { renderer, camera, sky, options, lawn, groundAt } = hills;
    renderer.setPixelRatio(1);
    renderer.setSize(1920, 1080, false);
    camera.aspect = 1920 / 1080;
    camera.updateProjectionMatrix();

    const canvas = renderer.domElement;
    const stream = canvas.captureStream(30);
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('No WebM MediaRecorder codec is available.');
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12000000 });
    const recording = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (event) => reject(event.error || new Error('MediaRecorder failed.'));
    });
    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    recorder.ondataavailable = async (event) => {
      if (event.data.size) await window.__motionChunk(await blobToBase64(event.data));
    };

    const { heading: headingDegrees, eye, startX, startZ } = options;
    const heading = (headingDegrees * Math.PI) / 180;
    const forward = { x: Math.sin(heading), z: -Math.cos(heading) };
    const right = { x: -forward.z, z: forward.x };
    const ease = (t) => t * t * (3 - 2 * t);

    function pose(elapsedSeconds) {
      let x = startX;
      let z = startZ;
      let yaw = Math.PI + heading;
      let pitch = (25 * Math.PI) / 180;
      if (pathName === 'stress') {
        const pan = elapsedSeconds < 3 ? 0
          : elapsedSeconds < 4 ? elapsedSeconds - 3
            : elapsedSeconds < 5 ? 5 - elapsedSeconds : 0;
        yaw += ((60 * Math.PI) / 180) * ease(Math.max(0, Math.min(1, pan)));
        const offset = elapsedSeconds >= 5
          ? 16 * Math.sin(Math.PI * Math.min(1, (elapsedSeconds - 5) / 4)) : 0;
        x += right.x * offset;
        z += right.z * offset;
      } else if (pathName === 'seam') {
        yaw = Math.PI + Math.sin((elapsedSeconds * Math.PI) / 2.5) * ((30 * Math.PI) / 180);
      } else if (pathName === 'zenith') {
        yaw = Math.PI + heading + elapsedSeconds * Math.PI * 2;
        pitch = (89.9 * Math.PI) / 180;
      }
      camera.position.set(x, groundAt(x, z) + eye, z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(pitch, yaw, 0);
      camera.updateMatrixWorld(true);
    }

    const captured = [];
    recorder.start(500);
    const started = performance.now();
    await new Promise((resolve, reject) => {
      const step = (now) => {
        try {
          const elapsed = now - started;
          pose(elapsed / 1000);
          while (captured.length < frameTimes.length && elapsed / 1000 >= frameTimes[captured.length]) {
            const index = captured.length;
            captured.push({ seconds: elapsed / 1000, position: camera.position.toArray() });
            void window.__motionFrame(
              `frame-${index + 1}`,
              canvas.toDataURL('image/png'),
            );
          }
          if (elapsed >= seconds * 1000) resolve();
          else requestAnimationFrame(step);
        } catch (error) {
          reject(error);
        }
      };
      requestAnimationFrame(step);
    });
    recorder.stop();
    await recording;
    for (const track of stream.getTracks()) track.stop();
    const clouds = sky?.clouds ?? null;
    return {
      mimeType,
      durationSeconds: seconds,
      frames: captured,
      cloudStats: clouds?.stats ?? null,
      canvas: { width: canvas.width, height: canvas.height },
      options: { ...options, ...lawn },
    };
  }, { pathName, seconds, frameTimes: [0.5, 3.5, 6.5, 9.5] });
} finally {
  await browser.close();
}
const after = await hashTree();

for (const [name, image] of frameImages) {
  await writeFile(join(output, `${name}.png`), image);
}
await writeFile(join(output, 'motion.webm'), Buffer.concat(videoChunks));

const videoBytes = videoChunks.reduce((total, chunk) => total + chunk.length, 0);
const report = {
  label,
  path: pathName,
  description: PATHS[pathName],
  url: url.href,
  at: new Date().toISOString(),
  adapter,
  purpose: 'Visual review only; encoding and PNG capture invalidate performance comparisons.',
  requestedFrameRate: 30,
  durationSeconds: result.durationSeconds,
  canvas: result.canvas,
  mimeType: result.mimeType,
  videoBytes,
  frames: result.frames,
  cloudStats: result.cloudStats,
  options: result.options,
  sourceHashBefore: before,
  sourceHashAfter: after,
  sourceUnchanged: before === after,
  warnings: before === after ? [] : ['The source tree changed during the capture.'],
};
const reportPath = await writeJson(output, 'motion.json', report);

if (videoBytes < 1000) throw new Error('Recorded WebM is empty.');
if (frameImages.size === 0) throw new Error('No review frames were captured.');
console.log(`recorded ${pathName} for ${seconds}s  ${result.mimeType}  ${(videoBytes / 1e6).toFixed(1)} MB`);
console.log(`frames ${frameImages.size}  adapter ${adapter.classification}`);
for (const warning of report.warnings) console.log(`warning: ${warning}`);
console.log(`\n${output}`);
