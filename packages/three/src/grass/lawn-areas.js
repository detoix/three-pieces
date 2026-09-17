import * as THREE from 'three/webgpu';

/**
 * Lawn areas: where a loaded model says grass may grow.
 *
 * A host has a building, a park or a garden exported from somewhere, and wants
 * the lawn on the parts of it that are lawn. That is a selector and a mask:
 * pick the objects, collect their triangles in world space, and hand grass a
 * `keepAt` that tests a blade's root against them.
 *
 * The default selector reads a `landscape` tag from `userData` (glTF `extras`),
 * which is the convention the authoring side of this project writes. Any other
 * convention is one function away -- see `readLawnAreas`.
 *
 * Version 1 is deliberately narrow: static, horizontal surfaces at one
 * elevation. Slopes need grass's procedural height form and stacked lawns need
 * more than one height per point, so both are rejected rather than approximated.
 */
const { Fn, If, bool, float, vec2, textureLevel } = THREE.TSL;

/**
 * The authored tag: `{ version: 1, id, role }` on `userData.landscape`, where
 * the role is `lawn` or its older spelling `turf`. Models already carry the
 * old word, so both are read and neither is rewritten.
 */
export function landscapeLawnTag(object) {
  const definition = object.userData?.landscape;
  if (!definition || (definition.role !== 'lawn' && definition.role !== 'turf')) return false;
  if (definition.version !== 1 || typeof definition.id !== 'string' || !definition.id) {
    throw new Error('Unsupported or invalid lawn metadata.');
  }
  return definition.id;
}

