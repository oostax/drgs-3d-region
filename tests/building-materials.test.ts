import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, createExpression } from '@maplibre/maplibre-gl-style-spec';
import { MercatorCoordinate } from 'maplibre-gl';
import * as THREE from 'three';
import type { Feature, Geometry, Polygon } from 'geojson';
import { BUILDING_HEIGHT, BUILDING_BASE, BUILDING_FACADE_COLOR, BUILDING_ROOF_COLOR, classifyBuilding, buildingWallUV, getBuildingLight, type BuildingProfile, type BuildingProfileKind } from '../src/lib/building-materials';
import { BuildingDetailsLayer, buildingGeometryArea, makeBuildingDetailGeometry } from '../src/lib/map-building-details';
import { getLightingState } from '../src/lib/solar';

const coordinate = MercatorCoordinate.fromLngLat([49.12, 55.79]), unit = coordinate.meterInMercatorCoordinateUnits();
const point = (x: number, y: number): [number, number] => { const p = new MercatorCoordinate(coordinate.x + x * unit, coordinate.y - y * unit).toLngLat(); return [p.lng, p.lat]; };
const rectangle = (width: number, length: number): Polygon => ({ type: 'Polygon', coordinates: [[point(0, 0), point(width, 0), point(width, length), point(0, length), point(0, 0)]] });
const feature = (id: string, properties: Record<string, unknown> = {}, geometry: Geometry = rectangle(20, 12)): Feature<Geometry> => ({ type: 'Feature', geometry, properties: { id, ...properties } });

test('semantic use groups come from source tags; names and IDs never identify a building use', () => {
  const expected: [string, BuildingProfileKind][] = [['apartments', 'apartments'], ['house', 'house'], ['office', 'office'], ['retail', 'retail'], ['school', 'education'], ['hospital', 'hospital'], ['industrial', 'industrial'], ['warehouse', 'warehouse'], ['garage', 'garage'], ['shed', 'shed'], ['church', 'religious'], ['mosque', 'religious'], ['service', 'utility']];
  for (const [source, kind] of expected) assert.equal(classifyBuilding({ class: source }).kind, kind);
  assert.equal(classifyBuilding({ historic: 'yes' }).kind, 'historic');
  assert.equal(classifyBuilding({ id: 'red-brick-office', name: 'Школа' }).kind, 'neutral');
  for (const kind of ['residential', 'commercial', 'outbuilding', 'medical'] as const) {
    assert.equal(classifyBuilding({ class: kind }).kind, kind);
    assert.equal(classifyBuilding({ subtype: kind }).kind, kind);
  }
  assert.notEqual(classifyBuilding({ id: 'a' }).facadeColor, classifyBuilding({ id: 'b' }).facadeColor, 'unknown buildings may have different decorative pigments');
  assert.equal(classifyBuilding({ id: 'a' }).kind, classifyBuilding({ id: 'b' }).kind, 'decoration never changes semantic class');
});

test('concrete is not proof of panel construction, and office is not proof of glazing', () => {
  assert.equal(classifyBuilding({ class: 'apartments', facade_material: 'concrete' }).kind, 'apartments');
  assert.equal(classifyBuilding({ class: 'apartments', facade_material: 'concrete_panels' }).kind, 'panel');
  assert.equal(classifyBuilding({ class: 'apartments', facade_material: 'brick' }).kind, 'brick');
  assert.equal(classifyBuilding({ class: 'office' }).surface, 'plaster');
  assert.equal(classifyBuilding({ class: 'office', facade_material: 'glass' }).surface, 'glass');
});

test('religious, tiny and ancillary objects never receive residential window grids', () => {
  for (const c of ['church', 'mosque', 'garage', 'shed', 'service']) assert.equal(classifyBuilding({ class: c, num_floors: 3 }).windows, 'none');
  const tiny = classifyBuilding({}, 9); assert.equal(tiny.height, 8); assert.equal(tiny.windows, 'none');
  assert.equal(classifyBuilding({ class: 'apartments', num_floors: 9 }, 12).windows, 'none');
  assert.equal(classifyBuilding({ class: 'church', facade_material: 'glass' }).surface, 'plaster');
  assert.equal(classifyBuilding({ height: 22 }, 9).height, 22, 'explicit height remains evidence even for a small footprint');
});

