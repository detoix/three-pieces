import * as THREE from 'three/webgpu';
import { GRASS_RINGS, WORLD_CELL_BIAS, hashUint, worldCellSeed } from './grid.js';

const { Fn, float, hash, select, uint, vec2 } = THREE.TSL;

export const GRASS_BASE_SPACING = GRASS_RINGS[0].spacing;
export const GRASS_BASE_DENSITY = GRASS_RINGS[0].densityNear;

const RETENTION_STEPS = 65_536;
const midDensity = GRASS_RINGS.find(ring => ring.id === 'mid').densityNear;
const farDensity = GRASS_RINGS.find(ring => ring.id === 'far').densityNear;
// Midpoint decoding puts these complete integer cohorts on opposite sides
// of each ownership threshold. Quantizing a continuous rank afterwards can
// otherwise admit a fine-only crown that has no owner in the next ring.
const farEnd = Math.ceil(farDensity / GRASS_BASE_DENSITY * RETENTION_STEPS - .5);
const midEnd = Math.ceil(midDensity / GRASS_BASE_DENSITY * RETENTION_STEPS - .5);

function bucket(seed, salt, count) {
  // WGSL converts the hash to f32 before scaling. Its largest values can
  // round to one, so both implementations clamp to the last valid bucket.
  return Math.min(count - 1,
    Math.floor(Math.fround(Math.fround(hashUint(seed + salt)) * count)));
}

function midCrownCell(x, z) {
  const seed = worldCellSeed(x, z);
  return { x: x * 3 + bucket(seed, 211, 3), z: z * 3 + bucket(seed, 223, 3) };
}

function farMidCell(value) {
  return Math.floor((value * 8 + 4) / 3);
}

/** A coarse allocation selects an existing crown from the finest world grid. */
export function nestedCrownCell(ring, cellX, cellZ) {
  if (ring.id === 'far') return midCrownCell(farMidCell(cellX), farMidCell(cellZ));
  if (ring.id === 'mid') return midCrownCell(cellX, cellZ);
  return { x: cellX, z: cellZ };
}

/** Shared absolute density rank, encoded in the record's existing 16 bits. */
export function crownRetentionWord(fineX, fineZ) {
  const midX = Math.floor(fineX / 3), midZ = Math.floor(fineZ / 3);
  const crown = midCrownCell(midX, midZ);
  let start = midEnd, end = RETENTION_STEPS;
  if (crown.x === fineX && crown.z === fineZ) {
    const farX = Math.floor((midX * 3 + 1.5) / 8);
    const farZ = Math.floor((midZ * 3 + 1.5) / 8);
    const isFar = farMidCell(farX) === midX && farMidCell(farZ) === midZ;
    start = isFar ? 0 : farEnd;
    end = isFar ? farEnd : midEnd;
  }
  return start + bucket(worldCellSeed(fineX, fineZ), 97, end - start);
}

function cellSeedNode(cell) {
  return uint(cell.x.add(WORLD_CELL_BIAS)).mul(uint(1_664_525))
    .add(uint(cell.y.add(WORLD_CELL_BIAS)).mul(uint(1_013_904_223)));
}

function midCrownCellNode(cell) {
  const seed = cellSeedNode(cell);
  const child = vec2(hash(seed.add(uint(211))), hash(seed.add(uint(223))))
    .mul(3).floor().min(vec2(2));
  return cell.mul(3).add(child);
}

function farMidCellNode(cell) {
  return cell.mul(8).add(4).div(3).floor();
}

export function nestedCrownCellNode(ring, cell) {
  if (ring.id === 'far') return midCrownCellNode(farMidCellNode(cell));
  if (ring.id === 'mid') return midCrownCellNode(cell);
  return cell;
}

/** Midpoints round-trip through packAppearance without changing their cohort. */
export const crownRetentionNode = Fn(([fineCell]) => {
  const midCell = fineCell.div(3).floor();
  const midCrown = midCrownCellNode(midCell);
  const isMid = fineCell.x.equal(midCrown.x).and(fineCell.y.equal(midCrown.y));
  const farCell = midCell.mul(3).add(1.5).div(8).floor();
  const farMid = farMidCellNode(farCell);
  const isFar = isMid.and(midCell.x.equal(farMid.x)).and(midCell.y.equal(farMid.y));
  const start = select(isFar, float(0), select(isMid, float(farEnd), float(midEnd)));
  const end = select(isFar, float(farEnd), select(isMid, float(midEnd), float(RETENTION_STEPS)));
  const count = end.sub(start);
  const offset = hash(cellSeedNode(fineCell).add(uint(97)))
    .mul(count).floor().min(count.sub(1));
  return start.add(offset).add(.5).div(RETENTION_STEPS);
});
