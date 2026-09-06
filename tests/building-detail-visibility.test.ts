import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Feature, Geometry, Polygon } from 'geojson';
import { BuildingDetailsLayer } from '../src/lib/map-building-details';
import { getLightingState } from '../src/lib/solar';

const origin = MercatorCoordinate.fromLngLat([49.12, 55.79]), unit = origin.meterInMercatorCoordinateUnits();
const point = (x: number, y: number): [number, number] => {
  const coordinate = new MercatorCoordinate(origin.x + x * unit, origin.y - y * unit).toLngLat();
  return [coordinate.lng, coordinate.lat];
};
function rectangle(id: string, x = 0, properties: Record<string, unknown> = {}): Feature<Polygon> {
  return { type: 'Feature', properties: { id, class: 'apartments', height: 12, ...properties }, geometry: { type: 'Polygon', coordinates: [[point(x, 0), point(x + 20, 0), point(x + 20, 12), point(x, 12), point(x, 0)]] } };
}
type LayerState = {
  map: unknown; rebuild: () => void; light: (state: ReturnType<typeof getLightingState>) => void;
  entries: { id: string }[]; content: THREE.Group; textures: Map<string, { diffuse: THREE.Texture; emissive: THREE.Texture }>;
  dirty: boolean; sourceChanged: (event: { sourceId: string; sourceDataType?: string; isSourceLoaded?: boolean }) => void;
  sourceDirty: boolean; rebuildSteps: () => Generator<void,void,unknown>;
  moving: () => void; changed: () => void;
};
function setup(features: Feature<Geometry>[], mobile = false) {
  const layer = new BuildingDetailsLayer({ enabled: () => true, lighting: () => getLightingState(12), mobile });
  const state = layer as unknown as LayerState;
  let repaints = 0, sourceQueries = 0, screenY = 400, center = { lng: 49.12, lat: 55.79 };
  state.map = {
    getSource: () => ({}), querySourceFeatures: (_: string, { sourceLayer }: { sourceLayer: string }) => { sourceQueries++; return sourceLayer === 'building' ? features : []; },
    getCenter: () => center, getZoom: () => 16, getCanvas: () => ({ clientWidth: 1200, clientHeight: 800 }),
    project: () => ({ x: 600, y: screenY }), getTerrain: () => null, triggerRepaint: () => { repaints++; }, off: () => {},
  };
  return { layer, state, repaints: () => repaints, sourceQueries: () => sourceQueries, projectAtY: (y: number) => { screenY = y; }, moveCenter: (lng: number, lat: number) => { center = { lng, lat }; } };
}

test('tile-split buildings keep both footprints without duplicating buffered copies or culling whole batches', () => {
  const left = rectangle('across-tile'), right = rectangle('across-tile', 20);
  const { layer, state } = setup([left, structuredClone(left), right, structuredClone(right)]);
  state.rebuild();
  assert.deepEqual(state.entries.map(entry => entry.id), ['across-tile']);
  const walls = (state.content.children[0] as THREE.Mesh).geometry;
  assert.equal(walls.drawRange.count, 2 * 4 * 6, 'both unique tile fragments have walls');
  const roof = (state.content.children[1] as THREE.Mesh).geometry.getAttribute('position');
  let area = 0;
  for (let i = 0; i < roof.count; i += 3) area += new THREE.Triangle(new THREE.Vector3().fromBufferAttribute(roof, i), new THREE.Vector3().fromBufferAttribute(roof, i + 1), new THREE.Vector3().fromBufferAttribute(roof, i + 2)).getArea();
  assert.ok(Math.abs(area - 480) < 0.1, 'roof coverage remains complete across the tile boundary');
  assert.ok(state.content.children.every(child => child.frustumCulled === false), 'the map viewport, not a merged Three bounding sphere, controls coverage');
  layer.onRemove();
});

test('a tile arriving during yielded source preparation is picked up by the next pass', () => {
  const features=Array.from({length:130},(_,i)=>rectangle(`before-${i}`,i*24));
  const {layer,state}=setup(features), pass=state.rebuildSteps();
  assert.equal(pass.next().done,false);
  features.push(rectangle('late-tile',0));
  state.sourceChanged({sourceId:'atlas-buildings',sourceDataType:'content',isSourceLoaded:false});
  while(!pass.next().done){ /* finish the snapshot taken before the late tile */ }
  assert.equal(state.sourceDirty,true,'completion must not swallow a newer source revision');
  state.rebuild();assert.ok(state.entries.some(entry=>entry.id==='late-tile'));
  layer.onRemove();
});

