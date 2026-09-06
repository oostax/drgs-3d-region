import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import type { Feature, Polygon, Position } from 'geojson';
import { BUILDING_BODY_HEIGHT, BUILDING_HEIGHT, classifyBuilding } from '../src/lib/building-materials';
import { buildingTerrainAnchor, buildingTerrainAltitude, BUILDING_TERRAIN_SKIRT } from '../src/lib/building-terrain';
import { buildBuildingGeometry, makeBuildingDetailGeometry, packBuildingGeometry, unpackBuildingGeometry, GEOMETRY_PARTS } from '../src/lib/building-detail-geometry';
import { BuildingDetailsLayer } from '../src/lib/map-building-details';
import { getLightingState } from '../src/lib/solar';

const origin = MercatorCoordinate.fromLngLat([49.12, 55.79]), unit = origin.meterInMercatorCoordinateUnits();
const point = (x: number, y: number): [number, number] => {
  const p = new MercatorCoordinate(origin.x + x * unit, origin.y - y * unit).toLngLat(); return [p.lng, p.lat];
};
const polygon: Position[][] = [[point(0, 0), point(200, 0), point(200, 20), point(0, 20), point(0, 0)]];
const range = (geometry: THREE.BufferGeometry) => {
  const p = geometry.getAttribute('position'); let low = Infinity, high = -Infinity;
  for (let i = 0; i < Math.min(p.count, geometry.drawRange.count); i++) { low = Math.min(low, p.getZ(i)); high = Math.max(high, p.getZ(i)); }
  return { low, high };
};
const dispose = (g: ReturnType<typeof makeBuildingDetailGeometry>) => { for (const key of ['walls', 'roof', 'edge', 'relief', 'signage'] as const) g[key].dispose(); };

function evaluate(expression: Parameters<typeof createExpression>[0], properties: Record<string, unknown>, zoom = 16) {
  const compiled = createExpression(expression, 'grounding-test');
  assert.equal(compiled.result, 'success'); if (compiled.result !== 'success') throw new Error('Invalid expression');
  return compiled.value.evaluate({ zoom }, { type: 'Polygon', properties });
}

test('neutral buildings retain 8 m across footprint fragments and zoom, without enlarging garages', () => {
  for (const properties of [{}, { building: 'yes' }, { class: 'unknown' }, { building_id: 'parent' }]) {
    for (const area of [6, 240, 50_000]) {
      const p = classifyBuilding(properties, area); assert.equal(p.height, 8); assert.equal(p.heightEstimated, true);
      for (const zoom of [10, 13, 14.3, 15, 16, 20]) assert.equal(evaluate(BUILDING_HEIGHT, properties, zoom), p.height);
    }
  }
  assert.equal(classifyBuilding({ class: 'garage' }).height, 2.8);
  assert.equal(classifyBuilding({ class: 'shed' }).height, 2.5);
  assert.equal(classifyBuilding({ height: 2.1 }).height, 2.1, 'a measured low building must stay low');
});

test('missing, zero and invalid primary floor counts do not erase a valid secondary floor tag', () => {
  for (const num_floors of [undefined, null, 0, -1, '', 'bad']) {
    const properties = { num_floors, 'building:levels': '4' };
    assert.equal(classifyBuilding(properties).height, 12);
    assert.equal(classifyBuilding(properties).floors, 4);
    assert.equal(evaluate(BUILDING_HEIGHT, properties), 12);
  }
  assert.equal(classifyBuilding({ num_floors: 5, 'building:levels': 4 }).height, 15);
  assert.equal(classifyBuilding({ height: 17, num_floors: null, 'building:levels': 4 }).height, 17);
});

test('flat, missing and unsupported roof shapes never leave a missing wall band below the vector cap', () => {
  for (const tags of [{}, { roof_shape: 'flat' }, { roof_shape: 'unsupported' }, { roof_shape: ' GABLED ' },
    { roof_shape: '', 'roof:shape': 'gabled' }, { roof_shape: 'GABLED' }, { 'roof:shape': 'hipped' }]) {
    const properties = { height: 18, roof_height: 4, ...tags }, profile = classifyBuilding(properties);
    assert.equal(profile.eaves, evaluate(BUILDING_BODY_HEIGHT, properties), JSON.stringify(tags));
    for (const level of [0, 1, 2] as const) {
      const g = makeBuildingDetailGeometry(polygon, profile, level);
      assert.equal(range(g.walls).high, profile.eaves);
      assert.ok(range(g.roof).low >= profile.eaves + .05, 'roof stays above the opaque cap');
      dispose(g);
    }
  }
});

