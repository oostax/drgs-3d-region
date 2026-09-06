import type { RoadGeometryProfile } from './map-transport-profile';

/** Geographic simulation state. None of these identities or seeds depend on the camera. */
export type WorldPoint = [number, number];
export type RoadSurfaceSection = { terrainRoad?: StableRoad; reversed?: boolean; end: number; sourceId: string; elevation: number; profile?: RoadGeometryProfile };
export type StableRoad = { terrainParent?:StableRoad; terrainOffset?:number; id: string; featureId: string; points: WorldPoint[]; distances: number[]; length: number; elevation: number; heightSamples?: { distance: number; elevation: number }[]; oneWay: boolean; bridge?: boolean; profile?: RoadGeometryProfile; sections?: RoadSurfaceSection[] };
export const WORLD_SPAN = 40075016.68557849 * Math.cos(55.79 * Math.PI / 180);
export const stableHash = (value: string) => { let n = 2166136261; for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619); return n >>> 0; };
export function seededRandom(seed: number) { return () => { seed = Math.imul(seed ^ seed >>> 15, 1 | seed); seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed); return ((seed ^ seed >>> 14) >>> 0) / 4294967296; }; }
export function worldPoint(point: readonly number[]): WorldPoint { const latitude = Math.max(-85, Math.min(85, point[1])) * Math.PI / 180; return [point[0] / 360 * WORLD_SPAN, Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / (2 * Math.PI) * WORLD_SPAN]; }
export function worldLngLat(point: WorldPoint): WorldPoint { return [point[0] / WORLD_SPAN * 360, (2 * Math.atan(Math.exp(point[1] / WORLD_SPAN * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI]; }
export function rebasePoint(point: WorldPoint, origin: WorldPoint, scale = 1): WorldPoint { return [(point[0] - origin[0]) * scale, (point[1] - origin[1]) * scale]; }
export function geometryKey(points: WorldPoint[]): string { const forward = points.map(([x, y]) => `${Math.round(x * 2)},${Math.round(y * 2)}`).join(';'), reverse = points.toReversed().map(([x, y]) => `${Math.round(x * 2)},${Math.round(y * 2)}`).join(';'); return stableHash(forward < reverse ? forward : reverse).toString(36); }
export function pointLineDistance(point: WorldPoint, points: WorldPoint[]) { let result = Infinity; for (let i = 1; i < points.length; i++) { const a = points[i - 1], b = points[i], dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); result = Math.min(result, Math.hypot(a[0] + dx * t - point[0], a[1] + dy * t - point[1])); } return result; }
export function makeRoad(id: string, featureId: string, points: WorldPoint[], elevation = 0, oneWay = false, bridge = false, profile?: RoadGeometryProfile): StableRoad { const distances = [0]; for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])); return { id, featureId, points, distances, length: distances.at(-1) ?? 0, elevation, oneWay, bridge, profile }; }
export function roadPosition(road: StableRoad, distance: number) { const d = Math.max(0, Math.min(road.length, distance)); let i = 1; while (i < road.distances.length - 1 && road.distances[i] < d) i++; const a = road.points[i - 1], b = road.points[i], t = (d - road.distances[i - 1]) / (road.distances[i] - road.distances[i - 1] || 1); return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) }; }
/** Height in metres, interpolated along the road, independent of camera/LOD. */
export function roadElevationAt(road: Pick<StableRoad, 'elevation' | 'heightSamples' | 'sections' | 'terrainParent' | 'terrainOffset'>, distance: number): number {
  if (road.terrainParent) return roadElevationAt(road.terrainParent, distance + (road.terrainOffset || 0));
  if (road.sections?.length) {
    let start = 0;
    for (const section of road.sections) {
      if (distance <= section.end) return section.terrainRoad ? roadElevationAt(section.terrainRoad, section.reversed ? section.terrainRoad.length - (distance - start) : distance - start) : section.elevation;
      start = section.end;
    }
    return road.sections.at(-1)!.elevation;
  }
  const samples = road.heightSamples;
  if (!samples?.length) return road.elevation;
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (samples[mid].distance < distance) lo = mid; else hi = mid; }
  const a = samples[lo], b = samples[hi], t = Math.max(0, Math.min(1, (distance - a.distance) / (b.distance - a.distance || 1)));
  return a.elevation + (b.elevation - a.elevation) * t;
}

