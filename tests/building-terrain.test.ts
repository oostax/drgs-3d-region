import test from 'node:test';
import assert from 'node:assert/strict';
import { MercatorCoordinate, type Map as LibreMap } from 'maplibre-gl';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import type { Feature, Geometry, Polygon } from 'geojson';
import { BUILDING_BASE, BUILDING_BODY_HEIGHT, BUILDING_HEIGHT, classifyBuilding } from '../src/lib/building-materials';
import { buildingTerrainAnchor, sampleBuildingTerrain, buildingTerrainAltitudes, buildingTerrainRevision, installBuildingTerrain, terrainBuildingBase, terrainBuildingHeight } from '../src/lib/building-terrain';
import { BuildingDetailsLayer } from '../src/lib/map-building-details';
import { configureBuildingTileLod } from '../src/lib/building-lod';
import { getLightingState } from '../src/lib/solar';
import { readFileSync } from 'node:fs';

const origin = MercatorCoordinate.fromLngLat([49.12, 55.79]);
const unit = origin.meterInMercatorCoordinateUnits();
const point = (x: number, y: number): [number, number] => { const p = new MercatorCoordinate(origin.x + x * unit, origin.y - y * unit).toLngLat(); return [p.lng, p.lat]; };
const xy = (point: [number, number]) => { const p = MercatorCoordinate.fromLngLat(point); return [(p.x - origin.x) / unit, -(p.y - origin.y) / unit]; };
const rectangle = (width = 20, length = 10, x = 0): Polygon => ({ type: 'Polygon', coordinates: [[point(x, 0), point(x + width, 0), point(x + width, length), point(x, length), point(x, 0)]] });
const feature = (id: string, geometry: Geometry = rectangle(), properties: Record<string, unknown> = {}): Feature<Geometry> => ({ type: 'Feature', id, properties: { id, ...properties }, geometry });
const sampler = (read: (p: [number, number]) => number | null, active = true) => ({ getTerrain: () => active ? { source: 'atlas-dem' } : null, queryTerrainElevation: read });
const close = (a: number, b: number, tolerance = 0.025) => assert.ok(Math.abs(a - b) < tolerance, `${a} vs ${b}`);

function harness(t: { after: (fn: () => void) => void }) {
  const oldRequest = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  let id = 0, terrain: { source: string; exaggeration: number } | null = { source: 'atlas-dem', exaggeration: 1 };
  let read: (p: [number, number]) => number | null = () => 100;
  const frames = new Map<number, FrameRequestCallback>(), handlers = new Map<string, Set<(event?: any) => void>>();
  const states = new Map<string, Record<string, unknown>>(), features: Record<string, Feature<Geometry>[]> = { building: [], building_part: [] };
  globalThis.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  t.after(() => { globalThis.requestAnimationFrame = oldRequest; globalThis.cancelAnimationFrame = oldCancel; });
  const map = {
    on: (event: string, fn: (event?: any) => void) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event)!.add(fn); },
    off: (event: string, fn: (event?: any) => void) => { handlers.get(event)?.delete(fn); },
    getTerrain: () => terrain, queryTerrainElevation: (p: [number, number]) => read(p), getSource: () => ({}),
    querySourceFeatures: (_source: string, options: { sourceLayer: string }) => features[options.sourceLayer] ?? [],
    setFeatureState: (target: { sourceLayer: string; id: string }, state: Record<string, unknown>) => { const key = `${target.sourceLayer}:${target.id}`; states.set(key, { ...states.get(key), ...state }); },
    removeFeatureState: (target: { sourceLayer: string; id: string }, name: string) => { const state = states.get(`${target.sourceLayer}:${target.id}`); if (state) delete state[name]; },
    triggerRepaint: () => {}, getCenter: () => ({ lng: 49.12, lat: 55.79 }), getZoom: () => 17,
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }), project: () => ({ x: 400, y: 300 }),
  } as unknown as LibreMap;
  const flush = () => { let iterations = 0; while (frames.size) { assert.ok(++iterations < 10000, 'terrain scheduling must settle'); const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(0); } };
  const emit = (event: string, data?: unknown) => { for (const callback of handlers.get(event) ?? []) callback(data); };
  return { map, states, features, flush, emit, frames, handlers, setRead: (next: typeof read) => { read = next; }, setTerrain: (value: typeof terrain) => { terrain = value; emit('terrain'); } };
}

