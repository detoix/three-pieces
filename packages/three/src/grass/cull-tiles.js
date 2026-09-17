/** Coarse visibility only. The GPU still evaluates every retained crown exactly. */
export const GRASS_CULL_TILE_SIDE = 32;
export const GRASS_CULL_TILE_LANES = GRASS_CULL_TILE_SIDE ** 2;

export function cullTileCapacity(ring) {
  return Math.ceil(ring.side / GRASS_CULL_TILE_SIDE) ** 2;
}

/**
 * Write surviving {cellX, cellZ, width, height} tiles into a persistent vec4
 * buffer. The window is partitioned without duplicates, including its short
 * outer rows/columns. Bounds describe ALL possible crown culling spheres,
 * rather than only roots or actual blade triangles: retaining the exact GPU
 * visible set requires keeping even its conservative edge-of-frustum hits.
 *
 * groundBounds must bound decoded packed heights. marginXZ includes both the
 * maximum sphere radius and the normal-dependent centre displacement;
 * marginBelow/Above bound those same spheres vertically. coverageBounds is an
 * optional UNION of authoritative root-coverage AABBs, never a guessed mask.
 */
export function selectCullTiles(state, {
  camera, planes, groundBounds, marginXZ, marginBelow, marginAbove,
  coverageBounds = null,
}, target) {
  const { ring, originCellX, originCellZ } = state;
  const { side, spacing, inner, outer } = ring;
  if (target.length < cullTileCapacity(ring) * 4) {
    throw new RangeError('Grass tile output must hold the full ring window.');
  }
  let count = 0;
  let changed = false;
  const minY = groundBounds.minimum - marginBelow;
  const maxY = groundBounds.maximum + marginAbove;
  // Both the record coordinates and frustum uniforms are f32 on the GPU.
  // Expand for their rounding rather than rejecting a GPU-accepted boundary
  // due to a stricter f64 CPU calculation, including translated scenes.
  const magnitude = Math.max(1, Math.abs(camera.x), Math.abs(camera.y ?? 0),
    Math.abs(camera.z), Math.abs(minY), Math.abs(maxY),
    Math.abs(originCellX * spacing), Math.abs(originCellZ * spacing),
    Math.abs((originCellX + side) * spacing), Math.abs((originCellZ + side) * spacing));
  const tolerance = 1e-4 + magnitude * 2e-6;
  const outerSquared = (outer + tolerance) ** 2;
  const innerSquared = Math.max(0, inner - tolerance) ** 2;

  for (let row = 0; row < side; row += GRASS_CULL_TILE_SIDE) {
    const height = Math.min(GRASS_CULL_TILE_SIDE, side - row);
    for (let column = 0; column < side; column += GRASS_CULL_TILE_SIDE) {
      const width = Math.min(GRASS_CULL_TILE_SIDE, side - column);
      const cellX = originCellX + column;
      const cellZ = originCellZ + row;
      // Placement jitter stays within its cell (centre .5 +/- .4). Using the
      // whole cell here is deliberately wider and does not need hash samples.
      const x0 = cellX * spacing - tolerance;
      const z0 = cellZ * spacing - tolerance;
      const x1 = (cellX + width) * spacing + tolerance;
      const z1 = (cellZ + height) * spacing + tolerance;
      const nearX = Math.max(x0 - camera.x, 0, camera.x - x1);
      const nearZ = Math.max(z0 - camera.z, 0, camera.z - z1);
      if (nearX * nearX + nearZ * nearZ > outerSquared) continue;
      const farX = Math.max(Math.abs(x0 - camera.x), Math.abs(x1 - camera.x));
      const farZ = Math.max(Math.abs(z0 - camera.z), Math.abs(z1 - camera.z));
      if (farX * farX + farZ * farZ < innerSquared) continue;

      if (coverageBounds) {
        let overlaps = false;
        for (const bounds of coverageBounds) {
          if (x1 >= bounds.minX && x0 <= bounds.maxX && z1 >= bounds.minZ && z0 <= bounds.maxZ) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) continue;
      }

      const bx0 = x0 - marginXZ, bx1 = x1 + marginXZ;
      const bz0 = z0 - marginXZ, bz1 = z1 + marginXZ;
      let outside = false;
      for (const plane of planes) {
        const n = plane.normal;
        // Support point furthest along the plane normal. If even that point
        // is outside, every crown sphere in the tile is outside this plane.
        const distance = n.x * (n.x >= 0 ? bx1 : bx0) +
          n.y * (n.y >= 0 ? maxY : minY) +
          n.z * (n.z >= 0 ? bz1 : bz0) + plane.constant;
        if (distance < -tolerance) { outside = true; break; }
      }
      if (outside) continue;

      const offset = count * 4;
      changed ||= target[offset] !== cellX || target[offset + 1] !== cellZ ||
        target[offset + 2] !== width || target[offset + 3] !== height;
      target[offset] = cellX;
      target[offset + 1] = cellZ;
      target[offset + 2] = width;
      target[offset + 3] = height;
      count++;
    }
  }
  return { count, dispatchCandidates: count * GRASS_CULL_TILE_LANES, changed };
}
