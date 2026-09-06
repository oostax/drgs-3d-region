import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import type { Feature, Polygon } from 'geojson';
import { BUILDING_BODY_HEIGHT, classifyBuilding, getBuildingRenderCap } from '../src/lib/building-materials';
import { BuildingDetailsLayer, makeBuildingDetailGeometry } from '../src/lib/map-building-details';
import { getLightingState } from '../src/lib/solar';

const origin = MercatorCoordinate.fromLngLat([49.12, 55.79]), unit = origin.meterInMercatorCoordinateUnits();
const point = (x: number, y: number, lng = 49.12): [number, number] => {
  const start = MercatorCoordinate.fromLngLat([lng, 55.79]), p = new MercatorCoordinate(start.x + x * unit, start.y - y * unit).toLngLat();
  return [p.lng, p.lat];
};
const rectangle = (offset = 0, lng = 49.12): Polygon => ({ type: 'Polygon', coordinates: [[point(offset, 0, lng), point(offset + 24, 0, lng), point(offset + 24, 16, lng), point(offset, 16, lng), point(offset, 0, lng)]] });
const range = (geometry: THREE.BufferGeometry) => {
  const position=geometry.getAttribute('position');let low=Infinity,high=-Infinity;
  for(let i=0;i<Math.min(position.count,geometry.drawRange.count);i++){const z=position.getZ(i);low=Math.min(low,z);high=Math.max(high,z);}
  return {low,high};
};
const dispose = (geometry: ReturnType<typeof makeBuildingDetailGeometry>) => { geometry.walls.dispose(); geometry.roof.dispose(); geometry.edge.dispose(); geometry.relief.dispose(); geometry.signage.dispose(); };
type LayerState = { map: unknown; rebuild: () => void; light: (state: ReturnType<typeof getLightingState>) => void; textures: Map<string, { diffuse: THREE.Texture; emissive: THREE.Texture; normal: THREE.Texture }>; entries: { detailLevel: number }[]; content: THREE.Group; dirty: boolean; sourceChanged: (event: { sourceId: string; sourceDataType: string; isSourceLoaded: boolean }) => void };
function setup(features: Feature<Polygon>[], mobile = false) {
  const layer = new BuildingDetailsLayer({ enabled: () => true, lighting: () => getLightingState(12), mobile });
  const state = layer as unknown as LayerState; let zoom = 14.4, scale = 0.2;
  state.map = {
    getSource: () => ({}), querySourceFeatures: (_: string, { sourceLayer }: { sourceLayer: string }) => sourceLayer === 'building' ? features : [],
    getCenter: () => ({ lng: 49.12, lat: 55.79 }), getZoom: () => zoom, getCanvas: () => ({ clientWidth: 1200, clientHeight: 800 }),
    project: ([lng, lat]: [number, number]) => { const p = MercatorCoordinate.fromLngLat([lng, lat]); return { x: 600 + (p.x - origin.x) / unit * scale, y: 400 - (p.y - origin.y) / unit * scale }; },
    getTerrain: () => null, triggerRepaint: () => {}, off: () => {},
  };
  return { layer, state, view: (nextZoom: number, nextScale: number) => { zoom = nextZoom; scale = nextScale; } };
}

test('integrated close buildings combine pitched roofs and solid facade relief in physical metres', () => {
  const profile = classifyBuilding({ class: 'apartments', height: 18, num_floors: 5, roof_height: 3, roof_shape: 'gabled' }, 384);
  const a = makeBuildingDetailGeometry(rectangle().coordinates, profile, 2), b = makeBuildingDetailGeometry(rectangle(0, 37.62).coordinates, profile, 2);
  assert.equal(a.roofKind, 'gabled'); assert.equal(a.roofEstimated, false);
  assert.ok(range(a.roof).high - range(a.roof).low > 2.9);
  assert.ok(a.relief.getAttribute('position').count > 500);
  assert.ok(a.relief.getAttribute('color').count === a.relief.getAttribute('normal').count);
  for (const field of ['walls', 'roof', 'relief'] as const) {
    a[field].computeBoundingBox(); b[field].computeBoundingBox();
    const sizeA = a[field].boundingBox!.getSize(new THREE.Vector3()), sizeB = b[field].boundingBox!.getSize(new THREE.Vector3());
    assert.ok(sizeA.distanceTo(sizeB) < 0.01, `${field} keeps metre dimensions in another longitude`);
  }
  dispose(a); dispose(b);
});

test('LOD upgrades replace cached simple geometry while time of day preserves all texture identities', () => {
  const feature: Feature<Polygon> = { type: 'Feature', properties: { id: 'building', class: 'apartments', height: 15, num_floors: 5 }, geometry: rectangle() };
  const { layer, state, view } = setup([feature]); state.rebuild();
  assert.equal(state.entries[0].detailLevel, 0); const far = layer.getDiagnostics();
  view(16.5, 4); state.rebuild(); state.light(getLightingState(12)); const near = layer.getDiagnostics();
  assert.equal(state.entries[0].detailLevel, 2); assert.equal(near.cacheHits, 0, 'detail level is part of the geometry key');
  assert.ok(near.vertices > far.vertices + 500);
  const ids = [...state.textures.values()].map(textures => [textures.diffuse.uuid, textures.emissive.uuid, textures.normal.uuid]);
  state.light(getLightingState(0));
  assert.deepEqual([...state.textures.values()].map(textures => [textures.diffuse.uuid, textures.emissive.uuid, textures.normal.uuid]), ids);
  state.rebuild(); assert.equal(layer.getDiagnostics().cacheHits, 1);
  layer.onRemove();
});

