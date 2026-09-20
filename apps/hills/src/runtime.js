import * as THREE from 'three/webgpu';

import {
  CANOPY_PULL_MAX,
  LAWN,
  createGrass,
  createLawnSurface,
  lawnColorsFor,
} from '@detoix/three-pieces/grass';
import {
  AUTHORED_SKY,
  AUTHORED_SUN,
  applySkyLighting,
  createSky,
  sunDirectionFrom,
} from '@detoix/three-pieces/sky';
import {
  createHillsGroundMesh,
  createHillsHeightNode,
  hillsHeightAt,
  hillsHeightBounds,
} from '@detoix/three-pieces/terrain';

import { readHillsOptions, readSceneOptions } from './options.js';
import { createWebGPUWalkControls } from './walk-controls.js';

/** Ground grid reach; the camera's far plane and the haze sit inside it. */
const GROUND_RADIUS = 1500;
const CAMERA_FAR = 1450;

export async function startHills({ adapter }) {
  const lawn = readSceneOptions(location.search, window.devicePixelRatio);
  const options = readHillsOptions(location.search);
  const container = document.getElementById('app');
  const loading = document.getElementById('loading-screen');
  const loadingText = document.getElementById('loading-text');
  const hint = document.getElementById('walk-hint');
  const hud = document.getElementById('hills-hud');
  if (!container) throw new Error('The WebGPU canvas host is missing.');
  if (!options.ui) {
    hud?.setAttribute('hidden', '');
    hint?.setAttribute('hidden', '');
  }

  const renderer = new THREE.WebGPURenderer({
    antialias: lawn.msaa,
    powerPreference: 'high-performance',
    trackTimestamp: lawn.gpuTiming,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setPixelRatio(lawn.pixelRatio);
  renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
  container.append(renderer.domElement);

  let surface;
  let sky;
  let grass;
  let ground;
  let controls;
  let resize;
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    if (resize) window.removeEventListener('resize', resize);
    controls?.dispose();
    sky?.dispose();
    grass?.dispose();
    ground?.dispose();
    surface?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  try {
    if (loadingText) loadingText.textContent = 'Opening the WebGPU device…';
    await renderer.init();
    if (renderer.backend.isWebGPUBackend !== true) {
      throw new Error('Three.js fell back to WebGL2; the GPU-driven lawn requires the WebGPU backend.');
    }

    const camera = new THREE.PerspectiveCamera(62, 1, 0.1, CAMERA_FAR);
    camera.coordinateSystem = renderer.coordinateSystem;

    const heightBounds = hillsHeightBounds(options.hills);
    const heightAt = createHillsHeightNode(THREE.TSL, options.hills);
    // The packing interval must hold every height the function can return; the
    // bound is exact, so a centimetre either side is only for rounding.
    const packingMinimum = heightBounds.minimum - 0.01;
    const packingRange = heightBounds.span + 0.02;

    const greens = lawnColorsFor(lawn.lawnHue);
    if (loadingText) loadingText.textContent = 'Loading the CC0 lawn PBR maps…';
    surface = await createLawnSurface({
      renderer,
      underlay: lawn.underlay,
      greens,
      flatten: lawn.flatten,
      macroTint: lawn.macroTint,
      proxy: lawn.proxy,
      projectedProxy: lawn.projectedProxy,
      proxyBladeWidth: (LAWN.minWidth + LAWN.maxWidth) * 0.5 * lawn.bladeWidth,
      groundAO: lawn.groundAO,
      grainStrength: lawn.grain,
      variation: lawn.variation,
      backlight: lawn.backlight,
      heightAt,
    });

    const scene = new THREE.Scene();
    const skyLight = new THREE.HemisphereLight(AUTHORED_SKY.color, AUTHORED_SKY.ground, AUTHORED_SKY.intensity);
    const sun = new THREE.DirectionalLight(AUTHORED_SUN.color, AUTHORED_SUN.intensity);
    const sunDirection = sunDirectionFrom(lawn.sunElevation, lawn.sunAzimuth);
    sun.position.set(...sunDirection.map((component) => component * 100));
    scene.add(skyLight, sun, sun.target);

    let lighting = null;
    let cloudShadows = false;
    // The probe as baked, and the sky irradiance the lights were last pointed
    // at. The clouds report a sky of their own once a cache cycle -- brighter
    // and much less blue than the clear one -- and the lights follow it.
    let probe = null;
    let litSky = null;
    const followSky = () => {
      if (!probe || !lawn.skyLights) return;
      const cloudy = sky?.cloudySkyIrradiance ?? null;
      const skyIrradiance = cloudy ?? probe.sky;
      if (skyIrradiance === litSky) return;
      litSky = skyIrradiance;
      lighting = applySkyLighting({ sun, skyLight, probe: { sun: probe.sun, sky: skyIrradiance } });
    };
    if (lawn.sky === 'atmosphere') {
      if (loadingText) loadingText.textContent = 'Baking the atmosphere…';
      sky = createSky({
        renderer,
        sunElevation: lawn.sunElevation,
        sunAzimuth: lawn.sunAzimuth,
        exposure: lawn.skyExposure,
        multiScatter: lawn.skyMultiScatter,
        eyeHeightKm: 0.0017,
        clouds: lawn.clouds,
        cloudQuality: lawn.cloudQuality,
        cloudCoverage: lawn.cloudCoverage,
        cloudWindSpeed: lawn.cloudWindSpeed,
      });
      try {
        probe = await sky.bake();
        followSky();
      } catch (error) {
        console.warn('Sky lighting probe failed; keeping authored lights.', error);
      }
      scene.backgroundNode = sky.backgroundNode;
      scene.fogNode = sky.fogNodeFor({ near: options.hazeNear, far: options.hazeFar });
      // The sky's map of the sunlight that gets through the clouds, installed
      // as the sun's shadow. Three r185 takes a light's `shadow.shadowNode` in
      // place of the shadow map it would otherwise render, so no map is drawn
      // and the sun is simply multiplied by it wherever it lights a surface
      // that receives shadows: the ground, the blades, and the light through
      // the blades, which `GrassLightingModel` reads off the same shadowed
      // light colour.
      if (sky.cloudShadowNode && lawn.cloudShadows) {
        renderer.shadowMap.enabled = true;
        sun.castShadow = true;
        sun.shadow.shadowNode = sky.cloudShadowNode();
        cloudShadows = true;
      }
    } else {
      scene.background = new THREE.Color('#b8c9b5');
      scene.fog = new THREE.Fog('#b8c9b5', options.hazeNear, options.hazeFar);
    }

    ground = createHillsGroundMesh(THREE, {
      material: surface.material,
      radius: GROUND_RADIUS,
      heightBounds,
    });
    ground.mesh.receiveShadow = cloudShadows;
    scene.add(ground.mesh);

    if (loadingText) loadingText.textContent = 'Allocating persistent grass grids…';
    grass = createGrass({
      renderer,
      heightMap: { heightAt, normalStep: 0.25, packingMinimum, packingRange },
      groundBounds: { minimum: heightBounds.minimum, maximum: heightBounds.maximum },
      surface,
      // The blades receive the clouds' shadow. Nothing here casts one: the
      // hills are too gentle to shadow themselves at the default sun, and the
      // blades cast none by design.
      shadows: cloudShadows,
      coarseCulling: lawn.coarseCulling,
      cullHysteresis: lawn.cullHysteresis,
      subgroupCulling: lawn.subgroupCulling,
      tillers: lawn.tillers,
      minBladePixels: lawn.bladePixels,
      projectedCanopy: lawn.projectedProxy,
      poseCache: lawn.poseCache,
      diffuseOnly: lawn.diffuseOnly,
      backlight: lawn.backlight,
      bend: {
        min: LAWN.minBend * lawn.bendMin,
        max: Math.max(LAWN.minBend * lawn.bendMin, LAWN.maxBend * lawn.bendMax),
      },
      posture: { clumpPull: lawn.clumpPull, tillerFan: lawn.tillerFan },
      canopy: {
        near: Math.min(LAWN.canopyNormalNear * lawn.canopy, CANOPY_PULL_MAX),
        far: Math.min(LAWN.canopyNormalFar * lawn.canopy, CANOPY_PULL_MAX),
      },
      greens,
      heightCorrelation: lawn.variation,
      size: {
        minHeight: LAWN.minHeight * lawn.bladeHeight,
        maxHeight: LAWN.maxHeight * lawn.bladeHeight,
        minWidth: LAWN.minWidth * lawn.bladeWidth,
        maxWidth: LAWN.maxWidth * lawn.bladeWidth,
      },
    });
    scene.add(grass.group);

    const groundAt = (x, z) => hillsHeightAt(x, z, options.hills);
    const heading = THREE.MathUtils.degToRad(options.heading);
    camera.position.set(options.startX, groundAt(options.startX, options.startZ) + options.eye, options.startZ);
    camera.lookAt(
      camera.position.x + Math.sin(heading),
      camera.position.y - 0.08,
      camera.position.z - Math.cos(heading),
    );
    camera.updateMatrixWorld(true);

    controls = createWebGPUWalkControls(camera, renderer.domElement, {
      groundAt,
      eyeHeight: options.eye,
      limit: Infinity,
      speed: options.walkSpeed,
      runSpeed: options.runSpeed,
    });
    controls.setOnEngaged(() => hint?.setAttribute('hidden', ''));

    resize = function resizeRenderer() {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height);
      renderer.setPixelRatio(lawn.pixelRatio);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();

    const fpsText = document.querySelector('[data-stat="fps"]');
    const positionText = document.querySelector('[data-stat="position"]');
    const clock = new THREE.Clock();
    let frames = 0;
    let fpsSince = performance.now();
    let firstFrame = true;
    let captureResolve = null;

    function animate(now) {
      const delta = Math.min(clock.getDelta(), 0.05);
      controls.update(delta);
      ground.follow(camera);
      // The camera is the observer, so the clouds follow the walk.
      sky?.update(now / 1000, camera.position);
      followSky();
      grass.update(camera);
      renderer.render(scene, camera);

      // Reading the canvas in this callback, right after the draw, is the one
      // moment a WebGPU canvas is guaranteed to hold the frame just rendered.
      if (captureResolve) {
        const resolve = captureResolve;
        captureResolve = null;
        resolve(renderer.domElement.toDataURL('image/png'));
      }

      frames += 1;
      if (options.ui && now - fpsSince >= 500) {
        if (fpsText) fpsText.textContent = String(Math.round((frames * 1000) / (now - fpsSince)));
        if (positionText) {
          const { x, y, z } = camera.position;
          positionText.textContent = `${x.toFixed(0)}, ${z.toFixed(0)} · ${y.toFixed(1)} m`;
        }
        frames = 0;
        fpsSince = now;
      }
      if (firstFrame) {
        firstFrame = false;
        loading?.setAttribute('hidden', '');
        window.__ready = true;
      }
    }

    await renderer.setAnimationLoop(animate);
    window.addEventListener('beforeunload', dispose, { once: true });
    window.__hills = {
      renderer, camera, scene, grass, surface, sky, ground, lighting, options, lawn,
      // Scripts drive the camera from outside; these two are for them. `groundAt`
      // is the same function the walk controls use, so a script can stand the
      // camera on the terrain; `capture` resolves with the next rendered frame
      // as a PNG data URL.
      groundAt,
      capture: () => new Promise((resolve) => { captureResolve = resolve; }),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
