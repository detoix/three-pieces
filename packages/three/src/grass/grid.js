/**
 * CPU-side control plane for the camera-centred grass grids.
 *
 * These values describe persistent GPU allocations. Camera movement changes
 * only each grid's integer world-cell origin; it never changes a capacity and
 * never replaces a buffer. Cells address the storage toroidally, so a move
 * updates only newly exposed strips. The shader uses the same integer cells
 * as seeds, so returning to a place returns the same grass.
 */

const RAW_RINGS = [
  {
    id: 'close',
    inner: 0,
    outer: 2,
    spacing: 0.025,
    segments: 3,
    seedIndex: 0,
    densityInner: 0,
    densityOuter: 8,
    densityNear: 1600,
    densityFar: 1 / 0.075 ** 2,
  },
  {
    id: 'near',
    ribbon: true,
    inner: 2,
    outer: 8,
    spacing: 0.025,
    segments: 2,
    seedIndex: 0,
    densityInner: 0,
    densityOuter: 8,
    densityNear: 1600,
    densityFar: 1 / 0.075 ** 2,
  },
  {
    id: 'mid',
    ribbon: true,
    seedIndex: 1,
    inner: 8,
    outer: 24,
    spacing: 0.075,
    segments: 2,
    densityNear: 1 / 0.075 ** 2,
    densityFar: 1 / 0.2 ** 2,
  },
  {
    id: 'far',
    seedIndex: 2,
    inner: 24,
    outer: 52,
    spacing: 0.2,
    segments: 1,
    densityNear: 1 / 0.2 ** 2,
    densityFar: 0,
  },
];

export const RING_SEED_STRIDE = 97_531;

export const WORLD_CELL_BIAS = 1_048_576;

function coveredSide(outer, spacing) {
  // Two spare rows cover the sub-cell remainder while the centre is snapped.
  const side = Math.ceil((outer * 2) / spacing) + 2;
  return side % 2 === 0 ? side : side + 1;
}

export const GRASS_RINGS = Object.freeze(
  RAW_RINGS.map((ring, index) => {
    const side = coveredSide(ring.outer, ring.spacing);
    return Object.freeze({
      ...ring,
      index,
      // Draw order and shape LOD may change without moving crowns or changing
      // their retention lottery. Close/near share one world grid and density
      // curve; only the owner and its blade geometry change at two metres.
      seedIndex: ring.seedIndex ?? index,
      densityInner: ring.densityInner ?? ring.inner,
      densityOuter: ring.densityOuter ?? ring.outer,
      side,
      capacity: side * side,
      candidateDensity: 1 / ring.spacing ** 2,
    });
  }),
);

export const TOTAL_GRASS_CANDIDATES = GRASS_RINGS.reduce(
  (total, ring) => total + ring.capacity,
  0,
);

/**
 * Indices one blade submits, which is what the indirect command carries.
 * Compact ribbons submit two triangles with a fixed four-vertex stride.
 *
 * The tip closes to a point, so the topmost segment is a triangle and not a
 * quad: a quad there spends a second triangle whose two upper vertices
 * coincide, and a zero-area triangle rasterises nothing at any distance.
 */
export function bladeVertexCount(segments, { ribbon = false } = {}) {
  return ribbon ? 6 : segments * 6 - 3;
}

/** Submitted triangles, including a compact young ribbon's collapsed tip. */
export function bladeTriangleCount(segments, { ribbon = false } = {}) {
  return ribbon ? 2 : segments * 2 - 1;
}

/**
 * Triangles the indirect draws submit for a frame's visible crowns.
 *
 * One place, because the HUD used to derive its own and got two things wrong:
 * it multiplied by `segments * 2`, which counts the degenerate tip quad that
 * `bladeVertexCount` drops, and it counted one blade per crown when a crown
 * grows `LAWN.tillers` of them. At three tillers a near crown reports 6
 * triangles where the draw submits 15, so the lawn read as 2.5x cheaper than
 * it is -- which is exactly the number a density experiment is judged on.
 */
export function grassTriangleCount(visible, tillers) {
  return GRASS_RINGS.reduce(
    (total, ring) =>
      total +
      (visible[ring.index] ?? 0) * bladeTriangleCount(ring.segments, ring) * tillers,
    0,
  );
}

export function gridCellAt(value, spacing) {
  return Math.floor(value / spacing);
}

