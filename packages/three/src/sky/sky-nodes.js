import * as THREE from 'three/webgpu';

import {
  ATMOSPHERE,
  SKY_LUT,
  SUN_ANGULAR_RADIUS,
  sunDirectionFrom,
} from './atmosphere.js';

const {
  Fn,
  If,
  Loop,
  cameraPosition,
  float,
  fog,
  instanceIndex,
  normalWorldGeometry,
  normalize,
  positionWorld,
  rangeFogFactor,
  select,
  storage,
  textureLevel,
  textureStore,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4,
} = THREE.TSL;

/**
 * How finely the lighting probe samples the hemisphere, per axis. 32 x 32
 * cosine-weighted directions, once, reading the table the sky itself renders
 * from -- so the lights cannot drift from the sky above them.
 */
const PROBE_AXIS = 32;

/** `renderer._attributes` outlives the buffer otherwise, as the lawn found. */
function releaseStorageBuffer(renderer, attribute) {
  renderer._attributes?.delete(attribute);
}

/**
 * The TSL twin of `atmosphere.js`.
 *
 * Every constant and every mapping in this file is transcribed from that
 * module, which is where they are written down and tested. Nothing here should
 * introduce a number of its own: when the two disagree the scalar side is
 * right, because it is the one `node --test` can read.
 *
 * Three tables are baked once, at startup, by three compute passes:
 *
 *   transmittance   256 x 64    how much of the beam survives a given ray
 *   multiScatter     32 x 32    the light that has bounced more than once
 *   skyView         256 x 144   in-scattered radiance for this sun and eye
 *
 * 424 KiB of RGBA16F between them. The steady-state cost of the sky is then
 * one bilinear fetch of `skyView` per background pixel and one per fogged
 * fragment -- the 48-step raymarch happens 36,864 times at startup and never
 * again, because the sun does not move and a metre of eye height is nothing
 * against a hundred kilometres of air. Move the sun and only the third table
 * is rebuilt.
 */

const BOTTOM = float(ATMOSPHERE.bottomRadius);
const TOP = float(ATMOSPHERE.topRadius);
const H_CHORD = float(
  Math.sqrt(
    ATMOSPHERE.topRadius * ATMOSPHERE.topRadius -
      ATMOSPHERE.bottomRadius * ATMOSPHERE.bottomRadius,
  ),
);
const RAYLEIGH = vec3(...ATMOSPHERE.rayleighScattering);
const OZONE = vec3(...ATMOSPHERE.ozoneAbsorption);
const GROUND_ALBEDO = vec3(...ATMOSPHERE.groundAlbedo);
const SOLAR = vec3(...ATMOSPHERE.solarIrradiance);
const ISOTROPIC_PHASE = float(1 / (4 * Math.PI));

const toTexCoord = (x, size) => x.mul(1 - 1 / size).add(0.5 / size);
const fromTexCoord = (u, size) => u.sub(0.5 / size).div(1 - 1 / size);

// --- the medium ------------------------------------------------------------

/** Rayleigh, Mie and ozone densities, packed as one vec3. */
const densitiesAt = Fn(([height]) => {
  const h = height.max(0).toVar();
  return vec3(
    h.div(ATMOSPHERE.rayleighScaleHeight).negate().exp(),
    h.div(ATMOSPHERE.mieScaleHeight).negate().exp(),
    h
      .sub(ATMOSPHERE.ozoneCentre)
      .abs()
      .div(ATMOSPHERE.ozoneWidth)
      .oneMinus()
      .max(0),
  );
});

const extinctionAt = Fn(([height]) => {
  const d = densitiesAt(height).toVar();
  return RAYLEIGH.mul(d.x)
    .add(vec3(d.y.mul(ATMOSPHERE.mieExtinction)))
    .add(OZONE.mul(d.z));
});

// --- ray geometry ----------------------------------------------------------

const distanceToTop = Fn(([r, mu]) => {
  const discriminant = r.mul(r).mul(mu.mul(mu).sub(1)).add(TOP.mul(TOP));
  return discriminant.max(0).sqrt().sub(r.mul(mu)).max(0);
});

