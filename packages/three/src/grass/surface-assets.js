export const LAWN_UNDERLAY = Object.freeze({
  solid: 'solid',
  lawn: 'lawn',
});

export const LAWN_PBR_WORLD_SIZE = 1.4;
export const LAWN_PBR_SECONDARY_UV_SCALE = 0.931;
/** Mip level whose texel covers the scale the photograph's own patches live on.
 *
 *  The asset is 1024 texels over 1.4 m, so level 8 is one texel every 35 cm --
 *  the size of the soft light and dark blotches in the source photograph.
 *  Dividing the sample by itself at that level keeps everything finer, which is
 *  the blade-scale detail the asset is here for, and removes everything
 *  coarser, which is another lawn's patches laid under this one's. */
export const LAWN_PBR_FLATTEN_LEVEL = 8;

export const LAWN_MACRO_WORLD_SIZE = 31.7;
export const LAWN_MACRO_SAMPLE_LEVEL = 5;

/**
 * The health signal: the same channel of the same map at the same mip, over a
 * much larger world tile.
 *
 * Same channel and same level on purpose. Mip 5 of a 1,024 map is 32 texels,
 * and the 0.045-0.32 window `macroAt` maps is tuned to what the green channel
 * actually does at that level -- a coarser mip regresses towards the tile mean
 * and the window would have to be re-measured against the asset. Changing only
 * the tile changes the *scale* of the signal and nothing about its
 * distribution: 161.3 m over 32 texels is a patch about 5 m across, so a 52 m
 * view holds a handful of them rather than the metre-scale mottling `macroAt`
 * supplies. The offset is non-harmonic with the macro one so the two signals
 * do not line up and double a patch's contrast.
 */
/** World tile the lawn's flow field is read on, in metres.
 *
 *  Between the macro tile and the health tile, and non-harmonic with both, so
 *  the three signals disagree about scale and about nothing else. A lawn's
 *  grain runs in patches you can see several of at once, which is tens of
 *  metres, not the metres a clump runs to. */
export const LAWN_FLOW_WORLD_SIZE = 34;
export const LAWN_FLOW_SAMPLE_LEVEL = LAWN_MACRO_SAMPLE_LEVEL;

export const LAWN_HEALTH_WORLD_SIZE = 161.3;
export const LAWN_HEALTH_SAMPLE_LEVEL = LAWN_MACRO_SAMPLE_LEVEL;

export const LAWN_PBR_ASSET = Object.freeze({
  id: 'Grass004',
  title: 'Grass 004',
  creator: 'ambientCG',
  source: 'https://ambientcg.com/a/Grass004',
  license: 'CC0 1.0 Universal',
  licenseURL: 'https://docs.ambientcg.com/license/',
  worldWidth: LAWN_PBR_WORLD_SIZE,
  encodedBytes: 615_023,
  maps: Object.freeze({
    albedoRoughness: Object.freeze({
      url: new URL(
        './assets/grass004/lawn-albedo-roughness.webp',
        import.meta.url,
      ).href,
      width: 1024,
      height: 1024,
      channels: 4,
      encodedBytes: 339_200,
      sha256:
        'f125db0beb05752da57bb29ae9bc37432247618b1bf2bb21a93cc51251085401',
    }),
    normal: Object.freeze({
      url: new URL('./assets/grass004/lawn-normal-gl.jpg', import.meta.url)
        .href,
      width: 512,
      height: 512,
      channels: 4,
      encodedBytes: 275_823,
      sha256:
        '91c5ca235c06129211944635955d94d01d19b5b3faa561b0fa2dfae1eb20f335',
    }),
  }),
});

export function normalizeLawnUnderlay(value) {
  return value === LAWN_UNDERLAY.solid
    ? LAWN_UNDERLAY.solid
    : LAWN_UNDERLAY.lawn;
}

export function mipmappedTextureBytes(width, height = width, channels = 4) {
  let mipWidth = width;
  let mipHeight = height;
  let bytes = 0;
  while (true) {
    bytes += mipWidth * mipHeight * channels;
    if (mipWidth === 1 && mipHeight === 1) break;
    mipWidth = Math.max(1, Math.floor(mipWidth / 2));
    mipHeight = Math.max(1, Math.floor(mipHeight / 2));
  }
  return bytes;
}

export function lawnPBRGPUBytes() {
  return Object.values(LAWN_PBR_ASSET.maps).reduce(
    (total, map) =>
      total + mipmappedTextureBytes(map.width, map.height, map.channels),
    0,
  );
}
