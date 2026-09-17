import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLADE_CULL_CENTRE,
  bladeCullRadiusFactor,
} from '../src/grass/blade-arc.js';
import { GRASS_RINGS } from '../src/grass/grid.js';
import { createBladeGeometry } from '../src/grass/blade-geometry.js';
import {
  CANOPY_PULL_FLOOR,
  CANOPY_PULL_MAX,
  CLUMP_PULL_MARGIN,
  GRASS004_ALBEDO_MEAN,
  LAWN,
  LAWN_TARGET_HUE,
  lawnColorsFor,
} from '../src/grass/preset.js';

/**
 * A blade's shape and its culling sphere are one contract.
 *
 * `grass.js` shapes each blade in the vertex stage -- it bends by its own
 * hashed amount, and widens when it would otherwise fall under a pixel on
 * screen -- and culls it in a compute pass against a sphere that learns
 * neither. Nothing connects the two but arithmetic, and getting it wrong does
 * not throw: a blade that leaves its sphere is culled while still on screen,
 * which reads as blades winking out at the frame edge on a hard turn. That is
 * a fault you need a moving camera and a wide view to notice at all, so it is
 * held here instead.
 *
 * These are both halves, written the way the shader writes them.
 */

/** Sphere centre, up the ground normal, as a fraction of blade height. */
const CULL_CENTRE = 0.5;
/** Sphere radius, before the width term, as the same fraction. */
const CULL_RADIUS = 0.58;

/** A blade's half-width at `along`, as a fraction of its base width. */
function bladeHalfWidth(along) {
  return (1 - along) ** LAWN.taper * 0.5;
}

/** The sphere the cull pass builds, in metres. It is centred on the crown. */
function cullRadius(height, width) {
  return (
    CULL_RADIUS * height +
    0.5 * LAWN.maxThicken * width +
    0.5 * LAWN.tillerSpread
  );
}

function range(from, to, steps) {
  const out = [];
  for (let i = 0; i <= steps; i += 1)
    out.push(from + (to - from) * (i / steps));
  return out;
}

/**
 * A blade's centreline at `along` (0 root, 1 tip), as fractions of its height.
 * A constant-curvature arc to second order -- the same expansion the vertex
 * stage evaluates.
 */
function bladeArc(bend, along) {
  return {
    rise: along - (bend * bend * along ** 3) / 6,
    reach: (bend * along * along) / 2,
  };
}

function bendSamples() {
  return range(LAWN.minBend, LAWN.maxBend, 64);
}

test('every resting bend stays inside the culling sphere', () => {
  for (const bend of bendSamples()) {
    for (let i = 0; i <= 256; i += 1) {
      const along = i / 256;
      const { rise, reach } = bladeArc(bend, along);
      const distance = Math.hypot(reach, rise - CULL_CENTRE);
      assert.ok(
        distance <= CULL_RADIUS,
        `bend ${bend.toFixed(3)} at ${along.toFixed(3)} reaches ` +
          `${distance.toFixed(4)} of blade height from the sphere centre, ` +
          `past the ${CULL_RADIUS} the cull allows`,
      );
    }
  }
});

test('leaning bends a blade over rather than stretching it', () => {
  for (const bend of bendSamples()) {
    const upright = bladeArc(0, 1);
    const leaning = bladeArc(bend, 1);
    assert.ok(
      leaning.rise <= upright.rise,
      `bend ${bend.toFixed(3)} raised the tip to ${leaning.rise.toFixed(4)}`,
    );
    assert.ok(
      Math.hypot(leaning.reach, leaning.rise) <= 1,
      `bend ${bend.toFixed(3)} put the tip ` +
        `${Math.hypot(leaning.reach, leaning.rise).toFixed(4)} of a blade ` +
        `height from the root, so the blade grew by leaning`,
    );
  }
});

test('a blade is planted, whatever it draws', () => {
  for (const bend of bendSamples()) {
    const root = bladeArc(bend, 0);
    assert.equal(root.rise, 0);
    assert.equal(root.reach, 0);
  }
});