test('unknown buildings use 8 m at every zoom and footprint size; explicit small structures stay small', () => {
  const height = createExpression(BUILDING_HEIGHT, 'height'); assert.equal(height.result, 'success'); if (height.result !== 'success') return;
  for (const properties of [{}, { class: 'yes' }, { class: 'unknown' }, { building_id: 'parent' }]) {
    for (const area of [6, 240, 15000]) assert.equal(classifyBuilding(properties, area).height, 8);
    for (const zoom of [10, 13, 14.3, 15, 17, 20]) assert.equal(height.value.evaluate({ zoom }, { type: 'Polygon', properties }), 8);
  }
  assert.equal(classifyBuilding({ height: 2.8 }).height, 2.8);
  assert.equal(classifyBuilding({ class: 'garage' }).height, 2.8);
  assert.equal(classifyBuilding({ class: 'shed' }).height, 2.5);
  assert.equal(classifyBuilding({ num_floors: 5 }).height, 15);
  for (const value of [null, 0, '', 'invalid']) assert.equal(classifyBuilding({ num_floors: value, 'building:levels': 4 }).height, 12);
});

test('terrain datum is the Mercator vertex average including holes, without closing-point bias', () => {
  const polygon = rectangle(30, 20).coordinates;
  polygon.push([point(2, 2), point(2, 8), point(8, 8), point(8, 2), point(2, 2)]);
  const anchor = buildingTerrainAnchor(polygon)!;
  close(xy(anchor)[0], 10); close(xy(anchor)[1], 7.5);
  assert.deepEqual(buildingTerrainAnchor([]), null);
  assert.deepEqual(buildingTerrainAnchor([[[NaN, 1]]]), null);
});

test('tile anchor reproduces MapLibre integer floor rather than fractional centroid', () => {
  const tile = { z: 13, x: 5200, y: 2500 }, scale = 2 ** tile.z * 8192;
  const p = (x: number, y: number) => { const ll = new MercatorCoordinate((tile.x * 8192 + x) / scale, (tile.y * 8192 + y) / scale).toLngLat(); return [ll.lng, ll.lat]; };
  const anchor = buildingTerrainAnchor([[p(10, 10), p(31, 10), p(31, 30), p(10, 10)]], tile)!;
  const coordinate = MercatorCoordinate.fromLngLat(anchor);
  close(coordinate.x * scale - tile.x * 8192, 24, 1e-6);
  close(coordinate.y * scale - tile.y * 8192, 16, 1e-6);
});

test('slope lift preserves the complete wall height above the highest sampled footprint', () => {
  const sample = sampleBuildingTerrain(rectangle().coordinates, sampler(p => 100 + xy(p)[0] / 2))!;
  close(sample.datum, 105); close(sample.lift, 5);
  assert.ok(sample.datum + sample.lift + 8 >= 118 - 1e-6);
  const reverse = rectangle().coordinates.map(ring => [...ring].reverse());
  const reversed = sampleBuildingTerrain(reverse, sampler(p => 100 + xy(p)[0] / 2))!;
  close(reversed.datum, sample.datum); close(reversed.lift, sample.lift);
});

test('long edges and interior hills are sampled, not just footprint vertices', () => {
  const read = (p: [number, number]) => { const [x] = xy(p); return 100 + Math.max(0, 12 - Math.abs(x - 25)); };
  const sample = sampleBuildingTerrain(rectangle(200, 10).coordinates, sampler(read))!;
  assert.ok(sample.lift > 10, 'ridge between the first corner and centroid must be detected');
});

test('missing or nonfinite DEM is not treated as zero; negative elevations are valid', () => {
  for (const elevation of [null, NaN, Infinity, -Infinity]) assert.equal(sampleBuildingTerrain(rectangle().coordinates, sampler(() => elevation)), null);
  assert.equal(sampleBuildingTerrain(rectangle().coordinates, sampler(p => xy(p)[0] > 19 ? null : 100)), null);
  assert.deepEqual(sampleBuildingTerrain(rectangle().coordinates, sampler(() => -18)), { datum: -18, lift: 0 });
  assert.deepEqual(sampleBuildingTerrain(rectangle().coordinates, sampler(() => { throw new Error('must not query disabled terrain'); }, false)), { datum: 0, lift: 0 });
});

