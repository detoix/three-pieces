import * as THREE from 'three/webgpu';

// Input handling and DOM ownership stay outside the grass rendering package.

const KEY_ACTION = new Map([
  ['KeyW', 'forward'],
  ['ArrowUp', 'forward'],
  ['KeyS', 'back'],
  ['ArrowDown', 'back'],
  ['KeyA', 'left'],
  ['ArrowLeft', 'left'],
  ['KeyD', 'right'],
  ['ArrowRight', 'right'],
  ['ShiftLeft', 'run'],
  ['ShiftRight', 'run'],
]);

const UP = new THREE.Vector3(0, 1, 0);
const HALF_PI = Math.PI / 2 - 0.01;

export function createWebGPUWalkControls(
  camera,
  domElement,
  {
    groundAt = () => 0,
    eyeHeight = 1.7,
    limit = 66,
    speed = 2.8,
    runSpeed = 7,
  } = {},
) {
  const pressed = new Set();
  const look = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const wish = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const listeners = [];
  const moveTouch = { id: null, x: 0, y: 0, ox: 0, oy: 0 };
  const lookTouch = { id: null, x: 0, y: 0 };
  let touchDriven = false;
  let engaged = false;
  let onEngaged = () => {};

  const stick = document.createElement('div');
  stick.className = 'wg-stick';
  stick.hidden = true;
  stick.setAttribute('aria-hidden', 'true');
  const stickNub = document.createElement('div');
  stickNub.className = 'wg-stick-nub';
  stick.append(stickNub);
  domElement.parentElement?.append(stick);

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  }

  function markEngaged() {
    if (engaged) return;
    engaged = true;
    onEngaged();
  }

  function applyLook(dx, dy, scale) {
    look.y -= dx * scale;
    look.x -= dy * scale;
    look.x = Math.max(-HALF_PI, Math.min(HALF_PI, look.x));
    camera.quaternion.setFromEuler(look);
  }

  function onKeyDown(event) {
    const action = KEY_ACTION.get(event.code);
    if (!action) return;
    if (document.pointerLockElement === domElement) event.preventDefault();
    pressed.add(action);
  }

  function onKeyUp(event) {
    const action = KEY_ACTION.get(event.code);
    if (action) pressed.delete(action);
  }

  function onMouseMove(event) {
    if (document.pointerLockElement !== domElement) return;
    applyLook(event.movementX, event.movementY, 0.002);
  }

  function onPointerLockChange() {
    if (document.pointerLockElement === domElement) markEngaged();
    else pressed.clear();
  }

  function onCanvasClick(event) {
    if (event.pointerType === 'touch' || document.pointerLockElement) return;
    try {
      const request = domElement.requestPointerLock();
      request?.catch(() => {});
    } catch {
      // Pointer lock can be denied by browser policy; touch/keys still work.
    }
  }

  function setStick(clientX, clientY) {
    const host = domElement.parentElement?.getBoundingClientRect();
    stick.style.left = `${clientX - (host?.left ?? 0)}px`;
    stick.style.top = `${clientY - (host?.top ?? 0)}px`;
    stickNub.style.transform = 'translate(-50%, -50%)';
    stick.hidden = false;
  }

  function releaseMoveTouch() {
    moveTouch.id = null;
    moveTouch.x = 0;
    moveTouch.y = 0;
    stick.hidden = true;
  }

  function onPointerDown(event) {
    if (event.pointerType !== 'touch') return;
    touchDriven = true;
    markEngaged();
    if (event.clientX < window.innerWidth * 0.4 && moveTouch.id === null) {
      moveTouch.id = event.pointerId;
      moveTouch.ox = event.clientX;
      moveTouch.oy = event.clientY;
      setStick(event.clientX, event.clientY);
    } else if (lookTouch.id === null) {
      lookTouch.id = event.pointerId;
      lookTouch.x = event.clientX;
      lookTouch.y = event.clientY;
    } else {
      return;
    }
    try {
      domElement.setPointerCapture?.(event.pointerId);
    } catch {
      // The pointer may already be gone; pointerup/cancel will clear its role.
    }
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (event.pointerId === moveTouch.id) {
      const dx = event.clientX - moveTouch.ox;
      const dy = event.clientY - moveTouch.oy;
      const length = Math.hypot(dx, dy);
      const radius = 46;
      const scale = length > radius ? radius / length : 1;
      moveTouch.x = (dx * scale) / radius;
      moveTouch.y = (-dy * scale) / radius;
      stickNub.style.transform = `translate(calc(-50% + ${dx * scale}px), calc(-50% + ${dy * scale}px))`;
      event.preventDefault();
      return;
    }
    if (event.pointerId !== lookTouch.id) return;
    applyLook(event.clientX - lookTouch.x, event.clientY - lookTouch.y, 0.004);
    lookTouch.x = event.clientX;
    lookTouch.y = event.clientY;
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (event.pointerId === moveTouch.id) releaseMoveTouch();
    if (event.pointerId === lookTouch.id) lookTouch.id = null;
  }

  function onBlur() {
    pressed.clear();
    velocity.set(0, 0, 0);
    releaseMoveTouch();
    lookTouch.id = null;
  }

  on(document, 'keydown', onKeyDown);
  on(document, 'keyup', onKeyUp);
  on(document, 'mousemove', onMouseMove);
  on(document, 'pointerlockchange', onPointerLockChange);
  on(domElement, 'click', onCanvasClick);
  on(domElement, 'pointerdown', onPointerDown);
  on(domElement, 'pointermove', onPointerMove);
  on(domElement, 'pointerup', onPointerUp);
  on(domElement, 'pointercancel', onPointerUp);
  on(window, 'blur', onBlur);

  camera.position.y =
    groundAt(camera.position.x, camera.position.z) + eyeHeight;

  function update(delta) {
    const forwardAmount =
      (pressed.has('forward') ? 1 : 0) -
      (pressed.has('back') ? 1 : 0) +
      moveTouch.y;
    const rightAmount =
      (pressed.has('right') ? 1 : 0) -
      (pressed.has('left') ? 1 : 0) +
      moveTouch.x;

    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, UP).normalize();
    wish
      .copy(forward)
      .multiplyScalar(forwardAmount)
      .addScaledVector(right, rightAmount);
    const throttle = Math.min(1, wish.length());
    if (throttle > 0) wish.multiplyScalar(1 / wish.length());

    const targetSpeed = (pressed.has('run') ? runSpeed : speed) * throttle;
    wish.multiplyScalar(targetSpeed);
    const response = Math.min(1, delta * (throttle > 0 ? 12 : 8));
    velocity.lerp(wish, response);
    camera.position.addScaledVector(velocity, delta);
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -limit, limit);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, -limit, limit);
    camera.position.y =
      groundAt(camera.position.x, camera.position.z) + eyeHeight;
    camera.updateMatrixWorld(true);
  }

  return {
    update,
    setOnEngaged(callback) {
      onEngaged = callback;
    },
    get touchDriven() {
      return touchDriven;
    },
    dispose() {
      for (const [target, type, handler, options] of listeners) {
        target.removeEventListener(type, handler, options);
      }
      if (document.pointerLockElement === domElement)
        document.exitPointerLock();
      stick.remove();
    },
  };
}
