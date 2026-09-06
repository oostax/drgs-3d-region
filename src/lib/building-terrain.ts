import { MercatorCoordinate, type ExpressionSpecification, type Map as LibreMap } from 'maplibre-gl';
import type { Feature, Geometry, Position } from 'geojson';

const SOURCE = 'atlas-buildings';
const STATE = 'atlasTerrainLift';
const EXTENT = 8192; // MapLibre v6.7.0 internal vector-tile extent.
type Tile = { z: number; x: number; y: number };
type TerrainMap = Pick<LibreMap, 'getTerrain' | 'queryTerrainElevation'>;
type TerrainFeature = Feature<Geometry> & { tile?: Tile; sourceLayer?: string };
type Placement = { sourceLayer: string; id: string; lift: number; altitudes: Map<string, number> };
const polygons = (geometry: Geometry): Position[][][] => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
const featureId = (feature: Feature) => String(feature.properties?.id ?? feature.id ?? '');
const sourceLayer = (feature: TerrainFeature) => feature.sourceLayer ?? (feature.properties?.building_id ? 'building_part' : 'building');
const keyOf = (feature: TerrainFeature) => `${sourceLayer(feature)}:${featureId(feature)}`;

/** Presentation-only foundation lift; measured height and storeys are unchanged. */
export function terrainBuildingHeight(height: ExpressionSpecification): ExpressionSpecification {
  return ['+', height, ['max', 0, ['number', ['feature-state', STATE], 0]]];
}
export function terrainBuildingBase(base: ExpressionSpecification): ExpressionSpecification {
  // Ground bodies keep MapLibre's basement. Elevated parts keep their clearance.
  return ['case', ['>', base, 0], terrainBuildingHeight(base), base];
}

/** Same vertex average as FillExtrusionBucket, including holes and excluding
 * duplicate closing points. Tile coordinates reproduce its integer floor;
 * an area centroid, bbox centre or first corner is NOT the renderer's datum.
 */
export function buildingTerrainAnchor(polygon: Position[][], tile?: Tile): [number, number] | null {
  let x = 0, y = 0, count = 0;
  const scale = tile ? 2 ** tile.z * EXTENT : 1;
  for (const ring of polygon) for (let i = 0; i < ring.length; i++) {
    const point = ring[i];
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
    if (i === ring.length - 1 && i > 0 && point[0] === ring[0][0] && point[1] === ring[0][1]) continue;
    const p = MercatorCoordinate.fromLngLat([point[0], point[1]]);
    x += tile ? Math.round(p.x * scale - tile.x * EXTENT) : p.x;
    y += tile ? Math.round(p.y * scale - tile.y * EXTENT) : p.y;
    count++;
  }
  if (!count) return null;
  const p = tile
    ? new MercatorCoordinate((tile.x * EXTENT + Math.floor(x / count)) / scale, (tile.y * EXTENT + Math.floor(y / count)) / scale)
    : new MercatorCoordinate(x / count, y / count);
  const point = p.toLngLat();
  return [point.lng, point.lat];
}

