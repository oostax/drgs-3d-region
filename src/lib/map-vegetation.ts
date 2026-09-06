import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { seededRandom, stableHash, treeCell, worldPoint, type WorldPoint } from './map-life-stability';
import type { Feature, Geometry } from 'geojson';

export type VegetationPolygon = WorldPoint[][];
export type VegetationKind = 'wood' | 'park' | 'garden' | 'grass' | 'orchard';
type Bounds = [number, number, number, number];
export type VegetationZone = { polygon: VegetationPolygon; kind: VegetationKind; bounds: Bounds };
export type VegetationTree = { id: string; point: WorldPoint; elevation: number };
export type VegetationPath = { points: WorldPoint[]; clearance: number };
export type VegetationMask = { clear: (point: WorldPoint) => boolean; zoneAt: (point: WorldPoint) => VegetationZone | undefined };
type VegetationCandidate = { id: string; point: WorldPoint };
function drain<T>(steps: Generator<void, T, unknown>): T { let result = steps.next(); while (!result.done) result = steps.next(); return result.value; }
const token = (value: unknown) => String(value ?? '').toLowerCase();
const EXCLUDED = new Set(['pitch', 'stadium', 'track', 'playground', 'sports_centre', 'golf_course', 'parking', 'parking_space', 'plaza', 'pedestrian', 'swimming_pool', 'cemetery', 'grave_yard', 'flowerbed']);

export function vegetationExcluded(properties: Record<string, unknown>) {
  return [properties.class, properties.subclass, properties.leisure, properties.amenity, properties.landuse].some(value => EXCLUDED.has(token(value))) || ['asphalt', 'concrete', 'paved', 'paving_stones'].includes(token(properties.surface));
}

/** A courtyard, school, residential area or protected boundary alone is not evidence of greenery. */
export function vegetationKind(properties: Record<string, unknown>): VegetationKind | null {
  if (vegetationExcluded(properties)) return null;
  const values = [properties.greenType, properties.subclass, properties.class, properties.natural, properties.landuse, properties.leisure].map(token);
  if (values.some(v => ['wood', 'forest', 'tree_row'].includes(v))) return 'wood';
  if (values.includes('orchard')) return 'orchard';
  if (values.some(v => ['garden', 'allotments', 'shrubbery', 'scrub', 'plant_nursery'].includes(v))) return 'garden';
  if (values.some(v => ['park', 'village_green', 'recreation_ground'].includes(v))) return 'park';
  if (values.some(v => ['grass', 'grassland', 'meadow'].includes(v))) return 'grass';
  return properties.kind === 'green' ? 'park' : null;
}

const bounds = (points: WorldPoint[]): Bounds => points.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
const overlaps = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export function vegetationZones(features: Feature<Geometry>[], center: WorldPoint, radius: number): VegetationZone[] {
  const viewport: Bounds = [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius], result: VegetationZone[] = [], seen = new Set<string>();
  for (const feature of features) {
    const kind = vegetationKind(feature.properties ?? {}); if (!kind) continue;
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
    for (const coordinates of polygons) {
      const polygon = coordinates.map(ring => ring.map(worldPoint)); if (!polygon[0]?.length) continue;
      const box = bounds(polygon[0]); if (!overlaps(box, viewport)) continue;
      const key = `${kind}:${box.map(n => Math.round(n)).join(':')}:${polygon[0].length}`;
      if (seen.has(key)) continue; seen.add(key); result.push({ polygon, kind, bounds: box });
    }
  }
  return result;
}

function inside(point: WorldPoint, ring: WorldPoint[]) { let found = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if ((ring[i][1] > point[1]) !== (ring[j][1] > point[1]) && point[0] < (ring[j][0] - ring[i][0]) * (point[1] - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0]) found = !found; return found; }
export const inVegetationPolygon = (point: WorldPoint, polygon: VegetationPolygon) => inside(point, polygon[0]) && !polygon.slice(1).some(ring => inside(point, ring));
function segmentDistance(p: WorldPoint, a: WorldPoint, b: WorldPoint) { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t); }