/** DEM can arrive late. Missing samples retain their previous value. Bridges join
 * mapped abutments; terrain under a river is never mistaken for the deck height. */
export function updateRoadTerrain(road: StableRoad, sample: (point: WorldPoint) => number | null) {
  const divisions = road.bridge ? 1 : Math.max(1, Math.min(256, Math.ceil(road.length / 35)));
  const samples = Array.from({ length: divisions + 1 }, (_, index) => {
    const distance = road.length * index / divisions, p = roadPosition(road, distance), value = sample([p.x, p.y]);
    return { distance, elevation: value !== null && Number.isFinite(value) ? value : roadElevationAt(road, distance) };
  });
  road.heightSamples = samples; road.elevation = roadElevationAt(road, road.length / 2);
}
export function roadSurfaceAt(road: StableRoad, distance: number) { return road.sections?.find(section => distance <= section.end) ?? road.sections?.at(-1) ?? road; }
export function treeCell(column: number, row: number, size = 15) { const id = `${column}:${row}`, rng = seededRandom(stableHash(`tree:${id}`)); return { id, point: [(column + 0.28 + rng() * 0.44) * size, (row + 0.28 + rng() * 0.44) * size] as WorldPoint }; }
export function drivableRoad(properties: Record<string, unknown>) { const roadClass = properties.roadClass ?? properties.class, subclass = properties.subclass; return !['path', 'track', 'rail', 'transit', 'ferry', 'aerialway', 'runway', 'taxiway', 'pier', 'pedestrian', 'footway', 'cycleway', 'steps', 'bridleway'].includes(String(roadClass)) && !['pedestrian', 'footway', 'cycleway', 'steps', 'bridleway'].includes(String(subclass)) && properties.brunnel !== 'tunnel'; }

/** Keep the first representation of a tile fragment. Later clipping/LOD cannot move its cars. */
export class StableRoadCache {
  readonly roads = new Map<string, StableRoad>();
  private featureParts = new Map<string, Set<string>>(); private geometries = new Map<string, string>();
  private remember(road: StableRoad) { this.roads.set(road.id, road); const parts = this.featureParts.get(road.featureId) ?? new Set<string>(); parts.add(road.id); this.featureParts.set(road.featureId, parts); this.geometries.set(geometryKey(road.points), road.id); }
  private retain(known: StableRoad, incoming: StableRoad) { if (incoming.profile && (!known.profile || known.profile.estimated && !incoming.profile.estimated)) known.profile = incoming.profile; if (incoming.bridge && !known.bridge) { known.bridge = true; known.elevation = Math.max(known.elevation, incoming.elevation); } return known; }
  add(road: StableRoad) {
    if (this.roads.has(road.id)) return this.retain(this.roads.get(road.id)!, road);
    const duplicate = this.geometries.get(geometryKey(road.points)); if (duplicate && this.roads.has(duplicate)) return this.retain(this.roads.get(duplicate)!, road);
    const overlaps = [...this.featureParts.get(road.featureId) ?? []].flatMap((id) => this.roads.has(id) ? [this.roads.get(id)!] : []);
    const covered = overlaps.find((known) => road.points.every((point) => pointLineDistance(point, known.points) < 5));
    if (covered) return this.retain(covered, road);
    if (overlaps.length) {
      // New tiles may extend an existing OSM way: add only its uncovered tails.
      let part: WorldPoint[] = []; const additions: StableRoad[] = [];
      const flush = () => { if (part.length > 1) { const candidate = makeRoad(`${road.featureId}:${geometryKey(part)}`, road.featureId, part, road.elevation, road.oneWay, road.bridge, road.profile); if (candidate.length >= 2 && !this.roads.has(candidate.id)) { this.remember(candidate); additions.push(candidate); } } part = []; };
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1], b = road.points[i], dx = b[0] - a[0], dy = b[1] - a[1], squareLength = dx * dx + dy * dy || 1;
        const fractions = [0, 1];
        for (const known of overlaps) for (const point of known.points) { const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / squareLength; if (t > 0 && t < 1 && Math.hypot(a[0] + dx * t - point[0], a[1] + dy * t - point[1]) < 5) fractions.push(t); }
        fractions.sort((x, y) => x - y);
        for (let j = 1; j < fractions.length; j++) { const start = fractions[j - 1], end = fractions[j]; if (end - start < 1e-8) continue;
          const mid: WorldPoint = [a[0] + dx * (start + end) / 2, a[1] + dy * (start + end) / 2];
          if (overlaps.some((known) => pointLineDistance(mid, known.points) < 5)) flush(); else { if (!part.length) part.push([a[0] + dx * start, a[1] + dy * start]); part.push([a[0] + dx * end, a[1] + dy * end]); }
        }
      }
      flush(); return additions[0] ?? overlaps[0];
    }
    this.remember(road); return road;
  }
  prune(center: WorldPoint, radius: number, maximum: number, protectedIds = new Set<string>()) {
    const ordered = [...this.roads.values()].map((road) => ({ road, distance: pointLineDistance(center, road.points) })).sort((a, b) => a.distance - b.distance);
    for (let index = 0; index < ordered.length; index++) {
      const { road, distance } = ordered[index]; if (protectedIds.has(road.id) || index < maximum && distance <= radius) continue;
      this.roads.delete(road.id); this.geometries.delete(geometryKey(road.points)); const parts = this.featureParts.get(road.featureId); parts?.delete(road.id); if (!parts?.size) this.featureParts.delete(road.featureId);
    }
  }
}