test('terrain anchor ignores ring starting point, winding and closing duplicates, and includes courtyard vertices', () => {
  const ring = polygon[0].slice(0, -1);
  const expected = point(100, 10), close = (points: Position[]) => [...points, points[0]];
  for (let i = 0; i < ring.length; i++) for (const reverse of [false, true]) {
    const rotated = [...ring.slice(i), ...ring.slice(0, i)]; if (reverse) rotated.reverse();
    const actual = buildingTerrainAnchor([close(rotated)])!;
    assert.ok(Math.abs(actual[0] - expected[0]) < 1e-10); assert.ok(Math.abs(actual[1] - expected[1]) < 1e-10);
  }
  const courtyard = [point(20, 4), point(20, 8), point(40, 8), point(40, 4), point(20, 4)];
  const actual = buildingTerrainAnchor([polygon[0], courtyard])!, wanted = point(65, 8);
  assert.ok(Math.abs(actual[0] - wanted[0]) < 1e-10); assert.ok(Math.abs(actual[1] - wanted[1]) < 1e-10);
  assert.equal(buildingTerrainAnchor([]), null);
});

test('source-tile terrain anchors reproduce MapLibre integer centroid rounding', () => {
  const tile = { z: 15, x: 20855, y: 10248 }, span = 2 ** tile.z;
  const pixel = (x: number, y: number): Position => {
    const p = new MercatorCoordinate((tile.x + x / 8192) / span, (tile.y + y / 8192) / span).toLngLat(); return [p.lng, p.lat];
  };
  const rings = [[[100, 100], [501, 100], [501, 203], [100, 203], [100, 100]],
    [[130, 120], [130, 151], [191, 151], [191, 120], [130, 120]]];
  const anchor = buildingTerrainAnchor(rings.map(ring => ring.map(([x, y]) => pixel(x, y))), tile)!;
  // Eight vertices: mean x=230.5, y=143.5; the bucket stores floor(mean).
  const expected = pixel(230, 143);
  assert.ok(Math.abs(anchor[0] - expected[0]) < 1e-11); assert.ok(Math.abs(anchor[1] - expected[1]) < 1e-11);
});

test('terrain samples preserve negative altitudes and reject missing/non-finite values without guessing another location', () => {
  for (const value of [-25, 0, 125, null, NaN, Infinity]) {
    const actual = buildingTerrainAltitude({ queryTerrainElevation: () => value }, point(0, 0));
    assert.equal(actual, typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }
  assert.equal(buildingTerrainAltitude({ queryTerrainElevation: () => { throw new Error('must not query'); } }, null), 0);
});

test('terrain skirts preserve above-ground UV scale and never lower elevated building parts', () => {
  for (const base of [0, 6]) for (const terrain of [false, true]) {
    const p = classifyBuilding({ height: 18, min_height: base, num_floors: 6 });
    const g = makeBuildingDetailGeometry(polygon, p, 0, terrain), bottom = base - (terrain && base === 0 ? BUILDING_TERRAIN_SKIRT : 0);
    assert.equal(range(g.walls).low, bottom); assert.equal(range(g.walls).high, 18);
    const uv = g.walls.getAttribute('uv');
    assert.ok(Math.abs((uv.getY(2) - uv.getY(0)) / (18 - bottom) - 1 / (4 * p.floorHeight)) < 1e-7);
    assert.ok(Math.abs(uv.getY(0) + (base - bottom) / (4 * p.floorHeight)) < 1e-7);
    dispose(g);
  }
});

function setup(features: Feature<Polygon>[]) {
  let terrain = true, zoom = 17;
  const canvas = { clientWidth: 1440, clientHeight: 900 };
  const sample = ([lng, lat]: [number, number]) => 100 + (MercatorCoordinate.fromLngLat([lng, lat]).x - origin.x) / unit * .04;
  const layer = new BuildingDetailsLayer({ mobile: false, enabled: () => true, lighting: () => getLightingState(12) });
  const state = layer as unknown as {
    map: unknown; content: THREE.Group; rebuild: () => void; terrainChanged: () => void; dirty: boolean;
    entries: { id: string; profile: ReturnType<typeof classifyBuilding> }[];
    sourceCandidates: unknown[]; geometryInput: (candidate: unknown, level: number, origin: MercatorCoordinate) => Parameters<typeof buildBuildingGeometry>[0];
    light: (state: ReturnType<typeof getLightingState>) => void; batches: { material: THREE.MeshStandardMaterial }[];
  };
  state.map = {
    getSource: () => ({}), querySourceFeatures: (_: string, options: { sourceLayer: string }) => options.sourceLayer === 'building' ? features : [],
    getTerrain: () => terrain ? { source: 'atlas-dem' } : null, queryTerrainElevation: sample,
    getCenter: () => origin.toLngLat(), getZoom: () => zoom, getCanvas: () => canvas,
    project: () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }), triggerRepaint() {}, off() {},
  };
  return { layer, state, sample, canvas, setTerrain: (value: boolean) => { terrain = value; state.terrainChanged(); }, setZoom: (value: number) => { zoom = value; } };
}
const feature = (id: string): Feature<Polygon> => ({ type: 'Feature', properties: { id, roof_shape: 'flat' }, geometry: { type: 'Polygon', coordinates: polygon } });

