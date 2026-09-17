import * as THREE from 'three/webgpu';

// Level terrain for tests that need a height map and not a landscape.

/** A 2×2 texture at one elevation, as a host with flat turf would build. */
export function createFlatHeightMap(elevation = 0) {
  const texture = new THREE.DataTexture(new Uint16Array(4), 2, 2, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { texture, extent: 130, minimum: elevation, scale: 1,
    packingMinimum: elevation, packingRange: 1, texelWorldSize: 1 };
}

/** A filterable R16F texture of zero heights at `resolution`², over ±`extent` metres. */
export function createFlatHeightTexture({ extent = 130, resolution = 8 } = {}) {
  const texture = new THREE.DataTexture(
    new Uint16Array(resolution * resolution), resolution, resolution,
    THREE.RedFormat, THREE.HalfFloatType,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, extent, minimum: 0, scale: 1, packingMinimum: 0, packingRange: 1,
    texelWorldSize: (extent * 2) / (resolution - 1) };
}