type RoadEnd = { road: StableRoad; reversed: boolean };
type RoadGraph = { ends: Map<string, RoadEnd[]>; pieces: Map<string, StableRoad[]> };
const graphCache = new WeakMap<StableRoad[], RoadGraph>();
function endpointGraph(roads: StableRoad[]) {
  const cached = graphCache.get(roads); if (cached) return cached;
  const graph: RoadGraph = { ends: new Map(), pieces: new Map() };
  const vertices = new Map<string, { id: string; point: WorldPoint }[]>();
  for (const road of roads) for (const point of road.points) { const key = `${Math.floor(point[0] / 6)}:${Math.floor(point[1] / 6)}`, entries = vertices.get(key) ?? []; entries.push({ id: road.id, point }); vertices.set(key, entries); }
  for (const road of roads) {
    const splits = [0];
    for (let i = 1; i < road.points.length - 1; i++) {
      const point = road.points[i], column = Math.floor(point[0] / 6), row = Math.floor(point[1] / 6); let shared = false;
      for (let x = column - 1; x <= column + 1 && !shared; x++) for (let y = row - 1; y <= row + 1 && !shared; y++) shared = (vertices.get(`${x}:${y}`) ?? []).some((other) => other.id !== road.id && Math.hypot(other.point[0] - point[0], other.point[1] - point[1]) <= 6);
      if (shared) splits.push(i);
    }
    splits.push(road.points.length - 1);
    const pieces = splits.length === 2 ? [road] : splits.slice(1).map((end, i) => ({ ...makeRoad(`${road.id}:junction:${i}`, road.featureId, road.points.slice(splits[i], end + 1), road.elevation, road.oneWay, road.bridge, road.profile), terrainParent: road, terrainOffset: road.distances[splits[i]] }));
    graph.pieces.set(road.id, pieces);
    for (const piece of pieces) for (const reversed of [false, true]) {
      if (reversed && piece.oneWay) continue; const point = reversed ? piece.points.at(-1)! : piece.points[0], key = `${Math.floor(point[0] / 6)}:${Math.floor(point[1] / 6)}`;
      const entries = graph.ends.get(key) ?? []; entries.push({ road: piece, reversed }); graph.ends.set(key, entries);
    }
  }
  graphCache.set(roads, graph); return graph;
}

