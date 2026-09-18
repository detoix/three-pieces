import * as THREE from 'three/webgpu';

import {
  GRASS_BACKLIGHT,
  GrassLightingModel,
  normalizeBacklight,
} from './blade-lighting.js';
import { GRASS004_ALBEDO_MEAN, LAWN, LAWN_COLORS } from './preset.js';
import { CANOPY_DETAIL, CANOPY_NORMAL_DETAIL, canopyWeightNode } from './canopy-lod.js';
import {
  LAWN_FLOW_SAMPLE_LEVEL,
  LAWN_FLOW_WORLD_SIZE,
  LAWN_HEALTH_SAMPLE_LEVEL,
  LAWN_HEALTH_WORLD_SIZE,
  LAWN_MACRO_SAMPLE_LEVEL,
  LAWN_MACRO_WORLD_SIZE,
  LAWN_PBR_ASSET,
  LAWN_PBR_FLATTEN_LEVEL,
  LAWN_PBR_SECONDARY_UV_SCALE,
  LAWN_PBR_WORLD_SIZE,
  LAWN_UNDERLAY,
  lawnPBRGPUBytes,
  normalizeLawnUnderlay,
} from './surface-assets.js';

const {
  Fn,
  atan,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  color,
  cross,
  float,
  mix,
  modelWorldMatrix,
  select,
  normalMap,
  normalize,
  positionGeometry,
  positionWorld,
  positionView,
  screenSize,
  smoothstep,
  texture: textureNode,
  textureLevel,
  varying,
  vec2,
  vec3,
  vec4,
} = THREE.TSL;

const SECONDARY_UV_OFFSET = new THREE.Vector2(0.37, 0.19);
const MACRO_UV_OFFSET = new THREE.Vector2(0.23, 0.61);
const HEALTH_UV_OFFSET = new THREE.Vector2(0.71, 0.13);
const FLOW_UV_OFFSET = new THREE.Vector2(0.41, 0.83);
/** Where the flow field's second component is read, in tiles from the first.
 *
 *  A direction needs two numbers and one sample gives one usable channel: a
 *  photograph's red and blue are both dark wherever it is shadowed, so a
 *  vector built from them runs along the diagonal everywhere. Two reads of the
 *  same channel a good way apart are independent instead. */
const FLOW_SECOND_OFFSET = new THREE.Vector2(0.29, 0.57);

/**
 * What a fully dry patch multiplies its colour by.
 *
 * A multiplier rather than a colour to mix towards, because the two things it
 * has to tint -- the blade's own green ramp and the Grass004 albedo under it --
 * are different colours that have to end up the same shade of straw. Red up,
 * green held, blue down is what browning does to both: it is a loss of
 * chlorophyll, not a wash of yellow paint over the top.
 */
const DRY_TINT = new THREE.Vector3(1.34, 1.06, 0.62);

/** Floor on the local mean the flattening divides by.
 *
 *  A photograph has texels near black -- shadow between blades, mostly -- and
 *  a ratio against one of those is a white speck standing in a lawn. */
const GROUND_FLATTEN_FLOOR = 0.03;

/** Cap on that ratio, for the same reason from the other side. */
const GROUND_FLATTEN_CEILING = 3;

/** Shortest flow vector that still names a direction. */
const FLOW_FLOOR = 1e-4;

