import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { Feature, Polygon } from 'geojson';
import { createVegetationMask, createVegetationMeshes, inVegetationPolygon, sampleVegetation, updateVegetationLighting, vegetationAppearance, vegetationExcluded, vegetationKind, vegetationZones, type VegetationPolygon, type VegetationZone } from '../src/lib/map-vegetation';
import { worldLngLat, worldPoint, type WorldPoint } from '../src/lib/map-life-stability';
import { MapLifeLayer } from '../src/lib/map-life';
import { getLightingState } from '../src/lib/solar';

const rectangle = (x: number, y: number, width: number, height: number): VegetationPolygon => [[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]];
const zone = (x: number, y: number, width: number, height: number, kind: VegetationZone['kind'] = 'park'): VegetationZone => ({ polygon: rectangle(x, y, width, height), kind, bounds: [x, y, x + width, y + height] });

test('tree placement requires positive green evidence and excludes sports, paving and unsupported protected boundaries', () => {
  for (const properties of [{ class: 'residential' }, { class: 'school' }, { class: 'courtyard' }, { class: 'national_park' }, { class: 'nature_reserve' }]) assert.equal(vegetationKind(properties), null);
  for (const properties of [{ class: 'grass', subclass: 'garden' }, { natural: 'wood' }, { kind: 'green', greenType: 'park' }, { class: 'grass' }, { landuse: 'orchard' }]) assert.ok(vegetationKind(properties));
  for (const properties of [{ class: 'pitch' }, { class: 'stadium' }, { leisure: 'playground' }, { class: 'grass', surface: 'asphalt' }, { amenity: 'parking' }]) { assert.equal(vegetationExcluded(properties), true); assert.equal(vegetationKind(properties), null); }
});

test('long green strips crossing the viewport survive even when all vertices and the centre lie outside them', () => {
  const polygon = rectangle(-300, 15, 600, 12);
  const feature: Feature<Polygon> = { type: 'Feature', properties: { class: 'grass', subclass: 'garden' }, geometry: { type: 'Polygon', coordinates: polygon.map(ring => ring.map(worldLngLat)) } };
  const zones = vegetationZones([feature], [0, 0], 50);
  assert.equal(zones.length, 1); assert.equal(zones[0].kind, 'garden');
});

test('confirmed courtyard gardens receive trees while roofs, sports grounds, paths and unconfirmed yards stay empty', () => {
  const courtyard = rectangle(25, 25, 50, 50), building = rectangle(0, 0, 100, 100); building.push(rectangle(20, 20, 60, 60)[0]);
  const zones = [zone(25, 25, 50, 50, 'garden'), zone(120, 0, 100, 100)];
  const pitch = rectangle(130, 10, 70, 35), path: WorldPoint[] = [[120, 65], [220, 65]];
  const mask = createVegetationMask(zones, [building, pitch], [{ points: path, clearance: 3 }]);
  const candidates = sampleVegetation(zones, [100, 50], 160, 120, mask);
  assert.ok(candidates.some(tree => inVegetationPolygon(tree.point, courtyard)), 'a planted courtyard is not part of the surrounding roof polygon');
  for (const tree of candidates) { assert.ok(!inVegetationPolygon(tree.point, building)); assert.ok(!inVegetationPolygon(tree.point, pitch)); if (tree.point[0] >= 120) assert.ok(Math.abs(tree.point[1] - 65) >= 3); }
  assert.equal(sampleVegetation([], [50, 50], 100, 120, createVegetationMask([], [building], [])).length, 0, 'courtyard holes alone do not imply planted trees');
});

test('sampling spreads coverage between separate parks and preserves the same world positions after pan', () => {
  const zones = [zone(-120, -120, 240, 240, 'wood'), zone(450, 20, 80, 80, 'garden'), zone(-520, 40, 70, 90, 'park')];
  const mask = createVegetationMask(zones, [], []), first = sampleVegetation(zones, [0, 0], 800, 40, mask), after = sampleVegetation(zones, [20, 10], 800, 40, mask);
  for (const patch of zones) assert.ok(first.slice(0, 40).some(tree => inVegetationPolygon(tree.point, patch.polygon)), 'one nearby forest must not consume every render slot');
  const prior = new Map(first.map(tree => [tree.id, tree.point]));
  for (const tree of after) if (prior.has(tree.id)) assert.deepEqual(tree.point, prior.get(tree.id));
  assert.equal(new Set(first.map(tree => tree.id)).size, first.length); assert.ok(first.length <= 160);
});

