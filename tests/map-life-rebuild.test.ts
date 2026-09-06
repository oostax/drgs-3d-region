import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MapLifeLayer } from '../src/lib/map-life';
import { getLightingState } from '../src/lib/solar';

type State = { map: unknown; incremental: boolean; content: THREE.Group; pendingBuild: State | null; rebuildCount: number; rebuildSlices: number; rebuildSkipped: boolean; sourceSnapshot: Map<string, unknown>; clearContent: () => void; cancelBuild: () => void };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function idle(state: State) { for (let i = 0; state.pendingBuild && i < 100; i++) await delay(5); assert.equal(state.pendingBuild, null); }

test('staged city rebuild keeps the visible scene until atomic commit, cancels obsolete work and skips identical data', async () => {
  let lng = 49.12, enabled = true;
  const reads = new Map<string, number>();
  const road = { type: 'Feature', id: 'road', properties: { class: 'minor' }, geometry: { type: 'LineString', coordinates: [[49.10, 55.79], [49.14, 55.79]] } };
  const layer = new MapLifeLayer({ enabled: () => enabled, animate: () => false, offices: () => [], banksVisible: () => false, lighting: () => getLightingState(12), mobile: true, reducedMotion: false });
  const state = layer as unknown as State;
  state.map = { getZoom: () => 15.8, getCenter: () => ({ lng, lat: 55.79 }), getTerrain: () => null, getSource: () => ({}), querySourceFeatures: (_source: string, options: { sourceLayer: string }) => { reads.set(options.sourceLayer, (reads.get(options.sourceLayer) ?? 0) + 1); return options.sourceLayer === 'transportation' ? [road] : []; }, triggerRepaint() {} };
  layer.rebuild(); const original = state.content, vehicle = original.children.find(child => child instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
  assert.ok(vehicle); let disposed = 0; vehicle.geometry.addEventListener('dispose', () => disposed++);
  reads.clear(); state.incremental = true; lng += 0.003;
  layer.rebuild(); const obsolete = state.pendingBuild!;
  assert.equal(state.content, original); assert.equal(disposed, 0);
  // Cancel while work is queued; a fixed sleep can outlast a fast complete build.
  lng += 0.003; layer.rebuild();
  assert.notEqual(state.pendingBuild, obsolete); assert.equal(state.content, original); assert.equal(disposed, 0);
  await idle(state);
  assert.notEqual(state.content, original); assert.equal(disposed, 1); assert.equal(state.rebuildCount, 2); assert.ok(state.rebuildSlices >= 12);
  const committed = state.content, count = state.rebuildCount;
  reads.clear(); layer.rebuild(); await idle(state);
  assert.equal(state.content, committed); assert.equal(state.rebuildCount, count); assert.equal(state.rebuildSkipped, true);
  assert.ok([...reads.values()].every(count => count <= 2), 'building/building_part share layer names; each source-layer is queried once per snapshot');
  enabled = false; layer.rebuild(); assert.equal(state.content.visible, false); enabled = true; layer.rebuild(); await idle(state); assert.equal(state.content, committed); assert.equal(state.content.visible, true);
  lng += 0.003; layer.rebuild(); state.cancelBuild(); await delay(5); assert.equal(state.pendingBuild, null); assert.equal(state.content, committed);
  state.clearContent();
});

test('camera drag keeps the committed city snapshot and defers a new local origin until it settles', async () => {
  let lng = 49.12, moving = false;
  const layer = new MapLifeLayer({ enabled: () => true, animate: () => false, offices: () => [], banksVisible: () => false, lighting: () => getLightingState(12), mobile: true, reducedMotion: false });
  const state = layer as unknown as State;
  state.map = {
    getZoom: () => 15.8,
    getCenter: () => ({ lng, lat: 55.79 }),
    getTerrain: () => null,
    getSource: () => ({}),
    isMoving: () => moving,
    querySourceFeatures: () => [],
    triggerRepaint() {},
  };
  layer.rebuild(); await idle(state);
  const committed = state.content;
  moving = true; lng += 0.004;
  layer.rebuild();
  assert.equal(state.content, committed, 'the visible scene remains anchored while the camera is in flight');
  assert.equal(state.pendingBuild, null, 'no replacement origin is prepared during a drag');
  moving = false;
  layer.rebuild(); await idle(state);
  assert.notEqual(state.content, committed, 'the settled viewport can refresh normally');
  state.clearContent();
});

test('cancelling a vegetation stage closes its nested generator before discarding the pending scene', async () => {
  const layer = new MapLifeLayer({ enabled: () => true, animate: () => false, offices: () => [], banksVisible: () => false, lighting: () => getLightingState(12), mobile: true, reducedMotion: false });
  const state = layer as unknown as State & { createTreesSteps: () => Generator<void, void, unknown> };
  state.map = { getZoom: () => 15.8, getCenter: () => ({ lng: 49.12, lat: 55.79 }), getTerrain: () => null, getSource: () => ({}), querySourceFeatures: () => [], triggerRepaint() {} };
  let entered = false, closed = 0;
  state.createTreesSteps = function* () { try { entered = true; for (let i = 0; i < 1_000_000; i++) yield; } finally { closed++; } };
  state.incremental = true; const current = state.content; layer.rebuild();
  for (let i = 0; !entered && i < 100; i++) await delay(2);
  assert.equal(entered, true); assert.equal(closed, 0); state.cancelBuild();
  assert.equal(closed, 1); assert.equal(state.pendingBuild, null); assert.equal(state.content, current);
});

test('source fingerprint yields while lazy vector geometries are decoded', () => {
  const layer = new MapLifeLayer({ enabled: () => true, animate: () => false, offices: () => [], banksVisible: () => false, lighting: () => getLightingState(12), mobile: false, reducedMotion: false });
  const state = layer as unknown as State & { buildKeySteps: (radius: number) => Generator<string, string, unknown> };
  state.map = { getZoom: () => 16, getTerrain: () => null };
  let decoded = 0;
  const features = Array.from({ length: 500 }, (_, id) => {
    let visited = false;
    return { type: 'Feature', id, properties: { class: 'residential' }, get geometry() { if (!visited) { visited = true; decoded++; } return { type: 'Polygon', coordinates: [[[49 + id * 0.001, 55], [49 + id * 0.001, 55.001], [49.001 + id * 0.001, 55]]] }; } };
  });
  state.sourceSnapshot.set('atlas-buildings:building', features);
  const work = state.buildKeySteps(2500), first = work.next();
  assert.equal(first.done, false); assert.equal(first.value, 'sources'); assert.ok(decoded > 0 && decoded <= 128, 'a snapshot cannot decode the entire loaded building source in one operation');
  let result = work.next(); while (!result.done) result = work.next();
  assert.equal(decoded, features.length); assert.ok(result.value.length > 0);
});

test('cheap city preparation steps share timed slices without repeated four-step timer waits', context => {
  const layer = new MapLifeLayer({ enabled: () => true, animate: () => false, offices: () => [], banksVisible: () => false, lighting: () => getLightingState(12), mobile: false, reducedMotion: false });
  const state = layer as unknown as State & { snapshotStages: () => Generator<string, void, unknown>; buildSnapshot: (complete: () => void, skip: () => void) => void };
  let cpu = 0, completed = false, steps = 0;
  const queue: (() => void)[] = [];
  context.mock.method(performance, 'now', () => cpu += .001);
  context.mock.method(globalThis, 'setTimeout', (callback: () => void) => { queue.push(callback); return 1; });
  state.incremental = true;
  state.snapshotStages = function* () { for (let i = 0; i < 260; i++) { steps++; yield 'sources'; } };
  state.buildSnapshot(() => { completed = true; }, () => {});
  assert.equal(completed, false, 'camera-triggered preparation must return before completion');
  assert.equal(steps, 4);
  let tasks = 0;
  while (queue.length && tasks < 100) { queue.shift()!(); tasks++; }
  assert.equal(completed, true);
  assert.equal(steps, 260);
  assert.ok(tasks <= 5, `cheap work should not require 65 timer waits: ${tasks}`);
});
