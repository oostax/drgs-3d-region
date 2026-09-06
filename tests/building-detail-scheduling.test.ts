import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Feature, Polygon } from 'geojson';
import { BuildingDetailsLayer } from '../src/lib/map-building-details';
import { getLightingState } from '../src/lib/solar';

const feature = (id: string, kind = 'apartments', lng = 49.12): Feature<Polygon> => ({
  type: 'Feature', properties: { id, class: kind, height: 15, num_floors: 5 },
  geometry: { type: 'Polygon', coordinates: [[[lng, 55.79], [lng + .0004, 55.79], [lng + .0004, 55.7902], [lng, 55.7902], [lng, 55.79]]] },
});
type Internals = {
  map: unknown; renderer: unknown; rebuild: () => void; light: (value: ReturnType<typeof getLightingState>) => void;
  dirty: boolean; sourceChanged: (event: { sourceId: string; sourceDataType: string }) => void;
  entries: { id: string }[]; origin: MercatorCoordinate; content: THREE.Group;
  textures: Map<string, { diffuse: THREE.Texture; emissive: THREE.Texture; normal: THREE.Texture }>;
};

function harness(context: TestContext) {
  let clock = 0, nextFrame = 0, enabled = true, destroyed = false;
  // Deterministic CPU checkpoints: tests inspect scheduling and resource
  // ownership, rather than asserting hardware-dependent execution durations.
  context.mock.method(performance, 'now', () => clock += 2);
  const frames = new Map<number, FrameRequestCallback>();
  const original = ['requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => frames.delete(id) });
  context.after(() => { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  let features = [feature('baseline')], center = { lng: 49.12, lat: 55.79 };
  const canvas = { clientWidth: 1200, clientHeight: 800, width: 1200, height: 800, dataset: {} };
  const layer = new BuildingDetailsLayer({ mobile: false, enabled: () => enabled, lighting: () => getLightingState(12) });
  const state = layer as unknown as Internals;
  state.map = {
    getSource: () => ({}), querySourceFeatures: (_: string, options: { sourceLayer: string }) => options.sourceLayer === 'building' ? features : [],
    getZoom: () => 17, getPitch: () => 55, getCenter: () => center, getCanvas: () => canvas,
    project: () => ({ x: 600, y: 400 }), getTerrain: () => null, triggerRepaint: () => {}, off: () => {},
  };
  const renderedCounts: number[] = [];
  state.renderer = { capabilities: { getMaxAnisotropy: () => 1 }, resetState: () => {}, setViewport: () => {}, dispose: () => {}, render: () => renderedCounts.push(state.content.children.length) };
  state.rebuild(); state.light(getLightingState(12));
  const draw = () => layer.render({} as WebGL2RenderingContext, { defaultProjectionData: { mainMatrix: new THREE.Matrix4().elements } } as unknown as Parameters<BuildingDetailsLayer['render']>[1]);
  const tick = () => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(clock));
  };
  const drain = () => {
    for (let i = 0; i < 500 && (frames.size || state.dirty || layer.getDiagnostics().buildPending); i++) { draw(); tick(); }
    assert.equal(frames.size, 0, 'completed preparation has no continuous RAF loop');
    assert.equal(layer.getDiagnostics().buildPending, false);
  };
  return {
    layer, state, frames, renderedCounts, draw, tick, drain,
    setEnabled: (value: boolean) => { enabled = value; },
    replace: (next: Feature<Polygon>[], lng = center.lng) => {
      features = next; center = { ...center, lng };
      state.sourceChanged({ sourceId: 'atlas-buildings', sourceDataType: 'content' }); layer.refresh();
    },
    destroy: () => { if (!destroyed) { destroyed = true; layer.onRemove(); } },
  };
}

test('cold preparation keeps the live scene and commits only the latest camera/source with its matching origin', context => {
  const h = harness(context);
  try {
    const oldGeometry = (h.state.content.children[0] as THREE.Mesh).geometry, oldOrigin = h.state.origin;
    let oldDisposals = 0; oldGeometry.addEventListener('dispose', () => { oldDisposals++; });
    h.replace(Array.from({ length: 30 }, (_, index) => feature(`stale-${index}`, 'apartments', 49.121 + index * .0005)));
    h.draw(); assert.equal(h.frames.size, 1);
    assert.equal(h.layer.getDiagnostics().geometryCacheEntries, 1, 'render queues preparation without doing cold geometry work');
    for (let i = 0; i < 4; i++) { h.tick(); h.draw(); }
    assert.equal(h.layer.getDiagnostics().buildPending, true);
    assert.equal((h.state.content.children[0] as THREE.Mesh).geometry, oldGeometry);
    h.replace([feature('latest-city', 'apartments', 37.62)], 37.62);
    for (let i = 0; i < 5; i++) {
      h.tick(); h.draw();
      if (h.layer.getDiagnostics().buildPending) {
        assert.equal(h.state.origin, oldOrigin, 'the old scene keeps its metre origin during the distant-city rebuild');
        assert.equal((h.state.content.children[0] as THREE.Mesh).geometry, oldGeometry);
      }
    }
    h.drain(); h.draw();
    assert.deepEqual(h.state.entries.map(entry => entry.id), ['latest-city']);
    assert.ok(Math.abs(h.state.origin.toLngLat().lng - 37.62) < 1e-8);
    assert.equal(oldDisposals, 1, 'old GPU geometry is released only when complete replacements are committed');
    assert.ok(h.renderedCounts.every(count => count > 0), 'preparation never publishes an empty live group');
    assert.ok(h.layer.getDiagnostics().buildSlices > 1);
  } finally { h.destroy(); }
});

test('invalidating a prepared texture family releases its lease and removal cancels all pending work', context => {
  const h = harness(context);
  try {
    const oldTextures = new Set([...h.state.textures.values()].flatMap(textures => Object.values(textures)));
    const disposed: THREE.Texture[] = [], dispose = THREE.Texture.prototype.dispose;
    context.mock.method(THREE.Texture.prototype, 'dispose', function (this: THREE.Texture) { disposed.push(this); dispose.call(this); });
    h.replace([feature('prepared-school', 'education')]); h.draw();
    for (let i = 0; i < 100 && h.layer.getDiagnostics().buildPhase !== 'textures'; i++) { h.tick(); h.draw(); }
    assert.equal(h.layer.getDiagnostics().buildPhase, 'textures');
    assert.equal(h.layer.getDiagnostics().buildPending, true);
    assert.deepEqual(new Set([...h.state.textures.values()].flatMap(textures => Object.values(textures))), oldTextures, 'prepared maps do not replace the visible materials early');
    h.replace([feature('replacement', 'apartments')]); h.tick();
    const canceledTextures = disposed.filter(texture => !oldTextures.has(texture));
    assert.equal(canceledTextures.length, 3, 'cancellation releases the uncommitted diffuse/emission/normal family');
    assert.equal(new Set(canceledTextures).size, 3);
    h.destroy(); const afterRemoval = disposed.length; h.tick();
    assert.equal(h.frames.size, 0); assert.equal(h.layer.getDiagnostics().buildPending, false);
    assert.equal(h.layer.getDiagnostics().geometryCacheEntries, 0);
    assert.equal(disposed.length, afterRemoval, 'canceled callbacks cannot recreate or dispose resources again');
  } finally { h.destroy(); }
});

test('disabled detail layers stop preparation and resume the newest viewport when enabled again', context => {
  const h = harness(context);
  try {
    h.replace(Array.from({ length: 12 }, (_, index) => feature(`next-${index}`, 'apartments', 49.12 + index * .0005)));
    h.draw(); h.tick(); h.setEnabled(false); h.tick();
    assert.equal(h.frames.size, 0); assert.equal(h.layer.getDiagnostics().buildPending, false);
    assert.equal(h.state.dirty, true); assert.deepEqual(h.state.entries.map(entry => entry.id), ['baseline']);
    h.setEnabled(true); h.drain();
    assert.equal(h.state.entries.length, 12);
    assert.equal(h.frames.size, 0);
  } finally { h.destroy(); }
});

test('an empty viewport commits through production RAF scheduling without invalid Three objects', context => {
  const h = harness(context), errors: unknown[][] = [];
  context.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  try {
    const oldGeometry = (h.state.content.children[0] as THREE.Mesh).geometry;
    let disposed = 0; oldGeometry.addEventListener('dispose', () => { disposed++; });
    h.replace([]); h.draw();
    assert.equal(h.frames.size, 1, 'the empty viewport uses the production preparation queue');
    h.drain(); h.draw();
    assert.equal(h.state.entries.length, 0);
    assert.equal(h.state.content.children.length, 0);
    assert.equal(disposed, 0, 'an empty viewport keeps bounded warm GPU buffers for a return pan');
    assert.equal(h.layer.getDiagnostics().buildPending, false);
    assert.equal(h.state.dirty, false);
    assert.equal(h.frames.size, 0);
    assert.deepEqual(errors, [], 'Three must never receive add(undefined) for an empty group');

    h.replace([feature('visible-again')]); h.drain();
    assert.deepEqual(h.state.entries.map(entry => entry.id), ['visible-again']);
    assert.ok(h.state.content.children.length > 0, 'an empty commit does not disable later preparation');
    assert.deepEqual(errors, []);
    h.destroy(); assert.equal(disposed, 1, 'removing the layer releases the warm buffers');
  } finally { h.destroy(); }
});


test('cheap source batches share the CPU slice instead of waiting a frame per 64 features', context => {
  const h = harness(context);
  try {
    // Model cheap cached/duplicate features; keep CPU time below the slice budget.
    let cpu = 0; context.mock.method(performance, 'now', () => cpu += .0001);
    h.replace(Array.from({ length: 6400 }, () => feature('baseline')));
    let frames = 0;
    do { h.draw(); h.tick(); frames++; } while (frames < 200 && (h.frames.size || h.state.dirty || h.layer.getDiagnostics().buildPending));
    assert.ok(frames < 10, `cheap duplicates must not incur 100 frame waits: ${frames}`);
    assert.deepEqual(h.state.entries.map(entry => entry.id), ['baseline']);
    assert.equal(h.layer.getDiagnostics().buildPending, false);
  } finally { h.destroy(); }
});

test('neighbor prefetch is bounded and late results are ignored after navigation', async context => {
  const h = harness(context);
  type Candidate = { cachePrefix: string; geometryKeys: Map<string, string>; pixels: number };
  const state = h.state as unknown as { sourceCandidates: Candidate[]; geometryWorker: unknown; geometryOrigin: MercatorCoordinate; geometryCache: Map<string, unknown>; schedulePrefetch: (candidates: Candidate[], origin: MercatorCoordinate, zoom: number) => void; cancelPrefetch: () => void };
  const { buildBuildingGeometry, packBuildingGeometry } = await import('../src/lib/building-detail-geometry');
  type Input = Parameters<typeof buildBuildingGeometry>[0];
  type Packed = ReturnType<typeof packBuildingGeometry>;
  const callbacks: (() => void)[] = [];
  const jobs: { inputs: Input[]; resolve: (items: Packed[]) => void }[] = [];
  context.mock.method(globalThis, 'setTimeout', (callback: () => void) => { callbacks.push(callback); return 1; });
  Object.assign(h.state.map as object, { isMoving: () => false });
  state.geometryWorker = { available: true, completed: 0, build: (inputs: Input[]) => new Promise<Packed[]>(resolve => jobs.push({ inputs, resolve })), dispose() {}, cancel() {} };
  const candidates = Array.from({ length: 20 }, (_, i) => ({ ...state.sourceCandidates[0], cachePrefix: `neighbor-${i}`, geometryKeys: new Map<string,string>(), pixels: 2 }));
  try {
    state.schedulePrefetch(candidates, state.geometryOrigin, 17); callbacks.shift()!();
    assert.equal(jobs.length, 1); assert.equal(jobs[0].inputs.length, 8, 'speculation never queues a whole neighborhood ahead of visible work');
    const initial = state.geometryCache.size;
    state.cancelPrefetch();
    jobs[0].resolve(jobs[0].inputs.map(input => packBuildingGeometry(input.key, buildBuildingGeometry(input))));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(state.geometryCache.size, initial); assert.equal(jobs.length,1);
    state.schedulePrefetch(candidates.slice(0, 2), state.geometryOrigin,17); callbacks.shift()!();
    jobs[1].resolve(jobs[1].inputs.map(input => packBuildingGeometry(input.key, buildBuildingGeometry(input))));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(state.geometryCache.size, initial + 2);
    assert.equal(h.layer.getDiagnostics().prefetched,2);
  } finally { h.destroy(); }
});

test('production preparation resumes worker results and atomically publishes the new geometry', async context => {
  const h = harness(context);
  const { buildBuildingGeometry, packBuildingGeometry } = await import('../src/lib/building-detail-geometry');
  type Input = Parameters<typeof buildBuildingGeometry>[0];
  let requests = 0;
  const state = h.state as unknown as { geometryWorker: unknown };
  state.geometryWorker = { available: true, completed: 0, busy:false, build: async (inputs: Input[]) => { requests++; return inputs.map(input => packBuildingGeometry(input.key, buildBuildingGeometry(input))); }, dispose() {}, cancel() {} };
  try {
    const original = h.state.content.children[0];
    h.replace([feature('worker-building','apartments',49.123)]);
    h.draw(); assert.equal(h.state.content.children[0],original);
    for (let i=0; i<500 && (h.frames.size || h.state.dirty || h.layer.getDiagnostics().buildPending); i++) { h.draw(); h.tick(); await Promise.resolve(); await Promise.resolve(); }
    assert.ok(requests>0); assert.equal(h.layer.getDiagnostics().buildPending,false);
    assert.deepEqual(h.state.entries.map(entry=>entry.id),['worker-building']);
    assert.ok(h.state.content.children.length>0);
  } finally { h.destroy(); }
});
