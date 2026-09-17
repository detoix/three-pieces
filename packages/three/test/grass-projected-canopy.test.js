import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { canopyWeightAt } from '../src/grass/canopy-lod.js';

const near = 0.39, far = 0.78, bladeWidth = 0.0034125;
const pullAt = args => near + (far - near) * canopyWeightAt(args);

test('projected canopy keeps the near blade normal and reaches the same far canopy as the underlay', () => {
  const pixelScale = 2 * Math.tan(62 * Math.PI / 360) / 1080;
  assert.equal(pullAt({ horizontalDistance: 0, viewDepth: 1.7, bladeWidth, pixelScale }), near);
  for (const distance of [3, 4, 6, 8, 12, 24, 52]) {
    const args = { horizontalDistance: distance, viewDepth: distance, bladeWidth, pixelScale };
    const underlayWeight = canopyWeightAt(args);
    assert.ok(Math.abs((pullAt(args) - near) / (far - near) - underlayWeight) < 1e-12);
  }
  assert.ok(pullAt({ horizontalDistance: 8, viewDepth: 8, bladeWidth, pixelScale }) > far - 0.002);
  assert.equal(pullAt({ horizontalDistance: 52, viewDepth: 52, bladeWidth, pixelScale }), far);
  // More pixels do not recreate the 8/9 of near-field crowns omitted at 8 m.
  const highResolution = pullAt({ horizontalDistance: 8, viewDepth: 8,
    bladeWidth, pixelScale: pixelScale / 100 });
  assert.ok(Math.abs(highResolution - (near + (far - near) * 8 / 9)) < 1e-12);
});

test('view-matrix depth matches an actually projected blade width off-axis and across camera pitches', () => {
  for (const fov of [35, 62, 90]) for (const height of [720, 1080, 2160]) {
    const width = height * 16 / 9;
    const camera = new PerspectiveCamera(fov, width / height, .05, 170);
    camera.position.set(7, 1.7, 9);
    camera.lookAt(7, fov === 62 ? -2 : 1, -12);
    camera.updateMatrixWorld(true);
    const right = new Vector3(1, 0, 0).transformDirection(camera.matrixWorld);
    const pixelScale = 2 / (camera.projectionMatrix.elements[5] * height);
    for (const base of [new Vector3(7, 0, 5), new Vector3(10, 0, 1), new Vector3(2, 0, -5)]) {
      const viewDepth = -base.clone().applyMatrix4(camera.matrixWorldInverse).z;
      const horizontalDistance = Math.hypot(base.x - camera.position.x, base.z - camera.position.z);
      const a = base.clone().addScaledVector(right, -bladeWidth / 2).project(camera);
      const b = base.clone().addScaledVector(right, bladeWidth / 2).project(camera);
      const projectedPixels = Math.abs(b.x - a.x) * width / 2;
      assert.ok(Math.abs(projectedPixels - bladeWidth / (viewDepth * pixelScale)) < 1e-10);
      // Independent projection of the two endpoints yields the same proxy
      // weight as the vertex's view-depth inputs and the ground's positionView.
      const fromEndpoints = canopyWeightAt({ horizontalDistance, viewDepth: 1,
        bladeWidth, pixelScale: bladeWidth / projectedPixels });
      const fromViewDepth = canopyWeightAt({ horizontalDistance, viewDepth, bladeWidth, pixelScale });
      assert.ok(Math.abs(fromEndpoints - fromViewDepth) < 1e-10);
    }
  }
});
