import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Feature, Polygon } from 'geojson';
import { classifyBuilding } from '../src/lib/building-materials';
import { buildingTextureKey, disposeFacadeTextures, makeFacadeTextures } from '../src/lib/building-facade-textures';
import { BuildingDetailsLayer, buildingDetailBudget } from '../src/lib/map-building-details';
import { getLightingState } from '../src/lib/solar';

test('semantic facade types have visibly distinct patterns, independent of IDs and source colours', () => {
  const classes = ['apartments', 'house', 'office', 'retail', 'school', 'hospital', 'industrial', 'warehouse', 'garage', 'shed', 'church', 'service', 'unknown', 'residential', 'kindergarten', 'university', 'clinic', 'medical', 'stadium', 'sports_centre', 'government', 'library', 'hotel', 'train_station', 'barn', 'greenhouse', 'commercial', 'outbuilding'];
  const hashes = new Set<string>();
  for (const kind of classes) {
    const profile = classifyBuilding({ class: kind, height: 12, num_floors: 3 }, 240), textures = makeFacadeTextures(profile, 0);
    hashes.add(createHash('sha256').update(textures.diffuse.image.data as Uint8Array).digest('hex'));
    const recolored = classifyBuilding({ class: kind, height: 12, num_floors: 3, facade_color: '#804020', id: 'other' }, 240);
    assert.equal(buildingTextureKey(profile), buildingTextureKey(recolored), 'colours/IDs cannot multiply material batches');
    disposeFacadeTextures(textures);
  }
  assert.equal(hashes.size, classes.length, 'all requested semantic classes have their own visible pattern');
});

test('unknown plaster has surface variation but no invented lit residential windows', () => {
  const textures = makeFacadeTextures(classifyBuilding({}, 120), 1), pixels = textures.diffuse.image.data as Uint8Array, emission = textures.emissive.image.data as Uint8Array;
  const tones = new Set<number>();
  for (let i = 0; i < pixels.length; i += 4) { tones.add(pixels[i]); assert.equal(emission[i], 0); }
  assert.ok(tones.size > 8); disposeFacadeTextures(textures);
});

test('day and night share immutable texture assets and relief uses linear normal data', () => {
  const profile = classifyBuilding({ class: 'apartments', facade_material: 'brick', height: 15, num_floors: 5 }, 200);
  const day = makeFacadeTextures(profile, 0), night = makeFacadeTextures(profile, 1);
  for (const key of ['diffuse', 'emissive', 'normal'] as const) {
    assert.deepEqual(day[key].image.data, night[key].image.data, 'time must not regenerate a different atlas');
    assert.equal(day[key].generateMipmaps, true); assert.equal(day[key].minFilter, THREE.LinearMipmapLinearFilter);
  }
  assert.equal(day.normal.colorSpace, THREE.NoColorSpace);
  const normals = day.normal.image.data as Uint8Array;
  assert.ok(new Set(Array.from(normals).filter((_, i) => i % 4 === 0)).size > 8, 'window reveals and seams contain actual normal variation');
  const lit = day.emissive.image.data as Uint8Array;
  assert.ok(lit.some((value, i) => i % 4 === 0 && value > 0));
  assert.ok(lit.some((value, i) => i % 4 === 0 && value === 0), 'only occupied windows emit');
  disposeFacadeTextures(day); disposeFacadeTextures(night);
});

test('time-of-day changes reuse texture identities and retain facade albedo', () => {
  const layer = new BuildingDetailsLayer({ enabled: () => true, lighting: () => getLightingState(12), mobile: false });
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: '#ffffff' });
  const state = layer as unknown as { map: unknown; batches: unknown[]; light: (state: ReturnType<typeof getLightingState>) => void; textures: Map<string, unknown> };
  state.map = { getZoom: () => 17, off: () => {} };
  state.batches = [{ profile: classifyBuilding({ class: 'apartments', num_floors: 3 }), material }];
  state.light(getLightingState(12));
  const maps = [material.map, material.emissiveMap, material.normalMap];
  const versions = maps.map(map => map!.version);
  for (const hour of [0, 4, 7, 12, 18, 21, 23]) state.light(getLightingState(hour));
  assert.deepEqual([material.map, material.emissiveMap, material.normalMap], maps);
  assert.deepEqual(maps.map(map => map!.version), versions, 'time does not re-upload images');
  assert.equal(material.color.getHexString(), 'ffffff', 'night is not applied twice to the albedo');
  assert.equal(state.textures.size, 1);
  layer.onRemove();
});

test('whole-viewport building coverage starts at quarter scale and batches 1050 source objects into three draws', () => {
  assert.deepEqual(buildingDetailBudget(false), { minZoom: 14.3, maxBuildings: 2000, minPixels: 2 });
  assert.deepEqual(buildingDetailBudget(true), { minZoom: 15, maxBuildings: 700, minPixels: 3 });
  const coordinate = MercatorCoordinate.fromLngLat([49.12, 55.79]), unit = coordinate.meterInMercatorCoordinateUnits();
  const point = (x: number, y: number): [number, number] => { const p = new MercatorCoordinate(coordinate.x + x * unit, coordinate.y - y * unit).toLngLat(); return [p.lng, p.lat]; };
  const geometry: Polygon = { type: 'Polygon', coordinates: [[point(0, 0), point(20, 0), point(20, 12), point(0, 12), point(0, 0)]] };
  const features: Feature<Polygon>[] = Array.from({ length: 1050 }, (_, i) => ({ type: 'Feature', geometry, properties: { id: `source-${i}`, class: 'apartments', num_floors: 3, facade_color: i % 2 ? '#804020' : '#d4d1c6' } }));
  const layer = new BuildingDetailsLayer({ enabled: () => true, lighting: () => getLightingState(12), mobile: false });
  const state = layer as unknown as { map: unknown; rebuild: () => void; entries: { id: string }[]; batches: unknown[]; content: THREE.Group };
  state.map = { getSource: () => ({}), querySourceFeatures: (_: string, { sourceLayer }: { sourceLayer: string }) => sourceLayer === 'building' ? features : [], getCenter: () => ({ lng: 49.12, lat: 55.79 }), getZoom: () => 14.5, getCanvas: () => ({ clientWidth: 1200, clientHeight: 800 }), project: () => ({ x: 600, y: 400 }), getTerrain: () => null, off: () => {} };
  state.rebuild();
  assert.equal(state.entries.length, 1050); assert.equal(state.batches.length, 1);
  assert.equal(state.content.children.length, 3, 'one facade batch, one roof batch, one edge batch');
  const walls = (state.content.children[0] as THREE.Mesh).geometry;
  assert.equal(walls.drawRange.count, 1050 * 4 * 6);
  const colors = walls.getAttribute('color');
  assert.ok(new Set(Array.from({ length: colors.count }, (_, i) => colors.getX(i))).size > 1, 'merged buildings retain independent source colours');
  layer.onRemove();
});
