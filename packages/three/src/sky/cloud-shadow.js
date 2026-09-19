import * as THREE from 'three/webgpu';

const { Fn, float, mix, vec2, vec4, uvec2, uniform, instanceIndex,
  texture, storageTexture, positionWorld } = THREE.TSL;

// Cloud shadows. For every point of a square of ground around the observer the
// sky marches how much of the sun's direct beam gets down through the cloud
// layer, and it hands the host a node that looks that up for any world
// position; the host multiplies its sun by it (`docs/sky.md` has the lines
// that do it through the light's shadow). This file is the map's geometry and
// its schedule, as plain arithmetic that `node --test` can read, and the GPU
// plumbing that follows them. The march itself is `clouds.js`'s, because it
// reads the same cloud field the sky is drawn from.
//
// The map is of the cloud field, not of the ground. The field never does
// anything but drift -- the density model has no other motion -- so a map
// marched once stays exact, read a little further along each frame, until the
// ground in view has drifted or walked out of it. A steady frame marches
// nothing, and the lookup where the shadows are drawn is one texture read and
// two multiply-adds: everything but the position is folded into two uniforms
// on the CPU, and the map's fading edge is marched into the map itself.

/** The direction the cloud field drifts in: along +x, and 0.32 of that along
 *  +z. The sky's march, its display and the shadows all read it here, so the
 *  shadows cannot drift one way while the clouds overhead drift another. */
export const WIND_Z = 0.32;

export const CLOUD_SHADOW = Object.freeze({
  /** Texels along each side. */
  resolution: 256,
  /** Kilometres along each side: 20 m texels. A cloud's shadow has no edge
   *  sharper than the sun's own width, 0.53 degrees, makes it: 17 m from a
   *  base 1.8 km up the ray at the demo's 49-degree sun and 33 m from a top
   *  3.5 km up. The march reads the cloud's body at its crispest, and a 20 m
   *  texel, filtered, blurs that edge by about as much as the sun does; read
   *  back, a shadow's edge spans three texels. */
  extentKm: 5.12,
  /** Once the observer's field point is this far from the map's centre, in
   *  either axis, the next map is marched behind the displayed one, a slice a
   *  frame, and swapped in whole. At the package's default 12 m/s wind that
   *  is every 40 seconds or so, for about a second; at the demo's 4 m/s,
   *  every two minutes. */
  recentreKm: 0.5,
  /** Four rows a slice: 0.053 ms in a frame that marches one, measured on an
   *  integrated laptop GPU, so a whole map is about 3.4 ms. */
  slices: 64,
  /** ...and past this, because the observer jumped or the frames came too
   *  slowly for the slices to keep up, the whole map is marched at once. */
  jumpKm: 0.8,
  /** The outer band of the map fades to no shadow, reaching none at the last
   *  texel, so the edge clamp reads no shadow beyond the map rather than
   *  smearing its last texel out to the horizon. */
  fadeKm: 0.2,
  /** The sun-ward march: 50 m steps, as the sky's own, from 16 to 64 of them. */
  targetStepKm: 0.05,
  minSteps: 16,
  maxSteps: 64,
  /** Optical depth past which what is left of the beam (e^-8, 0.03%) does not
   *  show, so the march stops. */
  opaqueDepth: 8,
  /** Shadows are cast by a sun no lower than about 3 degrees: nearer the
   *  horizon the projection onto the ground runs away to infinity. */
  minSunHeight: 0.05,
});

export const SHADOW_TEXEL_KM = CLOUD_SHADOW.extentKm / CLOUD_SHADOW.resolution;

/** Everything this close to the observer, in kilometres, is shadowed from a
 *  complete map after every update: the schedule never lets the observer's
 *  field point get further than `jumpKm` from the displayed map's centre, and
 *  the full-strength part of the map reaches `extentKm / 2 - fadeKm` from it.
 *  1.56 km, past the demo's 1.45 km far plane. */
export const SHADOW_REACH_KM =
  (CLOUD_SHADOW.extentKm * 500 - CLOUD_SHADOW.fadeKm * 1000 - CLOUD_SHADOW.jumpKm * 1000) / 1000;

/** How far the cloud field has drifted after `seconds` of wind at `windSpeed`
 *  m/s, in km (x, z). A world point sees the field point `world + drift`. */
export function cloudDrift(seconds, windSpeed) {
  const km = (seconds * windSpeed) / 1000;
  return [km, km * WIND_Z];
}

/** The sun the shadows are cast from: the sky's, raised to `minSunHeight`. */
export function shadowCastDirection([x, y, z]) {
  const up = Math.max(y, CLOUD_SHADOW.minSunHeight);
  const length = Math.hypot(x, up, z);
  return [x / length, up / length, z / length];
}

