import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as THREE from 'three/webgpu';

import {
  LAWN_PBR_ASSET,
  LAWN_PBR_WORLD_SIZE,
  lawnPBRGPUBytes,
  mipmappedTextureBytes,
  normalizeLawnUnderlay,
} from '../src/grass/surface-assets.js';
import {
  createLawnSurface,
  loadLawnPBRTextures,
} from '../src/grass/surface.js';
import { LAWN } from '../src/grass/preset.js';

function createTestTexture(size) {
  return new THREE.DataTexture(
    new Uint8Array(size * size * 4).fill(128),
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
}

test('the checked-in Grass004 derivatives match their documented metadata', () => {
  assert.equal(LAWN_PBR_ASSET.id, 'Grass004');
  assert.equal(LAWN_PBR_ASSET.license, 'CC0 1.0 Universal');
  assert.equal(LAWN_PBR_WORLD_SIZE, 1.4);

  let encodedBytes = 0;
  for (const map of Object.values(LAWN_PBR_ASSET.maps)) {
    const bytes = readFileSync(new URL(map.url));
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(bytes.length, map.encodedBytes);
    assert.equal(digest, map.sha256);
    encodedBytes += bytes.length;
  }
  assert.equal(encodedBytes, LAWN_PBR_ASSET.encodedBytes);

  const packed = readFileSync(new URL(LAWN_PBR_ASSET.maps.albedoRoughness.url));
  assert.equal(packed.toString('ascii', 0, 4), 'RIFF');
  assert.equal(packed.toString('ascii', 8, 12), 'WEBP');
  assert.ok(
    packed.includes(Buffer.from('ALPH')),
    'roughness must remain packed',
  );

  const normal = readFileSync(new URL(LAWN_PBR_ASSET.maps.normal.url));
  assert.deepEqual(Array.from(normal.subarray(0, 3)), [0xff, 0xd8, 0xff]);
  assert.equal(mipmappedTextureBytes(1024), 5_592_404);
  assert.equal(mipmappedTextureBytes(512), 1_398_100);
  assert.equal(lawnPBRGPUBytes(), 6_990_504);
});

test('live underlay switching retains two textures and two materials', async () => {
  const albedoRoughness = createTestTexture(4);
  const normal = createTestTexture(4);
  const surface = await createLawnSurface({
    renderer: { getMaxAnisotropy: () => 16 },
    underlay: 'solid',
    textures: { albedoRoughness, normal },
  });
  const solidMaterial = surface.solidMaterial;
  const lawnMaterial = surface.lawnMaterial;

  assert.equal(albedoRoughness.colorSpace, THREE.SRGBColorSpace);
  assert.equal(normal.colorSpace, THREE.NoColorSpace);
  for (const texture of [albedoRoughness, normal]) {
    assert.equal(texture.wrapS, THREE.RepeatWrapping);
    assert.equal(texture.wrapT, THREE.RepeatWrapping);
    assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
    assert.equal(texture.magFilter, THREE.LinearFilter);
    assert.equal(texture.generateMipmaps, true);
    assert.equal(texture.anisotropy, 8);
  }
  assert.equal(surface.stats.asset, 'Grass004');
  assert.equal(surface.stats.maps, 2);
  assert.equal(surface.stats.encodedBytes, 615_023);
  assert.equal(surface.stats.gpuBytes, 6_990_504);
  assert.strictEqual(surface.material, solidMaterial);

  assert.equal(surface.setMode('lawn'), 'lawn');
  assert.strictEqual(surface.material, lawnMaterial);
  assert.strictEqual(surface.albedoRoughnessTexture, albedoRoughness);
  assert.strictEqual(surface.normalTexture, normal);
  assert.strictEqual(surface.solidMaterial, solidMaterial);

  assert.equal(surface.setMode('solid'), 'solid');
  assert.strictEqual(surface.material, solidMaterial);
  assert.strictEqual(surface.lawnMaterial, lawnMaterial);

  surface.dispose();
  surface.dispose();
});

test('supplied textures transfer by default and stay with the host when borrowed', async () => {
  const renderer = { getMaxAnisotropy: () => 16 };
  const counted = () => {
    const albedoRoughness = createTestTexture(4);
    const normal = createTestTexture(4);
    const disposals = { count: 0 };
    for (const texture of [albedoRoughness, normal]) {
      texture.addEventListener('dispose', () => { disposals.count += 1; });
    }
    return { textures: { albedoRoughness, normal }, disposals };
  };

  const owned = counted();
  const transferred = await createLawnSurface({ renderer, textures: owned.textures });
  assert.equal(transferred.ownsTextures, true);
  transferred.dispose();
  transferred.dispose();
  assert.equal(owned.disposals.count, 2);

  // Two surfaces over one host-owned pair: neither may release it.
  const shared = counted();
  let materialDisposals = 0;
  const surfaces = [];
  for (let index = 0; index < 2; index += 1) {
    const surface = await createLawnSurface({ renderer, textures: shared.textures, ownTextures: false });
    assert.equal(surface.ownsTextures, false);
    assert.strictEqual(surface.albedoRoughnessTexture, shared.textures.albedoRoughness);
    for (const material of [surface.solidMaterial, surface.lawnMaterial]) {
      material.addEventListener('dispose', () => { materialDisposals += 1; });
    }
    surfaces.push(surface);
  }
  for (const surface of surfaces) surface.dispose();
  assert.equal(shared.disposals.count, 0);
  assert.equal(materialDisposals, 4, 'a borrowing surface still releases its own materials');

  await assert.rejects(
    createLawnSurface({ renderer, textures: counted().textures, ownTextures: 'no' }),
    (error) => error instanceof TypeError && /ownTextures/.test(error.message),
  );
  // Refused before loading: there is no loader here, so reaching the bundled
  // load would fail with a different error.
  await assert.rejects(
    createLawnSurface({ renderer, ownTextures: false }),
    (error) => error instanceof TypeError && /supplied textures/.test(error.message),
  );
});

test('a heightAt surface displaces both ground materials and a flat one builds as before', async () => {
  const renderer = { getMaxAnisotropy: () => 16 };
  const textures = () => ({ albedoRoughness: createTestTexture(4), normal: createTestTexture(4) });
  const heightAt = THREE.TSL.Fn(([worldXZ]) => worldXZ.x.mul(0.1));

  const flat = await createLawnSurface({ renderer, textures: textures() });
  assert.equal(flat.displaced, false);
  assert.equal(flat.lawnMaterial.positionNode, null);
  assert.equal(flat.solidMaterial.isNodeMaterial, undefined, 'the flat control stays a plain material');
  flat.dispose();

  for (const grainStrength of [0, 0.5]) {
    const hills = await createLawnSurface({ renderer, textures: textures(), heightAt, grainStrength });
    assert.equal(hills.displaced, true);
    for (const material of [hills.lawnMaterial, hills.solidMaterial]) {
      assert.equal(material.isNodeMaterial, true);
      assert.equal(material.positionNode?.isNode, true);
      assert.equal(material.normalNode?.isNode, true);
    }
    hills.dispose();
  }

  await assert.rejects(createLawnSurface({ renderer, textures: textures(), heightAt: 1 }), /heightAt/);
  await assert.rejects(createLawnSurface({ renderer, textures: textures(), heightAt, groundNormalStep: 0 }), /groundNormalStep/);
});

test('a partial PBR load failure disposes the map that did load', async () => {
  const fulfilled = createTestTexture(2);
  let disposed = 0;
  fulfilled.addEventListener('dispose', () => {
    disposed += 1;
  });
  const loader = {
    loadAsync(url) {
      return url.endsWith('.webp')
        ? Promise.resolve(fulfilled)
        : Promise.reject(new Error('normal failed'));
    },
  };

  await assert.rejects(loadLawnPBRTextures({ loader }), /normal failed/);
  assert.equal(disposed, 1);
});