test('source facade and roof colors are independent and override cautious defaults', () => {
  const p = classifyBuilding({ class: 'church', facade_color: '#804020', roof_color: '#007755' });
  assert.equal(p.facadeColor, '#804020'); assert.equal(p.roofColor, '#007755'); assert.ok(p.sourceFacadeColor && p.sourceRoofColor);
  assert.equal(classifyBuilding({ facade_color: 'not-a-color' }).sourceFacadeColor, false);
  const unknown = classifyBuilding({ class: 'house' }); assert.equal(unknown.roofShape, null); assert.equal(unknown.roofHeight, 0); assert.equal(unknown.roofDirection, null);
  const tagged = classifyBuilding({ height: 12, num_floors: 3, roof_shape: 'gabled', roof_height: 3, roof_direction: 120 });
  assert.equal(tagged.eaves, 9); assert.equal(tagged.roofShape, 'gabled'); assert.equal(tagged.roofHeight, 3); assert.equal(tagged.roofDirection, 120);
});

test('height expressions retain measured values, floor estimates and safe neutral defaults', () => {
  const expression = createExpression(BUILDING_HEIGHT, 'height'); assert.equal(expression.result, 'success'); if (expression.result !== 'success') return;
  for (const [properties, height] of [[{}, 8], [{ class: 'garage' }, 2.8], [{ num_floors: 5 }, 15], [{ height: 18, num_floors: 3 }, 18], [{ class: 'office' }, 7.2]] as [Record<string, unknown>, number][]) assert.equal(expression.value.evaluate({ zoom: 17 }, { type: 'Polygon', properties }), height);
  for (const expr of [BUILDING_BASE, BUILDING_FACADE_COLOR, BUILDING_ROOF_COLOR]) assert.equal(createExpression(expr, 'building').result, 'success');
  assert.equal(classifyBuilding({ num_floors: 5 }).heightEstimated, true); assert.equal(classifyBuilding({ height: 18 }).heightEstimated, false);
});

test('tiny objects, source coercion and parts use exactly the base-map height and base at every zoom', () => {
  const height = createExpression(BUILDING_HEIGHT, 'height'), base = createExpression(BUILDING_BASE, 'base');
  assert.equal(height.result, 'success'); assert.equal(base.result, 'success');
  if (height.result !== 'success' || base.result !== 'success') return;
  const cases = [
    { class: 'church' }, { class: 'retail' }, { class: 'apartments', num_floors: 9 },
    { building_id: 'office-parent' }, { building_id: 'religious-parent', min_height: 6 },
    { height: '12', num_floors: '3', min_height: '3' },
    { height: '12 m', num_floors: 2 }, { height: 0, 'building:levels': '4' },
    { num_floors: null, 'building:levels': 4 }, { class: 'education', amenity: 'school' },
  ];
  for (const properties of cases) for (const area of [6.12, 240]) {
    const profile = classifyBuilding(properties, area);
    for (const zoom of [14, 16, 19]) {
      assert.equal(profile.height, height.value.evaluate({ zoom }, { type: 'Polygon', properties }), JSON.stringify(properties));
      assert.equal(profile.base, base.value.evaluate({ zoom }, { type: 'Polygon', properties }));
    }
    if (area < 15) assert.equal(profile.windows, 'none');
  }
});

test('UV rows and eave positions align to known source floors, not zoom or wall length', () => {
  const p = classifyBuilding({ class: 'apartments', height: 30, num_floors: 9, roof_height: 3 }, 240), uv = buildingWallUV(20, p);
  assert.equal(uv.rows, 9); assert.equal(uv.metresPerFloor, 3); assert.equal(uv.upperV, 9);
  const geometry = makeBuildingDetailGeometry(rectangle(20, 12).coordinates, p), position = geometry.walls.getAttribute('position'), texture = geometry.walls.getAttribute('uv');
  const z = Array.from({ length: position.count }, (_, i) => position.getZ(i)); assert.equal(Math.max(...z), 27); assert.equal(Math.min(...z), 0);
  const v = Array.from({ length: texture.count }, (_, i) => texture.getY(i)); assert.equal(Math.max(...v) * 4, 9);
  const area = buildingGeometryArea(rectangle(3, 4)); assert.ok(Math.abs(area - 12) < 0.02);
  geometry.walls.dispose(); geometry.roof.dispose(); geometry.edge.dispose();
});

test('roof surface uses real polygon holes and adds no invented slope', () => {
  const polygon = rectangle(20, 20); polygon.coordinates.push([point(5, 5), point(5, 15), point(15, 15), point(15, 5), point(5, 5)]);
  const p = classifyBuilding({ height: 9 }), geometry = makeBuildingDetailGeometry(polygon.coordinates, p), pos = geometry.roof.getAttribute('position');
  let area = 0; for (let i = 0; i < pos.count; i += 3) { const a = new THREE.Vector3().fromBufferAttribute(pos, i), b = new THREE.Vector3().fromBufferAttribute(pos, i + 1), c = new THREE.Vector3().fromBufferAttribute(pos, i + 2); area += new THREE.Triangle(a, b, c).getArea(); }
  assert.ok(Math.abs(area - 300) < 0.1, 'roof hole remains open');
  for (let i = 0; i < pos.count; i++) {
    assert.ok(Math.abs(pos.getZ(i) - 9.08) < 0.001);
    assert.ok(pos.getZ(i) > 9.05, 'detail roof is physically above the opaque MapLibre roof cap');
  }
  const edge = geometry.edge.getAttribute('position');
  for (let i = 0; i < edge.count; i++) assert.ok(edge.getZ(i) > 9.08, 'coping is above both roof surfaces');
  geometry.walls.dispose(); geometry.roof.dispose(); geometry.edge.dispose();
});

