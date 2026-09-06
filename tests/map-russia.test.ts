import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { LngLat, type LayerSpecification, type Map as LibreMap, type TransformConstrainFunction } from 'maplibre-gl';
import { addRussiaMask, configureRussiaMap, constrainRussiaViewport, RUSSIA_MASK_LAYER, RUSSIA_MASK_SOURCE } from '../src/lib/map-russia';

const sourceBytes = readFileSync(new URL('../public/data/russia-regions.geojson', import.meta.url));
const regions = JSON.parse(sourceBytes.toString()) as FeatureCollection<Polygon | MultiPolygon>;
const mask = JSON.parse(readFileSync(new URL('../public/data/russia-mask.geojson', import.meta.url), 'utf8')) as FeatureCollection<Polygon> & { sourceSha256: string };

function polygonIndex(collection: FeatureCollection<Polygon | MultiPolygon>) {
  return collection.features.flatMap(({ geometry }) => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).map((rings) => {
    const xs = rings[0].map((position) => position[0]);
    const ys = rings[0].map((position) => position[1]);
    return { rings, west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) };
  });
}

const regionIndex = polygonIndex(regions);
const maskIndex = polygonIndex(mask);

function inRing([x, y]: Position, ring: Position[]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

function contains(index: ReturnType<typeof polygonIndex>, point: Position) {
  return index.some(({ west, east, south, north, rings }) => point[0] >= west && point[0] <= east && point[1] >= south && point[1] <= north && inRing(point, rings[0]) && !rings.slice(1).some((ring) => inRing(point, ring)));
}

test('inverse mask is generated from the exact existing regional dataset', () => {
  assert.equal(mask.sourceSha256, createHash('sha256').update(sourceBytes).digest('hex'));
  // Verify complements throughout the country and its neighbours, not only cities.
  for (let longitude = -178.137; longitude < 180; longitude += 7.3) {
    for (let latitude = 39.139; latitude < 84; latitude += 3.7) {
      const point = [longitude, latitude];
      assert.equal(contains(maskIndex, point), !contains(regionIndex, point), `Inverse mismatch at ${point}`);
    }
  }
});

test('Russia, Kaliningrad, Sakhalin and both sides of the antimeridian remain visible', () => {
  const places: [string, number, number][] = [
    ['Moscow', 37.6176, 55.7558],
    ['Kazan', 49.12, 55.79],
    ['Kaliningrad', 20.51, 54.71],
    ['Yakutsk', 129.731, 62.027],
    ['Yuzhno-Sakhalinsk', 142.74, 46.96],
    ['Wrangel Island', -179.5, 71.2],
    ['Chukotka west', 176, 66.5],
    ['Chukotka east', -173, 66],
  ];
  for (const [name, longitude, latitude] of places) {
    assert.equal(contains(regionIndex, [longitude, latitude]), true, `${name} belongs to the source dataset`);
    assert.equal(contains(maskIndex, [longitude, latitude]), false, `${name} must not be covered`);
  }
});

test('neighbouring countries and distant map copies have no visible basemap', () => {
  const places: [string, number, number][] = [
    ['Helsinki', 24.9384, 60.1699], ['Tallinn', 24.7536, 59.437],
    ['Minsk', 27.5615, 53.9045], ['Beijing', 116.4074, 39.9042],
    ['Ulaanbaatar', 106.9, 47.918], ['Astana', 71.4, 51.16],
    ['Oslo', 10.75, 59.9], ['Anchorage', -149.9, 61.2],
    ['Pacific Ocean', -160, 55], ['Atlantic Ocean', -20, 40.5],
  ];
  for (const [name, longitude, latitude] of places) {
    assert.equal(contains(maskIndex, [longitude, latitude]), true, `${name} must be covered`);
  }
});

test('mask cells preserve islands without exceeding MapLibre ring limits or crossing the world seam', () => {
  for (const { geometry } of mask.features) {
    assert.ok(geometry.coordinates.length <= 161, 'Avoid MapLibre dropping excess island holes');
    for (const ring of geometry.coordinates) {
      assert.deepEqual(ring[0], ring.at(-1));
      for (let index = 1; index < ring.length; index++) assert.ok(Math.abs(ring[index][0] - ring[index - 1][0]) < 180);
    }
  }
});

test('a 390 by 844 portrait overview keeps zoom 0.35 and its Russian latitude', () => {
  let constrain: TransformConstrainFunction | undefined;
  const container = { clientWidth: 390, clientHeight: 844 };
  const map = {
    setRenderWorldCopies: () => {}, setMinZoom: () => {}, setMaxZoom: () => {}, setMaxBounds: () => {},
    getContainer: () => container,
    setTransformConstrain: (callback: TransformConstrainFunction) => { constrain = callback; },
  } as unknown as LibreMap;
  configureRussiaMap(map);
  assert.ok(constrain);
  const portrait = constrain(new LngLat(104.5, 68), 0.35);
  assert.equal(portrait.zoom, 0.35, 'The viewport height must not force an enlarged country');
  assert.deepEqual(portrait.center.toArray(), [104.5, 68], 'The center must not drift towards the equator');
  container.clientHeight = 390;
  assert.deepEqual(constrain(new LngLat(104.5, 68), 0.35), portrait);
  container.clientWidth = 1400;
  const desktop = constrain(new LngLat(104.5, 68), 0.35);
  assert.ok(1400 * 360 / (512 * 2 ** desktop.zoom) <= 220.000001, 'Wide screens cannot reveal repeated worlds');
});

test('camera constraints preserve wrapped Chukotka and keep navigation centered on Russia', () => {
  assert.deepEqual(constrainRussiaViewport(new LngLat(-173, 66), 6, 390).center.toArray(), [187, 66]);
  assert.deepEqual(constrainRussiaViewport(new LngLat(0, 0), 6, 390).center.toArray(), [15, 39]);
  assert.deepEqual(constrainRussiaViewport(new LngLat(220, 89), 30, 390), { center: new LngLat(192, 83), zoom: 20 });
});

test('mask covers base labels while analytic symbols stay above it, and repeated setup is harmless', () => {
  const layers: LayerSpecification[] = [
    { id: 'water', type: 'fill', source: 'base' },
    { id: 'atlas-selected-fill', type: 'fill', source: 'regions' },
    { id: 'atlas-solar-light', type: 'fill', source: 'light' },
    { id: 'label_city', type: 'symbol', source: 'base' },
    { id: 'label_country_1', type: 'symbol', source: 'base' },
    { id: 'atlas-russia-labels', type: 'symbol', source: 'regions' },
    { id: 'atlas-poi-label', type: 'symbol', source: 'points' },
  ];
  const sources = new Map();
  const hidden: string[] = [];
  let worldCopies: boolean | undefined;
  let minZoom: number | undefined;
  let bounds: unknown;
  const map = {
    getStyle: () => ({ layers }),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, source: unknown) => sources.set(id, source),
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    addLayer: (layer: LayerSpecification, before?: string) => {
      const index = layers.findIndex((candidate) => candidate.id === before);
      if (index === -1) layers.push(layer); else layers.splice(index, 0, layer);
    },
    setLayoutProperty: (id: string, property: string, value: string) => {
      if (property === 'visibility' && value === 'none') hidden.push(id);
    },
    setRenderWorldCopies: (value: boolean) => { worldCopies = value; },
    setMinZoom: (value: number) => { minZoom = value; },
    setMaxZoom: () => {},
    setTransformConstrain: () => {},
    setMaxBounds: (value: unknown) => { bounds = value; },
  } as unknown as LibreMap;
  configureRussiaMap(map);
  addRussiaMask(map);
  addRussiaMask(map);
  assert.equal(worldCopies, true, 'The +180° Chukotka continuation stays available');
  assert.equal(minZoom, 0.25, 'Portrait screens may zoom out enough for the complete country');
  assert.equal(bounds, null, 'Default bounds cannot overrule the portrait overview');
  assert.equal(sources.size, 1);
  assert.ok(sources.has(RUSSIA_MASK_SOURCE));
  assert.equal(layers.filter((layer) => layer.id === RUSSIA_MASK_LAYER).length, 1);
  const maskPosition = layers.findIndex((layer) => layer.id === RUSSIA_MASK_LAYER);
  assert.ok(maskPosition > layers.findIndex((layer) => layer.id === 'label_country_1'));
  assert.ok(maskPosition < layers.findIndex((layer) => layer.id === 'atlas-russia-labels'));
  assert.ok(hidden.includes('label_country_1'));
  assert.ok(!hidden.includes('label_city'));
});
