import * as THREE from 'three/webgpu';

const {
  Fn,
  If,
  atomicAdd,
  atomicLoad,
  atomicStore,
  attribute,
  cameraViewMatrix,
  color,
  cos,
  cross,
  float,
  floatBitsToUint,
  hash,
  instanceIndex,
  mix,
  negateOnBackSide,
  normalize,
  packSnorm2x16,
  packUnorm2x16,
  positionLocal,
  select,
  sin,
  storage,
  struct,
  textureLevel,
  transformNormalToView,
  uint,
  uintBitsToFloat,
  uniform,
  unpackSnorm2x16,
  unpackUnorm2x16,
  varyingProperty,
  vec2,
  vec3,
  vec4,
  vertexIndex,
} = THREE.TSL;

import { BLADE_CULL_CENTRE, bladeCullRadiusFactor } from './blade-arc.js';
import { canopyWeightNode } from './canopy-lod.js';
import { CullRefreshTracker, cullMotionMargin } from './cull-refresh.js';
import { CULL_WORKGROUP_SIZE, cullDispatchSize, emitSubgroupCompacted } from './subgroup-compaction.js';
import { GRASS_POSE_FLOATS, GrassBladePose, poseCrownCapacity } from './pose-cache.js';
import {
  bladeUniqueVertexCount,
  createBladeGeometry,
  CLOSE_RIBBON_MORPH_FROM,
  CLOSE_RIBBON_MORPH_TO,
} from './blade-geometry.js';
import {
  GRASS_BACKLIGHT,
  GrassLightingModel,
  normalizeBacklight,
} from './blade-lighting.js';
import {
  CANOPY_PULL_FLOOR,
  CANOPY_PULL_MAX,
  CLUMP_PULL_MARGIN,
  LAWN,
  LAWN_COLORS,
} from './preset.js';
import {
  GRASS_RINGS,
  RING_SEED_STRIDE,
  TOTAL_GRASS_CANDIDATES,
  WORLD_CELL_BIAS,
  bladeVertexCount,
  createRingState,
  grassTriangleCount,
  snapRingState,
} from './grid.js';
import { GRASS_RECORD_WORDS, grassStorageFootprint } from './record-layout.js';
import {
  GRASS_CULL_TILE_SIDE, GRASS_CULL_TILE_LANES, cullTileCapacity, selectCullTiles,
} from './cull-tiles.js';

// drawIndexedIndirect: indexCount, instanceCount, firstIndex, baseVertex,
// firstInstance. baseVertex is signed in WGSL but shares this 32-bit storage.
const DRAW_UINTS = 5;
const DRAW_BYTES = DRAW_UINTS * Uint32Array.BYTES_PER_ELEMENT;

const GrassRecord = struct(
  {
    // X/Z retain their exact f32 bits. The remaining bounded values use
    // normalized integers, giving this struct a 28-byte array stride.
    //
    // X and Z are two scalar words and not the `uvec2` they read as, and that
    // is the whole reason this struct fits in seven. A `uvec2` aligns to eight
    // bytes, and WGSL rounds an array's stride up to its element's alignment:
    // with the pair in it, six words of fields occupy six words but *seven*
    // occupy eight. The padding word is invisible -- `getLength()` reports it
    // and nothing else does -- so the clump word would have cost 8.4 MiB
    // across the three rings rather than 4.2. Two `uint`s align to four, and
    // seven words stride at seven.
    worldXBits: 'uint',
    worldZBits: 'uint',
    groundBlade: 'uint',
    normalXZ: 'uint',
    yawWidth: 'uint',
    appearance: 'uint',
    clumpHealth: 'uint',
  },
  'EzPackedGrassRecord',
);
if (GrassRecord.getLength() !== GRASS_RECORD_WORDS) {
  throw new Error(
    'Packed grass record layout must remain exactly seven words.',
  );
}

const DrawIndirect = struct(
  {
    indexCount: 'uint',
    instanceCount: { type: 'uint', atomic: true },
    firstIndex: 'uint',
    baseVertex: 'int',
    firstInstance: 'uint',
  },
  'EzGrassDrawIndirect',
);
if (DrawIndirect.getLength() !== DRAW_UINTS) {
  throw new Error('Indexed grass draw commands must remain exactly five words.');
}

/**
 * Frees the GPU buffer behind a storage attribute.
 *
 * `BufferAttribute.dispose()` only dispatches an event, and in the WebGPU path
 * the sole listener is registered by `Geometries` on a *geometry*. These
 * attributes are not geometry attributes -- the records and visible IDs are
 * bound as `storage()` nodes, and the draw commands arrive through
 * `setIndirect()`, which `Geometries.onDispose` also skips -- so nothing hears
 * it and the buffers outlive the lawn. Three r185 exposes no public way to
 * release one; `Attributes.delete()` is the same path `Geometries` takes, and
 * it both destroys the buffer and corrects `renderer.info.memory`. It no-ops
 * for an attribute the renderer never uploaded.
 */
function releaseStorageBuffer(renderer, attribute) {
  renderer._attributes?.delete(attribute);
}

function packAppearance(tint, retention, macro) {
  const tintByte = uint(tint.clamp(0, 1).mul(255).add(0.5));
  const macroByte = uint(macro.clamp(0, 1).mul(255).add(0.5));
  // Midpoint decoding deliberately excludes zero. Otherwise the lowest
  // quantized retention cohort would survive even when target density is 0.
  const retentionWord = uint(retention.clamp(0, 1).mul(65_536)).min(
    uint(65_535),
  );
  return tintByte
    .bitOr(macroByte.shiftLeft(uint(8)))
    .bitOr(retentionWord.shiftLeft(uint(16)));
}

function unpackAppearance(packed) {
  const tint = float(packed.bitAnd(uint(255))).div(255);
  const macro = float(packed.shiftRight(uint(8)).bitAnd(uint(255))).div(255);
  const retention = float(packed.shiftRight(uint(16)))
    .add(0.5)
    .div(65_536);
  return vec3(tint, retention, macro);
}

/**
 * The crown's clump and the health of the ground it stands in.
 *
 * Sixteen bits of clump heading, eight of clump shortening, eight of health.
 * The heading gets the wide field because it is an angle every crown in a
 * clump shares: quantize it to a byte and the lawn's headings fall into 256
 * directions, which at this clump size is a visible grain across open ground.
 * The other two are a fraction of a 4-8 cm blade and a signal that is fed
 * straight into a smoothstep, and neither can spend more than a byte usefully.
 */
function packClumpHealth(angleUnit, shortenUnit, health) {
  const angleWord = uint(angleUnit.clamp(0, 1).mul(65_535).add(0.5));
  const shortenByte = uint(shortenUnit.clamp(0, 1).mul(255).add(0.5));
  const healthByte = uint(health.clamp(0, 1).mul(255).add(0.5));
  return angleWord
    .bitOr(shortenByte.shiftLeft(uint(16)))
    .bitOr(healthByte.shiftLeft(uint(24)));
}

function unpackClumpHealth(packed) {
  const angle = float(packed.bitAnd(uint(65_535))).div(65_535);
  const shorten = float(packed.shiftRight(uint(16)).bitAnd(uint(255))).div(255);
  const health = float(packed.shiftRight(uint(24))).div(255);
  return vec3(angle, shorten, health);
}

function unpackGroundNormal(packed) {
  const xz = unpackSnorm2x16(packed).toVar('packedNormalXZ');
  const y = float(1).sub(xz.dot(xz)).max(0).sqrt();
  return normalize(vec3(xz.x, y, xz.y));
}