/** Distance to the ground, or -1 where the ray misses it. */
const distanceToGround = Fn(([r, mu]) => {
  const discriminant = r
    .mul(r)
    .mul(mu.mul(mu).sub(1))
    .add(BOTTOM.mul(BOTTOM))
    .toVar();
  return select(
    discriminant.greaterThanEqual(0).and(mu.lessThan(0)),
    r.mul(mu).add(discriminant.max(0).sqrt()).negate().max(0),
    float(-1),
  );
});

const marchLength = Fn(([r, mu]) => {
  const ground = distanceToGround(r, mu).toVar();
  return select(ground.greaterThanEqual(0), ground, distanceToTop(r, mu));
});

const radiusAt = Fn(([r, mu, d]) =>
  d.mul(d).add(r.mul(mu).mul(d).mul(2)).add(r.mul(r)).max(0).sqrt(),
);

// --- phase functions -------------------------------------------------------

const rayleighPhase = Fn(([cosTheta]) =>
  cosTheta
    .mul(cosTheta)
    .add(1)
    .mul(3 / (16 * Math.PI)),
);

/** Cornette-Shanks, as in the scalar twin. */
const miePhase = Fn(([cosTheta]) => {
  const g = ATMOSPHERE.mieAnisotropy;
  const k = (3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g));
  const denominator = float(1 + g * g)
    .sub(cosTheta.mul(2 * g))
    .max(1e-4)
    .pow(1.5);
  return cosTheta.mul(cosTheta).add(1).mul(k).div(denominator.max(1e-4));
});

// --- table parameterizations ----------------------------------------------

const transmittanceUV = Fn(([r, mu]) => {
  const rho = r.mul(r).sub(BOTTOM.mul(BOTTOM)).max(0).sqrt().toVar();
  const d = distanceToTop(r, mu).toVar();
  const dMin = TOP.sub(r);
  const dMax = rho.add(H_CHORD);
  return vec2(
    toTexCoord(
      d.sub(dMin).div(dMax.sub(dMin).max(1e-6)).clamp(0, 1),
      SKY_LUT.transmittance.width,
    ),
    toTexCoord(rho.div(H_CHORD).clamp(0, 1), SKY_LUT.transmittance.height),
  );
});

/** Returns (r, mu). */
const transmittanceParams = Fn(([uv]) => {
  const rho = fromTexCoord(uv.y, SKY_LUT.transmittance.height)
    .clamp(0, 1)
    .mul(H_CHORD)
    .toVar();
  const r = rho.mul(rho).add(BOTTOM.mul(BOTTOM)).sqrt().toVar();
  const dMin = TOP.sub(r);
  const dMax = rho.add(H_CHORD);
  const d = dMin
    .add(
      fromTexCoord(uv.x, SKY_LUT.transmittance.width)
        .clamp(0, 1)
        .mul(dMax.sub(dMin)),
    )
    .toVar();
  const mu = select(
    d.lessThanEqual(1e-6),
    float(1),
    H_CHORD.mul(H_CHORD)
      .sub(rho.mul(rho))
      .sub(d.mul(d))
      .div(r.mul(d).max(1e-6).mul(2))
      .clamp(-1, 1),
  );
  return vec2(r, mu);
});

const multiScatterUV = Fn(([r, muSun]) =>
  vec2(
    toTexCoord(muSun.mul(0.5).add(0.5).clamp(0, 1), SKY_LUT.multiScatter.width),
    toTexCoord(
      r
        .sub(BOTTOM)
        .div(ATMOSPHERE.topRadius - ATMOSPHERE.bottomRadius)
        .clamp(0, 1),
      SKY_LUT.multiScatter.height,
    ),
  ),
);