test('four tree silhouettes vary deterministically in shape, size and color within six static instanced draws', () => {
  const trees = Array.from({ length: 400 }, (_, i) => ({ id: `mapped-garden:${i}`, point: [i % 20 * 12, Math.floor(i / 20) * 12] as WorldPoint, elevation: 0 }));
  const kinds = new Set(trees.map(tree => vegetationAppearance(tree.id).kind)), heights = new Set(trees.map(tree => Math.round(vegetationAppearance(tree.id).height)));
  assert.equal(kinds.size, 4); assert.ok(heights.size >= 7);
  for (const tree of trees) assert.deepEqual(vegetationAppearance(tree.id), vegetationAppearance(tree.id));
  const group = createVegetationMeshes(trees, point => point);
  assert.equal(group.children.length, 6); assert.equal(group.userData.treeCount, 400);
  const canopies = group.children.filter(child => child.name.startsWith('vegetation-canopy')) as THREE.InstancedMesh[];
  assert.equal(canopies.reduce((sum, mesh) => sum + mesh.count, 0), 400);
  for (const mesh of canopies) {
    assert.equal(mesh.instanceMatrix.usage, THREE.StaticDrawUsage);
    const reflectance = (mesh.material as THREE.MeshStandardMaterial).color;
    assert.equal(reflectance.r, reflectance.g); assert.equal(reflectance.g, reflectance.b, 'material reflectance must not multiply another green pigment');
    assert.ok(reflectance.g >= 0.3 && reflectance.g < 0.5, 'bounded diffuse reflectance preserves greens under strong shared daylight');
  }
  updateVegetationLighting(group, 1);
  for (const mesh of canopies) assert.ok((mesh.material as THREE.MeshStandardMaterial).emissiveIntensity >= 0.18, 'night leaves retain a subtle readable green fill');
  updateVegetationLighting(group, 0);
  for (const child of group.children as THREE.InstancedMesh[]) { if (child.material instanceof THREE.MeshStandardMaterial && child.name.startsWith('vegetation-canopy')) assert.ok(child.material.emissiveIntensity < 0.04); child.geometry.dispose(); (child.material as THREE.Material).dispose(); }
});

test('late DEM tiles and terrain changes refresh cached tree elevations while preserving placement', async () => {
  let terrainEnabled = true, elevation: number | null = 0;
  const center = worldPoint([49.12, 55.79]), polygon = rectangle(center[0] - 160, center[1] - 120, 320, 240);
  const layer = new MapLifeLayer({ enabled: () => true, animate: () => false, offices: () => [], banksVisible: () => false, lighting: () => getLightingState(12), mobile: true, reducedMotion: true });
  const state = layer as unknown as {
    map: unknown; data: Feature<Polygon>[]; visibleTrees: { id: string; point: WorldPoint; elevation: number }[]; vegetation: THREE.Group;
    sourceUpdated: (event: { sourceId: string; sourceDataType: string; isSourceLoaded: boolean }) => void;
    refresh: () => void; clearContent: () => void;
  };
  state.data = [{ type: 'Feature', properties: { kind: 'green', greenType: 'park' }, geometry: { type: 'Polygon', coordinates: polygon.map(ring => ring.map(worldLngLat)) } }];
  state.map = { getZoom: () => 14.1, getCenter: () => ({ lng: 49.12, lat: 55.79 }), getTerrain: () => terrainEnabled ? { source: 'regional-dem' } : null, queryTerrainElevation: () => elevation, getSource: () => ({}), querySourceFeatures: () => [], triggerRepaint() {} };
  layer.rebuild(); assert.ok(state.visibleTrees.length > 50);
  const placements = new Map(state.visibleTrees.map(tree => [tree.id, [...tree.point]]));
  const verify = (expected: number) => {
    assert.equal(state.visibleTrees.length, placements.size);
    for (const tree of state.visibleTrees) { assert.equal(tree.elevation, expected); assert.deepEqual(tree.point, placements.get(tree.id)); }
    const shadows = state.vegetation.getObjectByName('vegetation-shadows') as THREE.InstancedMesh, trunks = state.vegetation.getObjectByName('vegetation-trunks') as THREE.InstancedMesh, matrix = new THREE.Matrix4();
    shadows.getMatrixAt(0, matrix); assert.ok(Math.abs(new THREE.Vector3().setFromMatrixPosition(matrix).z - expected - 0.11) < 0.001);
    trunks.getMatrixAt(0, matrix); assert.ok(Math.abs(new THREE.Vector3().setFromMatrixPosition(matrix).z - new THREE.Vector3().setFromMatrixScale(matrix).z / 2 - expected) < 0.001);
  };
  verify(0);
  elevation = 120;
  state.sourceUpdated({ sourceId: 'regional-dem', sourceDataType: 'content', isSourceLoaded: false });
  await new Promise(resolve => setTimeout(resolve, 240));
  verify(120);
  elevation = null; layer.rebuild(); verify(120);
  terrainEnabled = false; state.refresh();
  await new Promise(resolve => setTimeout(resolve, 240));
  verify(0); state.clearContent();
});