/**
 * Which clump a point belongs to: the nearest of a jittered lattice of clump
 * points, returned as its integer cell in `xy` and the squared distance to it
 * in `z`.
 *
 * This is the Voronoi scheme Ghost of Tsushima's grass uses, at a lawn's
 * scale. It has to search the full 3x3 neighbourhood: a clump point is jittered
 * anywhere inside its own cell, so the nearest one to a crown sitting near a
 * corner can be in any of the eight cells around it, and a cheaper 2x2 search
 * picks the wrong clump along two of the four edges.
 *
 * It runs once per crown, in placement, and the result is packed into the
 * record's seventh word. It used to run in `material.positionNode`, which put
 * a nine-cell search on every vertex of every blade for a value that is the
 * same at all of them: 45 vertices a near crown, nine neighbours each, 405
 * repeated hash-and-compare sequences to learn one angle and one scale. The
 * four bytes that hold it instead are the cheapest trade in this file.
 *
 * Placement is the right stage for it and not merely a cheaper one: a crown's
 * clump depends on nothing but where the crown is, and where the crown is, is
 * decided here and then never changes.
 *
 * Note what this seed does *not* carry, against the habit of every other seed
 * in this file: a ring salt. It must not. A crown either side of the 8 m
 * handover has to land in the same clump whichever ring draws it, and salting
 * per ring gives the near and mid grids different clumps for the same ground
 * -- a seam ring at 8 m and another at 24 m, exactly where the density
 * contract promises there is no step.
 */
function clumpAt(worldXZ) {
  const cell = worldXZ.div(LAWN.clumpSize).floor().toVar('clumpCell');
  const nearest = vec3(0, 0, 1e9).toVar('clumpNearest');
  for (let stepZ = -1; stepZ <= 1; stepZ += 1) {
    for (let stepX = -1; stepX <= 1; stepX += 1) {
      const neighbour = cell.add(vec2(stepX, stepZ));
      const seed = uint(neighbour.x.add(WORLD_CELL_BIAS))
        .mul(uint(1_664_525))
        .add(uint(neighbour.y.add(WORLD_CELL_BIAS)).mul(uint(1_013_904_223)));
      const point = neighbour
        .add(vec2(hash(seed.add(uint(31))), hash(seed.add(uint(37)))))
        .mul(LAWN.clumpSize);
      const offset = point.sub(worldXZ);
      const reach = offset.dot(offset);
      If(reach.lessThan(nearest.z), () => {
        nearest.assign(vec3(neighbour.x, neighbour.y, reach));
      });
    }
  }
  return nearest;
}

