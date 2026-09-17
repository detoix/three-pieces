import * as THREE from 'three/webgpu';

/** Four aligned vec4s, without quantizing the original shader's outputs. */
export const GRASS_POSE_FLOATS = 16;
export const GRASS_POSE_BYTES = GRASS_POSE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
export const GrassBladePose = THREE.TSL.struct({
  baseHeight: 'vec4',
  forwardWidth: 'vec4',
  sideBend: 'vec4',
  normalDry: 'vec4',
}, 'GrassBladePose');
if (GrassBladePose.getLength() !== GRASS_POSE_FLOATS) {
  throw new Error('Grass pose cache must have a 64-byte array stride.');
}

// Near + mid share an 8 MiB ceiling, including when the tiller dial changes.
// Four tillers yield 24,576 near and 8,192 mid crowns. Close/far stay analytic.
const CACHE_BYTES = Object.freeze({ near: 6 * 1024 * 1024, mid: 2 * 1024 * 1024 });
export function poseCrownCapacity(ring, tillers) {
  if (!Number.isInteger(tillers) || tillers < 1) throw new RangeError('Pose cache needs whole tillers.');
  return Math.min(ring.capacity, Math.floor((CACHE_BYTES[ring.id] ?? 0) / (GRASS_POSE_BYTES * tillers)));
}
