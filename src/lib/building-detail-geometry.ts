import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Geometry, Position } from 'geojson';
import { buildingWallUV, getBuildingRenderCap, type BuildingProfile } from './building-materials';
import { makeBuildingRoofGeometry } from './building-roof-geometry';
import { makeBuildingWallRelief } from './building-wall-relief';
import { makeBuildingSignageGeometry } from './building-signage';
type XY = [number, number];
// The base map's opaque roof cap ends at height + 0.05 m.
const ROOF_DETAIL_OFFSET = 0.08;
const ROOF_EDGE_OFFSET = 0.105;
const polygons = (geometry: Geometry): Position[][][] => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
const signedArea = (ring: XY[]) => ring.reduce((sum, point, i) => { const next = ring[(i + 1) % ring.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0) / 2;
const local = (point: Position, origin: MercatorCoordinate): XY => { const coordinate = MercatorCoordinate.fromLngLat([point[0], point[1]]), unit = origin.meterInMercatorCoordinateUnits(); return [(coordinate.x - origin.x) / unit, -(coordinate.y - origin.y) / unit]; };
export function buildingGeometryArea(geometry: Geometry) {
  return polygons(geometry).reduce((sum, polygon) => { const first = polygon[0]?.[0]; if (!first) return sum; const origin = MercatorCoordinate.fromLngLat([first[0], first[1]]); return sum + polygon.reduce((total, ring, i) => total + Math.abs(signedArea(ring.map((p) => local(p, origin)))) * (i ? -1 : 1), 0); }, 0);
}

/** Full wall UV rows match source floors; every coordinate remains in real metres. */
export function makeBuildingDetailGeometry(polygon: Position[][], profile: BuildingProfile, detailLevel: 0 | 1 | 2 = 0) {
  const first = polygon[0][0], origin = MercatorCoordinate.fromLngLat([first[0], first[1]]);
  const rings = polygon.map((ring, i) => { let points = ring.map((point) => local(point, origin)); if (points.length > 2 && Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) < 0.01) points = points.slice(0, -1); if ((signedArea(points) > 0) !== (i === 0)) points.reverse(); return points; });
  const positions: number[] = [], uvs: number[] = [], edges: number[] = [];
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy); if (length < 0.1) continue;
    const nx = dy / length * 0.035, ny = -dx / length * 0.035, uv = buildingWallUV(length, profile), ax = a[0] + nx, ay = a[1] + ny, bx = b[0] + nx, by = b[1] + ny;
    positions.push(ax, ay, profile.base, bx, by, profile.base, bx, by, profile.eaves, ax, ay, profile.base, bx, by, profile.eaves, ax, ay, profile.eaves);
    // One atlas tile is four physical floors by four window bays, not a zoom-dependent repeat.
    const shift = (profile.facadeVariant ?? 0) / 4;
    uvs.push(shift, 0, shift + uv.columns / 4, 0, shift + uv.columns / 4, uv.rows / 4, shift, 0, shift + uv.columns / 4, uv.rows / 4, shift, uv.rows / 4);
    edges.push(a[0], a[1], getBuildingRenderCap(profile) + ROOF_EDGE_OFFSET, b[0], b[1], getBuildingRenderCap(profile) + ROOF_EDGE_OFFSET);
  }
  const walls = new THREE.BufferGeometry(); walls.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); walls.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); walls.computeVertexNormals();
  const vectors = rings.map((ring) => ring.map((point) => new THREE.Vector2(...point))), triangles = THREE.ShapeUtils.triangulateShape(vectors[0], vectors.slice(1)), flattened = rings.flat(), roofPositions: number[] = [], roofUV: number[] = [];
  for (const face of triangles) for (const index of face) { const p = flattened[index]; roofPositions.push(p[0], p[1], getBuildingRenderCap(profile) + ROOF_DETAIL_OFFSET); roofUV.push(p[0] / 8, p[1] / 8); }
  let roof = new THREE.BufferGeometry(); roof.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3)); roof.setAttribute('uv', new THREE.Float32BufferAttribute(roofUV, 2)); roof.computeVertexNormals();
  const edge = new THREE.BufferGeometry(); edge.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  let relief = makeBuildingWallRelief(rings, profile, detailLevel), roofKind = 'flat', roofEstimated = true;
  if (detailLevel > 0) {
    const architecture = makeBuildingRoofGeometry(rings, profile, { detailLevel, capHeight: getBuildingRenderCap(profile) });
    roofKind = architecture.kind; roofEstimated = architecture.estimated;
    if (architecture.roof.getAttribute('position').count) { roof.dispose(); roof = architecture.roof; } else architecture.roof.dispose();
    if (architecture.trim.getAttribute('position').count) {
      architecture.trim.deleteAttribute('uv');
      coloredGeometry(architecture.trim, new THREE.Matrix4(), profile.facadeColor);
      relief = merged([relief, architecture.trim])!;
    } else architecture.trim.dispose();
  }
  const signage = makeBuildingSignageGeometry(rings, profile, detailLevel);
  return { walls, roof, edge, relief, signage, origin, roofKind, roofEstimated };
}

