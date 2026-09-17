# Grass004 lawn PBR asset

The runtime maps in this directory are optimized derivatives of
[Grass 004](https://ambientcg.com/a/Grass004) by ambientCG. The source asset is
provided under the [CC0 1.0 Universal license](https://docs.ambientcg.com/license/),
which explicitly permits copying, modification, redistribution, commercial use,
and inclusion of the raw files in a project. Attribution is not required; it is
recorded here for provenance.

- Source download: `Grass004_1K-JPG.zip`, retrieved 2026-08-31
- Source physical size: approximately 1.4 m × 1.4 m
- Source archive SHA-256:
  `4b63495f459db8481f4d5144e4e9069345c81cf898cc71f2216f5dd3bb344469`
- Source color SHA-256:
  `9e1c60da44b34a9738b1256ba827541f097dc583521b1d281e61b5f4b4217bc5`
- Source OpenGL-normal SHA-256:
  `8014a81d896a5c589b60612a769bc39eb1213e48d96f6146f485ea36e9e9610f`
- Source roughness SHA-256:
  `706580983860f942e141acdd68c4128dd683be50fcc5d85b7c67a9a3a8c7bac0`

## Runtime derivatives

`lawn-albedo-roughness.webp` is 1024 × 1024. RGB contains the source color.
Alpha contains source roughness, area-filtered to 256 × 256, quantized to 16
levels, and expanded with nearest filtering before WebP encoding. Roughness does
not need the albedo's spatial resolution, and packing it removes one GPU texture
and one terrain sample.

`lawn-normal-gl.jpg` is the source OpenGL normal, Lanczos-filtered to 512 × 512
and encoded as 4:4:4 JPEG. Avoiding chroma subsampling matters for a normal map;
512² still resolves roughly 2.7 mm per texel at the documented material scale.

The derivatives were produced with:

```sh
ffmpeg -i Grass004_1K-JPG_Color.jpg \
  -i Grass004_1K-JPG_Roughness.jpg \
  -filter_complex '[0:v]format=rgba[color];[1:v]scale=256:256:flags=area,format=gray,lut=y=round(val/16)*16,scale=1024:1024:flags=neighbor[rough];[color][rough]alphamerge' \
  -c:v libwebp -quality 78 -compression_level 6 -preset picture \
  -pix_fmt yuva420p lawn-albedo-roughness.webp

ffmpeg -i Grass004_1K-JPG_NormalGL.jpg \
  -vf scale=512:512:flags=lanczos -q:v 2 -pix_fmt yuvj444p \
  lawn-normal-gl.jpg
```

| Runtime map                  |   Bytes | SHA-256                                                            |
| ---------------------------- | ------: | ------------------------------------------------------------------ |
| `lawn-albedo-roughness.webp` | 339,200 | `f125db0beb05752da57bb29ae9bc37432247618b1bf2bb21a93cc51251085401` |
| `lawn-normal-gl.jpg`         | 275,823 | `91c5ca235c06129211944635955d94d01d19b5b3faa561b0fa2dfae1eb20f335` |

Total transfer size is 615,023 bytes. After browser decode and mip generation,
the two RGBA8 GPU textures occupy 6,990,504 bytes (about 6.7 MiB).