test('base vector body and custom cap use the same source roof-height coercion', () => {
  const compiled = createExpression(BUILDING_BODY_HEIGHT, 'building-body-height');
  assert.equal(compiled.result, 'success'); if (compiled.result !== 'success') return;
  const cases = [
    { height: 18, roof_shape: 'gabled', roof_height: 4 },
    { height: 18, min_height: 6, roof_shape: 'hipped', roof_height: 99 },
    { height: 18, 'roof:shape': 'barrel', 'roof:height': '3.5' },
    { height: 18, 'roof:shape': 'gabled', 'roof:height': '3 m' },
    { height: 18, 'roof:shape': 'gabled', 'roof:height': '3,5' },
    { height: 18, roof_shape: 'gabled', roof_height: 'bad', 'roof:height': 3 },
    { height: 18, roof_shape: 'unsupported', roof_height: 4 },
  ];
  for (const properties of cases) {
    const profile = classifyBuilding(properties, 384), body = compiled.value.evaluate({ zoom: 16 }, { type: 'Polygon', properties }) as number;
    assert.equal(body, getBuildingRenderCap(profile), JSON.stringify(properties));
  }
});

test('tagged pitched buildings have no floating fallback roof or high perimeter wire at any detail level', () => {
  const profile = classifyBuilding({ class: 'house', height: 12, roof_shape: 'gabled', roof_height: 3, roof_direction: 0 }, 384), cap = getBuildingRenderCap(profile);
  for (const detailLevel of [0, 1, 2] as const) {
    const geometry = makeBuildingDetailGeometry(rectangle().coordinates, profile, detailLevel), roof = range(geometry.roof), edges = geometry.edge.getAttribute('position');
    assert.ok(roof.low >= cap + 0.05 && roof.low <= cap + 0.12, `LOD ${detailLevel}: the roof starts on the opaque eave cap, not metres above it`);
    assert.ok(roof.high <= profile.height + 0.12, 'tagged total height stays authoritative');
    assert.ok(edges.count === 0 || edges.getZ(0) <= cap + 0.2, `LOD ${detailLevel}: the eave edge does not float at ridge height`);
    dispose(geometry);
  }
});

test('merged architecture including roofs and relief respects both mobile and desktop vertex limits', () => {
  const ring: [number, number][] = Array.from({ length: 72 }, (_, i) => point(32 * Math.cos(i / 72 * Math.PI * 2), 32 * Math.sin(i / 72 * Math.PI * 2)));
  const features: Feature<Polygon>[] = Array.from({ length: 340 }, (_, i) => ({ type: 'Feature', properties: { id: `complex-${i}`, class: 'apartments', height: 18, num_floors: 6 }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } }));
  for (const mobile of [false, true]) {
    const { layer, state, view } = setup(features, mobile); view(18, 4); state.rebuild();
    const diagnostics = layer.getDiagnostics();
    assert.ok(diagnostics.buildings > 20 && diagnostics.modeledBuildings > 0);
    assert.ok(diagnostics.vertices <= (mobile ? 90_000 : 280_000), JSON.stringify(diagnostics));
    assert.ok(diagnostics.detailedBuildings <= (mobile ? 28 : 120));
    assert.ok(state.content.children.every(child => child.frustumCulled === false));
    layer.onRemove();
  }
});

test('late terrain data rebuilds altitude-dependent geometry before another camera move', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const feature: Feature<Polygon> = { type: 'Feature', properties: { id: 'terrain-building', class: 'apartments', height: 15 }, geometry: rectangle() };
  const { layer, state, view } = setup([feature]); view(16.5, 4);
  const map = state.map as { getTerrain: () => { source: string } | null; queryTerrainElevation?: () => number };
  let elevation = 0; map.getTerrain = () => ({ source: 'atlas-dem' }); map.queryTerrainElevation = () => elevation;
  state.rebuild(); assert.equal(state.dirty, false);
  elevation = 125;
  state.sourceChanged({ sourceId: 'atlas-dem', sourceDataType: 'content', isSourceLoaded: false });
  context.mock.timers.tick(250);
  assert.equal(state.dirty, true, 'the terrain tile must invalidate building elevations even while adjacent DEM tiles load');
  state.rebuild(); const walls = (state.content.children[0] as THREE.Mesh).geometry;
  assert.ok(Math.abs(range(walls).low - 125) < 0.01, 'custom facade follows the same ground altitude as the opaque map body');
  assert.equal(layer.getDiagnostics().cacheHits, 0);
  layer.onRemove();
});
