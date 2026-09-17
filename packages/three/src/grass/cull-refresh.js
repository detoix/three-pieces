import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';

export const CULL_TRANSLATION_LIMIT = 0.15;
export const CULL_ROTATION_LIMIT = 4 * Math.PI / 180;
const rotationDotLimit = Math.cos(CULL_ROTATION_LIMIT * 0.5);

// A rigid camera is needed for the rotation-distance proof below. A parent
// with scale/shear uses exact matrix invalidation instead of an unsafe guard.
export function isRigidCameraMatrix(matrix) {
  const e = matrix.elements;
  const tolerance = 1e-8;
  for (const offset of [0, 4, 8]) {
    if (Math.abs(e[offset] ** 2 + e[offset + 1] ** 2 + e[offset + 2] ** 2 - 1) > tolerance) return false;
  }
  for (const [a, b] of [[0, 4], [0, 8], [4, 8]]) {
    if (Math.abs(e[a] * e[b] + e[a + 1] * e[b + 1] + e[a + 2] * e[b + 2]) > tolerance) return false;
  }
  return Math.abs(e[3]) < tolerance && Math.abs(e[7]) < tolerance &&
    Math.abs(e[11]) < tolerance && Math.abs(e[15] - 1) < tolerance && matrix.determinant() > 0;
}

/**
 * Maximum change of normalized frustum-plane distance for a crown centre.
 * Rotation moves a point at radius R by at most 2 sin(angle / 2) R;
 * translation adds at most its length. Sphere radius is unchanged by a rigid
 * view transform. This bounds every plane, including near/far and pitched views.
 * The radial ownership annuli deliberately remain at the last cull centre.
 */
export function cullMotionMargin(outer, cameraY, groundBounds, centreOffset) {
  const vertical = Math.max(Math.abs(groundBounds.minimum - cameraY),
    Math.abs(groundBounds.maximum - cameraY)) + centreOffset;
  const radius = Math.hypot(outer + centreOffset, vertical);
  return CULL_TRANSLATION_LIMIT + 2 * Math.sin(CULL_ROTATION_LIMIT / 2) * radius + 1e-4;
}

export class CullRefreshTracker {
  constructor(enabled = false) {
    this.enabled = enabled;
    this.initialized = false;
    this.world = new Matrix4();
    this.projection = new Matrix4();
    this.position = new Vector3();
    this.orientation = new Quaternion();
    this.livePosition = new Vector3();
    this.liveOrientation = new Quaternion();
  }

  supportsMotion(camera) {
    return this.enabled && isRigidCameraMatrix(camera.matrixWorld);
  }

  needsRefresh(camera) {
    if (!this.initialized || this.coordinateSystem !== camera.coordinateSystem ||
        !this.projection.equals(camera.projectionMatrix)) return true;
    if (this.world.equals(camera.matrixWorld)) return false;
    if (!this.rigid || !this.supportsMotion(camera)) return true;
    this.livePosition.setFromMatrixPosition(camera.matrixWorld);
    if (this.position.distanceToSquared(this.livePosition) > CULL_TRANSLATION_LIMIT ** 2 + 1e-12) return true;
    this.liveOrientation.setFromRotationMatrix(camera.matrixWorld).normalize();
    return Math.abs(this.orientation.dot(this.liveOrientation)) < rotationDotLimit - 1e-12;
  }

  commit(camera) {
    this.world.copy(camera.matrixWorld);
    this.projection.copy(camera.projectionMatrix);
    this.coordinateSystem = camera.coordinateSystem;
    this.position.setFromMatrixPosition(camera.matrixWorld);
    this.rigid = this.supportsMotion(camera);
    if (this.rigid) this.orientation.setFromRotationMatrix(camera.matrixWorld).normalize();
    this.initialized = true;
  }

  invalidate() { this.initialized = false; }
}
