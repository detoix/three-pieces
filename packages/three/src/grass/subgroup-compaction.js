import * as THREE from 'three/webgpu';

const { If, atomicAdd, nodeObject, subgroupAdd, subgroupElect,
  subgroupExclusiveAdd, uint } = THREE.TSL;

export const CULL_WORKGROUP_SIZE = 64;

/** One reservation per nonempty subgroup. Call from converged control flow. */
export function emitSubgroupCompacted(candidateIndex, emit, counter, visibleWrite) {
  const offset = subgroupExclusiveAdd(emit).toVar('grassSubgroupOffset');
  const total = subgroupAdd(emit).toVar('grassSubgroupTotal');
  const leader = subgroupElect().toVar('grassSubgroupLeader');
  const base = uint(0).toVar('grassSubgroupBase');
  If(leader.and(total.greaterThan(uint(0))), () => {
    base.assign(atomicAdd(counter, total));
  });
  // r185's TSL proxy incorrectly pads this one-input WGSL intrinsic to two
  // arguments. Use its underlying public node without mutating Three's proxy.
  const sharedBase = nodeObject(new THREE.SubgroupFunctionNode(
    'subgroupBroadcastFirst', base,
  )).toVar('grassSubgroupSharedBase');
  If(emit.greaterThan(uint(0)), () => {
    visibleWrite.element(sharedBase.add(offset)).assign(candidateIndex);
  });
}

/** Explicit workgroups avoid Three's lane-divergent implicit count return. */
export function cullDispatchSize(candidateCount) {
  return [Math.ceil(candidateCount / CULL_WORKGROUP_SIZE), 1, 1];
}
