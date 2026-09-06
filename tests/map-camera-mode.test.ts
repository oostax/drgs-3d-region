import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAP_3D, naturalMapPitch, nextMapMode, applyMapViewMode } from '../src/lib/map-camera-mode';
import type { Map as LibreMap } from 'maplibre-gl';

const ids = ['atlas-building-flat', 'atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs'];
function fixture() {
  const layers = new Map(ids.map(id => [id, {}]));
  const visibility = new Map<string, unknown>(), paints = new Map<string, unknown>();
  let maxPitch = 75, touch = true;
  const map = {
    getLayer: (id: string) => layers.get(id),
    getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: (id: string, _: string, value: unknown) => visibility.set(id, value),
    setPaintProperty: (id: string, property: string, value: unknown) => paints.set(`${id}:${property}`, value),
    getMaxPitch: () => maxPitch,
    setMaxPitch: (value: number) => { maxPitch = value; },
    touchPitch: { isEnabled: () => touch, enable: () => { touch = true; }, disable: () => { touch = false; } },
  } as unknown as LibreMap;
  return { map, visibility, paints, layers, snapshot: () => ({ visible: [...visibility], maxPitch, touch }) };
}
const options = { buildings: true, bankFocus: false, maxPitch: 75 };

test('first launch is unambiguously 2D and each click alternates the selected mode', () => {
  assert.equal(DEFAULT_MAP_3D, false);
  for (const zoom of [2, 6.35, 11.5, 14, 20]) {
    const first = nextMapMode(DEFAULT_MAP_3D, zoom);
    assert.deepEqual(first, { next3D: true, pitch: naturalMapPitch(zoom) });
    const second = nextMapMode(first.next3D, zoom);
    assert.deepEqual(second, { next3D: false, pitch: 0 });
    assert.deepEqual(nextMapMode(second.next3D, zoom), first);
  }
});

test('a top-down 3D overview is still 3D: it cannot trap the toggle', () => {
  assert.equal(naturalMapPitch(6.35), 0);
  assert.deepEqual(nextMapMode(true, 6.35), { next3D: false, pitch: 0 });
  assert.deepEqual(nextMapMode(true, 14), { next3D: false, pitch: 0 });
});

test('first 2D and repeated returns to 2D have identical layers and gesture constraints', () => {
  const scene = fixture(); applyMapViewMode(scene.map, DEFAULT_MAP_3D, options);
  const initial = scene.snapshot();
  assert.equal(scene.visibility.get('atlas-building-flat'), 'visible');
  assert.ok(ids.slice(1).every(id => scene.visibility.get(id) === 'none'));
  assert.equal(initial.maxPitch, 0); assert.equal(initial.touch, false);
  for (let cycle = 0; cycle < 5; cycle++) {
    applyMapViewMode(scene.map, true, options);
    assert.equal(scene.visibility.get('atlas-building-flat'), 'none');
    assert.ok(ids.slice(1).every(id => scene.visibility.get(id) === 'visible'));
    assert.equal(scene.snapshot().maxPitch, 75); assert.equal(scene.snapshot().touch, true);
    applyMapViewMode(scene.map, false, options);
    assert.deepEqual(scene.snapshot(), initial);
  }
  assert.ok([...scene.paints.keys()].every(key => !key.includes('pattern')), 'mode changes never mutate material textures');
});

test('resize, restored layers, bank focus and building visibility preserve the selected mode', () => {
  const scene = fixture();
  applyMapViewMode(scene.map, true, { ...options, maxPitch: 60 });
  assert.equal(scene.snapshot().maxPitch, 60);
  applyMapViewMode(scene.map, true, options);
  assert.equal(scene.snapshot().maxPitch, 75);
  scene.visibility.clear();
  applyMapViewMode(scene.map, false, { ...options, bankFocus: true });
  assert.equal(scene.visibility.get('atlas-building-flat'), 'visible');
  assert.equal(scene.paints.get('atlas-building-flat:fill-opacity'), 0.16);
  for (const is3D of [false, true]) {
    applyMapViewMode(scene.map, is3D, { ...options, buildings: false });
    assert.ok(ids.every(id => scene.visibility.get(id) === 'none'));
  }
});
