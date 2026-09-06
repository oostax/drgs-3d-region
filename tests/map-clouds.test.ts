import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { cloudVisibility, createCloudGroup, createCloudMaterial, safeCloudAltitude, updateCloudView } from '../src/lib/map-clouds';
import { MapLifeLayer } from '../src/lib/map-life';
import { getLightingState } from '../src/lib/solar';

test('cloud deck clears terrain and tall roofs by hundreds of metres in every region', () => {
  for (const [terrain, roof] of [[0, 70], [160, 570], [2100, 2400], [25, 1050]]) {
    const altitude = safeCloudAltitude(terrain, roof);
    assert.ok(altitude - terrain >= 900); assert.ok(altitude - roof >= 600);
    assert.equal(safeCloudAltitude(terrain, roof, 2) - altitude, 220);
  }
});

test('soft cloud mask has dense interiors and continuous transparent edges with a bounded shared buffer', () => {
  const a = createCloudMaterial(), b = createCloudMaterial();
  const texture = a.uniforms.uDensity.value as THREE.DataTexture, second = b.uniforms.uDensity.value as THREE.DataTexture;
  assert.equal(texture.image.width, 128); assert.equal(texture.image.height, 128); assert.equal(texture.image.data!.byteLength, 65536);
  assert.equal(texture.image.data, second.image.data, 'rebuilding clouds must reuse authored pixel data');
  const pixels = texture.image.data!;
  assert.ok(pixels[(64 * 128 + 64) * 4 + 3] > 200);
  const alpha = new Set<number>(); let step = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const value = pixels[(y * 128 + x) * 4 + 3]; alpha.add(value);
    if (x === 0 || y === 0 || x === 127 || y === 127) assert.equal(value, 0);
    if (x > 0) step = Math.max(step, Math.abs(value - pixels[(y * 128 + x - 1) * 4 + 3]));
  }
  assert.ok(alpha.size > 150); assert.ok(step < 32, 'density must not have a polygon-shaped hard cutoff');
  assert.equal(a.depthTest, true); assert.equal(a.depthWrite, false); assert.equal(a.transparent, true);
  let disposal = 0; texture.addEventListener('dispose', () => disposal++); a.dispose(); assert.equal(disposal, 1); b.dispose();
});

test('cloud puffs are stable, batched and not a stack of translucent polyhedra', () => {
  const material = createCloudMaterial(), a = createCloudGroup('world:cloud:1', material), b = createCloudGroup('world:cloud:1', material);
  assert.equal(a.children.length, 1);
  const mesh = a.children[0] as THREE.Mesh, other = b.children[0] as THREE.Mesh;
  assert.equal(mesh.geometry.getAttribute('position').count, 36, 'six puffs use only twelve triangles');
  assert.deepEqual(mesh.geometry.getAttribute('position').array, other.geometry.getAttribute('position').array);
  assert.ok(Array.from(mesh.geometry.getAttribute('aSize').array).every(n => n >= 39 && n <= 90));
  mesh.geometry.dispose(); other.geometry.dispose(); material.dispose();
});

test('billboarding uses the combined map projection and survives camera rotation', () => {
  const material = createCloudMaterial();
  for (const position of [[200, -500, 750], [-450, 350, 950], [20, -80, 600]]) {
    const camera = new THREE.PerspectiveCamera(45, 1.4, 0.1, 10000); camera.up.set(0, 0, 1); camera.position.fromArray(position); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const inverse = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    const altitude = updateCloudView(material, inverse);
    const right = material.uniforms.uRight.value as THREE.Vector3, up = material.uniforms.uUp.value as THREE.Vector3;
    assert.ok(right.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)) > 0.999);
    assert.ok(up.dot(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)) > 0.999);
    assert.ok(Math.abs(altitude - position[2]) < 0.2);
    assert.ok(Math.abs(right.dot(up)) < 1e-6);
  }
  material.dispose();
});

test('clouds dissolve for close building inspection and before the camera crosses the cloud deck', () => {
  assert.ok(cloudVisibility(15.8, 58, 1700, 900) > 0.99);
  assert.equal(cloudVisibility(17.2, 58, 100, 900), 0);
  assert.equal(cloudVisibility(15.8, 58, 900, 900), 0);
  assert.equal(cloudVisibility(15.8, 0, 1700, 900), 0);
  let previous = cloudVisibility(15.8, 58, 900, 900);
  for (let altitude = 901; altitude <= 1500; altitude++) {
    const next = cloudVisibility(15.8, 58, altitude, 900); assert.ok(Math.abs(next - previous) < 0.007); previous = next;
  }
});

test('actual life rebuild raises cached sky paths over new terrain while preserving their phase', () => {
  let terrain = 240;
  const layer = new MapLifeLayer({ enabled: () => true, animate: () => false, offices: () => [], banksVisible: () => false, lighting: () => getLightingState(12), mobile: true, reducedMotion: true });
  type Moving = { id: string; altitude: number; distance: number; bornAt: number; group: THREE.Group };
  const state = layer as unknown as { map: unknown; moving: Moving[]; movingCache: Map<string, Moving>; cloudMaterial: THREE.ShaderMaterial; clearContent: () => void };
  const building = { type: 'Feature', properties: { height: 500 }, geometry: { type: 'Polygon', coordinates: [[[49.119, 55.789], [49.121, 55.789], [49.121, 55.791], [49.119, 55.791], [49.119, 55.789]]] } };
  state.map = { getZoom: () => 15.8, getCenter: () => ({ lng: 49.12, lat: 55.79 }), getTerrain: () => ({}), queryTerrainElevation: () => terrain, getSource: () => ({}), querySourceFeatures: (_source: string, options: { sourceLayer: string }) => options.sourceLayer === 'building' ? [building] : [], triggerRepaint() {} };
  layer.rebuild();
  const first = state.moving.find(item => item.id.includes(':cloud:'))!;
  assert.ok(first.altitude >= 1340);
  state.movingCache.get(first.id)!.altitude = 180;
  const texture = state.cloudMaterial.uniforms.uDensity.value as THREE.DataTexture; let disposed = 0; texture.addEventListener('dispose', () => disposed++);
  terrain = 1240; layer.rebuild();
  const second = state.moving.find(item => item.id === first.id)!;
  assert.ok(second.altitude >= 2340); assert.equal(second.distance, first.distance); assert.equal(second.bornAt, first.bornAt); assert.equal(disposed, 1);
  state.clearContent();
});
