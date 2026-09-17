import * as THREE from 'three/webgpu';
import { GRASS_RINGS, ringForDistance, targetDensityAt } from './grid.js';

const { Fn, float, mix, select, smoothstep } = THREE.TSL;

// A/B thresholds, in actual framebuffer pixels. Use the real blade width,
// before the geometry's minimum-pixel widening: that widening stabilizes a
// silhouette, but does not make omitted lawn detail resolvable again.
export const CANOPY_RESOLVED_PIXELS = 1.3;
export const CANOPY_UNRESOLVED_PIXELS = 0.35;
export const CANOPY_DETAIL = 0.65;
export const CANOPY_NORMAL_DETAIL = 0.12;

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Scalar reference: missing near-field geometry and subpixel blades both
 * require a canopy underlay. The maximum avoids counting the same loss twice.
 * Positive viewDepth measures perspective depth, not horizontal distance.
 */
export function canopyWeightAt({ horizontalDistance, viewDepth, bladeWidth, pixelScale }) {
  const ring = ringForDistance(horizontalDistance);
  const density = ring ? targetDensityAt(ring, horizontalDistance) : 0;
  const missing = 1 - density / GRASS_RINGS[0].densityNear;
  const pixels = bladeWidth / Math.max(viewDepth * pixelScale, 1e-8);
  const unresolved = 1 - smooth(CANOPY_UNRESOLVED_PIXELS, CANOPY_RESOLVED_PIXELS, pixels);
  return Math.max(missing, unresolved);
}

export const canopyWeightNode = Fn(([horizontalDistance, viewDepth, bladeWidth, pixelScale]) => {
  let density = float(0);
  for (let i = GRASS_RINGS.length - 1; i >= 0; i--) {
    const ring = GRASS_RINGS[i];
    const localDensity = mix(float(ring.densityNear), float(ring.densityFar),
      smoothstep(float(ring.densityInner), float(ring.densityOuter), horizontalDistance));
    density = select(horizontalDistance.lessThan(ring.outer), localDensity, density);
  }
  const missing = density.div(GRASS_RINGS[0].densityNear).oneMinus();
  const pixels = bladeWidth.div(viewDepth.mul(pixelScale).max(1e-8));
  const unresolved = smoothstep(float(CANOPY_UNRESOLVED_PIXELS),
    float(CANOPY_RESOLVED_PIXELS), pixels).oneMinus();
  return missing.max(unresolved);
});
