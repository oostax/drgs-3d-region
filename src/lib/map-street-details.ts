import * as THREE from 'three';
import { ROAD_ASPHALT_COLOR, roadGeometryProfile, type RoadGeometryProfile } from './map-transport-profile';
import type { LightingState } from './solar';
import { pointLineDistance, stableHash, worldLngLat, roadElevationAt, type StableRoad } from './map-life-stability';

type XY = [number, number];
export type StreetDetailRoad = { id: string; points: XY[]; distances: number[]; length: number; elevation: number; heightSamples?: StableRoad['heightSamples']; sections?: StableRoad['sections']; bridge?: boolean; profile?: RoadGeometryProfile };
export type StreetDetailOptions = { mobile: boolean; center: XY; radius: number; toLocal: (point: XY) => XY };
type Lamp = { id: string; roadId: string; point: XY; light: XY; angle: number; elevation: number };
type BridgeSegment = { id: string; roadId: string; a: XY; b: XY; elevation: number; elevationA: number; elevationB: number; chainage: number; metresPerWorldUnit: number; profile: RoadGeometryProfile };
type Batch = { name: string; geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] };

const LAMP_SPACING = 55;
const metresPerWorldUnit = (point: XY) => Math.max(0.1, Math.cos(worldLngLat(point)[1] * Math.PI / 180) / Math.cos(55.79 * Math.PI / 180));
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const standard = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.82, ...extra });

