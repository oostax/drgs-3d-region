import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { CustomRenderMethodInput } from 'maplibre-gl';
import { MapLifeLayer } from '../src/lib/map-life';
import { makeRoad, StableRoadCache } from '../src/lib/map-life-stability';
import type { createStreetDetails } from '../src/lib/map-street-details';
import { getSceneTime } from '../src/lib/solar';

test('bridge metadata survives canonical duplicates and clipped cache tails', () => {
  const cache = new StableRoadCache(), original = makeRoad('first', 'way/1', [[0, 0], [100, 0]]);
  cache.add(original);
  cache.add(makeRoad('same-geometry', 'way/1', [[0, 0], [100, 0]], 5, false, true));
  assert.equal(cache.roads.get('first'), original); assert.equal(original.bridge, true); assert.equal(original.elevation, 5);
  cache.add(makeRoad('next-tile', 'way/1', [[0, 0], [200, 0]], 5, false, true));
  assert.equal(cache.roads.size, 2);
  const tail = [...cache.roads.values()].find((road) => road !== original)!;
  assert.equal(tail.bridge, true); assert.equal(tail.elevation, 5); assert.deepEqual(tail.points, [[100, 0], [200, 0]]);
});

test('life layer gates street details by zoom and bank focus, updates lighting and disposes once', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, removeEventListener() {} } });
  try {
    let zoom = 15.2, bankFocus = false, lighting = { ...getSceneTime({ timeMode: 'manual', hour: 12, life: false }), nightAmount: 0 };
    const layer = new MapLifeLayer({ enabled: () => true, animate: () => false, offices: () => [], banksVisible: () => false, bankFocus: () => bankFocus, lighting: () => lighting, mobile: true, reducedMotion: false });
    const state = layer as unknown as { map: unknown; renderer: unknown; streetDetails: ReturnType<typeof createStreetDetails> | null; content: THREE.Group };
    const road = { type: 'Feature', id: 'mapped-bridge', properties: { class: 'primary', brunnel: 'bridge' }, geometry: { type: 'LineString', coordinates: [[49.117, 55.79], [49.124, 55.79]] } };
    state.map = { getZoom: () => zoom, getCenter: () => ({ lng: 49.12, lat: 55.79 }), getTerrain: () => null, getSource: () => ({}), querySourceFeatures: (_source: string, options: { sourceLayer: string }) => options.sourceLayer === 'transportation' ? [road] : [], triggerRepaint() {}, off() {}, getCanvas: () => ({ width: 1000, height: 800, clientWidth: 1000, clientHeight: 800 }) };
    state.renderer = { resetState() {}, setViewport() {}, render() {}, dispose() {} };
    layer.rebuild(); assert.equal(state.streetDetails, null);
    zoom = 16; layer.rebuild();
    const first = state.streetDetails!; assert.ok(first.group.userData.lampCount > 0); assert.equal(first.group.userData.bridgeSegmentCount, 1); assert.equal(first.group.parent, state.content);
    const uniqueGeometry = new Set((first.group.children as THREE.InstancedMesh[]).map((mesh) => mesh.geometry)); let disposed = 0;
    for (const geometry of uniqueGeometry) geometry.addEventListener('dispose', () => disposed++);
    const poles = first.group.getObjectByName('street-lamp-poles') as THREE.InstancedMesh, matrix = new THREE.Matrix4(); poles.getMatrixAt(0, matrix);
    const firstPoleLength = new THREE.Vector3().setFromMatrixScale(matrix).z; assert.ok(Math.abs(firstPoleLength - 7.8) < 1e-5);
    lighting = { ...lighting, nightAmount: 1 };
    layer.render({} as WebGL2RenderingContext, { defaultProjectionData: { mainMatrix: new THREE.Matrix4().elements } } as unknown as CustomRenderMethodInput);
    const glow = first.group.getObjectByName('street-lamp-luminaires') as THREE.InstancedMesh;
    assert.equal((glow.material as THREE.MeshStandardMaterial).emissiveIntensity, 2.3);
    zoom = 18; layer.rebuild(); assert.equal(disposed, uniqueGeometry.size); assert.equal(first.group.parent, null);
    const currentPoles = state.streetDetails!.group.getObjectByName('street-lamp-poles') as THREE.InstancedMesh; currentPoles.getMatrixAt(0, matrix);
    assert.ok(Math.abs(new THREE.Vector3().setFromMatrixScale(matrix).z - firstPoleLength) < 1e-5);
    bankFocus = true; layer.rebuild(); assert.equal(state.streetDetails, null); assert.equal(state.content.getObjectByName('atlas-street-details'), undefined);
    layer.onRemove(); assert.equal(disposed, uniqueGeometry.size, 'parent cleanup must not dispose detached detail geometry twice');
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