function createRingResources({
  ring,
  heightMap,
  drawAttribute,
  drawStorage,
  cameraWorld,
  cullCameraWorld,
  pixelScale,
  frustumPlanes,
  shadows,
  surface,
  keepAt,
  coarseCulling,
  subgroupCulling,
  minBladePixels,
  tillers,
  backlight,
  diffuseOnly,
  bend,
  posture,
  canopy,
  projectedCanopy,
  poseCache,
  heightCorrelation,
  greens,
  size,
}) {
  const state = createRingState(ring);
  const cullGuard = uniform(0);
  const cullCandidateCount = uniform(ring.capacity, 'uint');
  // One dispatch covers at most two disjoint newly exposed strips. In a
  // refill, the first rectangle covers the whole allocation.
  const placementRectA = uniform(new THREE.Vector4());
  const placementRectB = uniform(new THREE.Vector4());
  const placementFirstCount = uniform(0, 'uint');

  const recordAttribute = new THREE.StorageBufferAttribute(
    ring.capacity,
    GRASS_RECORD_WORDS,
    Uint32Array,
  );
  recordAttribute.name = `Grass ${ring.id} records`;
  const recordsWrite = storage(
    recordAttribute,
    GrassRecord,
    recordAttribute.count,
  );
  const recordsRead = storage(
    recordAttribute,
    GrassRecord,
    recordAttribute.count,
  ).toReadOnly();

  const visibleAttribute = new THREE.StorageBufferAttribute(
    ring.capacity,
    1,
    Uint32Array,
  );
  visibleAttribute.name = `Grass ${ring.id} visible IDs`;
  const visibleWrite = storage(
    visibleAttribute,
    'uint',
    visibleAttribute.count,
  );
  const visibleRead = storage(
    visibleAttribute,
    'uint',
    visibleAttribute.count,
  ).toReadOnly();

  const poseCapacity = poseCache ? poseCrownCapacity(ring, tillers) : 0;
  const poseAttribute = poseCapacity
    ? new THREE.StorageBufferAttribute(poseCapacity * tillers * (GRASS_POSE_FLOATS / 4), 4, Float32Array)
    : null;
  if (poseAttribute) poseAttribute.name = `Grass ${ring.id} visible poses`;
  // Three r185 duplicates a named struct declaration when it is used as both
  // a storage element and a function return. Keep storage as four vec4s and
  // use GrassBladePose only for local values. The 64-byte layout is unchanged.
  const poseWrite = poseAttribute ? storage(poseAttribute, 'vec4', poseAttribute.count) : null;
  const poseRead = poseAttribute
    ? storage(poseAttribute, 'vec4', poseAttribute.count).toReadOnly() : null;

  const cullTileAttribute = coarseCulling
    ? new THREE.StorageBufferAttribute(cullTileCapacity(ring), 4, Float32Array)
    : null;
  if (cullTileAttribute) {
    cullTileAttribute.name = `Grass ${ring.id} cull tiles`;
    cullTileAttribute.setUsage(THREE.DynamicDrawUsage);
  }
  const cullTiles = cullTileAttribute
    ? storage(cullTileAttribute, 'vec4', cullTileAttribute.count).toReadOnly()
    : null;

  // A procedural `heightAt` has no domain edge, which is what an unbounded
  // terrain needs: the rings follow the camera and every placement asks the
  // function directly. The texture form clamps at its extent.
  const groundHeightAt = heightMap.heightAt ?? Fn(([worldXZ]) => {
    const uv = worldXZ
      .div(heightMap.extent * 2)
      .add(0.5)
      .clamp(0, 1);
    return textureLevel(heightMap.texture, uv, float(0))
      .r.mul(heightMap.scale)
      .add(heightMap.minimum);
  });

  const placementCompute = Fn(() => {
    const cell = vec2(0).toVar('worldCell');
    If(instanceIndex.lessThan(placementFirstCount), () => {
      const width = uint(placementRectA.z).max(uint(1));
      cell.assign(placementRectA.xy.add(vec2(
        float(instanceIndex.mod(width)), float(instanceIndex.div(width)),
      )));
    }).Else(() => {
      const slot = instanceIndex.sub(placementFirstCount);
      const width = uint(placementRectB.z).max(uint(1));
      cell.assign(placementRectB.xy.add(vec2(
        float(slot.mod(width)), float(slot.div(width)),
      )));
    });
    // Positive modulo expressed with floor works for negative world cells as
    // well. This mapping never depends on the camera or the current origin.
    const wrapped = cell.sub(cell.div(ring.side).floor().mul(ring.side));
    const recordIndex = uint(wrapped.y).mul(uint(ring.side)).add(uint(wrapped.x));
    // The bias keeps signed cells positive before the WGSL float→uint cast.
    const seed = uint(cell.x.add(WORLD_CELL_BIAS))
      .mul(uint(1_664_525))
      .add(uint(cell.y.add(WORLD_CELL_BIAS)).mul(uint(1_013_904_223)))
      .add(uint(ring.seedIndex * RING_SEED_STRIDE))
      .toVar('cellSeed');
    const jitter = vec2(hash(seed.add(11)), hash(seed.add(23)))
      .sub(0.5)
      .mul(0.8);
    const worldXZ = cell
      .add(0.5)
      .add(jitter)
      .mul(ring.spacing)
      .toVar('worldXZ');
    const height = groundHeightAt(worldXZ).toVar('groundHeight');
    const normalStep = heightMap.normalStep ?? heightMap.texelWorldSize;
    const heightLeft = groundHeightAt(worldXZ.sub(vec2(normalStep, 0)));
    const heightRight = groundHeightAt(worldXZ.add(vec2(normalStep, 0)));
    const heightDown = groundHeightAt(worldXZ.sub(vec2(0, normalStep)));
    const heightUp = groundHeightAt(worldXZ.add(vec2(0, normalStep)));
    const normal = normalize(
      vec3(
        heightLeft.sub(heightRight),
        normalStep * 2,
        heightDown.sub(heightUp),
      ),
    ).toVar('groundNormal');

    const bladeWidthUnit = hash(seed.add(53));
    const yawUnit = hash(seed.add(67));
    const tint = hash(seed.add(79));
    const retention = hash(seed.add(97));
    const macro = surface.macroAt(worldXZ);
    // The two scales of world signal this crown answers to: the metre-scale
    // macro that varies its density and tint, and the patch-scale health that
    // decides whether it is standing in a dry part of the lawn. The ground
    // under it reads that second one through the same `healthAt`.
    const health = surface.healthAt(worldXZ);
    // Vigour: ground that holds water grows taller as well as greener, so the
    // crown's height is part its own hash and part the patch it stands in.
    // See `LAWN.heightCorrelation` -- without this a dry patch was short-of-
    // water grass at exactly the height of the lush grass beside it.
    const vigour = macro.add(health).mul(0.5);
    const bladeHeightUnit = mix(
      hash(seed.add(41)),
      vigour,
      float(LAWN.heightCorrelation * heightCorrelation),
    ).clamp(0, 1);
    const clump = clumpAt(worldXZ).toVar('crownClump');
    const clumpSeed = uint(clump.x.add(WORLD_CELL_BIAS))
      .mul(uint(1_664_525))
      .add(uint(clump.y.add(WORLD_CELL_BIAS)).mul(uint(1_013_904_223)))
      .toVar('clumpSeed');
    const record = recordsWrite.element(recordIndex);
    record.get('worldXBits').assign(floatBitsToUint(worldXZ.x));
    record.get('worldZBits').assign(floatBitsToUint(worldXZ.y));
    record
      .get('groundBlade')
      .assign(
        packUnorm2x16(
          vec2(
            height.sub(heightMap.packingMinimum).div(heightMap.packingRange),
            bladeHeightUnit,
          ),
        ),
      );
    record.get('normalXZ').assign(packSnorm2x16(normal.xz));
    record.get('yawWidth').assign(packUnorm2x16(vec2(yawUnit, bladeWidthUnit)));
    record.get('appearance').assign(packAppearance(tint, retention, macro));
    record
      .get('clumpHealth')
      .assign(
        packClumpHealth(
          hash(clumpSeed.add(uint(59))),
          hash(clumpSeed.add(uint(43))),
          health,
        ),
      );
  })()
    .compute(ring.capacity, [64])
    .setName(`Place ${ring.id} grass`);

  const cullBody = Fn(() => {
    const candidateIndex = uint(instanceIndex).toVar('grassCandidateIndex');
    const emit = subgroupCulling ? uint(0).toVar('grassEmit') : null;
    const evaluateCandidate = () => {
      let validLane = uint(1).equal(uint(1));
      if (coarseCulling) {
        const tile = cullTiles.element(instanceIndex.div(uint(GRASS_CULL_TILE_LANES)));
        const lane = instanceIndex.mod(uint(GRASS_CULL_TILE_LANES));
        const column = lane.mod(uint(GRASS_CULL_TILE_SIDE));
        const row = lane.div(uint(GRASS_CULL_TILE_SIDE));
        validLane = column.lessThan(uint(tile.z)).and(row.lessThan(uint(tile.w)));
        const cell = tile.xy.add(vec2(float(column), float(row)));
        const wrapped = cell.sub(cell.div(ring.side).floor().mul(ring.side));
        candidateIndex.assign(uint(wrapped.y).mul(uint(ring.side)).add(uint(wrapped.x)));
      }
      If(validLane, () => {
        const record = recordsRead.element(candidateIndex);
        const worldXZ = vec2(
          uintBitsToFloat(record.get('worldXBits')),
          uintBitsToFloat(record.get('worldZBits')),
        );
        const groundBlade = unpackUnorm2x16(record.get('groundBlade')).toVar(
          'packedGroundBlade',
        );
        const groundHeight = groundBlade.x
          .mul(heightMap.packingRange)
          .add(heightMap.packingMinimum);
        const bladeHeight = mix(size.minHeight, size.maxHeight, groundBlade.y);
        const normal = unpackGroundNormal(record.get('normalXZ'));
        const yawWidth = unpackUnorm2x16(record.get('yawWidth'));
        const bladeWidth = mix(size.minWidth, size.maxWidth, yawWidth.y);
        const appearance = unpackAppearance(record.get('appearance')).toVar(
          'packedAppearance',
        );
        const base = vec3(worldXZ.x, groundHeight, worldXZ.y);
        const delta = base.xz.sub(cullCameraWorld.xz);
        const distance = delta.length().toVar('ringDistance');
        const t = distance
          .sub(ring.densityInner)
          .div(ring.densityOuter - ring.densityInner)
          .clamp(0, 1);
        const smooth = t.mul(t).mul(float(3).sub(t.mul(2)));
        const density = mix(ring.densityNear, ring.densityFar, smooth).mul(
          surface.densityFrom(appearance.z),
        );
        const retained = appearance.y.lessThanEqual(
          density.div(ring.candidateDensity).clamp(0, 1),
        );
        const owned = distance
          .greaterThanEqual(ring.inner)
          .and(distance.lessThan(ring.outer));

        // Test a conservative sphere against normalized world-space frustum
        // planes. Centreline point tests miss a strip that crosses the edge while
        // all sampled centres are outside. The extra 8% covers the resting bend --
        // a tip at LAWN.maxBend sits 0.527 of the blade's height from this centre,
        // so the margin is real but finite. The width term covers the widest pair
        // of vertices at their most thickened, because the vertex stage widens a
        // sub-pixel blade and this pass never learns by how much.
        const sphereCentre = base.add(
          normal.mul(bladeHeight.mul(BLADE_CULL_CENTRE)),
        );
        const sphereRadius = bladeHeight
          .mul(bladeCullRadiusFactor(bend.max))
          .add(bladeWidth.mul(0.5 * LAWN.maxThicken))
          .add(LAWN.tillerSpread * 0.5)
          .add(cullGuard);
        let inFrustum = frustumPlanes[0].xyz
          .dot(sphereCentre)
          .add(frustumPlanes[0].w)
          .greaterThanEqual(sphereRadius.negate());
        for (let index = 1; index < frustumPlanes.length; index += 1) {
          const plane = frustumPlanes[index];
          inFrustum = inFrustum.and(
            plane.xyz
              .dot(sphereCentre)
              .add(plane.w)
              .greaterThanEqual(sphereRadius.negate()),
          );
        }

        // An optional world-space keep-out, tested here rather than baked into a
        // placement record: the six record words are full, and stealing precision
        // from the blade-width channel to store one bit would change a packing
        // contract the whole field depends on. A caller that passes no mask builds
        // no node, so a caller without a mask generates the shader it always did.
        let keep = owned.and(retained).and(inFrustum);
        if (keepAt) keep = keep.and(keepAt(worldXZ));

        if (subgroupCulling) {
          emit.assign(select(keep, uint(1), uint(0)));
        } else {
          If(keep, () => {
            const draw = drawStorage.element(uint(ring.index));
            const outputIndex = atomicAdd(draw.get('instanceCount'), uint(1));
            visibleWrite.element(outputIndex).assign(candidateIndex);
          });
        }
      });
    };
    if (subgroupCulling) {
      // Padded lanes participate in every collective but never read a tile or
      // record. No collective is nested in validity or visibility branches.
      If(instanceIndex.lessThan(cullCandidateCount), evaluateCandidate);
      emitSubgroupCompacted(candidateIndex, emit,
        drawStorage.element(uint(ring.index)).get('instanceCount'), visibleWrite);
    } else {
      evaluateCandidate();
    }
  })();
  const cullCompute = cullBody.compute(
    subgroupCulling ? cullDispatchSize(ring.capacity) : ring.capacity,
    [CULL_WORKGROUP_SIZE],
  ).setName(`Cull ${ring.id} grass`);

  const morphToRibbon = ring.id === 'close';
  const geometry = createBladeGeometry(ring.segments, tillers, { ...ring, morphToRibbon });
  geometry.instanceCount = ring.capacity;
  geometry.setIndirect(drawAttribute, ring.index * DRAW_BYTES);

  const bladeNormal = varyingProperty('vec3', `vEzGrassNormal${ring.index}`);
  const bladeCanopy = varyingProperty('vec4', `vEzGrassCanopy${ring.index}`);
  const bladeTint = varyingProperty('float', `vEzGrassTint${ring.index}`);
  const bladeGradient = varyingProperty(
    'float',
    `vEzGrassGradient${ring.index}`,
  );
  const bladeMacro = varyingProperty('float', `vEzGrassMacro${ring.index}`);
  const bladeDry = varyingProperty('float', `vEzGrassDry${ring.index}`);
  const material = diffuseOnly
    ? new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, forceSinglePass: true })
    : new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      forceSinglePass: true,
      roughness: LAWN.bladeRoughness,
      metalness: 0,
    });
  // The exact same expansion builds cached compute poses and the analytic
  // vertex fallback. Only vertex-local curvature/normal and camera-dependent
  // widening/canopy stay below in the material.
  const expandPose = Fn(([candidate, tiller]) => {
    const record = recordsRead.element(candidate);
    const worldXZ = vec2(
      uintBitsToFloat(record.get('worldXBits')),
      uintBitsToFloat(record.get('worldZBits')),
    );
    const groundBlade = unpackUnorm2x16(record.get('groundBlade')).toVar(
      'packedGroundBlade',
    );
    const groundHeight = groundBlade.x
      .mul(heightMap.packingRange)
      .add(heightMap.packingMinimum);
    const crownHeight = mix(size.minHeight, size.maxHeight, groundBlade.y);
    const groundNormal = unpackGroundNormal(record.get('normalXZ'));
    const yawWidth = unpackUnorm2x16(record.get('yawWidth')).toVar(
      'packedYawWidth',
    );
    // Its own seed, composed from where the blade stands the way the placement
    // pass composes cells. The record's six words are full, and a tiller is
    // cheaper to re-derive here than a packing contract is to change.
    const tillerSeed = record
      .get('worldXBits')
      .mul(uint(1_664_525))
      .add(record.get('worldZBits').mul(uint(1_013_904_223)))
      .add(tiller.mul(uint(2_654_435_761)))
      .toVar('tillerSeed');
    // Read, not searched for. Placement did the nine-cell Voronoi once for
    // this crown and packed the answer; all that is left here is the range
    // mapping, which stays beside `LAWN` for the same reason the blade's
    // height and width do.
    const clumpHealth = unpackClumpHealth(record.get('clumpHealth')).toVar(
      'packedClumpHealth',
    );
    const clumpAngle = clumpHealth.x.mul(Math.PI * 2);
    const clumpShorten = mix(
      float(LAWN.clumpShortest),
      float(1),
      clumpHealth.y,
    );

    const crownYaw = yawWidth.x.mul(Math.PI * 2);
    const bladeWidth = mix(size.minWidth, size.maxWidth, yawWidth.y);
    // The crown's own facing, pulled round towards its clump's. Added, not
    // mixed: a mix of two opposed headings cancels to a vector with no
    // direction, and this sum cannot fall below `clumpPull - 1`.
    const crownHeading = vec3(cos(crownYaw), 0, sin(crownYaw)).add(
      vec3(cos(clumpAngle), 0, sin(clumpAngle)).mul(posture.clumpPull),
    );
    // The crown's tangent frame. Both the tuft's spread and each blade's fan
    // are rotations inside it, so a slope tilts the whole crown once.
    const crownForward = normalize(
      crownHeading.sub(groundNormal.mul(crownHeading.dot(groundNormal))),
    );
    const crownSide = normalize(cross(groundNormal, crownForward));
    // Fan each blade off the crown's facing and stand it off the crown centre.
    // Unfanned, a tuft is parallel blades stacked in one place, which reads as
    // one fat blade rather than several thin ones.
    const fan = hash(tillerSeed.add(uint(149)))
      .sub(0.5)
      .mul(posture.tillerFan)
      .toVar('tillerFan');
    const forward = crownForward
      .mul(cos(fan))
      .add(crownSide.mul(sin(fan)))
      .toVar('bladeForward');
    const side = crownSide
      .mul(cos(fan))
      .sub(crownForward.mul(sin(fan)))
      .toVar('bladeSide');
    const crownAngle = float(tiller)
      .mul((2 * Math.PI) / tillers)
      .add(crownYaw);
    const crownOffset = crownSide
      .mul(cos(crownAngle))
      .add(crownForward.mul(sin(crownAngle)))
      // Uniform disk area, with one angular stratum per tiller. A linear
      // radius piles half the roots into the inner quarter of the disk.
      .mul(hash(tillerSeed.add(uint(167))).sqrt().mul(LAWN.tillerSpread * 0.5));
    // How dry this blade is: its patch, modulated by its own hash. The patch
    // is what makes the variation read as ground rather than as noise, and
    // the modulation is what stops the patch being a flat wash -- it is a
    // multiplier on the patch and not a signal of its own, so a blade in
    // green turf multiplies zero and stays green however its hash fell.
    const dry = surface
        .dryAt(clumpHealth.z)
        .mul(
          mix(
            float(1 - LAWN.dryScatter),
            float(1 + LAWN.dryScatter),
            hash(tillerSeed.add(uint(193))),
          ),
        )
        .clamp(0, 1)
        .mul(LAWN.dryStrength);

    // Tillers of one crown are not all the same age. Equal heights read as a
    // mown bristle; this only ever shortens a blade, so the crown's culling
    // sphere -- measured from its full height -- still contains every one.
    const bladeHeight = crownHeight
      .mul(clumpShorten)
      .mul(
        mix(
          float(LAWN.tillerShortest),
          float(1),
          hash(tillerSeed.add(uint(181))),
        ),
      )
      .toVar('bladeHeight');
    const bendUnit = hash(tillerSeed.add(uint(131)));
    const bladeBend = mix(float(bend.min), float(bend.max), bendUnit).toVar(
      'bladeBend',
    );
    const base = vec3(worldXZ.x, groundHeight, worldXZ.y).add(crownOffset);
    return GrassBladePose({
      baseHeight: vec4(base, bladeHeight),
      forwardWidth: vec4(forward, bladeWidth),
      sideBend: vec4(side, bladeBend),
      normalDry: vec4(groundNormal, dry),
    });
  });
  const poseCompute = poseCapacity ? Fn(() => {
    const crown = instanceIndex.div(uint(tillers));
    const visibleCount = atomicLoad(drawStorage.element(uint(ring.index)).get('instanceCount'));
    If(crown.lessThan(uint(poseCapacity)).and(crown.lessThan(visibleCount)), () => {
      const candidate = visibleRead.element(crown);
      const expanded = expandPose(candidate, instanceIndex.mod(uint(tillers))).toVar('expandedPose');
      const offset = instanceIndex.mul(uint(4));
      ['baseHeight', 'forwardWidth', 'sideBend', 'normalDry'].forEach((field, index) => {
        poseWrite.element(offset.add(uint(index))).assign(expanded.get(field));
      });
    });
  })().compute(poseCapacity * tillers, [64]).setName(`Expand ${ring.id} grass poses`) : null;

  material.positionNode = Fn(() => {
    const candidate = visibleRead.element(instanceIndex);
    const record = recordsRead.element(candidate);
    const appearance = unpackAppearance(record.get('appearance'));
    const tiller = vertexIndex.div(uint(bladeUniqueVertexCount(ring.segments, ring)));
    const pose = GrassBladePose().toVar('bladePose');
    if (poseCapacity) {
      // An explicit branch is essential: overflow must render every crown,
      // and cached vertices must not eagerly evaluate the expensive fallback.
      If(instanceIndex.lessThan(uint(poseCapacity)), () => {
        const offset = instanceIndex.mul(uint(tillers)).add(tiller).mul(uint(4));
        ['baseHeight', 'forwardWidth', 'sideBend', 'normalDry'].forEach((field, index) => {
          pose.get(field).assign(poseRead.element(offset.add(uint(index))));
        });
      }).Else(() => { pose.assign(expandPose(candidate, tiller)); });
    } else {
      pose.assign(expandPose(candidate, tiller));
    }
    const base = pose.get('baseHeight').xyz.toVar('bladeBase');
    const bladeHeight = pose.get('baseHeight').w;
    const forward = pose.get('forwardWidth').xyz;
    const bladeWidth = pose.get('forwardWidth').w;
    const side = pose.get('sideBend').xyz;
    const bladeBend = pose.get('sideBend').w;
    const groundNormal = pose.get('normalDry').xyz;
    const toCamera = cameraWorld.sub(base).toVar('bladeToCamera');
    const ribbonShape = morphToRibbon ? attribute('grassRibbonShape', 'vec4') : null;
    const ribbonMorph = morphToRibbon ? toCamera.xz.length()
      .smoothstep(CLOSE_RIBBON_MORPH_FROM, CLOSE_RIBBON_MORPH_TO).toVar('closeRibbonMorph') : null;
    bladeDry.assign(pose.get('normalDry').w);
    bladeTint.assign(appearance.x);
    bladeGradient.assign(positionLocal.y);
    bladeMacro.assign(appearance.z);
    // A constant-curvature arc to second order: the tip reaches forward by
    // bend/2 of the blade's length and the blade loses the height it spends
    // doing it, so leaning bends a blade over rather than stretching it.
    const along = positionLocal.y.toVar('bladeAlong');
    let rise = along.sub(
      bladeBend.mul(bladeBend).mul(along).mul(along).mul(along).div(6),
    );
    let reach = bladeBend.mul(along).mul(along).mul(0.5);
    let widthCoordinate = positionLocal.x;
    if (morphToRibbon) {
      // The root and tip do not move. Interior vertices approach their chord;
      // a convex interpolation stays within the existing crown culling sphere.
      rise = mix(rise, along.mul(float(1).sub(bladeBend.mul(bladeBend).div(6))), ribbonMorph);
      reach = mix(reach, along.mul(bladeBend).mul(.5), ribbonMorph);
      widthCoordinate = mix(widthCoordinate, ribbonShape.x, ribbonMorph);
    }

    // Two normals over flat geometry. Along the blade, the arc's own tangent:
    // a blade tipped forward by `lean` faces that much further down, which is
    // what makes the resting bend visible in light rather than in silhouette
    // alone. Across it, a splay toward each edge, interpolated between the two
    // sides to shade a two-vertex strip as the curved section it stands for.
    const lean = bladeBend.mul(along).toVar('bladeLean');
    const splay = positionLocal.x
      .mul(2 * LAWN.normalSpread)
      .toVar('bladeSplay');
    let bladeFacing = forward
      .mul(cos(lean))
      .sub(groundNormal.mul(sin(lean)))
      .mul(cos(splay))
      .add(side.mul(sin(splay)))
      .toVar('bladeFacing');
    if (morphToRibbon) {
      // Match the ribbon's endpoint normals along each edge as it straightens.
      // No normalization here: the near ribbon also interpolates raw normals.
      const rootFacing = forward.mul(Math.cos(LAWN.normalSpread)).add(side.mul(ribbonShape.y));
      const tipFacing = forward.mul(cos(bladeBend)).sub(groundNormal.mul(sin(bladeBend)))
        .mul(ribbonShape.z).add(side.mul(ribbonShape.w));
      bladeFacing = mix(bladeFacing, mix(rootFacing, tipFacing, along), ribbonMorph);
    }
    bladeNormal.assign(bladeFacing);

    // Widen a blade only as far as it falls under `minBladePixels` on screen.
    // `facing` is how much of the blade's width survives projection: 1 face-on,
    // towards 0 as it turns its edge to the camera, which is the other way a
    // blade goes sub-pixel besides distance. Capped, because the culling
    // sphere is sized from the true width -- see LAWN.maxThicken.
    const viewDistance = toCamera.length().toVar('bladeViewDistance');
    const viewDir = toCamera.div(viewDistance.max(1e-4));
    const alignment = side.dot(viewDir);
    const facing = float(1).sub(alignment.mul(alignment)).max(0).sqrt();
    const shown = bladeWidth.mul(facing).max(1e-6);
    const wanted = viewDistance.mul(pixelScale).mul(minBladePixels);
    const thicken = wanted.div(shown).clamp(1, LAWN.maxThicken);

    // The shading normal, which is not the blade's own. See `canopyNormalNear`:
    // a blade is 3 mm wide, a pixel covers several of them within a few metres,
    // and shading each by its literal facing makes a clump that happens to face
    // the sun a bright slab beside a dark one. Pull it toward the ground's --
    // the thing a patch of unresolved blades averages to -- further with
    // distance, and let the blade keep more of its own facing close up, where
    // its curvature is several pixels wide and worth drawing.
    //
    // The transmission term does *not* read this one. It is handed the blade's
    // own normal instead, because it asks whether the sun is behind this blade
    // and a normal tipped up towards the sky answers no for the whole lawn.
    // Share the underlay's physical-pixel and missing-density transition.
    // Root depth comes from the view matrix: eye distance is not perspective
    // depth, especially near the screen edges or when looking down at turf.
    // Use the authored mean width before minimum-pixel silhouette widening,
    // just as surface.proxyBladeWidth does, so both representations agree.
    const canopyWeight = projectedCanopy
      ? canopyWeightNode(toCamera.xz.length(),
          cameraViewMatrix.mul(vec4(base, 1)).z.negate().max(1e-4),
          float((size.minWidth + size.maxWidth) * 0.5), pixelScale)
      : viewDistance.smoothstep(LAWN.canopyNormalFrom, LAWN.canopyNormalTo);
    const canopyPull = mix(
      float(canopy.near),
      float(canopy.far),
      canopyWeight,
    ).toVar('canopyPull');
    // Facing is known in the fragment stage. Carry the ground normal and
    // weight there: flipping a mix here would turn its upward ground term
    // downward on every backface, giving half the turf dark undersides.
    bladeCanopy.assign(vec4(groundNormal, canopyPull));

    return base
      .add(side.mul(widthCoordinate.mul(bladeWidth).mul(thicken)))
      .add(groundNormal.mul(rise.mul(bladeHeight)))
      .add(forward.mul(reach.mul(bladeHeight)));
  })();
  // The blade's own facing, in the same view space and flipped to face the eye
  // the same way -- the gate the transmission term needs, and the one thing
  // the canopy pull above must not take away from it.
  const bladeNormalView = negateOnBackSide(
    transformNormalToView(bladeNormal).normalize(),
  );
  material.normalNode = Fn(() => {
    // Face the leaf towards the eye first, then pull towards the canopy's
    // upward normal. The latter describes the ground, not a two-sided leaf,
    // and must not flip when the eye crosses a blade's back face.
    const groundNormalView = bladeCanopy.xyz
      .transformNormalByViewMatrix(cameraViewMatrix);
    const canopyNormal = mix(
      bladeNormalView,
      groundNormalView,
      bladeCanopy.w,
    ).toVar('canopyNormal');
    // User-selected bend ranges can oppose the two directions exactly. Keep
    // the leaf normal at cancellation; never normalize a zero-length vector.
    const canopyLength = canopyNormal.length().toVar('canopyLength');
    return select(
      canopyLength.greaterThan(float(CANOPY_PULL_FLOOR)),
      canopyNormal.div(canopyLength.max(float(CANOPY_PULL_FLOOR))),
      bladeNormalView,
    );
  })();
  // The light that comes *through* a blade. It is a lighting model rather than
  // an emissive term because only the lighting model is handed a `lightColor`
  // the shadow has already been applied to -- an emissive rim would glow in
  // shade, which is the mistake this is avoiding. One per ring, because it
  // reads that ring's own blade-height varying.
  // `?backlight=off` leaves the stock `PhysicalLightingModel` in place, which
  // is the A/B control: same geometry, same records, same draws, one term
  // gone. It is also the only way to see what the term contributes, because
  // both pages open looking away from their own sun.
  if (diffuseOnly || backlight !== GRASS_BACKLIGHT.off) {
    const lightingModel = new GrassLightingModel(bladeGradient, {
      mode: backlight,
      backlightColor: greens.backlight,
      bladeNormalView,
      diffuseOnly,
    });
    material.setupLightingModel = () => lightingModel;
  }
  // A blade stands in a few centimetres of its neighbours and its root sees
  // very little of the sky. Nothing here draws that -- these blades cast no
  // shadow-map silhouette on purpose -- so the occlusion is asserted: darken
  // the bottom `rootOcclusionHeight` of every blade towards `rootOcclusion`.
  // It is the cheapest thing in this material that gives a plane of lit
  // strips a floor to sit on.
  const rootOcclusion = mix(
    float(LAWN.rootOcclusion),
    float(1),
    bladeGradient.clamp(0, 1).smoothstep(0, LAWN.rootOcclusionHeight),
  );
  material.colorNode = mix(
    color(greens.bottom),
    color(greens.top),
    bladeGradient.clamp(0, 1),
  )
    .mul(bladeTint.mul(0.18).add(0.91))
    .mul(surface.tintFrom(bladeMacro))
    .mul(surface.dryTintFrom(bladeDry))
    .mul(rootOcclusion);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `GPU lawn · ${ring.id}`;
  mesh.frustumCulled = false;
  // Short lawn blades do not cast a useful shadow-map silhouette, but they do
  // receive the terrain/sun shadow. This is real lit geometry, not a splat.
  mesh.castShadow = false;
  mesh.receiveShadow = shadows;

  return {
    ring,
    state,
    placementRectA,
    placementRectB,
    placementFirstCount,
    recordAttribute,
    visibleAttribute,
    cullTileAttribute,
    cullTileCount: 0,
    cullGuard,
    cullCandidateCount,
    poseAttribute,
    poseCompute,
    placementCompute,
    cullCompute,
    geometry,
    material,
    mesh,
  };
}