/** Returns (r, muSun). */
const multiScatterParams = Fn(([uv]) =>
  vec2(
    fromTexCoord(uv.x, SKY_LUT.multiScatter.width)
      .clamp(0, 1)
      .mul(2)
      .sub(1)
      .clamp(-1, 1),
    BOTTOM.add(
      fromTexCoord(uv.y, SKY_LUT.multiScatter.height)
        .clamp(0, 1)
        .mul(ATMOSPHERE.topRadius - ATMOSPHERE.bottomRadius),
    ),
  ),
);

/**
 * `mu` is the view cosine against up, `cosAzimuth` the view and sun flattened
 * onto the ground and dotted. Columns bunch towards the sun, rows towards the
 * horizon; only the upper hemisphere is stored, because at a 1.7 m eye
 * everything below it is ground within a few metres.
 */
const skyViewUV = Fn(([mu, cosAzimuth]) => {
  const zenith = mu.clamp(-1, 1).acos().toVar();
  const azimuth = cosAzimuth.clamp(-1, 1).acos().toVar();
  const upward = zenith.div(Math.PI / 2).clamp(0, 1);
  return vec2(
    toTexCoord(azimuth.div(Math.PI).clamp(0, 1).sqrt(), SKY_LUT.skyView.width),
    toTexCoord(
      upward.oneMinus().max(0).sqrt().oneMinus(),
      SKY_LUT.skyView.height,
    ),
  );
});

/** Returns (mu, sinZenith, cosAzimuth). */
const skyViewParams = Fn(([uv]) => {
  const x = fromTexCoord(uv.x, SKY_LUT.skyView.width).clamp(0, 1).toVar('skyX');
  const y = fromTexCoord(uv.y, SKY_LUT.skyView.height)
    .clamp(0, 1)
    .toVar('skyY');
  const azimuth = x.mul(x).mul(Math.PI).toVar('skyAzimuthOut');
  const oneMinusY = y.oneMinus().toVar('skyOneMinusY');
  const zenith = oneMinusY
    .mul(oneMinusY)
    .oneMinus()
    .mul(Math.PI / 2)
    .toVar('skyZenithOut');
  return vec3(zenith.cos(), zenith.sin(), azimuth.cos());
});

// --- the passes ------------------------------------------------------------

function createLUT(width, height, name) {
  const lut = new THREE.StorageTexture(width, height);
  lut.name = name;
  lut.type = THREE.HalfFloatType;
  lut.format = THREE.RGBAFormat;
  lut.minFilter = THREE.LinearFilter;
  lut.magFilter = THREE.LinearFilter;
  lut.wrapS = THREE.ClampToEdgeWrapping;
  lut.wrapT = THREE.ClampToEdgeWrapping;
  lut.generateMipmaps = false;
  lut.mipmapsAutoUpdate = false;
  return lut;
}

/**
 * The single dependency-free knot in the whole system: every sun-facing term
 * asks this, and it is zero the moment the planet is in the way. Without that
 * test the sky lights itself from below the horizon.
 */
const sunTransmittanceFrom = (lut) =>
  Fn(([r, muSun]) =>
    select(
      distanceToGround(r, muSun).greaterThanEqual(0),
      vec3(0),
      textureLevel(lut, transmittanceUV(r, muSun), 0).rgb,
    ),
  );

