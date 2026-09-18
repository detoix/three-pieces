import { sunAnglesOf } from '@detoix/three-pieces/sky';
import { HILLS_DEFAULT_SCALE } from '@detoix/three-pieces/terrain';
import {
  CLUMP_PULL_MARGIN,
  LAWN,
  LAWN_TARGET_HUE,
  normalizeBacklight,
  normalizeLawnUnderlay,
} from '@detoix/three-pieces/grass';

// URL dials. None of this is part of the package: it is how this demo exposes
// the package's options for A/B comparison and for framing a recording.

/**
 * Where the sun stands in the demo, written as the two angles the sky needs
 * rather than as an offset.
 *
 * It is one number in two places otherwise: the directional light aims the
 * shading and the atmosphere aims the scattering, and a sky whose sun disk is
 * not where the shadows say it is looks wrong in a way nobody can name. These
 * are the angles the lawn palette was calibrated under.
 */
const SHIPPED_SUN_OFFSET = [24, 34, 17];
const SUN_ANGLES = sunAnglesOf(SHIPPED_SUN_OFFSET);

/**
 * What the sky's radiance is multiplied by on its way to the tone mapper.
 *
 * The atmosphere is solved with the sun's irradiance set to 1, so this number
 * is the sun in render units and it decides the whole image. It is measured,
 * not chosen: a sweep read the rendered horizon back off
 * the real adapter, and this is the value at which the horizon keeps the
 * luminance the flat `#b8c9b5` background and its matching fog had. Holding
 * the horizon still is the conservative choice, because the horizon is what
 * the far field dissolves into -- the lawn's measured hue is calibrated over
 * depth, and re-exposing the far band would move it. Everything above the
 * horizon then lands where the physics puts it relative to that.
 */
const SKY_EXPOSURE = 7.1;

