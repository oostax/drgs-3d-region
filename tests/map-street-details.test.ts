import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStreetDetails, type StreetDetailRoad } from '../src/lib/map-street-details';
import { makeRoad, worldPoint } from '../src/lib/map-life-stability';
import { getSceneTime } from '../src/lib/solar';

const center = worldPoint([49.12, 55.79]);
const local = (point: [number, number]): [number, number] => [point[0] - center[0], point[1] - center[1]];
const road = (id: string, y: number, bridge = false): StreetDetailRoad => ({ ...makeRoad(id, id, [[center[0] - 1500, center[1] + y], [center[0], center[1] + y], [center[0] + 1500, center[1] + y]], bridge ? 5 : 0), bridge });
const state = (nightAmount: number) => ({ ...getSceneTime({ timeMode: 'manual', hour: 0, life: false }), nightAmount });

test('street lighting respects mobile/desktop budgets and uses instancing without point lights', () => {
  const roads = Array.from({ length: 40 }, (_, index) => road(`road-${index}`, (index - 20) * 50, index % 3 === 0));
  for (const mobile of [false, true]) {
    const detail = createStreetDetails(roads, { mobile, center, radius: 2200, toLocal: local });
    assert.equal(detail.group.userData.lampCount, mobile ? 60 : 180); assert.ok(detail.group.children.length <= 10);
    assert.ok(detail.group.children.every((object) => object instanceof THREE.InstancedMesh)); assert.ok(!detail.group.children.some((object) => object instanceof THREE.Light));
    assert.ok(detail.group.userData.bridgeSegmentCount <= (mobile ? 35 : 100)); detail.dispose();
  }
});

test('elevation never fabricates a bridge; flagged bridge deck aligns with the traffic height', () => {
  const elevatedRoad = { ...road('hillside', 0), elevation: 120 };
  const noBridge = createStreetDetails([elevatedRoad], { mobile: false, center, radius: 2200, toLocal: local }); assert.equal(noBridge.group.userData.bridgeSegmentCount, 0); assert.equal(noBridge.group.getObjectByName('bridge-decks'), undefined); noBridge.dispose();
  const mapped = createStreetDetails([elevatedRoad, road('mapped-bridge', 50, true)], { mobile: false, center, radius: 2200, toLocal: local });
  assert.deepEqual(mapped.group.userData.bridgeRoadIds, ['mapped-bridge']); const asphalt = mapped.group.getObjectByName('bridge-asphalt') as THREE.InstancedMesh, matrix = new THREE.Matrix4();
  for (let i = 0; i < asphalt.count; i++) { asphalt.getMatrixAt(i, matrix); const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(); matrix.decompose(position, rotation, scale); assert.ok(Math.abs(position.z + scale.z / 2 - 5) < 1e-5); }
  mapped.dispose();
});

test('lamp world positions and seeded identities survive pan, origin rebase and input reordering', () => {
  const roads = Array.from({ length: 8 }, (_, index) => road(`canonical-${index}`, (index - 4) * 65));
  const first = createStreetDetails(roads, { mobile: false, center, radius: 1600, toLocal: local });
  const shifted: [number, number] = [center[0] + 18, center[1] + 11], scale = 0.998;
  const second = createStreetDetails(roads.toReversed(), { mobile: false, center: shifted, radius: 1600, toLocal: (point) => [(point[0] - shifted[0]) * scale, (point[1] - shifted[1]) * scale] });
  type Placement = { id: string; point: [number, number] };
  const before = new Map((first.group.userData.worldLamps as Placement[]).map((lamp) => [lamp.id, lamp.point]));
  const after = second.group.userData.worldLamps as Placement[]; let shared = 0;
  const poles = second.group.getObjectByName('street-lamp-poles') as THREE.InstancedMesh, matrix = new THREE.Matrix4();
  for (let i = 0; i < after.length; i++) { const lamp = after[i]; if (before.has(lamp.id)) { assert.deepEqual(lamp.point, before.get(lamp.id)); shared++; } poles.getMatrixAt(i * 2, matrix); assert.ok(Math.abs(matrix.elements[12] / scale + shifted[0] - lamp.point[0]) < 0.001); assert.ok(Math.abs(matrix.elements[13] / scale + shifted[1] - lamp.point[1]) < 0.001); }
  assert.ok(shared > 160); first.dispose(); second.dispose();
});

test('night changes shared materials without recreating geometry, and disposal is idempotent', () => {
  const detail = createStreetDetails([road('street', 0, true)], { mobile: false, center, radius: 1600, toLocal: local });
  const meshes = detail.group.children as THREE.InstancedMesh[], ids = meshes.map((mesh) => mesh.uuid), geometries = new Set(meshes.map((mesh) => mesh.geometry));
  const luminaires = detail.group.getObjectByName('street-lamp-luminaires') as THREE.InstancedMesh;
  detail.updateLighting(state(1)); assert.equal((luminaires.material as THREE.MeshStandardMaterial).emissiveIntensity, 2.3); assert.equal(detail.group.getObjectByName('street-lamp-halos')!.visible, true);
  detail.updateLighting(state(0)); assert.equal((luminaires.material as THREE.MeshStandardMaterial).emissiveIntensity, 0); assert.equal(detail.group.getObjectByName('street-lamp-halos')!.visible, false); assert.deepEqual(detail.group.children.map((mesh) => mesh.uuid), ids);
  let disposed = 0; for (const geometry of geometries) geometry.addEventListener('dispose', () => { disposed++; });
  detail.dispose(); detail.dispose(); assert.equal(disposed, geometries.size); assert.equal(detail.group.children.length, 0); assert.doesNotThrow(() => detail.updateLighting(state(1)));
});
