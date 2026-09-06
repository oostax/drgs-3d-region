import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, createExpression, createPropertyExpression, latest, type StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, Map as LibreMap } from 'maplibre-gl';
import { applyGroundMaterials, groundColor, groundColorExpression, groundPatternImage, isManagedGroundLayer, textureOpacity } from '../src/lib/map-ground-materials';

function evaluate(expression: unknown, properties: Record<string, unknown> = {}, zoom = 17) {
  const compiled = createExpression(expression, 'ground');
  assert.equal(compiled.result, 'success', JSON.stringify(compiled.value));
  if (compiled.result !== 'success') throw new Error('Ground expression invalid');
  return compiled.value.evaluate({ zoom }, { type: 'Polygon', properties });
}

function fixture() {
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background' },
    { id: 'atlas-russia-ground', type: 'fill', source: 'atlas-russia', paint: { 'fill-color': '#fff' } },
    { id: 'park', type: 'fill', source: 'openmaptiles', 'source-layer': 'park' },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': '#789aaa' } },
    { id: 'landuse_residential', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse', maxzoom: 16 },
    { id: 'landcover_wood', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover' },
    { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
    { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building' },
  ];
  const images = new Map<string, unknown>(), writes: { id: string; property: string; value: unknown }[] = [];
  const getLayer = (id: string) => layers.find((layer) => layer.id === id);
  const map = {
    getSource: (id: string) => ['openmaptiles', 'atlas-russia'].includes(id) ? {} : undefined,
    getLayer, hasImage: (id: string) => images.has(id),
    addImage: (id: string, image: unknown) => images.set(id, image),
    addLayer: (layer: LayerSpecification, before?: string) => layers.splice(before ? layers.findIndex((candidate) => candidate.id === before) : layers.length, 0, layer),
    setLayoutProperty: (id: string, property: string, value: unknown) => { const layer = getLayer(id) as { layout?: Record<string, unknown> }; layer.layout ??= {}; layer.layout[property] = value; },
    setPaintProperty: (id: string, property: string, value: unknown) => { writes.push({ id, property, value }); const layer = getLayer(id) as { paint?: Record<string, unknown> }; layer.paint ??= {}; layer.paint[property] = value; },
  } as unknown as LibreMap;
  return { map, layers, images, writes, getLayer };
}

test('source landcover determines natural colors and an unknown area stays mineral', () => {
  const colors = new Set<string>();
  for (const kind of ['wood', 'grass', 'farmland', 'wetland', 'sand', 'rock', 'ice']) {
    const color = String(evaluate(groundColorExpression('landcover', 0), { class: kind })); colors.add(color);
    const compiled = createPropertyExpression(groundColorExpression('landcover', 1), 'fill-color', latest.paint_fill['fill-color'] as StylePropertySpecification);
    assert.equal(compiled.result, 'success');
    if (compiled.result === 'success') {
      const night = compiled.value.evaluate({ zoom: 17 }, { type: 'Polygon', properties: { class: kind } }) as Color;
      assert.ok(Math.max(...night.rgb.slice(0, 3)) < 0.4, `${kind} must not glow at night`);
    }
  }
  assert.equal(colors.size, 7);
  assert.equal(evaluate(groundColorExpression('landcover', 0), { class: 'unknown' }), groundColor('neutral', 0));
  const grass = Color.parse(String(evaluate(groundColorExpression('landcover', 0), { class: 'grass' })))!;
  assert.ok(grass.g - grass.r > 0.08 && grass.g - grass.b > 0.2, 'grass must read as green instead of white-grey');
});

test('real source polygons receive materials at every close zoom without styling roads or untyped features', () => {
  const scene = fixture(); applyGroundMaterials(scene.map, scene.layers, 0);
  const landuse = scene.getLayer('atlas-ground-landuse')!;
  assert.equal('maxzoom' in landuse ? landuse.maxzoom : undefined, undefined, 'residential surface must survive z16');
  assert.equal('filter' in landuse && evaluate(landuse.filter, { class: 'school' }), true);
  for (const kind of ['', 'unknown', 'stadium', 'track', 'pitch', 'railway']) assert.equal('filter' in landuse && evaluate(landuse.filter, { class: kind }), false, `${kind} belongs to no ground-use guess`);
  const protectedArea = scene.getLayer('atlas-ground-park')!;
  assert.equal(protectedArea.type === 'fill' && protectedArea.paint?.['fill-opacity'], 0.25, 'protected-area boundaries do not prove tree cover');
  assert.equal(scene.getLayer('atlas-ground-park-grain'), undefined);
  assert.equal(isManagedGroundLayer(scene.getLayer('road')!), false);
  assert.equal(isManagedGroundLayer(scene.getLayer('building')!), false);
  assert.equal(isManagedGroundLayer(scene.getLayer('water')!), false);
});

test('ground layers stay below water, roads and buildings; sparse old fills no longer erase their pigments', () => {
  const scene = fixture(); applyGroundMaterials(scene.map, scene.layers, 0);
  const firstDetail = scene.layers.findIndex((layer) => layer.id === 'water');
  for (const layer of scene.layers.filter((layer) => layer.id.startsWith('atlas-ground-'))) assert.ok(scene.layers.indexOf(layer) < firstDetail);
  for (const id of ['landuse_residential', 'landcover_wood', 'park']) assert.ok(scene.writes.some((write) => write.id === id && write.property === 'fill-opacity' && write.value === 0));
  assert.equal(scene.writes.some((write) => ['water', 'road', 'building'].includes(write.id)), false);
  for (const layer of scene.layers) if (layer.type === 'fill' && layer.id.startsWith('atlas-ground-')) {
    for (const [property, value] of Object.entries(layer.paint ?? {})) {
      const compiled = createPropertyExpression(value, property, latest.paint_fill[property as keyof typeof latest.paint_fill] as StylePropertySpecification);
      assert.equal(compiled.result, 'success', `${layer.id} ${property}: ${JSON.stringify(compiled.value)}`);
    }
  }
});

test('three shared opaque pigments have seamless variation and cannot darken overlapping areas to black', () => {
  for (const kind of ['vegetation', 'mineral', 'soil'] as const) {
    const image = groundPatternImage(kind); assert.equal(image, groundPatternImage(kind));
    assert.equal(image.width, 128); assert.equal(image.height, 128); assert.equal(image.data.byteLength, 65536);
    let min = 255, max = 0;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const offset = (y * 128 + x) * 4, alpha = image.data[offset + 3];
      assert.equal(alpha, 255, 'the bitmap has no dark alpha-mask path');
      for (let channel = 0; channel < 3; channel++) assert.ok(image.data[offset + channel] > 80 && image.data[offset + channel] < 215, 'overlap converges to a natural pigment, never black');
      min = Math.min(min, image.data[offset]); max = Math.max(max, image.data[offset]);
      if (x === 0) assert.ok(Math.abs(image.data[offset] - image.data[(y * 128 + 127) * 4]) < 12, 'seam must not introduce a visible boundary');
    }
    assert.ok(max - min > 20, 'surface must have visible broad material variation');
  }
  assert.equal(evaluate(textureOpacity(0, 0.6), {}, 8), 0);
  assert.equal(evaluate(textureOpacity(1, 0.6), {}, 17), 0, 'daytime texture pigment cannot brighten a night surface');
});

test('time changes never regenerate textures and identical lighting makes no style writes', () => {
  const scene = fixture(); assert.equal(applyGroundMaterials(scene.map, scene.layers, 0), true);
  assert.equal(scene.images.size, 3); const originalImages = [...scene.images.values()], count = scene.writes.length;
  assert.equal(applyGroundMaterials(scene.map, scene.layers, 0), false); assert.equal(scene.writes.length, count);
  assert.equal(applyGroundMaterials(scene.map, scene.layers, 1), true); assert.deepEqual([...scene.images.values()], originalImages);
  const nightCount = scene.writes.length; assert.equal(applyGroundMaterials(scene.map, scene.layers, 0.999), false); assert.equal(scene.writes.length, nightCount);
  const idx = scene.layers.findIndex((layer) => layer.id === 'atlas-ground-landuse'); scene.layers[idx] = { ...scene.layers[idx] };
  assert.equal(applyGroundMaterials(scene.map, scene.layers, 1), true, 'a replacement style layer receives current lighting');
});

test('daylight restores green pigments and texture uses ordinary fill opacity without the terrain FBO path', () => {
  const scene = fixture(); applyGroundMaterials(scene.map, scene.layers, 1); applyGroundMaterials(scene.map, scene.layers, 0);
  const cover = scene.getLayer('atlas-ground-landcover');
  assert.equal(cover?.type === 'fill' && evaluate(cover.paint?.['fill-color'], { class: 'grass' }), groundColor('grass', 0));
  const grain = scene.getLayer('atlas-ground-landcover-grain');
  assert.equal(grain?.type === 'fill' && evaluate(grain.paint?.['fill-opacity'], {}, 17), 0.42);
  assert.equal(grain?.type === 'fill' && grain.paint?.['fill-layer-opacity'], 1, 'the renderer must never allocate a layer-opacity scratch framebuffer');
  applyGroundMaterials(scene.map, scene.layers, 1);
  assert.equal(grain?.type === 'fill' && evaluate(grain.paint?.['fill-opacity'], {}, 17), 0);
});
