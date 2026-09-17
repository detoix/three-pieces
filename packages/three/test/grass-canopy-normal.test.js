import assert from 'node:assert/strict';
import test from 'node:test';

import { Euler, Matrix4, Vector3 } from 'three';
import { CANOPY_PULL_FLOOR, LAWN } from '../src/grass/preset.js';

// Scalar counterpart of the grass material's fragment-stage canopy mix.
function canopyNormal(blade, ground, pull, frontFacing) {
  const facingBlade = blade.clone().normalize().multiplyScalar(frontFacing ? 1 : -1);
  const mixed = facingBlade.clone().lerp(ground.clone().normalize(), pull);
  return mixed.length() > CANOPY_PULL_FLOOR ? mixed.normalize() : facingBlade;
}

function closeVector(actual, expected, message) {
  assert.ok(actual.distanceTo(expected) < 1e-12,
    `${message}: ${actual.toArray()} versus ${expected.toArray()}`);
}

test('both faces of an upright leaf retain the upward canopy contribution', () => {
  const ground = new Vector3(0, 1, 0);
  for (const pull of [LAWN.canopyNormalNear, LAWN.canopyNormalFar]) {
    for (let yaw = 0; yaw < Math.PI * 2; yaw += .2) {
      const blade = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      const front = canopyNormal(blade, ground, pull, true);
      const back = canopyNormal(blade, ground, pull, false);
      assert.ok(front.y > 0 && back.y > 0);
      assert.ok(Math.abs(front.y - back.y) < 1e-12);
      // The previous order flipped the canopy as well as the leaf.
      const oldBack = blade.clone().lerp(ground, pull).normalize().negate();
      assert.ok(oldBack.y < 0);
    }
  }
});

test('canopy shading commutes with camera rotations, including sloped ground', () => {
  const rotations = [
    new Euler(.7, 1.1, -.2), new Euler(-1.2, .2, .8), new Euler(0, Math.PI, 0),
  ].map((euler) => new Matrix4().makeRotationFromEuler(euler));
  const ground = new Vector3(.15, 1, -.2).normalize();
  const blade = new Vector3(.8, -.25, .5).normalize();
  for (const rotation of rotations) {
    for (const frontFacing of [true, false]) {
      for (const pull of [0, .3, .6]) {
        const inWorld = canopyNormal(blade, ground, pull, frontFacing);
        const inView = canopyNormal(
          blade.clone().transformDirection(rotation),
          ground.clone().transformDirection(rotation), pull, frontFacing,
        );
        closeVector(inView, inWorld.transformDirection(rotation), 'view-space canopy');
      }
    }
  }
});

test('opposed normals at equal weight remain finite', () => {
  for (const frontFacing of [true, false]) {
    const blade = new Vector3(0, frontFacing ? -1 : 1, 0);
    closeVector(canopyNormal(blade, new Vector3(0, 1, 0), .5, frontFacing),
      new Vector3(0, -1, 0), 'cancellation keeps the face-forward blade');
  }
});

test('the underlay blends texture and grain normals in the same space', () => {
  const surface = new Vector3(.1, 1, .15).normalize();
  const grain = new Vector3(-.3, 1, .2).normalize();
  const rotation = new Matrix4().makeRotationFromEuler(new Euler(.8, -.6, .2));
  const weight = .7;
  const expected = surface.clone().lerp(grain, weight).normalize()
    .transformDirection(rotation);
  const viewBlend = surface.clone().transformDirection(rotation)
    .lerp(grain.clone().transformDirection(rotation), weight).normalize();
  closeVector(viewBlend, expected, 'surface and grain use view space');
  const oldMixedSpaces = surface.clone().transformDirection(rotation)
    .lerp(grain, weight).normalize();
  assert.ok(oldMixedSpaces.distanceTo(expected) > .1);
});
