import test from 'node:test';
import assert from 'node:assert/strict';
import { Color } from '@maplibre/maplibre-gl-style-spec';
import type { Map as LibreMap } from 'maplibre-gl';
import { getBuildingLight } from '../src/lib/building-materials';
import { SolarLightLayer, spatialLightingAmount, SOLAR_TWILIGHT_OPACITY } from '../src/lib/map-solar-light';
import { getLightingState } from '../src/lib/solar';

const date = new Date('2026-09-06T14:00:00Z');
test('sunset sunlight is a restrained warm highlight while the map fill remains near-neutral', () => {
  for (let hour = 0; hour < 24; hour += 0.1) {
    const light = getBuildingLight(getLightingState(hour, date));
    const sun = Color.parse(light.sunColor)!.rgb.slice(0, 3);
    const map = Color.parse(light.mapColor)!.rgb.slice(0, 3);
    const ambient = Color.parse(light.ambientColor)!.rgb.slice(0, 3);
    assert.ok(sun[0] >= sun[1] && sun[1] >= sun[2]);
    assert.ok(sun[0] - sun[2] <= 0.16, `${hour}: sunlight must not recolor white walls orange`);
    assert.ok(map[0] - map[2] <= 0.075, `${hour}: the global map light includes neutral ambient fill`);
    assert.ok(Math.max(...ambient) - Math.min(...ambient) < 0.03);
  }
});

test('sunlight changes continuously through sunrise and sunset without a 12/15 degree colour switch', () => {
  const base = getLightingState(12, date);
  let previous: number[] | null = null;
  for (let elevation = -15; elevation <= 40; elevation += 0.1) {
    const light = getBuildingLight({ ...base, sunElevation: elevation, nightAmount: Math.max(0, Math.min(1, -elevation / 8)) });
    const rgb = Color.parse(light.sunColor)!.rgb.slice(0, 3);
    if (previous) assert.ok(Math.max(...rgb.map((value, i) => Math.abs(value - previous![i]))) <= 1.01 / 255);
    previous = rgb;
  }
});

test('city scale never draws a solar colour overlay in 2D or 3D', () => {
  const layer = new SolarLightLayer();
  const state = layer as unknown as { program: object; uniforms: object; map: LibreMap };
  state.program = {}; state.uniforms = {};
  const noDraw = new Proxy({}, { get: (_, key) => { throw new Error(`City overlay must not call WebGL.${String(key)}`); } }) as WebGL2RenderingContext;
  for (const zoom of [9, 10, 13, 16, 20]) {
    state.map = { getZoom: () => zoom } as LibreMap;
    assert.equal(spatialLightingAmount(zoom), 0);
    assert.doesNotThrow(() => layer.render(noDraw, {} as Parameters<SolarLightLayer['render']>[1]));
  }
});

test('the regional atmosphere is capped at four percent and fades continuously into city lighting', () => {
  assert.ok(SOLAR_TWILIGHT_OPACITY > 0 && SOLAR_TWILIGHT_OPACITY <= 0.04);
  assert.equal(spatialLightingAmount(5), 1);
  let previous = 1;
  for (let zoom = 5.5; zoom <= 9; zoom += 0.01) {
    const amount = spatialLightingAmount(zoom);
    assert.ok(amount >= 0 && amount <= previous);
    assert.ok(previous - amount < 0.005);
    previous = amount;
  }
  assert.equal(spatialLightingAmount(9), 0);
});
