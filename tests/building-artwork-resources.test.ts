import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { acquireFacadeArtwork, loadFacadeArtwork, releaseFacadeArtwork } from '../src/lib/building-facade-artwork';
import { classifyBuilding } from '../src/lib/building-materials';
import { makeBuildingDetailGeometry } from '../src/lib/map-building-details';

test('facade artwork retries failed loads, coalesces decoding and releases shared maps after the last layer', async () => {
  const originals = new Map(['document', 'Image'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const images: MockImage[] = [];
  class MockImage {
    width = 1536; height = 768; src = '';
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor() { images.push(this); }
  }
  let decodedTiles = 0;
  const source = new Uint8ClampedArray(384 * 384 * 4);
  for (let i = 0; i < source.length; i += 4) source.set([84, 112, 145, 255], i);
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => { decodedTiles++; }, getImageData: () => ({ data: source }) }) };
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: MockImage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
  try {
    const failed = loadFacadeArtwork();
    assert.equal(loadFacadeArtwork(), failed, 'concurrent layers share one request');
    images[0].onerror!(); assert.equal(await failed, false);
    const ready = loadFacadeArtwork();
    assert.notEqual(ready, failed, 'a failed first download does not disable all future restored layers');
    assert.equal(images.length, 2);
    images[1].onload!(); assert.equal(await ready, true);
    assert.equal(decodedTiles, 8);

    const profile = classifyBuilding({ id: 'shared-house', class: 'apartments', height: 18, min_height: 3, num_floors: 5 }, 400);
    const first = acquireFacadeArtwork(profile)!, second = acquireFacadeArtwork(profile)!;
    assert.ok(first); assert.equal(second, first);
    let disposed = 0;
    Object.values(first).forEach(map => map.addEventListener('dispose', () => { disposed++; }));
    assert.equal(first.normal.colorSpace, THREE.NoColorSpace);
    assert.equal(first.diffuse.colorSpace, THREE.SRGBColorSpace);
    assert.equal(releaseFacadeArtwork(first), true); assert.equal(disposed, 0, 'one departing layer retains the other layer’s maps');
    assert.equal(releaseFacadeArtwork(second), true); assert.equal(disposed, 3, 'the final lease releases diffuse, emission and normal maps');
    const restored = acquireFacadeArtwork(profile)!;
    assert.notEqual(restored.diffuse.uuid, first.diffuse.uuid, 'a restored GPU layer receives live textures');
    assert.equal(await loadFacadeArtwork(), true); assert.equal(images.length, 2, 'decoded pixels survive GPU resource disposal');

    const geometry = makeBuildingDetailGeometry([[[49.12, 55.79], [49.1203, 55.79], [49.1203, 55.7902], [49.12, 55.7902], [49.12, 55.79]]], profile);
    try {
      const uv = geometry.walls.getAttribute('uv');
      const lower = Math.min(...Array.from({ length: uv.count }, (_, i) => uv.getY(i)));
      const upper = Math.max(...Array.from({ length: uv.count }, (_, i) => uv.getY(i)));
      for (const map of Object.values(restored)) {
        assert.ok(Math.abs((upper - lower) * map.repeat.y * 3 - profile.floors) < 1e-6, 'all three maps show one authored window row per real floor');
      }
    } finally {
      geometry.walls.dispose(); geometry.roof.dispose(); geometry.edge.dispose(); geometry.relief.dispose(); geometry.signage.dispose();
      releaseFacadeArtwork(restored);
    }
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
