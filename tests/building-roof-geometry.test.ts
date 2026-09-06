import test from 'node:test';
import assert from 'node:assert/strict';
import type { BufferGeometry } from 'three';
import { classifyBuilding } from '../src/lib/building-materials';
import { BUILDING_ROOF_VERTEX_LIMIT, makeBuildingRoofGeometry } from '../src/lib/building-roof-geometry';

type Point = [number, number];
const rectangle: Point[][] = [[[0, 0], [32, 0], [32, 18], [0, 18]]];
const shapes = ['gabled', 'hipped', 'skillion', 'barrel', 'sawtooth', 'flat'];
const range = (geometry: BufferGeometry) => {
  const attribute = geometry.getAttribute('position'), values = Array.from({ length: attribute.count }, (_, i) => attribute.getZ(i));
  return { low: Math.min(...values), high: Math.max(...values) };
};
function projectedArea(geometry: BufferGeometry) {
  const p = geometry.getAttribute('position'); let area = 0;
  for (let i = 0; i < p.count; i += 3) area += Math.abs((p.getX(i + 1) - p.getX(i)) * (p.getY(i + 2) - p.getY(i)) - (p.getY(i + 1) - p.getY(i)) * (p.getX(i + 2) - p.getX(i))) / 2;
  return area;
}
function inside(point: Point, ring: Point[]) {
  let contained = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if ((ring[i][1] > point[1]) !== (ring[j][1] > point[1]) && point[0] < (ring[j][0] - ring[i][0]) * (point[1] - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0]) contained = !contained;
  return contained;
}

test('six roof families have real silhouettes above the opaque map cap and finite upward normals', () => {
  const signatures = new Set<string>();
  for (const shape of shapes) {
    const profile = classifyBuilding({ height: 12, roof_shape: shape, class: 'apartments' });
    const geometry = makeBuildingRoofGeometry(rectangle, profile, { detailLevel: 2 });
    assert.equal(geometry.kind, shape);
    const r = range(geometry.roof);
    assert.ok(r.low > 12.05, `${shape} must clear the opaque map cap`);
    if (shape !== 'flat') assert.ok(r.high - r.low > 1.5, `${shape} needs an actual pitch`);
    else assert.ok(range(geometry.trim).high - r.low > 1.1, 'flat roof gets a visible mechanical penthouse at close range');
    assert.ok(Math.abs(projectedArea(geometry.roof) - 576) < 0.005);
    const normals = geometry.roof.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) { assert.ok(normals.getZ(i) > 0); assert.ok(Number.isFinite(normals.getX(i)) && Number.isFinite(normals.getY(i))); }
    const positions = geometry.roof.getAttribute('position');
    signatures.add(JSON.stringify(Array.from(positions.array)));
    for (const mesh of [geometry.roof, geometry.trim]) {
      assert.equal(mesh.index, null); assert.equal(mesh.getAttribute('position').count, mesh.getAttribute('normal').count); assert.equal(mesh.getAttribute('position').count, mesh.getAttribute('uv').count);
      if (mesh.getAttribute('position').count) assert.ok(range(mesh).low > 12.05);
      mesh.dispose();
    }
  }
  assert.equal(signatures.size, 6, 'roof types must differ in geometry, not only in texture');
});

