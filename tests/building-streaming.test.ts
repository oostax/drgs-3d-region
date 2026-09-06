import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import { classifyBuilding } from '../src/lib/building-materials';
import { buildBuildingGeometry, packBuildingGeometry, unpackBuildingGeometry, geometryTransferList, GEOMETRY_PARTS, type BuildingGeometryInput } from '../src/lib/building-detail-geometry';
import { BuildingSpatialCache, buildingSpatialCell } from '../src/lib/building-spatial-cache';
import { BuildingGeometryWorkerClient } from '../src/lib/building-geometry-worker-client';

function input(level: 0 | 1 | 2): BuildingGeometryInput {
  const origin = MercatorCoordinate.fromLngLat([49.1,55.7]);
  return { key: `school-${level}`, profile: classifyBuilding({ class:'school', height:16 }, 400), detailLevel:level, origin:[origin.x,origin.y,origin.z], altitudes:[83], polygons:[[[[49.12,55.79],[49.1204,55.79],[49.1204,55.7903],[49.12,55.7903],[49.12,55.79]],[[49.1201,55.7901],[49.1201,55.7902],[49.1202,55.7902],[49.1202,55.7901],[49.1201,55.7901]]]] };
}
for (const level of [0,1,2] as const) test(`worker transfer preserves every attribute and roof at detail ${level}`, () => {
  const baseline = buildBuildingGeometry(input(level));
  const packed = packBuildingGeometry('test', buildBuildingGeometry(input(level)));
  const buffers = geometryTransferList([packed]);
  const received = structuredClone(packed, { transfer:buffers });
  assert.ok(buffers.every(buffer => buffer.byteLength === 0), 'ownership transfers without retaining duplicate buffers');
  const actual = unpackBuildingGeometry(received);
  assert.equal(actual.cost, baseline.cost); assert.equal(actual.roofKind, baseline.roofKind);
  for (const part of GEOMETRY_PARTS) {
    assert.equal(actual[part].length, baseline[part].length);
    actual[part].forEach((geometry, i) => {
      assert.deepEqual(Object.keys(geometry.attributes), Object.keys(baseline[part][i].attributes));
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        const expected = baseline[part][i].getAttribute(name);
        assert.equal(attribute.itemSize, expected.itemSize); assert.equal(attribute.normalized, expected.normalized);
        assert.deepEqual(attribute.array, expected.array);
      }
    });
  }
});

test('unchanged spatial buffers survive staging, reorder, eviction and return navigation', () => {
  const cache = new BuildingSpatialCache(1024*1024,2), material = new THREE.MeshBasicMaterial();
  const a = new THREE.BoxGeometry().toNonIndexed(), b = new THREE.BoxGeometry().toNonIndexed();
  const first = cache.acquire('cell-a:wall', [a,b], material)!;
  const scene = new THREE.Group(); scene.add(first);
  const version = (first.geometry.getAttribute('position') as THREE.BufferAttribute).version;
  assert.equal(cache.acquire('cell-a:wall',[b,a],material), first);
  assert.equal(first.parent, scene, 'acquisition must not steal a mesh from the visible scene');
  assert.equal((first.geometry.getAttribute('position') as THREE.BufferAttribute).version,version);
  const second=cache.acquire('cell-b:wall',[a],material)!; let disposed=0;
  second.geometry.addEventListener('dispose',()=>disposed++);
  cache.acquire('cell-c:wall',[b],material);
  cache.prune(new Set([first]));
  assert.equal(disposed,1); assert.equal(cache.size,2);
  assert.equal(cache.acquire('cell-a:wall',[a,b],material),first);
  cache.clear(); a.dispose(); b.dispose(); material.dispose();
});

test('cell addresses stay fixed across local navigation and differ across cities', () => {
  assert.equal(buildingSpatialCell(49.12,55.79),buildingSpatialCell(49.120001,55.790001));
  assert.notEqual(buildingSpatialCell(49.12,55.79),buildingSpatialCell(37.62,55.75));
});

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: {id:number;inputs:BuildingGeometryInput[]}[]=[]; terminated=false;
  postMessage(value: {id:number;inputs:BuildingGeometryInput[]}) { this.posted.push(value); }
  terminate() { this.terminated=true; }
}
test('worker cancellation rejects outstanding jobs and ignores late messages', async () => {
  const worker = new FakeWorker(), client = new BuildingGeometryWorkerClient(()=>worker as unknown as Worker);
  const result = client.build([input(0)]), rejected = assert.rejects(result,/cancelled/);
  client.cancel(); await rejected;
  assert.equal(worker.terminated,true); assert.equal(client.busy,false);
  worker.onmessage?.({data:{id:worker.posted[0].id,items:[]}} as MessageEvent);
  assert.equal(client.completed,0); client.dispose();
});
test('worker errors release pending work and leave an observable fallback', async () => {
  const worker = new FakeWorker(), client = new BuildingGeometryWorkerClient(()=>worker as unknown as Worker);
  const result = client.build([input(0)]), rejected = assert.rejects(result,/startup/);
  worker.onerror?.({ message:'startup failed', preventDefault(){} } as ErrorEvent); await rejected;
  assert.equal(client.busy,false); assert.equal(client.failure,'startup failed'); assert.equal(client.available,false); client.dispose();
});
