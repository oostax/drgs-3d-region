import { createShoreDetails } from './map-shore-details';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as LibreMap } from 'maplibre-gl';
import type { Feature, Geometry, Position } from 'geojson';
import type { BankOffice } from './types';
import type { LightingState } from './solar';
import { getBuildingLight } from './building-materials';
import { createTransportActors, createTransportDetails } from './map-transport-details';
import { roadGeometryProfile, roadLaneOffset, railwayKind, walkablePath } from './map-transport-profile';
import { createSportsDetails } from './map-sports-details';
import { createStreetDetails } from './map-street-details';
import { cloudVisibility, createCloudGroup, createCloudMaterial, safeCloudAltitude, updateCloudView } from './map-clouds';
import { createVegetationMaskSteps, createVegetationMeshesSteps, sampleVegetationSteps, updateVegetationLighting, vegetationExcluded, vegetationZones, type VegetationPath, type VegetationZone } from './map-vegetation';
import { WORLD_SPAN, worldPoint, worldLngLat, rebasePoint, geometryKey, stableHash as hash, seededRandom as random, drivableRoad, makeRoad, roadSurfaceAt, roadElevationAt, updateRoadTerrain, roadPosition as positionOnRoad, pointLineDistance, connectedRoute, vehicleRoute, StableRoadCache, SimulationClock, type StableRoad } from './map-life-stability';

type XY = [number, number];
type LocalPolygon = XY[][];
type Road = StableRoad;
type Vehicle = { id: string; sourceRoad: string; road: Road; distance: number; bornAt: number; speed: number; reverse: boolean; color: THREE.Color; type: number; pose?: THREE.Matrix4 };
type VehicleBatch = { mesh: THREE.InstancedMesh; vehicles: Vehicle[]; part: THREE.Matrix4; wheels?: boolean };
type MovingObject = { id: string; group: THREE.Group; from: XY; to: XY; speed: number; distance: number; bornAt: number; altitude: number };
type Tree = { id: string; point: XY; elevation: number };
type Options = { enabled: () => boolean; animate: () => boolean; offices: () => BankOffice[]; banksVisible: () => boolean; bankFocus?: () => boolean; lighting: () => LightingState; mobile: boolean; reducedMotion: boolean; onError?: (error: unknown) => void };

function inside(point: XY, ring: XY[]) { let found = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if ((ring[i][1] > point[1]) !== (ring[j][1] > point[1]) && point[0] < (ring[j][0] - ring[i][0]) * (point[1] - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0]) found = !found; return found; }
const inPolygon = (p: XY, poly: LocalPolygon) => inside(p, poly[0]) && !poly.slice(1).some((ring) => inside(p, ring));
function closest(p: XY, a: XY, b: XY) { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return [a[0] + t * dx, a[1] + t * dy] as XY; }
function distanceToLine(point: XY, line: XY[]) { let d = Infinity; for (let i = 1; i < line.length; i++) { const p = closest(point, line[i - 1], line[i]); d = Math.min(d, Math.hypot(p[0] - point[0], p[1] - point[1])); } return d; }
const standard = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
function mesh(parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) { const obj = new THREE.Mesh(geometry, material); obj.position.set(x, y, z); parent.add(obj); return obj; }
function cleanup(group: THREE.Object3D) { const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(); group.traverse((obj) => { if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) { geometries.add(obj.geometry); (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => materials.add(m)); } }); geometries.forEach((g) => g.dispose()); materials.forEach((m) => { if ('map' in m && m.map instanceof THREE.Texture) m.map.dispose(); m.dispose(); }); group.clear(); }

/** Illustrative urban life, never a feed of real vehicle/aircraft locations.
 * Roads and greenery use OSM geometry. Instances are bounded and local in metres.
 * Pausing keeps the scene still; hidden tabs and reduced motion never run a loop.
 */
export class MapLifeLayer implements CustomLayerInterface {
  readonly id = 'atlas-life'; readonly type = 'custom' as const; readonly renderingMode = '3d' as const;
  private map: LibreMap | null = null; private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene(); private content = new THREE.Group(); private camera = new THREE.Camera();
  private origin = MercatorCoordinate.fromLngLat([49.12, 55.79]); private scale = this.origin.meterInMercatorCoordinateUnits();
  private batches: VehicleBatch[] = []; private vehicles: Vehicle[] = []; private moving: MovingObject[] = [];
  private offices: { group: THREE.Group; id: string }[] = []; private projection: THREE.Matrix4 | null = null;
  private data: Feature<Geometry>[] = []; private timer: ReturnType<typeof setTimeout> | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null; private abort = new AbortController();
  private clock = new SimulationClock(); private worldOrigin: XY = worldPoint([49.12, 55.79]); private localScale = 1;
  private railCache = new StableRoadCache(); private pathCache = new StableRoadCache(); private transportActors = createTransportActors();
  private transportDetails: ReturnType<typeof createTransportDetails> | null = null; private sports: THREE.Group | null = null;
  private roadCache = new StableRoadCache(); private vehicleCache = new Map<string, Vehicle>(); private treeCache = new Map<string, Tree>(); private visibleTrees: Tree[] = [];
  private movingCache = new Map<string, Omit<MovingObject, 'group'>>(); private skyAnchor: XY | null = null;
  private cloudMaterial: THREE.ShaderMaterial | null = null; private cloudAltitude = 900; private vegetation: THREE.Group | null = null;
  private failed = false; private lastLighting: LightingState | null = null;
  private lastDiagnosticsAt = -Infinity; private rebuildMs = 0; private rebuildCount = 0; private rebuildSkipped = false;
  private incremental = false; private pendingBuild: MapLifeLayer | null = null; private buildTimer: ReturnType<typeof setTimeout> | null = null; private buildCancelled = false; private buildIterator: Generator<string, void, unknown> | null = null; private rebuildMaxSliceMs = 0; private rebuildSlices = 0; private rebuildStageMs: Record<string, number> = {};
  private sourceSnapshot = new Map<string, Feature<Geometry>[]>(); private lastBuildKey = ''; private terrainRevision = 0;
  private streetDetails: ReturnType<typeof createStreetDetails> | null = null;
  private sky = new THREE.HemisphereLight(0xeaf5ed, 0x6b7560, 2); private sun = new THREE.DirectionalLight(0xffefd6, 2.5);
  private readonly refresh = () => { if (this.updateTimer) clearTimeout(this.updateTimer); this.updateTimer = setTimeout(() => this.rebuild(), 180); };
  constructor(private options: Options) {}