test('the preset keeps the bend range ordered and upright-ish', () => {
  assert.ok(LAWN.minBend >= 0, 'a blade cannot lean backwards at rest');
  assert.ok(LAWN.minBend < LAWN.maxBend, 'bend range is ordered');
  assert.ok(LAWN.maxBend < Math.PI / 4, 'past 45 degrees this is not a lawn');
});

test('the widest thickened tiller still fits its crown sphere', () => {
  // A crown is culled as one sphere, and every blade it grows has to be in it:
  // widened to the cap, bent as far as it may bend, and standing as far off
  // the crown centre as the tuft spreads.
  const offset = 0.5 * LAWN.tillerSpread;
  for (const height of range(LAWN.minHeight, LAWN.maxHeight, 8)) {
    for (const width of range(LAWN.minWidth, LAWN.maxWidth, 8)) {
      const radius = cullRadius(height, width);
      // Both shortenings compound, so the shortest blade the shader can
      // build is the product of the two.
      for (const shorten of range(
        LAWN.tillerShortest * LAWN.clumpShortest,
        1,
        5,
      )) {
        for (const bend of range(LAWN.minBend, LAWN.maxBend, 8)) {
          for (const along of range(0, 1, 64)) {
            const { rise, reach } = bladeArc(bend, along);
            // The far edge of the blade, widened as far as the shader may go,
            // on the tiller standing furthest from the crown.
            const across =
              bladeHalfWidth(along) * width * LAWN.maxThicken + offset;
            const distance = Math.hypot(
              across,
              rise * height * shorten - CULL_CENTRE * height,
              reach * height * shorten,
            );
            assert.ok(
              distance <= radius,
              `a ${(height * 100).toFixed(1)} cm crown's tiller at bend ` +
                `${bend.toFixed(2)}, shortened to ${shorten.toFixed(2)} and ` +
                `thickened ${LAWN.maxThicken}x, reaches ` +
                `${(distance * 1000).toFixed(2)} mm from the crown centre, ` +
                `past the ${(radius * 1000).toFixed(2)} mm the cull allows`,
            );
          }
        }
      }
    }
  }
});

test('a tiller only ever shortens, so its crown still bounds it', () => {
  assert.ok(LAWN.tillerShortest > 0, 'a tiller with no height is not drawn');
  assert.ok(
    LAWN.tillerShortest <= 1,
    'a tiller taller than its crown outgrows the sphere measured for it',
  );
  assert.ok(LAWN.tillers >= 1, 'a crown grows at least one blade');
  assert.ok(Number.isInteger(LAWN.tillers), 'tillers are whole blades');
});

test('tillering multiplies every ring alike', () => {
  // The rings hand over at matched densities. Tillering is a flat multiplier
  // on all of them, so those boundaries still match -- if this ever becomes
  // per-ring, the 8 m and 24 m handovers need re-deriving, not just retesting.
  assert.equal(typeof LAWN.tillers, 'number');
  assert.ok(LAWN.tillerFan >= 0, 'a negative fan is a mirrored blade');
  assert.ok(LAWN.tillerSpread >= 0, 'a crown cannot have negative width');
});

test('thickening only ever widens, and only to the cap', () => {
  assert.ok(LAWN.maxThicken >= 1, 'a cap under 1 would narrow a blade');
  assert.ok(LAWN.minBladePixels > 0, 'a floor of zero pixels floors nothing');
  // The width a blade is allowed to reach has to stay a blade, not a ribbon.
  const widest = LAWN.maxWidth * LAWN.maxThicken;
  assert.ok(
    widest < LAWN.minHeight,
    `a fully thickened blade is ${(widest * 1000).toFixed(1)} mm across, ` +
      `wider than the shortest blade is tall`,
  );
});