/** Small spatial bins bound per-candidate work; very large regions are checked once. */
class SpatialIndex<T> {
  private bins = new Map<string, T[]>(); private broad: T[] = [];
  *addSteps(item: T, box: Bounds, checkpoint: () => boolean): Generator<void, void, unknown> {
    const left = Math.floor(box[0] / 96), right = Math.floor(box[2] / 96), bottom = Math.floor(box[1] / 96), top = Math.floor(box[3] / 96);
    if ((right - left + 1) * (top - bottom + 1) > 256) { this.broad.push(item); if (checkpoint()) yield; return; }
    for (let x = left; x <= right; x++) for (let y = bottom; y <= top; y++) { const key = `${x}:${y}`, bin = this.bins.get(key); if (bin) bin.push(item); else this.bins.set(key, [item]); if (checkpoint()) yield; }
  }
  at(point: WorldPoint) { return [...this.broad, ...this.bins.get(`${Math.floor(point[0] / 96)}:${Math.floor(point[1] / 96)}`) ?? []]; }
}

export function createVegetationMask(zones: VegetationZone[], blocked: VegetationPolygon[], paths: VegetationPath[], localScale = 1): VegetationMask {
  return drain(createVegetationMaskSteps(zones, blocked, paths, localScale));
}

export function* createVegetationMaskSteps(zones: VegetationZone[], blocked: VegetationPolygon[], paths: VegetationPath[], localScale = 1): Generator<void, VegetationMask, unknown> {
  let operations = 0; const checkpoint = () => ++operations % 128 === 0;
  const green = new SpatialIndex<VegetationZone>(), excluded = new SpatialIndex<VegetationPolygon>(), segments = new SpatialIndex<{ a: WorldPoint; b: WorldPoint; clearance: number }>();
  for (const zone of zones) yield* green.addSteps(zone, zone.bounds, checkpoint);
  const buffer = 3.5 / Math.max(0.1, localScale);
  for (const polygon of blocked) { const box = bounds(polygon[0]); yield* excluded.addSteps(polygon, [box[0] - buffer, box[1] - buffer, box[2] + buffer, box[3] + buffer], checkpoint); }
  for (const path of paths) for (let i = 1; i < path.points.length; i++) {
    const a = path.points[i - 1], b = path.points[i], clearance = path.clearance / Math.max(0.1, localScale), box = bounds([a, b]);
    yield* segments.addSteps({ a, b, clearance }, [box[0] - clearance, box[1] - clearance, box[2] + clearance, box[3] + clearance], checkpoint);
  }
  const clear = (point: WorldPoint) => !excluded.at(point).some(polygon => inVegetationPolygon(point, polygon) || polygon.some(ring => ring.some((p, i) => segmentDistance(point, p, ring[(i + 1) % ring.length]) < buffer))) && !segments.at(point).some(segment => segmentDistance(point, segment.a, segment.b) < segment.clearance);
  return { clear, zoneAt: (point: WorldPoint) => green.at(point).find(zone => inVegetationPolygon(point, zone.polygon)) };
}

/** Sample every confirmed patch before filling dense parks; no camera-dependent random seeds. */
export function sampleVegetation(zones: VegetationZone[], center: WorldPoint, radius: number, limit: number, mask: ReturnType<typeof createVegetationMask>) {
  return drain(sampleVegetationSteps(zones, center, radius, limit, mask));
}