test('terrain expressions move roofs and elevated parts together but retain the ground basement', () => {
  const height = createExpression(terrainBuildingHeight(BUILDING_BODY_HEIGHT), 'height');
  const base = createExpression(terrainBuildingBase(BUILDING_BASE), 'base');
  assert.equal(height.result, 'success'); assert.equal(base.result, 'success');
  if (height.result !== 'success' || base.result !== 'success') return;
  const ground = { type: 'Polygon' as const, properties: { height: 12, roof_shape: 'gabled', roof_height: 3 } };
  assert.equal(height.value.evaluate({ zoom: 17 }, ground, { atlasTerrainLift: 5 }), 14);
  assert.equal(base.value.evaluate({ zoom: 17 }, ground, { atlasTerrainLift: 5 }), 0);
  const part = { type: 'Polygon' as const, properties: { height: 12, min_height: 3 } };
  assert.equal(height.value.evaluate({ zoom: 17 }, part, { atlasTerrainLift: 5 }), 17);
  assert.equal(base.value.evaluate({ zoom: 17 }, part, { atlasTerrainLift: 5 }), 8);
  assert.equal(height.value.evaluate({ zoom: 10 }, part, {}), 12);
});

test('controller shares per-ID lift across tile fragments and isolates building_part IDs', t => {
  const h = harness(t), first = feature('same'), second = feature('same', rectangle(20, 10, 40));
  h.features.building = [first, second, first]; h.features.building_part = [feature('same', rectangle(), { min_height: 3, height: 12 })];
  h.setRead(p => 100 + xy(p)[0] / 2);
  const controller = installBuildingTerrain(h.map); t.after(controller.dispose); h.flush();
  close(Number(h.states.get('building:same')!.atlasTerrainLift), 5);
  close(Number(h.states.get('building_part:same')!.atlasTerrainLift), 5);
  const combined = feature('same', { type: 'MultiPolygon', coordinates: [rectangle().coordinates, rectangle(20, 10, 40).coordinates] });
  const altitudes = buildingTerrainAltitudes(h.map, combined)!;
  close(altitudes[0], 110); close(altitudes[1], 130);
  const before = buildingTerrainRevision(h.map); h.emit('moveend'); h.flush();
  assert.equal(buildingTerrainRevision(h.map), before, 'unchanged placement must not rebuild details on every move');
});

test('DEM arrival, changes and terrain toggles invalidate caches without using sea-level geometry', t => {
  const h = harness(t), building = feature('test'); h.features.building = [building]; h.setRead(() => null);
  const controller = installBuildingTerrain(h.map); t.after(controller.dispose); h.flush();
  assert.equal(buildingTerrainAltitudes(h.map, building), null);
  h.setRead(() => 140); h.emit('sourcedata', { sourceId: 'atlas-dem', sourceDataType: 'content' }); h.flush();
  assert.deepEqual(buildingTerrainAltitudes(h.map, building), [140]);
  const oldRevision = buildingTerrainRevision(h.map);
  h.setRead(() => 280); h.setTerrain({ source: 'atlas-dem', exaggeration: 2 }); h.flush();
  assert.deepEqual(buildingTerrainAltitudes(h.map, building), [280]); assert.ok(buildingTerrainRevision(h.map) > oldRevision);
  h.setTerrain(null); h.flush(); assert.deepEqual(buildingTerrainAltitudes(h.map, building), [0]);
  assert.equal(h.states.get('building:test')?.atlasTerrainLift, undefined);
  controller.dispose(); assert.equal(h.frames.size, 0);
  for (const listeners of h.handlers.values()) assert.equal(listeners.size, 0);
});