function edge(a, b, x, z) {
  return (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
}
export function triangleContains(triangle, x, z) {
  return triangle.every((a, i) => edge(a, triangle[(i + 1) % 3], x, z) >= 0);
}

/**
 * Collects the lawn areas of a loaded scene, in world space.
 *
 * `select(object)` returns an id for a lawn surface, `true` to use its name, or
 * a falsy value to skip it. It may also throw, which is how the default
 * selector rejects a tag it does not understand rather than ignoring it.
 *
 * @param {THREE.Object3D} root
 * @param {{ select?: (object: THREE.Object3D) => string | boolean }} [options]
 */
export function readLawnAreas(root, { select = landscapeLawnTag } = {}) {
  if (typeof select !== 'function') {
    throw new TypeError('Lawn area select must be a function of an object.');
  }
  root.updateMatrixWorld(true);
  const meshes = [], triangles = [], ids = new Set();
  let elevation;
  root.traverse((node) => {
    const selected = select(node);
    if (!selected) return;
    const id = selected === true ? (node.name || node.uuid) : selected;
    if (typeof id !== 'string' || !id) {
      throw new TypeError('Lawn area select must return an id string or true.');
    }
    if (ids.has(id)) throw new Error(`Duplicate lawn area ID: ${id}`);
    ids.add(id);
    const parts = [];
    node.traverse((part) => { if (part.isMesh) parts.push(part); });
    if (!parts.length) throw new Error(`Lawn area ${id} has no surface mesh.`);
    for (const mesh of parts) {
      if (mesh.isSkinnedMesh || mesh.isInstancedMesh) throw new Error('A lawn area must be a static surface mesh.');
      const position = mesh.geometry.attributes.position;
      const indices = mesh.geometry.index;
      const count = indices ? indices.count : position.count;
      if (count % 3) throw new Error('Lawn area geometry must contain triangles.');
      for (let i = 0; i < count; i += 3) {
        const vertices = [0, 1, 2].map(offset => new THREE.Vector3()
          .fromBufferAttribute(position, indices ? indices.getX(i + offset) : i + offset)
          .applyMatrix4(mesh.matrixWorld));
        for (const vertex of vertices) {
          if (![vertex.x, vertex.y, vertex.z].every(Number.isFinite)) throw new Error('Lawn area coordinates must be finite.');
          elevation ??= vertex.y;
          if (Math.abs(vertex.y - elevation) > 1e-4) throw new Error('Lawn areas version 1 require horizontal surfaces at one elevation.');
        }
        const triangle = vertices.map(v => [v.x, v.z]);
        const area = edge(triangle[0], triangle[1], ...triangle[2]);
        if (Math.abs(area) < 1e-10) continue;
        if (area < 0) triangle.reverse();
        triangles.push(triangle);
      }
      meshes.push(mesh);
    }
  });
  if (ids.size && !triangles.length) throw new Error('Lawn areas have no usable surface.');
  return { meshes, triangles, elevation: elevation ?? 0, ids: [...ids],
    contains: (x, z) => triangles.some(t => triangleContains(t, x, z)) };
}

/** Conservative raster: 255 = fully inside; 128 = exact-test boundary; 0 = outside.
 * Per-triangle interior cells are sufficient; shared diagonals take the exact
 * union path, so triangulation cannot leave seams or bleed over a boundary.
 */
export function bakeLawnCoverage(triangles, resolution = 512) {
  const all = triangles.flat();
  const min = all.length ? [Math.min(...all.map(p => p[0])) - .01, Math.min(...all.map(p => p[1])) - .01] : [0, 0];
  const max = all.length ? [Math.max(...all.map(p => p[0])) + .01, Math.max(...all.map(p => p[1])) + .01] : [1, 1];
  const size = max.map((v, i) => v - min[i]);
  const step = size.map(v => v / resolution);
  const data = new Uint8Array(resolution * resolution);
  for (const triangle of triangles) {
    const low = [0, 1].map(axis => Math.max(0, Math.floor((Math.min(...triangle.map(p => p[axis])) - min[axis]) / step[axis])));
    const high = [0, 1].map(axis => Math.min(resolution - 1, Math.floor((Math.max(...triangle.map(p => p[axis])) - min[axis]) / step[axis])));
    for (let row = low[1]; row <= high[1]; row++) for (let col = low[0]; col <= high[0]; col++) {
      const index = row * resolution + col;
      const x = min[0] + col * step[0], z = min[1] + row * step[1];
      const interior = [[x,z],[x+step[0],z],[x,z+step[1]],[x+step[0],z+step[1]]]
        .every(p => triangleContains(triangle, ...p));
      data[index] = Math.max(data[index], interior ? 255 : 128);
    }
  }
  return { data, min, size, resolution };
}

export function createLawnMask(regions) {
  const baked = bakeLawnCoverage(regions.triangles);
  const texture = new THREE.DataTexture(baked.data, baked.resolution, baked.resolution, THREE.RedFormat);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = 'Authored lawn coverage';
  const keep = Fn(([worldXZ]) => {
    const uv = worldXZ.sub(vec2(...baked.min)).div(vec2(...baked.size));
    const insideBounds = uv.x.greaterThanEqual(0).and(uv.y.greaterThanEqual(0))
      .and(uv.x.lessThan(1)).and(uv.y.lessThan(1));
    const coverage = textureLevel(texture, uv, float(0)).r;
    const accepted = bool(false).toVar();
    If(insideBounds.and(coverage.greaterThan(.75)), () => { accepted.assign(true); })
      .ElseIf(insideBounds.and(coverage.greaterThan(.25)), () => {
        let union = bool(false);
        for (const triangle of regions.triangles) {
          let within = bool(true);
          for (let i = 0; i < 3; i++) {
            const a = triangle[i], b = triangle[(i + 1) % 3];
            const cross = worldXZ.y.sub(a[1]).mul(b[0] - a[0])
              .sub(worldXZ.x.sub(a[0]).mul(b[1] - a[1]));
            within = within.and(cross.greaterThanEqual(0));
          }
          union = union.or(within);
        }
        accepted.assign(union);
      });
    return accepted;
  });
  return { keepAt: worldXZ => keep(worldXZ), dispose: () => texture.dispose(), texture };
}

/**
 * The flat height map grass needs for a lawn at one elevation, in its texture form.
 * `extent` is the half-width of the square it covers; outside it, sampling clamps.
 */
export function createFlatHeightMap(elevation, { extent = 130 } = {}) {
  const texture = new THREE.DataTexture(new Uint16Array(4), 2, 2, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { texture, extent, resolution: 2, minimum: elevation, scale: 1,
    packingMinimum: elevation, packingRange: 1, texelWorldSize: 1 };
}