export function* sampleVegetationSteps(zones: VegetationZone[], center: WorldPoint, radius: number, limit: number, mask: VegetationMask): Generator<void, VegetationCandidate[], unknown> {
  let operations = 0; const checkpoint = () => ++operations % 128 === 0;
  const candidates = new Map<string, { id: string; point: WorldPoint }>(), cellSize = 10;
  const sorted = [...zones].sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1])).slice(0, 360);
  const target = limit * 4, perZone = Math.max(12, Math.ceil(target / Math.max(1, sorted.length)));
  for (const zone of sorted) {
    const box: Bounds = [Math.max(zone.bounds[0], center[0] - radius), Math.max(zone.bounds[1], center[1] - radius), Math.min(zone.bounds[2], center[0] + radius), Math.min(zone.bounds[3], center[1] + radius)];
    const left = Math.floor(box[0] / cellSize), right = Math.floor(box[2] / cellSize), bottom = Math.floor(box[1] / cellSize), top = Math.floor(box[3] / cellSize);
    const cx = Math.floor((box[0] + box[2]) / 2 / cellSize), cy = Math.floor((box[1] + box[3]) / 2 / cellSize);
    let accepted = 0, attempts = 0;
    const visit = (x: number, y: number) => {
      if (x < left || x > right || y < bottom || y > top || accepted >= perZone || candidates.size >= target) return;
      attempts++; const cell = treeCell(x, y, cellSize), id = `vegetation:${cellSize}:${cell.id}`, point = cell.point;
      if (candidates.has(id) || !inVegetationPolygon(point, zone.polygon)) return;
      const cluster = seededRandom(stableHash(`grove:${Math.floor(x / 4)}:${Math.floor(y / 4)}`))();
      const density = zone.kind === 'wood' ? 0.92 : zone.kind === 'orchard' ? 0.8 : zone.kind === 'grass' ? 0.12 + cluster * 0.28 : 0.38 + cluster * 0.4;
      if (seededRandom(stableHash(`${id}:density`))() > density || !mask.clear(point)) return;
      candidates.set(id, { id, point }); accepted++;
    };
    const maxRing = Math.max(right - left, top - bottom);
    for (let ring = 0; ring <= maxRing && accepted < perZone && candidates.size < target && attempts < perZone * 35 + 160; ring++) {
      if (!ring) { visit(cx, cy); if (checkpoint()) yield; continue; }
      for (let x = cx - ring; x <= cx + ring; x++) { visit(x, cy - ring); if (checkpoint()) yield; visit(x, cy + ring); if (checkpoint()) yield; }
      for (let y = cy - ring + 1; y < cy + ring; y++) { visit(cx - ring, y); if (checkpoint()) yield; visit(cx + ring, y); if (checkpoint()) yield; }
    }
  }
  // Interleave fixed world sectors, so a central forest cannot consume every slot.
  const sectors = new Map<string, { id: string; point: WorldPoint }[]>();
  for (const tree of candidates.values()) { const key = `${Math.floor(tree.point[0] / 180)}:${Math.floor(tree.point[1] / 180)}`, group = sectors.get(key); if (group) group.push(tree); else sectors.set(key, [tree]); if (checkpoint()) yield; }
  const groups = [...sectors.values()].sort((a, b) => Math.hypot(a[0].point[0] - center[0], a[0].point[1] - center[1]) - Math.hypot(b[0].point[0] - center[0], b[0].point[1] - center[1]));
  const result: { id: string; point: WorldPoint }[] = [];
  for (let row = 0; result.length < target; row++) { let added = false; for (const group of groups) { if (group[row]) { result.push(group[row]); added = true; } if (checkpoint()) yield; } if (!added) break; }
  return result;
}

export function vegetationAppearance(id: string) {
  const rng = seededRandom(stableHash(`tree:${id}:appearance`)), kind = Math.min(3, Math.floor(rng() * 4));
  const height = (kind === 2 ? 9 : kind === 1 ? 8 : kind === 3 ? 4.5 : 6) + rng() * (kind === 3 ? 2 : 4.5);
  return { kind, height, radius: (kind === 1 ? 1.8 : kind === 3 ? 2.1 : 2.8) + rng() * 1.1, rotation: rng() * Math.PI * 2, color: ['#5a7c53', '#6c8b5d', '#466f55', '#7a965f', '#5c8064', '#708e66'][Math.floor(rng() * 6)] };
}

/** Four silhouettes, one trunk batch, one shadow batch; canopy pigment is not multiplied by green again. */
export function createVegetationMeshes(trees: VegetationTree[], toLocal: (point: WorldPoint) => WorldPoint) {
  return drain(createVegetationMeshesSteps(trees, toLocal));
}

