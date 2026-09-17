import * as THREE from 'three/webgpu';

import { LAWN } from './preset.js';

// Finish before the 2 m ownership boundary, including cull-centre hysteresis
// and the maximum tiller root offset. Horizontal distance follows the live eye.
export const CLOSE_RIBBON_MORPH_FROM = 1.2;
export const CLOSE_RIBBON_MORPH_TO = 1.8;

/** Vertices per tiller, unchanged by the clipped or pointed blade profile. */
export function bladeUniqueVertexCount(segments, { ribbon = false } = {}) {
  return ribbon ? 4 : segments * 2 + 1;
}

function pushPointedBlade(positions, indices, segments, base) {
  for (let row = 0; row < segments; row += 1) {
    const y = row / segments;
    const half = (1 - y) ** LAWN.taper * 0.5;
    positions.push(-half, y, 0, half, y, 0);
  }
  positions.push(-0, 1, 0);
  for (let segment = 0; segment < segments; segment += 1) {
    const left = base + segment * 2;
    indices.push(left, left + 1, left + 2);
    if (segment < segments - 1) {
      indices.push(left + 1, left + 3, left + 2);
    }
  }
}

function pushCompactRibbon(positions, indices, base, tiller, mown) {
  // Keep the same root and cut-tip widths as the curved mown blade. Between
  // them, this LOD uses one straight span on each side. The young leaf keeps
  // its pointed tip as two coincident vertices, preserving a fixed stride.
  const clipped = mown && tiller % 4 !== 3;
  const retainedLength = [0.68, 0.74, 0.8][tiller % 3];
  const tipHalf = clipped ? (1 - retainedLength) ** LAWN.taper * 0.5 : 0;
  positions.push(-0.5, 0, 0, 0.5, 0, 0, -tipHalf, 1, 0, tipHalf, 1, 0);
  indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
}

function pushMownBlade(positions, indices, segments, base, tiller) {
  // A clipped leaf retains width at the cut. These are portions of the same
  // tapered leaf, rescaled to the existing authored height; no blade grows.
  const retainedLength = [0.68, 0.74, 0.8][tiller % 3];
  const halfWidth = (y) => (1 - y * retainedLength) ** LAWN.taper * 0.5;
  // Sampling one edge once fewer than the other gives the cut TWO vertices
  // without adding one. Near: four left + three right, five triangles; mid:
  // three left + two right, three triangles. Zipper them in increasing height
  // so the interior has neither a hole nor overlapping triangles.
  for (let row = 0; row <= segments; row += 1) {
    const y = row / segments;
    positions.push(-halfWidth(y), y, 0);
  }
  const rightBase = base + segments + 1;
  for (let row = 0; row < segments; row += 1) {
    const y = row / (segments - 1);
    positions.push(halfWidth(y), y, 0);
  }
  let left = 0;
  let right = 0;
  while (left < segments || right < segments - 1) {
    const nextLeft = left < segments ? (left + 1) / segments : Infinity;
    const nextRight = right < segments - 1 ? (right + 1) / (segments - 1) : Infinity;
    if (nextLeft <= nextRight) {
      indices.push(base + left, rightBase + right, base + left + 1);
      left += 1;
    } else {
      indices.push(base + left, rightBase + right, rightBase + right + 1);
      right += 1;
    }
  }
}

/**
 * Short mown ribbons, with one pointed young leaf per four tillers.
 *
 * Keep tillers separate even though their local positions coincide: the vertex
 * shader derives the tiller from vertexIndex and gives each one its own bend,
 * heading and crown offset. Sharing across tillers would erase that variation.
 * With ribbon=false the triangle/vertex counts match the pointed control.
 * Compact ribbons use four vertices and two submitted triangles per tiller;
 * the pointed leaf's coincident tips make its second triangle degenerate.
 * The far LOD keeps its single unresolved triangle. Pass { mown: false } for
 * the original pointed profile when comparing appearance at fixed geometry cost.
 */
export function createBladeGeometry(segments, tillers, { mown = true, ribbon = false, morphToRibbon = false } = {}) {
  const positions = [];
  const indices = [];
  const ribbonShapes = [];
  const verticesPerTiller = bladeUniqueVertexCount(segments, { ribbon });
  for (let tiller = 0; tiller < tillers; tiller += 1) {
    const base = tiller * verticesPerTiller;
    if (ribbon) {
      pushCompactRibbon(positions, indices, base, tiller, mown);
    } else if (mown && segments > 1 && tiller % 4 !== 3) {
      pushMownBlade(positions, indices, segments, base, tiller);
    } else {
      pushPointedBlade(positions, indices, segments, base);
    }
    if (morphToRibbon) {
      // Derive the target from THIS leaf's cut/pointed tip. The close and near
      // meshes share tiller identity, so this exactly matches the near ribbon.
      let tipHalf = 0;
      for (let vertex = base; vertex < base + verticesPerTiller; vertex++) {
        if (positions[vertex * 3 + 1] === 1) tipHalf = Math.max(tipHalf, Math.abs(positions[vertex * 3]));
      }
      for (let vertex = base; vertex < base + verticesPerTiller; vertex++) {
        const sign = Math.sign(positions[vertex * 3]);
        const along = positions[vertex * 3 + 1];
        const tipSplay = sign * tipHalf * 2 * LAWN.normalSpread;
        // x: straight ribbon width coordinate; yzw: endpoint normal factors.
        // Precompute fixed splay trig once, keeping this close-only morph cheap.
        ribbonShapes.push(sign * (.5 * (1 - along) + tipHalf * along),
          Math.sin(sign * LAWN.normalSpread), Math.cos(tipSplay), Math.sin(tipSplay));
      }
    }
  }

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
  if (morphToRibbon) geometry.setAttribute('grassRibbonShape',
    new THREE.Float32BufferAttribute(ribbonShapes, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
