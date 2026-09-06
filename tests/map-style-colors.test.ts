import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, createExpression, createPropertyExpression, latest, type StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Map as LibreMap, LayerSpecification } from 'maplibre-gl';
import { applyMapLighting, ROOF_COLOR } from '../src/lib/map-appearance';
import { BUILDING_VARIANT, mixCssColor, surfaceRole, themedColorValue } from '../src/lib/map-style-colors';
import { getSceneTime } from '../src/lib/solar';

const nightState = { ...getSceneTime({ timeMode: 'manual', hour: 0, life: false }), nightAmount: 1 };
const maxChannel = (value: unknown) => Math.max(...Color.parse(String(value))!.rgb.slice(0, 3));

test('actual OpenFreeMap rgb, rgba and hsl white surfaces all become dark at night', () => {
  for (const [id, color] of [['landuse_residential', 'rgb(234, 234, 230)'], ['aeroway-area', 'rgba(255, 255, 255, 1)'], ['landcover_glacier', 'hsl(0,0%,98%)'], ['background', 'white'], ['road_area_pier', '#fff'], ['park', '#ffffffff']]) {
    const role = surfaceRole(id, 'fill', 'fill-color'), result = themedColorValue(color, role, 1);
    assert.ok(maxChannel(result) < 0.4, `${id} remained bright: ${String(result)}`);
  }
  assert.equal(Color.parse(mixCssColor('rgba(255,255,255,0.2)', '#17262b', 1))!.a, 0.2, 'transparent masks must retain their alpha');
});

test('zoom stops, match labels and conditions survive recoloring; nested white output disappears', () => {
  const original = ['interpolate', ['linear'], ['zoom'], 8, ['match', ['get', 'class'], 'white', 'rgb(255,255,255)', 'park', ['case', ['==', ['get', 'name'], 'white'], 'hsl(0,0%,98%)', '#f4f4ee'], 'white'], 16, ['step', ['get', 'level'], 'rgba(255,255,255,1)', 2, '#fff']];
  const transformed = themedColorValue(original, 'residential', 1) as unknown[];
  assert.deepEqual(transformed.slice(0, 4), original.slice(0, 4)); assert.equal(transformed[5], 16);
  const match = transformed[4] as unknown[]; assert.equal(match[2], 'white'); assert.equal(match[4], 'park');
  const conditional = match[5] as unknown[]; assert.deepEqual(conditional[1], ['==', ['get', 'name'], 'white']);
  assert.ok(maxChannel(match[3]) < 0.4); assert.ok(maxChannel(conditional[2]) < 0.4); assert.ok(maxChannel(match.at(-1)) < 0.4);
  assert.deepEqual(original[4], ['match', ['get', 'class'], 'white', 'rgb(255,255,255)', 'park', ['case', ['==', ['get', 'name'], 'white'], 'hsl(0,0%,98%)', '#f4f4ee'], 'white'], 'original style is immutable');
  const compiled = createPropertyExpression(transformed, 'layers[0].paint.fill-color', latest.paint_fill['fill-color'] as StylePropertySpecification); assert.equal(compiled.result, 'success', String(compiled.value));
});

test('feature-driven colors remain valid inside zoom expressions and cannot emit white at night', () => {
  const value = themedColorValue(['interpolate', ['linear'], ['zoom'], 8, ['to-color', ['get', 'paint']], 18, ['coalesce', ['get', 'other'], 'white']], 'asphalt', 1);
  const compiled = createPropertyExpression(value, 'layers[0].paint.fill-color', latest.paint_fill['fill-color'] as StylePropertySpecification); assert.equal(compiled.result, 'success', String(compiled.value));
  const evaluated = createExpression(value, 'layers[0].paint.fill-color'); assert.equal(evaluated.result, 'success');
  if (evaluated.result === 'success') { const color = evaluated.value.evaluate({ zoom: 17 }, { type: 'Polygon', properties: { paint: 'white', other: 'rgb(255,255,255)' } }) as Color; assert.ok(Math.max(...color.rgb.slice(0, 3)) < 0.4); }
});