export function* createVegetationMeshesSteps(trees: VegetationTree[], toLocal: (point: WorldPoint) => WorldPoint): Generator<void, THREE.Group, unknown> {
  const group = new THREE.Group(); group.name = 'atlas-vegetation'; group.userData.treeCount = trees.length;
  const ownedGeometry = new Set<THREE.BufferGeometry>(), ownedMaterial = new Set<THREE.Material>();
  const geometry = <T extends THREE.BufferGeometry>(value: T): T => { ownedGeometry.add(value); return value; };
  const material = <T extends THREE.Material>(value: T): T => { ownedMaterial.add(value); return value; };
  let complete = false, operations = 0; const checkpoint = () => ++operations % 128 === 0;
  try {
  const broadParts = [[-0.38, 0, 0, 0.8], [0.38, 0.08, 0.06, 0.76], [0, -0.1, 0.45, 0.72]].map(([x, y, z, scale]) => new THREE.IcosahedronGeometry(scale, 0).translate(x, y, z));
  const broad = geometry(mergeGeometries(broadParts, false)!); broadParts.forEach(part => part.dispose());
  const coniferParts = [new THREE.ConeGeometry(1, 1.6, 8).rotateX(Math.PI / 2).translate(0, 0, -0.05), new THREE.ConeGeometry(0.7, 1.5, 8).rotateX(Math.PI / 2).translate(0, 0, 0.65)];
  const conifer = geometry(mergeGeometries(coniferParts, false)!); coniferParts.forEach(part => part.dispose());
  const geometries = [broad, geometry(new THREE.SphereGeometry(1, 8, 5)), conifer, geometry(new THREE.SphereGeometry(1, 8, 4))];
  const trunk = new THREE.InstancedMesh(geometry(new THREE.CylinderGeometry(0.16, 0.25, 1, 5).rotateX(Math.PI / 2)), material(new THREE.MeshStandardMaterial({ color: '#938573', roughness: 1, emissive: '#807765', emissiveIntensity: 0.03 })), trees.length);
  const shadow = new THREE.InstancedMesh(geometry(new THREE.CircleGeometry(1, 8)), material(new THREE.MeshBasicMaterial({ color: '#435743', transparent: true, opacity: 0.12, depthWrite: false })), trees.length);
  trunk.name = 'vegetation-trunks'; shadow.name = 'vegetation-shadows';
  group.add(shadow, trunk);
  const profiles: ReturnType<typeof vegetationAppearance>[] = [], byKind: number[][] = [[], [], [], []], obj = new THREE.Object3D();
  for (let i = 0; i < trees.length; i++) { const profile = vegetationAppearance(trees[i].id); profiles.push(profile); byKind[profile.kind].push(i); if (checkpoint()) yield; }
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i], p = profiles[i], [x, y] = toLocal(tree.point), trunkHeight = p.height * 0.5;
    obj.rotation.set(0, 0, 0); obj.position.set(x, y, tree.elevation + trunkHeight / 2); obj.scale.set(1, 1, trunkHeight); obj.updateMatrix(); trunk.setMatrixAt(i, obj.matrix); if (checkpoint()) yield;
    obj.position.z = tree.elevation + 0.11; obj.scale.set(p.radius * 1.1, p.radius * 0.85, 1); obj.updateMatrix(); shadow.setMatrixAt(i, obj.matrix); if (checkpoint()) yield;
  }
  for (let kind = 0; kind < geometries.length; kind++) {
    const indices = byKind[kind];
    if (!indices.length) { geometries[kind].dispose(); ownedGeometry.delete(geometries[kind]); continue; }
    // Foliage has lower diffuse reflectance than buildings. A neutral multiplier
    // preserves pigment hue under the bright shared daylight without bleaching
    // crowns into the pale map ground or multiplying their green channel twice.
    const crownMaterial = material(new THREE.MeshStandardMaterial({ color: '#b0b0b0', roughness: 1, emissive: '#55765a', emissiveIntensity: 0.035 }));
    const crown = new THREE.InstancedMesh(geometries[kind], crownMaterial, indices.length); crown.name = `vegetation-canopy-${kind}`;
    crown.frustumCulled = false; group.add(crown);
    for (let instance = 0; instance < indices.length; instance++) {
      const index = indices[instance], tree = trees[index], p = profiles[index], [x, y] = toLocal(tree.point);
      obj.position.set(x, y, tree.elevation + p.height * 0.62); obj.rotation.set(0, 0, p.rotation); obj.scale.set(p.radius, p.radius * (kind === 1 ? 0.85 : 1), p.height * (kind === 2 ? 0.28 : 0.32)); obj.updateMatrix(); crown.setMatrixAt(instance, obj.matrix); crown.setColorAt(instance, new THREE.Color(p.color)); if (checkpoint()) yield;
    }
  }
  trunk.frustumCulled = false; shadow.frustumCulled = false; group.userData.drawCalls = group.children.length; complete = true; return group;
  } finally {
    if (!complete) { ownedGeometry.forEach(value => value.dispose()); ownedMaterial.forEach(value => value.dispose()); group.clear(); }
  }
}

export function updateVegetationLighting(group: THREE.Group, night: number) {
  const amount = Math.max(0, Math.min(1, night));
  for (const child of group.children) if (child instanceof THREE.InstancedMesh && child.material instanceof THREE.MeshStandardMaterial) child.material.emissiveIntensity = child.name.startsWith('vegetation-canopy') ? 0.035 + amount * 0.15 : 0.03 + amount * 0.06;
}