function coloredGeometry(geometry: THREE.BufferGeometry, transform: THREE.Matrix4, color: string) {
  geometry.applyMatrix4(transform);
  const rgb = new THREE.Color(color), count = geometry.getAttribute('position').count, colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([rgb.r, rgb.g, rgb.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}
function merged(geometries: THREE.BufferGeometry[], disposeParts = true) {
  const geometry = mergeGeometries(geometries, false);
  if (disposeParts) for (const item of geometries) item.dispose();
  return geometry;
}

export type BuildingGeometryInput = { key: string; polygons: Position[][][]; profile: BuildingProfile; detailLevel: 0 | 1 | 2; altitudes: number[]; origin: [number, number, number] };
export type BuildingGeometry = { walls: THREE.BufferGeometry[]; roofs: THREE.BufferGeometry[]; edges: THREE.BufferGeometry[]; reliefs: THREE.BufferGeometry[]; signs: THREE.BufferGeometry[]; cost: number; roofKind: string };
export const GEOMETRY_PARTS = ['walls', 'roofs', 'edges', 'reliefs', 'signs'] as const;

/** Identical metre-space geometry for the worker and the synchronous fallback. */
export function buildBuildingGeometry(input: BuildingGeometryInput): BuildingGeometry {
  const { profile, detailLevel, altitudes } = input;
  const origin = new MercatorCoordinate(...input.origin), unit = origin.meterInMercatorCoordinateUnits();
  const result: BuildingGeometry = { walls: [], roofs: [], edges: [], reliefs: [], signs: [], cost: 0, roofKind: 'flat' };
  input.polygons.forEach((polygon, index) => {
    const geometry = makeBuildingDetailGeometry(polygon, profile, detailLevel), latitudeScale = geometry.origin.meterInMercatorCoordinateUnits() / unit;
    const transform = new THREE.Matrix4().makeTranslation((geometry.origin.x - origin.x) / unit, -(geometry.origin.y - origin.y) / unit, altitudes[index] * latitudeScale).scale(new THREE.Vector3(latitudeScale, latitudeScale, latitudeScale));
    result.walls.push(coloredGeometry(geometry.walls, transform, profile.facadeColor));
    result.roofs.push(coloredGeometry(geometry.roof, transform, profile.roofColor));
    geometry.edge.applyMatrix4(transform); result.edges.push(geometry.edge);
    if (geometry.relief.getAttribute('position').count) { geometry.relief.applyMatrix4(transform); result.reliefs.push(geometry.relief); } else geometry.relief.dispose();
    if (index === 0 && geometry.signage.getAttribute('position').count) { geometry.signage.applyMatrix4(transform); result.signs.push(geometry.signage); } else geometry.signage.dispose();
    result.cost += geometry.signage.getAttribute('position').count + geometry.walls.getAttribute('position').count + geometry.roof.getAttribute('position').count + geometry.edge.getAttribute('position').count + geometry.relief.getAttribute('position').count;
    result.roofKind = geometry.roofKind;
  });
  return result;
}

type PackedAttribute = { array: Float32Array; itemSize: number; normalized: boolean };
export type PackedBuildingGeometry = { key: string; cost: number; roofKind: string; parts: Record<typeof GEOMETRY_PARTS[number], Record<string, PackedAttribute>[]> };
export function packBuildingGeometry(key: string, geometry: BuildingGeometry): PackedBuildingGeometry {
  const parts = Object.fromEntries(GEOMETRY_PARTS.map(part => [part, geometry[part].map(item => Object.fromEntries(Object.entries(item.attributes).map(([name, attribute]) => [name, { array: attribute.array as Float32Array, itemSize: attribute.itemSize, normalized: attribute.normalized }])))])) as PackedBuildingGeometry['parts'];
  return { key, cost: geometry.cost, roofKind: geometry.roofKind, parts };
}
export function unpackBuildingGeometry(packed: PackedBuildingGeometry): BuildingGeometry {
  const parts = Object.fromEntries(GEOMETRY_PARTS.map(part => [part, packed.parts[part].map(attributes => {
    const geometry = new THREE.BufferGeometry();
    for (const [name, value] of Object.entries(attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(value.array, value.itemSize, value.normalized));
    return geometry;
  })]));
  return { ...parts, cost: packed.cost, roofKind: packed.roofKind } as BuildingGeometry;
}
export function geometryTransferList(items: PackedBuildingGeometry[]): ArrayBuffer[] {
  return [...new Set(items.flatMap(item => GEOMETRY_PARTS.flatMap(part => item.parts[part].flatMap(attributes => Object.values(attributes).map(attribute => attribute.array.buffer as ArrayBuffer)))))];
}
