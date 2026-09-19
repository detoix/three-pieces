import type { DirectionalLight, HemisphereLight, Node, WebGPURenderer } from 'three/webgpu';

export type CloudQuality = 'low' | 'balanced' | 'high';

export interface SkyOptions {
  /** An initialized Three.js WebGPURenderer; the host retains ownership. */
  renderer: WebGPURenderer;
  /** Degrees above the horizon, in [-90, 90]. Default 45. */
  sunElevation?: number;
  /** Degrees from +Z toward +X, normalized modulo 360. Default 0. */
  sunAzimuth?: number;
  /** Nonnegative linear radiance multiplier, excluded from the probe. Default 1. */
  exposure?: number;
  /** Nonnegative atmospheric multiple-scattering multiplier. Default 1. */
  multiScatter?: number;
  /** Fixed atmospheric observer height in km, in [0, 100). Default 0.0017. */
  eyeHeightKm?: number;
  /** Enable the cloud volume and angular cache. Default true. */
  clouds?: boolean;
  /** Construction-time resolution and integration preset. Default balanced. */
  cloudQuality?: CloudQuality;
  /** Weather coverage parameter in [0, 1], not a literal sky fraction. Default 0.48. */
  cloudCoverage?: number;
  /** Drift speed parameter in m/s, in [0, 100]. Default 12. */
  cloudWindSpeed?: number;
  /** Deterministic unsigned 32-bit procedural seed. Default 0x43f6a21d. */
  cloudSeed?: number;
}

export interface SkyProbe {
  /** Direct irradiance on a sun-facing surface; above-atmosphere solar RGB is [1,1,1]. */
  sun: [number, number, number];
  /** Clear-sky irradiance on an upward-facing surface; excludes clouds and exposure. */
  sky: [number, number, number];
}

export interface CloudStats {
  readonly quality: CloudQuality;
  readonly width: number;
  readonly height: number;
  /** Minimum coarse ray-march steps across the layer; longer rays use more. */
  readonly steps: number;
  /** Maximum coarse ray-march steps across the layer, currently 256. */
  readonly maxSteps: number;
  /** Target coarse sample spacing in km, currently 0.05 (50 m). */
  readonly targetStepKm: number;
  /** Fine step as a fraction of the coarse one, used from a cloud boundary
   *  until the ray is deep inside, currently 0.25. */
  readonly fineStepFraction: number;
  /** Cap on coarse plus fine samples per ray, currently 320. */
  readonly maxIterations: number;
  readonly slices: number;
  readonly coverage: number;
  readonly windSpeed: number;
  /** Runtime node IDs for initialization and incremental update timestamp attribution. */
  readonly computeNodeIds: readonly [number, number];
  /** Estimated texture bytes, including the shadow maps, excluding driver allocations and pipelines. */
  readonly bytes: number;
  /** The cloud shadow map; null at zero coverage, where there is no shadow to march. */
  readonly shadow: CloudShadowStats | null;
  readonly generation: number;
  readonly updatedTexels: number;
  /** Duration of one completed cache update cycle, not a GPU timing. */
  readonly cacheLatencySeconds: number;
  readonly representation: string;
}

export interface CloudShadowStats {
  /** Texels along each side of the map, currently 256. */
  readonly resolution: number;
  /** Kilometres of ground along each side, currently 5.12 (20 m texels). */
  readonly extentKm: number;
  readonly texelKm: number;
  /** Everything within this many km of the observer is shadowed from a complete map, currently 1.56. */
  readonly reachKm: number;
  readonly bytes: number;
  /** Runtime node IDs of the whole-map and one-slice passes, for timestamp attribution. */
  readonly computeNodeIds: readonly [number, number];
  /** Maps shown so far, counting the one each bake marches. */
  readonly generation: number;
  /** The cloud-field point (x, z) in km the shown map is centred on. */
  readonly centreKm: readonly [number, number];
}

