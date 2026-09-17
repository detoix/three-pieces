import * as THREE from 'three/webgpu';

import { LAWN, LAWN_COLORS } from './preset.js';

const { color, float, normalView, positionViewDirection } = THREE.TSL;

/** Floor on the cosine inside the Beer-Lambert exponent.
 *
 *  The path through a sheet is its thickness over the cosine, which diverges
 *  as the light goes edge-on. The linear factor in front already takes the
 *  term to zero there, so this only keeps the division finite: at 0.02 the
 *  exponent is -12.5 and the shader never has to rely on `exp(-inf)` being
 *  exactly zero under whatever fast-math the driver applies. */
const GRAZING_FLOOR = 0.02;

/** How the blades are allowed to transmit light. */
export const GRASS_BACKLIGHT = Object.freeze({
  /** Gated on the blade's own normal. The default. */
  blade: 'blade',
  /** The shipped view-only lobe, kept as the A/B control. */
  view: 'view',
  /** No transmission at all: the stock `PhysicalLightingModel`. */
  off: 'off',
  /** The far field's aggregate, for the underlay standing in for grass.
   *
   *  The same view lobe as `view`, and here it is the *correct* model rather
   *  than the discarded one. A blade you can resolve has one normal, so the
   *  honest question is whether the sun is behind that blade. A canopy you
   *  cannot resolve has every normal at once, so some fraction of it is always
   *  backlit and the only thing that decides how much of that reaches the eye
   *  is where the eye is. The two disagree because they are at different
   *  scales, not because one is wrong. */
  canopy: 'canopy',
});

/**
 * The term as it shipped, frozen so the control cannot drift with the dials.
 *
 * `LAWN.backscatter` and `LAWN.backscatterPower` moved when the term was
 * rewritten -- the gate costs it most of its range, so the coefficient had to
 * rise to compensate. Reading the control off those would compare the new
 * shape at the new strength against the new shape at the new strength, which
 * is not a control.
 */
const SHIPPED_BACKLIGHT = Object.freeze({ strength: 0.55, power: 4 });

/** @param {string|boolean} value @returns {string} a `GRASS_BACKLIGHT` mode */
export function normalizeBacklight(value) {
  if (value === false || value === GRASS_BACKLIGHT.off)
    return GRASS_BACKLIGHT.off;
  if (value === GRASS_BACKLIGHT.view) return GRASS_BACKLIGHT.view;
  return GRASS_BACKLIGHT.blade;
}

/**
 * The lawn's lighting, which is the standard one plus the light that comes
 * *through* a blade.
 *
 * A grass blade is a fraction of a millimetre of translucent tissue. Lit from
 * behind it does not go dark, it lights up -- that is most of what a lawn
 * looks like into the sun, and a purely reflective model cannot produce it at
 * any roughness. This adds the missing term and nothing else: everything
 * reflective is `PhysicalLightingModel`'s by default. The grass-only
 * `diffuseOnly` A/B uses Lambert reflection while retaining transmission.
 *
 * Four things make it a transmission term rather than green paint:
 *
 * - **It is gated on the blade, not on the camera.** The question asked first
 *   is `-dot(N, L)`: is the light arriving at the face of *this blade* that
 *   the eye cannot see? The normal it asks with is the blade's own splayed,
 *   leaned facing with `negateOnBackSide` already applied, so it faces the eye
 *   and a negative dot is a blade the sun is behind.
 *
 *   It is handed in rather than read off `normalView`, and that is
 *   load-bearing. `normalView` is the *shading* normal, which `grass.js` pulls
 *   toward the ground's with distance so that a patch of unresolved blades
 *   averages into a canopy instead of a bright slab beside a dark one. A
 *   normal tipped up towards the sky has no back face for a high sun to be
 *   behind, so gating on it would answer "front-lit" for the whole lawn and
 *   quietly delete this term at exactly the distances the pull is strongest.
 *
 *   This term used to be `pow(dot(-lightDirection, viewDirection), 4)` alone,
 *   and that is a different question: is the *camera* pointing into the sun.
 *   For a directional light both of those vectors are shared by the whole
 *   lawn, so a yaw turned every lit tip on screen up or down together, as one
 *   coherent sheet, rather than lighting the blades the sun happened to be
 *   behind. A hundred thousand blades with a hundred thousand headings should
 *   average into a canopy, not switch.
 * - **It absorbs.** `backscatterAbsorb` carries Beer-Lambert over the slanted
 *   path, so a blade edge-on to the sun goes dark instead of merely dim. That
 *   is the part that reads as tissue.
 * - **It is strongest at the tip.** A blade thickens towards the sheath and
 *   stands in more of its neighbours down there, so the bottom transmits
 *   almost nothing. That is also where `LAWN.rootOcclusion` is darkest, and
 *   the two have to agree or the blade glows exactly where it was occluded.
 * - **It is shadow-aware, and gets that for free.** `lightColor` arriving at
 *   `direct()` has already been multiplied by the light's shadow node --
 *   `AnalyticLightNode.setupShadow()` does it before the lighting model ever
 *   runs -- so multiplying by it suppresses the term inside shadow with no
 *   shadow lookup of this material's own. That is the whole reason this is a
 *   lighting model and not an `emissiveNode`: an emissive term would keep
 *   glowing under a tree, at night, and on the shadowed side of a hill.
 *
 * The camera has not dropped out of it. Tissue scatters forward, so a backlit
 * blade really is brighter seen towards the light -- `backscatterView` is how
 * much of the term that lobe carries, and the rest survives at any view angle.
 */
