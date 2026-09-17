import { createGPUDrivenGrass } from './grass.js';
import { GRASS_BACKLIGHT } from './blade-lighting.js';

export { createLawnSurface, loadLawnPBRTextures, LAWN_UNDERLAY, normalizeLawnUnderlay } from './surface.js';
export { LAWN, LAWN_COLORS, LAWN_TARGET_HUE, lawnColorsFor, CANOPY_PULL_MAX, CLUMP_PULL_MARGIN } from './preset.js';
export { GRASS_RINGS } from './grid.js';
export { GRASS_BACKLIGHT, normalizeBacklight } from './blade-lighting.js';

const BOOLEAN_OPTIONS = [
  'shadows', 'coarseCulling', 'subgroupCulling', 'cullHysteresis',
  'diffuseOnly', 'projectedCanopy', 'poseCache',
];
const PALETTE_COLORS = ['bottom', 'top', 'backlight', 'ground'];
// `GRASS_BACKLIGHT.canopy` is the surface's aggregate far-field mode, not a
// blade mode; normalizeBacklight() would quietly read it as `blade`.
const BLADE_BACKLIGHT_MODES = [GRASS_BACKLIGHT.blade, GRASS_BACKLIGHT.view, GRASS_BACKLIGHT.off];

function requireRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Grass ${name} must be an object.`);
  }
}

function requireFinite(record, name, keys) {
  for (const key of keys) {
    if (!Number.isFinite(record[key])) {
      throw new TypeError(`Grass ${name}.${key} must be a finite number.`);
    }
  }
}

/**
 * Tuning options are optional, but a supplied one must be complete and sane.
 * The deeper checks in createGPUDrivenGrass (clump-pull margin, canopy pull
 * ceiling, ordered bend) still apply; these catch what they would let through
 * -- non-finite values, missing fields, mistyped flags -- as a clear error
 * instead of NaN geometry or a silently ignored option.
 */
function validateTuning(options) {
  for (const key of BOOLEAN_OPTIONS) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new TypeError(`Grass ${key} must be a boolean.`);
    }
  }
  const { backlight, tillers, minBladePixels, bend, posture, canopy, size, greens, heightCorrelation } = options;
  if (backlight !== undefined && typeof backlight !== 'boolean' &&
      !BLADE_BACKLIGHT_MODES.includes(backlight)) {
    throw new RangeError(
      `Grass backlight must be a boolean or one of ${BLADE_BACKLIGHT_MODES.join(', ')}.`,
    );
  }
  if (tillers !== undefined && !(Number.isInteger(tillers) && tillers >= 1)) {
    throw new RangeError('Grass tillers must be a whole number of at least 1.');
  }
  if (minBladePixels !== undefined && !(Number.isFinite(minBladePixels) && minBladePixels > 0)) {
    throw new RangeError('Grass minBladePixels must be a positive finite number.');
  }
  if (heightCorrelation !== undefined) {
    if (!Number.isFinite(heightCorrelation)) {
      throw new TypeError('Grass heightCorrelation must be a finite number.');
    }
    if (heightCorrelation < 0) {
      throw new RangeError('Grass heightCorrelation must not be negative.');
    }
  }
  if (bend !== undefined) {
    requireRecord(bend, 'bend');
    requireFinite(bend, 'bend', ['min', 'max']);
  }
  if (posture !== undefined) {
    requireRecord(posture, 'posture');
    requireFinite(posture, 'posture', ['clumpPull', 'tillerFan']);
  }
  if (canopy !== undefined) {
    requireRecord(canopy, 'canopy');
    requireFinite(canopy, 'canopy', ['near', 'far']);
  }
  if (size !== undefined) {
    requireRecord(size, 'size');
    requireFinite(size, 'size', ['minHeight', 'maxHeight', 'minWidth', 'maxWidth']);
    if (!(size.minHeight > 0 && size.minWidth > 0)) {
      throw new RangeError('Grass blade heights and widths must be positive.');
    }
    if (size.maxHeight < size.minHeight || size.maxWidth < size.minWidth) {
      throw new RangeError('Grass size ranges must be ordered, minimum first.');
    }
  }
  if (greens !== undefined) {
    requireRecord(greens, 'greens');
    for (const key of PALETTE_COLORS) {
      const value = greens[key];
      if (!(typeof value === 'string' || Number.isFinite(value) || value?.isColor)) {
        throw new TypeError(`Grass greens.${key} must be a color string, number or THREE.Color.`);
      }
    }
    const tint = greens.groundTint;
    if (!Array.isArray(tint) || tint.length !== 3 ||
        !tint.every(channel => Number.isFinite(channel) && channel >= 0)) {
      throw new TypeError('Grass greens.groundTint must be three finite non-negative multipliers.');
    }
  }
}

/**
 * Two forms of terrain: a baked texture over a centred square, or a TSL
 * function of world XZ with no edge. Both pack crown heights into the same
 * interval, so both must say what it is.
 */
function validateHeightMap(heightMap) {
  if (!heightMap || typeof heightMap !== 'object') {
    throw new TypeError('Grass terrain requires a heightMap descriptor.');
  }
  const procedural = heightMap.heightAt != null;
  if (procedural) {
    if (typeof heightMap.heightAt !== 'function') {
      throw new TypeError('Grass heightMap.heightAt must be a TSL node function.');
    }
    if (heightMap.texture != null) {
      throw new TypeError('Grass heightMap takes either heightAt or texture, not both.');
    }
  } else if (!heightMap.texture?.isTexture) {
    throw new TypeError('Grass terrain requires a height-map texture or a heightAt function.');
  }
  const keys = procedural
    ? ['normalStep', 'packingMinimum', 'packingRange']
    : ['extent', 'minimum', 'scale', 'texelWorldSize', 'packingMinimum', 'packingRange'];
  for (const key of keys) {
    if (!Number.isFinite(heightMap[key])) {
      throw new TypeError(`Grass heightMap.${key} must be finite.`);
    }
  }
  if (procedural) {
    if (heightMap.normalStep <= 0 || heightMap.packingRange <= 0) {
      throw new RangeError('Grass terrain normal step and packing range must be positive.');
    }
  } else if (heightMap.extent <= 0 || heightMap.texelWorldSize <= 0 || heightMap.packingRange <= 0) {
    throw new RangeError('Grass terrain extent, texel size and packing range must be positive.');
  }
}

/**
 * Public Three.js WebGPU grass entry point. The host owns the renderer, terrain
 * texture, coverage mask and shared lawn surface. See docs/grass-api.md.
 */
export function createGrass(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Grass options must be an object.');
  }
  const { renderer, heightMap, surface, keepAt } = options;
  if (!renderer || renderer.initialized === false ||
      renderer.backend?.isWebGPUBackend === false ||
      renderer.backend?.isWebGLBackend === true ||
      typeof renderer.compute !== 'function' ||
      typeof renderer.getDrawingBufferSize !== 'function' ||
      typeof renderer.getArrayBufferAsync !== 'function') {
    throw new TypeError('Grass requires an initialized Three.js WebGPU renderer.');
  }
  validateHeightMap(heightMap);
  if (!surface?.material?.isMaterial ||
      ['macroAt', 'healthAt', 'tintFrom', 'densityFrom', 'dryTintFrom']
        .some(key => typeof surface[key] !== 'function')) {
    throw new TypeError('Grass requires a shared lawn surface from createLawnSurface().');
  }
  if (keepAt != null && typeof keepAt !== 'function') {
    throw new TypeError('Grass keepAt must be a TSL node function.');
  }
  validateTuning(options);
  return createGPUDrivenGrass(options);
}
