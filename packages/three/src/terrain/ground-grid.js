/**
 * A flat XZ grid that the lawn surface lifts onto the hills on the GPU.
 *
 * One mesh, centred on the camera and snapped so it never swims. Its vertex
 * spacing grows with distance -- each axis is `radius * (c*s + (1-c)*s^3)` over
 * `s` in [-1, 1] -- which keeps half-metre cells under the grass, where the
 * blades read the exact height and a coarse ground would float or bury them,
 * while the same vertex budget still reaches the horizon. A single grid has no
 * seams between levels, which nested rings would need skirts to hide.
 */

/** Grid coordinate for sample `index` of `segments + 1` along one axis. */
export function groundAxisAt(index, { radius, segments, innerSpacing }) {
  const s = (index / segments) * 2 - 1;
  const linear = groundLinearShare({ radius, segments, innerSpacing });
  return radius * (linear * s + (1 - linear) * s * s * s);
}

/** The linear share of the axis curve that gives `innerSpacing` at the centre. */
export function groundLinearShare({ radius, segments, innerSpacing }) {
  const linear = (innerSpacing * segments) / (2 * radius);
  if (!(linear > 0 && linear <= 1)) {
    throw new RangeError(
      'Ground inner spacing must be positive and no coarser than a uniform grid over the radius.',
    );
  }
  return linear;
}

/** Positions (y = 0) and triangle indices for the grid, as typed arrays. */
export function createGroundGridArrays({ radius = 1500, segments = 384, innerSpacing = 0.5 } = {}) {
  if (!Number.isInteger(segments) || segments < 2 || segments % 2) {
    throw new RangeError('Ground segments must be an even whole number of at least 2.');
  }
  const options = { radius, segments, innerSpacing };
  const axis = Float32Array.from({ length: segments + 1 }, (_, index) => groundAxisAt(index, options));
  const side = segments + 1;
  const positions = new Float32Array(side * side * 3);
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const offset = (row * side + column) * 3;
      positions[offset] = axis[column];
      positions[offset + 2] = axis[row];
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let cursor = 0;
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const a = row * side + column;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      // Counter-clockwise seen from +Y, so the ground's front face is up.
      indices.set([a, c, b, b, c, d], cursor);
      cursor += 6;
    }
  }
  return { positions, indices, axis };
}

/** Where the grid's centre goes for a camera at (x, z): the nearest multiple of the snap step. */
export function snapGroundCentre(x, z, step) {
  return [Math.round(x / step) * step, Math.round(z / step) * step];
}

export function createHillsGroundMesh(THREE, { material, radius = 1500, segments = 384, innerSpacing = 0.5, heightBounds } = {}) {
  const { positions, indices } = createGroundGridArrays({ radius, segments, innerSpacing });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const normals = new Float32Array(positions.length);
  for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The CPU never sees the displaced surface, so give three a bound that holds it.
  const halfHeight = Math.max(Math.abs(heightBounds?.minimum ?? 0), Math.abs(heightBounds?.maximum ?? 0));
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-radius, -halfHeight, -radius),
    new THREE.Vector3(radius, halfHeight, radius),
  );
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(radius, radius, halfHeight));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Hills ground';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return {
    mesh,
    follow(camera) {
      const [x, z] = snapGroundCentre(camera.position.x, camera.position.z, innerSpacing);
      if (mesh.position.x !== x || mesh.position.z !== z) {
        mesh.position.set(x, 0, z);
        mesh.updateMatrixWorld(true);
      }
    },
    dispose() {
      geometry.dispose();
    },
  };
}
