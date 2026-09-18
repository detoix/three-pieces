import * as THREE from 'three/webgpu';

// The sky's lighting probe carried onto a directional light and a hemisphere
// light, calibrated so the grass palette (`LAWN_TARGET_HUE`) renders as it was
// measured. Hosts that light their scene some other way do not need this file.

/**
 * The lights the lawn was calibrated under, and the two numbers that let the
 * atmosphere take them over without re-exposing the image.
 *
 * The sky's lighting probe reports the sun's beam and the hemisphere's
 * irradiance in the model's own units, where the sun above the atmosphere is
 * 1. Handing those to the lights directly would be the physically coherent
 * thing and it is not what happens here, because the scene is not physically
 * balanced to begin with: measured off the probe, a real sun at this elevation
 * delivers 10.2 times the irradiance of its own sky onto flat ground, and
 * these two lights deliver 1.34. Adopting the real ratio deepens every shadow
 * by a factor of seven and moves the lawn's backlight, canopy and occlusion
 * calibrations along with its hue. That is a separate change.
 *
 * So each light is anchored instead: its **colour** comes from the atmosphere
 * at whatever elevation the sun is at, and its **luminance** is scaled so that
 * at the shipped 49.1 degrees it reproduces exactly what was authored. The
 * anchors are that scale, measured off the probe --
 *
 *   sun   authored (3.2000, 2.7884, 1.9536), luminance 2.8156
 *         probe    (0.9230, 0.8304, 0.7004), luminance 0.84070
 *   sky   authored (1.3718, 1.5379, 1.3059), luminance 1.4859
 *         probe    (0.0314, 0.0646, 0.1270), luminance 0.06205
 *
 * -- so the sun's warmth and the sky's blue are now the air's rather than an
 * author's, the ratio between them stays where it was, and `?sunelevation=`
 * dims and reddens both the way the sky above them does.
 *
 * `test/sky-atmosphere.test.js` holds the two authored luminances, so changing
 * `#fff0cd` or 3.2 fails there and points back at this comment rather than
 * silently re-anchoring the lights.
 */
export const AUTHORED_SUN = {
  color: '#fff0cd',
  intensity: 3.2,
  luminance: 2.8156,
};
export const AUTHORED_SKY = {
  color: '#e8f4e3',
  ground: '#26331e',
  intensity: 1.7,
  luminance: 1.4859,
};
export const SUN_ANCHOR = 3.3491;
export const SKY_ANCHOR = 23.947;

/** Relative luminance of a linear RGB triple. */
export function relativeLuminance([red, green, blue]) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Points the two lights at what the sky says, anchored.
 *
 * Both carry their magnitude in the colour and keep `intensity` at 1, because
 * three gives a hemisphere light one intensity for two colours and the ground
 * bounce has to scale with the sky rather than against it. The ground keeps
 * its authored hue -- it is the lawn, and the lawn's colour is authored -- and
 * only its brightness follows the sky down.
 */
export function applySkyLighting({ sun, skyLight, probe }) {
  const sunColor = probe.sun.map((channel) => channel * SUN_ANCHOR);
  const skyColor = probe.sky.map((channel) => channel * SKY_ANCHOR);
  const groundScale =
    relativeLuminance(skyColor) / Math.max(1e-6, AUTHORED_SKY.luminance);

  sun.intensity = 1;
  sun.color.setRGB(...sunColor, THREE.LinearSRGBColorSpace);

  skyLight.intensity = 1;
  skyLight.color.setRGB(...skyColor, THREE.LinearSRGBColorSpace);
  skyLight.groundColor
    .set(AUTHORED_SKY.ground)
    .multiplyScalar(AUTHORED_SKY.intensity * groundScale);

  return { sunColor, skyColor };
}
