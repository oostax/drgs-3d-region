import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { classifyBuilding } from '../src/lib/building-materials';
import { BUILDING_SIGNAGE_ATLAS, getBuildingSignage, makeBuildingSignageGeometry } from '../src/lib/building-signage';

type XY = [number, number];
const ring: XY[] = [[0, 0], [24, 0], [24, 12], [0, 12]];
const school = classifyBuilding({ class: 'school', height: 9, num_floors: 3 });

test('purpose signs require source-classified use, never suggestive names, IDs, or a tall building', () => {
  for (const properties of [{}, { id: 'school', name: 'Школа' }, { height: 100 }, { class: 'apartments' }, { class: 'house' }, { class: 'church' }]) {
    const profile = classifyBuilding(properties);
    assert.equal(getBuildingSignage(profile), null);
    assert.equal(makeBuildingSignageGeometry([ring], profile).getAttribute('position').count, 0);
  }
  assert.equal(getBuildingSignage(school)?.label, 'ШКОЛА');
  assert.equal(getBuildingSignage(classifyBuilding({ class: 'hospital' }))?.label, 'БОЛЬНИЦА');
  assert.equal(getBuildingSignage(classifyBuilding({ class: 'kindergarten' }))?.label, 'ДЕТСКИЙ САД');
  assert.equal(getBuildingSignage(classifyBuilding({ subtype: 'medical' }))?.label, 'МЕДИЦИНА');
});

test('opposite ring windings produce the same outward, unmirrored entrance sign', () => {
  const a = makeBuildingSignageGeometry([ring], school), b = makeBuildingSignageGeometry([[...ring].reverse()], school);
  assert.equal(a.getAttribute('position').count, 6);
  for (const attribute of ['position', 'normal', 'uv']) assert.deepEqual([...a.getAttribute(attribute).array], [...b.getAttribute(attribute).array]);
  const position = a.getAttribute('position'), normal = a.getAttribute('normal');
  const triangle = new THREE.Triangle(new THREE.Vector3().fromBufferAttribute(position, 0), new THREE.Vector3().fromBufferAttribute(position, 1), new THREE.Vector3().fromBufferAttribute(position, 2));
  assert.ok(triangle.getNormal(new THREE.Vector3()).dot(new THREE.Vector3().fromBufferAttribute(normal, 0)) > 0.999);
  assert.equal(normal.getY(0), -1); assert.ok(position.getY(0) < 0, 'the first southern facade points away from the building');
  assert.ok(position.getZ(0) >= 2.15); assert.ok(position.getZ(2) < school.eaves);
  assert.ok(position.getX(1) > position.getX(0), 'text advances right when viewed from outside');
  a.dispose(); b.dispose();
});

test('closed rings and courtyard winding cannot put entrance signs into a courtyard', () => {
  const courtyard: XY[] = [[2, 2], [22, 2], [22, 10], [2, 10]];
  const geometry = makeBuildingSignageGeometry([[...ring, ring[0]], courtyard], school), position = geometry.getAttribute('position');
  assert.equal(position.count, 6);
  for (let i = 0; i < position.count; i++) assert.ok(position.getY(i) < 0);
  geometry.dispose();
});

test('tiny, distant, floating and invalid parts cannot create misplaced signs', () => {
  for (const profile of [{ ...school, tiny: true }, { ...school, base: 3 }, { ...school, eaves: 2.6 }]) assert.equal(makeBuildingSignageGeometry([ring], profile).getAttribute('position').count, 0);
  for (const level of [0, 1] as const) assert.equal(makeBuildingSignageGeometry([ring], school, level).getAttribute('position').count, 0);
  for (const invalid of [[], [[0, 0], [0, 0], [0, 0]], [[0, 0], [NaN, 1], [4, 0]], [[0, 0], [2, 0], [2, 2], [0, 2]]] as XY[][]) assert.equal(makeBuildingSignageGeometry([invalid], school).getAttribute('position').count, 0);
});

test('all signs occupy a bounded shared atlas and use a modest physical facade strip', () => {
  const kinds = ['school', 'kindergarten', 'hospital', 'clinic', 'medical', 'college', 'stadium', 'sports_hall', 'civic', 'library', 'train_station', 'hotel', 'office', 'retail', 'industrial', 'warehouse'];
  const slots = new Set<number>();
  assert.equal(BUILDING_SIGNAGE_ATLAS.width * BUILDING_SIGNAGE_ATLAS.height, 1024 * 1024);
  for (const className of kinds) {
    const profile = classifyBuilding({ class: className, height: 8, num_floors: 2 }), spec = getBuildingSignage(profile)!;
    assert.ok(spec); slots.add(spec.slot);
    const geometry = makeBuildingSignageGeometry([ring], profile), uv = geometry.getAttribute('uv');
    assert.equal(geometry.getAttribute('position').count, 6);
    assert.ok(geometry.userData.width <= 10); assert.ok(geometry.userData.height <= 1.35);
    for (let i = 0; i < uv.count; i++) { assert.ok(uv.getX(i) > 0 && uv.getX(i) < 1); assert.ok(uv.getY(i) > 0 && uv.getY(i) < 1); }
    geometry.dispose();
  }
  assert.equal(slots.size, 16); assert.equal(Math.max(...slots), 15);
});
