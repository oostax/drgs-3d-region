import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { createVegetationMaskSteps, sampleVegetationSteps, createVegetationMeshesSteps, type VegetationPolygon, type VegetationZone } from '../src/lib/map-vegetation';
import type { WorldPoint } from '../src/lib/map-life-stability';

const rectangle = (x: number, y: number, width: number, height: number): VegetationPolygon => [[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]];
const trees = () => Array.from({ length: 1400 }, (_, i) => ({ id: `mapped-garden:${i}`, point: [i % 40 * 12, Math.floor(i / 40) * 12] as WorldPoint, elevation: i % 7 }));
function drain<T>(steps: Generator<void, T, unknown>) {
  let result = steps.next(), slices = 0;
  while (!result.done) { slices++; result = steps.next(); }
  return { value: result.value, slices };
}
function dispose(group: THREE.Group) {
  for (const child of group.children as THREE.InstancedMesh[]) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); }
  group.clear();
}

test('vegetation masks yield while indexing and preserve every exclusion', () => {
  const blocked = Array.from({ length: 260 }, (_, i) => rectangle(i * 110, 0, 15, 15));
  const { value: mask, slices } = drain(createVegetationMaskSteps([], blocked, [{ points: [[-20, 60], [30000, 60]], clearance: 5 }]));
  assert.ok(slices >= 2, 'index construction yields inside its spatial-bin workload');
  for (let i = 0; i < blocked.length; i++) {
    assert.equal(mask.clear([i * 110 + 5, 5]), false);
    assert.equal(mask.clear([i * 110 + 17, 5]), false, 'the roof buffer is unchanged');
    assert.equal(mask.clear([i * 110 + 40, 35]), true);
    assert.equal(mask.clear([i * 110 + 40, 60]), false);
  }
});

test('yielding vegetation sampling preserves the pre-refactor candidate identities and ordering', () => {
  const zones: VegetationZone[] = [
    { polygon: rectangle(-800, -800, 1600, 1600), kind: 'wood', bounds: [-800, -800, 800, 800] },
    { polygon: rectangle(850, -90, 180, 180), kind: 'garden', bounds: [850, -90, 1030, 90] },
  ];
  const mask = drain(createVegetationMaskSteps(zones, [rectangle(-150, -100, 130, 220)], [{ points: [[-1000, 300], [1000, 300]], clearance: 5 }])).value;
  const { value: candidates, slices } = drain(sampleVegetationSteps(zones, [0, 0], 1200, 1400, mask));
  assert.ok(slices > 30, 'sampling and sector interleaving yield during the full-quality workload');
  assert.equal(candidates.length, 2992);
  // Captured from the original synchronous implementation before extracting steps.
  assert.equal(createHash('sha256').update(JSON.stringify(candidates)).digest('hex'), '19a539ca6ef33dab9a1ecb62501bca72d7887e2da65497dfb77188e38970a1a2');
  assert.ok(candidates.every(candidate => mask.clear(candidate.point)));
});

test('yielding mesh preparation preserves all 1400 trees, their buffers and six draws', () => {
  const { value: group, slices } = drain(createVegetationMeshesSteps(trees(), point => [point[0] - 240, point[1] - 200]));
  try {
    assert.ok(slices >= 40, 'profiles and instance matrices are prepared in bounded batches');
    assert.equal(group.userData.treeCount, 1400); assert.equal(group.children.length, 6);
    const hash = createHash('sha256');
    for (const child of group.children as THREE.InstancedMesh[]) {
      hash.update(child.name); hash.update(new Uint8Array(child.instanceMatrix.array.buffer));
      if (child.instanceColor) hash.update(new Uint8Array(child.instanceColor.array.buffer));
      for (const [key, attribute] of Object.entries(child.geometry.attributes)) { hash.update(key); hash.update(new Uint8Array(attribute.array.buffer)); }
      if (child.geometry.index) hash.update(new Uint8Array(child.geometry.index.array.buffer));
    }
    assert.equal(hash.digest('hex'), '7cd405b42193cacd5abc831eb065b68b30e30b5fba47f2e48546d6dd3573eda3');
  } finally { dispose(group); }
});

test('canceling mesh preparation releases every unpublished resource once at early and late checkpoints', context => {
  const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  const disposeGeometry = THREE.BufferGeometry.prototype.dispose, disposeMaterial = THREE.Material.prototype.dispose;
  context.mock.method(THREE.BufferGeometry.prototype, 'dispose', function (this: THREE.BufferGeometry) { geometries.push(this); disposeGeometry.call(this); });
  context.mock.method(THREE.Material.prototype, 'dispose', function (this: THREE.Material) { materials.push(this); disposeMaterial.call(this); });
  for (const checkpoint of [1, 35, 42]) {
    const steps = createVegetationMeshesSteps(trees(), point => point);
    for (let i = 0; i < checkpoint; i++) assert.equal(steps.next().done, false);
    const previousGeometries = geometries.length, previousMaterials = materials.length;
    steps.return(undefined as unknown as THREE.Group);
    const canceledGeometries = geometries.slice(previousGeometries), canceledMaterials = materials.slice(previousMaterials);
    assert.equal(canceledGeometries.length, 6, 'unused canopy geometries are owned even before meshes are populated');
    assert.equal(new Set(canceledGeometries).size, 6);
    assert.ok(canceledMaterials.length >= 2 && canceledMaterials.length <= 6);
    assert.equal(new Set(canceledMaterials).size, canceledMaterials.length);
    const counts = [geometries.length, materials.length];
    assert.equal(steps.next().done, true); steps.return(undefined as unknown as THREE.Group);
    assert.deepEqual([geometries.length, materials.length], counts, 'canceled work cannot allocate or dispose resources again');
  }
});