test('the blade is modelled near life size, and never back to a spike', () => {
  // The point of `minBladePixels`: stability is bought on screen, so the model
  // no longer has to be drawn oversized to survive walking distance. This used
  // to hold `maxWidth` to the 5 mm at the top of real turf grass's 2-4 mm.
  //
  // It is 6.5 mm, and the bound moved with a measurement rather than with the
  // value: between about 2 m and the distance `maxThicken` caps the widening
  // at, screen width is pinned at `minBladePixels` whatever the blade is
  // modelled at, but past that cap coverage is proportional to this number
  // again. On the adapter at 1280x720, 3.1-5.0 mm against 4.0-6.5 mm is 7.0
  // points of bare ground at 6-8 m, 8.5 at 8-12 m and 7.3 at 12-16 m -- and
  // 0.8 at 2-3 m, where the pinning still holds and the wider model is
  // invisible, which is the half of the old argument that survives.
  assert.ok(LAWN.minWidth >= 0.002, 'thinner than turf grass gets');
  assert.ok(
    LAWN.maxWidth <= 0.008,
    `a ${(LAWN.maxWidth * 1000).toFixed(1)} mm blade is back in the 8-14 mm ` +
      'this shipped with, which is what made the lawn read as fat spikes -- ' +
      'no coverage measurement buys that back',
  );
  // The oversizing is a device, not the model. Keep it inside twice life size
  // so it stays something a later change can hand back to the far field.
  assert.ok(
    LAWN.maxWidth <= 2 * 0.004,
    'past twice the widest real blade this is no longer a modelled blade',
  );
});

test('a clump only ever shortens its crowns', () => {
  // Same contract as tillerShortest, one scale up. The cull pass measures a
  // crown at its full height and never learns which clump it fell in, so a
  // clump that could make grass taller would put it outside its own sphere.
  assert.ok(LAWN.clumpShortest > 0, 'a clump with no height is not drawn');
  assert.ok(
    LAWN.clumpShortest <= 1,
    'a clump taller than its crowns outgrows the sphere measured for them',
  );
});

test('a clump heading can never cancel to nothing', () => {
  // The crown heading is a unit vector plus the clump heading times clumpPull.
  // Opposed, those sum to |clumpPull - 1|, and normalizing a zero vector has
  // no answer -- so this margin is what stops a NaN blade.
  assert.notEqual(
    LAWN.clumpPull,
    1,
    'at a pull of exactly 1 an opposed clump cancels its crown to zero',
  );
  assert.ok(
    Math.abs(LAWN.clumpPull - 1) >= CLUMP_PULL_MARGIN,
    `a pull of ${LAWN.clumpPull} leaves only ` +
      `${Math.abs(LAWN.clumpPull - 1).toFixed(3)} of heading to normalize`,
  );
});