test('concave footprints and courtyards stay exact for every roof shape', () => {
  const outline: Point[] = [[0, 0], [40, 0], [40, 12], [28, 12], [28, 32], [0, 32]];
  const courtyard: Point[] = [[8, 8], [8, 20], [20, 20], [20, 8]];
  for (const shape of shapes) {
    const geometry = makeBuildingRoofGeometry([outline, courtyard], classifyBuilding({ height: 18, roof_shape: shape }), { detailLevel: 2 });
    assert.ok(Math.abs(projectedArea(geometry.roof) - (1040 - 144)) < 0.02, shape);
    for (const mesh of [geometry.roof, geometry.trim]) {
      const p = mesh.getAttribute('position');
      for (let i = 0; i < p.count; i += 3) {
        const triangleArea = Math.abs((p.getX(i + 1) - p.getX(i)) * (p.getY(i + 2) - p.getY(i)) - (p.getY(i + 1) - p.getY(i)) * (p.getX(i + 2) - p.getX(i)));
        if (triangleArea < 1e-5) continue;
        const centroid: Point = [(p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3];
        assert.ok(inside(centroid, outline) && !inside(centroid, courtyard), `${shape} must never cover a courtyard or concave road gap`);
      }
      mesh.dispose();
    }
  }
});

test('roof ridges rotate with source direction and shape does not change when the footprint is translated', () => {
  const north = makeBuildingRoofGeometry(rectangle, classifyBuilding({ height: 9, roof_shape: 'gabled', roof_direction: 0 }));
  const east = makeBuildingRoofGeometry(rectangle, classifyBuilding({ height: 9, roof_shape: 'gabled', roof_direction: 90 }));
  const ridgeCoordinates = (geometry: BufferGeometry) => {
    const p = geometry.getAttribute('position'), top = range(geometry).high;
    return Array.from({ length: p.count }, (_, i) => i).filter(i => Math.abs(p.getZ(i) - top) < 1e-5).map(i => [p.getX(i), p.getY(i)]);
  };
  assert.ok(ridgeCoordinates(north.roof).every(p => Math.abs(p[1] - 9) < 0.001));
  assert.ok(ridgeCoordinates(east.roof).every(p => Math.abs(p[0] - 16) < 0.001));
  const offset = makeBuildingRoofGeometry(rectangle.map(ring => ring.map(p => [p[0] + 120, p[1] - 80] as Point)), classifyBuilding({ height: 9, roof_shape: 'gabled', roof_direction: 0 }));
  assert.equal(offset.roof.getAttribute('position').count, north.roof.getAttribute('position').count);
  assert.ok(Math.abs(projectedArea(offset.roof) - projectedArea(north.roof)) < 0.01);
  assert.equal(range(offset.roof).high, range(north.roof).high);
  for (const item of [north, east, offset]) { item.roof.dispose(); item.trim.dispose(); }
});

test('detail levels retain flat distant geometry and reserve penthouses for the close view', () => {
  const profile = classifyBuilding({ height: 30, class: 'office' });
  const far = makeBuildingRoofGeometry(rectangle, profile, { detailLevel: 0 });
  const medium = makeBuildingRoofGeometry(rectangle, profile, { detailLevel: 1 });
  const close = makeBuildingRoofGeometry(rectangle, profile, { detailLevel: 2 });
  assert.equal(far.kind, 'flat'); assert.equal(far.trim.getAttribute('position').count, 0);
  assert.ok(range(medium.trim).high - medium.eave < 0.7, 'medium detail is limited to a parapet');
  assert.ok(range(close.trim).high - close.eave > 1.1);
  for (const item of [far, medium, close]) { item.roof.dispose(); item.trim.dispose(); }
});

test('source heights are unchanged and inferred roofs do not pretend to be reconstructed religious architecture', () => {
  const religious = makeBuildingRoofGeometry(rectangle, classifyBuilding({ class: 'church', height: 14 }), { detailLevel: 2 });
  assert.equal(religious.kind, 'flat'); assert.equal(religious.estimated, true);
  const profile = classifyBuilding({ class: 'house', height: 12, roof_shape: 'gabled', roof_height: 3 });
  const explicit = makeBuildingRoofGeometry(rectangle, profile);
  assert.equal(profile.height, 12); assert.equal(profile.eaves, 9);
  assert.equal(explicit.eave, 12.09); assert.equal(explicit.rise, 3); assert.equal(explicit.estimated, true, 'lifted source roof remains an illustrative overlay');
  for (const item of [religious, explicit]) { item.roof.dispose(); item.trim.dispose(); }
});

test('source-aligned cap preserves measured roof height when map body and detail walls share its eave', () => {
  for (const shape of shapes.filter(shape => shape !== 'flat')) {
    const profile = classifyBuilding({ height: 18, roof_height: 4, roof_shape: shape });
    const geometry = makeBuildingRoofGeometry(rectangle, profile, { capHeight: profile.eaves, detailLevel: 1 });
    assert.equal(geometry.estimated, false); assert.equal(geometry.rise, 4);
    assert.ok(Math.abs(range(geometry.roof).low - 14.09) < 0.001);
    assert.ok(Math.abs(range(geometry.roof).high - 18.09) < 0.001);
    geometry.roof.dispose(); geometry.trim.dispose();
  }
});

test('complex outlines stay within the hard vertex budget without dropping projected roof coverage', () => {
  const ring: Point[] = Array.from({ length: 220 }, (_, i) => { const angle = i / 220 * Math.PI * 2, radius = i % 2 ? 21 : 22; return [Math.cos(angle) * radius, Math.sin(angle) * radius]; });
  const geometry = makeBuildingRoofGeometry([ring], classifyBuilding({ class: 'industrial', height: 10 }), { detailLevel: 2 });
  assert.ok(geometry.roof.getAttribute('position').count + geometry.trim.getAttribute('position').count <= BUILDING_ROOF_VERTEX_LIMIT);
  const expectedArea = Math.abs(ring.reduce((sum, p, i) => sum + p[0] * ring[(i + 1) % ring.length][1] - p[1] * ring[(i + 1) % ring.length][0], 0)) / 2;
  assert.ok(Math.abs(projectedArea(geometry.roof) - expectedArea) < 0.02);
  geometry.roof.dispose(); geometry.trim.dispose();
});
