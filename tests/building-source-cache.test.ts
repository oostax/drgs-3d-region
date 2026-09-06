import test from 'node:test';
import assert from 'node:assert/strict';
import type { Feature, Polygon } from 'geojson';
import { BuildingDetailsLayer } from '../src/lib/map-building-details';
import { getLightingState } from '../src/lib/solar';

function building(id: string, longitude: number): Feature<Polygon> {
  return {
    type: 'Feature', properties: { id, class: 'apartments', height: 12 },
    geometry: { type: 'Polygon', coordinates: [[
      [longitude, 55.79], [longitude + 0.0003, 55.79],
      [longitude + 0.0003, 55.7901], [longitude, 55.7901], [longitude, 55.79],
    ]] },
  };
}

test('returning to a cached source tile restores its building details without a new source-data event', () => {
  const a = building('district-a', 49.12), b = building('district-b', 49.15);
  let features = [a], longitude = 49.12, queries = 0;
  const layer = new BuildingDetailsLayer({ enabled: () => true, lighting: () => getLightingState(12), mobile: false });
  const state = layer as unknown as {
    map: unknown; rebuild: () => void; changed: () => void;
    sourceChanged: (event: { sourceId: string; sourceDataType: string }) => void;
    entries: { id: string }[];
  };
  state.map = {
    getSource: () => ({}),
    querySourceFeatures: (_source: string, options: { sourceLayer: string }) => {
      queries++;
      return options.sourceLayer === 'building' ? features : [];
    },
    getCenter: () => ({ lng: longitude, lat: 55.79 }), getZoom: () => 16,
    getCanvas: () => ({ clientWidth: 1200, clientHeight: 800 }),
    project: () => ({ x: 600, y: 400 }), getTerrain: () => null,
    triggerRepaint() {}, off() {},
  };
  try {
    state.rebuild();
    assert.deepEqual(state.entries.map(entry => entry.id), ['district-a']);

    features = [b]; longitude = 49.15;
    state.sourceChanged({ sourceId: 'atlas-buildings', sourceDataType: 'content' });
    state.rebuild();
    assert.deepEqual(state.entries.map(entry => entry.id), ['district-b']);
    const queriesBeforeReturn = queries;

    // MapLibre reuses this tile from its out-of-view cache without emitting sourcedata.
    features = [a]; longitude = 49.12;
    state.changed();
    state.rebuild();
    assert.deepEqual(state.entries.map(entry => entry.id), ['district-a']);
    assert.ok(queries > queriesBeforeReturn, 'the completed camera move refreshes source coverage');
    assert.equal(layer.getDiagnostics().cacheHits, 1, 'returning to a tile still reuses its geometry');

    const queriesAfterReturn = queries;
    state.rebuild();
    assert.equal(queries, queriesAfterReturn, 'unchanged camera rebuilds keep using source candidates');
  } finally {
    layer.onRemove();
  }
});