export interface Sky {
  /** Install as scene.backgroundNode. Includes atmosphere, solar disk and clouds. */
  readonly backgroundNode: Node;
  /** Clear-atmosphere RGB for a world direction node; excludes disk and clouds. */
  readonly skyRadianceNode: (direction: Node) => Node;
  /** Frozen diagnostics only; lifecycle remains owned by this sky. */
  readonly clouds: { readonly stats: CloudStats } | null;
  /**
   * The fraction of the sun's direct beam the clouds let through to a world position in
   * metres (default: the fragment's `positionWorld`), as a TSL float in [0, 1]. Null with
   * clouds off. Install it as a directional light's shadow node to darken everything that
   * light lights; see docs/sky.md. Valid for positions below the cloud base and within
   * `clouds.stats.shadow.reachKm` of the observer passed to update(); past the map it is 1.
   */
  readonly cloudShadowNode: ((worldPosition?: Node) => Node) | null;
  /** Frozen world direction [x, y, z]; +Y is up. */
  readonly sunDirection: readonly [number, number, number];
  /** True after a successful bake and false during work, failure or disposal. */
  readonly ready: boolean;
  readonly disposed: boolean;
  readonly stats: {
    /** Estimated atmosphere and cloud texture bytes. */
    readonly bytes: number;
    /** Number of atmosphere LUTs/passes (3); excludes the probe and cloud passes. */
    readonly passes: number;
    /** Read-only atmosphere LUT dimensions for diagnostics; not configuration. */
    readonly tables: readonly {
      readonly name: string;
      readonly width: number;
      readonly height: number;
    }[];
  };
  /** Linear distance fog, with 0 <= near < far in host scene units. */
  fogNodeFor(options: { near: number; far: number }): Node;
  /** Initialize/rebake the sky and return clear-air lighting. Serialized per instance. */
  bake(): Promise<SkyProbe>;
  /** Change the sun in degrees and rebake; valid as the first async operation. */
  setSun(elevationDegrees: number, azimuthDegrees: number): Promise<SkyProbe>;
  /**
   * Absolute monotonic time in seconds, once before each render. A successful bake
   * resets the clock guard. Returns false while unavailable or with clouds off.
   * `observer` is the camera's world position in metres (x and z are read). Given,
   * cloud snapshots are marched from where it stands, so the sky stays correct
   * however far it walks; omitted, the observer is the world origin.
   */
  update(seconds: number, observer?: { readonly x: number; readonly z: number }): boolean;
  /**
   * Idempotent. Detach scene nodes first, including a cloud shadow node installed on a
   * light; pending async work rejects after disposal.
   */
  dispose(): void;
}

/** No DOM, scene, camera, light or renderer ownership. See docs/sky.md. */
export function createSky(options: SkyOptions): Sky;

/** Unit direction, +Y up, azimuth from +Z toward +X. Inputs are finite degrees. */
export function sunDirectionFrom(elevationDegrees: number, azimuthDegrees: number): [number, number, number];

/** Inverse for a finite, nonzero direction; azimuth is in [-180, 180] degrees. */
export function sunAnglesOf(direction: readonly [number, number, number]): { elevation: number; azimuth: number };

/** The light values the lawn palette was calibrated under, and their luminance. */
export const AUTHORED_SUN: { readonly color: string; readonly intensity: number; readonly luminance: number };
export const AUTHORED_SKY: {
  readonly color: string;
  readonly ground: string;
  readonly intensity: number;
  readonly luminance: number;
};
/** Scales from probe luminance to the authored lights' luminance at the calibration sun. */
export const SUN_ANCHOR: number;
export const SKY_ANCHOR: number;
export function relativeLuminance(rgb: readonly [number, number, number]): number;
/**
 * Colours the host's lights from a sky probe and anchors their luminance to the
 * authored values. Mutates `sun` and `skyLight`; returns the linear colours applied.
 */
export function applySkyLighting(options: {
  sun: DirectionalLight;
  skyLight: HemisphereLight;
  probe: SkyProbe;
}): { sunColor: [number, number, number]; skyColor: [number, number, number] };