function inside(point: [number, number], ring: Position[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

/** Sample the actual footprint, including long edges and interior, not only one
 * corner. Null/nonfinite DEM is unknown, never sea level. Negative DEM is valid.
 * The bounded sampling protects against the supplied DEM, not survey accuracy.
 */
export function sampleBuildingTerrain(polygon: Position[][], map: TerrainMap, tile?: Tile) {
  if (!map.getTerrain()) return { datum: 0, lift: 0 };
  const anchor = buildingTerrainAnchor(polygon, tile);
  if (!anchor || !polygon[0]?.length) return null;
  const read = (point: [number, number]) => {
    const elevation = map.queryTerrainElevation(point);
    return typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : null;
  };
  const datum = read(anchor);
  if (datum === null) return null;
  let maximum = datum;
  const sample = (point: [number, number]) => {
    const value = read(point);
    if (value === null) return false;
    maximum = Math.max(maximum, value); return true;
  };
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const ring of polygon) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (!Number.isFinite(a[0]) || !Number.isFinite(a[1])) return null;
    west = Math.min(west, a[0]); east = Math.max(east, a[0]); south = Math.min(south, a[1]); north = Math.max(north, a[1]);
    const start = MercatorCoordinate.fromLngLat([a[0], a[1]]), end = MercatorCoordinate.fromLngLat([b[0], b[1]]);
    const length = Math.hypot(end.x - start.x, end.y - start.y) / start.meterInMercatorCoordinateUnits();
    const steps = Math.max(1, Math.min(16, Math.ceil(length / 25)));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      if (!sample([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return null;
    }
  }
  for (let x = 1; x < 5; x++) for (let y = 1; y < 5; y++) {
    const point: [number, number] = [west + (east - west) * x / 5, south + (north - south) * y / 5];
    if (inside(point, polygon[0]) && !polygon.slice(1).some(ring => inside(point, ring)) && !sample(point)) return null;
  }
  // Round upwards, not nearest: a small DEM change must not hide a roof again.
  return { datum, lift: Math.ceil(Math.max(0, maximum - datum) * 100) / 100 };
}

const controllers = new WeakMap<LibreMap, BuildingTerrainController>();
let revision = 0;
export function buildingTerrainRevision(map: LibreMap) { return controllers.get(map)?.revision ?? 0; }
export function buildingTerrainAltitudes(map: LibreMap, feature: TerrainFeature): number[] | null {
  const fragments = polygons(feature.geometry);
  if (!map.getTerrain()) return fragments.map(() => 0);
  const controller = controllers.get(map);
  if (controller) {
    const placement = controller.placements.get(keyOf(feature));
    if (!placement) return null;
    const altitudes = fragments.map(polygon => placement.altitudes.get(JSON.stringify(polygon)));
    return altitudes.every((value): value is number => typeof value === 'number' && Number.isFinite(value)) ? altitudes : null;
  }
  // Standalone use (and deterministic tests) follows exactly the same rules.
  const samples = fragments.map(polygon => sampleBuildingTerrain(polygon, map, feature.tile));
  if (samples.some(sample => sample === null)) return null;
  const lift = Math.max(0, ...samples.map(sample => sample!.lift));
  return samples.map(sample => sample!.datum + lift);
}

function samePlacements(a: Map<string, Placement>, b: Map<string, Placement>) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || other.lift !== value.lift || other.altitudes.size !== value.altitudes.size) return false;
    for (const [polygon, altitude] of value.altitudes) if (other.altitudes.get(polygon) !== altitude) return false;
  }
  return true;
}

/** Covers BOTH native extrusion layers at every source LOD, independently of
 * the much smaller decorative-mesh budget. Work is sliced, snapshots atomic.
 */
