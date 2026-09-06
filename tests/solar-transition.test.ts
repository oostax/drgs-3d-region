import test from 'node:test';
import assert from 'node:assert/strict';
import { getLightingState, getSceneTime, type LightingState, type SceneAppearance } from '../src/lib/solar';
import { geographicNightAmount, getWorldSunDirection, interpolateLighting } from '../src/lib/solar-transition';

const september = new Date('2026-09-04T14:00:00Z');
const close = (actual: number, expected: number, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

test('one scene time creates different daylight levels across Russian longitudes', () => {
  const appearance: SceneAppearance = { timeMode: 'auto', hour: 0, life: true };
  const sun = getWorldSunDirection(appearance, september);
  const west = geographicNightAmount(20.51, 54.71, sun);
  const east = geographicNightAmount(131.88, 43.12, sun);
  assert.ok(west < 0.05, 'Kaliningrad is still in daylight');
  assert.ok(east > 0.95, 'Vladivostok is already at night');
  close(Math.hypot(...sun), 1);
});

test('geographic lighting agrees with the existing solar calculation in both clock modes', () => {
  for (const date of [september, new Date('2026-06-21T01:00:00Z'), new Date('2026-12-21T10:00:00Z')]) {
    for (const appearance of [{ timeMode: 'auto', hour: 0, life: true }, { timeMode: 'manual', hour: 18.25, life: false }] as SceneAppearance[]) {
      const sun = getWorldSunDirection(appearance, date);
      for (const coordinates of [[20.51, 54.71], [49.12, 55.79], [82.92, 55.03], [131.88, 43.12], [179, 66], [-179, 66]] as [number, number][]) {
        close(geographicNightAmount(...coordinates, sun), getSceneTime(appearance, { date, coordinates }).nightAmount);
      }
    }
  }
});

test('time and azimuth interpolate over midnight and north by the shortest path', () => {
  const from = { ...getLightingState(23, september), sunAzimuth: 359 };
  const to = { ...getLightingState(1, september), sunAzimuth: 1 };
  const midpoint = interpolateLighting(from, to, 0.5);
  close(midpoint.localHour, 0);
  close(midpoint.sunAzimuth, 0);
  close(interpolateLighting(from, to, 0.25).localHour, 23.5);
  close(interpolateLighting(from, to, 0.75).localHour, 0.5);
  close(interpolateLighting(to, from, 0.5).localHour, 0);
  close(interpolateLighting(from, to, -1).localHour, 23);
  close(interpolateLighting(from, to, 2).localHour, 1);

  const before = interpolateLighting(from, to, 0.4999), after = interpolateLighting(from, to, 0.5001);
  assert.ok(Math.abs(before.nightAmount - after.nightAmount) < 0.001);
  assert.ok(Math.hypot(...before.sunDirection.map((value, index) => value - after.sunDirection[index])) < 0.001);
});

test('opposite and nearly opposite sun directions stay finite, unit length and continuous', () => {
  const base = getLightingState(12, september);
  for (const [start, end] of [
    [[1, 0, 0], [-1, 0, 0]],
    [[0, 0, 1], [0, 0, -1]],
    [[1, 0, 0], [-1, 1e-8, 0]],
    [[1, 0, 0], [1, 1e-8, 0]],
  ] as [LightingState['sunDirection'], LightingState['sunDirection']][]) {
    const from = { ...base, sunDirection: start }, to = { ...base, sunDirection: end };
    let previous = interpolateLighting(from, to, 0).sunDirection;
    for (let step = 0; step <= 100; step++) {
      const result = interpolateLighting(from, to, step / 100);
      assert.ok(result.sunDirection.every(Number.isFinite));
      close(Math.hypot(...result.sunDirection), 1);
      assert.ok(Math.hypot(...result.sunDirection.map((value, index) => value - previous[index])) < 0.04);
      previous = result.sunDirection;
    }
    const expectedLength = Math.hypot(...end);
    previous.forEach((value, index) => close(value, end[index] / expectedLength));
  }
});

test('dawn and sunset soften continuously across neighboring map coordinates', () => {
  const sun = getWorldSunDirection({ timeMode: 'manual', hour: 18, life: true }, september);
  const samples = Array.from({ length: 101 }, (_, index) => geographicNightAmount(35 + index * 0.3, 55.79, sun));
  assert.ok(samples.some((value) => value > 0.05 && value < 0.95), 'twilight must contain intermediate tones');
  for (let index = 1; index < samples.length; index++) assert.ok(Math.abs(samples[index] - samples[index - 1]) < 0.04);
  close(geographicNightAmount(-180, 66, sun), geographicNightAmount(180, 66, sun));
});
