import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, createExpression } from '@maplibre/maplibre-gl-style-spec';
import type { ExpressionSpecification } from 'maplibre-gl';
import { BUILDING_FACADE_COLOR, BUILDING_ROOF_COLOR, classifyBuilding } from '../src/lib/building-materials';

function evaluate(expression: ExpressionSpecification, properties: Record<string, unknown>) {
  const compiled = createExpression(expression, 'building-pigment');
  assert.equal(compiled.result, 'success', JSON.stringify(compiled.value));
  if (compiled.result !== 'success') throw new Error('Invalid color expression');
  const result = compiled.value.evaluate({ zoom: 17 }, { type: 'Polygon', properties }) as Color;
  return '#' + result.rgb.slice(0, 3).map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('');
}

test('named red, green and blue become architectural pigments in both renderers', () => {
  for (const [name, facade, roof] of [['red', '#b58170', '#906557'], ['green', '#8f9b7f', '#697b63'], ['blue', '#899dab', '#667e8b']]) {
    const properties = { facade_color: name, roof_color: name };
    const profile = classifyBuilding(properties);
    assert.equal(profile.facadeColor, facade);
    assert.equal(profile.roofColor, roof);
    assert.equal(evaluate(BUILDING_FACADE_COLOR, properties), facade);
    assert.equal(evaluate(BUILDING_ROOF_COLOR, properties), roof);
    assert.equal(profile.rawFacadeColor, name);
    assert.equal(profile.rawRoofColor, name);
    assert.ok(profile.sourceFacadeColor && profile.sourceRoofColor);
  }
});

test('other CSS names retain subdued chroma, with case and whitespace preserved as metadata', () => {
  for (const name of [' FUCHSIA ', 'lime', 'rebeccapurple', 'gold', 'cyan', 'White', 'black', 'lightblue']) {
    const properties = { 'building:colour': name, 'roof:color': name };
    const profile = classifyBuilding(properties);
    for (const color of [profile.facadeColor, profile.roofColor]) {
      const rgb = Color.parse(color)!.rgb.slice(0, 3);
      assert.ok(Math.max(...rgb) - Math.min(...rgb) < 0.3, name);
    }
    assert.equal(evaluate(BUILDING_FACADE_COLOR, properties), profile.facadeColor, name);
    assert.equal(evaluate(BUILDING_ROOF_COLOR, properties), profile.roofColor, name);
    assert.equal(profile.rawFacadeColor, name);
    assert.equal(profile.rawRoofColor, name);
  }
});

test('natural hex colors remain exact and take precedence over broad names in aliases', () => {
  for (const [raw, expected] of [['#804020', '#804020'], ['#648070', '#648070'], [' #AB724C ', '#ab724c'], ['#000000', '#000000'], ['#808080', '#808080'], ['#fff', '#ffffff']]) {
    const properties = { facade_color: 'red', 'building:color': raw, roof_color: 'blue', 'roof:colour': raw };
    const profile = classifyBuilding(properties);
    assert.equal(profile.facadeColor, expected);
    assert.equal(profile.roofColor, expected);
    assert.equal(profile.rawFacadeColor, raw);
    assert.equal(profile.rawRoofColor, raw);
    assert.equal(evaluate(BUILDING_FACADE_COLOR, properties), expected);
    assert.equal(evaluate(BUILDING_ROOF_COLOR, properties), expected);
  }
});

test('invalid or transparent colors fall back consistently, numeric CSS colors share pigment handling', () => {
  for (const properties of [
    { facade_color: 'invalid', 'building:colour': 'red', roof_color: 'transparent', 'roof:color': 'blue' },
    { facade_color: '#ff000010', roof_color: 'invalid', class: 'house' },
    { facade_color: 'rgb(255, 0, 0)', roof_color: 'hsl(240, 100%, 50%)' },
    { facade_color: 12, roof_color: null },
  ]) {
    const profile = classifyBuilding(properties);
    assert.equal(evaluate(BUILDING_FACADE_COLOR, properties), profile.facadeColor);
    assert.equal(evaluate(BUILDING_ROOF_COLOR, properties), profile.roofColor);
  }
  const absent = classifyBuilding({});
  assert.equal(absent.rawFacadeColor, null);
  assert.equal(absent.rawRoofColor, null);
  const invalid = classifyBuilding({ facade_color: 'invalid' });
  assert.equal(invalid.rawFacadeColor, 'invalid');
  assert.equal(invalid.sourceFacadeColor, false);
});

test('inherited facade pigment metadata does not replace a part roof or its dimensions', () => {
  const properties = { min_height: 4, height: 12, roof_color: 'blue' };
  const profile = classifyBuilding(properties, 80, { class: 'house', facade_color: 'red', roof_color: 'white', height: 40 });
  assert.equal(profile.rawFacadeColor, 'red');
  assert.equal(profile.rawRoofColor, 'blue');
  assert.equal(profile.height, 12);
  assert.equal(profile.base, 4);
  assert.equal(profile.facadeColor, '#b58170');
  assert.equal(profile.roofColor, '#667e8b');
});

test('categorical primary hex/RGB codes use the same architectural pigments as their CSS names', () => {
  const cases = [
    ['#ff0000', 'red'], ['#F00', 'red'], ['rgb(255, 0, 0)', 'red'],
    ['#008000', 'green'], ['rgb(0, 128, 0)', 'green'],
    ['#0000ff', 'blue'], ['#00F', 'blue'], ['hsl(240, 100%, 50%)', 'blue'],
  ];
  for (const [raw, name] of cases) {
    const properties = { facade_color: raw, roof_color: raw }, profile = classifyBuilding(properties);
    const named = classifyBuilding({ facade_color: name, roof_color: name });
    assert.equal(profile.facadeColor, named.facadeColor, raw); assert.equal(profile.roofColor, named.roofColor, raw);
    assert.equal(evaluate(BUILDING_FACADE_COLOR, properties), profile.facadeColor, raw);
    assert.equal(evaluate(BUILDING_ROOF_COLOR, properties), profile.roofColor, raw);
    assert.equal(profile.rawFacadeColor, raw); assert.equal(profile.rawRoofColor, raw);
    assert.ok(profile.sourceFacadeColor && profile.sourceRoofColor);
  }
});

test('exceptionally saturated arbitrary RGB is compressed without changing natural shades', () => {
  for (const raw of ['#fb1cce', '#18e62b', '#f51d12', '#0b38f4', '#00ff00', 'rgb(250, 6, 3)']) {
    const properties = { facade_color: raw, roof_color: raw }, profile = classifyBuilding(properties);
    assert.notEqual(profile.facadeColor, raw); assert.notEqual(profile.roofColor, raw);
    for (const color of [profile.facadeColor, profile.roofColor]) {
      const rgb = Color.parse(color)!.rgb.slice(0, 3);
      assert.ok(Math.max(...rgb) - Math.min(...rgb) < 0.26, `${raw}: ${color} is a restrained pigment`);
    }
    assert.equal(evaluate(BUILDING_FACADE_COLOR, properties), profile.facadeColor, raw);
    assert.equal(evaluate(BUILDING_ROOF_COLOR, properties), profile.roofColor, raw);
    assert.equal(profile.rawFacadeColor, raw); assert.equal(profile.rawRoofColor, raw);
  }
  const natural = classifyBuilding({ facade_color: 'rgb(128, 64, 32)', roof_color: '#804020' });
  assert.equal(natural.facadeColor, '#804020'); assert.equal(natural.roofColor, '#804020');
});
