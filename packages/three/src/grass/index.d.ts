import type {
  ColorRepresentation, DataTexture, Group, Material, Mesh, MeshStandardMaterial,
  MeshStandardNodeMaterial, Node, Object3D, PerspectiveCamera, Texture, WebGPURenderer,
} from 'three/webgpu';

export type LawnUnderlay = 'solid' | 'lawn';
export type GrassBacklight = 'blade' | 'view' | 'off';
export type LawnGroundMaterial = MeshStandardMaterial | MeshStandardNodeMaterial;

export interface LawnPalette {
  readonly bottom: ColorRepresentation;
  readonly top: ColorRepresentation;
  readonly backlight: ColorRepresentation;
  readonly ground: ColorRepresentation;
  /** RGB multipliers for the supplied ground photograph. */
  readonly groundTint: readonly [number, number, number];
}

/** Frozen palette returned by lawnColorsFor(). Colors are hexadecimal strings. */
export interface LawnColors extends LawnPalette {
  readonly bottom: string;
  readonly top: string;
  readonly backlight: string;
  readonly ground: string;
}

/** Borrowed, filterable GPU height texture and its world/packing transforms. */
export interface GrassHeightMap {
  readonly texture: Texture;
  /** Positive half-width of the centered square XZ domain, in metres. */
  readonly extent: number;
  /** Decoded height = sampled red channel * scale + minimum, in metres. */
  readonly minimum: number;
  readonly scale: number;
  /** Positive finite-difference sampling distance, in metres. */
  readonly texelWorldSize: number;
  /** Minimum and positive range for packed crown heights; contain all decoded heights. */
  readonly packingMinimum: number;
  readonly packingRange: number;
}

/**
 * Procedural terrain with no domain edge, for unbounded or camera-following ground.
 * `heightAt` is evaluated in the placement compute pass, once per placed crown plus
 * four finite-difference samples `normalStep` apart for its normal.
 */
export interface GrassHeightFunction {
  /** World XZ vec2 -> scalar height in metres, as a TSL node. */
  readonly heightAt: (worldXZ: Node) => Node;
  /** Positive finite-difference distance for the ground normal, in metres. */
  readonly normalStep: number;
  /** Minimum and positive range for packed crown heights; contain every height heightAt returns. */
  readonly packingMinimum: number;
  readonly packingRange: number;
}

/** TSL functions receive nodes and return shader nodes, never CPU sample values. */
export interface GrassSurface {
  readonly material: Material;
  /** World XZ vec2 -> scalar macro variation. */
  readonly macroAt: (worldXZ: Node) => Node;
  /** World XZ vec2 -> scalar health. */
  readonly healthAt: (worldXZ: Node) => Node;
  /** Scalar macro variation -> RGB multiplier. */
  readonly tintFrom: (macro: Node) => Node;
  /** Scalar macro variation -> scalar retained density. */
  readonly densityFrom: (macro: Node) => Node;
  /** Scalar dryness -> RGB multiplier. */
  readonly dryTintFrom: (dry: Node) => Node;
}

export interface LawnPBRTextures {
  /** Color in RGB and roughness in alpha. */
  albedoRoughness: Texture;
  /** OpenGL tangent-space normal. */
  normal: Texture;
}

export interface LawnTextureLoader {
  loadAsync(url: string): Promise<Texture>;
}

export interface LawnSurfaceOptions {
  /** Initialized host-owned WebGPU renderer. */
  renderer: WebGPURenderer;
  underlay?: LawnUnderlay;
  /** Configured in place (color space, wrapping, filtering, anisotropy, name). */
  textures?: LawnPBRTextures;
  /**
   * Whether surface.dispose() releases supplied `textures`. Default true, transferring
   * ownership; false keeps them host-owned. False without `textures` throws.
   */
  ownTextures?: boolean;
  greens?: LawnPalette;
  /** Ground photograph flattening in [0, 1]. Default LAWN.groundFlatten. */
  flatten?: number;
  /** Macro color variation scale. Default 1. */
  macroTint?: number;
  /** Ground canopy representation weight in [0, 1]. Default 1. */
  proxy?: number;
  projectedProxy?: boolean;
  /** Positive mean physical blade width in metres for projected canopy matching. */
  proxyBladeWidth?: number;
  /** Ground canopy occlusion in (0, 1]. Default LAWN.groundCanopyAO. */
  groundAO?: number;
  /** Canopy normal grain in [0, 1]. Default LAWN.canopyGrain. */
  grainStrength?: number;
  /** Shared density variation scale. Default 1. */
  variation?: number;
  /** Normalized by normalizeBacklight(). Default 'blade'. */
  backlight?: string | boolean;
}

