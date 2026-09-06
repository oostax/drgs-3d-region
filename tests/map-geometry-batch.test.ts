import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { refillGeometryBatch } from '../src/lib/map-geometry-batch';

const triangle = (x: number) => new THREE.BufferGeometry()
  .setAttribute('position', new THREE.Float32BufferAttribute([x,0,0,x+1,0,0,x,1,0],3))
  .setAttribute('color', new THREE.Float32BufferAttribute([1,0,0,0,1,0,0,0,1],3));

test('camera batches retain GPU buffers while contents change and draw only current vertices', () => {
  const parts = [triangle(0), triangle(10)], batch = refillGeometryBatch(undefined, parts)!;
  const positions = batch.getAttribute('position'), colors = batch.getAttribute('color');
  assert.equal(batch.drawRange.count, 6);
  assert.deepEqual(Array.from(positions.array.slice(0,18)), parts.flatMap(part=>Array.from(part.getAttribute('position').array)));
  const moved = triangle(20), next = refillGeometryBatch(batch, [moved])!;
  assert.equal(next, batch); assert.equal(next.getAttribute('position'), positions); assert.equal(next.getAttribute('color'), colors);
  assert.equal(next.drawRange.count,3,'retired geometry remains outside the draw range');
  assert.deepEqual(Array.from(positions.array.slice(0,9)),Array.from(moved.getAttribute('position').array));
  assert.equal((positions as THREE.BufferAttribute).usage,THREE.DynamicDrawUsage);
  assert.deepEqual((positions as THREE.BufferAttribute).updateRanges,[{start:0,count:9}]);
  batch.dispose(); parts.forEach(part=>part.dispose()); moved.dispose();
});

test('growth replaces insufficient storage once and removal can release it', () => {
  const part=triangle(0), first=refillGeometryBatch(undefined,[part])!;let disposed=0;first.addEventListener('dispose',()=>disposed++);
  const grown=refillGeometryBatch(first,[part,part,part])!;
  assert.notEqual(grown,first);assert.equal(disposed,1);assert.equal(grown.drawRange.count,9);
  assert.ok(grown.getAttribute('position').count<=11,'slack stays bounded');
  grown.dispose();part.dispose();
});