export function createRingState(ring) {
  return {
    ring,
    centreCellX: Number.NaN,
    centreCellZ: Number.NaN,
    originCellX: 0,
    originCellZ: 0,
    updateRects: [],
    updateCount: 0,
    fullRefill: false,
  };
}

/** Mutates an allocation's small control object, never the allocation itself. */
export function snapRingState(state, worldX, worldZ) {
  const { ring } = state;
  const centreCellX = gridCellAt(worldX, ring.spacing);
  const centreCellZ = gridCellAt(worldZ, ring.spacing);
  state.updateRects.length = 0;
  state.updateCount = 0;
  state.fullRefill = false;
  if (centreCellX === state.centreCellX && centreCellZ === state.centreCellZ) {
    return false;
  }

  const dx = centreCellX - state.centreCellX;
  const dz = centreCellZ - state.centreCellZ;
  state.centreCellX = centreCellX;
  state.centreCellZ = centreCellZ;
  state.originCellX = centreCellX - ring.side / 2;
  state.originCellZ = centreCellZ - ring.side / 2;
  const x = state.originCellX;
  const z = state.originCellZ;
  const side = ring.side;
  const addRect = (x, z, width, height) => {
    if (width === 0 || height === 0) return;
    state.updateRects.push({ x, z, width, height });
    state.updateCount += width * height;
  };
  if (!Number.isFinite(dx) || !Number.isFinite(dz) ||
      Math.abs(dx) >= side || Math.abs(dz) >= side) {
    state.fullRefill = true;
    addRect(x, z, side, side);
  } else {
    // The vertical strip owns the diagonal corner; the horizontal strip
    // excludes it, so every new cell is written exactly once.
    const width = Math.abs(dx);
    addRect(dx > 0 ? x + side - width : x, z, width, side);
    addRect(x + (dx < 0 ? width : 0), dz > 0 ? z + side - dz : z,
      side - width, Math.abs(dz));
  }
  return true;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

/** A world cell keeps its physical record slot until it leaves the window. */
export function slotForWorldCell(ring, cellX, cellZ) {
  return positiveModulo(cellZ, ring.side) * ring.side +
    positiveModulo(cellX, ring.side);
}

export function worldCellForSlot(state, slot, target = {}) {
  const column = slot % state.ring.side;
  const row = Math.floor(slot / state.ring.side);
  target.x = state.originCellX +
    positiveModulo(column - state.originCellX, state.ring.side);
  target.z = state.originCellZ +
    positiveModulo(row - state.originCellZ, state.ring.side);
  return target;
}

export function ringDistance(x, z) {
  return Math.hypot(x, z);
}

export function ringOwnsDistance(ring, distance) {
  return distance >= ring.inner && distance < ring.outer;
}

export function ringForDistance(distance) {
  return GRASS_RINGS.find((ring) => ringOwnsDistance(ring, distance)) ?? null;
}

export function targetDensityAt(ring, distance) {
  const inner = ring.densityInner ?? ring.inner;
  const outer = ring.densityOuter ?? ring.outer;
  const span = outer - inner;
  const linear = span > 0 ? (distance - inner) / span : 0;
  const t = Math.min(1, Math.max(0, linear));
  const smooth = t * t * (3 - 2 * t);
  return ring.densityNear + (ring.densityFar - ring.densityNear) * smooth;
}

export function retentionAt(ring, distance) {
  return Math.min(
    1,
    Math.max(0, targetDensityAt(ring, distance) / ring.candidateDensity),
  );
}

/**
 * The same 32-bit composition and PCG hash used by Three's TSL `hash()` node.
 * It is intentionally based on signed world cells converted to uint32.
 */
export function worldCellSeed(cellX, cellZ, salt = 0) {
  return (
    (Math.imul(cellX + WORLD_CELL_BIAS, 1_664_525) +
      Math.imul(cellZ + WORLD_CELL_BIAS, 1_013_904_223) +
      salt) >>>
    0
  );
}

export function hashUint(seed) {
  const state = (Math.imul(seed >>> 0, 747_796_405) + 2_891_336_453) >>> 0;
  const word = Math.imul(
    ((state >>> ((state >>> 28) + 4)) ^ state) >>> 0,
    277_803_737,
  );
  const result = ((word >>> 22) ^ word) >>> 0;
  return result / 4_294_967_296;
}

export function worldCellRandom(cellX, cellZ, salt = 0) {
  return hashUint(worldCellSeed(cellX, cellZ, salt));
}