export interface LawnSurface extends GrassSurface {
  readonly albedoRoughnessTexture: Texture;
  readonly normalTexture: Texture;
  /** False only when created with host-owned textures (`ownTextures: false`). */
  readonly ownsTextures: boolean;
  /** World XZ vec2 -> vec2 flow direction. */
  readonly flowAt: (worldXZ: Node) => Node;
  /** Scalar health -> scalar dryness. */
  readonly dryAt: (health: Node) => Node;
  readonly solidMaterial: MeshStandardMaterial;
  readonly lawnMaterial: MeshStandardNodeMaterial;
  readonly mode: LawnUnderlay;
  /** Current selected ground material; existing meshes are not reassigned automatically. */
  readonly material: LawnGroundMaterial;
  setMode(mode: string | null | undefined): LawnUnderlay;
  readonly stats: {
    readonly asset: string;
    readonly maps: number;
    /** Bundled asset estimate, also reported when supplying custom textures. */
    readonly encodedBytes: number;
    readonly gpuBytes: number;
    readonly anisotropy: number;
  };
  /** Idempotent; disposes both materials and both textures, including supplied textures. */
  dispose(): void;
}

export interface GrassCoverageBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface GrassOptions {
  renderer: WebGPURenderer;
  heightMap: GrassHeightMap | GrassHeightFunction;
  /** Borrowed shared surface, normally returned by createLawnSurface(). */
  surface: GrassSurface;
  shadows?: boolean;
  /** World XZ vec2 -> boolean TSL node; borrowed mask resources remain host-owned. */
  keepAt?: ((worldXZ: Node) => Node) | null;
  coarseCulling?: boolean;
  subgroupCulling?: boolean;
  cullHysteresis?: boolean;
  /** Conservative decoded height bounds in metres; defaults to the packing interval. */
  groundBounds?: { minimum: number; maximum: number } | null;
  /** Conservative union containing every allowed root; does not itself mask placement. */
  coverageBounds?: readonly GrassCoverageBounds[] | null;
  minBladePixels?: number;
  tillers?: number;
  backlight?: string | boolean;
  diffuseOnly?: boolean;
  bend?: { min: number; max: number };
  posture?: { clumpPull: number; tillerFan: number };
  canopy?: { near: number; far: number };
  projectedCanopy?: boolean;
  poseCache?: boolean;
  greens?: LawnPalette;
  heightCorrelation?: number;
  /** Ordered positive physical dimensions in metres. */
  size?: { minHeight: number; maxHeight: number; minWidth: number; maxWidth: number };
}

/** Live diagnostics from stats(); use snapshotStats() to retain a historical copy. */
export interface GrassStats {
  readonly candidates: number;
  readonly tillers: number;
  readonly storage: {
    readonly recordBytes: number;
    readonly visibleIdBytes: number;
    readonly totalBytes: number;
  };
  /** Backed by a live Uint32Array, in GRASS_RINGS order; refreshed by explicit readback. */
  readonly visible: ArrayLike<number> & Iterable<number>;
  readonly triangles: number;
  readonly placements: number;
  readonly placementCandidates: number;
  readonly cullCandidates: number;
  readonly subgroupCulling: boolean;
  readonly poseCandidates: number;
  readonly poseCacheBytes: number;
  readonly cullTiles: number;
  readonly cullTileBytes: number;
  readonly drawCalls: number;
  readonly computeCalls: number;
  readonly computeDispatches: number;
}

export interface Grass {
  /** Add to the host scene with an identity world transform. */
  readonly group: Group;
  /** Current borrowed surface.material; the host assigns it to its ground meshes. */
  readonly groundMaterial: Material;
  readonly disposed: boolean;
  /** Call before rendering with current perspective-camera matrices. No-op after disposal. */
  update(camera: PerspectiveCamera): void;
  /** Refresh after changing coverage uniforms/bounds. No-op after disposal. */
  invalidateCulling(): void;
  /** After first update; false while another readback is pending or after disposal. */
  sampleVisibleCounts(): Promise<boolean>;
  /** The live diagnostic object; read only, and it keeps changing. */
  stats(): GrassStats;
  /** A deep-frozen copy of stats() at this moment; `visible` is a plain array. Still callable after disposal. */
  snapshotStats(): GrassStats;
  /** Idempotent; owns blade resources only, not renderer, surface, height map or mask. */
  dispose(): void;
}

export interface GrassRing {
  readonly id: 'close' | 'near' | 'mid' | 'far';
  readonly inner: number;
  readonly outer: number;
  readonly spacing: number;
  readonly segments: number;
  /** Shared canonical crown seed stream; zero for every LOD. */
  readonly seedIndex: number;
  readonly densityInner: number;
  readonly densityOuter: number;
  readonly densityNear: number;
  readonly densityFar: number;
  readonly index: number;
  readonly side: number;
  readonly capacity: number;
  readonly candidateDensity: number;
  readonly ribbon?: true;
}