test('detail layer skips unknown DEM and rebuilds the same building when terrain arrives', t => {
  const h = harness(t); h.features.building = [feature('long', rectangle(200, 20))]; h.setRead(() => null);
  const terrain = installBuildingTerrain(h.map); t.after(terrain.dispose); h.flush();
  const layer = new BuildingDetailsLayer({ enabled: () => true, lighting: () => getLightingState(12), mobile: true });
  const state = layer as unknown as { map: LibreMap; rebuild: () => void; entries: { id: string }[]; geometryCache: Map<string, { roofs: { getAttribute: (name: string) => { count: number; getZ: (i: number) => number } }[] }> };
  state.map = h.map; t.after(() => layer.onRemove()); state.rebuild(); assert.equal(state.entries.length, 0);
  h.setRead(p => 100 + xy(p)[0] / 20); h.emit('sourcedata', { sourceId: 'atlas-dem', sourceDataType: 'content' }); h.flush(); state.rebuild();
  assert.equal(state.entries.length, 1);
  for (const cached of state.geometryCache.values()) for (const roof of cached.roofs) {
    const positions = roof.getAttribute('position');
    for (let i = 0; i < positions.count; i++) assert.ok(positions.getZ(i) >= 118 - 0.03, 'roof stays above terrain plus the full 8 m body');
  }
});

test('native source setup retains tile metadata and lifts every body and roof exactly once', t => {
  const h = harness(t); h.setTerrain(null);
  const api = h.map as unknown as Record<string, any>;
  let specification = { type: 'vector', url: 'pmtiles://local-buildings', minzoom: 10, maxzoom: 15, attribution: 'source evidence' } as Record<string, unknown>;
  let replacements = 0, writes = 0, lodCalls = 0;
  const layers = new Map<string, { id: string; type: string; source: string }>();
  const paint = new Map<string, Record<string, unknown>>();
  api.getSource = () => ({ serialize: () => specification });
  api.removeSource = () => { replacements++; };
  api.addSource = (_id: string, next: Record<string, unknown>) => { specification = next; };
  api.getStyle = () => ({ layers: [...layers.values()] });
  api.getLayer = (id: string) => layers.get(id);
  api.getPaintProperty = (id: string, name: string) => paint.get(id)![name];
  api.setPaintProperty = (id: string, name: string, value: unknown) => { paint.get(id)![name] = value; writes++; h.emit('styledata'); };
  api.setSourceTileLodParams = () => { lodCalls++; };
  configureBuildingTileLod(h.map); h.flush();
  assert.equal(replacements, 1); assert.equal(lodCalls, 1);
  assert.deepEqual(specification, { type: 'vector', url: 'pmtiles://local-buildings', minzoom: 10, maxzoom: 15, attribution: 'source evidence', promoteId: 'id' });
  for (const id of ['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs']) {
    layers.set(id, { id, type: 'fill-extrusion', source: 'atlas-buildings' });
    const roof = id.includes('roof');
    paint.set(id, { 'fill-extrusion-height': roof ? ['+', BUILDING_BODY_HEIGHT, 0.05] : BUILDING_BODY_HEIGHT, 'fill-extrusion-base': roof ? BUILDING_BODY_HEIGHT : BUILDING_BASE });
  }
  h.emit('styledata'); assert.equal(writes, 8);
  for (const [id, values] of paint) {
    const roof = id.includes('roof');
    for (const [property, expected] of [['fill-extrusion-height', roof ? 13.05 : 13], ['fill-extrusion-base', roof ? 13 : 0]] as const) {
      const expression = createExpression(values[property] as any, property);
      assert.equal(expression.result, 'success');
      if (expression.result === 'success') close(Number(expression.value.evaluate({ zoom: 17 }, { type: 'Polygon', properties: {} }, { atlasTerrainLift: 5 })), expected, 1e-6);
    }
  }
  h.emit('styledata'); assert.equal(writes, 8, 'style events must not accumulate terrain lift');
  h.emit('remove'); assert.equal(h.frames.size, 0);
  for (const listeners of h.handlers.values()) assert.equal(listeners.size, 0);
});

test('both the native map and detail worker input use shared terrain placement', () => {
  const grounding = readFileSync(new URL('../src/lib/map-building-grounding.ts', import.meta.url), 'utf8');
  const details = readFileSync(new URL('../src/lib/map-building-details.ts', import.meta.url), 'utf8');
  assert.ok(grounding.includes('terrainBuildingHeight(height)'));
  assert.ok(grounding.includes('terrainBuildingBase(base)'));
  assert.ok(grounding.includes('installBuildingTerrain(map)'));
  assert.ok(details.includes('buildingTerrainAltitudes('));
  assert.ok(!details.includes('queryTerrainElevation([polygon[0][0][0]'));
  assert.ok(details.includes('buildingTerrainRevision(map)'));
});
