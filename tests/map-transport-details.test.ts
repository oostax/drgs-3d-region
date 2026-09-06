import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createTransportActors, createTransportDetails } from '../src/lib/map-transport-details';
import { ROAD_ASPHALT_COLOR, railwayKind, roadGeometryProfile, roadLaneOffset, walkablePath } from '../src/lib/map-transport-profile';
import { makeRoad, StableRoadCache, connectedRoute, roadSurfaceAt, worldPoint, pointLineDistance, type WorldPoint } from '../src/lib/map-life-stability';
import { createStreetDetails } from '../src/lib/map-street-details';
import type { LightingState } from '../src/lib/solar';

const center = worldPoint([49.12, 55.79]);
const point = (x: number, y: number): WorldPoint => [center[0] + x, center[1] + y];
const local = (p: WorldPoint): WorldPoint => [p[0] - center[0], p[1] - center[1]];
const options = { mobile: false, center, radius: 1600, zoom: 16.9, toLocal: local, elapsed: 0 };
const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();

test('source width and lanes control bridge asphalt and vehicle lanes consistently', () => {
  const profile = roadGeometryProfile({ class: 'primary', lanes: '4', width: '14 m' });
  assert.equal(profile.width, 14); assert.equal(profile.estimated, false); assert.equal(profile.lanes, 4);
  assert.equal(roadLaneOffset(profile), profile.laneWidth / 2);
  assert.ok(Math.abs(roadGeometryProfile({ class: 'minor' }).width - 6.4) < 1e-8);
  assert.equal(roadGeometryProfile({ class: 'service' }).lanes, 1);
  assert.equal(roadLaneOffset(roadGeometryProfile({ class: 'service' })), 0);
  const road = makeRoad('bridge', 'bridge', [point(-200, 0), point(200, 0)], 5, false, true, profile);
  const street = createStreetDetails([road], options), asphalt = street.group.getObjectByName('bridge-asphalt') as THREE.InstancedMesh;
  asphalt.getMatrixAt(0, matrix); matrix.decompose(position, quaternion, scale); assert.equal(scale.y, 14);
  assert.equal((asphalt.material as THREE.MeshBasicMaterial).color.getHexString(), ROAD_ASPHALT_COLOR.slice(1));
  street.updateLighting({ nightAmount: 1 } as LightingState); assert.equal((asphalt.material as THREE.MeshBasicMaterial).color.getHexString(), '383d3c');
  street.dispose();
});

test('physical road metadata survives tile tails and connected vehicle routes', () => {
  const profile = roadGeometryProfile({ class: 'primary', lanes: 4, width: 14 }), cache = new StableRoadCache();
  const first = cache.add(makeRoad('a', 'way', [point(0, 0), point(100, 0)], 0, false, false, profile));
  cache.add(makeRoad('tail', 'way', [point(50, 0), point(100, 0), point(200, 0)], 0, false, false, profile));
  assert.ok([...cache.roads.values()].every(road => road.profile?.width === 14));
  const minor = makeRoad('minor', 'minor', [point(200, 0), point(400, 0)], 0, false, false, roadGeometryProfile({ class: 'minor' }));
  const route = connectedRoute([...cache.roads.values(), minor], first, 1); assert.equal(route.profile?.width, 14);
  assert.equal(roadSurfaceAt(route, 50).profile?.width, 14); assert.ok(Math.abs(roadSurfaceAt(route, 300).profile!.width - 6.4) < 1e-8);
});

test('surface railway and pedestrian classifiers exclude tunnels, disused track and forbidden paths', () => {
  assert.equal(railwayKind({ class: 'rail', subclass: 'rail' }), 'rail');
  assert.equal(railwayKind({ class: 'transit', subclass: 'tram' }), 'tram');
  assert.equal(railwayKind({ class: 'rail', brunnel: 'tunnel' }), null);
  assert.equal(railwayKind({ class: 'rail', subclass: 'disused' }), null);
  assert.equal(walkablePath({ class: 'path', subclass: 'footway' }), true);
  assert.equal(walkablePath({ class: 'path', subclass: 'cycleway' }), false);
  assert.equal(walkablePath({ class: 'primary' }), false);
  assert.equal(walkablePath({ class: 'path', foot: 'no' }), false);
});

test('rails have real gauge, sleepers and multi-car trains follow curved source tracks without per-car draw calls', () => {
  const road = makeRoad('track', 'track', [point(-600, 0), point(0, 0), point(350, 230), point(700, 230)], 18);
  const path = makeRoad('footpath', 'footpath', [point(-600, 80), point(0, 80), point(350, 310)], 18);
  const actors = createTransportActors(), scene = createTransportDetails([road], [path], options, actors);
  assert.equal(scene.group.userData.trains, 1); assert.ok(scene.group.userData.railcars >= 3); assert.ok(scene.group.userData.pedestrians >= 10);
  assert.ok(scene.group.children.length <= 10); assert.ok(scene.group.children.every(mesh => mesh instanceof THREE.InstancedMesh && !mesh.frustumCulled));
  const rails = scene.group.getObjectByName('railway-rails') as THREE.InstancedMesh;
  rails.getMatrixAt(0, matrix); const a = new THREE.Vector3().setFromMatrixPosition(matrix);
  rails.getMatrixAt(1, matrix); const b = new THREE.Vector3().setFromMatrixPosition(matrix);
  assert.ok(Math.abs(a.distanceTo(b) - 1.52) < 1e-5);
  const bodies = scene.group.getObjectByName('train-bodies') as THREE.InstancedMesh;
  bodies.getMatrixAt(0, matrix); const start = matrix.clone(), geometryId = bodies.geometry.uuid, actor = actors.trains.values().next().value;
  scene.update(18); bodies.getMatrixAt(0, matrix); assert.notDeepEqual(matrix.elements, start.elements); assert.equal(bodies.geometry.uuid, geometryId);
  for (let i = 0; i < bodies.count; i++) { bodies.getMatrixAt(i, matrix); position.setFromMatrixPosition(matrix); assert.ok(pointLineDistance(point(position.x, position.y), road.points) < 0.001); }
  const next = createTransportDetails([road], [path], { ...options, center: point(60, 0), elapsed: 18 }, actors);
  assert.equal(actors.trains.values().next().value, actor); assert.equal(next.group.userData.railcars, scene.group.userData.railcars);
});

test('dense rail yards and walking networks obey fixed desktop/mobile geometry and actor budgets', () => {
  const tracks = Array.from({ length: 70 }, (_, i) => makeRoad(`rail-${i}`, `rail-${i}`, [point(-1400, i * 5), point(1400, i * 5)]));
  const paths = Array.from({ length: 70 }, (_, i) => makeRoad(`walk-${i}`, `walk-${i}`, [point(-1400, i * 7), point(1400, i * 7)]));
  for (const mobile of [false, true]) {
    const scene = createTransportDetails(tracks, paths, { ...options, mobile }, createTransportActors());
    assert.ok(scene.group.userData.trains <= (mobile ? 3 : 7)); assert.ok(scene.group.userData.pedestrians <= (mobile ? 90 : 260));
    assert.ok(scene.group.userData.sleepers <= (mobile ? 1700 : 5400)); assert.ok(scene.group.userData.railSegments <= (mobile ? 160 : 480));
    assert.ok(scene.group.children.length <= 10);
    const bodies = scene.group.getObjectByName('train-bodies') as THREE.InstancedMesh; scene.update(50); const state = bodies.instanceMatrix.array.slice(); scene.update(50); assert.deepEqual(bodies.instanceMatrix.array, state);
  }
});