export class GrassLightingModel extends THREE.PhysicalLightingModel {
  /**
   * @param {Node} bladeGradient Blade-local height, 0 at the root and 1 at the
   *   tip. Per ring, because each ring's material carries its own varying.
   * @param {object} [options]
   * @param {'blade'|'view'} [options.mode] `blade` gates the term on this
   *   blade's own normal. `view` is the shipped term, kept as the A/B control:
   *   the view lobe alone, at the coefficients it shipped with. Without it the
   *   only control is no transmission at all, which cannot answer whether the
   *   rewrite was an improvement -- only whether the term exists.
   * @param {string} [options.backlightColor] The green a blade takes out of
   *   the light on the way through. Passed in rather than read from the
   *   preset, because `?lawnhue=` rotates the whole palette and a transmitted
   *   green that stayed put would drift off the blade carrying it.
   * @param {Node} [options.bladeNormalView] The blade's own facing in view
   *   space, flipped to the eye. Defaults to `normalView`, which is the same
   *   vector only while nothing has pulled the shading normal off the blade.
   */
  constructor(bladeGradient, { mode, backlightColor, bladeNormalView, diffuseOnly = false } = {}) {
    super();
    this.bladeGradient = bladeGradient;
    this.mode = mode ?? GRASS_BACKLIGHT.blade;
    this.backlightColor = backlightColor ?? LAWN_COLORS.backlight;
    this.bladeNormalView = bladeNormalView ?? normalView;
    this.diffuseOnly = diffuseOnly;
    // PhongLightingModel(false) is Three's Lambert implementation. Its
    // direct() checks this flag when called with this lighting-model object.
    this.specular = false;
  }

  start(builder) {
    // Bypass the physical model's setup and finishing hooks as well as its
    // BRDF; setting specular intensity to zero would still build that work.
    if (this.diffuseOnly) THREE.LightingModel.prototype.start.call(this, builder);
    else super.start(builder);
  }

  indirect(builder) {
    if (this.diffuseOnly) THREE.PhongLightingModel.prototype.indirect.call(this, builder);
    else super.indirect(builder);
  }

  finish(builder) {
    if (this.diffuseOnly) THREE.PhongLightingModel.prototype.finish.call(this, builder);
    else super.finish(builder);
  }

  directRectArea(lightData, builder) {
    // Match MeshLambertNodeMaterial's light support in the A/B mode; do not
    // accidentally retain PhysicalLightingModel's area-light GGX path.
    if (this.diffuseOnly) THREE.PhongLightingModel.prototype.directRectArea.call(this, lightData, builder);
    else super.directRectArea(lightData, builder);
  }

  direct(lightData, builder) {
    if (this.diffuseOnly) THREE.PhongLightingModel.prototype.direct.call(this, lightData, builder);
    else super.direct(lightData, builder);

    if (this.mode === GRASS_BACKLIGHT.off) return;

    const { lightDirection, lightColor, reflectedLight } = lightData;

    // How much of this light is travelling towards the eye. Shared by the
    // whole lawn under a directional sun, which is the point of the control
    // and the fault in the shipped term.
    const forwardScatter = lightDirection
      .negate()
      .dot(positionViewDirection)
      .clamp(0, 1);

    if (this.mode === GRASS_BACKLIGHT.canopy) {
      // `weight` is the canopy proxy: 0 where the ground is ground and 1 where
      // the underlay is the whole lawn. Without it the soil at your feet would
      // transmit light, which is the one thing this term must never do.
      reflectedLight.directDiffuse.addAssign(
        lightColor
          .mul(color(this.backlightColor))
          .mul(forwardScatter.pow(float(LAWN.canopyBacklightPower)))
          .mul(this.bladeGradient.clamp(0, 1))
          .mul(float(LAWN.canopyBacklight)),
      );
      return;
    }

    if (this.mode === GRASS_BACKLIGHT.view) {
      reflectedLight.directDiffuse.addAssign(
        lightColor
          .mul(color(this.backlightColor))
          .mul(forwardScatter.pow(float(SHIPPED_BACKLIGHT.power)))
          .mul(
            this.bladeGradient.clamp(0, 1).smoothstep(LAWN.backscatterTip, 1),
          )
          .mul(float(SHIPPED_BACKLIGHT.strength)),
      );
      return;
    }

    // Is this light behind this blade? `lightDirection` points from the
    // surface towards the light and the blade's own normal faces the eye, so a
    // negative dot is light entering the face the eye cannot see.
    const backIncidence = this.bladeNormalView
      .dot(lightDirection)
      .negate()
      .clamp(0, 1)
      .toVar('bladeBackIncidence');

    // What survives the crossing: the cosine of the entering flux, times
    // Beer-Lambert over a path of thickness/cosine.
    const transmittance = backIncidence.mul(
      backIncidence
        .max(GRAZING_FLOOR)
        .reciprocal()
        .mul(-LAWN.backscatterAbsorb)
        .exp(),
    );

    // Forward scattering. A modifier on the term rather than its existence
    // condition: `1 - backscatterView` of it is there whatever the camera is
    // doing, which is what stops the lawn changing character with yaw.
    const viewGain = float(1 - LAWN.backscatterView).add(
      forwardScatter
        .pow(float(LAWN.backscatterPower))
        .mul(float(LAWN.backscatterView)),
    );

    // Thin tissue only. Held to zero across the base, where the blade is thick
    // and `rootOcclusion` is darkest.
    const thinness = this.bladeGradient
      .clamp(0, 1)
      .smoothstep(LAWN.backscatterTip, 1);

    reflectedLight.directDiffuse.addAssign(
      lightColor
        .mul(color(this.backlightColor))
        .mul(transmittance)
        .mul(viewGain)
        .mul(thinness)
        .mul(float(LAWN.backscatter)),
    );
  }
}
