/**
 * The blade's centreline, and the sphere that has to contain it.
 *
 * These two are one contract. The vertex stage bends a blade by its own hashed
 * amount; the culling pass bounds it with a sphere that never learns what that
 * amount was. Nothing connects them but arithmetic, and getting it wrong does
 * not throw -- a blade that leaves its sphere is culled while still on screen,
 * which reads as blades winking out at the frame edge on a hard turn.
 *
 * The radius used to be the literal 0.58, correct for one `maxBend` and silently
 * wrong for any other. That was fine while bend was a constant. It stopped
 * being fine the moment bend became a dial, because the failure it produces is
 * invisible from a still frame.
 */

/** Fractions of blade height at `along` (0 root, 1 tip), from the vertex stage.
 *
 *  A constant-curvature arc to second order. Worth knowing where that stops
 *  being true: against an exact arc the reach is within a percent to about
 *  0.6 rad, and over-reaches it by roughly a tenth by 1.1 rad. It over-bends
 *  rather than under-bends, so the bound below stays conservative. */
export function bladeArcAt(bend, along) {
  return {
    rise: along - (bend * bend * along ** 3) / 6,
    reach: (bend * along * along) / 2,
  };
}

/** Where the culling sphere sits, up the ground normal, in blade heights. */
export const BLADE_CULL_CENTRE = 0.5;

/** Margin over the measured worst case, for the quantization and the slope. */
const CULL_MARGIN = 1.1;

/**
 * Sphere radius in blade heights, for a given hardest bend.
 *
 * Measured along the arc rather than taken at the tip: at small bends the
 * furthest point from the sphere's centre is the tip, but the centre sits half
 * way up, so the root competes with it and the maximum is not always at either
 * end.
 *
 * At the shipped `maxBend` of 0.55 this returns 0.5797, which is the 0.58 the
 * pass carried as a literal -- the derivation reproduces the constant rather
 * than replacing it.
 */
export function bladeCullRadiusFactor(maxBend, samples = 512) {
  let worst = 0;
  for (let index = 0; index <= samples; index += 1) {
    const along = index / samples;
    const { rise, reach } = bladeArcAt(maxBend, along);
    worst = Math.max(worst, Math.hypot(reach, rise - BLADE_CULL_CENTRE));
  }
  return worst * CULL_MARGIN;
}
