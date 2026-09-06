import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, createExpression, createPropertyExpression, latest, type StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, Map as LibreMap } from 'maplibre-gl';
import { applyRoadStyle, isManagedRoadLayer, metresToLinePixels, ROAD_WIDTH_METRES } from '../src/lib/map-road-style';
import { ROAD_ASPHALT_COLOR, roadGeometryProfile } from '../src/lib/map-transport-profile';

function evaluate(value: unknown, properties: Record<string, unknown> = {}, zoom = 17) {
  const expression = createExpression(value, 'road'); assert.equal(expression.result, 'success', JSON.stringify(expression.value));
  if (expression.result !== 'success') throw new Error('Invalid road expression');
  return expression.value.evaluate({ zoom }, { type: 'LineString', properties });
}

function fixture() {
  const line = (id: string, extra: Record<string, unknown> = {}): LayerSpecification => ({ id, type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], id.startsWith('railway') ? 'rail' : 'primary'], paint: { 'line-color': '#fff', 'line-width': 7 }, ...extra } as LayerSpecification);
  const layers: LayerSpecification[] = [line('tunnel_motorway_inner'), line('highway_path'), line('highway_major_casing'), line('highway_major_inner'), line('railway'), line('railway_dashline'), line('highway_motorway_bridge_inner'), { id: 'road-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name' }];
  let latitude = 55.8;
  const writes: { id: string; property: string; value: unknown }[] = [];
  const getLayer = (id: string) => layers.find((layer) => layer.id === id);
  const map = {
    getSource: () => ({}), getCenter: () => ({ lat: latitude }), getLayer, getStyle: () => ({ version: 8, sources: {}, layers }),
    addLayer: (layer: LayerSpecification, before?: string) => layers.splice(before ? layers.findIndex((candidate) => candidate.id === before) : layers.length, 0, layer),
    setPaintProperty: (id: string, property: string, value: unknown) => { writes.push({ id, property, value }); const layer = getLayer(id) as { paint?: Record<string, unknown> }; layer.paint ??= {}; layer.paint[property] = value; },
  } as unknown as LibreMap;
  return { map, layers, writes, getLayer, setLatitude: (value: number) => { latitude = value; } };
}

test('MapLibre road dimensions agree with shared physical profiles and source lane/width overrides', () => {
  for (const roadClass of ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track']) {
    for (const extra of [{}, { oneway: true }, { oneway: '-1' }, { lanes: 3 }, { lanes: 11 }, { lanes: '2' }, { width: 11 }, { width: '12.5 m' }, { width: '7m ' }, { width: 0 }, { width: 'unknown' }, { width: 90 }, { subclass: 'service' }]) {
      const properties = { class: roadClass, ...extra };
      assert.equal(evaluate(ROAD_WIDTH_METRES, properties), roadGeometryProfile(properties).width, JSON.stringify(properties));
    }
  }
});

test('road pixels match physical metres at any close fractional zoom and regional latitude', () => {
  for (const latitude of [0, 45, 55.8, 69]) for (const zoom of [14, 15.3, 17, 18.75, 20]) {
    const pixels = evaluate(metresToLinePixels(ROAD_WIDTH_METRES, latitude, 0.8), { class: 'minor' }, zoom);
    const metres = pixels * 78271.51696 * Math.cos(latitude * Math.PI / 180) / 2 ** zoom;
    assert.ok(Math.abs(metres - roadGeometryProfile({ class: 'minor' }).width) < 1e-8, `${latitude} ${zoom}: ${metres}`);
  }
});

test('asphalt colors and casing widths agree with bridge surfaces, preserving pedestrian and brunnel layer order', () => {
  const scene = fixture(), originalOrder = scene.layers.map(layer => layer.id), path = structuredClone(scene.getLayer('highway_path'));
  applyRoadStyle(scene.map, scene.layers, 0);
  assert.deepEqual(scene.getLayer('highway_path'), path); assert.equal(isManagedRoadLayer(scene.getLayer('highway_path')!), false);
  assert.deepEqual(scene.layers.filter(layer => originalOrder.includes(layer.id)).map(layer => layer.id), originalOrder);
  const paint = (id: string) => (scene.getLayer(id) as { paint: Record<string, unknown> }).paint;
  assert.equal(Color.parse(String(paint('highway_major_inner')['line-color']))!.toString(), Color.parse(ROAD_ASPHALT_COLOR)!.toString());
  assert.equal(paint('highway_major_inner')['line-color'], paint('highway_motorway_bridge_inner')['line-color']);
  const roadWidth = evaluate(paint('highway_major_inner')['line-width'], { class: 'primary' });
  const casingWidth = evaluate(paint('highway_major_casing')['line-width'], { class: 'primary' });
  assert.ok(casingWidth > roadWidth && casingWidth / roadWidth < 1.1);
  const markings = scene.getLayer('atlas-road-lane-markings');
  for (const brunnel of ['bridge', 'tunnel']) assert.equal(markings?.type === 'line' && evaluate(markings.filter, { class: 'primary', brunnel }), false, 'ground markings must not cross elevated/tunnel road surfaces');
  applyRoadStyle(scene.map, scene.layers, 1); assert.equal(Color.parse(String(paint('highway_major_inner')['line-color']))!.toString(), Color.parse('#383d3c')!.toString());
});

test('2D rail ballast is dark with physical width and sleepers yield to the detailed railway', () => {
  const scene = fixture(); applyRoadStyle(scene.map, scene.layers, 0);
  const paint = (id: string) => (scene.getLayer(id) as { paint: Record<string, unknown> }).paint;
  const ballast = Color.parse(String(paint('railway')['line-color']))!;
  assert.ok(Math.max(...ballast.rgb.slice(0, 3)) < 0.5);
  assert.equal(evaluate(paint('railway_dashline')['line-opacity'], {}, 16), 0);
  assert.ok(evaluate(paint('railway_dashline')['line-opacity'], {}, 14) > 0);
  assert.equal(scene.layers.filter(layer => layer.id.startsWith('atlas-rail-steel-')).length, 2);
  assert.ok(scene.layers.findIndex(layer => layer.id === 'atlas-rail-steel-left-railway_dashline') < scene.layers.findIndex(layer => layer.id === 'highway_motorway_bridge_inner'));
});

test('road expressions are valid and unchanged lighting/nearby latitude trigger no new paint writes', () => {
  const scene = fixture(); assert.equal(applyRoadStyle(scene.map, scene.layers, 0), true);
  for (const write of scene.writes) {
    const spec = latest.paint_line[write.property as keyof typeof latest.paint_line] as StylePropertySpecification;
    const value = Array.isArray(write.value) && typeof write.value[0] === 'number' ? ['literal', write.value] : write.value;
    const compiled = createPropertyExpression(value, write.property, spec);
    assert.equal(compiled.result, 'success', `${write.id}.${write.property}: ${JSON.stringify(compiled.value)}`);
  }
  const count = scene.writes.length; assert.equal(applyRoadStyle(scene.map, scene.layers, 0), false); assert.equal(scene.writes.length, count);
  scene.setLatitude(55.801); assert.equal(applyRoadStyle(scene.map, scene.layers, 0), false);
  scene.setLatitude(56); assert.equal(applyRoadStyle(scene.map, scene.layers, 0), true);
  assert.ok(scene.writes.slice(count).every(write => ['line-width', 'line-offset'].includes(write.property)), 'latitude only changes geometry, not pigment');
});