function configureLawnTexture(texture, { colorSpace, anisotropy, name }) {
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

export async function loadLawnPBRTextures({ loader } = {}) {
  const textureLoader = loader ?? new THREE.TextureLoader();
  const results = await Promise.allSettled([
    textureLoader.loadAsync(LAWN_PBR_ASSET.maps.albedoRoughness.url),
    textureLoader.loadAsync(LAWN_PBR_ASSET.maps.normal.url),
  ]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) {
    for (const result of results) {
      if (result.status === 'fulfilled') result.value.dispose();
    }
    throw failed.reason;
  }
  const [albedoRoughness, normal] = results.map((result) => result.value);
  return { albedoRoughness, normal };
}

/**
 * @param {object} [options]
 * @param {THREE.Renderer} options.renderer Initialized, for its anisotropy.
 * @param {string} [options.underlay] `lawn` or the `solid` control.
 * @param {{albedoRoughness: Texture, normal: Texture}} [options.textures]
 *   Configured in place either way.
 * @param {boolean} [options.ownTextures] Whether surface.dispose() releases the
 *   supplied textures. Defaults to true, transferring them; pass false to keep
 *   them host-owned. Only meaningful with `textures`: loaded maps are always owned.
 * @param {object} [options.greens] The lawn palette, from `lawnColorsFor()`.
 *   Its `groundTint` is what carries the Grass004 albedo from its own hue of
 *   72 degrees onto the palette's, at unchanged luminance -- the asset is a
 *   photograph, so it cannot be recoloured, only multiplied.
 * @param {boolean} [options.projectedProxy] Opt-in projected-size/density canopy A/B.
 * @param {number} [options.proxyBladeWidth] Mean authored blade width in metres,
 *   including any width multiplier the caller applied, before minimum-pixel
 *   widening.
 * @param {Function} [options.heightAt] Optional TSL `worldXZ -> height` function.
 *   When given, both ground materials lift every vertex of a flat XZ grid to it
 *   and shade with its slope, so one camera-following grid can be unbounded
 *   terrain. Omitted, the materials are the flat ones this always built.
 * @param {number} [options.groundNormalStep] Finite-difference distance in
 *   metres for that slope.
 */
export async function createLawnSurface({
  renderer,
  underlay,
  textures,
  ownTextures = true,
  greens = LAWN_COLORS,
  flatten = LAWN.groundFlatten,
  macroTint = 1,
  proxy = 1,
  projectedProxy = false,
  proxyBladeWidth = (LAWN.minWidth + LAWN.maxWidth) * 0.5,
  groundAO = LAWN.groundCanopyAO,
  grainStrength = LAWN.canopyGrain,
  variation = 1,
  backlight = GRASS_BACKLIGHT.blade,
  heightAt = null,
  groundNormalStep = 0.25,
} = {}) {
  if (!renderer || typeof renderer.getMaxAnisotropy !== 'function') {
    throw new TypeError('The lawn surface needs an initialized renderer.');
  }
  if (heightAt !== null && typeof heightAt !== 'function') {
    throw new TypeError('Lawn surface heightAt must be a TSL node function.');
  }
  if (!(Number.isFinite(groundNormalStep) && groundNormalStep > 0)) {
    throw new RangeError('Lawn surface groundNormalStep must be a positive distance.');
  }
  if (typeof ownTextures !== 'boolean') {
    throw new TypeError('Lawn surface ownTextures must be a boolean.');
  }
  // Checked before loading, so a surface that would leak what it loads is
  // refused before it has loaded anything.
  if (!ownTextures && !textures) {
    throw new TypeError(
      'Lawn surface ownTextures: false needs supplied textures; ' +
        'bundled maps it loads itself are always owned.',
    );
  }
  if (!(grainStrength >= 0 && grainStrength <= 1)) {
    throw new RangeError(
      "The canopy grain is how far the far field's normal leans with the " +
        'lawn, in [0, 1]. At 1 it lies on its side.',
    );
  }
  if (!(groundAO > 0 && groundAO <= 1)) {
    throw new RangeError(
      'Ground canopy occlusion is what the ground keeps of an open field, in ' +
        '(0, 1]. At 0 the lawn stands on black.',
    );
  }
  if (!(proxy >= 0 && proxy <= 1)) {
    throw new RangeError(
      'The canopy proxy is a mix weight in [0, 1], from the ground as it is ' +
        'photographed to the grass a distant pixel averages to.',
    );
  }
  if (!(Number.isFinite(proxyBladeWidth) && proxyBladeWidth > 0)) {
    throw new RangeError('Projected canopy needs a positive physical blade width.');
  }
  if (!(flatten >= 0 && flatten <= 1)) {
    throw new RangeError(
      'Flattening the ground is a mix weight in [0, 1], from the photograph ' +
        'as it was shot to the photograph with its own patches divided out.',
    );
  }

  const loaded = textures ?? (await loadLawnPBRTextures());
  if (!loaded?.albedoRoughness?.isTexture || !loaded?.normal?.isTexture) {
    throw new TypeError(
      'The lawn surface needs albedo/roughness and normal textures.',
    );
  }

  const anisotropy = Math.min(8, renderer.getMaxAnisotropy());
  const albedoRoughnessTexture = configureLawnTexture(loaded.albedoRoughness, {
    colorSpace: THREE.SRGBColorSpace,
    anisotropy,
    name: 'Grass004 albedo + roughness',
  });
  const normalTexture = configureLawnTexture(loaded.normal, {
    colorSpace: THREE.NoColorSpace,
    anisotropy,
    name: 'Grass004 OpenGL normal',
  });

  // PlaneGeometry's v axis points towards -Z after it is rotated onto XZ.
  // Matching that orientation keeps the OpenGL tangent-space normal correct.
  const primaryUVAt = Fn(([worldXZ]) =>
    vec2(worldXZ.x, worldXZ.y.negate()).div(LAWN_PBR_WORLD_SIZE),
  );
  const secondaryUVAt = Fn(([worldXZ]) =>
    vec2(worldXZ.y, worldXZ.x)
      .div(LAWN_PBR_WORLD_SIZE)
      .mul(LAWN_PBR_SECONDARY_UV_SCALE)
      .add(SECONDARY_UV_OFFSET),
  );

  // The same source albedo supplies a deliberately coarse world-space signal
  // for both terrain variation and grass appearance. It is sampled explicitly
  // in compute, so placement never depends on fragment derivatives.
  const macroAt = Fn(([worldXZ]) => {
    const macroUV = vec2(worldXZ.x, worldXZ.y.negate())
      .div(LAWN_MACRO_WORLD_SIZE)
      .add(MACRO_UV_OFFSET);
    const macroGreen = textureLevel(
      albedoRoughnessTexture,
      macroUV,
      float(LAWN_MACRO_SAMPLE_LEVEL),
    ).g;
    return smoothstep(float(0.045), float(0.32), macroGreen);
  });

  // The patch signal, at a scale a lawn actually varies on. Same sample as
  // `macroAt` with the tile opened out, so the two disagree about scale and
  // about nothing else. Explicit level, for the same reason: placement reads
  // it in compute, where there are no fragment derivatives to pick a mip from.
  const healthAt = Fn(([worldXZ]) => {
    const healthUV = vec2(worldXZ.x, worldXZ.y.negate())
      .div(LAWN_HEALTH_WORLD_SIZE)
      .add(HEALTH_UV_OFFSET);
    const healthGreen = textureLevel(
      albedoRoughnessTexture,
      healthUV,
      float(LAWN_HEALTH_SAMPLE_LEVEL),
    ).g;
    return smoothstep(float(0.045), float(0.32), healthGreen);
  });

  /**
   * Which way the lawn runs here: a smooth world-space unit direction.
   *
   * A lawn is not a field of independently-pointed blades. Growth, mowing,
   * prevailing wind and drainage all leave a grain that runs over tens of
   * metres, and it is the reason a real lawn changes brightness as you walk
   * round it rather than staying one flat green. `LAWN.flowPull` is how much
   * of a crown's facing this dictates, against its own hash and its clump's.
   *
   * Two reads of the same channel, well apart, because a direction needs two
   * independent numbers -- see `FLOW_SECOND_OFFSET`. Normalized with a floor:
   * the two can both land on the middle of their range, and a lawn has to run
   * *somewhere*.
   */
  const flowAt = Fn(([worldXZ]) => {
    const base = vec2(worldXZ.x, worldXZ.y.negate())
      .div(LAWN_FLOW_WORLD_SIZE)
      .add(FLOW_UV_OFFSET);
    const read = (uv) =>
      smoothstep(
        float(0.045),
        float(0.32),
        textureLevel(albedoRoughnessTexture, uv, float(LAWN_FLOW_SAMPLE_LEVEL))
          .g,
      ).sub(0.5);
    const raw = vec2(read(base), read(base.add(FLOW_SECOND_OFFSET))).toVar(
      'lawnFlowRaw',
    );
    const length = raw.length().toVar('lawnFlowLength');
    return select(
      length.greaterThan(float(FLOW_FLOOR)),
      raw.div(length.max(float(FLOW_FLOOR))),
      vec2(1, 0),
    );
  });

  const tintFrom = Fn(([macro]) =>
    mix(
      vec3(1, 1, 1),
      vec3(
        mix(0.9, 1.06, macro),
        mix(0.94, 1.05, macro),
        mix(0.88, 0.99, macro),
      ),
      float(macroTint),
    ),
  );
  const densityFrom = Fn(([macro]) =>
    mix(float(1 - LAWN.densitySpread * variation), float(1), macro),
  );

  // How dry a place is, from its health. One function, called by the blades
  // and by the ground they stand in: that shared call is the whole point of
  // the signal. Variation the grass has and the terrain does not reads as
  // green grass growing out of unrelated soil, which is the failure this
  // lawn's macro tint already avoids at the metre scale.
  const dryAt = Fn(([health]) =>
    smoothstep(float(LAWN.dryOnset), float(LAWN.dryFull), health.oneMinus()),
  );
  const dryTintFrom = Fn(([dry]) =>
    mix(
      vec3(1, 1, 1),
      vec3(DRY_TINT.x, DRY_TINT.y, DRY_TINT.z),
      dry.clamp(0, 1),
    ),
  );

  // Grass is visually isotropic, so blending a rotated, non-harmonic repeat is
  // an inexpensive way to break the obvious 1.4 m tile without extra assets.
  const pbrAt = Fn(([worldXZ, macro]) => {
    const primary = textureNode(albedoRoughnessTexture, primaryUVAt(worldXZ));
    const secondary = textureNode(
      albedoRoughnessTexture,
      secondaryUVAt(worldXZ),
    );
    return mix(primary, secondary, macro.mul(0.46).add(0.27));
  });

  // The same two samples at a mip level whose texel covers 35 cm: the local
  // level the pair is varying around, at the scale the photograph's own
  // blotches live on. Blended the same way, or the ratio below would be a
  // sample of one lawn over the mean of a differently-weighted one.
  const pbrMeanAt = Fn(([worldXZ, macro]) => {
    const primary = textureLevel(
      albedoRoughnessTexture,
      primaryUVAt(worldXZ),
      float(LAWN_PBR_FLATTEN_LEVEL),
    );
    const secondary = textureLevel(
      albedoRoughnessTexture,
      secondaryUVAt(worldXZ),
      float(LAWN_PBR_FLATTEN_LEVEL),
    );
    return mix(primary, secondary, macro.mul(0.46).add(0.27));
  });

  /**
   * Grass004 with its own patches divided out, at `strength`.
   *
   * The asset is a photograph of a lawn, and it brings that lawn's metre-scale
   * light and dark patches with it. They are the most visible thing in the
   * ground close to the camera -- soft blotches that no blade, clump, dry patch
   * or macro sample here agrees with, because they belong to a different lawn.
   * They also fight the variation this one asserts: `macroAt` and `healthAt`
   * decide where this lawn is lighter, and then the photograph says somewhere
   * else.
   *
   * Dividing the sample by its own local mean keeps every frequency finer than
   * that mean -- the blade-scale detail the asset is actually here for -- and
   * flattens everything coarser to one level, which `tintFrom` and `dryTintFrom`
   * are then free to vary on this lawn's terms. Multiplying the ratio back by
   * the asset's global mean puts the absolute level where it was, so this
   * changes the ground's structure and not its brightness.
   *
   * The divisor is floored and the ratio capped: a photograph has texels near
   * black, and a ratio against one of those is a white speck in a lawn.
   */
  const flattenPBR = Fn(([sample, localMean, strength]) => {
    const ratio = sample
      .div(localMean.max(float(GROUND_FLATTEN_FLOOR)))
      .clamp(0, GROUND_FLATTEN_CEILING);
    return mix(sample, ratio.mul(color(GRASS004_ALBEDO_MEAN)), strength);
  });

  // Terrain displacement, shared by both ground materials. The grid's own XZ
  // is taken to world space by the mesh's transform, which must therefore be
  // a translation: the height is a world height, so the mesh's own Y is
  // subtracted back out. The slope is evaluated per vertex and interpolated.
  const displaced = heightAt
    ? (() => {
        const translation = modelWorldMatrix.element(3);
        const vertexXZ = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xz;
        const step = float(groundNormalStep);
        const left = heightAt(vertexXZ.sub(vec2(groundNormalStep, 0)));
        const right = heightAt(vertexXZ.add(vec2(groundNormalStep, 0)));
        const down = heightAt(vertexXZ.sub(vec2(0, groundNormalStep)));
        const up = heightAt(vertexXZ.add(vec2(0, groundNormalStep)));
        return {
          position: vec3(
            positionGeometry.x,
            heightAt(vertexXZ).sub(translation.y),
            positionGeometry.z,
          ),
          normal: varying(
            normalize(vec3(left.sub(right), step.mul(2), down.sub(up))),
            'vLawnGroundNormal',
          ),
        };
      })()
    : null;

  const solidMaterial = displaced
    ? new THREE.MeshStandardNodeMaterial({ color: greens.ground, roughness: 1, metalness: 0 })
    : new THREE.MeshStandardMaterial({
        color: greens.ground,
        roughness: 1,
        metalness: 0,
      });
  solidMaterial.name = 'Solid lawn underlay control';
  if (displaced) {
    solidMaterial.positionNode = displaced.position;
    solidMaterial.normalNode = displaced.normal.normalize()
      .transformNormalByViewMatrix(cameraViewMatrix);
  }

  const lawnMaterial = new THREE.MeshStandardNodeMaterial({
    metalness: 0,
  });
  lawnMaterial.name = 'World-space Grass004 PBR lawn';
  if (displaced) lawnMaterial.positionNode = displaced.position;
  const worldXZ = positionWorld.xz;
  const macro = macroAt(worldXZ).toVar('lawnSurfaceMacro');
  const pbr = pbrAt(worldXZ, macro).toVar('lawnPbrSample');
  const pbrMean = pbrMeanAt(worldXZ, macro).toVar('lawnPbrLocalMean');
  const ground = flattenPBR(pbr.rgb, pbrMean.rgb, float(flatten)).toVar(
    'lawnGroundAlbedo',
  );
  const textureBlend = macro.mul(0.46).add(0.27);
  const primaryNormal = textureNode(normalTexture, primaryUVAt(worldXZ))
    .rgb.mul(2)
    .sub(1);
  const secondaryNormalRaw = textureNode(normalTexture, secondaryUVAt(worldXZ))
    .rgb.mul(2)
    .sub(1);
  const secondaryNormal = vec3(
    secondaryNormalRaw.y,
    secondaryNormalRaw.x.negate(),
    secondaryNormalRaw.z,
  );
  const packedNormal = mix(primaryNormal, secondaryNormal, textureBlend)
    .normalize()
    .mul(0.5)
    .add(0.5);
  const horizontalDistance = cameraPosition.xz.sub(worldXZ).length();
  // How much of this fragment is grass nobody can resolve rather than ground
  // somebody can see into. See `canopyProxyFrom`: a pixel at 8 m covers 0.6 of
  // a blade and one at 16 m covers 2.7, so past there a pixel is an average of
  // grass; and bare ground measures over 99% past 24 m, so out there this
  // material is the entire lawn. Below the near end this is zero and the
  // ground is the ground.
  // Opt-in A/B: use the actual framebuffer projection and the same retained
  // density as geometry. A fixed distance ramp leaves the ground exposed
  // after near-ring thinning, and changes meaning with resolution/FOV.
  const canopyProxy = (projectedProxy
    ? canopyWeightNode(horizontalDistance, positionView.z.negate().max(1e-4),
        float(proxyBladeWidth),
        float(2).div(cameraProjectionMatrix.element(1).y.mul(screenSize.y.max(1))))
    : smoothstep(
        float(LAWN.canopyProxyFrom),
        float(LAWN.canopyProxyTo),
        horizontalDistance,
      ))
    .mul(float(proxy))
    .toVar('lawnCanopyProxy');
  // The normal map fades on the same ramp rather than on one of its own. It
  // used to fade over 8-24 m by itself, which is the same distances for the
  // same reason -- sub-pixel micro-relief that aliases -- so leaving both in
  // would be two overlapping fades arguing about one thing.
  const normalStrength = projectedProxy
    ? mix(float(0.58), float(CANOPY_NORMAL_DETAIL), canopyProxy)
    : canopyProxy.oneMinus().mul(0.58);
  // The canopy the proxy stands in for is not level. See `LAWN.canopyGrain`:
  // a lawn runs one way over tens of metres, and a canopy leaning with the
  // grain returns light differently from one leaning against it. The blades'
  // own normals are deliberately aggregated towards the ground -- that is what
  // `canopyNormalNear`/`Far` do -- so this is the only place left in the lawn
  // where an orientation can still be seen, and the only place it is not
  // immediately cancelled.
  //
  // A blade leaning one way turns its lit face the other, which is why the
  // lean is subtracted: `bladeNormal` in `grass.js` is
  // `forward * cos(lean) - groundNormal * sin(lean)`, so the face the eye sees
  // tips away from the direction the blade bends.
  // A strength of zero builds no node: no flow sample, no tilt, and the same
  // shader this generated before the grain existed.
  const canopyGrain =
    grainStrength > 0
      ? flowAt(worldXZ).mul(float(grainStrength).mul(canopyProxy))
      : null;
  const canopyNormal = canopyGrain && !displaced
    ? vec3(canopyGrain.x.negate(), 1, canopyGrain.y.negate()).normalize()
    : null;
  const health = healthAt(worldXZ).toVar('lawnSurfaceHealth');
  // The hue correction. Grass004 is a photograph of a lawn at hue 72, which is
  // olive beside the 105 the blades are drawn at, and it is the ground seen
  // through every gap between them. This carries its mean onto the palette's
  // hue at unchanged luminance: a hue fix, not a brightness one.
  // What a pixel of unresolved grass averages to: the blade's own ramp, read
  // towards the tip because the root half of a blade stands in its neighbours
  // and a distant pixel never sees it. It is the albedo only -- the sun, the
  // shadow and the canopy normal below do the rest, exactly as they do for the
  // blades in front of it.
  const canopyAlbedo = mix(
    color(greens.bottom),
    color(greens.top),
    float(LAWN.canopyProxyTip),
  ).mul(float(LAWN.canopyProxyOcclusion));
  // Once the canopy starts closer, replacing all texture by a solid color
  // makes a smooth carpet. Preserve a restrained, mip-filtered blade-scale
  // signal from the existing samples; no added texture reads or geometry.
  const detailedCanopyAlbedo = projectedProxy
    ? canopyAlbedo.mul(mix(vec3(1),
        vec3(ground.dot(vec3(0.2126, 0.7152, 0.0722))
          .div(color(GRASS004_ALBEDO_MEAN).dot(vec3(0.2126, 0.7152, 0.0722)))
          .clamp(0.5, 1.5)),
        float(CANOPY_DETAIL)))
    : canopyAlbedo;
  // Both ends of the mix then take this lawn's own variation, so the ground
  // and the canopy it turns into are lighter, darker and drier in the same
  // places -- and in the same places the blades are, which read the same two
  // signals.
  // The ground is under a canopy, and until now it was lit as though it were
  // not. See `groundCanopyAO`: the blades cast no shadow by design, so nothing
  // told the terrain that a few centimetres of grass stand between it and the
  // sky. It is applied to the ground end of the mix only -- the canopy end
  // carries its own `canopyProxyOcclusion`, which is the same physics one
  // layer up, and multiplying both would occlude the far field twice.
  lawnMaterial.colorNode = mix(
    ground.mul(vec3(...greens.groundTint)).mul(float(groundAO)),
    detailedCanopyAlbedo,
    canopyProxy,
  )
    .mul(tintFrom(macro))
    .mul(dryTintFrom(dryAt(health).mul(LAWN.groundDryStrength)));
  // Towards the blades' own roughness as it stops being ground.
  lawnMaterial.roughnessNode = mix(
    pbr.a.mul(0.22).add(0.76),
    float(LAWN.bladeRoughness),
    canopyProxy,
  );
  // The texture's relief where the ground is resolvable, the canopy's lean
  // where it is not. `normalMap` returns a view-space normal; the world-space
  // grain must enter that same space before blending or pitching the camera
  // changes the turf's lighting. Its world normal needs no model transform.
  if (displaced) {
    // The same composition in the terrain's own frame. `normalMap` builds its
    // frame around the geometry's normal, and a displaced flat grid still
    // carries +Y, so the frame is built here from the slope instead. On level
    // ground T is +X and B is -Z, which is the UV orientation `primaryUVAt`
    // assumes, so this reduces to the flat path's arithmetic.
    const groundNormal = displaced.normal.normalize().toVar('lawnGroundNormal');
    const tangent = normalize(
      vec3(1, 0, 0).sub(groundNormal.mul(groundNormal.x)),
    ).toVar('lawnGroundTangent');
    const bitangent = cross(groundNormal, tangent).toVar('lawnGroundBitangent');
    const detail = packedNormal.mul(2).sub(1);
    const detailNormal = tangent
      .mul(detail.x.mul(normalStrength))
      .add(bitangent.mul(detail.y.mul(normalStrength)))
      .add(groundNormal.mul(detail.z))
      .normalize();
    const worldNormal = canopyGrain
      ? mix(
          detailNormal,
          groundNormal
            .add(tangent.mul(canopyGrain.x.negate()))
            .add(bitangent.mul(canopyGrain.y))
            .normalize(),
          canopyProxy,
        ).normalize()
      : detailNormal;
    lawnMaterial.normalNode = worldNormal.transformNormalByViewMatrix(cameraViewMatrix);
  } else {
    const surfaceNormal = normalMap(packedNormal, vec2(normalStrength));
    lawnMaterial.normalNode = canopyNormal
      ? mix(
          surfaceNormal,
          canopyNormal.transformNormalByViewMatrix(cameraViewMatrix),
          canopyProxy,
        ).normalize()
      : surfaceNormal;
  }

  // The far field transmits, because out there the far field *is* the grass.
  // Weighted by the proxy, so the ground at your feet does not. `?backlight=off`
  // takes it out alongside the blades' own term, since a lawn that transmits at
  // 30 m and not at 3 is not a control.
  if (normalizeBacklight(backlight) !== GRASS_BACKLIGHT.off) {
    const canopyLighting = new GrassLightingModel(canopyProxy, {
      mode: GRASS_BACKLIGHT.canopy,
      backlightColor: greens.backlight,
    });
    lawnMaterial.setupLightingModel = () => canopyLighting;
  }

  let mode = normalizeLawnUnderlay(underlay);
  let disposed = false;

  function setMode(nextMode) {
    mode = normalizeLawnUnderlay(nextMode);
    return mode;
  }

  return {
    albedoRoughnessTexture,
    normalTexture,
    macroAt,
    healthAt,
    flowAt,
    tintFrom,
    densityFrom,
    dryAt,
    dryTintFrom,
    solidMaterial,
    lawnMaterial,
    get mode() {
      return mode;
    },
    get material() {
      return mode === LAWN_UNDERLAY.lawn ? lawnMaterial : solidMaterial;
    },
    setMode,
    ownsTextures: ownTextures,
    displaced: Boolean(displaced),
    stats: Object.freeze({
      asset: LAWN_PBR_ASSET.id,
      maps: Object.keys(LAWN_PBR_ASSET.maps).length,
      encodedBytes: LAWN_PBR_ASSET.encodedBytes,
      gpuBytes: lawnPBRGPUBytes(),
      anisotropy,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      solidMaterial.dispose();
      lawnMaterial.dispose();
      if (!ownTextures) return;
      albedoRoughnessTexture.dispose();
      normalTexture.dispose();
    },
  };
}

export { LAWN_UNDERLAY, normalizeLawnUnderlay };