/** The point on the ground (y = 0, in km) whose ray to the sun passes through
 *  a world position in metres. Everything on that ray below the clouds sees
 *  the same clouds between it and the sun, so one map of the ground serves a
 *  blade tip, a hillside and anything a host stands on it. */
export function shadowGround([x, y, z], cast) {
  const run = (y / 1000) / cast[1];
  return [x / 1000 - cast[0] * run, z / 1000 - cast[2] * run];
}

/** How far a point's map position runs per metre of height: the sun's
 *  horizontal direction over its height, the per-sun half of `shadowGround`. */
export function shadowSlope(cast) {
  return [cast[0] / cast[1], cast[2] / cast[1]];
}

/** The map coordinates of world (0, 0, 0): the per-frame half of `shadowUV`. */
export function shadowOffset(drift, centre) {
  return [
    (drift[0] - centre[0]) / CLOUD_SHADOW.extentKm + 0.5,
    (drift[1] - centre[1]) / CLOUD_SHADOW.extentKm + 0.5,
  ];
}

/** Map coordinates of a world position in metres, for a map centred on field
 *  point `centre` (km) and a field that has drifted by `drift` (km). Written
 *  as the shader has it: position times a constant, plus the two halves. */
export function shadowUV([x, y, z], cast, drift, centre) {
  const slope = shadowSlope(cast);
  const offset = shadowOffset(drift, centre);
  const scale = 0.001 / CLOUD_SHADOW.extentKm;
  return [(x - slope[0] * y) * scale + offset[0], (z - slope[1] * y) * scale + offset[1]];
}

/** How much of the march a texel keeps, at map coordinates: all of it inside,
 *  none at the last texel, fading over the outer `fadeKm`. The rest is no
 *  shadow, so beyond the map the edge clamp reads none. */
export function shadowWeight([u, v]) {
  const half = CLOUD_SHADOW.extentKm / 2;
  const edge = half - SHADOW_TEXEL_KM / 2;
  const away = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * CLOUD_SHADOW.extentKm;
  const t = Math.min(1, Math.max(0, (away - (half - CLOUD_SHADOW.fadeKm)) / (edge - (half - CLOUD_SHADOW.fadeKm))));
  return 1 - t * t * (3 - 2 * t);
}

/** Steps for a sun-ward path of `pathKm` through the layer. */
export function shadowSteps(pathKm) {
  const { targetStepKm, minSteps, maxSteps } = CLOUD_SHADOW;
  return Math.min(maxSteps, Math.max(minSteps, Math.ceil(pathKm / targetStepKm)));
}

/** Where a new map is centred for an observer on field point `field`: on the
 *  texel grid, so consecutive maps sample the same field points and swapping
 *  one for the next changes nothing on screen. */
export function shadowCentreFor([x, z]) {
  const texel = SHADOW_TEXEL_KM;
  return [Math.round(x / texel) * texel, Math.round(z / texel) * texel];
}

/**
 * When to march a new map, with no GPU in it, so that the reach it promises can
 * be tested by simulation. `next()` is told the observer's field point each
 * frame and answers with the work to do, or null: a slice of the next map, or
 * the whole of it at once. Either way the map is shown the moment its last
 * texel has been marched, never before.
 */
export class CloudShadowSchedule {
  constructor() {
    this.shown = null;
    this.marching = null;
    this.slice = 0;
  }

  /** A complete map centred on `centre` is on display. */
  show(centre) {
    this.shown = centre;
    this.marching = null;
    this.slice = 0;
  }

  next(field) {
    if (this.shown === null) return null;
    const { jumpKm, recentreKm, slices } = CLOUD_SHADOW;
    const off = Math.max(Math.abs(field[0] - this.shown[0]), Math.abs(field[1] - this.shown[1]));
    if (off > jumpKm) {
      const centre = shadowCentreFor(field);
      this.show(centre);
      return { centre, full: true, first: true, last: true };
    }
    if (this.marching === null) {
      if (off <= recentreKm) return null;
      this.marching = shadowCentreFor(field);
    }
    const step = {
      centre: this.marching,
      full: false,
      slice: this.slice,
      first: this.slice === 0,
      last: this.slice === slices - 1,
    };
    this.slice += 1;
    if (step.last) this.show(step.centre);
    return step;
  }
}

function shadowTexture(size, name) {
  const t = new THREE.StorageTexture(size, size);
  t.name = name;
  // RGBA16F, as the sky's own cache, for storage and filtering on baseline
  // WebGPU. Only R is used.
  t.type = THREE.HalfFloatType;
  t.format = THREE.RGBAFormat;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = t.mipmapsAutoUpdate = false;
  return t;
}

/**
 * The GPU half: two maps, one shown while the other is marched, and the node a
 * light is multiplied by.
 *
 * @param {object} options
 * @param {THREE.WebGPURenderer} options.renderer
 * @param {Node} options.sunDirection The sky's sun, a unit vec3 uniform. Read
 *   at each bake, which is the only time it changes.
 * @param {(ground: Node, cast: Node) => Node} options.transmittanceAt The
 *   sun's beam that reaches a field point on the ground (a vec2 in km) along
 *   `cast`, from `clouds.js`.
 */