test('shared Overture prefixes produce all eight stable facade variants and parts reuse their parent', () => {
  const compiled = createExpression(BUILDING_VARIANT, 'layers[0].paint.fill-extrusion-color'); assert.equal(compiled.result, 'success', String(compiled.value)); if (compiled.result !== 'success') return;
  const variants = new Set<number>();
  for (let suffix = 0; suffix < 32; suffix++) { const id = `08b8b852adffffff000${suffix.toString(16).padStart(2, '0')}`; const variant: number = compiled.value.evaluate({ zoom: 17 }, { type: 'Polygon', properties: { id } }); variants.add(variant); assert.equal(compiled.value.evaluate({ zoom: 19 }, { type: 'Polygon', properties: { id: 'part-other-id', building_id: id } }), variant); }
  assert.equal(variants.size, 8);
  const result = createPropertyExpression(ROOF_COLOR, 'layers[0].paint.fill-extrusion-color', latest['paint_fill-extrusion']['fill-extrusion-color'] as StylePropertySpecification); assert.equal(result.result, 'success', String(result.value));
});

function mockMap(layers: LayerSpecification[]) {
  const images = new Map<string, unknown>(), writes: { id: string; property: string; value: unknown }[] = [], counters = { addImage: 0, updateImage: 0, light: 0, repaint: 0 };
  const style = { version: 8, sources: { openmaptiles: { type: 'vector' } }, layers };
  const getLayer = (id: string) => layers.find((layer) => layer.id === id);
  const map = { getStyle: () => style, getSource: (id: string) => id === 'openmaptiles' ? {} : undefined, getLayer, hasImage: (id: string) => images.has(id), addImage: (id: string, image: unknown) => { images.set(id, image); counters.addImage++; }, updateImage: (id: string, image: unknown) => { images.set(id, image); counters.updateImage++; }, addLayer: (layer: LayerSpecification) => layers.push(layer), setPaintProperty: (id: string, property: string, value: unknown) => { writes.push({ id, property, value }); const layer = getLayer(id)! as unknown as { paint: Record<string, unknown> }; layer.paint ??= {}; layer.paint[property] = value; }, setLight: () => { counters.light++; }, triggerRepaint: () => { counters.repaint++; } } as unknown as LibreMap;
  return { map, layers, images, writes, counters };
}

test('real lighting pass darkens omitted surfaces, updates late roofs, and never uploads unused facade images', () => {
  const fixture = mockMap([{ id: 'background', type: 'background', paint: { 'background-color': 'white' } }, { id: 'landuse_residential', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse', paint: { 'fill-color': 'rgb(234, 234, 230)' } }, { id: 'aeroway-area', type: 'fill', source: 'openmaptiles', 'source-layer': 'aeroway', paint: { 'fill-color': 'rgba(255,255,255,1)' } }, { id: 'town', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', paint: { 'text-color': '#111', 'text-halo-color': 'white' } }]);
  applyMapLighting(fixture.map, nightState); assert.equal(fixture.counters.addImage, 3); assert.ok([...fixture.images.keys()].every(id => id.startsWith('atlas-ground-grain-')), 'only shared ground masks are uploaded');
  for (const id of ['background', 'aeroway-area']) { const color = fixture.writes.find((write) => write.id === id && write.property.endsWith('-color'))!.value; assert.ok(maxChannel(color) < 0.4); }
  const ground = fixture.writes.find(write => write.id === 'atlas-ground-landuse' && write.property === 'fill-color')!.value;
  const groundExpression = createPropertyExpression(ground, 'fill-color', latest.paint_fill['fill-color'] as StylePropertySpecification);
  assert.equal(groundExpression.result, 'success');
  if (groundExpression.result === 'success') assert.ok(Math.max(...(groundExpression.value.evaluate({ zoom: 17 }, { type: 'Polygon', properties: { class: 'residential' } }) as Color).rgb.slice(0, 3)) < 0.4);
  assert.ok(fixture.layers.some((layer) => layer.id === 'atlas-road-soft-light')); assert.equal(fixture.layers.filter((layer) => layer.type === 'symbol').length, 1, 'road labels are never cloned');
  const count = fixture.writes.length; applyMapLighting(fixture.map, { ...nightState, nightAmount: 0.998 }); assert.equal(fixture.counters.updateImage, 0); assert.equal(fixture.writes.length, count);
  fixture.layers.push({ id: 'atlas-building-roofs', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', paint: { 'fill-extrusion-color': ROOF_COLOR } });
  applyMapLighting(fixture.map, nightState); assert.ok(fixture.writes.some((write) => write.id === 'atlas-building-roofs')); assert.equal(fixture.counters.updateImage, 0);
  applyMapLighting(fixture.map, { ...nightState, nightAmount: 0.9 }); assert.equal(fixture.counters.updateImage, 0);
});