export class BuildingTerrainController {
  placements = new Map<string, Placement>();
  revision = ++revision;
  private frame: number | null = null;
  private work: Generator<void, Map<string, Placement>, unknown> | null = null;
  private dirty = false;
  private disposed = false;
  constructor(private readonly map: LibreMap) {
    map.on('sourcedata', this.sourceChanged); map.on('terrain', this.terrainChanged);
    map.on('moveend', this.schedule); map.on('resize', this.schedule); map.on('remove', this.dispose);
    this.schedule();
  }
  private sourceChanged = (event: { sourceId?: string; sourceDataType?: string }) => {
    if ((event.sourceId === SOURCE || event.sourceId === this.map.getTerrain()?.source) && event.sourceDataType !== 'metadata' && event.sourceDataType !== 'visibility') this.schedule();
  };
  private terrainChanged = () => {
    this.work?.return(new Map()); this.work = null;
    for (const placement of this.placements.values()) this.clearState(placement);
    this.placements.clear(); this.revision = ++revision; this.schedule(); this.map.triggerRepaint();
  };
  private clearState(placement: Placement) {
    try { if (this.map.getSource(SOURCE)) this.map.removeFeatureState({ source: SOURCE, sourceLayer: placement.sourceLayer, id: placement.id }, STATE); }
    catch { /* The style may already be gone when Map fires remove. */ }
  }
  private schedule = () => {
    if (this.disposed) return;
    this.dirty = true;
    if (this.frame === null) this.frame = requestAnimationFrame(this.step);
  };
  private *collect(): Generator<void, Map<string, Placement>, unknown> {
    const next = new Map<string, Placement>(), incomplete = new Set<string>();
    if (!this.map.getSource(SOURCE) || !this.map.getTerrain()) return next;
    let count = 0;
    for (const layer of ['building', 'building_part']) {
      for (const feature of this.map.querySourceFeatures(SOURCE, { sourceLayer: layer }) as TerrainFeature[]) {
        const id = featureId(feature); if (!id) continue;
        const key = `${layer}:${id}`;
        let placement = next.get(key);
        if (!placement) { placement = { sourceLayer: layer, id, lift: 0, altitudes: new Map() }; next.set(key, placement); }
        for (const polygon of polygons(feature.geometry)) {
          if (!polygon.length || polygon.reduce((sum, ring) => sum + ring.length, 0) > 12_000) { incomplete.add(key); continue; }
          const signature = JSON.stringify(polygon);
          const sample = sampleBuildingTerrain(polygon, this.map, feature.tile);
          if (!sample) { incomplete.add(key); continue; }
          placement.lift = Math.max(placement.lift, sample.lift);
          placement.altitudes.set(signature, Math.max(placement.altitudes.get(signature) ?? -Infinity, sample.datum));
          yield;
        }
        if (++count % 64 === 0) yield;
      }
    }
    for (const [key, placement] of next) {
      if (incomplete.has(key)) { placement.lift = this.placements.get(key)?.lift ?? 0; placement.altitudes.clear(); continue; }
      for (const [polygon, datum] of placement.altitudes) placement.altitudes.set(polygon, datum + placement.lift);
    }
    return next;
  }
  private step = () => {
    this.frame = null;
    if (this.disposed) return;
    if (!this.work) { this.dirty = false; this.work = this.collect(); }
    const started = performance.now();
    try {
      do {
        const step = this.work.next();
        if (step.done) {
          this.work = null;
          if (!samePlacements(this.placements, step.value)) {
            for (const [key, old] of this.placements) if (!step.value.has(key)) this.clearState(old);
            for (const [key, placement] of step.value) if (this.placements.get(key)?.lift !== placement.lift) {
              this.map.setFeatureState({ source: SOURCE, sourceLayer: placement.sourceLayer, id: placement.id }, { [STATE]: placement.lift });
            }
            this.placements = step.value; this.revision = ++revision; this.map.triggerRepaint();
          }
          break;
        }
      } while (performance.now() - started < 4);
    } catch (error) {
      this.work = null;
      // A source can disappear during a style change; other failures stay visible.
      if (this.map.getSource(SOURCE)) console.warn('Building terrain refresh failed', error);
    }
    if (this.work || this.dirty) this.frame = requestAnimationFrame(this.step);
  };
  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null; this.work?.return(new Map()); this.work = null;
    this.map.off('sourcedata', this.sourceChanged); this.map.off('terrain', this.terrainChanged);
    this.map.off('moveend', this.schedule); this.map.off('resize', this.schedule); this.map.off('remove', this.dispose);
    for (const placement of this.placements.values()) this.clearState(placement);
    this.placements.clear();
    if (controllers.get(this.map) === this) controllers.delete(this.map);
  };
}
export function installBuildingTerrain(map: LibreMap) {
  controllers.get(map)?.dispose();
  const controller = new BuildingTerrainController(map); controllers.set(map, controller);
  return controller;
}