export function createFieldSky({
  renderer,
  sunElevation,
  sunAzimuth,
  exposure = 1,
  multiScatter = 1,
  eyeHeightKm = 0.0017,
}) {
  const transmittanceLUT = createLUT(
    SKY_LUT.transmittance.width,
    SKY_LUT.transmittance.height,
    'Sky transmittance LUT',
  );
  const multiScatterLUT = createLUT(
    SKY_LUT.multiScatter.width,
    SKY_LUT.multiScatter.height,
    'Sky multiple-scattering LUT',
  );
  const skyViewLUT = createLUT(
    SKY_LUT.skyView.width,
    SKY_LUT.skyView.height,
    'Sky view LUT',
  );

  const direction = sunDirectionFrom(sunElevation, sunAzimuth);
  const sunDirection = uniform(new THREE.Vector3(...direction));
  const skyExposure = uniform(float(exposure));
  const multiScatterScale = uniform(float(multiScatter));
  const eyeRadius = float(ATMOSPHERE.bottomRadius + Math.max(0, eyeHeightKm));

  const sunTransmittance = sunTransmittanceFrom(transmittanceLUT);

  // -- pass 1: transmittance -----------------------------------------------

  const transmittancePass = Fn(() => {
    const width = SKY_LUT.transmittance.width;
    const texel = uvec2(instanceIndex.mod(width), instanceIndex.div(width));
    const uv = vec2(
      texel.x.toFloat().add(0.5).div(width),
      texel.y.toFloat().add(0.5).div(SKY_LUT.transmittance.height),
    ).toVar('transmittanceUV');
    const params = transmittanceParams(uv).toVar('transmittanceParams');
    const r = params.x.toVar('transmittanceR');
    const mu = params.y.toVar('transmittanceMu');

    const steps = SKY_LUT.transmittance.steps;
    const step = marchLength(r, mu).div(steps).toVar('transmittanceStep');
    const depth = vec3(0).toVar('transmittanceDepth');
    Loop(steps, ({ i }) => {
      const d = i.toFloat().add(0.5).mul(step);
      depth.addAssign(extinctionAt(radiusAt(r, mu, d).sub(BOTTOM)).mul(step));
    });

    textureStore(
      transmittanceLUT,
      texel,
      vec4(depth.negate().exp(), 1),
    ).toWriteOnly();
  })().compute(SKY_LUT.transmittance.width * SKY_LUT.transmittance.height, [
    64,
  ]);

  // -- pass 2: multiple scattering -----------------------------------------

  const multiScatterPass = Fn(() => {
    const width = SKY_LUT.multiScatter.width;
    const texel = uvec2(instanceIndex.mod(width), instanceIndex.div(width));
    const uv = vec2(
      texel.x.toFloat().add(0.5).div(width),
      texel.y.toFloat().add(0.5).div(SKY_LUT.multiScatter.height),
    ).toVar('msUV');
    const params = multiScatterParams(uv).toVar('msParams');
    const muSun = params.x.toVar('msMuSun');
    const r = params.y.toVar('msR');
    const sunHorizontal = muSun
      .mul(muSun)
      .oneMinus()
      .max(0)
      .sqrt()
      .toVar('msSunHorizontal');

    const radiance = vec3(0).toVar('msRadiance');
    const rescattered = vec3(0).toVar('msRescattered');
    const { sqrtSamples, steps } = SKY_LUT.multiScatter;

    // A uniform sphere of directions, marched with an isotropic phase. The two
    // integrals are the second-order radiance and the fraction of a uniform
    // field the medium would scatter again; the series of the second closes
    // the rest of the orders in one divide.
    Loop(sqrtSamples, sqrtSamples, ({ i, j }) => {
      const theta = i
        .toFloat()
        .add(0.5)
        .div(sqrtSamples)
        .mul(2 * Math.PI)
        .toVar('msTheta');
      const phi = j
        .toFloat()
        .add(0.5)
        .div(sqrtSamples)
        .mul(2)
        .oneMinus()
        .clamp(-1, 1)
        .acos()
        .toVar('msPhi');
      const mu = phi.cos().toVar('msMu');
      const sinPhi = phi.sin().toVar('msSinPhi');
      // The sun sits in the XY plane, so only the X component of the direction
      // meets its horizontal part.
      const nu = sinPhi
        .mul(theta.cos())
        .mul(sunHorizontal)
        .add(mu.mul(muSun))
        .clamp(-1, 1)
        .toVar('msNu');

      const length = marchLength(r, mu).toVar('msLength');
      const step = length.div(steps).toVar('msStep');
      const throughput = vec3(1).toVar('msThroughput');

      Loop(steps, ({ i: sample }) => {
        const d = sample.toFloat().add(0.3).mul(step);
        const rd = radiusAt(r, mu, d).toVar('msRd');
        const muSunAt = r
          .mul(muSun)
          .add(d.mul(nu))
          .div(rd.max(1e-6))
          .clamp(-1, 1)
          .toVar('msMuSunAt');
        const densities = densitiesAt(rd.sub(BOTTOM)).toVar('msDensities');
        const scattering = RAYLEIGH.mul(densities.x)
          .add(vec3(densities.y.mul(ATMOSPHERE.mieScattering)))
          .toVar('msScattering');
        const extinction = RAYLEIGH.mul(densities.x)
          .add(vec3(densities.y.mul(ATMOSPHERE.mieExtinction)))
          .add(OZONE.mul(densities.z))
          .max(vec3(1e-9))
          .toVar('msExtinction');
        const stepT = extinction.mul(step).negate().exp().toVar('msStepT');
        // The analytic integral of scattering * transmittance across the step,
        // which stays stable where a midpoint sample does not.
        const integrated = scattering
          .mul(stepT.oneMinus())
          .div(extinction)
          .toVar('msIntegrated');

        radiance.addAssign(
          throughput
            .mul(integrated)
            .mul(sunTransmittance(rd, muSunAt))
            .mul(SOLAR)
            .mul(ISOTROPIC_PHASE),
        );
        rescattered.addAssign(throughput.mul(integrated));
        throughput.mulAssign(stepT);
      });

      // The ground the ray ends on is a Lambertian source of its own, and it
      // is why this table is not neutral: a green planet puts green into the
      // horizon.
      const groundMu = r
        .mul(muSun)
        .add(length.mul(nu))
        .div(BOTTOM)
        .clamp(-1, 1)
        .toVar('msGroundMu');
      radiance.addAssign(
        select(
          distanceToGround(r, mu)
            .greaterThanEqual(0)
            .and(groundMu.greaterThan(0)),
          throughput
            .mul(sunTransmittance(BOTTOM, groundMu))
            .mul(groundMu)
            .mul(GROUND_ALBEDO.div(Math.PI))
            .mul(SOLAR),
          vec3(0),
        ),
      );
    });

    const directions = sqrtSamples * sqrtSamples;
    const L = radiance.div(directions).toVar('msL');
    const f = rescattered.div(directions).toVar('msF');
    textureStore(
      multiScatterLUT,
      texel,
      vec4(L.div(f.oneMinus().max(vec3(1e-4))), 1),
    ).toWriteOnly();
  })().compute(SKY_LUT.multiScatter.width * SKY_LUT.multiScatter.height, [64]);

  // -- pass 3: the sky this sun makes --------------------------------------

  const inScattering = Fn(([mu, sinZenith, cosAzimuth]) => {
    const muSun = sunDirection.y.clamp(-1, 1).toVar('skyMuSun');
    const sunHorizontal = muSun
      .mul(muSun)
      .oneMinus()
      .max(0)
      .sqrt()
      .toVar('skySunHorizontal');
    const nu = sinZenith
      .mul(cosAzimuth)
      .mul(sunHorizontal)
      .add(mu.mul(muSun))
      .clamp(-1, 1)
      .toVar('skyNu');

    const r = eyeRadius;
    const steps = SKY_LUT.skyView.steps;
    const step = marchLength(r, mu).div(steps).toVar('skyStep');
    const phaseR = rayleighPhase(nu).toVar('skyPhaseR');
    const phaseM = miePhase(nu).toVar('skyPhaseM');
    const throughput = vec3(1).toVar('skyThroughput');
    const radiance = vec3(0).toVar('skyRadiance');

    Loop(steps, ({ i }) => {
      const d = i.toFloat().add(0.3).mul(step);
      const rd = radiusAt(r, mu, d).toVar('skyRd');
      const muSunAt = r
        .mul(muSun)
        .add(d.mul(nu))
        .div(rd.max(1e-6))
        .clamp(-1, 1)
        .toVar('skyMuSunAt');
      const densities = densitiesAt(rd.sub(BOTTOM)).toVar('skyDensitiesAt');
      const rayleigh = RAYLEIGH.mul(densities.x).toVar('skyRayleigh');
      const mie = densities.y.mul(ATMOSPHERE.mieScattering).toVar('skyMie');
      const extinction = rayleigh
        .add(vec3(densities.y.mul(ATMOSPHERE.mieExtinction)))
        .add(OZONE.mul(densities.z))
        .max(vec3(1e-9))
        .toVar('skyExtinction');
      const stepT = extinction.mul(step).negate().exp().toVar('skyStepT');
      const ms = textureLevel(
        multiScatterLUT,
        multiScatterUV(rd, muSunAt),
        0,
      ).rgb.toVar('skyMS');

      const source = rayleigh
        .mul(phaseR)
        .add(vec3(mie.mul(phaseM)))
        .mul(sunTransmittance(rd, muSunAt))
        .mul(SOLAR)
        .add(rayleigh.add(vec3(mie)).mul(ms).mul(multiScatterScale))
        .toVar('skySource');

      radiance.addAssign(
        throughput.mul(source).mul(stepT.oneMinus()).div(extinction),
      );
      throughput.mulAssign(stepT);
    });

    return radiance;
  });

  const skyViewPass = Fn(() => {
    const width = SKY_LUT.skyView.width;
    const texel = uvec2(instanceIndex.mod(width), instanceIndex.div(width));
    const uv = vec2(
      texel.x.toFloat().add(0.5).div(width),
      texel.y.toFloat().add(0.5).div(SKY_LUT.skyView.height),
    ).toVar('skyViewUVOut');
    const params = skyViewParams(uv).toVar('skyViewParamsOut');
    textureStore(
      skyViewLUT,
      texel,
      vec4(inScattering(params.x, params.y, params.z), 1),
    ).toWriteOnly();
  })().compute(SKY_LUT.skyView.width * SKY_LUT.skyView.height, [64]);

  // -- pass 4: what the sky lights the ground with -------------------------

  /**
   * A lighting probe, read off the finished sky rather than modelled a second
   * time on the CPU.
   *
   * The scalar twin could compute this -- it has every term -- but doing so
   * costs 450 ms of startup building its own copies of the two tables the GPU
   * has already built, and leaves two implementations of the same integral to
   * drift apart. Sampling the sky-view table instead makes the lights
   * *derived from the sky*, not merely consistent with it: change the medium,
   * the sun or the exposure and they move together by construction.
   *
   * One invocation, 1,024 cosine-weighted directions, once per sun. The
   * cosine weighting is in the sampling rather than the sum, so the hemisphere
   * integral is a plain mean times pi.
   */
  const probeAttribute = new THREE.StorageBufferAttribute(2, 4, Float32Array);
  probeAttribute.name = 'Sky lighting probe';
  const probeStorage = storage(probeAttribute, 'vec4', probeAttribute.count);

  const lightingPass = Fn(() => {
    // Direct sun, transmitted down the whole column to the eye.
    probeStorage
      .element(0)
      .assign(
        vec4(
          sunTransmittance(eyeRadius, sunDirection.y.clamp(-1, 1)).mul(SOLAR),
          1,
        ),
      );

    // Diffuse sky, cosine-weighted over the upper hemisphere.
    const total = vec3(0).toVar('probeTotal');
    Loop(PROBE_AXIS, PROBE_AXIS, ({ i, j }) => {
      const u1 = i.toFloat().add(0.5).div(PROBE_AXIS).toVar('probeU1');
      const u2 = j.toFloat().add(0.5).div(PROBE_AXIS).toVar('probeU2');
      const sinTheta = u1.sqrt().toVar('probeSin');
      const cosTheta = u1.oneMinus().max(0).sqrt().toVar('probeCos');
      const phi = u2.mul(2 * Math.PI).toVar('probePhi');
      const mu = cosTheta;
      // The table is indexed by the azimuth away from the sun, and the probe's
      // own azimuth is measured from the sun's, so phi *is* that angle.
      total.addAssign(
        textureLevel(skyViewLUT, skyViewUV(mu, phi.cos()), 0).rgb,
      );
    });
    probeStorage
      .element(1)
      .assign(vec4(total.mul(Math.PI / (PROBE_AXIS * PROBE_AXIS)), 1));
  })().compute(1, [1]);

  const probeReadback = new THREE.ReadbackBuffer(
    8 * Float32Array.BYTES_PER_ELEMENT,
  );
  probeReadback.name = 'Sky lighting probe readback';

  // --- reading it back -----------------------------------------------------

  /**
   * The azimuth cosine the table is indexed by. Straight up the flattened view
   * has no direction, so it is pinned to 1 and the zenith row stays whole.
   */
  const cosAzimuthToSun = Fn(([direction3]) => {
    const view = vec2(direction3.x, direction3.z).toVar();
    const sun = vec2(sunDirection.x, sunDirection.z).toVar();
    const viewLength = view.length().toVar();
    const sunLength = sun.length().toVar();
    return select(
      viewLength.lessThan(1e-4).or(sunLength.lessThan(1e-4)),
      float(1),
      view.dot(sun).div(viewLength.mul(sunLength).max(1e-6)).clamp(-1, 1),
    );
  });

  /** In-scattered radiance towards a world-space direction, +Y up. */
  const skyRadianceNode = Fn(([direction3]) => {
    const d = normalize(direction3).toVar('skyDirection');
    const uv = skyViewUV(d.y, cosAzimuthToSun(d)).toVar('skyLookupUV');
    return textureLevel(skyViewLUT, uv, 0).rgb.mul(skyExposure);
  });

  /**
   * The solar disk, added on top of the table rather than baked into it: it is
   * a tenth of a degree across and no 256-column table survives being asked
   * for it. Radiance is the irradiance over the disk's solid angle, so its
   * brightness follows from its size rather than being dialled, and the limb
   * darkening is the usual quadratic fit.
   */
  const sunDiskNode = Fn(([direction3]) => {
    const d = normalize(direction3).toVar('sunDiskDirection');
    const cosAngle = d.dot(sunDirection).clamp(-1, 1).toVar('sunDiskCos');
    const edge = float(Math.cos(SUN_ANGULAR_RADIUS));
    const inner = float(Math.cos(SUN_ANGULAR_RADIUS * 0.88));
    const disk = cosAngle.smoothstep(edge, inner).toVar('sunDiskMask');
    const result = vec3(0).toVar('sunDiskRadiance');
    // Gate on the existing smooth mask, preserving its complete soft edge.
    // The atmosphere LUT still supplies the glow outside the solar disk.
    // Its zero-contribution pixels need neither inverse trig nor a second
    // lookup; explicit texture levels make this branch derivative-safe.
    If(disk.greaterThan(0), () => {
      // How far out on the disk this is, as a fraction of its radius.
      const offset = cosAngle
        .acos()
        .div(SUN_ANGULAR_RADIUS)
        .clamp(0, 1)
        .toVar('sunDiskOffset');
      const limb = offset
        .mul(offset)
        .oneMinus()
        .max(0)
        .sqrt()
        .mul(0.6)
        .add(0.4)
        .toVar('sunDiskLimb');
      const radiance = float(
        1 / (Math.PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS),
      );
      result.assign(SOLAR.mul(radiance)
        .mul(disk)
        .mul(limb)
        .mul(sunTransmittance(eyeRadius, sunDirection.y.clamp(-1, 1)))
        .mul(skyExposure));
    });
    return result;
  });

  // The background mesh is an untransformed unit sphere drawn from the inside,
  // so its geometric normal is the world direction the pixel looks along.
  const backgroundNode = skyRadianceNode(normalWorldGeometry).add(
    sunDiskNode(normalWorldGeometry),
  );

  /**
   * Aerial perspective, as far as a linear distance ramp can honestly claim it.
   *
   * Clear-air extinction over 100 m is two parts in a thousand: a ramp is not
   * Rayleigh, it is a stand-in for the humidity and aerosol the model has no
   * business resolving at this scale. So the *shape* stays what it was -- a
   * linear ramp between `near` and `far` -- and only the colour changes, to the
   * sky the fragment is actually standing in front of. That is the whole reason
   * the flat background could not simply be replaced: a blue sky over a green
   * horizon haze reads as a bug, and matching them by hand is what the table
   * already knows.
   */
  const fogNodeFor = ({ near, far }) => {
    const direction = positionWorld.sub(cameraPosition);
    const factor = rangeFogFactor(float(near), float(far)).toVar('fieldFogFactor');
    const radiance = Fn(() => {
      const result = vec3(0).toVar('fieldFogRadiance');
      // Most of an authored site lies inside the haze's near distance. Keep
      // its zero-weight mix exact, and evaluate sky direction/LUT only where
      // fog contributes. The lookup uses an explicit level, not derivatives.
      If(factor.greaterThan(0), () => {
        result.assign(skyRadianceNode(direction));
      });
      return result;
    })();
    return fog(radiance, factor);
  };

  let disposed = false;
  const assertAlive = () => {
    if (disposed) throw new Error('Cannot use a disposed atmosphere.');
  };
  async function dispatch(pass) {
    assertAlive();
    await renderer.computeAsync(pass);
    assertAlive();
  }

  /**
   * Runs the probe and reads it back.
   *
   * `sun` is the direct beam's irradiance on a surface facing it and `sky` is
   * the hemisphere's irradiance on a surface facing up, both in the same model
   * units the sky is rendered in: the sun's irradiance above the atmosphere is
   * 1, so both are fractions of it and both already carry `skyExposure`'s
   * sibling, the raw scattering, but not `skyExposure` itself. The caller
   * decides what a render unit is.
  */
  async function readProbe() {
    await dispatch(lightingPass);
    assertAlive();
    let result;
    try {
      result = await renderer.getArrayBufferAsync(
        probeAttribute,
        probeReadback,
        0,
        8 * Float32Array.BYTES_PER_ELEMENT,
      );
      assertAlive();
      const values = new Float32Array(result.buffer);
      const probe = {
        sun: [values[0], values[1], values[2]],
        sky: [values[4], values[5], values[6]],
      };
      return probe;
    } finally {
      // r185 marks a reusable ReadbackBuffer mapped before awaiting mapAsync,
      // as the lawn's visible-count readback records. Release that state, then
      // let the caller fall back to the authored lights rather than losing the
      // page over a probe.
      if (result) result.release();
      else if (probeReadback._mapped) probeReadback.release();
    }
  }

  let baked = false;

  return {
    sunDirection,
    backgroundNode,
    fogNodeFor,
    skyRadianceNode,
    skyExposure,
    multiScatterScale,

    /**
     * Bakes all three tables and the lighting probe, and returns what the sky
     * lights the ground with. The first two tables never need it again.
    */
    async bake() {
      assertAlive();
      if (!baked) {
        await dispatch(transmittancePass);
        await dispatch(multiScatterPass);
        baked = true;
      }
      await dispatch(skyViewPass);
      return readProbe();
    },

    /** Points the sun somewhere else and rebakes the two things that care. */
    async setSun(elevationDegrees, azimuthDegrees) {
      assertAlive();
      sunDirection.value.set(
        ...sunDirectionFrom(elevationDegrees, azimuthDegrees),
      );
      await dispatch(skyViewPass);
      return readProbe();
    },

    stats: {
      // RGBA16F: four channels, two bytes each.
      bytes:
        (SKY_LUT.transmittance.width * SKY_LUT.transmittance.height +
          SKY_LUT.multiScatter.width * SKY_LUT.multiScatter.height +
          SKY_LUT.skyView.width * SKY_LUT.skyView.height) *
        8,
      passes: 3,
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      transmittancePass.dispose();
      multiScatterPass.dispose();
      skyViewPass.dispose();
      lightingPass.dispose();
      transmittanceLUT.dispose();
      multiScatterLUT.dispose();
      skyViewLUT.dispose();
      probeReadback.dispose();
      releaseStorageBuffer(renderer, probeAttribute);
    },
  };
}
