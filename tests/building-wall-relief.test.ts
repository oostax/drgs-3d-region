import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { classifyBuilding } from '../src/lib/building-materials';
import { makeBuildingWallRelief } from '../src/lib/building-wall-relief';

type XY = [number, number];
const rectangle: XY[][] = [[[0, 0], [24, 0], [24, 16], [0, 16], [0, 0]]];
const points = (geometry: ReturnType<typeof makeBuildingWallRelief>) => {
  const positions = geometry.getAttribute('position');
  return Array.from({ length: positions.count }, (_, i) => [positions.getX(i), positions.getY(i), positions.getZ(i)]);
};

test('near residential facades have real balcony slabs and rails outside the source walls', () => {
  const profile = classifyBuilding({ class: 'apartments', height: 15, num_floors: 5 }, 384);
  const geometry = makeBuildingWallRelief(rectangle, profile, 2), vertices = points(geometry);
  assert.ok(vertices.some(([x, y, z]) => x > 2 && x < 22 && y < -0.85 && z > 3), 'upper-floor slabs project almost a metre beyond the facade');
  assert.ok(vertices.some(([x, y, z]) => x > 2 && x < 22 && y < -0.75 && Math.abs(z - 3.97) < 0.01), 'opaque balcony rails have actual vertical height');
  assert.ok(Math.max(...vertices.map(point => point[2])) < profile.eaves, 'facade relief never raises the roof or changes source heights');
  assert.equal(geometry.index, null);
  assert.deepEqual(Object.keys(geometry.attributes).sort(), ['color', 'normal', 'position']);
  assert.ok(vertices.length <= 1980 && vertices.length > 500);
  geometry.dispose();
});

test('coarse relief adds a physical cornice below the roof while disabled and tiny details allocate no faces', () => {
  const profile = classifyBuilding({ class: 'office', height: 12, num_floors: 3 }, 384);
  const coarse = makeBuildingWallRelief(rectangle, profile, 1), vertices = points(coarse);
  assert.ok(vertices.some(([, y]) => y < -0.25));
  assert.ok(vertices.every(([, , z]) => z >= profile.eaves - 0.51 && z <= profile.eaves - 0.23));
  assert.ok(vertices.length > 0 && vertices.length <= 432);
  const disabled = makeBuildingWallRelief(rectangle, profile, 0), tiny = makeBuildingWallRelief(rectangle, classifyBuilding({ class: 'house' }, 9), 2);
  assert.equal(disabled.getAttribute('position').count, 0); assert.equal(tiny.getAttribute('position').count, 0);
  coarse.dispose(); disabled.dispose(); tiny.dispose();
});

test('unknown use receives modeled bands and pilasters without assumed residential balconies', () => {
  const profile = classifyBuilding({ class: 'yes', num_floors: 4, height: 12 }, 384);
  const geometry = makeBuildingWallRelief(rectangle, profile, 2), vertices = points(geometry);
  assert.equal(profile.kind, 'neutral');
  assert.ok(vertices.some(([, y, z]) => y < -0.25 && z < 1), 'ground-to-eaves pilasters change the silhouette');
  assert.ok(vertices.some(([, y, z]) => y < -0.24 && Math.abs(z - 3.12) < 0.01), 'intermediate floor band has real depth');
  assert.ok(!vertices.some(([, y, z]) => y < -0.7 && z > 4), 'unknown use does not gain upper-floor residential balconies');
  geometry.dispose();
});

test('courtyard strips face the void regardless of ring winding and never receive balconies or entrances', () => {
  const rings: XY[][] = [[[0, 0], [40, 0], [40, 24], [0, 24], [0, 0]], [[10, 6], [30, 6], [30, 18], [10, 18], [10, 6]]];
  const profile = classifyBuilding({ class: 'apartments', height: 12, num_floors: 4 }, 720);
  for (const input of [rings, rings.map(ring => [...ring].reverse())]) {
    const geometry = makeBuildingWallRelief(input, profile, 2), vertices = points(geometry);
    assert.ok(vertices.some(([x, y, z]) => x > 10.25 && x < 10.5 && y > 5.8 && y < 18.2 && z > 11), 'left courtyard cornice projects into the hole');
    assert.ok(!vertices.some(([x, y, z]) => x > 10.7 && x < 29.3 && y > 6.7 && y < 17.3 && z < 10), 'courtyard void has no entrance canopies or balconies');
    geometry.dispose();
  }
});

test('all triangles have outward unit normals and facade dimensions are stable in world metres', () => {
  const profile = classifyBuilding({ class: 'civic', height: 14, num_floors: 4 }, 384);
  const a = makeBuildingWallRelief(rectangle, profile, 2), b = makeBuildingWallRelief(rectangle.map(ring => ring.map(([x, y]): XY => [x + 5000, y - 6000])), profile, 2);
  const positions = a.getAttribute('position'), normals = a.getAttribute('normal'), translated = b.getAttribute('position');
  assert.equal(positions.count, translated.count);
  for (let i = 0; i < positions.count; i++) {
    assert.ok(Math.abs(translated.getX(i) - positions.getX(i) - 5000) < 0.001);
    assert.ok(Math.abs(translated.getY(i) - positions.getY(i) + 6000) < 0.001);
    assert.equal(translated.getZ(i), positions.getZ(i));
    const normal = new Vector3().fromBufferAttribute(normals, i); assert.ok(Math.abs(normal.length() - 1) < 0.0001);
  }
  for (let i = 0; i < positions.count; i += 3) {
    const start = new Vector3().fromBufferAttribute(positions, i), ab = new Vector3().fromBufferAttribute(positions, i + 1).sub(start), ac = new Vector3().fromBufferAttribute(positions, i + 2).sub(start);
    const actual = ab.cross(ac).normalize(), expected = new Vector3().fromBufferAttribute(normals, i);
    assert.ok(actual.dot(expected) > 0.99, `triangle ${i / 3} is outward facing`);
  }
  a.dispose(); b.dispose();
});

test('skyscraper floors, complex outlines and elevated parts cannot exceed the geometry budget', () => {
  for (const kind of ['apartments', 'panel', 'contemporary', 'neutral', 'historic', 'stadium', 'kindergarten', 'greenhouse']) {
    const profile = classifyBuilding({ class: kind, height: 300, min_height: 6, num_floors: 100 }, 384), geometry = makeBuildingWallRelief(rectangle, profile, 2), vertices = points(geometry);
    assert.ok(vertices.length <= 1980, `${kind} has ${vertices.length} vertices`);
    assert.ok(vertices.every(point => point.every(Number.isFinite) && point[2] >= profile.base && point[2] <= profile.eaves));
    geometry.dispose();
  }
  const complex: XY[] = Array.from({ length: 480 }, (_, i) => [100 * Math.cos(i / 480 * Math.PI * 2), 100 * Math.sin(i / 480 * Math.PI * 2)]);
  const geometry = makeBuildingWallRelief([complex], classifyBuilding({ height: 15, num_floors: 5 }, 30_000), 2);
  assert.ok(geometry.getAttribute('position').count <= 1980); geometry.dispose();
});
