import type { BufferGeometry, Camera, Material, Mesh, Node } from 'three/webgpu';

export interface HeightBounds {
  readonly minimum: number;
  readonly maximum: number;
  readonly span: number;
}

export interface HillOctave {
  readonly wavelength: number;
  readonly amplitude: number;
  readonly angle: number;
  readonly stretch: number;
  readonly phaseU: number;
  readonly phaseV: number;
}

/** The arithmetic a height formula is written against: numbers or TSL nodes. */
export interface HeightOps<T> {
  num(value: number): T;
  add(a: T, b: T): T;
  mul(a: T, b: T): T;
  sin(a: T): T;
  cos(a: T): T;
}

export const HILL_OCTAVES: readonly HillOctave[];
export const HILL_WARP: {
  readonly distance: number;
  readonly wavelengthX: number;
  readonly wavelengthZ: number;
  readonly phaseX: number;
  readonly phaseZ: number;
};
export const HILLS_DEFAULT_SCALE: number;
/** Exact bound on |height| at scale 1. */
export const HILLS_AMPLITUDE_SUM: number;
export const SCALAR_OPS: HeightOps<number>;

export function hillsHeightBounds(scale?: number): HeightBounds;
export function hillsHeightWith<T>(ops: HeightOps<T>, x: T, z: T, scale?: number): T;
/** Height in metres at world (x, z). */
export function hillsHeightAt(x: number, z: number, scale?: number): number;
export function hillsNormalAt(x: number, z: number, scale?: number, step?: number): [number, number, number];
/** `TSL` is `THREE.TSL`. */
export function hillsNodeOps(TSL: object): HeightOps<Node>;
/** TSL `worldXZ -> height` for grass `heightMap.heightAt` and surface `heightAt`. */
export function createHillsHeightNode(TSL: object, scale?: number): (worldXZ: Node) => Node;

export interface GroundGridOptions {
  /** Half-width in metres. Default 1500. */
  radius?: number;
  /** Even cell count per axis. Default 384. */
  segments?: number;
  /** Cell size at the centre in metres. Default 0.5. */
  innerSpacing?: number;
}

export function groundLinearShare(options: Required<GroundGridOptions>): number;
export function groundAxisAt(index: number, options: Required<GroundGridOptions>): number;
export function createGroundGridArrays(options?: GroundGridOptions): {
  positions: Float32Array;
  indices: Uint32Array;
  axis: Float32Array;
};
export function snapGroundCentre(x: number, z: number, step: number): [number, number];

/**
 * A flat, camera-following grid for a displaced lawn surface (`createLawnSurface({ heightAt })`).
 * Call `follow(camera)` before rendering; `dispose()` releases the geometry, not the material.
 */
export function createHillsGroundMesh(
  THREE: object,
  options: GroundGridOptions & { material: Material; heightBounds?: HeightBounds },
): { readonly mesh: Mesh<BufferGeometry, Material>; follow(camera: Camera): void; dispose(): void };
