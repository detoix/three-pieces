// The scalar contract for how a cloud sample is lit. `clouds.js` transcribes
// `cloudInScattering` into TSL term for term; when the two disagree this side
// is right, because it is the one `node --test` can read.

import { ATMOSPHERE } from './atmosphere.js';

const ISOTROPIC = 1 / (4 * Math.PI);

export const CLOUD_LIGHTING = Object.freeze({
  /** Dual Henyey-Greenstein single scattering: a strong forward lobe for the
   *  silver lining and a weak back lobe, weighted 0.8 / 0.2. */
  forwardG: 0.65,
  backG: -0.2,
  forwardWeight: 0.8,
  /** Multiple scattering. Cloud droplets barely absorb, so light that has
   *  scattered more than once does not die off like the direct beam: it
   *  diffuses through, falling off algebraically, as `1 / (1 + falloff tau)`,
   *  the shape of slab transmission. That is what keeps a cloud's shaded side
   *  grey instead of handing it to the blue sky ambient, which is what an
   *  exponential in the optical depth to the sun did: a single far sun sample
   *  inside another cloud stamped a dark blue patch.
   *
   *  The slab law's own coefficient, about `0.75 (1 - g)` for droplets, is
   *  near 0.1; at that, the shaded cores of clouds seen toward the sun were
   *  as bright as their edges. 1.2 is set against photographs: ten
   *  fair-weather cumulus from Wikimedia Commons (listed in
   *  `docs/measuring.md`) measure, pooled, a 10th-to-90th-percentile luma
   *  ratio of 0.69 and median saturation 0.08 through the same classifier
   *  (`measure-photos.mjs`). The render measured 0.77 and 0.07 at 0.4, and
   *  0.74 and 0.10 at 1.2, at the sky's default coverage; 0.8 and 1.6 moved
   *  the ratio no further. The rest of the gap is the undersides this sky's
   *  clouds do not yet have. 0.4 had been chosen to keep the page's earlier
   *  look, not a real sky's. */
  msFalloff: 1.2,
  /** How much multiply scattered sunlight a sample carries, relative to the
   *  sun, and its phase: isotropic, because it has forgotten its direction. A
   *  forward-leaning lobe (g 0.2-0.35 was tried) lit the faces seen toward the
   *  sun as brightly as the ones seen away from it. */
  msWeight: 2.2,
  msG: 0,
  /** "Powder": a thin fringe has had few scattering events, so seen from the
   *  sun's side it is darker than the dense body behind it, which is what
   *  draws the creases between billows. `powder` is how fast density fills
   *  that in; `powderStrength` how much of the darkening a view directly
   *  away from the sun gets. Toward the sun the fringe is the silver lining
   *  and no darkening applies. */
  powder: 2,
  powderStrength: 0.7,
  /** Ambient. Tops see the sky, bases see the sunlit lawn below: the blue
   *  hemisphere alone would paint every base blue. The ground term is the
   *  same lawn albedo the atmosphere's multiple scattering bounces off, lit by
   *  the sun and sky, and cut to a quarter for the shadow the cloud field
   *  itself casts on the ground it looks down at. */
  skyAmbientBase: 0.2,
  skyAmbientTop: 0.8,
  groundAlbedo: ATMOSPHERE.groundAlbedo,
  groundShadow: 0.25,
});

export function phaseHG(mu, g) {
  return ((1 - g * g) * ISOTROPIC) / Math.max(0.001, 1 + g * g - 2 * g * mu) ** 1.5;
}

/** The dual-lobe single-scattering phase for a view-sun cosine `mu`. */
export function cloudPhase(mu) {
  const L = CLOUD_LIGHTING;
  return phaseHG(mu, L.forwardG) * L.forwardWeight + phaseHG(mu, L.backG) * (1 - L.forwardWeight);
}

/** The multiple-scattering phase, already multiplied by its weight. */
export function cloudMultiPhase(mu) {
  const L = CLOUD_LIGHTING;
  return (ISOTROPIC * 0.5 + phaseHG(mu, L.msG) * 0.5) * L.msWeight;
}

/** Sunlight scattered toward the eye per unit sun, before colour. */
export function cloudSunScattering({ opticalDepth, density, mu }) {
  const L = CLOUD_LIGHTING;
  const beer = Math.exp(-opticalDepth);
  const diffuse = 1 / (1 + L.msFalloff * opticalDepth);
  const away = (1 - mu) * 0.5;
  const powder = 1 - Math.exp(-L.powder * density);
  const darkening = 1 + (powder - 1) * away * L.powderStrength;
  return (beer * cloudPhase(mu) + diffuse * cloudMultiPhase(mu)) * darkening;
}

/** Radiance the lawn below sends up at a cloud base, per channel. */
export function cloudGroundBounce({ sun, sky, sunHeight }) {
  const L = CLOUD_LIGHTING;
  return L.groundAlbedo.map((albedo, channel) =>
    (albedo * (sun[channel] * Math.max(0, sunHeight) + sky[channel]) * L.groundShadow) / Math.PI);
}

/** Ambient radiance at normalized layer height `height` (0 base, 1 top). */
export function cloudAmbient({ sky, ground, height }) {
  const L = CLOUD_LIGHTING;
  const h = Math.min(1, Math.max(0, height));
  const skyScale = L.skyAmbientBase + (L.skyAmbientTop - L.skyAmbientBase) * h;
  return sky.map((value, channel) => value * skyScale + ground[channel] * (1 - h));
}

/**
 * Source radiance of one cloud sample, per unit extinction, before exposure:
 * sunlight scattered toward the eye plus the ambient it sits in. `sunUp` fades
 * the direct term out as the sun sets.
 */
export function cloudInScattering({ opticalDepth, density, mu, height, sun, sky, sunHeight, sunUp = 1 }) {
  const scattered = cloudSunScattering({ opticalDepth, density, mu }) * sunUp;
  const ambient = cloudAmbient({ sky, ground: cloudGroundBounce({ sun, sky, sunHeight }), height });
  return sun.map((value, channel) => value * scattered + ambient[channel]);
}