test('a long building on a slope uses the vector centroid, not its low first corner, in foreground and worker inputs', () => {
  const h = setup([feature('long')]);
  try {
    h.state.rebuild();
    const input = h.state.geometryInput(h.state.sourceCandidates[0], 0, origin);
    assert.ok(Math.abs(input.altitudes[0] - 104) < 1e-6);
    const direct = buildBuildingGeometry(input), received = unpackBuildingGeometry(structuredClone(packBuildingGeometry('worker', direct)));
    assert.ok(Math.abs(range(direct.walls[0]).low - 94) < .01);
    assert.ok(Math.abs(range(direct.walls[0]).high - 112) < .01);
    assert.ok(range(direct.roofs[0]).low > Math.max(...polygon[0].map(p => h.sample(p as [number, number]))));
    for (const part of GEOMETRY_PARTS) {
      direct[part].forEach((g, i) => { assert.deepEqual(received[part][i].getAttribute('position').array, g.getAttribute('position').array); g.dispose(); });
      received[part].forEach(g => g.dispose());
    }
    h.setTerrain(false); assert.equal(h.state.dirty, true); h.state.rebuild();
    const flat = h.state.geometryInput(h.state.sourceCandidates[0], 0, origin);
    assert.equal(flat.terrain, false); assert.equal(flat.altitudes[0], 0); assert.notEqual(flat.key, input.key);
    assert.equal(range((h.state.content.children[0] as THREE.Mesh).geometry).low, 0);
  } finally { h.layer.onRemove(); }
});

test('switching a zero-elevation DEM still changes the geometry cache key and ground skirt', () => {
  const h = setup([feature('zero')]);
  (h.state.map as { queryTerrainElevation: () => number }).queryTerrainElevation = () => 0;
  try {
    h.state.rebuild(); const a = h.state.geometryInput(h.state.sourceCandidates[0], 0, origin);
    h.setTerrain(false); h.state.rebuild(); const b = h.state.geometryInput(h.state.sourceCandidates[0], 0, origin);
    assert.equal(a.altitudes[0], b.altitudes[0]); assert.notEqual(a.key, b.key);
    assert.equal(range((h.state.content.children[0] as THREE.Mesh).geometry).low, 0);
  } finally { h.layer.onRemove(); }
});

test('desktop to mobile to desktop rebuilds live budgets and shaders without changing building dimensions', () => {
  const h = setup(Array.from({ length: 780 }, (_, i) => feature(`long-${i}`)));
  try {
    h.state.rebuild(); const desktop = h.layer.getDiagnostics(); assert.equal(desktop.buildings, 780);
    const dimensions = h.state.entries.map(e => [e.profile.height, e.profile.base, e.profile.eaves]);
    h.canvas.clientWidth = 390; h.canvas.clientHeight = 844; h.layer.setMobile(true); assert.equal(h.state.dirty, true);
    h.state.rebuild(); h.state.light(getLightingState(12));
    const mobile = h.layer.getDiagnostics(); assert.equal(mobile.mobile, true); assert.ok(mobile.buildings <= 700); assert.ok(mobile.vertices <= 90_000);
    assert.ok(h.state.entries.every(e => e.profile.height === 8)); assert.ok(h.state.batches.every(b => b.material.normalMap === null));
    h.canvas.clientWidth = 1440; h.layer.setMobile(false); h.state.rebuild(); h.state.light(getLightingState(12));
    assert.deepEqual(h.state.entries.map(e => [e.profile.height, e.profile.base, e.profile.eaves]), dimensions);
    assert.ok(h.state.batches.every(b => b.material.normalMap !== null));
  } finally { h.layer.onRemove(); }
});