test('partially loaded source tiles and continuous camera moves refresh within a bounded interval', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { layer, state, repaints } = setup([rectangle('visible')]);
  state.rebuild();
  state.sourceChanged({ sourceId: 'atlas-buildings', sourceDataType: 'content', isSourceLoaded: false });
  for (let i = 0; i < 30; i++) state.moving();
  assert.equal(state.dirty, false, 'move events coalesce instead of rebuilding each frame');
  assert.equal(repaints(), 0);
  context.mock.timers.tick(250);
  assert.equal(state.dirty, true, 'a loaded tile does not wait for every horizon tile to finish');
  assert.equal(repaints(), 1, 'one pending repaint handles all events');
  state.rebuild(); state.moving(); state.changed();
  assert.equal(repaints(), 2, 'the final camera position refreshes immediately');
  state.rebuild(); state.moving(); layer.onRemove(); context.mock.timers.tick(500);
  assert.equal(repaints(), 2, 'removal cancels deferred refreshes');
});

test('a tall facade remains eligible when its ground footprint is below the viewport', () => {
  const { layer, state, projectAtY } = setup([rectangle('tower', 0, { height: 120 }), rectangle('low', 30, { height: 3 })]);
  projectAtY(1060); state.rebuild();
  assert.deepEqual(state.entries.map(entry => entry.id), ['tower']);
  layer.onRemove();
});

test('camera rebuilds reuse facade textures and malformed source rings cannot disable the layer', () => {
  const malformed: Feature<Polygon> = { type: 'Feature', properties: { id: 'broken' }, geometry: { type: 'Polygon', coordinates: [[]] } };
  const { layer, state } = setup([rectangle('normal'), malformed]);
  state.rebuild(); state.light(getLightingState(12));
  const textures = [...state.textures.values()].map(entry => entry.diffuse);
  const material=(state.content.children[0] as THREE.Mesh).material;
  assert.ok(textures.length > 0);
  let disposed = 0; textures.forEach(texture => texture.addEventListener('dispose', () => { disposed++; }));
  state.rebuild(); state.light(getLightingState(12));
  assert.deepEqual(state.entries.map(entry => entry.id), ['normal']);
  assert.deepEqual([...state.textures.values()].map(entry => entry.diffuse), textures);
  assert.equal(disposed, 0, 'panning does not regenerate or upload the same atlas');
  assert.equal((state.content.children[0] as THREE.Mesh).material,material,'camera changes reuse the compiled material');
  layer.onRemove(); assert.equal(disposed, textures.length, 'GPU textures are released on removal');
});

test('complex source footprints respect a geometry budget as well as a building count', () => {
  const features: Feature<Polygon>[] = Array.from({ length: 200 }, (_, index) => {
    const ring = Array.from({ length: 180 }, (_, vertex) => point(20 * Math.cos(vertex / 180 * Math.PI * 2), 20 * Math.sin(vertex / 180 * Math.PI * 2)));
    return { type: 'Feature', properties: { id: `complex-${index}`, class: 'apartments' }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } };
  });
  const { layer, state } = setup(features, true); state.rebuild();
  const vertices = state.content.children.reduce((sum, child) => sum + Math.min((child as THREE.Mesh).geometry.drawRange.count, (child as THREE.Mesh).geometry.getAttribute('position').count), 0);
  assert.ok(state.entries.length > 0 && state.entries.length < features.length, 'complex features cannot bypass the mobile geometry budget');
  assert.ok(vertices < 180_000, `mobile mesh upload stays bounded (${vertices} vertices)`);
  layer.onRemove();
});

test('camera navigation reuses triangulated geometry while changed source dimensions and regions invalidate it', context => {
  const features = Array.from({ length: 200 }, (_, index) => rectangle(`house-${index}`, index * 24));
  const { layer, state, moveCenter, sourceQueries } = setup(features);
  state.rebuild(); const cold = layer.getDiagnostics(), initialQueries = sourceQueries();
  const wallGeometry = (state.content.children[0] as THREE.Mesh).geometry;
  moveCenter(49.121, 55.79); state.rebuild(); const warm = layer.getDiagnostics();
  assert.equal(warm.cacheHits, features.length, 'local camera movement performs no repeated triangulation');
  assert.equal(warm.vertices, cold.vertices); assert.equal(warm.geometryCacheEntries, features.length);
  assert.equal(warm.rebuilds, 2);
  assert.equal(sourceQueries(), initialQueries, 'camera-only moves project cached source bounds without another tile query');
  assert.equal((state.content.children[0] as THREE.Mesh).geometry.uuid, wallGeometry.uuid, 'unchanged selection and LOD retain the merged GPU geometry');
  features[0].properties!.height = 50;
  state.sourceChanged({ sourceId: 'atlas-buildings', sourceDataType: 'content', isSourceLoaded: true }); state.rebuild();
  assert.equal(layer.getDiagnostics().cacheHits, features.length - 1, 'updated source geometry dimensions replace only the affected cache entry');
  assert.ok(sourceQueries() > initialQueries, 'new tile content invalidates source candidates');
  moveCenter(37.62, 55.75); state.rebuild();
  assert.equal(layer.getDiagnostics().cacheHits, 0, 'another region rebases all metre coordinates');
  context.diagnostic(`200 distinct footprints, CPU build only: initial ${cold.buildMs.toFixed(1)} ms; warm ${warm.buildMs.toFixed(1)} ms`);
  layer.onRemove(); assert.equal(layer.getDiagnostics().geometryCacheEntries, 0);
});
