import test from 'node:test';
import assert from 'node:assert/strict';
import type { CustomLayerInterface, Map } from 'maplibre-gl';
import { recreateMapGpuLayers, type MapGpuLayers } from '../src/lib/map-gpu-layers';

type ResourceLayer = CustomLayerInterface & { generation: number; disposed: boolean; abort: AbortController };
const names = { solar: 'atlas-solar-light', landmarks: 'atlas-landmarks', details: 'atlas-building-details', life: 'atlas-life', scenes: 'atlas-signal-scenes' };
function harness() {
  let generation = 0, current: Record<keyof MapGpuLayers, ResourceLayer> | null = null;
  const vector = [{ id: 'atlas-building-3d', type: 'fill-extrusion' }, { id: 'atlas-building-roofs', type: 'fill-extrusion' }, { id: 'city-label', type: 'symbol' }];
  let layers: { id: string; type: string; resource?: ResourceLayer }[] = [...vector];
  const map = {
    getLayer: (id: string) => layers.find(layer => layer.id === id), getStyle: () => ({ layers }),
    removeLayer: (id: string) => { const layer = layers.find(layer => layer.id === id); layer?.resource?.onRemove?.({} as Map, {} as WebGL2RenderingContext); layers = layers.filter(layer => layer.id !== id); },
    addLayer: (resource: ResourceLayer, before?: string) => {
      assert.ok(!resource.disposed && !resource.abort.signal.aborted, 'GPU resources and fetch controller are live');
      const entry = { id: resource.id, type: resource.type, resource }, index = before ? layers.findIndex(layer => layer.id === before) : -1;
      if (index < 0) layers.push(entry); else layers.splice(index, 0, entry);
    },
  } as unknown as Pick<Map, 'getLayer' | 'removeLayer' | 'getStyle' | 'addLayer'>;
  const create = () => {
    generation++;
    current = Object.fromEntries(Object.entries(names).map(([key, id]) => {
      const layer: ResourceLayer = { id, type: 'custom', generation, disposed: false, abort: new AbortController(), render() {}, onRemove() { layer.disposed = true; layer.abort.abort(); } };
      return [key, layer];
    })) as Record<keyof MapGpuLayers, ResourceLayer>;
    return current;
  };
  return {
    map, create, current: () => current, layers: () => layers,
    loseContext: () => { for (const layer of layers) layer.resource?.onRemove?.({} as Map, {} as WebGL2RenderingContext); layers = layers.filter(layer => !layer.resource); },
  };
}

test('context restoration recreates every custom resource and reference while retaining vector layers', () => {
  const { map, create, current, layers, loseContext } = harness();
  const first = recreateMapGpuLayers(map, create), base = layers().filter(layer => layer.type !== 'custom');
  loseContext();
  assert.ok(Object.values(first).every(layer => layer.disposed && layer.abort.signal.aborted));
  const second = recreateMapGpuLayers(map, create);
  assert.equal(current(), second, 'callbacks and interaction refs receive the newly created layers');
  for (const key of Object.keys(names) as (keyof MapGpuLayers)[]) {
    assert.notEqual(second[key], first[key]); assert.equal(second[key].generation, 2);
    assert.ok(!second[key].disposed && !second[key].abort.signal.aborted);
  }
  assert.deepEqual(layers().filter(layer => layer.type !== 'custom'), base, 'serialized sources and vector layers are not re-created or duplicated');
});

test('custom 3D layers stay after architecture and before labels', () => {
  const { map, create, layers } = harness();
  const first = recreateMapGpuLayers(map, create);
  for (let round = 0; round < 2; round++) {
    const order = layers().map(layer => layer.id), index = (id: string) => order.indexOf(id);
    assert.ok(index('atlas-signal-scenes') > index('atlas-building-3d'));
    assert.ok(index('atlas-building-roofs') < index('atlas-solar-light'));
    assert.ok(index('atlas-solar-light') < index('atlas-landmarks'));
    assert.ok(index('atlas-landmarks') < index('atlas-building-details'));
    assert.ok(index('atlas-building-details') < index('atlas-life'), 'cloud alpha must be composited after roof depth exists');
    assert.ok(index('atlas-life') < index('city-label'));
    assert.ok(index('atlas-life') < index('atlas-signal-scenes'));
    assert.ok(index('atlas-signal-scenes') < index('city-label'));
    assert.equal(new Set(order).size, order.length, 'no duplicated GPU layers');
    if (round === 0) recreateMapGpuLayers(map, create);
  }
  assert.ok(Object.values(first).every(layer => layer.disposed));
});
