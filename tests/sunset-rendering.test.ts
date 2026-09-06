import test from 'node:test';
import assert from 'node:assert/strict';
import { Color } from '@maplibre/maplibre-gl-style-spec';
import { getBuildingLight, classifyBuilding } from '../src/lib/building-materials';
import { getLightingState } from '../src/lib/solar';
import { applyMapLighting } from '../src/lib/map-appearance';
import * as solar from '../src/lib/map-solar-light';

const date = new Date('2026-09-06T09:00:00Z');

test('sunset preserves material colours: neutral global light and gently warm directional light', () => {
  for (const elevation of [-12, -5, -1, 0, 2, 5, 10, 18, 40]) {
    const state = { ...getLightingState(17.35, date), sunElevation: elevation, nightAmount: elevation < -8 ? 1 : elevation < 0 ? 0.6 : 0 };
    const light = getBuildingLight(state);
    const legacy = Color.parse(light.legacyColor), sun = Color.parse(light.sunColor);
    assert.ok(legacy && sun);
    const [r, g, b] = legacy.rgb;
    assert.ok(r - b <= 18 / 255 && r >= g && g >= b, `${elevation}: global lighting must not wash all roofs orange`);
    const [sr, sg, sb] = sun.rgb;
    assert.ok(sr >= sg && sg >= sb && sr - sb <= 51 / 255, `${elevation}: direct sunlight is warm, not saturated orange`);
    assert.equal(light.ambientColor, '#e8e8e2', 'ambient does not change material hue at sunset');
  }
  const measured = { facade_color: '#e0ded3', roof_color: '#687981', height: 12 };
  const before = classifyBuilding(measured);
  for (const hour of [6, 12, 17.35, 18, 23]) getBuildingLight(getLightingState(hour, date));
  assert.deepEqual(classifyBuilding(measured), before, 'lighting does not rewrite the source or fallback pigment');
});

test('MapLibre uses its neutral global light, not the Three.js direct sun tint', () => {
  let applied: { color?: string } | undefined;
  const map = { getStyle: () => ({ layers: [] }), getZoom: () => 15, getLayer: () => undefined, getSource: () => undefined,
    setLight: (light: { color?: string }) => { applied = light; }, triggerRepaint() {} };
  const state = getLightingState(17.35, date), light = getBuildingLight(state);
  applyMapLighting(map as never, state, true);
  assert.equal(applied?.color, light.legacyColor);
  assert.notEqual(applied?.color, light.sunColor);
});

test('solar wash is absent at city scale and subtle at country scale, including dawn and dusk', () => {
  for (const zoom of [9, 10, 13, 15, 20]) assert.deepEqual(solar.solarOverlayStrength(zoom), { warmth: 0, night: 0 });
  for (let zoom = 0; zoom < 9; zoom += 0.1) {
    const amount = solar.solarOverlayStrength(zoom);
    assert.ok(amount.warmth >= 0 && amount.warmth <= 0.04);
    assert.ok(amount.night >= 0 && amount.night <= 0.76);
  }
  assert.ok(solar.solarOverlayStrength(5).night > 0.7, 'the geographic night terminator remains visible');
  assert.ok(solar.solarOverlayStrength(8.99).warmth < 0.00001, 'no colour jump at the city threshold');
});

test('city-scale solar pass skips drawing rather than compositing a second warm layer', () => {
  const layer = new solar.SolarLightLayer();
  const internal = layer as unknown as { program: unknown; uniforms: unknown; map: unknown };
  internal.program = {}; internal.uniforms = {}; internal.map = { getZoom: () => 15 };
  const gl = new Proxy({}, { get: (_target, name) => { throw new Error(`City view must not call GL ${String(name)}`); } });
  assert.doesNotThrow(() => layer.render(gl as WebGL2RenderingContext, {} as never));
});