/** Deterministic connected walk; every join follows a shared OSM endpoint, never a map diagonal. */
export function connectedRoute(roads: StableRoad[], start: StableRoad, seed: number, reverse = false, targetLength = 1800): StableRoad {
  const graph = endpointGraph(roads);
  const pieces = graph.pieces.get(start.id);
  const first = pieces ? reverse && !start.oneWay ? pieces.at(-1)! : pieces[0] : start;
  const rng = seededRandom(stableHash(String(seed))), startPoints = reverse && !first.oneWay ? first.points.toReversed() : first.points;
  const points = [...startPoints]; const sections: RoadSurfaceSection[] = first.sections ? first.sections.map(section => ({ ...section })) : [{ end: first.length, sourceId: first.id.split(':junction:')[0], elevation: first.elevation, profile: first.profile, terrainRoad: first, reversed: reverse && !first.oneWay }]; const used = new Set([first.id]); let length = first.length, previous = first;
  for (let step = 0; step < 48 && length < targetLength; step++) {
    const end = points.at(-1)!, before = points.at(-2)!; const incoming = Math.atan2(end[1] - before[1], end[0] - before[0]);
    const adjacent: RoadEnd[] = [], column = Math.floor(end[0] / 6), row = Math.floor(end[1] / 6);
    for (let x = column - 1; x <= column + 1; x++) for (let y = row - 1; y <= row + 1; y++) adjacent.push(...graph.ends.get(`${x}:${y}`) ?? []);
    const candidates = adjacent.flatMap(({ road, reversed }) => {
      if (used.has(road.id)) return [];
      const last=sections.at(-1)!, previousHeight=last.terrainRoad?roadElevationAt(last.terrainRoad,last.reversed?0:last.terrainRoad.length):last.elevation;
      if(Math.abs(roadElevationAt(road,reversed?road.length:0)-previousHeight)>3)return [];
      const join = reversed ? road.points.at(-1)! : road.points[0]; if (Math.hypot(join[0] - end[0], join[1] - end[1]) > 6) return [];
      const line = reversed ? road.points.toReversed() : road.points, next = line[1], outgoing = Math.atan2(next[1] - join[1], next[0] - join[0]), turn = Math.abs(Math.atan2(Math.sin(outgoing - incoming), Math.cos(outgoing - incoming)));
      return turn > 2.7 ? [] : [{ road, points: line, reversed }];
    }).sort((a, b) => a.road.id.localeCompare(b.road.id));
    if (!candidates.length) break;
    const chosen = candidates[Math.floor(rng() * candidates.length)]; const gap = Math.hypot(chosen.points[0][0] - end[0], chosen.points[0][1] - end[1]); if (gap > 0.01) points.push(chosen.points[0]); points.push(...chosen.points.slice(1)); length += chosen.road.length + gap; sections.push({ end: length, sourceId: chosen.road.id.split(':junction:')[0], elevation: chosen.road.elevation, profile: chosen.road.profile, terrainRoad: chosen.road, reversed: chosen.reversed }); used.add(chosen.road.id); previous = chosen.road;
  }
  return { ...makeRoad(`route:${start.id}:${seed}`, start.featureId, points, start.elevation, true, start.bridge, start.profile), sections };
}

/** Try deterministic alternatives before committing a vehicle to a route; avoid short dead-end branches. */
export function vehicleRoute(roads: StableRoad[], start: StableRoad, seed: number, targetLength = 2200, reverseStart = false) {
  let best = connectedRoute(roads, start, seed, reverseStart, targetLength);
  for (let attempt = 1; attempt < 6 && best.length < targetLength; attempt++) { const candidate = connectedRoute(roads, start, stableHash(`${seed}:${attempt}`), !start.oneWay && attempt % 2 === 1, targetLength); if (candidate.length > best.length) best = candidate; }
  return best;
}

/** Elapsed simulation time advances only while animation is running; rebuilds never reset it. */
export class SimulationClock {
  elapsed = 0; private previous: number | null = null; private wasRunning = false;
  step(now: number, running: boolean) { if (running && this.wasRunning && this.previous !== null) this.elapsed += Math.max(0, now - this.previous) / 1000; this.previous = now; this.wasRunning = running; return this.elapsed; }
}