test('the hue correction moves hue and nothing else', () => {
  // Turfgrass research scores lawn colour with the Dark Green Colour Index,
  // whose hue transform is `(H - 60) / 60` -- 60 degrees is the yellow end of
  // a lawn and 120 the deep-green end. A reference photograph of a well-fed
  // lawn sits at 99 and holds it at every depth. This page rendered at 75.
  const toLinear = (channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const parse = (hex) =>
    [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const luminance = (rgb) =>
    0.2126 * toLinear(rgb[0]) +
    0.7152 * toLinear(rgb[1]) +
    0.0722 * toLinear(rgb[2]);
  const hueOf = (rgb) => {
    const high = Math.max(...rgb);
    const span = high - Math.min(...rgb);
    if (span === 0) return 0;
    const sextant =
      high === rgb[0]
        ? ((rgb[1] - rgb[2]) / span) % 6
        : high === rgb[1]
          ? (rgb[2] - rgb[0]) / span + 2
          : (rgb[0] - rgb[1]) / span + 4;
    return (((sextant * 60) % 360) + 360) % 360;
  };

  // The target still overshoots the 99 it aims the *image* at, but by much
  // less than it used to. It was 104.4 while the sun was authored warm at
  // `#fff0cd` and the ambient authored near-neutral; both now come from the
  // atmosphere, which costs the image far less yellow, and 92 is what lands
  // 99. The floor is the authored hue itself: a target at or below 86.7 would
  // mean the palette needs no correction at all, which would make
  // `lawnColorsFor` dead weight rather than a calibration.
  assert.ok(
    LAWN_TARGET_HUE > 86.7,
    `a target of ${LAWN_TARGET_HUE} no longer overshoots the authored 86.7, ` +
      'so the rotation is doing nothing and should be removed rather than kept',
  );
  assert.ok(
    LAWN_TARGET_HUE <= 120,
    'past 120 the palette leaves the range turfgrass research calls lawn',
  );

  // Rotating a hue in HSV alone changes how bright a colour reads, because the
  // eye weights green nearly four times red. Holding luminance is what makes
  // this a correction rather than a repaint -- and what makes the A/B honest,
  // since a brighter lawn would flatter itself for the wrong reason.
  const authored = lawnColorsFor(86.7);
  const corrected = lawnColorsFor(LAWN_TARGET_HUE);
  for (const name of ['bottom', 'top', 'backlight', 'ground']) {
    const before = parse(authored[name]);
    const after = parse(corrected[name]);
    assert.ok(
      Math.abs(luminance(before) - luminance(after)) < 0.002,
      `${name} changed luminance ${luminance(before).toFixed(4)} -> ` +
        `${luminance(after).toFixed(4)}; the rotation must move hue only`,
    );
    assert.ok(
      hueOf(after) - hueOf(before) > 0,
      `${name} did not move towards green`,
    );
  }

  // The dial is lossless: asking for the hue the palette was drawn at returns
  // the palette as it was drawn, so `?lawnhue=86.7` is a true control.
  assert.deepEqual(
    { ...authored, groundTint: undefined },
    {
      bottom: '#4e6b32',
      top: '#638046',
      backlight: '#89ad60',
      ground: '#3c5a1d',
      groundTint: undefined,
    },
  );

  // The underlay is a photograph and cannot be recoloured, only multiplied.
  // Its tint has to land the asset's own mean on the palette's hue.
  const mean = parse(GRASS004_ALBEDO_MEAN);
  assert.ok(
    Math.abs(hueOf(mean) - 72) < 1,
    `the measured Grass004 mean is hue ${hueOf(mean).toFixed(1)}, not the 72 ` +
      'this correction was derived from -- re-measure the asset',
  );
  const tinted = mean.map(
    (channel, index) => channel * corrected.groundTint[index],
  );
  assert.ok(
    Math.abs(hueOf(tinted) - LAWN_TARGET_HUE) < 1,
    `the tinted underlay lands at hue ${hueOf(tinted).toFixed(1)}, not the ` +
      `palette's ${LAWN_TARGET_HUE}, so the ground disagrees with the grass`,
  );
  assert.ok(
    Math.abs(luminance(mean) - luminance(tinted)) < 0.002,
    'the ground tint must not brighten or darken the asset',
  );
});

/**
 * The shading normal the vertex stage builds, in a frame where the ground is
 * up, the blade leans along +Z and splays across +X. Written the way the
 * shader writes it: the blade's own facing, mixed toward the ground's.
 */
function canopyMix({ bend, along, half, pull }) {
  const lean = bend * along;
  const splay = half * 2 * LAWN.normalSpread;
  const blade = [
    Math.sin(splay),
    -Math.sin(lean) * Math.cos(splay),
    Math.cos(lean) * Math.cos(splay),
  ];
  const ground = [0, 1, 0];
  return Math.hypot(
    ...blade.map((axis, index) => axis * (1 - pull) + ground[index] * pull),
  );
}

/** The shortest that mix gets anywhere in a lawn built at these dial settings. */
function shortestCanopyMix({ maxBend, maxPull }) {
  let shortest = Infinity;
  for (const along of range(0, 1, 256)) {
    // The blade tapers, so its splay -- the one thing holding the normal off
    // the ground's axis -- runs out exactly at the tip.
    const half = bladeHalfWidth(along);
    for (const bend of range(0, maxBend, 128)) {
      for (const pull of range(0, maxPull, 64)) {
        shortest = Math.min(shortest, canopyMix({ bend, along, half, pull }));
      }
    }
  }
  return shortest;
}

test('the canopy pull aggregates the blades without dissolving them', () => {
  // A blade is 3 mm wide and a pixel covers several of them within a few
  // metres, so past that its own literal facing is a lie the size of a clump:
  // the ones facing the sun go bright and their neighbours go dark, and the
  // lawn reads as slabs. The pull is toward what those unresolved blades
  // average to, which is the ground they stand on -- so it has to grow with
  // distance, and it has to leave some blade in it at the far end.
  assert.ok(
    LAWN.canopyNormalNear >= 0 && LAWN.canopyNormalFar > LAWN.canopyNormalNear,
    'the pull has to grow with distance, or it is not aggregating anything',
  );
  assert.ok(
    LAWN.canopyNormalFar <= CANOPY_PULL_MAX,
    `a far pull of ${LAWN.canopyNormalFar} leaves ` +
      `${(1 - LAWN.canopyNormalFar).toFixed(2)} of the blade in its own ` +
      'shading, which is a lit plane with grass-shaped geometry in front',
  );

  // Both ends of the ramp sit inside a ring rather than on a boundary. A ramp
  // that ended where a ring does would step the lawn's shading exactly where
  // its density contract promises no step.
  assert.ok(
    LAWN.canopyNormalFrom > 0 && LAWN.canopyNormalTo > LAWN.canopyNormalFrom,
    'an ordered ramp, or `smoothstep` reads it backwards',
  );
  for (const metres of [LAWN.canopyNormalFrom, LAWN.canopyNormalTo]) {
    const boundaries = GRASS_RINGS.map((ring) => ring.outer);
    assert.ok(
      boundaries.every((edge) => Math.abs(edge - metres) > 1),
      `the ramp ends at ${metres} m, on a ring boundary`,
    );
  }
});

test('the canopy mix can never cancel a blade to nothing', () => {
  // `mix(bladeNormal, groundNormal, pull)` shortens as the two disagree, and a
  // blade folded past horizontal faces away from the sky: at a pull near a
  // half the two cancel and `normalize()` has no answer. The vertex stage
  // falls back to the blade's own normal below `CANOPY_PULL_FLOOR`.
  const shipped = shortestCanopyMix({
    maxBend: LAWN.maxBend,
    maxPull: CANOPY_PULL_MAX,
  });
  assert.ok(
    shipped > 0.1,
    `the shipped bend range mixes down to ${shipped.toFixed(3)}, which is ` +
      'close enough to cancelling that the fallback is load-bearing in a ' +
      'lawn nobody dialled',
  );

  // It is load-bearing at the ends of the dials, and exactly there. A blade
  // leaning a right angle faces straight down; its tip has tapered to no splay
  // left to hold the normal off the ground's axis; and half of nothing plus
  // half of the sky is nothing. Asserted at the point rather than swept,
  // because the cancellation *is* a single point and a lattice of samples
  // steps over it -- which is the same reason it is worth a floor in the
  // shader rather than an argument that it cannot happen.
  const cancelled = canopyMix({
    bend: Math.PI / 2,
    along: 1,
    half: 0,
    pull: 0.5,
  });
  assert.ok(
    cancelled < CANOPY_PULL_FLOOR,
    `a blade folded flat away from the sky and pulled half way back to it ` +
      `leaves ${cancelled.toExponential(2)} of a direction, which is nothing ` +
      'to normalize',
  );
  assert.ok(
    LAWN.maxBend * 8 > Math.PI / 2,
    `\`?bendmax=8\` reaches ${(LAWN.maxBend * 8).toFixed(2)} radians, so the ` +
      'dials can ask for that blade',
  );
  assert.ok(
    LAWN.canopyNormalNear <= 0.5 && LAWN.canopyNormalFar >= 0.5,
    'and the pull crosses a half between the near and far ends, so some ' +
      'distance in the ramp asks for it too',
  );
  assert.ok(
    CANOPY_PULL_FLOOR > 0 && CANOPY_PULL_FLOOR < shipped,
    'the floor has to be reachable by that blade and by no shipped one',
  );
});

test('clumps are a lawn scale, not a meadow one', () => {
  assert.ok(LAWN.clumpSize > LAWN.tillerSpread, 'a clump holds many crowns');
  assert.ok(LAWN.clumpSize <= 2, 'past a couple of metres this is terrain');
});

test('root occlusion darkens a blade without extinguishing it', () => {
  assert.ok(
    LAWN.rootOcclusion > 0,
    'a root multiplier of zero is a black band',
  );
  assert.ok(
    LAWN.rootOcclusion < 1,
    'at 1 this asserts no occlusion at all and the lawn reads flat',
  );
  assert.ok(
    LAWN.rootOcclusionHeight > 0 && LAWN.rootOcclusionHeight < 1,
    'occlusion has to end below the tip, or the whole blade is shaded by it',
  );
  // It compounds with the bottom-to-top colour gradient, which already darkens
  // a root. Both at once is what turns depth into mud.
  assert.ok(
    LAWN.rootOcclusion >= 0.5,
    `${LAWN.rootOcclusion} on top of the colour gradient is a blade with a ` +
      'black foot rather than an occluded one',
  );
  assert.ok(
    LAWN.rootOcclusionHeight <= 0.5,
    'occlusion past half a blade is a gradient, not a contact shadow',
  );
});

test('dry patches are a patch signal, and a blade only modulates it', () => {
  assert.ok(LAWN.dryOnset < LAWN.dryFull, 'the dry window is ordered');
  assert.ok(LAWN.dryOnset >= 0 && LAWN.dryFull <= 1, 'it is a unit signal');
  assert.ok(
    LAWN.dryStrength > 0 && LAWN.dryStrength < 1,
    'a maintained lawn browns; it does not turn to hay',
  );
  assert.ok(
    LAWN.groundDryStrength <= LAWN.dryStrength,
    'ground drier than the blades standing in it is a two-tone horizon',
  );
  // The one that matters. The scatter is a multiplier on the patch and never a
  // signal of its own, so a blade in green turf multiplies zero -- which is
  // what separates correlated dry patches from independently yellow blades.
  assert.ok(LAWN.dryScatter >= 0, 'a negative scatter mirrors the patch');
  assert.ok(
    LAWN.dryScatter < 1,
    `a scatter of ${LAWN.dryScatter} lets a blade fall to zero dryness inside ` +
      'a fully dry patch, which reads as noise rather than as ground',
  );
});

test('transmitted light is a rim, and it never lights the root', () => {
  assert.ok(LAWN.backscatter > 0, 'zero transmission is a reflective blade');
  assert.ok(
    LAWN.backscatter < 1,
    'a backlit tip brightens; past 1 the blade is a light source',
  );
  assert.ok(
    LAWN.backscatterPower >= 1,
    `an exponent of ${LAWN.backscatterPower} spreads the forward lobe wider ` +
      'than the hemisphere it is meant to shape',
  );

  // The term is gated on the blade, not on the camera. `backscatterView` is
  // how much of it the shared `dot(-light, view)` lobe carries: at 1 the whole
  // term is that lobe again, which is the bug this replaced -- for a
  // directional sun both vectors are the same across the lawn, so a yaw lit or
  // unlit every tip on screen together rather than the blades the sun was
  // actually behind.
  assert.ok(
    LAWN.backscatterView >= 0 && LAWN.backscatterView < 1,
    `a view weight of ${LAWN.backscatterView} leaves nothing that survives ` +
      'looking away from the sun, which is the whole-lawn coupling to camera ' +
      'yaw this term was rewritten to remove',
  );

  // Beer-Lambert over thickness/cosine. Zero makes the crossing free, so a
  // blade edge-on to the sun transmits as readily as one square to it and the
  // term stops reading as tissue.
  assert.ok(
    LAWN.backscatterAbsorb > 0,
    'a blade that absorbs nothing is not a blade of tissue',
  );
  const throughAt = (cosine) =>
    cosine * Math.exp(-LAWN.backscatterAbsorb / cosine);
  assert.ok(
    throughAt(1) * LAWN.backscatter < 1,
    'even square to the sun a blade may not become a light source',
  );
  assert.ok(
    throughAt(0.5) < throughAt(1) * 0.6,
    `a blade at 60 degrees passes ${throughAt(0.5).toFixed(3)} against ` +
      `${throughAt(1).toFixed(3)} square on, which is not a slant worth ` +
      'modelling',
  );

  // The one that is arithmetic rather than taste. Root occlusion darkens the
  // bottom `rootOcclusionHeight` of a blade because it is buried in its
  // neighbours; transmission must not start until above that, or the blade
  // lights up brightest exactly where the other term just said no light
  // reaches it.
  assert.ok(
    LAWN.backscatterTip >= LAWN.rootOcclusionHeight,
    `transmission starts at ${LAWN.backscatterTip} of a blade but occlusion ` +
      `runs to ${LAWN.rootOcclusionHeight}, so the two overlap and the base ` +
      'glows where it was just darkened',
  );
  assert.ok(
    LAWN.backscatterTip < 1,
    'transmission confined to the last point of a blade is invisible',
  );
});

test('the culling sphere is derived from the bend, not from a lucky constant', () => {
  // `bladeCullRadiusFactor` replaced a literal 0.58 in the cull pass. It has
  // to reproduce it at the shipped bend, or this is a behaviour change wearing
  // a refactor's clothes.
  assert.ok(Math.abs(bladeCullRadiusFactor(LAWN.maxBend) - 0.58) < 0.001);
  assert.equal(BLADE_CULL_CENTRE, CULL_CENTRE);

  // And it has to keep holding as the bend dial moves, which is the whole
  // point: the literal was correct for one `maxBend` and silently wrong for
  // every other, and the failure it produces -- blades culled while still on
  // screen -- cannot be seen in a still frame.
  for (const maxBend of [0.2, LAWN.maxBend, 0.825, 1.1, 1.6, 2.2]) {
    const radius = bladeCullRadiusFactor(maxBend);
    for (const bend of range(LAWN.minBend, maxBend, 24)) {
      for (const along of range(0, 1, 128)) {
        const { rise, reach } = bladeArc(bend, along);
        const distance = Math.hypot(reach, rise - CULL_CENTRE);
        assert.ok(
          distance <= radius,
          `at maxBend ${maxBend}, a blade bent ${bend.toFixed(3)} reaches ` +
            `${distance.toFixed(4)} against the ${radius.toFixed(4)} allowed`,
        );
      }
    }
  }

  // Monotonic, or the dial could shrink the sphere while lengthening the blade.
  let previous = 0;
  for (const maxBend of [0.1, 0.4, 0.55, 0.9, 1.4, 2]) {
    const radius = bladeCullRadiusFactor(maxBend);
    assert.ok(radius > previous, 'a harder bend cannot want a smaller sphere');
    previous = radius;
  }
});


test('compact ribbon vertices stay inside unchanged curved-blade culling bounds', () => {
  const near = GRASS_RINGS.find(ring => ring.id === 'near');
  assert.equal(near.ribbon, true);
  const geometry = createBladeGeometry(near.segments, 4, near);
  const positions = geometry.attributes.position;
  const offset = LAWN.tillerSpread * .5;
  for (const sizeScale of [.65, 1]) {
    for (const height of [LAWN.minHeight * sizeScale, LAWN.maxHeight * sizeScale]) {
      for (const width of [LAWN.minWidth * sizeScale, LAWN.maxWidth * sizeScale]) {
        for (const bend of range(LAWN.minBend, LAWN.maxBend, 8)) {
          const radius = height * bladeCullRadiusFactor(LAWN.maxBend) +
            width * .5 * LAWN.maxThicken + offset;
          for (const shorten of [LAWN.tillerShortest * LAWN.clumpShortest, 1]) {
            for (let vertex = 0; vertex < positions.count; vertex++) {
              const x = positions.getX(vertex), y = positions.getY(vertex);
              assert.ok(Math.abs(x) <= .5 && y >= 0 && y <= 1);
              const { rise, reach } = bladeArc(bend, y);
              // Bound every crown-offset direction by its maximum length.
              // A rigid rotation into any sloped ground frame keeps this norm.
              const distance = Math.hypot(x * width * LAWN.maxThicken,
                rise * height * shorten - BLADE_CULL_CENTRE * height,
                reach * height * shorten) + offset;
              assert.ok(distance <= radius + 1e-12,
                `ribbon ${vertex} escaped its existing crown sphere`);
            }
          }
        }
      }
    }
  }
  geometry.dispose();
});
