import * as THREE from 'three';
import { connectedRoute, pointLineDistance, roadPosition, roadSurfaceAt, roadElevationAt, seededRandom, stableHash, worldLngLat, type StableRoad, type WorldPoint } from './map-life-stability';

type Options = { mobile: boolean; center: WorldPoint; radius: number; zoom: number; toLocal: (point: WorldPoint) => WorldPoint; elapsed: number };
type Train = { id: string; route: StableRoad; cars: number; length: number; speed: number; phase: number; freight: boolean };
type Walker = { id: string; route: StableRoad; speed: number; phase: number; color: string };
export type TransportActors = { trains: Map<string, Train>; walkers: Map<string, Walker> };
export const createTransportActors = (): TransportActors => ({ trains: new Map(), walkers: new Map() });
const metres = (point: WorldPoint) => Math.cos(worldLngLat(point)[1] * Math.PI / 180) / Math.cos(55.79 * Math.PI / 180);
const material = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.86, emissive: color, emissiveIntensity: 0.12, ...extra });

/** Source track/path geometry with illustrative rolling stock and people; no live activity is implied. */
export function createTransportDetails(railways: StableRoad[], paths: StableRoad[], options: Options, actors: TransportActors) {
  const group = new THREE.Group(); group.name = 'atlas-transport-details';
  const scale = metres(options.center), railLimit = options.mobile ? 160 : 480, sleeperLimit = options.mobile ? 1700 : 5400;
  const near = (road: StableRoad, multiplier = 1) => pointLineDistance(options.center, road.points) < options.radius * multiplier;
  const ordered = (roads: StableRoad[]) => roads.filter(road => near(road)).sort((a, b) => pointLineDistance(options.center, a.points) - pointLineDistance(options.center, b.points) || a.id.localeCompare(b.id));
  const tracks = ordered(railways), walkways = ordered(paths);
  for (const [id, train] of actors.trains) if (!near(train.route, 2.5)) actors.trains.delete(id);
  for (const [id, walker] of actors.walkers) if (!near(walker.route, 2.5)) actors.walkers.delete(id);
  const trainLimit = options.mobile ? 3 : 7, walkerLimit = options.mobile ? 90 : 260;
  const trains = [...actors.trains.values()].filter(train => near(train.route)).slice(0, trainLimit);
  const trackById = new Map(railways.map(road => [road.id, road]));
  for (const train of trains) { const source = trackById.get(train.id.slice(6)); if (source) train.route.elevation = source.elevation; for (const section of train.route.sections ?? []) { const part = trackById.get(section.sourceId); if (part) section.elevation = part.elevation; } }
  for (const road of tracks) {
    if (trains.length >= trainLimit) break;
    const id = `train:${road.id}`; if (actors.trains.has(id) || road.length * scale < 170) continue;
    // Spread trains over the yard instead of placing overlapping consists on duplicate tiles.
    if (trains.some(train => train.route.featureId === road.featureId)) continue;
    const rng = seededRandom(stableHash(id)), route = connectedRoute(railways, road, stableHash(id), false, 2500 / scale);
    const freight = rng() < 0.55, length = freight ? 14 : 21, cars = Math.min(options.mobile ? 4 : 6, Math.floor(route.length * scale / (length + 1.8)) - 2);
    if (cars < 3) continue;
    const train = { id, route, cars, length, freight, speed: freight ? 5.5 : 10, phase: rng() * 2 };
    actors.trains.set(id, train); trains.push(train);
  }
  const walkers: Walker[] = [], chosen = new Set<string>(), clothing = ['#638898', '#bd765b', '#b9ad83', '#4c6269', '#75805b', '#997387', '#dbd5bd'];
  // Round-robin slots keep activity distributed across many paths, including park alleys.
  for (let slot = 0; slot < 10 && walkers.length < walkerLimit; slot++) for (const road of walkways) {
    if (walkers.length >= walkerLimit) break;
    if (road.length * scale < 12 || slot >= Math.min(10, Math.max(1, Math.floor(road.length * scale / 27)))) continue;
    const id = `walk:${road.id}:${slot}`; let walker = actors.walkers.get(id);
    if (!walker) { const rng = seededRandom(stableHash(id)); walker = { id, route: road, phase: rng() * 2, speed: 0.8 + rng() * 0.65, color: clothing[Math.floor(rng() * clothing.length)] }; actors.walkers.set(id, walker); }
    walkers.push(walker); chosen.add(id);
  }
  for (const walker of actors.walkers.values()) if (walkers.length < walkerLimit && !chosen.has(walker.id) && near(walker.route)) walkers.push(walker);
  if (actors.walkers.size > walkerLimit * 4) for (const [id] of actors.walkers) { if (actors.walkers.size <= walkerLimit * 4) break; if (!chosen.has(id)) actors.walkers.delete(id); }
  if (actors.trains.size > trainLimit * 4) for (const [id, train] of actors.trains) { if (actors.trains.size <= trainLimit * 4) break; if (!trains.includes(train)) actors.trains.delete(id); }

  const box = new THREE.BoxGeometry(1, 1, 1), object = new THREE.Object3D();
  type StaticBatch = { name: string; material: THREE.Material; matrices: THREE.Matrix4[] };
  const ballast: StaticBatch = { name: 'railway-ballast', material: material('#74736a'), matrices: [] };
  const sleepers: StaticBatch = { name: 'railway-sleepers', material: material('#595b53'), matrices: [] };
  const rails: StaticBatch = { name: 'railway-rails', material: material('#a9b2b1', { metalness: 0.5, roughness: 0.48 }), matrices: [] };
  const add = (batch: StaticBatch, x: number, y: number, z: number, length: number, width: number, height: number, angle: number) => { object.position.set(x, y, z); object.rotation.set(0, 0, angle); object.scale.set(length, width, height); object.updateMatrix(); batch.matrices.push(object.matrix.clone()); };
  let railSegments = 0;
  for (const road of tracks) for (let i = 1; i < road.points.length && railSegments < railLimit; i++) {
    const a = road.points[i - 1], b = road.points[i]; if (pointLineDistance(options.center, [a, b]) > options.radius) continue;
    const localA = options.toLocal(a), localB = options.toLocal(b), length = Math.hypot(localB[0] - localA[0], localB[1] - localA[1]); if (length < 0.3) continue;
    const angle = Math.atan2(localB[1] - localA[1], localB[0] - localA[0]), x = (localA[0] + localB[0]) / 2, y = (localA[1] + localB[1]) / 2, z = road.elevation;
    railSegments++;
    add(ballast, x, y, z + 0.045, length + 0.2, 3.5, 0.09, angle);
    for (const side of [-1, 1]) add(rails, x - Math.sin(angle) * side * 0.76, y + Math.cos(angle) * side * 0.76, z + 0.23, length + 0.1, 0.115, 0.15, angle);
    const spacing = options.zoom >= 16.8 ? 1.05 : 2.1, worldSpacing = spacing / scale;
    const start = Math.ceil(road.distances[i - 1] / worldSpacing) * worldSpacing - road.distances[i - 1], worldLength = road.distances[i] - road.distances[i - 1];
    for (let distance = start; distance < worldLength && sleepers.matrices.length < sleeperLimit; distance += worldSpacing) {
      const t = distance / worldLength, world: WorldPoint = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (Math.hypot(world[0] - options.center[0], world[1] - options.center[1]) > options.radius) continue;
      const point = options.toLocal(world); add(sleepers, point[0], point[1], z + 0.12, 0.22, 2.55, 0.12, angle);
    }
  }
  for (const batch of [ballast, sleepers, rails]) if (batch.matrices.length) {
    const mesh = new THREE.InstancedMesh(box, batch.material, batch.matrices.length); mesh.name = batch.name; mesh.frustumCulled = false;
    batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix)); mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); group.add(mesh);
  } else batch.material.dispose();
  const cars = trains.flatMap(train => Array.from({ length: train.cars }, (_, index) => ({ train, index })));
  const dynamic = (name: string, geometry: THREE.BufferGeometry, mat: THREE.Material, count: number) => { const mesh = new THREE.InstancedMesh(geometry, mat, count); mesh.name = name; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; group.add(mesh); return mesh; };
  const bodies = cars.length ? dynamic('train-bodies', box, material('#ffffff', { roughness: 0.68 }), cars.length) : null;
  const windows = cars.length ? dynamic('train-windows', box, material('#38515c', { roughness: 0.36 }), cars.length) : null;
  const roofs = cars.length ? dynamic('train-roofs', box, material('#aab3b2'), cars.length) : null;
  const bogies = cars.length ? dynamic('train-bogies', box, material('#343b3c'), cars.length * 2) : null;
  cars.forEach(({ train, index }, i) => bodies?.setColorAt(i, new THREE.Color(index === 0 ? '#985f4f' : train.freight ? ['#8c7658', '#6d8279', '#86716a'][index % 3] : '#c4d0c9')));
  const torsos = walkers.length ? dynamic('pedestrian-coats', box, material('#ffffff'), walkers.length) : null;
  const heads = walkers.length ? dynamic('pedestrian-heads', new THREE.IcosahedronGeometry(0.17, 0), material('#c0a68b'), walkers.length) : null;
  const legs = walkers.length ? dynamic('pedestrian-legs', box, material('#48545b'), walkers.length * 2) : null;
  walkers.forEach((walker, i) => torsos?.setColorAt(i, new THREE.Color(walker.color)));
  const place = (mesh: THREE.InstancedMesh | null, index: number, x: number, y: number, z: number, length: number, width: number, height: number, angle: number, swing = 0) => {
    if (!mesh) return; object.position.set(x, y, z); object.rotation.set(0, swing, angle); object.scale.set(length, width, height); object.updateMatrix(); mesh.setMatrixAt(index, object.matrix);
  };
  const update = (elapsed: number) => {
    cars.forEach(({ train, index }, i) => {
      const spacing = (train.length + 1.8) / scale, half = train.cars * spacing / 2, travel = Math.max(1, train.route.length - half * 2);
      const phase = (train.phase + elapsed * train.speed / scale / travel) % 2, direction = phase < 1 ? 1 : -1;
      const center = half + (1 - Math.abs(phase - 1)) * travel;
      const chainage = center + (index - (train.cars - 1) / 2) * spacing, point = roadPosition(train.route, chainage), [x, y] = options.toLocal([point.x, point.y]), z = roadElevationAt(train.route, chainage);
      const angle = point.angle + (direction < 0 ? Math.PI : 0), freightCar = train.freight && index > 0;
      place(bodies, i, x, y, z + 1.75, train.length, 2.9, 2.45, angle);
      place(windows, i, x, y, z + 2.35, train.length * (freightCar ? 0.06 : 0.85), 2.96, freightCar ? 0.12 : 0.66, angle);
      place(roofs, i, x, y, z + 3.05, train.length * 0.96, 2.94, 0.18, angle);
      for (const side of [-1, 1]) place(bogies, i * 2 + (side + 1) / 2, x + Math.cos(angle) * side * train.length * 0.32, y + Math.sin(angle) * side * train.length * 0.32, z + 0.56, 2.35, 2.7, 0.55, angle);
    });
    walkers.forEach((walker, i) => {
      const route = walker.route, phase = (walker.phase + elapsed * walker.speed / scale / Math.max(1, route.length)) % 2;
      const point = roadPosition(route, (1 - Math.abs(phase - 1)) * route.length), [x, y] = options.toLocal([point.x, point.y]);
      const angle = point.angle + (phase >= 1 ? Math.PI : 0), offset = (stableHash(walker.id) % 3 - 1) * 0.45;
      const px = x - Math.sin(angle) * offset, py = y + Math.cos(angle) * offset, z = roadElevationAt(route, (1 - Math.abs(phase - 1)) * route.length) + 0.1, stride = Math.sin(elapsed * 5 + walker.phase * 7);
      place(torsos, i, px, py, z + 1.05 + Math.abs(stride) * 0.025, 0.3, 0.44, 0.76, angle);
      place(heads, i, px, py, z + 1.6 + Math.abs(stride) * 0.025, 1, 1, 1, angle);
      for (const side of [-1, 1]) place(legs, i * 2 + (side + 1) / 2, px - Math.sin(angle) * side * 0.115, py + Math.cos(angle) * side * 0.115, z + 0.34, 0.16, 0.16, 0.64, angle, stride * side * 0.35);
    });
    for (const mesh of [bodies, windows, roofs, bogies, torsos, heads, legs]) if (mesh) mesh.instanceMatrix.needsUpdate = true;
  };
  update(options.elapsed);
  if (!group.children.length) box.dispose();
  group.userData = { illustrative: true, trains: trains.length, railcars: cars.length, pedestrians: walkers.length, railSegments, sleepers: sleepers.matrices.length, drawCalls: group.children.length };
  return { group, update };
}
