import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, createExpression } from '@maplibre/maplibre-gl-style-spec';
import { BUILDING_FACADE_COLOR, BUILDING_FACADE_VARIANT, BUILDING_PROFILE, BUILDING_ROOF_COLOR, classifyBuilding, type BuildingProfileKind } from '../src/lib/building-materials';

const cases: [Record<string, unknown>, BuildingProfileKind][] = [
  [{ class: 'kindergarten', subtype: 'education' }, 'kindergarten'],
  [{ class: 'school', subtype: 'education' }, 'education'],
  [{ class: 'college', subtype: 'education' }, 'university'],
  [{ class: 'university' }, 'university'],
  [{ class: 'stadium', subtype: 'entertainment' }, 'stadium'],
  [{ class: 'grandstand' }, 'stadium'],
  [{ class: 'sports_hall' }, 'sports'],
  [{ class: 'sports_centre' }, 'sports'],
  [{ class: 'hotel', subtype: 'commercial' }, 'hotel'],
  [{ class: 'government', subtype: 'civic' }, 'civic'],
  [{ class: 'library', subtype: 'civic' }, 'cultural'],
  [{ class: 'train_station' }, 'transport'],
  [{ class: 'barn', subtype: 'agricultural' }, 'agricultural'],
  [{ class: 'cowshed' }, 'agricultural'],
  [{ class: 'farm' }, 'house'],
  [{ class: 'dwelling_house' }, 'house'],
  [{ class: 'greenhouse' }, 'greenhouse'],
  [{ class: 'glasshouse' }, 'greenhouse'],
  [{ subtype: 'medical' }, 'medical'],
  [{ subtype: 'residential' }, 'residential'],
  [{ subtype: 'commercial' }, 'commercial'],
  [{ subtype: 'outbuilding' }, 'outbuilding'],
  [{ building: 'yes', amenity: 'kindergarten' }, 'kindergarten'],
  [{ building: 'civic', amenity: 'library' }, 'cultural'],
  [{ building: 'yes', leisure: 'stadium' }, 'stadium'],
  [{ building: 'yes', amenity: 'clinic' }, 'clinic'],
  [{ building: 'yes', tourism: 'museum' }, 'cultural'],
  [{ building: 'apartments', 'building:use': 'office' }, 'office'],
  [{ class: 'apartments', facade_material: 'brick' }, 'brick'],
  [{ class: 'apartments', facade_material: 'concrete_panels' }, 'panel'],
  [{ class: 'apartments', start_date: '2015-06-01' }, 'contemporary'],
];

test('Overture purpose classes and OSM tags select specific regional-independent facade families', () => {
  for (const [properties, expected] of cases) assert.equal(classifyBuilding(properties).kind, expected, JSON.stringify(properties));
});

test('base map and detailed facade agree on purpose and pigments for every new family', () => {
  const kind = createExpression(BUILDING_PROFILE, 'profile');
  const facade = createExpression(BUILDING_FACADE_COLOR, 'facade');
  const roof = createExpression(BUILDING_ROOF_COLOR, 'roof');
  assert.equal(kind.result, 'success'); assert.equal(facade.result, 'success'); assert.equal(roof.result, 'success');
  if (kind.result !== 'success' || facade.result !== 'success' || roof.result !== 'success') return;
  for (const [properties] of cases) {
    const profile = classifyBuilding(properties), feature = { type: 'Polygon' as const, properties };
    assert.equal(kind.value.evaluate({ zoom: 17 }, feature), profile.kind);
    assert.deepEqual((facade.value.evaluate({ zoom: 17 }, feature) as Color).rgb, Color.parse(profile.facadeColor)!.rgb);
    assert.deepEqual((roof.value.evaluate({ zoom: 17 }, feature) as Color).rgb, Color.parse(profile.roofColor)!.rgb);
  }
});

