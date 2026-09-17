import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { createGPUDrivenGrass } from '../src/grass/grass.js';
import { GrassLightingModel, GRASS_BACKLIGHT } from '../src/grass/blade-lighting.js';
import { createFlatHeightMap } from '../src/grass/index.js';

function build(diffuseOnly, backlight = 'blade') {
  const { Fn, float, vec3 } = THREE.TSL;
  const renderer = { _attributes: { delete() {} } };
  const surface = {
    macroAt: Fn(() => float(.5)), healthAt: Fn(() => float(.6)),
    tintFrom: Fn(() => vec3(1)), densityFrom: Fn(() => float(1)),
    dryAt: Fn(() => float(0)), dryTintFrom: Fn(() => vec3(1)),
  };
  const heightMap = createFlatHeightMap(0);
  const grass = createGPUDrivenGrass({ renderer, surface, heightMap, diffuseOnly, backlight });
  return { grass, dispose() { grass.dispose(); heightMap.texture.dispose(); } };
}

test('diffuse A/B changes only grass reflection and retains transmission and shadow reception', () => {
  for (const diffuseOnly of [false, true]) {
    const lawn = build(diffuseOnly);
    try {
      for (const mesh of lawn.grass.group.children) {
        const material = mesh.material;
        assert.equal(Boolean(material.isMeshLambertNodeMaterial), diffuseOnly);
        assert.equal(Boolean(material.isMeshStandardNodeMaterial), !diffuseOnly);
        assert.equal(mesh.receiveShadow, true);
        assert.equal(mesh.castShadow, false);
        assert.equal(material.side, THREE.DoubleSide);
        assert.ok(material.positionNode && material.normalNode && material.colorNode);
        const model = material.setupLightingModel();
        assert.equal(model.diffuseOnly, diffuseOnly);
        assert.equal(model.mode, GRASS_BACKLIGHT.blade);
      }
    } finally { lawn.dispose(); }
  }
  // The underlay constructs the lighting model without the new argument and
  // must retain its current PBR reflection.
  assert.equal(new GrassLightingModel(THREE.TSL.float(1), { mode: 'canopy' }).diffuseOnly, false);
});

test('backlight off remains off with diffuse reflection enabled', () => {
  const lawn = build(true, 'off');
  const original = THREE.PhongLightingModel.prototype.direct;
  let reflectionCalls = 0;
  THREE.PhongLightingModel.prototype.direct = function () {
    assert.equal(this.specular, false);
    reflectionCalls++;
  };
  try {
    for (const mesh of lawn.grass.group.children) {
      const model = mesh.material.setupLightingModel();
      assert.equal(model.mode, GRASS_BACKLIGHT.off);
      // An empty lightData deliberately has no transmission inputs. Only the
      // reflection delegate may run when transmission has been disabled.
      model.direct({}, {});
    }
    assert.equal(reflectionCalls, lawn.grass.group.children.length);
  } finally {
    THREE.PhongLightingModel.prototype.direct = original;
    lawn.dispose();
  }
});