test('dawn, dusk and night have neutral ambient and a warm directional source without blue channel wash', () => {
  for (const elevation of [-12, -5, 0, 5, 12, 40]) {
    const light = getBuildingLight({ ...getLightingState(18), sunElevation: elevation, nightAmount: elevation < -8 ? 1 : elevation < 0 ? 0.6 : 0 });
    const [r, g, b] = Color.parse(light.sunColor)!.rgb; assert.ok(r >= g && g >= b, `${elevation}: warm light`);
    const [ar, ag, ab] = Color.parse(light.ambientColor)!.rgb; assert.ok(ar >= ab && ag >= ab, 'ambient must not add blue');
  }
  assert.ok(getBuildingLight({ ...getLightingState(0), sunElevation: -12 }).sunIntensity < 0.1);
});

test('detail layer retains tile fragments and excludes landmark parents and parts', () => {
  const list = [feature('church', { class: 'church', height: 8 }), feature('part', { building_id: 'church', height: 15 }), feature('ambiguous'), feature('ambiguous', {}, rectangle(15, 12)), feature('normal', { num_floors: 2 })];
  const layer = new BuildingDetailsLayer({ enabled: () => true, lighting: () => getLightingState(12), mobile: true, excludeIds: () => new Set(['church']) });
  const state = layer as unknown as { map: unknown; rebuild: () => void; entries: { id: string }[] };
  state.map = { getSource: () => ({}), querySourceFeatures: (_: string, { sourceLayer }: { sourceLayer: string }) => sourceLayer === 'building' ? list : [], getCenter: () => ({ lng: 49.12, lat: 55.79 }), getZoom: () => 17, getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }), project: () => ({ x: 400, y: 300 }), getTerrain: () => null, off: () => {} };
  state.rebuild(); assert.deepEqual(state.entries.map((entry) => entry.id), ['ambiguous', 'normal']); layer.onRemove();
});

test('loaded parent appearance cannot raise a part or leak parent floors into its wall UV', () => {
  const parent = feature('office-parent', { class: 'office', num_floors: 4, height: 18, facade_color: '#804020' });
  const parts = [feature('unknown-height-part', { building_id: 'office-parent' }),
    feature('measured-part', { building_id: 'office-parent', height: 9, min_height: 3, num_floors: 3, min_floor: 1 })];
  const layer = new BuildingDetailsLayer({ enabled: () => true, lighting: () => getLightingState(12), mobile: true });
  const state = layer as unknown as { map: unknown; rebuild: () => void; entries: { id: string; profile: BuildingProfile; group: THREE.Group }[] };
  state.map = { getSource: () => ({}), querySourceFeatures: (_: string, { sourceLayer }: { sourceLayer: string }) => sourceLayer === 'building' ? [parent] : parts, getCenter: () => ({ lng: 49.12, lat: 55.79 }), getZoom: () => 17, getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }), project: () => ({ x: 400, y: 300 }), getTerrain: () => null, off: () => {} };
  state.rebuild();
  const unknown = state.entries.find(entry => entry.id === 'unknown-height-part')!;
  assert.equal(unknown.profile.kind, 'office'); assert.equal(unknown.profile.facadeColor, '#804020');
  assert.equal(unknown.profile.height, 8); assert.equal(unknown.profile.base, 0); assert.equal(unknown.profile.floors, 2);
  const measured = state.entries.find(entry => entry.id === 'measured-part')!;
  assert.equal(measured.profile.height, 9); assert.equal(measured.profile.base, 3); assert.equal(measured.profile.floors, 2);
  const detail = makeBuildingDetailGeometry(rectangle(20, 12).coordinates, measured.profile), walls = detail.walls;
  const position = walls.getAttribute('position'), uv = walls.getAttribute('uv');
  assert.equal(Math.min(...Array.from({ length: position.count }, (_, i) => position.getZ(i))), 3);
  assert.equal(Math.max(...Array.from({ length: position.count }, (_, i) => position.getZ(i))), 9);
  assert.equal(Math.max(...Array.from({ length: uv.count }, (_, i) => uv.getY(i))) * 4, 2);
  detail.walls.dispose(); detail.roof.dispose(); detail.edge.dispose(); layer.onRemove();
});