/**
 * @param {object} options
 * @param {number} [options.tillers] Blades grown from each crown. Per crown,
 *   so slots, placement, culling and storage are all unchanged by it and only
 *   the vertex stage and fill grow. Uniform across the three rings on purpose:
 *   the bands hand over at matched densities, and tillering one harder than
 *   its neighbour puts a step at 8 m or 24 m.
 * @param {{min: number, max: number}} [options.bend] Radians the tip leans
 *   from upright at rest, drawn per blade across this range. The culling
 *   sphere is sized from `max` rather than from a constant, so widening it
 *   cannot quietly push blades outside the bound that decides whether to draw
 *   them -- it grows the sphere, and more blades survive the cull.
 * @param {boolean|'blade'|'view'|'off'} [options.backlight] Light transmitted
 *   through a blade. `blade` gates it on the blade's own normal; `view` is the
 *   shipped view-only lobe and `off` the stock physical lighting model, both
 *   kept as A/B controls.
 * @param {boolean} [options.diffuseOnly] Grass-only Lambert reflection A/B.
 *   Preserves transmission, shadows and geometry; the underlay stays PBR.
 * @param {object} [options.size] Blade dimensions in metres, as
 *   `{minHeight, maxHeight, minWidth, maxWidth}`. Height is the coverage
 *   lever -- 93-97% of what a blade covers at this camera's angles comes from
 *   it. The culling sphere is derived from the height passed here, so it grows
 *   with it rather than being outgrown by it.
 * @param {object} [options.greens] The lawn palette, from `lawnColorsFor()`.
 *   Drawn around `LAWN_TARGET_HUE`; see `lawnColorsFor()`.
 * @param {{clumpPull: number, tillerFan: number}} [options.posture] How much
 *   of a crown's facing its clump dictates, and the radians of yaw its blades
 *   are fanned across. Both are how correlated neighbouring blades are, which
 *   is what decides whether a patch of lawn shades as a sheet or as a canopy,
 *   so they are dialled together. Neither moves the culling sphere: the pull
 *   normalizes a heading and the fan is yaw inside the crown's own frame.
 * @param {{near: number, far: number}} [options.canopy] How far a blade's
 *   shading normal is pulled toward the ground's, close up and far off. It is
 *   the shading normal alone: transmission keeps the blade's own facing, or a
 *   lawn pulled flat stops being backlit. `?canopy=0` is the control.
 * @param {boolean} [options.poseCache] Opt-in 8 MiB bounded visible-pose cache.
 *   Overflow crowns retain their exact analytic expansion; close/far are uncached.
 * @param {boolean} [options.projectedCanopy] Opt-in shared underlay/blade
 *   transition from projected physical width and missing geometry density.
 * @param {Function} [options.keepAt] Optional world-space mask,
 *   `(worldXZ) => booleanNode`, returning false where no blade may stand. Used
 *   to cut the lawn out of a planting or a building's footprint; most callers
 *   pass none.
 * @param {boolean} [options.cullHysteresis] Reuse guarded visibility for up to
 *   0.15 m of translation / 4 degrees of rotation. Radial LOD ownership and
 *   density remain relative to the last cull; vertex shading follows the live camera.
 * @param {boolean} [options.coarseCulling] CPU tile rejection before exact GPU culling.
 * @param {boolean} [options.subgroupCulling] Opt-in subgroup compaction, with the
 *   original per-crown atomic path when the initialized device lacks subgroups.
 * @param {{minimum:number, maximum:number}} [options.groundBounds] Optional tighter
 *   bounds on DECODED ground heights; defaults to the entire packing range.
 * @param {Array<{minX:number,minZ:number,maxX:number,maxZ:number}>} [options.coverageBounds]
 *   Optional union of AABBs containing every root allowed by the static keepAt mask.
 *   If mask uniforms or these bounds change, call invalidateCulling(). Changes
 *   to baked placement inputs (height/surface) still require recreating the lawn.
 */