/** Lawn and sky dials. */
export function readSceneOptions(search = '', devicePixelRatio = 1) {
  const params = new URLSearchParams(search);
  const number = (key, fallback, minimum, maximum) => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value)
      ? Math.min(maximum, Math.max(minimum, value))
      : fallback;
  };
  // `createGPUDrivenGrass` rejects a clump pull within a tenth of 1, where a
  // crown heading opposed to its clump's cancels to a vector with no direction
  // to normalize. Step over that band to the side it was asked from rather
  // than clamping into it, so a typo in the URL is a look and not a throw.
  const awayFromOne = (value) => {
    if (Math.abs(value - 1) >= CLUMP_PULL_MARGIN) return value;
    // Over the margin rather than onto it: 1 - 0.1 is 0.09999999999999998
    // away from 1 in a float64, which the guard reads as inside the band.
    const step = CLUMP_PULL_MARGIN * 1.1;
    return value < 1 ? 1 - step : 1 + step;
  };
  return {
    // Blades per crown. The one lever that buys near-ground density without
    // touching a candidate slot, a placement, a cull or a byte of storage --
    // and the one whose cost has to be measured rather than argued about,
    // which is why it is a dial. `?tillers=3` is the control.
    tillers: Math.round(number('tillers', LAWN.tillers, 1, 12)),
    // Multipliers on the preset's resting-bend range, for testing shape
    // against density. They are separate ends because they answer different
    // questions: `bendmin` raises the *floor*, and the floor is 5.7 degrees,
    // so a good share of blades stand to attention however high the ceiling
    // goes -- that is the likelier cause of a lawn reading as spikes. Only
    // `bendmax` moves the culling sphere.
    bendMin: number('bendmin', 1, 0, 8),
    bendMax: number('bendmax', 1, 0.1, 8),
    // How correlated neighbouring blades are. `clumppull` is how much of a
    // crown's facing its 45 cm clump dictates and `tillerfan` is the yaw its
    // own blades spread over; between them they decide whether a patch of
    // lawn presents one normal to the sun or a spread of them. `?clumppull=1.2
    // &tillerfan=0.7` restores the older meadow-grained pair, where the clump
    // outvoted the crown and every patch presented one shared normal.
    // A pull within a tenth of 1 can cancel a crown's heading to a zero
    // vector, so the dial steps over that band rather than clamping into it.
    clumpPull: awayFromOne(number('clumppull', 0.15, 0, 4)),
    tillerFan: number('tillerfan', 1.8, 0, 3),
    // How much of the Grass004 photograph's own metre-scale patchiness is
    // divided out of the ground. The asset is a photograph of a lawn and it
    // brings that lawn's light and dark blotches with it, which is the most
    // visible thing in the ground close to the camera and disagrees with every
    // signal this lawn has of its own. `?flatten=0` is the photograph as shot.
    flatten: number('flatten', LAWN.groundFlatten, 0, 1),
    macroTint: number('macro', 1, 0, 2),
    // How far the underlay turns into the grass it is standing in for, with
    // distance. Past 24 m the lawn is over 99% underlay -- the far ring still
    // draws blades and they cover nothing -- so out there this is the whole
    // lawn. `?proxy=0` is the ground as it was photographed, at every distance.
    proxy: number('proxy', 1, 0, 1),
    // What the ground between the blades keeps of the light an open field
    // gets. The blades cast no shadow, so without this the ground under a
    // canopy is lit as though nothing stood above it. `?groundao=1` is the
    // A/B; it is `LAWN.rootOcclusion` because the ground and a blade's base
    // are at the same height under the same neighbours.
    groundAO: number('groundao', LAWN.groundCanopyAO, 0.05, 1),
    // How far the far field's canopy normal leans with the lawn's grain. It is
    // on the underlay rather than the crowns because the crowns' normals are
    // aggregated towards the ground on purpose, and a grain put there cancels
    // against that -- measured, see `LAWN.canopyGrain`. `?grain=0` is the A/B.
    grain: number('grain', LAWN.canopyGrain, 0, 1),
    // How much of the lawn's own variation it asserts: the density swing
    // between poor and rich ground, and how much of a crown's height its patch
    // decides rather than its own hash. `?variation=0` is a lawn that varies
    // only by the preset's own narrow spread.
    variation: number('variation', 1, 0, 2),
    // How far the blades' shading normal is pulled toward the ground's, as a
    // multiple of the preset's near/far pair. A blade is 3 mm wide and a pixel
    // covers several of them within a few metres, so shading each by its own
    // literal facing makes the clumps that happen to face the sun bright slabs
    // beside dark ones; pulling the normal toward the ground's is what those
    // unresolved blades actually average to. `?canopy=0` is the control: every
    // blade shaded by its own facing, with no canopy pull. The transmission
    // term is not on this dial -- it keeps the blade's own normal whatever
    // this says, or the lawn stops being backlit as it is pulled flat.
    canopy: number('canopy', 1.3, 0, 1.6),
    // `blade` gates transmission on the blade's own normal, `view` is the
    // shipped view-only lobe and `off` removes it. The middle one is the
    // control that matters: `off` can only say whether the term exists.
    backlight: normalizeBacklight(params.get('backlight')),
    diffuseOnly: params.get('grassdiffuse') !== '0',
    bladePixels: number('bladepixels', 1.1, 0.5, 2),
    coarseCulling: params.get('grasscoarse') !== '0',
    projectedProxy: params.get('canopylod') !== '0',
    poseCache: params.get('posecache') === '1',
    cullHysteresis: params.get('cullhysteresis') !== '0',
    subgroupCulling: params.get('subgroupcull') === '1',
    // Hue the whole lawn palette is drawn around, in degrees -- blades, the
    // transmitted green and the tint on the Grass004 underlay together. See
    // `LAWN_TARGET_HUE`: turfgrass research puts healthy lawn between 60 and
    // 120, a reference photograph sits at 99, and this lawn rendered at 75.
    // `?lawnhue=86.7` is the palette as it was authored.
    lawnHue: number('lawnhue', LAWN_TARGET_HUE, 60, 140),
    // Multipliers on the blade's modelled size. Height is the one that moves
    // coverage: at a 1.7 m eye you see the ground at 12-23 degrees, where
    // 93-97% of a blade's projected extent is its height and almost none is
    // its width. `?bladeheight=0.73&bladewidth=0.77` is the 4-8 cm by 3-5 mm
    // blade from before the coverage sweep.
    bladeHeight: number('bladeheight', 0.65, 0.3, 4),
    bladeWidth: number('bladewidth', 0.65, 0.3, 4),
    shadows: params.get('shadows') !== 'off',
    underlay: normalizeLawnUnderlay(params.get('underlay')),
    // `?sky=flat` is the A/B: the `#b8c9b5` clear colour and the matching
    // linear fog the demo had before the sky, with no atmosphere baked at all.
    sky: params.get('sky') === 'flat' ? 'flat' : 'atmosphere',
    clouds: params.get('clouds') !== 'off',
    cloudQuality: ['low', 'balanced', 'high'].includes(params.get('cloudquality')) ? params.get('cloudquality') : 'balanced',
    cloudCoverage: number('cloudcoverage', 0.48, 0, 1),
    cloudWindSpeed: number('cloudwind', 12, 0, 100),
    // Whether the two lights take their colour from the atmosphere. This is
    // the A/B that isolates the lighting from the sky: `?skylights=off` keeps
    // the authored `#fff0cd` sun and neutral hemisphere under a physical sky,
    // which is how the scene was lit when the sky first landed.
    skyLights: params.get('skylights') !== 'off',
    // The sun in render units, and the one judgement call in the sky. See
    // `SKY_EXPOSURE`; it was measured off the render rather than chosen.
    skyExposure: number('skyexposure', SKY_EXPOSURE, 0.5, 60),
    // How much of the light that has bounced more than once the sky keeps.
    // `?skyms=0` is single scattering alone, and it is not a uniform dimming:
    // measured off the render, the zenith loses 39% of its luminance, the
    // horizon across the sun 34%, the horizon into the sun 19%, and the far
    // haze band 28%. The zenith loses most because it has the least single
    // scattering to begin with -- a short path up through thin air -- so the
    // control is a sky with a deeper, colder top and a flatter gradient.
    skyMultiScatter: number('skyms', 1, 0, 3),
    // The sun, for the atmosphere and the directional light together. The
    // defaults are the shipped offset expressed as angles, so leaving them
    // alone leaves every shadow and every measured lawn colour where it was.
    // Moving them moves both, which is the point -- and moves the lawn's hue
    // calibration with them, which is the cost.
    sunElevation: number('sunelevation', SUN_ANGLES.elevation, -10, 89),
    sunAzimuth: number('sunazimuth', SUN_ANGLES.azimuth, -360, 360),
    pixelRatio: number(
      'pixelratio',
      Math.min(devicePixelRatio || 1, 2),
      0.5,
      3,
    ),
  };
}

/**
 * Hills-only dials. Everything the lawn and the sky take is read by
 * `readSceneOptions`.
 */
export function readHillsOptions(search = '') {
  const params = new URLSearchParams(search);
  const number = (key, fallback, minimum, maximum) => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
  };
  const hazeNear = number('hazenear', 90, 0, 2000);
  return {
    /** Vertical scale of the hills; 0 is a flat, still unbounded, lawn. */
    hills: number('hills', HILLS_DEFAULT_SCALE, 0, 2),
    /** Eye height above the ground in metres. */
    eye: number('eye', 1.7, 0.3, 80),
    walkSpeed: number('walk', 2.8, 0.1, 50),
    runSpeed: number('run', 9, 0.1, 120),
    /** Where the sky's haze starts and where the ground is wholly sky-coloured. */
    hazeNear,
    hazeFar: Math.max(hazeNear + 1, number('hazefar', 1100, 1, 1400)),
    ui: params.get('ui') !== '0',
    startX: number('x', 0, -1e6, 1e6),
    startZ: number('z', 0, -1e6, 1e6),
    /** Initial heading in degrees, clockwise from -Z. */
    heading: number('heading', 35, -360, 360),
  };
}