  onAdd(map: LibreMap, gl: WebGL2RenderingContext) {
    this.map = map; this.incremental = true;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl }); this.renderer.autoClear = false;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.12;
      this.camera.matrixAutoUpdate = false; this.sky.position.set(0, 0, 1); this.scene.add(this.content, this.sky, this.sun);
      map.on('moveend', this.refresh); map.on('sourcedata', this.sourceUpdated); map.on('terrain', this.terrainUpdated);
      document.addEventListener('visibilitychange', this.visibilityChanged);
      void fetch('/data/map-life.geojson', { signal: this.abort.signal }).then((response) => response.ok ? response.json() : null).then((data) => { this.data = data?.features ?? []; this.refresh(); }).catch(() => { /* Cached basemap geometry remains available. */ });
      this.refresh();
    } catch (error) { this.failed = true; this.options.onError?.(error); }
  }
  private terrainUpdated = () => { this.terrainRevision++; this.refresh(); };
  private sourceUpdated = (event: { sourceId?: string; isSourceLoaded?: boolean; sourceDataType?: string }) => {
    const terrainSource = this.map?.getTerrain()?.source;
    if (terrainSource && event.sourceId === terrainSource && event.sourceDataType !== 'metadata' && event.sourceDataType !== 'visibility') this.terrainRevision++;
    if ((event.sourceId === 'openmaptiles' || event.sourceId === 'atlas-buildings' || terrainSource && event.sourceId === terrainSource) && event.sourceDataType !== 'metadata' && event.sourceDataType !== 'visibility') this.refresh();
  };
  private visibilityChanged = () => { if (document.hidden && this.timer) { clearTimeout(this.timer); this.timer = null; } else this.map?.triggerRepaint(); this.clock.step(performance.now(), false); };
  private local(point: Position): XY { return this.fromWorld(worldPoint(point)); }
  private fromWorld(point: XY): XY { return rebasePoint(point, this.worldOrigin, this.localScale); }
  private clearContent() { this.streetDetails?.dispose(); this.streetDetails = null; cleanup(this.content); this.cloudMaterial = null; this.vegetation = null; this.transportDetails = null; this.sports = null; }
  private terrain(point: XY, fallback = 0) {
    if (!this.map?.getTerrain()) return 0;
    const elevation = this.map.queryTerrainElevation(worldLngLat(point));
    return elevation !== null && Number.isFinite(elevation) ? elevation : fallback;
  }
  private inView(point: XY) { if (!this.map) return false; const projected = this.map.project(worldLngLat(point)), canvas = this.map.getCanvas(); return projected.x >= -80 && projected.x <= canvas.clientWidth + 80 && projected.y >= -80 && projected.y <= canvas.clientHeight + 80; }
  private query(source: string, layer: string): Feature<Geometry>[] {
    const key = `${source}:${layer}`, cached = this.sourceSnapshot.get(key); if (cached) return cached;
    if (!this.map?.getSource(source)) return [];
    try { const features = this.map.querySourceFeatures(source, { sourceLayer: layer }); this.sourceSnapshot.set(key, features); return features; } catch { return []; }
  }
  private *buildKeySteps(radius: number): Generator<string, string, unknown> {
    // Detect source changes without serializing full polygons or regenerating geometry.
    let signature = 0, inspected = 0;
    for (const [key, features] of this.sourceSnapshot) {
      let value = features.length;
      for (const feature of features) {
        const p = feature.properties ?? {}; let coordinates: unknown = 'coordinates' in feature.geometry ? feature.geometry.coordinates : [], tail = coordinates, shape = '';
        while (Array.isArray(coordinates) && Array.isArray(coordinates[0])) { shape += `:${coordinates.length}`; coordinates = coordinates[0]; }
        while (Array.isArray(tail) && Array.isArray(tail.at(-1))) tail = tail.at(-1);
        const point = coordinates as number[], end = tail as number[];
        value = (value + hash(`${feature.id ?? p.id ?? p.osm_id ?? ''}:${shape}:${point[0]}:${point[1]}:${end[0]}:${end[1]}:${p.class}:${p.subclass}:${p.width}:${p.lanes}:${p.brunnel}:${p.height}:${p.num_floors}`)) >>> 0;
        // MapLibre decodes/project coordinates lazily in feature.geometry.
        // Hashing must yield too, not just the querySourceFeatures calls.
        if (++inspected % 128 === 0) yield 'sources';
      }
      signature ^= hash(`${key}:${value}`);
    }
    const zoom = this.map!.getZoom(), band = [14.5, 15, 15.3, 16, 16.8, 17.2].filter(level => zoom >= level).length;
    return [signature, this.data.length, Math.round(this.worldOrigin[0] * this.localScale / 80), Math.round(this.worldOrigin[1] * this.localScale / 80), band, Math.round(radius), this.terrainRevision, this.map!.getTerrain()?.source ?? 'flat', this.map!.getTerrain() ? this.terrain(this.worldOrigin) : 0, this.options.banksVisible()].join(':');
  }

  private polygons(features: Feature<Geometry>[], radius: number) {
    return features.flatMap((feature) => feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : []).map((polygon) => polygon.map((ring) => ring.map((p) => worldPoint(p)))).filter((poly) => {
      if (!poly[0]?.length) return false;
      // A long green strip or building can cross the viewport without any vertex
      // or its centroid lying inside it. Bounding overlap retains that geometry.
      const xs = poly[0].map(p => p[0]), ys = poly[0].map(p => p[1]);
      return Math.min(...xs) <= this.worldOrigin[0] + radius && Math.max(...xs) >= this.worldOrigin[0] - radius && Math.min(...ys) <= this.worldOrigin[1] + radius && Math.max(...ys) >= this.worldOrigin[1] - radius;
    });
  }

  private cancelBuild() {
    const pending = this.pendingBuild; if (!pending) return;
    pending.buildCancelled = true; pending.buildIterator?.return(); pending.buildIterator = null; if (pending.buildTimer) clearTimeout(pending.buildTimer);
    pending.clearContent(); this.pendingBuild = null;
  }
  public rebuild() {
    if (!this.map || this.failed) return;
    this.cancelBuild();
    if (!this.options.enabled() || this.map.getZoom() < 14) { this.content.visible = false; this.clock.step(performance.now(), false); return; }
    // Vector tiles can finish loading while the user is dragging. Rebuilding
    // then would replace the local origin with an in-flight camera position,
    // which makes the city layer visibly slide independently of the basemap.
    // Keep the last geographic snapshot for the whole gesture; moveend already
    // schedules the fresh, settled viewport.
    if (this.map.isMoving?.()) return;
    // Build against a separate render origin and separate GPU objects. Shared
    // geographic caches retain identities; the displayed scene stays intact.
    const staged = Object.create(this) as MapLifeLayer;
    Object.assign(staged, { content: new THREE.Group(), batches: [], moving: [], offices: [], streetDetails: null, transportDetails: null, sports: null, vegetation: null, cloudMaterial: null, sourceSnapshot: new Map(), buildTimer: null, buildIterator: null, buildCancelled: false });
    this.pendingBuild = staged;
    const complete = () => {
      if (this.pendingBuild !== staged || staged.buildCancelled) return;
      const previous = this.content; this.clearContent(); this.scene.remove(previous);
      for (const field of ['content', 'origin', 'scale', 'worldOrigin', 'localScale', 'batches', 'vehicles', 'moving', 'offices', 'streetDetails', 'transportDetails', 'sports', 'vegetation', 'visibleTrees', 'cloudMaterial', 'cloudAltitude', 'skyAnchor', 'lastBuildKey', 'rebuildMs', 'rebuildMaxSliceMs', 'rebuildSlices', 'rebuildStageMs', 'rebuildCount', 'rebuildSkipped'] as const) Object.assign(this, { [field]: staged[field] });
      this.scene.add(this.content); this.lastLighting = null; this.pendingBuild = null; this.map?.triggerRepaint();
    };
    const skip = () => { if (this.pendingBuild === staged) { this.pendingBuild = null; this.rebuildSkipped = true; this.content.visible = true; } };
    try { staged.buildSnapshot(complete, skip); } catch (error) { this.cancelBuild(); this.options.onError?.(error); }
  }

  private buildSnapshot(complete: () => void, skip: () => void) {
    const work = this.snapshotStages(skip); this.buildIterator = work;
    let firstSlice = true;
    this.rebuildMs = 0; this.rebuildMaxSliceMs = 0; this.rebuildSlices = 0; this.rebuildStageMs = {};
    const run = () => {
      if (this.buildCancelled) return;
      try {
        const sliceStarted = performance.now(); let done = false, stepsInSlice = 0;
        do {
          const started = performance.now(), next = work.next(), duration = performance.now() - started, name = next.value ?? 'commit';
          this.rebuildMs += duration; this.rebuildMaxSliceMs = Math.max(this.rebuildMaxSliceMs, duration); this.rebuildSlices++; this.rebuildStageMs[name] = (this.rebuildStageMs[name] ?? 0) + duration;
          stepsInSlice++;
          done = next.done ?? false;
          if (done) { this.rebuildMaxSliceMs = Math.max(this.rebuildMaxSliceMs, performance.now() - sliceStarted); this.buildTimer = null; this.buildIterator = null; if (!this.rebuildSkipped) { this.lastLighting = null; this.rebuildCount++; complete(); } return; }
        // Yield early on entry so camera events never build a whole scene inline.
        // Later tasks consume the actual CPU budget: four cheap steps should
        // not each incur another browser timer clamp during a large snapshot.
        } while (!this.incremental || stepsInSlice < (firstSlice ? 4 : 64) && performance.now() - sliceStarted < (this.options.mobile ? 5 : 7));
        firstSlice = false;
        this.rebuildMaxSliceMs = Math.max(this.rebuildMaxSliceMs, performance.now() - sliceStarted);
        this.buildTimer = setTimeout(run, 0);
      } catch (error) { this.clearContent(); this.buildCancelled = true; skip(); this.options.onError?.(error); }
    };
    run();
  }

  private *snapshotStages(skip: () => void): Generator<string, void, unknown> {
    const map = this.map; if (!map || this.failed) return;
    this.sourceSnapshot.clear(); this.rebuildSkipped = false;
    if (map.getZoom() < 14 || !this.options.enabled()) { this.content.visible = false; this.clock.step(performance.now(), false); return; }
    // Geometry stays in world coordinates. Only the render origin changes with the camera.
    const previousOrigin = this.origin, previousScale = this.scale, previousWorldOrigin = this.worldOrigin, previousLocalScale = this.localScale;
    this.origin = MercatorCoordinate.fromLngLat(map.getCenter()); this.scale = this.origin.meterInMercatorCoordinateUnits();
    this.worldOrigin = worldPoint([map.getCenter().lng, map.getCenter().lat]); this.localScale = 1 / (WORLD_SPAN * this.scale);
    const radius = (this.options.mobile ? 1700 : 2500) / this.localScale;
    if (this.options.bankFocus?.()) {
      this.lastBuildKey = ''; this.clearContent(); this.content.visible = true; this.batches = []; this.vehicles = []; this.moving = []; this.offices = [];
      this.clock.step(performance.now(), false);
      if (this.options.banksVisible() && map.getZoom() >= 15) {
        const buildings = this.polygons(this.query('atlas-buildings', 'building'), radius);
        this.createOffices(buildings.map(polygon => polygon.map(ring => ring.map(point => this.fromWorld(point)))), radius * this.localScale);
      }
      this.lastLighting = null; yield 'offices'; return;
    }
    for (const [source, layer] of [['openmaptiles', 'transportation'], ['openmaptiles', 'landuse'], ['openmaptiles', 'landcover'], ['openmaptiles', 'park'], ['openmaptiles', 'water'], ['atlas-buildings', 'building'], ['atlas-buildings', 'building_part']]) { this.query(source, layer); yield 'sources'; }
    const key = yield* this.buildKeySteps(radius);
    if (key === this.lastBuildKey && this.content.visible) {
      this.origin = previousOrigin; this.scale = previousScale; this.worldOrigin = previousWorldOrigin; this.localScale = previousLocalScale;
      this.rebuildSkipped = true; skip(); map.triggerRepaint(); return;
    }
    this.lastBuildKey = key; yield 'sources';
    const retention = radius * 2.5;
    const publicRoads = this.data.filter((f) => f.properties?.kind === 'road');
    const transportation = this.query('openmaptiles', 'transportation');
    let roadWork = 0;
    for (const feature of [...publicRoads, ...transportation]) {
      if (++roadWork % 96 === 0) yield 'roads';
      const p = feature.properties ?? {}; if (!drivableRoad(p)) continue;
      const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [];
      const featureId = String(p.id ?? p.osm_id ?? feature.id ?? `geometry:${geometryKey(lines.flatMap((line) => line.map(worldPoint)))}`);
      for (const line of lines) {
        let points = line.map(worldPoint); if (points.length < 2 || pointLineDistance(this.worldOrigin, points) > radius) continue;
        if (p.oneway === -1 || p.oneway === '-1') points = points.toReversed();
        const id = `${featureId}:${geometryKey(points)}`;
        const bridge = p.brunnel === 'bridge' || p.bridge === true || p.bridge === 'yes' || p.bridge === 1;
        const road = makeRoad(id, featureId, points, this.terrain(points[Math.floor(points.length / 2)]), p.oneway === true || p.oneway === 1 || p.oneway === '1' || p.oneway === 'yes' || p.oneway === -1 || p.oneway === '-1', bridge, roadGeometryProfile(p));
        if (road.length >= 2 && road.length < 16000) this.roadCache.add(road);
      }
    }
    for (const feature of transportation) {
      if (++roadWork % 96 === 0) yield 'roads';
      const p = feature.properties ?? {}, rail = railwayKind(p), walking = walkablePath(p); if (!rail && !walking) continue;
      const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [];
      for (const line of lines) {
        const points = line.map(worldPoint); if (points.length < 2 || pointLineDistance(this.worldOrigin, points) > radius) continue;
        const featureId = String(p.id ?? p.osm_id ?? feature.id ?? `geometry:${geometryKey(points)}`), id = `${rail ? 'rail' : 'path'}:${featureId}:${geometryKey(points)}`;
        const bridge = p.brunnel === 'bridge' || p.bridge === 'yes';
        const route = makeRoad(id, featureId, points, this.terrain(points[Math.floor(points.length / 2)]), false, bridge);
        if (route.length > 2 && route.length < 16000) (rail ? this.railCache : this.pathCache).add(route);
      }
    }
    this.railCache.prune(this.worldOrigin, retention, this.options.mobile ? 240 : 700);
    this.pathCache.prune(this.worldOrigin, retention, this.options.mobile ? 450 : 1400);
    // Terrain may finish loading after the vector lines. Refresh cached ground heights too.
    for (const cache of [this.roadCache, this.railCache, this.pathCache]) for (const route of cache.roads.values()) { updateRoadTerrain(route, point => this.map?.getTerrain() ? this.map.queryTerrainElevation(worldLngLat(point)) : 0); if (++roadWork % 32 === 0) yield 'roads'; }
    this.roadCache.prune(this.worldOrigin, retention, this.options.mobile ? 700 : 2200);
    const roads = [...this.roadCache.roads.values()];
    yield 'roads';
    for (const vehicle of this.vehicleCache.values()) { const source = this.roadCache.roads.get(vehicle.sourceRoad); if (source) vehicle.road.elevation = source.elevation; for (const section of vehicle.road.sections ?? []) { const part = this.roadCache.roads.get(section.sourceId); if (part) { section.elevation = part.elevation; section.profile = part.profile; } } }
    for (const [id, vehicle] of this.vehicleCache) if (!this.roadCache.roads.has(vehicle.sourceRoad) || pointLineDistance(this.worldOrigin, vehicle.road.points) > retention) this.vehicleCache.delete(id);
    // Newly loaded adjacent tiles can extend only the route tail; its existing prefix and phase stay unchanged.
    for (const vehicle of this.vehicleCache.values()) if (vehicle.road.length < 1600) { const extended = connectedRoute(roads, vehicle.road, hash(`${vehicle.id}:extension`), false, 2200); if (extended.length > vehicle.road.length + 12) vehicle.road = { ...extended, id: vehicle.road.id }; }
    const nearby = roads.filter((road) => pointLineDistance(this.worldOrigin, road.points) < radius).sort((a, b) => pointLineDistance(this.worldOrigin, a.points) - pointLineDistance(this.worldOrigin, b.points) || a.id.localeCompare(b.id));
    const maximum = this.options.mobile ? 90 : 280;
    const retained = this.vehicles.filter((vehicle) => this.vehicleCache.has(vehicle.id) && pointLineDistance(this.worldOrigin, vehicle.road.points) < radius * 1.15);
    const selected = new Map(retained.map((vehicle) => [vehicle.id, vehicle]));
    const shortRoutes: Vehicle[] = [];
    const carColors = ['#eee9d9', '#617b87', '#bf6c58', '#eee7d6', '#577562', '#a79980', '#444f58', '#c0ccd0', '#d0b55d', '#547d93'];
    let preparedRoads = 0;
    for (const road of nearby) {
      if (road.length < 35) continue;
      const count = Math.min(6, Math.max(1, Math.floor(road.length / 105)));
      for (let i = 0; i < count && selected.size < maximum; i++) {
        const id = `${road.id}:car:${i}`; let vehicle = this.vehicleCache.get(id);
        if (!vehicle) {
          const rng = random(hash(id));
          const route = vehicleRoute(roads, road, hash(`${id}:route`), 1600 + rng() * 1400, !road.oneWay && rng() < 0.5);
          vehicle = { id, sourceRoad: road.id, road: route, distance: rng() * Math.min(road.length, route.length * 0.65), bornAt: this.clock.elapsed, speed: (5.5 + rng() * 5.5) / this.localScale, reverse: false, color: new THREE.Color(carColors[Math.floor(rng() * carColors.length)]), type: (road.profile?.width ?? 6.4) >= 6 && rng() < 0.15 ? 2 : rng() < 0.22 ? 1 : 0 };
          if (route.length < 320) { shortRoutes.push(vehicle); continue; }
          this.vehicleCache.set(id, vehicle);
        }
        selected.set(id, vehicle);
      }
      if (selected.size >= maximum) break;
      if (++preparedRoads % 12 === 0) yield 'routes';
    }
    // A sparse rural tile may have no connected multi-block network; keep a small honest fallback there.
    shortRoutes.sort((a, b) => b.road.length - a.road.length);
    for (const vehicle of shortRoutes) { if (selected.size >= (this.options.mobile ? 12 : 36)) break; this.vehicleCache.set(vehicle.id, vehicle); selected.set(vehicle.id, vehicle); }
    this.vehicles = [...selected.values()].slice(0, maximum);
    if (this.vehicleCache.size > maximum * 5) { const distant = [...this.vehicleCache.values()].filter((vehicle) => !selected.has(vehicle.id)).sort((a, b) => pointLineDistance(this.worldOrigin, b.road.points) - pointLineDistance(this.worldOrigin, a.road.points)); for (const vehicle of distant) { if (this.vehicleCache.size <= maximum * 5) break; this.vehicleCache.delete(vehicle.id); } }
    yield 'routes';
    // This content belongs to the pending snapshot, never to the visible scene.
    this.clearContent(); this.content.visible = true; this.batches = []; this.moving = []; this.offices = [];
    const landuse = this.query('openmaptiles', 'landuse'), landcover = this.query('openmaptiles', 'landcover');
    const greens = vegetationZones([...this.data.filter((f) => f.properties?.kind === 'green'), ...landcover, ...landuse, ...this.query('openmaptiles', 'park')], this.worldOrigin, radius);
    const water = this.polygons([...this.data.filter((f) => f.properties?.kind === 'water'), ...this.query('openmaptiles', 'water')], radius);
    const buildings = this.polygons([...this.query('atlas-buildings', 'building'), ...this.query('atlas-buildings', 'building_part')], radius);
    const excluded = this.polygons([...landuse, ...landcover].filter(feature => vegetationExcluded(feature.properties ?? {})), radius);
    const plazas = this.polygons(transportation, radius), paths: VegetationPath[] = nearby.map(road => ({ points: road.points, clearance: (road.profile?.width ?? 6.4) / 2 + 1.6 }));
    for (const feature of transportation) {
      const p = feature.properties ?? {}; if (p.brunnel === 'tunnel' || p.class === 'ferry' || p.class === 'aerialway') continue;
      const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [];
      const clearance = ['path', 'footway', 'cycleway', 'pedestrian', 'steps'].includes(String(p.class)) || ['footway', 'cycleway', 'pedestrian', 'steps'].includes(String(p.subclass)) ? 3 : ['motorway', 'trunk', 'primary', 'secondary'].includes(String(p.class)) ? 8 : 5;
      for (const line of lines) { const points = line.map(worldPoint); if (pointLineDistance(this.worldOrigin, points) < radius) paths.push({ points, clearance }); }
    }
    yield 'zones';
    const zoom = map.getZoom();
    const stages: (() => void)[] = [
      () => this.createVehicles(),
      () => {}, // Vegetation has its own fine-grained work iterator below.
      () => {
        if (zoom < 15.3) return;
        this.streetDetails = createStreetDetails(nearby, { mobile: this.options.mobile, center: this.worldOrigin, radius, toLocal: point => this.fromWorld(point) });
        this.content.add(this.streetDetails.group); this.streetDetails.updateLighting(this.options.lighting());
      },
      () => {
        if (zoom < 15.3) return;
        this.transportDetails = createTransportDetails([...this.railCache.roads.values()], [...this.pathCache.roads.values()], { mobile: this.options.mobile, center: this.worldOrigin, radius, zoom, toLocal: point => this.fromWorld(point), elapsed: this.clock.elapsed }, this.transportActors);
        this.content.add(this.transportDetails.group);
      },
      () => {
        this.sports = createSportsDetails([...this.query('atlas-buildings', 'building'), ...landuse], { mobile: this.options.mobile, center: this.worldOrigin, radius, toLocal: point => this.fromWorld(point), terrain: point => this.terrain(point) });
        this.content.add(this.sports);
        if (zoom >= 15.3) this.content.add(createShoreDetails([...landcover, ...landuse], transportation, this.query('openmaptiles', 'water'), { mobile: this.options.mobile, center: this.worldOrigin, radius, toLocal: point => this.fromWorld(point), terrain: point => this.terrain(point) }));
      },
      () => { if (zoom >= 15) this.createVessels(water, random(hash('boats')), radius); },
      () => { if (zoom >= 14.5 && zoom < 17.2) this.createSky(random(hash('sky'))); },
      () => { if (zoom >= 16 && this.options.banksVisible()) this.createOffices(buildings.map(polygon => polygon.map(ring => ring.map(point => this.fromWorld(point)))), radius * this.localScale); },
    ];
    const names = ['vehicles', 'trees', 'street', 'transport', 'sports', 'boats', 'sky', 'offices'];
    for (let i = 0; i < stages.length; i++) {
      if (i === 1) { for (const _ of this.createTreesSteps(greens, [...water, ...excluded, ...plazas], buildings, paths, radius)) yield 'trees'; }
      else stages[i]();
      yield names[i];
    }
  }

  private createVehicles() {
    const glass = standard('#3e5b65', { roughness: 0.23, metalness: 0.18 });
    const tire = standard('#303735'); const headlights = standard('#fff5ca', { emissive: '#ffebac', emissiveIntensity: 0.25 });
    for (let type = 0; type < 3; type++) {
      const vehicles = this.vehicles.filter((v) => v.type === type); if (!vehicles.length) continue;
      const length = type === 2 ? 10.2 : type === 1 ? 5.6 : 4.3, width = type === 2 ? 2.5 : 1.85;
      const body = standard('#ffffff', { roughness: 0.45, metalness: 0.12 });
      const parts: [THREE.BufferGeometry, THREE.Material, number, number, number, boolean?][] = [
        [new RoundedBoxGeometry(length, width, type === 2 ? 1.8 : 1.0, 1, 0.2), body, 0, 0, type === 2 ? 1.55 : 0.95],
        [new RoundedBoxGeometry(length * (type === 2 ? 0.88 : 0.57), width * 0.84, type === 2 ? 0.9 : 0.7, 1, 0.2), glass, -0.18, 0, type === 2 ? 2.75 : 1.67],
        [new THREE.BoxGeometry(length * 0.49, width * 0.87, 0.12), body, -0.25, 0, type === 2 ? 3.22 : 2.04],
        [new THREE.CylinderGeometry(0.37, 0.37, width + 0.08, 8), tire, length * 0.3, 0, 0.38],
        [new THREE.CylinderGeometry(0.37, 0.37, width + 0.08, 8), tire, -length * 0.3, 0, 0.38],
        [new THREE.BoxGeometry(0.06, width * 0.76, 0.16), headlights, length * 0.5 + 0.03, 0, 0.98],
      ];
      for (const [geometry, material, x, y, z] of parts) {
        const instance = new THREE.InstancedMesh(geometry, material, vehicles.length); instance.instanceMatrix.setUsage(THREE.DynamicDrawUsage); instance.frustumCulled = false;
        if (material === body) vehicles.forEach((v, i) => instance.setColorAt(i, v.color));
        this.batches.push({ mesh: instance, vehicles, part: new THREE.Matrix4().makeTranslation(x, y, z) }); this.content.add(instance);
      }
    }
  }

  private *createTreesSteps(green: VegetationZone[], blocked: LocalPolygon[], buildings: LocalPolygon[], paths: VegetationPath[], radius: number) {
    const limit = this.options.mobile ? 450 : 1400;
    const near = (point: XY, multiplier = 1) => Math.abs(point[0] - this.worldOrigin[0]) < radius * multiplier && Math.abs(point[1] - this.worldOrigin[1]) < radius * multiplier;
    const mask = yield* createVegetationMaskSteps(green, [...blocked, ...buildings], paths, this.localScale); yield;
    let work = 0;
    const visible = (point: XY) => near(point) && (typeof this.map?.project !== 'function' || this.inView(point));
    for (const [id, tree] of this.treeCache) { if (!near(tree.point, 2.5) || !mask.clear(tree.point)) this.treeCache.delete(id); if (++work % 128 === 0) yield; }
    // Existing trees survive empty/incomplete tile responses. Newly loaded paths
    // and footprints can remove an invalid tree; panning never randomizes it.
    const points = this.visibleTrees.filter(tree => this.treeCache.has(tree.id) && visible(tree.point)).slice(0, limit);
    const selected = new Set(points.map(tree => tree.id));
    const candidates = yield* sampleVegetationSteps(green, this.worldOrigin, radius, limit, mask); yield;
    for (const candidate of candidates) { if (!this.treeCache.has(candidate.id)) this.treeCache.set(candidate.id, { ...candidate, elevation: 0 }); if (++work % 128 === 0) yield; }
    for (const candidate of candidates) {
      if (++work % 128 === 0) yield;
      if (points.length >= limit) break;
      const tree = this.treeCache.get(candidate.id)!;
      if (!selected.has(tree.id) && visible(tree.point)) { points.push(tree); selected.add(tree.id); }
    }
    // Previously mapped trees remain available while a neighbouring source tile loads.
    for (const tree of this.treeCache.values()) {
      if (++work % 128 === 0) yield;
      if (points.length >= limit) break;
      if (!selected.has(tree.id) && visible(tree.point)) { points.push(tree); selected.add(tree.id); }
    }
    const maximum = limit * 5;
    if (this.treeCache.size > maximum) {
      const furthest = [...this.treeCache.values()].filter(tree => !selected.has(tree.id)).sort((a, b) => Math.hypot(b.point[0] - this.worldOrigin[0], b.point[1] - this.worldOrigin[1]) - Math.hypot(a.point[0] - this.worldOrigin[0], a.point[1] - this.worldOrigin[1]));
      for (const tree of furthest) { if (this.treeCache.size <= maximum) break; this.treeCache.delete(tree.id); }
    }
    // DEM tiles can arrive after placement, and terrain exaggeration/source can
    // change without changing a tree's identity. Only the rendered subset needs
    // fresh heights; unavailable active-DEM samples retain their last valid level.
    for (const tree of points) { tree.elevation = this.terrain(tree.point, tree.elevation); if (++work % 128 === 0) yield; }
    this.visibleTrees = points;
    this.vegetation = yield* createVegetationMeshesSteps(points, point => this.fromWorld(point));
    updateVegetationLighting(this.vegetation, this.options.lighting().nightAmount || 0);
    this.content.add(this.vegetation);
  }

  getVegetationDiagnostics() {
    return { trees: this.visibleTrees.length, cachedTrees: this.treeCache.size, drawCalls: this.vegetation?.children.length ?? 0, canopyFamilies: this.vegetation?.children.filter(child => child.name.startsWith('vegetation-canopy')).length ?? 0 };
  }

  private addMoving(record: Omit<MovingObject, 'group'>, group: THREE.Group) {
    const stable = this.movingCache.get(record.id) ?? record;
    // Keep the motion phase, but never keep a cached sky altitude below new terrain/roof clearance.
    if (record.id.startsWith('sky:')) stable.altitude = Math.max(stable.altitude, record.altitude);
    this.movingCache.set(record.id, stable);
    this.moving.push({ ...stable, group }); this.content.add(group);
  }

  private createVessels(water: LocalPolygon[], _rng: () => number, radius: number) {
    const maximum = this.options.mobile ? 1 : 4;
    for (const [id, record] of this.movingCache) if (id.startsWith('boat:') && pointLineDistance(this.worldOrigin, [record.from, record.to]) > radius * 2.5) this.movingCache.delete(id);
    const existing = [...this.movingCache.values()].filter((record) => record.id.startsWith('boat:') && pointLineDistance(this.worldOrigin, [record.from, record.to]) < radius * 1.2).slice(0, maximum);
    for (const polygon of water) {
      if (existing.length >= maximum) break;
      if (existing.some((record) => inPolygon(record.from, polygon))) continue;
      const id = `boat:${geometryKey(polygon[0])}`, rng = random(hash(id));
      const xs = polygon[0].map((p) => p[0]), ys = polygon[0].map((p) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const candidates: XY[] = []; for (let n = 0; n < 100; n++) { const p: XY = [minX + rng() * (maxX - minX), minY + rng() * (maxY - minY)]; if (Math.hypot(p[0] - this.worldOrigin[0], p[1] - this.worldOrigin[1]) < radius && inPolygon(p, polygon) && distanceToLine(p, polygon[0]) > 20) candidates.push(p); }
      if (candidates.length < 2) continue;
      const from = candidates[0], to = candidates.find((p) => Math.hypot(p[0] - from[0], p[1] - from[1]) > 150 && Array.from({ length: 24 }, (_, i) => [from[0] + (p[0] - from[0]) * i / 23, from[1] + (p[1] - from[1]) * i / 23] as XY).every((v) => inPolygon(v, polygon) && distanceToLine(v, polygon[0]) > 10));
      if (!to) continue;
      const record = { id, from, to, speed: 2.5, distance: rng() * Math.hypot(to[0] - from[0], to[1] - from[1]), bornAt: this.clock.elapsed, altitude: this.terrain(from) + 0.1 };
      this.movingCache.set(id, record); existing.push(record);
    }
    for (const record of existing) {
      const boat = new THREE.Group(); mesh(boat, new RoundedBoxGeometry(15, 4.2, 2.0, 2, 1), standard('#f1ead9'), 0, 0, 1.1); mesh(boat, new THREE.BoxGeometry(7.5, 3.2, 2.3), standard('#73898b'), -1.2, 0, 2.7); mesh(boat, new THREE.BoxGeometry(8.4, 3.9, 0.25), standard('#eee7d2'), -1.2, 0, 4.0); mesh(boat, new THREE.CylinderGeometry(0.1, 0.1, 3, 5).rotateX(Math.PI / 2), standard('#a99979'), 0, 0, 5.3);
      this.addMoving(record, boat);
    }
  }

  private createSky(_rng: () => number) {
    if (!this.skyAnchor || Math.hypot(this.skyAnchor[0] - this.worldOrigin[0], this.skyAnchor[1] - this.worldOrigin[1]) > 6000) {
      this.skyAnchor = [Math.floor(this.worldOrigin[0] / 2000) * 2000, Math.floor(this.worldOrigin[1] / 2000) * 2000];
      for (const id of this.movingCache.keys()) if (id.startsWith('sky:')) this.movingCache.delete(id);
    }
    const anchor = this.skyAnchor, anchorId = `${anchor[0]}:${anchor[1]}`, rng = random(hash(anchorId));
    const terrain = Math.max(this.terrain(anchor), this.terrain([anchor[0] - 3000, anchor[1]]), this.terrain([anchor[0] + 3000, anchor[1]]));
    let highestRoof = terrain;
    for (const feature of [...this.query('atlas-buildings', 'building'), ...this.query('atlas-buildings', 'building_part')]) {
      const properties = feature.properties ?? {}, height = Number(properties.height) || Number(properties.num_floors ?? properties['building:levels']) * 3;
      if (Number.isFinite(height) && height > 0) highestRoof = Math.max(highestRoof, terrain + height);
    }
    this.cloudAltitude = safeCloudAltitude(terrain, highestRoof);
    this.cloudMaterial = createCloudMaterial();
    for (let n = 0; n < (this.options.mobile ? 1 : 3); n++) {
      const id = `sky:${anchorId}:cloud:${n}`, cloud = createCloudGroup(id, this.cloudMaterial, this.options.mobile);
      const from: XY = [anchor[0] - 3000, anchor[1] + (rng() - 0.5) * 3000], to: XY = [anchor[0] + 3000, from[1] + 80];
      this.addMoving({ id, from, to, distance: rng() * 6000, bornAt: this.clock.elapsed, speed: 2.2, altitude: safeCloudAltitude(terrain, highestRoof, n) }, cloud);
    }
    if (!this.options.mobile) {
      const plane = new THREE.Group(), white = standard('#eee9db', { roughness: 0.4 });
      mesh(plane, new THREE.CapsuleGeometry(0.8, 8, 3, 8).rotateZ(Math.PI / 2), white);
      mesh(plane, new THREE.BoxGeometry(3, 14, 0.22), white, -0.2, 0, -0.1);
      mesh(plane, new THREE.BoxGeometry(1.8, 5, 0.18), standard('#527c78'), -4, 0, 0.15);
      mesh(plane, new THREE.BoxGeometry(2.2, 0.15, 2), standard('#527c78'), -4, 0, 1);
      this.addMoving({ id: `sky:${anchorId}:plane`, from: [anchor[0] - 4000, anchor[1] + 1500], to: [anchor[0] + 4000, anchor[1] - 1500], distance: rng() * 8000, bornAt: this.clock.elapsed, speed: 38, altitude: Math.max(terrain + 650, highestRoof + 300) }, plane);
    }
  }

  private createOffices(buildings: LocalPolygon[], radius: number) {
    for (const office of this.options.offices().filter((o) => o.bank === 'sber' && o.precision === 'building' && o.coordinateSourceUrl && o.coordinates)) {
      const p = this.local(office.coordinates!); if (Math.hypot(...p) > Math.min(radius, 850) || this.offices.length >= (this.options.mobile ? 3 : 8)) continue;
      const footprint = buildings.find((poly) => inPolygon(p, poly)); let anchor = p, angle = 0;
      if (footprint) { let best = Infinity; for (let i = 1; i < footprint[0].length; i++) { const a = footprint[0][i - 1], b = footprint[0][i], q = closest(p, a, b), d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < best) { best = d; anchor = q; angle = Math.atan2(b[1] - a[1], b[0] - a[0]); } } if (inPolygon([anchor[0] + Math.sin(angle) * 1.5, anchor[1] - Math.cos(angle) * 1.5], footprint)) angle += Math.PI; }
      const group = new THREE.Group(), green = standard('#218653', { emissive: '#126334', emissiveIntensity: 0.15 }), cream = standard('#e7e4d8'), glass = standard('#67918d', { roughness: 0.16, metalness: 0.2 });
      if (footprint) { mesh(group, new THREE.BoxGeometry(6.5, 2.8, 0.28), green, 0, 0, 3.6); mesh(group, new THREE.BoxGeometry(0.15, 0.15, 3.6), cream, -3, -1.2, 1.8); mesh(group, new THREE.BoxGeometry(0.15, 0.15, 3.6), cream, 3, -1.2, 1.8); mesh(group, new THREE.BoxGeometry(2.3, 0.12, 3.1), glass, 0, 0.2, 1.55); }
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64; const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#14884b'; ctx.fillRect(0, 0, 256, 64); ctx.fillStyle = '#ffffff'; ctx.font = '600 42px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('СБЕР', 145, 48); ctx.lineWidth = 5; ctx.strokeStyle = '#ffffff'; ctx.beginPath(); ctx.arc(38, 32, 20, 0.2, Math.PI * 1.8); ctx.stroke(); ctx.beginPath(); ctx.moveTo(24, 29); ctx.lineTo(35, 40); ctx.lineTo(58, 14); ctx.stroke();
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      const sign = mesh(group, new THREE.PlaneGeometry(6.4, 1.6), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6, emissive: '#ffffff', emissiveMap: texture, emissiveIntensity: 0.55, side: THREE.DoubleSide }), 0, -1.44, footprint ? 4.2 : 5.2); sign.rotation.x = Math.PI / 2;
      if (!footprint) mesh(group, new THREE.CylinderGeometry(0.17, 0.22, 4.5, 6).rotateX(Math.PI / 2), cream, 0, 0, 2.25);
      group.position.set(anchor[0], anchor[1], 0.2); group.rotation.z = angle; group.userData.officeId = office.id; this.offices.push({ group, id: office.id }); this.content.add(group);
    }
  }


  private readonly vehicleObject = new THREE.Object3D();
  private readonly vehicleMatrix = new THREE.Matrix4();
  private readonly renderTransform = new THREE.Matrix4();
  private readonly renderScale = new THREE.Matrix4();

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map, renderer = this.renderer; if (!map || !renderer || this.failed || !this.options.enabled() || map.getZoom() < 14 || !this.content.visible) { this.projection = null; this.clock.step(performance.now(), false); return; }
    try {
      const running = this.options.animate() && !this.options.bankFocus?.() && !this.options.reducedMotion && !document.hidden;
      if (this.streetDetails) this.streetDetails.group.visible = !this.options.bankFocus?.();
      const elapsed = this.clock.step(performance.now(), running);
      const obj = this.vehicleObject, matrix = this.vehicleMatrix;
      for (const vehicle of this.vehicles) {
        const progress = vehicle.distance + vehicle.speed * (elapsed - vehicle.bornAt);
        const from = vehicle.road.points[0], to = vehicle.road.points.at(-1)!;
        // Open tile fragments may end in view. Hold there until both ends are offscreen;
        // never jump a visible car back to the beginning of a short OSM way.
        if (progress > vehicle.road.length && !this.inView(from) && !this.inView(to)) { vehicle.distance = 0; vehicle.bornAt = elapsed; }
      }
      // Compute one pose per vehicle, shared by its body/glass/wheel batches.
      for (const vehicle of this.vehicles) {
        let distance = vehicle.distance + vehicle.speed * (elapsed - vehicle.bornAt);
        const first = vehicle.road.points[0], last = vehicle.road.points.at(-1)!;
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 6) distance %= vehicle.road.length;
        const p = positionOnRoad(vehicle.road, distance), [x, y] = this.fromWorld([p.x, p.y]);
        const surface = roadSurfaceAt(vehicle.road, distance), lane = roadLaneOffset(surface.profile ?? roadGeometryProfile());
        obj.position.set(x + Math.sin(p.angle) * lane, y - Math.cos(p.angle) * lane, roadElevationAt(vehicle.road, distance) + 0.1); obj.rotation.set(0, 0, p.angle); obj.updateMatrix();
        vehicle.pose ??= new THREE.Matrix4(); vehicle.pose.copy(obj.matrix);
      }
      for (const batch of this.batches) { batch.vehicles.forEach((vehicle, i) => { matrix.copy(vehicle.pose!).multiply(batch.part); batch.mesh.setMatrixAt(i, matrix); }); batch.mesh.instanceMatrix.needsUpdate = true; }
      this.transportDetails?.update(elapsed);
      for (const item of this.moving) {
        const dx = item.to[0] - item.from[0], dy = item.to[1] - item.from[1], length = Math.hypot(dx, dy);
        const distance = item.distance + item.speed * (elapsed - item.bornAt);
        const fraction = item.id.startsWith('boat:') ? 1 - Math.abs((distance / length) % 2 - 1) : distance / length % 1;
        const [x, y] = this.fromWorld([item.from[0] + dx * fraction, item.from[1] + dy * fraction]);
        item.group.position.set(x, y, item.altitude); item.group.rotation.z = Math.atan2(dy, dx) + (item.id.startsWith('boat:') && Math.floor(distance / length) % 2 ? Math.PI : 0);
      }
      const lighting = this.options.lighting(); if (lighting !== this.lastLighting) { const light = getBuildingLight(lighting); this.sky.intensity = 0.55 + lighting.brightness * 1.6; this.sun.intensity = 0.15 + lighting.brightness * 2.6; this.sun.color.set(light.sunColor); const d = lighting.sunDirection; this.sun.position.set(d[0] * 150, d[1] * 150, Math.max(12, d[2] * 150)); this.streetDetails?.updateLighting(lighting); if (this.vegetation) updateVegetationLighting(this.vegetation, lighting.nightAmount); this.lastLighting = lighting; }
      const transform = this.renderTransform.makeTranslation(this.origin.x, this.origin.y, this.origin.z).multiply(this.renderScale.makeScale(this.scale, -this.scale, this.scale));
      this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(transform); this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert(); (this.projection ??= new THREE.Matrix4()).copy(this.camera.projectionMatrix);
      if (this.cloudMaterial) {
        const altitude = updateCloudView(this.cloudMaterial, this.camera.projectionMatrixInverse), pitch = typeof map.getPitch === 'function' ? map.getPitch() : 50;
        const decks = this.moving.filter(item => item.id.includes(':cloud:')).map(item => item.altitude);
        const nearestDeck = decks.reduce((nearest, deck) => Math.abs(deck - altitude) < Math.abs(nearest - altitude) ? deck : nearest, this.cloudAltitude);
        this.cloudMaterial.uniforms.uOpacity.value = 0.6 * cloudVisibility(map.getZoom(), pitch, altitude, nearestDeck);
        this.cloudMaterial.uniforms.uNight.value = Math.max(0, Math.min(1, lighting.nightAmount));
        (this.cloudMaterial.uniforms.uSun.value as THREE.Vector3).fromArray(lighting.sunDirection).normalize();
        for (const item of this.moving) if (item.id.includes(':cloud:')) item.group.visible = this.cloudMaterial.uniforms.uOpacity.value > 0.003;
      }
      renderer.resetState(); renderer.setViewport(0, 0, map.getCanvas().width, map.getCanvas().height); renderer.render(this.scene, this.camera); renderer.resetState();
      if (process.env.NODE_ENV !== 'production') {
        const now = performance.now(), canvas = map.getCanvas();
        if (canvas.dataset && now - this.lastDiagnosticsAt >= 1000) {
          const clouds = this.moving.filter(item => item.id.includes(':cloud:'));
          const cameraAltitude = new THREE.Vector3(0, 0, -1).applyMatrix4(this.camera.projectionMatrixInverse).z;
          canvas.dataset.cityLife = JSON.stringify({ ...this.getVegetationDiagnostics(), simulationSeconds: Number(elapsed.toFixed(2)), motionRunning: running, rebuildMs: Number(this.rebuildMs.toFixed(1)), rebuildMaxSliceMs: Number(this.rebuildMaxSliceMs.toFixed(1)), rebuildSlices: this.rebuildSlices, rebuildStages: Object.fromEntries(Object.entries(this.rebuildStageMs).map(([name, duration]) => [name, Number(duration.toFixed(1))])), rebuildPending: this.pendingBuild !== null, rebuildCount: this.rebuildCount, rebuildSkipped: this.rebuildSkipped, vehicleDrawCalls: this.batches.length, vehicles: this.vehicles.length, buses: this.vehicles.filter(vehicle => vehicle.type === 2).length, transport: this.transportDetails?.group.userData ?? null, sports: this.sports?.userData.sports ?? null, street: this.streetDetails ? { lamps: this.streetDetails.group.userData.lampCount, bridges: this.streetDetails.group.userData.bridgeSegmentCount } : null, clouds: clouds.length, visibleClouds: clouds.filter(item => item.group.visible).length, cloudOpacity: Number((this.cloudMaterial?.uniforms.uOpacity.value ?? 0).toFixed(3)), cloudDecks: clouds.map(item => Math.round(item.altitude)), cameraAltitude: Math.round(cameraAltitude), night: Number(lighting.nightAmount.toFixed(3)), zoom: Number(map.getZoom().toFixed(2)) });
          this.lastDiagnosticsAt = now;
        }
      }
      if (running && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.map?.triggerRepaint(); }, this.options.mobile ? 65 : 40);
    } catch (error) { this.failed = true; this.options.onError?.(error); }
  }

  pickOffice(point: { x: number; y: number }) {
    if (!this.projection || !this.map) return null; const canvas = this.map.getCanvas(), x = point.x / canvas.clientWidth * 2 - 1, y = 1 - point.y / canvas.clientHeight * 2, inverse = this.projection.clone().invert();
    const near = new THREE.Vector3(x, y, -1).applyMatrix4(inverse), far = new THREE.Vector3(x, y, 1).applyMatrix4(inverse), ray = new THREE.Raycaster(near, far.sub(near).normalize());
    return this.offices.find((office) => ray.intersectObject(office.group, true).length)?.id ?? null;
  }
  onRemove() { this.cancelBuild(); if (this.timer) clearTimeout(this.timer); if (this.updateTimer) clearTimeout(this.updateTimer); this.abort.abort(); this.map?.off('moveend', this.refresh); this.map?.off('sourcedata', this.sourceUpdated); this.map?.off('terrain', this.terrainUpdated); document.removeEventListener('visibilitychange', this.visibilityChanged); this.clearContent(); this.renderer?.dispose(); this.map = null; this.renderer = null; }
}
