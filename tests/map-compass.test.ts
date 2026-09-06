import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Map as LibreMap } from 'maplibre-gl';
import { compassAngle, createCompassCamera, ringBearing, tiltCompass, wrapBearing } from '../src/lib/map-compass';

function fixture() {
  let bearing = 30, pitch = 20, maxPitch = 75;
  const events = new Map<string, Set<() => void>>();
  const writes: object[] = []; let stopped = 0, settled = 0;
  const fire = (event: string) => { for (const fn of events.get(event) ?? []) fn(); };
  const map = {
    getBearing: () => bearing, getPitch: () => pitch, getMaxPitch: () => maxPitch,
    stop: () => { stopped++; },
    jumpTo: (pose: { bearing?: number; pitch?: number }) => {
      writes.push(pose); bearing = pose.bearing ?? bearing; pitch = pose.pitch ?? pitch; fire('move');
    },
    on: (event: string, fn: () => void) => { if (!events.has(event)) events.set(event, new Set()); events.get(event)!.add(fn); },
    off: (event: string, fn: () => void) => { events.get(event)?.delete(fn); },
  } as unknown as LibreMap;
  const camera = createCompassCamera(map, () => { settled++; });
  return { camera, fire, writes, events, max: (n: number) => { maxPitch = n; }, counts: () => ({ stopped, settled }) };
}

test('compass wraps positive, negative and multi-revolution bearings without NaN', () => {
  assert.equal(wrapBearing(181), -179); assert.equal(wrapBearing(-181), 179);
  assert.equal(wrapBearing(1080), 0); assert.equal(wrapBearing(-1080), 0);
  assert.equal(wrapBearing(NaN), 0); assert.equal(wrapBearing(Infinity), 0);
});
test('ring follows the pointer with short continuous movement across the south seam', () => {
  assert.equal(compassAngle(0, -100), 0); assert.equal(compassAngle(100, 0), 90);
  assert.equal(compassAngle(-100, 0), -90); assert.equal(compassAngle(1, 1), null);
  assert.equal(compassAngle(NaN, 10), null);
  assert.equal(ringBearing(20, 179, -179), 18); assert.equal(ringBearing(20, -179, 179), 22);
  assert.equal(ringBearing(0, 0, 90), -90);
});
test('centre drag controls both axes, respects compact/flat pitch, and never produces invalid angles', () => {
  const pose = { bearing: 0, pitch: 30, maxPitch: 75 };
  assert.deepEqual(tiltCompass(pose, 50, -40), { bearing: -30, pitch: 50, maxPitch: 75 });
  assert.equal(tiltCompass(pose, 0, -10000).pitch, 75);
  assert.equal(tiltCompass({ ...pose, maxPitch: 60 }, 0, -10000).pitch, 60);
  assert.equal(tiltCompass({ ...pose, maxPitch: 0 }, 0, -10000).pitch, 0);
  assert.equal(tiltCompass(pose, 0, 10000).pitch, 0);
  assert.deepEqual(tiltCompass(pose, NaN, Infinity), pose);
});
test('compass uses live camera and sets orientation only, not zoom, padding or centre', () => {
  const { camera, writes, counts } = fixture();
  camera.begin(); assert.equal(camera.interacting(), true);
  camera.write({ bearing: 420, pitch: 40 });
  assert.deepEqual(writes, [{ bearing: 60, pitch: 40 }]);
  assert.deepEqual(camera.read(), { bearing: 60, pitch: 40, maxPitch: 75 });
  camera.end(); camera.end(); assert.equal(camera.interacting(), false);
  assert.deepEqual(counts(), { stopped: 1, settled: 1 }); camera.dispose();
});
test('last-moment mode/resize limit wins over a queued drag and nonfinite input is ignored', () => {
  const { camera, writes, max } = fixture();
  max(60); camera.write({ pitch: 75 }); assert.equal(camera.read().pitch, 60);
  max(0); camera.write({ pitch: 40 }); assert.equal(camera.read().pitch, 0);
  camera.write({ pitch: NaN, bearing: Infinity }); assert.equal(writes.length, 2);
  camera.write({ bearing: -45 }); assert.deepEqual(writes.at(-1), { bearing: -45 });
  camera.dispose();
});
test('subscriptions follow external camera, resize and mode changes and dispose harmlessly', () => {
  const { camera, events, writes, fire, counts } = fixture(); let notified = 0;
  const off = camera.subscribe(() => notified++);
  fire('move'); fire('resize'); camera.refresh(); assert.equal(notified, 3);
  off(); fire('move'); assert.equal(notified, 3);
  camera.subscribe(() => notified++); camera.begin(); camera.dispose(); camera.dispose();
  camera.write({ bearing: 90 }); camera.begin(); camera.end(); camera.refresh();
  fire('resize'); assert.equal(notified, 3); assert.equal(writes.length, 0);
  assert.equal([...events.values()].every(set => set.size === 0), true);
  assert.deepEqual(counts(), { stopped: 1, settled: 0 });
});
test('the compass is wired to the real map, preserves open context, and remains visible on mobile', () => {
  const atlas = fs.readFileSync('src/components/Atlas.tsx', 'utf8');
  const map = fs.readFileSync('src/components/AtlasMap.tsx', 'utf8');
  const css = fs.readFileSync('src/app/globals.css', 'utf8');
  assert.ok(atlas.includes('onCompassReady={setCompassCamera}'));
  assert.ok(atlas.includes('<MapCompass camera={compassCamera}'));
  assert.ok(atlas.includes("panelOpen && (overlay === null || overlay === 'compass')"));
  assert.ok(map.includes('createCompassCamera(map, finishCameraMove)'));
  assert.ok(map.includes('compassRef.current?.dispose()'));
  assert.ok(!css.includes('.map-controls > .icon-button:nth-of-type(3)'));
});
