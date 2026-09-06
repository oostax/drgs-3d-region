import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, createPropertyExpression, latest, type StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, LightSpecification, Map as LibreMap } from 'maplibre-gl';
import { applyMapLighting } from '../src/lib/map-appearance';
import { BUILDING_FACADE_COLOR, BUILDING_ROOF_COLOR } from '../src/lib/building-materials';
import { getLightingState, type LightingState } from '../src/lib/solar';
import { buildingSurfacePattern } from '../src/lib/map-building-surface';

const wallId = 'atlas-building-3d', roofId = 'atlas-building-roofs';
const state = (nightAmount: number, sunElevation = 40 - nightAmount * 60): LightingState => ({ ...getLightingState(12), nightAmount, sunElevation });

test('lighting preserves continuous materials and avoids unused per-feature colour buffers', () => {
  const scene = fixture();
  for (const layer of scene.layers) if (layer.type === 'fill-extrusion') {
    layer.paint = { 'fill-extrusion-pattern': buildingSurfacePattern(layer.id === roofId) };
  }
  for (const night of [0, 1, 0]) applyMapLighting(scene.map, state(night));
  assert.equal(scene.paints.size, 0, 'neither patterns nor their unused pigment buffers are rewritten');
  assert.equal(scene.lights.length, 3, 'the shared scene light still changes');
});

function fixture() {
  const layers: LayerSpecification[] = [
    { id: wallId, type: 'fill-extrusion', source: 'buildings', paint: { 'fill-extrusion-color': BUILDING_FACADE_COLOR } },
    { id: roofId, type: 'fill-extrusion', source: 'buildings', paint: { 'fill-extrusion-color': BUILDING_ROOF_COLOR } },
  ];
  const paints = new Map<string, unknown>(), lights: LightSpecification[] = [];
  const counters = { writes: 0, repaint: 0 };
  const map = {
    getStyle: () => ({ version: 8, sources: {}, layers }),
    getSource: () => undefined,
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    getZoom: () => 16,
    setPaintProperty: (id: string, property: string, value: unknown) => { paints.set(`${id}:${property}`, value); counters.writes++; },
    setLight: (light: LightSpecification) => lights.push(light),
    triggerRepaint: () => counters.repaint++,
    addImage: () => { throw new Error('Lighting must not upload facade textures'); },
    updateImage: () => { throw new Error('Lighting must not regenerate facade textures'); },
  } as unknown as LibreMap;
  const color = (id: string, properties: Record<string, unknown>) => {
    const value = paints.get(`${id}:fill-extrusion-color`);
    const expression = createPropertyExpression(value, `${id}.fill-extrusion-color`, latest['paint_fill-extrusion']['fill-extrusion-color'] as StylePropertySpecification);
    assert.equal(expression.result, 'success', JSON.stringify(expression.value));
    if (expression.result !== 'success') throw new Error('Invalid extrusion color');
    return expression.value.evaluate({ zoom: 16 }, { type: 'Polygon', properties }) as Color;
  };
  return { map, layers, color, paints, lights, counters };
}

test('night keeps source facade hues, roof distinctions and readable dark pigments', () => {
  const scene = fixture();
  applyMapLighting(scene.map, state(1));
  const terracotta = scene.color(wallId, { facade_color: '#b06c48' });
  const sage = scene.color(wallId, { facade_color: '#579478' });
  assert.ok(terracotta.r - sage.r > 0.15, 'source red/green facades must remain distinguishable after sunset');
  assert.ok(sage.g > terracotta.g, 'night tint must preserve the direction of source hue differences');
  const properties = { facade_color: '#d8d3c5', roof_color: '#6c8176' };
  const facade = scene.color(wallId, properties), roof = scene.color(roofId, properties);
  assert.ok(facade.r - roof.r > 0.15, 'walls and roofs must not collapse into a single dark tone');
  for (const id of [wallId, roofId]) {
    const dark = scene.color(id, { facade_color: '#010101', roof_color: '#010101' });
    assert.ok(Math.min(...dark.rgb.slice(0, 3)) > 0.12, 'even source black has a readable scene fill');
  }
});

test('returning from night restores precise daylight colors without accumulating tint', () => {
  const scene = fixture(), properties = { facade_color: '#cb9f71', roof_color: '#49654a' };
  applyMapLighting(scene.map, state(0));
  const dayWall = scene.color(wallId, properties), dayRoof = scene.color(roofId, properties);
  assert.equal(dayWall.toString(), Color.parse(properties.facade_color)!.toString());
  assert.equal(dayRoof.toString(), Color.parse(properties.roof_color)!.toString());
  applyMapLighting(scene.map, state(1));
  assert.notEqual(scene.color(wallId, properties).toString(), dayWall.toString());
  applyMapLighting(scene.map, state(0));
  assert.equal(scene.color(wallId, properties).toString(), dayWall.toString());
  assert.equal(scene.color(roofId, properties).toString(), dayRoof.toString());
});

test('sunset fill remains above roofs, changes continuously and keeps the daylight azimuth', () => {
  let previousPolar = 0;
  for (let sample = 0; sample <= 100; sample++) {
    const scene = fixture(), lighting = state(sample / 100);
    applyMapLighting(scene.map, lighting);
    const position = scene.lights[0].position as [number, number, number];
    assert.ok(position[2] >= 0 && position[2] <= 90, 'scene light must never illuminate from below the map');
    assert.equal(position[1], lighting.sunAzimuth);
    if (sample > 0) assert.ok(Math.abs(position[2] - previousPolar) < 1, 'twilight fill must not jump at the horizon');
    previousPolar = position[2];
  }
  const deepNight = fixture(); applyMapLighting(deepNight.map, state(1, -89));
  assert.ok((deepNight.lights[0].position as number[])[2] <= 60, 'night roofs keep overhead fill even with a deeply negative solar elevation');
});

test('unchanged lighting performs no paint writes or repaint and new roofs receive the current palette', () => {
  const scene = fixture(), lighting = state(1);
  applyMapLighting(scene.map, lighting);
  const previous = { ...scene.counters }, lightCount = scene.lights.length;
  applyMapLighting(scene.map, lighting);
  assert.deepEqual(scene.counters, previous);
  assert.equal(scene.lights.length, lightCount);
  scene.layers.push({ id: 'atlas-building-part-roofs', type: 'fill-extrusion', source: 'buildings', paint: { 'fill-extrusion-color': BUILDING_ROOF_COLOR } });
  applyMapLighting(scene.map, lighting);
  assert.deepEqual(scene.paints.get('atlas-building-part-roofs:fill-extrusion-color'), scene.paints.get(`${roofId}:fill-extrusion-color`));
});