function sampleRoad(road: StreetDetailRoad, distance: number) {
  let index = 1; while (index < road.distances.length - 1 && road.distances[index] < distance) index++;
  const a = road.points[index - 1], b = road.points[index], ratio = Math.max(0, Math.min(1, (distance - road.distances[index - 1]) / (road.distances[index] - road.distances[index - 1] || 1)));
  return { point: [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio] as XY, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

/** Procedural radial alpha, shared by every luminaire halo and ground light pool. */
function radialTexture() {
  const width = 32, data = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const radius = Math.hypot((x + 0.5) / width * 2 - 1, (y + 0.5) / width * 2 - 1), offset = (y * width + x) * 4;
    data[offset] = 255; data[offset + 1] = 225; data[offset + 2] = 173; data[offset + 3] = Math.round(Math.max(0, 1 - radius) ** 2.3 * 255);
  }
  const texture = new THREE.DataTexture(data, width, width, THREE.RGBAFormat); texture.colorSpace = THREE.SRGBColorSpace; texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true; return texture;
}

/** Generic details anchored to canonical OSM road geometry. Dimensions are illustrative.
 * No bridge is inferred from elevation, and no landmark-specific bridge shape is invented.
 */
export function createStreetDetails(roads: StreetDetailRoad[], options: StreetDetailOptions) {
  const group = new THREE.Group(); group.name = 'atlas-street-details';
  const limit = options.mobile ? 60 : 180, bridgeLimit = options.mobile ? 35 : 100;
  const within = (point: XY, margin = 0) => Math.hypot(point[0] - options.center[0], point[1] - options.center[1]) <= options.radius + margin;
  const nearby = roads.filter((road) => road.points.length >= 2 && road.length > 0 && Number.isFinite(road.elevation) && pointLineDistance(options.center, road.points) <= options.radius + 12)
    .map((road) => ({ road, distance: pointLineDistance(options.center, road.points) })).sort((a, b) => a.distance - b.distance || a.road.id.localeCompare(b.road.id));
  const candidates: Lamp[] = [], bridges: BridgeSegment[] = [];
  const candidateLimit = limit * 40;
  for (const { road } of nearby) {
    const roadScale = metresPerWorldUnit(road.points[Math.floor(road.points.length / 2)]), profile = road.profile ?? roadGeometryProfile();
    if (road.bridge === true) for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i]; if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1 || pointLineDistance(options.center, [a, b]) > options.radius) continue;
      bridges.push({ id: `${road.id}:bridge:${i - 1}`, roadId: road.id, a, b, elevation: roadElevationAt(road, (road.distances[i - 1] + road.distances[i]) / 2), elevationA: roadElevationAt(road, road.distances[i - 1]), elevationB: roadElevationAt(road, road.distances[i]), chainage: road.distances[i - 1], metresPerWorldUnit: roadScale, profile });
    }
    if (road.length < 35 || candidates.length >= candidateLimit) continue;
    const phase = (12 + stableHash(`${road.id}:street-light-phase`) % 31) / roadScale;
    for (let chainage = phase, slot = 0; chainage < road.length - 12 / roadScale && candidates.length < candidateLimit; chainage += LAMP_SPACING / roadScale, slot++) {
      const { point, angle } = sampleRoad(road, chainage); if (!within(point, 8)) continue;
      for (const side of [-1, 1]) {
        const normal: XY = [-Math.sin(angle) * side, Math.cos(angle) * side];
        const poleOffset = (profile.width / 2 + (road.bridge ? 0.55 : 1.35)) / roadScale, lightOffset = (profile.width / 2 - 0.85) / roadScale;
        const position: XY = [point[0] + normal[0] * poleOffset, point[1] + normal[1] * poleOffset];
        const light: XY = [point[0] + normal[0] * lightOffset, point[1] + normal[1] * lightOffset];
        candidates.push({ id: `${road.id}:lamp:${slot}:${side}`, roadId: road.id, point: position, light, angle, elevation: roadElevationAt(road, chainage) });
      }
    }
  }
  // Choose an identity-stable winner at intersections before applying the viewport budget.
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  const grid = new Map<string, XY[]>(), unique: Lamp[] = [], gridSize = 9 / metresPerWorldUnit(options.center);
  for (const candidate of candidates) {
    const column = Math.floor(candidate.point[0] / gridSize), row = Math.floor(candidate.point[1] / gridSize), tolerance = 8.5 / metresPerWorldUnit(candidate.point), reach = Math.ceil(tolerance / gridSize); let collision = false;
    for (let x = column - reach; x <= column + reach && !collision; x++) for (let y = row - reach; y <= row + reach && !collision; y++) collision = (grid.get(`${x}:${y}`) ?? []).some((point) => Math.hypot(candidate.point[0] - point[0], candidate.point[1] - point[1]) < tolerance);
    if (collision) continue;
    const key = `${column}:${row}`, points = grid.get(key) ?? []; points.push(candidate.point); grid.set(key, points); unique.push(candidate);
  }
  unique.sort((a, b) => Math.hypot(a.point[0] - options.center[0], a.point[1] - options.center[1]) - Math.hypot(b.point[0] - options.center[0], b.point[1] - options.center[1]) || a.id.localeCompare(b.id));
  const lamps = unique.slice(0, limit);
  bridges.sort((a, b) => pointLineDistance(options.center, [a.a, a.b]) - pointLineDistance(options.center, [b.a, b.b]) || a.id.localeCompare(b.id));
  const bridgeSegments = bridges.slice(0, bridgeLimit);

  const box = new THREE.BoxGeometry(1, 1, 1), cylinder = new THREE.CylinderGeometry(0.075, 0.1, 1, 6).rotateX(Math.PI / 2), disc = new THREE.CircleGeometry(1, 20);
  const asphalt = new THREE.MeshBasicMaterial({ color: ROAD_ASPHALT_COLOR, toneMapped: false }), concrete = standard('#a1aaa7'), metal = standard('#74868a', { roughness: 0.62, metalness: 0.38 }), pole = standard('#54636a', { roughness: 0.67, metalness: 0.34 });
  const markings = standard('#dedfd3', { roughness: 0.93 }), seams = standard('#454f53');
  const glow = standard('#d0dbdc', { roughness: 0.38, emissive: '#ffd39a', emissiveIntensity: 0 });
  const lightTexture = radialTexture();
  const haloMaterial = new THREE.MeshBasicMaterial({ map: lightTexture, color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide });
  const poolMaterial = new THREE.MeshBasicMaterial({ map: lightTexture, color: '#ffe0a4', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const batch = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material): Batch => ({ name, geometry, material, matrices: [] });
  const deckBatch = batch('bridge-decks', box, concrete), roadBatch = batch('bridge-asphalt', box, asphalt), railBatch = batch('bridge-railings', box, metal), seamBatch = batch('bridge-seams', box, seams), lineBatch = batch('bridge-edge-lines', box, markings);
  const poleBatch = batch('street-lamp-poles', cylinder, pole), headBatch = batch('street-lamp-housings', box, pole), glowBatch = batch('street-lamp-luminaires', box, glow), haloBatch = batch('street-lamp-halos', disc, haloMaterial), poolBatch = batch('street-lamp-pools', disc, poolMaterial);
  const batches = [deckBatch, roadBatch, railBatch, seamBatch, lineBatch, poleBatch, headBatch, glowBatch, haloBatch, poolBatch];
  const object = new THREE.Object3D();
  let bridgePlane: { x: number; y: number; angle: number; slope: number } | null = null;
  const addBox = (target: Batch, x: number, y: number, z: number, width: number, depth: number, height: number, angle = 0) => { const along = bridgePlane ? (x - bridgePlane.x) * Math.cos(bridgePlane.angle) + (y - bridgePlane.y) * Math.sin(bridgePlane.angle) : 0;
    const slope = bridgePlane?.slope ?? 0, pitch = width > depth && height < 0.6 ? -Math.atan(slope) : 0;
    object.position.set(x, y, z + along * slope); object.rotation.set(0, pitch, angle); object.scale.set(width / Math.cos(pitch), depth, height); object.updateMatrix(); target.matrices.push(object.matrix.clone()); };
  const addCylinder = (from: THREE.Vector3, to: THREE.Vector3, thickness: number) => { const direction = to.clone().sub(from), length = direction.length(); if (length < 0.01) return; object.position.copy(from).add(to).multiplyScalar(0.5); object.quaternion.setFromUnitVectors(Z_AXIS, direction.normalize()); object.scale.set(thickness, thickness, length); object.updateMatrix(); poleBatch.matrices.push(object.matrix.clone()); };

  let railPosts = 0, supports = 0; const railPostLimit = options.mobile ? 240 : 800, supportLimit = options.mobile ? 40 : 120;
  for (const segment of bridgeSegments) {
    const a = options.toLocal(segment.a), b = options.toLocal(segment.b), length = Math.hypot(b[0] - a[0], b[1] - a[1]), angle = Math.atan2(b[1] - a[1], b[0] - a[0]), x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2, z = segment.elevation, roadWidth = segment.profile.width, deckWidth = roadWidth + 2;
    bridgePlane = { x, y, angle, slope: (segment.elevationB - segment.elevationA) / (length || 1) };
    addBox(deckBatch, x, y, z - 0.355, length + 0.15, deckWidth, 0.55, angle);
    addBox(roadBatch, x, y, z - 0.04, length + 0.1, roadWidth, 0.08, angle);
    for (const side of [-1, 1]) {
      const nx = -Math.sin(angle) * side, ny = Math.cos(angle) * side;
      addBox(deckBatch, x + nx * (roadWidth / 2 + 0.15), y + ny * (roadWidth / 2 + 0.15), z + 0.08, length, 0.2, 0.16, angle);
      for (const height of [0.5, 1.12]) addBox(railBatch, x + nx * (deckWidth / 2 - 0.2), y + ny * (deckWidth / 2 - 0.2), z + height, length, 0.075, 0.075, angle);
      addBox(lineBatch, x + nx * (roadWidth / 2 - 0.3), y + ny * (roadWidth / 2 - 0.3), z + 0.014, length, 0.09, 0.012, angle);
    }
    // Segment joins are road expansion seams, not arbitrary marks across surrounding land.
    addBox(seamBatch, a[0], a[1], z + 0.018, 0.065, roadWidth, 0.012, angle);
    const worldLength = Math.hypot(segment.b[0] - segment.a[0], segment.b[1] - segment.a[1]);
    const railSpacing = 10 / segment.metresPerWorldUnit, phase = (stableHash(`${segment.roadId}:rail-posts`) % 10) / segment.metresPerWorldUnit;
    for (let distance = Math.ceil((segment.chainage - phase) / railSpacing) * railSpacing + phase - segment.chainage; distance < worldLength && railPosts < railPostLimit; distance += railSpacing) {
      const ratio = distance / worldLength, world: XY = [segment.a[0] + (segment.b[0] - segment.a[0]) * ratio, segment.a[1] + (segment.b[1] - segment.a[1]) * ratio]; if (!within(world)) continue; const point = options.toLocal(world);
      railPosts += 2;
      for (const side of [-1, 1]) addBox(railBatch, point[0] - Math.sin(angle) * side * (deckWidth / 2 - 0.2), point[1] + Math.cos(angle) * side * (deckWidth / 2 - 0.2), z + 0.6, 0.075, 0.075, 1.2, angle);
    }
    // Lane positions and asphalt share the same source/class-derived physical width.
    for (let lane = 1; lane < segment.profile.lanes; lane++) {
      const offset = -roadWidth / 2 + 0.3 + lane * segment.profile.laneWidth;
      const spacing = 8 / segment.metresPerWorldUnit;
      for (let distance = Math.ceil(segment.chainage / spacing) * spacing - segment.chainage; distance < worldLength; distance += spacing) {
        const t = (distance + Math.min(3 / segment.metresPerWorldUnit, worldLength - distance) / 2) / worldLength;
        const point = options.toLocal([segment.a[0] + (segment.b[0] - segment.a[0]) * t, segment.a[1] + (segment.b[1] - segment.a[1]) * t]);
        addBox(lineBatch, point[0] - Math.sin(angle) * offset, point[1] + Math.cos(angle) * offset, z + 0.014, Math.min(3, (worldLength - distance) * segment.metresPerWorldUnit), 0.1, 0.012, angle);
      }
    }
    // DEM gives abutment elevations, not surveyed pier positions/clearance.
    // Do not invent fixed-height supports penetrating terrain or floating above it.

  }

  bridgePlane = null;
  for (const lamp of lamps) {
    const p = options.toLocal(lamp.point), light = options.toLocal(lamp.light), inward = Math.atan2(light[1] - p[1], light[0] - p[0]), height = 7.8;
    addCylinder(new THREE.Vector3(p[0], p[1], lamp.elevation), new THREE.Vector3(p[0], p[1], lamp.elevation + height), 1);
    addCylinder(new THREE.Vector3(p[0], p[1], lamp.elevation + height), new THREE.Vector3(light[0], light[1], lamp.elevation + height + 0.25), 0.62);
    addBox(headBatch, p[0], p[1], lamp.elevation + 0.09, 0.27, 0.27, 0.18, lamp.angle);
    addBox(headBatch, light[0], light[1], lamp.elevation + height + 0.22, 0.82, 0.34, 0.16, inward);
    addBox(glowBatch, light[0], light[1], lamp.elevation + height + 0.13, 0.66, 0.26, 0.055, inward);
    addBox(haloBatch, light[0], light[1], lamp.elevation + height + 0.32, 1.3, 1.3, 1, inward);
    addBox(poolBatch, light[0], light[1], lamp.elevation + 0.04, 4.5, 3.0, 1, lamp.angle);
  }
  for (const target of batches) {
    if (!target.matrices.length) continue;
    const mesh = new THREE.InstancedMesh(target.geometry, target.material, target.matrices.length); mesh.name = target.name; mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    target.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix)); mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); mesh.frustumCulled = false; if (target === haloBatch || target === poolBatch) mesh.visible = false; group.add(mesh);
  }
  group.userData = { illustrative: true, roadWidths: nearby.map(({ road }) => ({ id: road.id, ...road.profile ?? roadGeometryProfile() })), supportHeightEstimateMeters: null, lampCount: lamps.length, bridgeSegmentCount: bridgeSegments.length, worldLamps: lamps.map((lamp) => ({ id: lamp.id, point: [...lamp.point], roadId: lamp.roadId })), bridgeRoadIds: [...new Set(bridgeSegments.map((segment) => segment.roadId))] };
  let disposed = false, lastNight = -1;
  const updateLighting = (state: LightingState) => {
    if (disposed) return; const night = Math.max(0, Math.min(1, state.nightAmount)); if (Math.abs(night - lastNight) < 0.002) return; lastNight = night;
    const strength = night * night * (3 - 2 * night); asphalt.color.set(ROAD_ASPHALT_COLOR).lerp(new THREE.Color('#383d3c'), night); glow.emissiveIntensity = 2.3 * strength; glow.color.set('#d0dbdc').lerp(new THREE.Color('#ffe7bf'), strength);
    haloMaterial.opacity = strength * 0.2; poolMaterial.opacity = strength * 0.11;
    for (const name of ['street-lamp-halos', 'street-lamp-pools']) { const mesh = group.getObjectByName(name); if (mesh) mesh.visible = strength > 0.005; }
  };
  const dispose = () => {
    if (disposed) return; disposed = true; group.removeFromParent(); group.clear();
    for (const geometry of new Set(batches.map((target) => target.geometry))) geometry.dispose();
    for (const material of new Set(batches.map((target) => target.material))) material.dispose(); lightTexture.dispose();
  };
  return { group, updateLighting, dispose };
}