/** Fixed authored defaults; these are not mutable runtime settings. */
export const LAWN: Readonly<{
  density: number;
  minHeight: number;
  maxHeight: number;
  minWidth: number;
  maxWidth: number;
  taper: number;
  minBladePixels: number;
  maxThicken: number;
  clumpSize: number;
  clumpShortest: number;
  clumpPull: number;
  tillers: number;
  tillerSpread: number;
  tillerFan: number;
  tillerShortest: number;
  minBend: number;
  maxBend: number;
  rootOcclusion: number;
  groundCanopyAO: number;
  rootOcclusionHeight: number;
  dryOnset: number;
  dryFull: number;
  dryScatter: number;
  dryStrength: number;
  groundDryStrength: number;
  backscatter: number;
  backscatterPower: number;
  backscatterAbsorb: number;
  backscatterView: number;
  backscatterTip: number;
  densitySpread: number;
  heightCorrelation: number;
  canopyBacklight: number;
  canopyBacklightPower: number;
  canopyGrain: number;
  normalSpread: number;
  canopyNormalNear: number;
  canopyNormalFar: number;
  canopyNormalFrom: number;
  canopyNormalTo: number;
  radius: number;
  groundFlatten: number;
  canopyProxyFrom: number;
  canopyProxyTo: number;
  canopyProxyTip: number;
  canopyProxyOcclusion: number;
  bladeRoughness: number;
  shadows: boolean;
}>;

export const LAWN_COLORS: LawnColors;
export const LAWN_TARGET_HUE: number;
export const CANOPY_PULL_MAX: number;
export const CLUMP_PULL_MARGIN: number;
export const GRASS_RINGS: readonly GrassRing[];
export const LAWN_UNDERLAY: Readonly<{ solid: 'solid'; lawn: 'lawn' }>;
/** 'canopy' is the internal aggregate lighting mode; normalizeBacklight maps it to 'blade'. */
export const GRASS_BACKLIGHT: Readonly<{ blade: 'blade'; view: 'view'; off: 'off'; canopy: 'canopy' }>;

/** Finite hue in degrees; returns an independently frozen palette. */
export function lawnColorsFor(hue?: number): LawnColors;
/** Only 'solid' selects the solid material; other values select 'lawn'. */
export function normalizeLawnUnderlay(value?: string | null): LawnUnderlay;
/** false/'off' -> 'off'; 'view' -> 'view'; other inputs -> 'blade'. */
export function normalizeBacklight(value?: string | boolean | null): GrassBacklight;
/** Loads bundled textures; caller owns them until transferring them to a surface. */
export function loadLawnPBRTextures(options?: { loader?: LawnTextureLoader }): Promise<LawnPBRTextures>;
export function createLawnSurface(options: LawnSurfaceOptions): Promise<LawnSurface>;
/** Local package boundary for initialized Three.js WebGPU r185; no scene/loop ownership. */
export function createGrass(options: GrassOptions): Grass;

/** World-space XZ triangle of a lawn area, wound counter-clockwise. */
export type LawnTriangle = readonly (readonly [number, number])[];

export interface LawnAreas {
  /** The surfaces themselves, for assigning `grass.groundMaterial` to them. */
  readonly meshes: readonly Mesh[];
  readonly triangles: readonly LawnTriangle[];
  /** The single world height every vertex shares, in metres. */
  readonly elevation: number;
  readonly ids: readonly string[];
  /** CPU point test, for walking and for anything placed outside the shader. */
  contains(x: number, z: number): boolean;
}

/** The authored tag `{ version: 1, id, role: 'lawn' | 'turf' }` on `userData.landscape`. */
export function landscapeLawnTag(object: Object3D): string | false;

/**
 * Collects the lawn areas of a loaded model, in world space. `select` returns an id,
 * `true` to use the object's name, or a falsy value to skip; it may throw to reject a
 * tag it recognises but cannot read. Rejects skinned and instanced meshes,
 * non-triangulated geometry, non-finite coordinates, duplicate ids, and any surface off
 * the shared elevation.
 */
export function readLawnAreas(
  root: Object3D,
  options?: { select?: (object: Object3D) => string | boolean },
): LawnAreas;

/** Conservative raster: 255 fully inside, 128 needs the exact test, 0 outside. */
export function bakeLawnCoverage(
  triangles: readonly LawnTriangle[],
  resolution?: number,
): { data: Uint8Array; min: [number, number]; size: [number, number]; resolution: number };

export function triangleContains(triangle: LawnTriangle, x: number, z: number): boolean;

/**
 * The mask for `createGrass({ keepAt })`: a coverage texture inside, exact triangle
 * tests along boundaries. Owns its texture; dispose it after the grass borrowing it.
 */
export function createLawnMask(areas: LawnAreas): {
  keepAt: (worldXZ: Node) => Node;
  readonly texture: DataTexture;
  dispose(): void;
};

/** The flat height map for a lawn at one elevation; `extent` is its half-width in metres. */
export function createFlatHeightMap(
  elevation: number,
  options?: { extent?: number },
): GrassHeightMap;
