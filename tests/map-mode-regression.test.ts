import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mode from '../src/lib/map-camera-mode';

function mapHarness() {
  const layers = new Map(['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs', 'atlas-building-flat'].map(id => [id, { id, visibility: 'visible' }]));
  let maxPitch = 75, touchPitch = true, writes = 0;
  const map = {
    getLayer: (id: string) => layers.get(id),
    getLayoutProperty: (id: string) => layers.get(id)?.visibility,
    setLayoutProperty: (id: string, property: string, value: string) => { assert.equal(property, 'visibility'); layers.get(id)!.visibility = value; writes++; },
    getMaxPitch: () => maxPitch,
    setMaxPitch: (value: number) => { maxPitch = value; writes++; },
    touchPitch: { isEnabled: () => touchPitch, enable: () => { touchPitch = true; writes++; }, disable: () => { touchPitch = false; writes++; } },
  };
  return { map: map as unknown as Parameters<typeof mode.applyMapMode>[0], layers, snapshot: () => ({ visibility: [...layers.values()].map(layer => [layer.id, layer.visibility]), maxPitch, touchPitch }), writes: () => writes };
}

test('cold start chooses the same untextured 2D mode as a return from 3D', () => {
  assert.equal(mode.DEFAULT_MAP_3D, false);
  const initial = mapHarness(), switched = mapHarness();
  mode.applyMapMode(initial.map, mode.DEFAULT_MAP_3D, true, false);
  for (const is3D of [false, true, false, true, false]) mode.applyMapMode(switched.map, is3D, true, false);
  assert.deepEqual(switched.snapshot(), initial.snapshot());
  assert.equal(initial.layers.get('atlas-building-flat')!.visibility, 'visible');
  assert.equal(initial.layers.get('atlas-building-roofs')!.visibility, 'none');
  assert.equal(initial.snapshot().maxPitch, 0);
});

test('mode toggling follows the selected mode, never a stale or animated camera pitch', () => {
  for (const zoom of [5.1, 6.35, 11.5, 15, 20]) for (const pitch of [0, 1, 4, 45, 58]) {
    assert.equal(mode.nextMapMode(true, pitch, zoom).next3D, false);
    assert.equal(mode.nextMapMode(false, pitch, zoom).next3D, true);
  }
  let is3D: boolean = mode.DEFAULT_MAP_3D;
  for (let click = 0; click < 8; click++) {
    is3D = mode.nextMapMode(is3D, 0, 6.35).next3D;
    assert.equal(is3D, click % 2 === 0, 'even a top-down overview toggles in one click');
  }
});

test('3D enables textured surfaces and pitch; responsive budgets never change the chosen mode', () => {
  const { map, layers, snapshot, writes } = mapHarness();
  mode.applyMapMode(map, true, true, true);
  for (const [id, layer] of layers) assert.equal(layer.visibility, id.endsWith('-flat') ? 'none' : 'visible');
  assert.equal(snapshot().maxPitch, 60); assert.equal(snapshot().touchPitch, true);
  mode.applyMapMode(map, true, true, false); assert.equal(snapshot().maxPitch, 75);
  const before = writes(); mode.applyMapMode(map, true, true, false);
  assert.equal(writes(), before, 'idempotent refresh does not churn layers or gestures');
  mode.applyMapMode(map, false, true, false);
  assert.equal(snapshot().maxPitch, 0); assert.equal(snapshot().touchPitch, false);
});

test('hidden buildings and style restoration retain the explicit 2D/3D contract', () => {
  for (const is3D of [false, true]) {
    const { map, layers } = mapHarness(); mode.applyMapMode(map, is3D, false);
    assert.ok([...layers.values()].every(layer => layer.visibility === 'none'));
    const restored = mapHarness(); mode.applyMapMode(restored.map, is3D, false);
    assert.deepEqual([...restored.layers], [...layers]);
  }
});

test('the Atlas initial state, mode button and native layer lifecycle use the same mode contract', () => {
  const atlas = readFileSync(new URL('../src/components/Atlas.tsx', import.meta.url), 'utf8');
  const map = readFileSync(new URL('../src/components/AtlasMap.tsx', import.meta.url), 'utf8');
  assert.match(atlas, /\[is3D, set3D\] = useState\(DEFAULT_MAP_3D\)/);
  assert.match(atlas, /aria-pressed=\{is3D\}/);
  assert.doesNotMatch(atlas, /const visible3D=is3D&&/);
  assert.match(map, /applyMapMode\(map, props\.is3D/);
  assert.match(map, /touchPitch: latest\.current\.is3D/);
});