export function createCloudShadowMap({ renderer, sunDirection, transmittanceAt }) {
  const { resolution, extentKm, slices, fadeKm } = CLOUD_SHADOW;
  const rows = resolution / slices;
  const maps = [0, 1].map(i => shadowTexture(resolution, `Cloud shadow ${i}`));
  const shown = texture(maps[0]);
  const destination = storageTexture(maps[1]);
  const target = uniform(new THREE.Vector2());
  const slice = uniform(0, 'uint');
  const cast = uniform(new THREE.Vector3(0, 1, 0));
  const slope = uniform(new THREE.Vector2());
  const offset = uniform(new THREE.Vector2());
  const ready = uniform(0);

  const makePass = full => Fn(() => {
    const coord = full
      ? uvec2(instanceIndex.mod(resolution), instanceIndex.div(resolution))
      : uvec2(instanceIndex.mod(resolution), instanceIndex.div(resolution).add(slice.mul(rows)));
    const uv = vec2(coord).add(0.5).div(resolution);
    const ground = uv.sub(0.5).mul(extentKm).add(target);
    // `shadowWeight`, marched into the texel.
    const away = uv.sub(0.5).abs();
    const weight = away.x.max(away.y).mul(extentKm)
      .smoothstep(extentKm / 2 - fadeKm, extentKm / 2 - SHADOW_TEXEL_KM / 2).oneMinus();
    const transmittance = mix(float(1), transmittanceAt(ground, cast), weight);
    destination.store(coord, vec4(transmittance, 0, 0, 1)).toWriteOnly();
  })().compute(full ? resolution * resolution : resolution * rows, [64])
    .setName(full ? 'March cloud shadow map' : 'March cloud shadow map slice');
  const fullPass = makePass(true);
  const slicePass = makePass(false);

  // `shadowUV`, transcribed. Before the first map is marched, no shadow.
  const shadowNode = (worldPosition = positionWorld) => {
    const uv = worldPosition.xz.sub(slope.mul(worldPosition.y))
      .mul(0.001 / extentKm).add(offset);
    return shown.sample(uv).level(0).r.max(ready.oneMinus());
  };

  const schedule = new CloudShadowSchedule();
  let displayed = 0;
  let centre = [0, 0];
  let disposed = false;
  const stats = {
    resolution, extentKm, texelKm: SHADOW_TEXEL_KM, reachKm: SHADOW_REACH_KM,
    bytes: resolution * resolution * 8 * 2,
    computeNodeIds: [fullPass.id, slicePass.id],
    generation: 0,
    /** Field point (x, z) in km the displayed map is centred on. */
    centreKm: [0, 0],
  };

  // Marching always goes into the map that is not shown, so a frame never
  // reads one half-written.
  const aim = at => {
    destination.value = maps[1 - displayed];
    target.value.set(at[0], at[1]);
  };
  const flip = at => {
    displayed = 1 - displayed;
    shown.value = maps[displayed];
    centre = at;
    stats.centreKm = [at[0], at[1]];
    stats.generation += 1;
  };
  // In doubles here, not in the shader, where hours of drift would cost the
  // lookup its precision.
  const place = drift => offset.value.set(...shadowOffset(drift, centre));
  const field = (observerKm, drift) => [observerKm[0] + drift[0], observerKm[1] + drift[1]];

  return {
    shadowNode,
    stats,
    /** March a whole map around the observer, under the sky's current sun, and
     *  show it. `observerKm` and `drift` are (x, z) in km. */
    async bake(observerKm, drift) {
      if (disposed) return;
      const sun = sunDirection.value;
      const direction = shadowCastDirection([sun.x, sun.y, sun.z]);
      cast.value.set(...direction);
      slope.value.set(...shadowSlope(direction));
      const at = shadowCentreFor(field(observerKm, drift));
      aim(at);
      await renderer.computeAsync(fullPass);
      if (disposed) return;
      flip(at);
      schedule.show(at);
      place(drift);
      ready.value = 1;
    },
    /** This frame's share of the work. */
    update(observerKm, drift) {
      if (disposed) return;
      const step = schedule.next(field(observerKm, drift));
      if (step !== null) {
        if (step.first) aim(step.centre);
        if (step.full) {
          renderer.compute(fullPass);
        } else {
          slice.value = step.slice;
          renderer.compute(slicePass);
        }
        // Queue order finishes the march before the frame that reads it.
        if (step.last) flip(step.centre);
      }
      place(drift);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ready.value = 0;
      fullPass.dispose();
      slicePass.dispose();
      maps.forEach(map => map.dispose());
    },
  };
}