export function createGPUDrivenGrass({
  renderer,
  heightMap,
  surface,
  shadows = true,
  keepAt = null,
  coarseCulling = false,
  subgroupCulling = false,
  cullHysteresis = false,
  groundBounds = null,
  coverageBounds = null,
  minBladePixels = LAWN.minBladePixels,
  tillers = LAWN.tillers,
  backlight = GRASS_BACKLIGHT.blade,
  diffuseOnly = false,
  bend = { min: LAWN.minBend, max: LAWN.maxBend },
  posture = { clumpPull: LAWN.clumpPull, tillerFan: LAWN.tillerFan },
  canopy = { near: LAWN.canopyNormalNear, far: LAWN.canopyNormalFar },
  projectedCanopy = false,
  poseCache = false,
  greens = LAWN_COLORS,
  heightCorrelation = 1,
  size = {
    minHeight: LAWN.minHeight,
    maxHeight: LAWN.maxHeight,
    minWidth: LAWN.minWidth,
    maxWidth: LAWN.maxWidth,
  },
}) {
  if (!surface) throw new TypeError('GPU grass needs the shared lawn surface.');
  if (!Number.isInteger(tillers) || tillers < 1) {
    throw new RangeError('A crown grows a whole number of blades, at least 1.');
  }
  if (!(bend.min >= 0) || !(bend.max >= bend.min)) {
    throw new RangeError('Blade bend needs an ordered, non-negative range.');
  }
  // A crown's heading is its own unit vector plus the clump's times the pull,
  // so a pull of exactly 1 can cancel two opposed headings to a zero vector
  // and hand `normalize()` no direction at all. The same bound is asserted on
  // the preset in `test/grass-blade-bounds.test.js`.
  if (
    !(posture.clumpPull >= 0) ||
    Math.abs(posture.clumpPull - 1) < CLUMP_PULL_MARGIN
  ) {
    throw new RangeError(
      'A clump pull must be non-negative and a tenth clear of 1, where an ' +
        'opposed crown and clump heading cancel to nothing to normalize.',
    );
  }
  if (!(posture.tillerFan >= 0)) {
    throw new RangeError('A negative tiller fan is a mirrored blade.');
  }
  // The pull is a mix weight toward the ground's normal: 0 is the blade's own
  // facing and 1 has no blade left in it, which lights a ring as the plane it
  // stands on. `CANOPY_PULL_MAX` is where that stops being grass.
  const pulledTooFar = (pull) => !(pull >= 0 && pull <= CANOPY_PULL_MAX);
  if (pulledTooFar(canopy.near) || pulledTooFar(canopy.far)) {
    throw new RangeError(
      `A canopy normal pull is a mix weight in [0, ${CANOPY_PULL_MAX}], from ` +
        "the blade's own facing toward the ground's.",
    );
  }
  if (!(Number.isFinite(minBladePixels) && minBladePixels > 0)) {
    throw new RangeError('Minimum blade width must be a positive pixel count.');
  }
  const useSubgroupCulling = Boolean(subgroupCulling && renderer.hasFeature?.('subgroups'));
  const backlightMode = normalizeBacklight(backlight);
  const decodedGroundBounds = groundBounds ?? {
    minimum: heightMap.packingMinimum,
    maximum: heightMap.packingMinimum + heightMap.packingRange,
  };
  if (!Number.isFinite(decodedGroundBounds.minimum) ||
      !Number.isFinite(decodedGroundBounds.maximum) ||
      decodedGroundBounds.minimum > decodedGroundBounds.maximum) {
    throw new RangeError('Ground bounds must be finite and ordered.');
  }
  if (coverageBounds !== null && (!Array.isArray(coverageBounds) || coverageBounds.some(bounds =>
    ![bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ].every(Number.isFinite) ||
    bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ))) {
    throw new RangeError('Coverage bounds must be a union of finite ordered XZ rectangles.');
  }
  const maxSphereRadius = size.maxHeight * bladeCullRadiusFactor(bend.max) +
    size.maxWidth * .5 * LAWN.maxThicken + LAWN.tillerSpread * .5;
  const maxCentreOffset = size.maxHeight * BLADE_CULL_CENTRE;
  const cameraWorld = uniform(new THREE.Vector3());
  const cullCameraWorld = uniform(new THREE.Vector3());
  const cullRefresh = new CullRefreshTracker(cullHysteresis);
  // Metres one physical pixel covers per metre of distance, so a blade can be
  // measured in pixels without the shader knowing the projection.
  const pixelScale = uniform(0);
  const drawingBuffer = new THREE.Vector2();
  const viewProjection = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const frustumPlanes = Array.from({ length: 6 }, () =>
    uniform(new THREE.Vector4()),
  );
  const drawData = new Uint32Array(GRASS_RINGS.length * DRAW_UINTS);
  for (const ring of GRASS_RINGS) {
    drawData[ring.index * DRAW_UINTS] =
      bladeVertexCount(ring.segments, ring) * tillers;
  }

  const drawAttribute = new THREE.IndirectStorageBufferAttribute(
    drawData,
    DRAW_UINTS,
  );
  drawAttribute.name = 'Grass indirect draw commands';
  const drawStorage = storage(drawAttribute, DrawIndirect, drawAttribute.count);
  const resetCompute = Fn(() => {
    atomicStore(
      drawStorage.element(instanceIndex).get('instanceCount'),
      uint(0),
    );
  })()
    .compute(GRASS_RINGS.length, [64])
    .setName('Reset grass indirect draws');

  const rings = GRASS_RINGS.map((ring) =>
    createRingResources({
      ring,
      heightMap,
      drawAttribute,
      drawStorage,
      cameraWorld,
      cullCameraWorld,
      pixelScale,
      frustumPlanes,
      shadows,
      surface,
      keepAt,
      coarseCulling,
      subgroupCulling: useSubgroupCulling,
      minBladePixels,
      tillers,
      backlight: backlightMode,
      diffuseOnly,
      bend,
      posture,
      canopy,
      projectedCanopy,
      poseCache,
      heightCorrelation,
      greens,
      size,
    }),
  );
  const group = new THREE.Group();
  group.name = 'Persistent GPU lawn grids';
  for (const ring of rings) group.add(ring.mesh);

  const readback = new THREE.ReadbackBuffer(drawData.byteLength);
  readback.name = 'Grass visible-count readback';
  const visible = new Uint32Array(GRASS_RINGS.length);
  // Stable group identity lets Three reuse its backend bookkeeping. Dispatch
  // order is placement -> counter reset -> culling, all in one compute pass.
  const computeNodes = [];
  let placements = 0;
  let readPending = false;
  let disposed = false;
  const grassStats = {
    candidates: TOTAL_GRASS_CANDIDATES,
    tillers,
    storage: grassStorageFootprint(TOTAL_GRASS_CANDIDATES),
    visible,
    // Reported here rather than re-derived by the HUD, because the HUD's own
    // arithmetic drifted from the draw command it was meant to describe.
    triangles: 0,
    placements: 0,
    placementCandidates: 0,
    cullCandidates: 0,
    subgroupCulling: useSubgroupCulling,
    poseCandidates: 0,
    poseCacheBytes: rings.reduce((sum, ring) => sum + (ring.poseAttribute?.array.byteLength ?? 0), 0),
    cullTiles: 0,
    cullTileBytes: rings.reduce((sum, ring) => sum + (ring.cullTileAttribute?.array.byteLength ?? 0), 0),
    drawCalls: GRASS_RINGS.length,
    // Match renderer.info.compute.calls: one API submission can dispatch many nodes.
    computeCalls: 0,
    computeDispatches: 0,
  };

  function update(camera) {
    if (disposed) return;
    cameraWorld.value.setFromMatrixPosition(camera.matrixWorld);
    // Element 5 is 1/tan(fovY/2) for any perspective projection, so this stays
    // right through a pixelratio change or a resize without reading either.
    renderer.getDrawingBufferSize(drawingBuffer);
    pixelScale.value =
      2 / (camera.projectionMatrix.elements[5] * Math.max(drawingBuffer.y, 1));
    viewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    // Camera-dependent blade width and lighting follow every frame. Only the
    // guarded visibility list and its radial LOD centre may stay unchanged.
    if (!cullRefresh.needsRefresh(camera)) {
      grassStats.placementCandidates = 0;
      grassStats.cullCandidates = 0;
      grassStats.poseCandidates = 0;
      grassStats.cullTiles = 0;
      grassStats.computeCalls = 0;
      grassStats.computeDispatches = 0;
      return;
    }
    cullCameraWorld.value.copy(cameraWorld.value);
    const guarded = cullRefresh.supportsMotion(camera);
    frustum.setFromProjectionMatrix(viewProjection, camera.coordinateSystem);
    for (let index = 0; index < frustum.planes.length; index += 1) {
      const plane = frustum.planes[index];
      frustumPlanes[index].value.set(
        plane.normal.x,
        plane.normal.y,
        plane.normal.z,
        plane.constant,
      );
    }

    computeNodes.length = 0;
    let placementCandidates = 0;
    for (const resources of rings) {
      if (
        snapRingState(resources.state, cullCameraWorld.value.x, cullCameraWorld.value.z)
      ) {
        const [a, b] = resources.state.updateRects;
        resources.placementRectA.value.set(a.x, a.z, a.width, a.height);
        resources.placementRectB.value.set(
          b?.x ?? 0, b?.z ?? 0, b?.width ?? 0, b?.height ?? 0,
        );
        resources.placementFirstCount.value = a.width * a.height;
        // Three r185 uses count both for dispatch size and its uniform bounds
        // guard, so partial workgroups cannot overwrite retained records.
        resources.placementCompute.count = resources.state.updateCount;
        computeNodes.push(resources.placementCompute);
        placementCandidates += resources.state.updateCount;
        placements += 1;
      }
    }

    computeNodes.push(resetCompute);
    let cullCandidates = 0;
    let cullTileCount = 0;
    for (const resources of rings) {
      const guard = guarded ? cullMotionMargin(resources.ring.outer,
        cullCameraWorld.value.y, decodedGroundBounds, maxCentreOffset) : 0;
      resources.cullGuard.value = guard;
      if (coarseCulling) {
        const attribute = resources.cullTileAttribute;
        const tiles = selectCullTiles(resources.state, {
          camera: cullCameraWorld.value, planes: frustum.planes,
          groundBounds: decodedGroundBounds,
          marginXZ: maxSphereRadius + maxCentreOffset + guard,
          marginBelow: maxSphereRadius + guard,
          marginAbove: maxSphereRadius + maxCentreOffset + guard,
          coverageBounds,
        }, attribute.array);
        if (tiles.count > 0 && (tiles.changed || tiles.count !== resources.cullTileCount)) {
          attribute.clearUpdateRanges();
          attribute.addUpdateRange(0, tiles.count * 4);
          attribute.needsUpdate = true;
        }
        resources.cullTileCount = tiles.count;
        resources.cullCandidateCount.value = tiles.dispatchCandidates;
        if (useSubgroupCulling) {
          resources.cullCompute.dispatchSize[0] = Math.ceil(tiles.dispatchCandidates / CULL_WORKGROUP_SIZE);
        } else {
          resources.cullCompute.count = tiles.dispatchCandidates;
        }
        cullTileCount += tiles.count;
        if (tiles.count === 0) continue;
      }
      computeNodes.push(resources.cullCompute);
      cullCandidates += resources.cullCandidateCount.value;
    }
    // Expansion reads the final compacted list/count after ALL ring culls.
    // Counts stay on the GPU: fixed bounded work skips lanes past visibility.
    let poseCandidates = 0;
    for (const resources of rings) {
      if (resources.poseCompute && (!coarseCulling || resources.cullTileCount > 0)) {
        computeNodes.push(resources.poseCompute);
        poseCandidates += resources.poseCompute.count;
      }
    }
    // Every CPU uniform/storage update is ready before this call. WebGPU
    // synchronizes storage between dispatches, so culling sees both freshly
    // placed records and reset counters without separate queue submissions.
    renderer.compute(computeNodes);
    cullRefresh.commit(camera);
    grassStats.placements = placements;
    grassStats.placementCandidates = placementCandidates;
    grassStats.cullCandidates = cullCandidates;
    grassStats.poseCandidates = poseCandidates;
    grassStats.cullTiles = cullTileCount;
    grassStats.computeCalls = 1;
    grassStats.computeDispatches = computeNodes.length;
  }

  async function sampleVisibleCounts() {
    if (disposed || readPending) return false;
    readPending = true;
    try {
      const result = await renderer.getArrayBufferAsync(
        drawAttribute,
        readback,
        0,
        drawData.byteLength,
      );
      if (disposed) {
        result.release();
        return false;
      }
      const commands = new Uint32Array(result.buffer);
      for (const ring of GRASS_RINGS) {
        visible[ring.index] = commands[ring.index * DRAW_UINTS + 1] ?? 0;
      }
      grassStats.triangles = grassTriangleCount(visible, tillers);
      result.release();
      return true;
    } catch (error) {
      // r185 marks a reusable ReadbackBuffer mapped before awaiting mapAsync.
      // Release that state after a device/readback failure so one failed HUD
      // sample does not make every later sample fail synchronously.
      if (readback._mapped) readback.release();
      if (disposed) return false;
      throw error;
    } finally {
      readPending = false;
    }
  }

  return {
    group,
    get groundMaterial() { return surface.material; },
    get disposed() { return disposed; },
    update,
    invalidateCulling() { if (!disposed) cullRefresh.invalidate(); },
    sampleVisibleCounts,
    stats() {
      return grassStats;
    },
    // A frozen copy for keeping: stats() is the live object the HUD reads
    // every frame, and its visible counts are the readback's own array.
    snapshotStats() {
      return Object.freeze({
        ...grassStats,
        storage: Object.freeze({ ...grassStats.storage }),
        visible: Object.freeze(Array.from(grassStats.visible)),
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      readback.dispose();
      resetCompute.dispose();
      releaseStorageBuffer(renderer, drawAttribute);
      for (const resources of rings) {
        resources.placementCompute.dispose();
        resources.cullCompute.dispose();
        resources.poseCompute?.dispose();
        releaseStorageBuffer(renderer, resources.recordAttribute);
        releaseStorageBuffer(renderer, resources.visibleAttribute);
        if (resources.cullTileAttribute) releaseStorageBuffer(renderer, resources.cullTileAttribute);
        if (resources.poseAttribute) releaseStorageBuffer(renderer, resources.poseAttribute);
        resources.geometry.dispose();
        resources.material.dispose();
      }
    },
  };
}