test('decorative diversity is stable, bounded, and never alters source dimensions or colors', () => {
  const variants = new Set<number>();
  for (let i = 0; i < 120; i++) {
    const properties = { id: `building-${i}`, class: 'apartments', height: 18, facade_color: '#926e45', roof_color: '#547768' };
    const profile = classifyBuilding(properties);
    assert.deepEqual(classifyBuilding(properties), profile);
    assert.equal(profile.kind, 'apartments'); assert.equal(profile.height, 18);
    assert.equal(profile.facadeColor, '#926e45'); assert.equal(profile.roofColor, '#547768');
    variants.add(profile.facadeVariant);
    assert.equal(classifyBuilding({ ...properties, id: 'child', building_id: properties.id }).facadeVariant, profile.facadeVariant);
  }
  assert.deepEqual([...variants].sort(), [0, 1, 2]);
});

test('recent appearance and surface materials require evidence, not height or a suggestive name', () => {
  assert.equal(classifyBuilding({ class: 'apartments', height: 150, name: 'Новостройка 2025' }).kind, 'apartments');
  assert.equal(classifyBuilding({ class: 'apartments', start_date: '1982' }).kind, 'apartments');
  assert.equal(classifyBuilding({ class: 'apartments', start_date: 'unknown' }).kind, 'apartments');
  assert.equal(classifyBuilding({ class: 'apartments', facade_material: 'concrete' }).surface, 'plain');
  assert.equal(classifyBuilding({ class: 'office' }).surface, 'plaster');
  assert.equal(classifyBuilding({ class: 'house', facade_material: 'timber_framing' }).surface, 'wood');
  assert.equal(classifyBuilding({ roof_material: 'metal' }).roofMaterial, 'metal');
  for (const properties of [{ name: 'Больница', id: 'hospital' }, { shop: 'no', office: 'no', historic: 'no' }]) assert.equal(classifyBuilding(properties).kind, 'neutral');
  for (const className of ['stadium', 'agricultural', 'outbuilding']) assert.equal(classifyBuilding({ class: className }).windows, 'none');
});

test('unknown buildings receive three stable muted fallback pigments that agree at every map zoom', () => {
  const variant = createExpression(BUILDING_FACADE_VARIANT, 'variant');
  const facade = createExpression(BUILDING_FACADE_COLOR, 'facade');
  const roof = createExpression(BUILDING_ROOF_COLOR, 'roof');
  assert.equal(variant.result, 'success'); assert.equal(facade.result, 'success'); assert.equal(roof.result, 'success');
  if (variant.result !== 'success' || facade.result !== 'success' || roof.result !== 'success') return;
  const neutral = classifyBuilding({});
  assert.equal(neutral.facadeColor, '#d8d3c5'); assert.equal(neutral.roofColor, '#637b76'); assert.equal(neutral.facadeVariant, 0);
  for (const className of ['yes', 'apartments', 'office', 'kindergarten', 'stadium', 'warehouse']) {
    const facades = new Set<string>(), roofs = new Set<string>();
    for (const id of ['hex-id-0', 'hex-id-1', 'hex-id-2']) {
      const properties = { id, class: className }, profile = classifyBuilding(properties);
      facades.add(profile.facadeColor); roofs.add(profile.roofColor);
      assert.equal(profile.kind, classifyBuilding({ class: className }).kind);
      assert.equal(profile.surface, classifyBuilding({ class: className }).surface);
      for (const zoom of [13, 16, 19]) {
        const feature = { type: 'Polygon' as const, properties };
        assert.equal(variant.value.evaluate({ zoom }, feature), profile.facadeVariant);
        assert.deepEqual((facade.value.evaluate({ zoom }, feature) as Color).rgb, Color.parse(profile.facadeColor)!.rgb);
        assert.deepEqual((roof.value.evaluate({ zoom }, feature) as Color).rgb, Color.parse(profile.roofColor)!.rgb);
      }
      for (const [field, value] of [['facade_color', '#29415f'], ['roof_color', '#183420']] as const) {
        const colored = classifyBuilding({ ...properties, [field]: value });
        assert.equal(field === 'facade_color' ? colored.facadeColor : colored.roofColor, value);
      }
    }
    assert.equal(facades.size, 3); assert.equal(roofs.size, 3);
  }
  for (const id of ['0', '1', '2', 'a', 'b', 'f']) {
    assert.equal(classifyBuilding({ id, class: 'office' }).facadeVariant, classifyBuilding({ id, class: 'school' }).facadeVariant);
    assert.equal(classifyBuilding({ id: 'child', building_id: id }).facadeVariant, classifyBuilding({ id }).facadeVariant);
  }
});
