import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  bakeLawnCoverage,
  createFlatHeightMap,
  landscapeLawnTag,
  readLawnAreas,
  triangleContains,
} from '../src/grass/index.js';
function patch(id='lawn') {
 const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 2).rotateX(-Math.PI/2));
 mesh.userData.landscape={version:1,id,role:'turf'};
 return mesh;
}
test('turf follows nested world transforms and ignores display names',()=>{
 const root=new THREE.Group(), parent=new THREE.Group(), mesh=patch();
 root.add(parent);parent.add(mesh);parent.position.set(10,-.32,20);parent.rotation.y=Math.PI/2;mesh.scale.set(2,1,1);mesh.name='Arbitrary human label';
 const turf=readLawnAreas(root);
 assert(Math.abs(turf.elevation + .32) < 1e-9);assert(turf.contains(10,23));assert(!turf.contains(12,20));
 assert.deepEqual(turf.ids,['lawn']);
});
test('missing metadata yields no lawn; invalid versions, duplicate IDs and slopes fail',()=>{
 assert.equal(readLawnAreas(new THREE.Group()).triangles.length,0);
 const root=new THREE.Group();root.add(patch(),patch());assert.throws(()=>readLawnAreas(root),/Duplicate/);
 root.remove(root.children[1]);root.children[0].userData.landscape.version=2;assert.throws(()=>readLawnAreas(root),/metadata/);
 root.children[0].userData.landscape.version=1;root.children[0].rotation.x=.3;assert.throws(()=>readLawnAreas(root),/horizontal/);
});
test('conservative raster plus exact boundary path preserves gaps and shared diagonals',()=>{
 const triangles=[[[0,0],[2,0],[2,2]],[[0,0],[2,2],[0,2]],[[3,0],[4,0],[4,2]],[[3,0],[4,2],[3,2]]];
 const baked=bakeLawnCoverage(triangles,32);
 const exact=(x,z)=>triangles.some(t=>triangleContains(t,x,z));
 for(let row=0;row<100;row++)for(let col=0;col<200;col++){
  const x=-.02+col*4.04/199,z=-.02+row*2.04/99;
  const u=(x-baked.min[0])/baked.size[0],v=(z-baked.min[1])/baked.size[1];
  const value=u>=0&&u<1&&v>=0&&v<1?baked.data[Math.floor(v*32)*32+Math.floor(u*32)]:0;
  assert.equal(value===255 || (value===128&&exact(x,z)),exact(x,z));
 }
 assert(exact(1,1));assert(!exact(2.5,1));
});

test('any convention selects turf, and an id is required for each surface', () => {
  const root = new THREE.Group();
  const lawn = new THREE.Mesh(new THREE.PlaneGeometry(4, 2).rotateX(-Math.PI / 2));
  lawn.name = 'Lawn — east';
  const path = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  path.name = 'Gravel path';
  root.add(lawn, path);

  // No authored tag, so the default selector finds nothing at all.
  assert.equal(readLawnAreas(root).triangles.length, 0);

  const byName = readLawnAreas(root, { select: (object) => object.name.startsWith('Lawn') });
  assert.deepEqual(byName.ids, ['Lawn — east']);
  assert.ok(byName.contains(0, 0) && !byName.contains(9, 9));

  // `true` names the surface after the object; a returned string overrides it.
  assert.deepEqual(readLawnAreas(root, { select: (o) => o.name === 'Lawn — east' }).ids, ['Lawn — east']);
  assert.deepEqual(readLawnAreas(root, { select: (o) => (o === lawn ? 'east' : false) }).ids, ['east']);

  const unnamed = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  root.add(unnamed);
  assert.match(readLawnAreas(root, { select: (o) => o === unnamed }).ids[0], /[0-9a-f-]{36}/i);

  assert.throws(() => readLawnAreas(root, { select: 'lawn' }), TypeError);
  assert.throws(() => readLawnAreas(root, { select: () => 12 }), TypeError);
  // A selector that throws rejects a model rather than quietly growing nothing.
  assert.throws(() => readLawnAreas(root, { select: () => { throw new Error('bad tag'); } }), /bad tag/);
});

test('the authored tag is one selector among others, and reads both spellings', () => {
  const mesh = patch('turf.east');
  // Models already say `turf`; `lawn` is the word the API uses now.
  mesh.userData.landscape.role = 'lawn';
  assert.equal(landscapeLawnTag(mesh), 'turf.east');
  mesh.userData.landscape.role = 'turf';
  assert.equal(landscapeLawnTag(mesh), 'turf.east');
  assert.equal(landscapeLawnTag(new THREE.Group()), false);
  mesh.userData.landscape.role = 'path';
  assert.equal(landscapeLawnTag(mesh), false);
  mesh.userData.landscape = { version: 2, id: 'x', role: 'turf' };
  assert.throws(() => landscapeLawnTag(mesh), /metadata/);
});

test('turf hands grass a flat height map at the surface it found', () => {
  const heightMap = createFlatHeightMap(-0.32);
  assert.equal(heightMap.minimum, -0.32);
  assert.equal(heightMap.packingMinimum, -0.32);
  assert.ok(heightMap.packingRange > 0 && heightMap.extent === 130);
  assert.equal(heightMap.texture.image.width, 2);
  assert.equal(createFlatHeightMap(0, { extent: 40 }).extent, 40);
  heightMap.texture.dispose();
});
