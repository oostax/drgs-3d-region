import { buildingGeometryArea, buildBuildingGeometry, unpackBuildingGeometry, type BuildingGeometryInput, type PackedBuildingGeometry } from './building-detail-geometry';
import { BuildingGeometryWorkerClient } from './building-geometry-worker-client';
import { BuildingSpatialCache, buildingSpatialCell } from './building-spatial-cache';
import { buildingTerrainAnchor, buildingTerrainAltitude, type BuildingSourceTile } from './building-terrain';
export { buildingGeometryArea, makeBuildingDetailGeometry } from './building-detail-geometry';
import * as THREE from 'three';
import { applyGroundFloorTexture, buildingTextureKey, disposeFacadeTextures, makeFacadeTextures, type FacadeTextures } from './building-facade-textures';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as LibreMap } from 'maplibre-gl';
import type { Feature, Geometry, Position } from 'geojson';
import { classifyBuilding, getBuildingLight, type BuildingProfile } from './building-materials';
import { loadFacadeArtwork } from './building-facade-artwork';
import { acquireBuildingSignageResources } from './building-signage';
import type { LightingState } from './solar';

export type BuildingDetailsOptions = { enabled: () => boolean; lighting: () => LightingState; mobile: boolean; excludeIds?: () => ReadonlySet<string>; onError?: (error: unknown) => void };
const polygons = (geometry: Geometry): Position[][][] => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];

function roofTexture() {
  const size = 64, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const grain = (x * 17 + y * 23) % 7, seam = x % 8;
    const tone = seam === 0 ? 179 : seam === 1 ? 250 : y % 32 === 0 ? 204 : 235 - grain;
    pixels.set([tone, tone, tone, 255], (y * size + x) * 4);
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat); texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true; return texture;
}
type Entry = { id: string; profile: BuildingProfile; detailLevel: number; roofKind: string };
type Batch = { profile: BuildingProfile; material: THREE.MeshStandardMaterial };
type GeometryBatch = { profile: BuildingProfile; geometries: THREE.BufferGeometry[] };
type DetailCandidate = { feature: Feature<Geometry>; terrainAnchors: ([number, number] | null)[]; area: number; points: number; signature: string };
type PreparedCandidate = DetailCandidate & { profile: BuildingProfile; bounds: [number, number, number, number]; cachePrefix: string; geometryKeys: Map<string, string> };
type CachedGeometry = { serial: number; walls: THREE.BufferGeometry[]; roofs: THREE.BufferGeometry[]; edges: THREE.BufferGeometry[]; reliefs: THREE.BufferGeometry[]; signs: THREE.BufferGeometry[]; cost: number; roofKind: string };

/** Vector tile boundaries may split one building into several different geometries.
 * Keep those fragments together; a duplicate ID is not evidence of a bad footprint.
 * Exact duplicates from buffered/overscaled tiles must not multiply geometry.
 */
function* collectBuildingCandidates(features: Feature<Geometry>[], excludes: ReadonlySet<string>): Generator<void,DetailCandidate[],unknown> {
  const selected = new Map<string, { feature: Feature<Geometry>; fragments: Map<string, Position[][]>; anchors: Map<string, [number, number] | null>; area: number; points: number }>();
  let work=0;
  for (const feature of features) {
    if(++work%64===0)yield;
    const id = String(feature.properties?.id ?? feature.id ?? ''), parent = String(feature.properties?.building_id ?? '');
    if (!id || excludes.has(id) || excludes.has(parent)) continue;
    let candidate = selected.get(id);
    for (const polygon of polygons(feature.geometry)) {
      if (!polygon.length || polygon.some(ring => ring.length < 4 || ring.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1])))) continue;
      const points = polygon.reduce((sum, ring) => sum + ring.length, 0);
      if (points > 12_000 || (candidate && (candidate.points + points > 12_000 || candidate.fragments.size >= 16))) continue;
      const key = JSON.stringify(polygon);
      if (candidate?.fragments.has(key)) continue;
      const area = buildingGeometryArea({ type: 'Polygon', coordinates: polygon });
      if (area < 1 || !Number.isFinite(area)) continue;
      if (!candidate) { candidate = { feature, fragments: new Map(), anchors: new Map(), area: 0, points: 0 }; selected.set(id, candidate); }
      candidate.fragments.set(key, polygon);
      candidate.anchors.set(key, buildingTerrainAnchor(polygon, (feature as Feature<Geometry> & { tile?: BuildingSourceTile }).tile));
      candidate.area += area; candidate.points += points;
    }
  }
  return [...selected.values()].map(candidate => ({ feature: { ...candidate.feature, geometry: { type: 'MultiPolygon', coordinates: [...candidate.fragments.values()] } }, terrainAnchors: [...candidate.anchors.values()], area: candidate.area, points: candidate.points, signature: [...candidate.fragments.keys()].sort().join('|') }));
}

function disposeCachedGeometry(geometry: CachedGeometry) { for (const item of [...geometry.walls, ...geometry.roofs, ...geometry.edges, ...geometry.reliefs, ...geometry.signs]) item.dispose(); }

/** Bounded whole-viewport detail coverage, sorted by projected size rather than distance to the camera centre. */
// Continuous vector materials cover the whole city. Only large visible buildings
// need the architectural pass; distant coverage never depends on this budget.
export function buildingDetailBudget(mobile: boolean) { return { minZoom: mobile ? 15 : 14.3, maxBuildings: mobile ? 700 : 2000, minPixels: mobile ? 3 : 2 }; }
/** Resolution chooses complexity, never the physical dimensions of a detail. */
export function buildingArchitectureLevel(pixels: number, zoom: number, mobile: boolean, detailedCount: number): 0 | 1 | 2 {
  if (pixels < (mobile ? 19 : 14)) return 0;
  return zoom >= (mobile ? 16 : 15.2) && pixels >= (mobile ? 74 : 60) && detailedCount < (mobile ? 28 : 120) ? 2 : 1;
}

/** Shared material batches overlay source footprints; the base map is never masked. */
export class BuildingDetailsLayer implements CustomLayerInterface {
  readonly id = 'atlas-building-details'; readonly type = 'custom' as const; readonly renderingMode = '3d' as const;
  private map: LibreMap | null = null; private renderer: THREE.WebGLRenderer | null = null;
  private readonly camera = new THREE.Camera(); private readonly scene = new THREE.Scene(); private readonly content = new THREE.Group();
  private readonly spatialCache: BuildingSpatialCache;
  private readonly geometryWorker = new BuildingGeometryWorkerClient();
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  private prefetchRevision = 0;
  private prefetched = 0;
  private readonly sky = new THREE.HemisphereLight(0xe8e8e2, 0xb4b5ac, 1); private readonly sun = new THREE.DirectionalLight(0xffead0, 2);
  private readonly nightFill = new THREE.DirectionalLight(0xe5ebe7, 0);
  private origin = MercatorCoordinate.fromLngLat([49.12, 55.79]); private entries: Entry[] = []; private batches: Batch[] = [];
  private geometryOrigin = this.origin;
  private signageResources: ReturnType<typeof acquireBuildingSignageResources> | null = null;
  private textures = new Map<string, FacadeTextures>(); private roofMap = roofTexture();
  private wallMaterials=new Map<string,THREE.MeshStandardMaterial>();
  private roofMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, map: this.roofMap, roughness: 0.9, side: THREE.DoubleSide, forceSinglePass: true, transparent: true, depthWrite: true });
  private reliefMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, side: THREE.DoubleSide, forceSinglePass: true, transparent: true, depthWrite: true });
  private edgeMaterial = new THREE.LineBasicMaterial({ color: '#72786c', transparent: true, opacity: 0.6, depthWrite: false });
  private dirty = true; private failed = false; private removed = false; private texturesDirty = true;
  private refreshVersion = 0; private buildFrame: number | null = null;
  private pendingBuild: { version: number; started: boolean; steps: Generator<void | Promise<void>, void, unknown> } | null = null;
  private textureRevision = 0; private appliedTextureRevision = 0;
  private lastBuildAt = -Infinity; private lastRefreshAt = -Infinity; private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private originReady = false; private geometryCache = new Map<string, CachedGeometry>(); private profileCache = new Map<string, BuildingProfile>();
  private sourceDirty = true; private sourceRevision = 0; private sourceCandidates: PreparedCandidate[] = []; private sourceExcludes = '';
  private renderSignature = ''; private geometrySerial = 0;
  private lastBuildMs = 0; private lastBuildChunkMs = 0; private lastBuildSlices = 0; private rebuilds = 0; private cacheHits = 0;
  private buildPhase = 'idle';
  private diagnosticsVersion = '';
  private readonly diagnosticsEnabled = process.env.NODE_ENV === 'development' || typeof location !== 'undefined' && ['127.0.0.1', 'localhost'].includes(location.hostname) && new URLSearchParams(location.search).has('diagnostics');
  private mobile: boolean;
  constructor(private readonly options: BuildingDetailsOptions) { this.mobile = options.mobile; this.spatialCache = new BuildingSpatialCache(options.mobile ? 16 * 1024 * 1024 : 48 * 1024 * 1024); }
  /** Rebudget after resize/orientation changes; never resize the buildings themselves. */
  setMobile(mobile: boolean) {
    if (this.removed || this.mobile === mobile) return;
    this.mobile = mobile; this.texturesDirty = true;
    this.spatialCache.setMaxBytes(mobile ? 16 * 1024 * 1024 : 48 * 1024 * 1024);
    this.refresh();
  }
  onAdd(map: LibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    try { this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl }); this.renderer.autoClear = false; this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.06; this.camera.matrixAutoUpdate = false; this.sky.position.set(0, 0, 1); this.scene.add(this.content, this.sky, this.sun, this.nightFill); map.on('move', this.moving); map.on('moveend', this.changed); map.on('resize', this.changed); map.on('sourcedata', this.sourceChanged); map.on('terrain', this.terrainChanged); this.refresh(); }
    catch (error) { this.failed = true; this.options.onError?.(error); }
    void loadFacadeArtwork().then(ready => {
      if (!ready || this.removed) return;
      // Keep the live scene's maps until its replacements have been prepared.
      this.textureRevision++; this.refresh();
    });
  }
  private changed = () => { this.sourceDirty = true; this.sourceRevision++; this.refresh(false); };
  private terrainChanged = () => { this.refresh(); };
  private moving = () => { this.cancelPrefetch(); this.scheduleRefresh(); };
  private sourceChanged = (event: { sourceId?: string; sourceDataType?: string; isSourceLoaded?: boolean }) => {
    // A visible tile can finish while another horizon tile is still loading.
    if ((event.sourceId === 'atlas-buildings' || event.sourceId === this.map?.getTerrain()?.source) && event.sourceDataType !== 'metadata' && event.sourceDataType !== 'visibility') {
      this.cancelPrefetch();
      if (event.sourceId === 'atlas-buildings') { this.sourceDirty = true; this.sourceRevision++; }
      this.scheduleRefresh(true);
    }
  };
  private scheduleRefresh(urgent=false) {
    if (this.removed) return;
    const delay = (urgent?140:this.mobile ? 650 : 500) - (performance.now() - Math.max(this.lastBuildAt, this.lastRefreshAt));
    if (delay <= 0) { this.refresh(false); return; }
    if(urgent&&this.refreshTimer!==null){clearTimeout(this.refreshTimer);this.refreshTimer=null;}
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refresh(false); }, delay);
  }
  refresh(invalidate = true) { if (this.removed) return; if (invalidate) this.cancelBuild(); if (this.refreshTimer !== null) { clearTimeout(this.refreshTimer); this.refreshTimer = null; } this.refreshVersion++; this.lastRefreshAt = performance.now(); this.dirty = true; this.map?.triggerRepaint(); }
  private cancelBuild() {
    this.cancelPrefetch();
    if (this.buildFrame !== null) cancelAnimationFrame(this.buildFrame);
    this.buildFrame = null;
    const pending = this.pendingBuild; this.pendingBuild = null;
    pending?.steps.return();
    if (pending) this.geometryWorker.cancel();
  }
  private beginBuild() {
    if (this.pendingBuild || this.removed || !this.dirty) return;
    this.dirty = false;
    this.pendingBuild = { version: this.refreshVersion, started: false, steps: this.rebuildSteps(true) };
    this.buildFrame = requestAnimationFrame(this.continueBuild);
  }
  private continueBuild = () => {
    this.buildFrame = null;
    const pending = this.pendingBuild, map = this.map;
    if (!pending || !map || this.removed) return;
    if (!this.options.enabled() || map.getZoom() < buildingDetailBudget(this.mobile).minZoom) { this.cancelBuild(); this.dirty = true; return; }
    // A queued generator has read no camera state yet: start it with the newest
    // version instead of starving the first slice during continuous movement.
    if (!pending.started) { pending.version = this.refreshVersion; pending.started = true; }
    // Finish this bounded staging pass even while the camera moves. The next
    // pass consumes dirty/latest state; the visible facade never disappears.
    try {
      const step = pending.steps.next();
      if (step.done) { this.pendingBuild = null; if (pending.version !== this.refreshVersion) this.dirty = true; map.triggerRepaint(); }
      else if (step.value instanceof Promise) { void step.value.then(() => { if (this.pendingBuild === pending && !this.removed) this.buildFrame = requestAnimationFrame(this.continueBuild); }); }
      else this.buildFrame = requestAnimationFrame(this.continueBuild);
    } catch (error) { this.cancelBuild(); this.failed = true; this.options.onError?.(error); }
  };
  /** Read-only counters for profiling a real viewport; no frame-rate estimate. */
  getDiagnostics() {
    let vertices = 0, geometryBytes = 0, textureBytes = 0;
    for (const object of this.content.children) if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      vertices += Math.min(object.geometry.drawRange.count, object.geometry.getAttribute('position').count);
      for (const attribute of Object.values(object.geometry.attributes) as THREE.BufferAttribute[]) geometryBytes += attribute.array.byteLength;
    }
    const uniqueTextures = new Set<THREE.Texture>();
    for (const textures of this.textures.values()) for (const texture of Object.values(textures)) uniqueTextures.add(texture);
    for (const texture of uniqueTextures) textureBytes += (texture.image as { data?: { byteLength: number } } | undefined)?.data?.byteLength ?? 0;
    if (this.signageResources) textureBytes += 1024 * 1024 * 4;
    return { mobile: this.mobile, worker: this.geometryWorker.available ? 'available' : 'fallback', workerCompleted: this.geometryWorker.completed, workerFailure: this.geometryWorker.failure, workerPending: this.geometryWorker.busy, spatialCacheBytes: this.spatialCache.bytes, spatialCacheEntries: this.spatialCache.size, spatialCacheHits: this.spatialCache.hits, spatialCacheMisses: this.spatialCache.misses, prefetched: this.prefetched, artworkTextures: [...uniqueTextures].filter(texture => texture.userData.facadeArtworkKey).length / 3, buildings: this.entries.length, modeledBuildings: this.entries.filter(entry => entry.detailLevel > 0).length, detailedBuildings: this.entries.filter(entry => entry.detailLevel === 2).length, roofs: this.entries.reduce<Record<string, number>>((counts, entry) => { counts[entry.roofKind] = (counts[entry.roofKind] ?? 0) + 1; return counts; }, {}), drawCalls: this.content.children.length, vertices, geometryBytes, textureBytes, textureSets: this.textures.size, geometryCacheEntries: this.geometryCache.size, cacheHits: this.cacheHits, buildMs: this.lastBuildMs, buildChunkMs: this.lastBuildChunkMs, buildSlices: this.lastBuildSlices, buildPending: Boolean(this.pendingBuild), buildPhase: this.buildPhase, rebuilds: this.rebuilds };
  }
  private query(layer: string): Feature<Geometry>[] { if (!this.map?.getSource('atlas-buildings')) return []; try { return this.map.querySourceFeatures('atlas-buildings', { sourceLayer: layer }); } catch { return []; } }
  private clear(disposeTextures = true) {
    this.content.clear(); this.spatialCache.clear(); this.entries = []; this.batches = [];
    if (disposeTextures) { for(const material of this.wallMaterials.values())material.dispose();this.wallMaterials.clear();for (const texture of this.textures.values()) disposeFacadeTextures(texture); this.textures.clear(); for (const geometry of this.geometryCache.values()) disposeCachedGeometry(geometry); this.geometryCache.clear(); this.profileCache.clear(); }
    this.texturesDirty = true;
  }
  /** Synchronous drain retained for deterministic geometry checks. Production
   * resumes the same generator between frames and commits a complete scene. */
  private rebuild() { this.cancelBuild(); for (const _ of this.rebuildSteps()) { /* drain */ } }
  private geometryInput(candidate: PreparedCandidate, detailLevel: 0 | 1 | 2, origin: MercatorCoordinate): BuildingGeometryInput {
    const fragments = polygons(candidate.feature.geometry), terrain = Boolean(this.map?.getTerrain());
    const altitudes = candidate.terrainAnchors.map(anchor => terrain && this.map ? buildingTerrainAltitude(this.map, anchor) : 0);
    const altitudeKey = `${terrain ? 'terrain' : 'flat'}|${altitudes.join(',')}|${detailLevel}`;
    let key = candidate.geometryKeys.get(altitudeKey);
    if (!key) { key = `${candidate.cachePrefix}|${altitudeKey}`; candidate.geometryKeys.set(altitudeKey, key); }
    return { key, polygons: fragments, profile: candidate.profile, detailLevel, altitudes, terrain, origin: [origin.x, origin.y, origin.z] };
  }
  private cancelPrefetch() {
    this.prefetchRevision++;
    if (this.prefetchTimer !== null) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = null;
  }
  private schedulePrefetch(candidates: (PreparedCandidate & { pixels: number })[], origin: MercatorCoordinate, zoom: number) {
    this.cancelPrefetch();
    if (!candidates.length || !this.geometryWorker.available || this.removed) return;
    const revision = this.prefetchRevision;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      const valid = () => !this.removed && revision === this.prefetchRevision && origin === this.geometryOrigin && !this.pendingBuild && !this.dirty && this.options.enabled() && !this.map?.isMoving();
      if (!valid()) return;
      const run = async () => {
        // A short batch bounds how long speculative work can precede a new viewport.
        for (let offset = 0; offset < candidates.length && valid(); offset += 8) {
          const inputs = candidates.slice(offset, offset + 8).map(candidate => this.geometryInput(candidate, buildingArchitectureLevel(candidate.pixels, zoom, this.mobile, 0), origin)).filter(input => !this.geometryCache.has(input.key));
          if (!inputs.length) continue;
          const packed = await this.geometryWorker.build(inputs);
          if (!valid()) return;
          for (const item of packed) if (!this.geometryCache.has(item.key)) { this.geometryCache.set(item.key, { ...unpackBuildingGeometry(item), serial: ++this.geometrySerial }); this.prefetched++; }
          this.pruneGeometryCache();
        }
        if (valid() && this.diagnosticsEnabled) this.map?.triggerRepaint();
      };
      void run().catch(() => { /* Prefetch never interrupts visible rendering. */ });
    }, 180);
  }
  private pruneGeometryCache() {
    const maxCacheEntries = this.mobile ? 1200 : 3500, maxCacheVertices = this.mobile ? 220_000 : 700_000;
    let cacheVertices = [...this.geometryCache.values()].reduce((sum, geometry) => sum + geometry.cost, 0);
    for (const [key, geometry] of this.geometryCache) { if (this.geometryCache.size <= maxCacheEntries && cacheVertices <= maxCacheVertices) break; disposeCachedGeometry(geometry); this.geometryCache.delete(key); cacheVertices -= geometry.cost; }
    while (this.profileCache.size > maxCacheEntries * 2) this.profileCache.delete(this.profileCache.keys().next().value!);
  }
  private *rebuildSteps(prepareTextures = false): Generator<void | Promise<void>, void, unknown> {
    const map = this.map; if (!map) return;
    let sliceStarted = performance.now(), cpuMs = 0, maxChunkMs = 0, slices = 1, committed = false;
    const checkpoint = function* (force = false): Generator<void, void, unknown> {
      const elapsed = performance.now() - sliceStarted;
      if (force || elapsed >= 6) { cpuMs += elapsed; maxChunkMs = Math.max(maxChunkMs, elapsed); slices++; yield; sliceStarted = performance.now(); }
    };
    const nextObjects: (THREE.Mesh | THREE.LineSegments)[] = [], nextBatches: Batch[] = [], stagedTextures = new Map<string, FacadeTextures>();
    const addBatch = (key: string, parts: THREE.BufferGeometry[], material: THREE.Material, lines = false) => {
      const object = this.spatialCache.acquire(key, parts, material, lines);
      if (object) nextObjects.push(object);
      return object;
    };
    const textureRevision = this.textureRevision, replaceTextures = textureRevision !== this.appliedTextureRevision;
    this.cacheHits = 0;
    try {
    this.buildPhase = 'source';
    const excludes = this.options.excludeIds?.() ?? new Set<string>(), excludeKey = [...excludes].sort().join('|');
    // Source geometry, JSON signatures and profiles do not change as the camera
    // moves. Re-query only after tile data or landmark exclusions change.
    if (this.sourceDirty || this.sourceExcludes !== excludeKey) {
      const sourceRevision = this.sourceRevision;
      const features = [...this.query('building'), ...this.query('building_part')], parents = new Map(features.filter(feature => !feature.properties?.building_id).map(feature => [String(feature.properties?.id ?? feature.id), feature.properties ?? {}]));
      const collector = collectBuildingCandidates(features, excludes);
      let step = collector.next();
      // The collector exposes checkpoints every 64 features, not frame boundaries.
      // Fast duplicate batches can share a slice; yield only when its CPU budget is spent.
      while (!step.done) { yield* checkpoint(); step = collector.next(); }
      const selected = step.value; const prepared: PreparedCandidate[] = [];
      for(const entry of selected){
        const properties = entry.feature.properties ?? {}, parent = parents.get(String(properties.building_id ?? '')), inherited: Record<string, unknown> = {};
        if (parent) for (const field of ['class', 'subtype', 'facade_color', 'facade_material', 'building:colour', 'building:material', 'amenity', 'building', 'building:use', 'leisure', 'office', 'shop', 'historic']) if (parent[field] !== undefined) inherited[field] = parent[field];
        const profileKey = JSON.stringify([properties, inherited, entry.area < 15]);
        const profile = this.profileCache.get(profileKey) ?? classifyBuilding(properties, entry.area, { ...inherited, ...properties });
        this.profileCache.delete(profileKey); this.profileCache.set(profileKey, profile);
        const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const polygon of polygons(entry.feature.geometry)) for (const p of polygon[0]) { bounds[0] = Math.min(bounds[0], p[0]); bounds[1] = Math.min(bounds[1], p[1]); bounds[2] = Math.max(bounds[2], p[0]); bounds[3] = Math.max(bounds[3], p[1]); }
        prepared.push({ ...entry, profile, bounds, cachePrefix: `${entry.signature}|${JSON.stringify(entry.terrainAnchors)}|${JSON.stringify(profile)}`, geometryKeys: new Map<string, string>() });
        yield* checkpoint();
      }
      this.sourceCandidates=prepared;
      this.sourceDirty = sourceRevision !== this.sourceRevision; this.sourceExcludes = excludeKey;
    }
    yield* checkpoint();
    const center = map.getCenter(), canvas = map.getCanvas(), budget = buildingDetailBudget(this.mobile);
    const nextOrigin = MercatorCoordinate.fromLngLat([center.lng, center.lat]);
    // Keep cached metre coordinates stable during local navigation, then rebase
    // for another city/region before float precision can erode facade offsets.
    if (!this.originReady || Math.hypot(nextOrigin.x - this.geometryOrigin.x, nextOrigin.y - this.geometryOrigin.y) / this.geometryOrigin.meterInMercatorCoordinateUnits() > 20_000) {
      this.geometryOrigin = nextOrigin; this.originReady = true;
      for (const geometry of this.geometryCache.values()) disposeCachedGeometry(geometry); this.geometryCache.clear();
    }
    const buildOrigin = this.geometryOrigin, zoom = map.getZoom();
    const unit = buildOrigin.meterInMercatorCoordinateUnits(), pixelsPerMetre = 512 * 2 ** zoom * unit;
    const projected: (PreparedCandidate & {pixels:number;importance:number;visible:boolean;nearby:boolean})[]=[];
    for(const entry of this.sourceCandidates){
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const [west, south, east, north] = entry.bounds;
      for (const point of [[west, south], [east, south], [east, north], [west, north]] as [number, number][]) {
        const pixel = map.project(point); minX = Math.min(minX, pixel.x); maxX = Math.max(maxX, pixel.x); minY = Math.min(minY, pixel.y); maxY = Math.max(maxY, pixel.y);
      }
      const width = Math.max(maxX - minX, Math.sqrt(entry.area) * pixelsPerMetre * 0.4), height = Math.max(maxY - minY, width * 0.3);
      const profile = entry.profile;
      // Ground footprints can be below the viewport while a tall facade remains visible.
      const rise = Math.min(canvas.clientHeight, profile.height * pixelsPerMetre);
      projected.push({ ...entry, profile, pixels: Math.max(width, height), importance: width * height,
        nearby: maxX > -canvas.clientWidth && minX < canvas.clientWidth * 2 && maxY > -canvas.clientHeight && minY < canvas.clientHeight * 2,
        visible: Number.isFinite(minX + minY + maxX + maxY) && maxX > -140 && minX < canvas.clientWidth + 140 && maxY > -140 && minY - rise < canvas.clientHeight + 200 });
      yield* checkpoint();
    }
    const candidates=projected.filter(entry => entry.visible && entry.pixels >= budget.minPixels)
      .sort((a, b) => b.importance - a.importance || String(a.feature.properties?.id).localeCompare(String(b.feature.properties?.id)))
      .slice(0, budget.maxBuildings);
    yield* checkpoint();
    // Materials/textures survive camera moves; only footprint batches are replaced.
    const nextEntries: Entry[] = [], geometryKeys: string[] = [];
    const wallGroups = new Map<string, GeometryBatch>();
    const cells = new Map<string, { roofs: THREE.BufferGeometry[]; edges: THREE.BufferGeometry[]; reliefs: THREE.BufferGeometry[]; signs: THREE.BufferGeometry[] }>();
    // Reserve inexpensive coverage for the whole viewport independently from
    // roof forms, ledges and signage. Detail cannot consume the last house's slot.
    let verticesLeft = this.mobile ? 90_000 : 280_000;
    let architectureLeft = this.mobile ? 32_000 : 110_000, detailedCount = 0;
    this.buildPhase = 'geometry';
    for (const [candidateIndex, candidate] of candidates.entries()) {
      // Bound triangulation and GPU uploads as well as the number of source IDs.
      const vertexCost = candidate.points * 12; if (vertexCost > verticesLeft) continue;
      const feature = candidate.feature, properties = feature.properties ?? {}, profile = candidate.profile, key = buildingTextureKey(profile);
      let detailLevel = buildingArchitectureLevel(candidate.pixels, zoom, this.mobile, detailedCount);
      // Decorations never displace a building from the base coverage budget.
      const silhouetteReserve = (candidates.length - candidateIndex - 1) * (this.mobile ? 70 : 110);
      if (architectureLeft < silhouetteReserve + 1800 && detailLevel === 2) detailLevel = 1;
      if (architectureLeft < 600) detailLevel = 0;
      if (detailLevel === 2) detailedCount++;
      const cell = buildingSpatialCell((candidate.bounds[0] + candidate.bounds[2]) / 2, (candidate.bounds[1] + candidate.bounds[3]) / 2);
      const batchKey = `${cell}:${key}`;
      let batch = wallGroups.get(batchKey); if (!batch) { batch = { profile, geometries: [] }; wallGroups.set(batchKey, batch); }
      let parts = cells.get(cell); if (!parts) { parts = { roofs: [], edges: [], reliefs: [], signs: [] }; cells.set(cell, parts); }
      // Foreground, worker lookahead and prefetch share one grounding calculation and key.
      const input = this.geometryInput(candidate, detailLevel, buildOrigin), geometryKey = input.key;
      let cached = this.geometryCache.get(geometryKey);
      if (cached) this.cacheHits++;
      else {
        if (prepareTextures && this.geometryWorker.available) {
          // Prepare a bounded lookahead batch in one worker message. The current
          // candidate retains the exact budget-selected level; speculative levels
          // are cache entries only and cannot override subsequent selection.
          const inputs: BuildingGeometryInput[] = [];
          for (const [offset, upcoming] of candidates.slice(candidateIndex, candidateIndex + 64).entries()) {
            const level = offset === 0 ? detailLevel : buildingArchitectureLevel(upcoming.pixels, zoom, this.mobile, detailedCount + offset);
            const input = this.geometryInput(upcoming, level, buildOrigin);
            if (!this.geometryCache.has(input.key)) inputs.push(input);
          }
          let packed: PackedBuildingGeometry[] = [];
          const waiting = this.geometryWorker.build(inputs).then(items => { packed = items; }, () => { /* Time-sliced identical fallback below. */ });
          const elapsed = performance.now() - sliceStarted; cpuMs += elapsed; maxChunkMs = Math.max(maxChunkMs, elapsed);
          yield waiting; sliceStarted = performance.now();
          for (const item of packed) {
            if (!this.geometryCache.has(item.key)) this.geometryCache.set(item.key, { ...unpackBuildingGeometry(item), serial: ++this.geometrySerial });
            yield* checkpoint();
          }
          cached = this.geometryCache.get(geometryKey);
        }
        cached ??= { ...buildBuildingGeometry(input), serial: ++this.geometrySerial };
      }

      this.geometryCache.delete(geometryKey); this.geometryCache.set(geometryKey, cached);
      yield* checkpoint();
      if (cached.cost > verticesLeft) continue;
      verticesLeft -= cached.cost;
      architectureLeft -= Math.max(0, cached.cost - vertexCost);
      batch.geometries.push(...cached.walls); parts.roofs.push(...cached.roofs); parts.edges.push(...cached.edges); parts.reliefs.push(...cached.reliefs); parts.signs.push(...cached.signs);
      nextEntries.push({ id: String(properties.id ?? feature.id), profile, detailLevel, roofKind: cached.roofKind });
      geometryKeys.push(String(cached.serial));
    }
    this.pruneGeometryCache();
    const renderSignature = geometryKeys.sort().join('\n');
    // Texture allocation can be more expensive than geometry. Yield between
    // shared families; the live materials retain their maps until the commit.
    this.buildPhase = 'textures';
    if (prepareTextures) for (const batch of wallGroups.values()) {
      const key = buildingTextureKey(batch.profile);
      if (!batch.geometries.length || stagedTextures.has(key) || !replaceTextures && this.textures.has(key)) continue;
      const textures = makeFacadeTextures(batch.profile), anisotropy = Math.min(this.mobile ? 2 : 4, this.renderer?.capabilities.getMaxAnisotropy() ?? 1);
      textures.diffuse.anisotropy = textures.normal.anisotropy = anisotropy; stagedTextures.set(key, textures);
      yield* checkpoint(true);
    }
    const commitTextures = () => {
      if (prepareTextures && replaceTextures) { for (const textures of this.textures.values()) disposeFacadeTextures(textures); this.textures.clear(); }
      if (stagedTextures.size || prepareTextures && replaceTextures) this.texturesDirty = true;
      for (const [key, textures] of stagedTextures) this.textures.set(key, textures);
      stagedTextures.clear(); if (prepareTextures) this.appliedTextureRevision = textureRevision;
    };
    const finish = () => {
      const elapsed = performance.now() - sliceStarted;
      this.dirty = false; this.lastBuildAt = performance.now(); this.lastBuildMs = cpuMs + elapsed;
      this.lastBuildChunkMs = Math.max(maxChunkMs, elapsed); this.lastBuildSlices = slices; this.rebuilds++; committed = true;
      this.schedulePrefetch(projected.filter(candidate => !candidate.visible && candidate.nearby).slice(0, this.mobile ? 24 : 64), buildOrigin, zoom);
    };
    if (this.renderSignature === renderSignature && this.entries.length) {
      commitTextures(); this.entries = nextEntries; finish();
      return;
    }
    this.buildPhase = 'merge';
    for (const [batchKey,batch] of wallGroups) {
      if (!batch.geometries.length) continue;
      const key = buildingTextureKey(batch.profile);
      let material=this.wallMaterials.get(key);
      if(!material){material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: batch.profile.surface === 'glass' ? 0.38 : 0.86, side: THREE.DoubleSide, forceSinglePass: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, emissive: '#fff4de', normalScale: new THREE.Vector2(.48, .48) });applyGroundFloorTexture(material,batch.profile);this.wallMaterials.set(key,material);}
      addBatch(`wall:${batchKey}`, batch.geometries, material); nextBatches.push({ profile: batch.profile, material });
      yield* checkpoint();
    }
    // MapLibre owns the projection and depth convention. These merged batches
    // have already passed a viewport budget; Three's single batch sphere must not hide them.
    for (const [cell, parts] of cells) {
      if (parts.roofs.length) addBatch(`${cell}:roofs`, parts.roofs, this.roofMaterial);
      yield* checkpoint();
      if (parts.edges.length) addBatch(`${cell}:edges`, parts.edges, this.edgeMaterial, true);
      yield* checkpoint();
      if (parts.reliefs.length) addBatch(`${cell}:reliefs`, parts.reliefs, this.reliefMaterial);
      yield* checkpoint();
      if (parts.signs.length && (typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined')) {
        this.signageResources ??= acquireBuildingSignageResources();
        const signs = addBatch(`${cell}:signs`, parts.signs, this.signageResources.material);
        if (signs) signs.renderOrder = 10;
      }
      yield* checkpoint();
    }
    // Reparent only at commit: a cached live mesh is never stolen by staging.
    this.content.clear();
    if (nextObjects.length) this.content.add(...nextObjects);
    this.spatialCache.prune(new Set(nextObjects), buildOrigin !== this.origin);
    this.batches = nextBatches; this.texturesDirty = true;
    this.entries = nextEntries; this.renderSignature = renderSignature; this.origin = buildOrigin;
    commitTextures(); finish();
    } finally {
      this.buildPhase = 'idle';
      if (!committed) {
        this.spatialCache.prune(new Set(this.content.children));
        for (const textures of stagedTextures.values()) disposeFacadeTextures(textures);
        this.pruneGeometryCache();
      }
    }
  }
  private light(state: LightingState) {
    const light = getBuildingLight(state);
    if (this.texturesDirty) {
      const active = new Set(this.batches.map(batch => buildingTextureKey(batch.profile)));
      // Keep a bounded warm set through turns of the camera; recreating textures
      // and shader materials on every pass causes upload and compilation spikes.
      for (const [key, textures] of this.textures) if (this.textures.size>64&&!active.has(key)) { disposeFacadeTextures(textures); this.textures.delete(key);this.wallMaterials.get(key)?.dispose();this.wallMaterials.delete(key); }
      for (const batch of this.batches) {
        const key = buildingTextureKey(batch.profile);
        let textures = this.textures.get(key);
        if (!textures) {
          textures = makeFacadeTextures(batch.profile);
          const anisotropy = Math.min(this.mobile ? 2 : 4, this.renderer?.capabilities.getMaxAnisotropy() ?? 1);
          textures.diffuse.anisotropy = anisotropy; textures.normal.anisotropy = anisotropy;
          this.textures.set(key, textures);
        }
        const changed=batch.material.map!==textures.diffuse||batch.material.emissiveMap!==textures.emissive||batch.material.normalMap!==(this.mobile ? null : textures.normal);
        batch.material.map = textures.diffuse; batch.material.emissiveMap = textures.emissive;
        // Mobile keeps the same artwork but skips the extra normal-map sample.
        batch.material.normalMap = this.mobile ? null : textures.normal;
        if(changed)batch.material.needsUpdate = true;
      }
      this.texturesDirty = false;
    }
    const budget = buildingDetailBudget(this.mobile), fade = THREE.MathUtils.smoothstep(this.map!.getZoom(), budget.minZoom, budget.minZoom + 0.15);
    // Albedo stays intact. Multiplying it by a dark pigment as well as dimming
    // the lights applied darkness twice and turned both roofs and walls black.
    for (const batch of this.batches) { batch.material.emissiveIntensity = light.warmWindows; batch.material.opacity = fade; }
    this.roofMaterial.opacity = fade; this.reliefMaterial.opacity = fade; this.edgeMaterial.opacity = fade * (0.44 - light.nightAmount * 0.12);
    this.sky.color.set(light.ambientColor); this.sky.intensity = light.ambientIntensity; this.sun.color.set(light.sunColor); this.sun.intensity = light.sunIntensity;
    const d = state.sunDirection; this.sun.position.set(d[0] * 200, d[1] * 200, d[2] * 200);
    // A soft architectural key reveals actual roof slopes at night without
    // pretending that the below-horizon solar source moved above the city.
    this.nightFill.intensity = light.nightAmount * 0.65;
    const azimuth = state.sunAzimuth * Math.PI / 180;
    this.nightFill.position.set(Math.sin(azimuth) * 140, Math.cos(azimuth) * 140, 100);
  }
  private readonly renderTransform = new THREE.Matrix4();
  private readonly renderScale = new THREE.Matrix4();

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map, renderer = this.renderer; if (!map || !renderer || this.failed || this.removed || !this.options.enabled() || map.getZoom() < buildingDetailBudget(this.mobile).minZoom) return;
    try { if (this.dirty) this.beginBuild();
      const diagnosticsVersion = `${this.rebuilds}:${Boolean(this.pendingBuild)}:${this.prefetched}:${this.geometryWorker.completed}`;
      if (this.diagnosticsEnabled && diagnosticsVersion !== this.diagnosticsVersion && map.getCanvas().dataset) { map.getCanvas().dataset.buildingDetails = JSON.stringify({ ...this.getDiagnostics(), zoom: map.getZoom(), pitch: map.getPitch(), center: map.getCenter() }); this.diagnosticsVersion = diagnosticsVersion; }
      if (!this.entries.length) return; this.light(this.options.lighting());
      const unit = this.origin.meterInMercatorCoordinateUnits(), transform = this.renderTransform.makeTranslation(this.origin.x, this.origin.y, 0).multiply(this.renderScale.makeScale(unit, -unit, unit));
      this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(transform); this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert(); renderer.resetState(); renderer.setViewport(0, 0, map.getCanvas().width, map.getCanvas().height); renderer.render(this.scene, this.camera);
    } catch (error) { this.failed = true; this.options.onError?.(error); } finally { renderer.resetState(); }
  }
  onRemove() { this.removed = true; this.cancelBuild(); this.geometryWorker.dispose(); if (this.refreshTimer !== null) clearTimeout(this.refreshTimer); this.refreshTimer = null; this.map?.off('move', this.moving); this.map?.off('moveend', this.changed); this.map?.off('resize', this.changed); this.map?.off('sourcedata', this.sourceChanged); this.map?.off('terrain', this.terrainChanged); this.clear(); this.signageResources?.release(); this.signageResources = null; this.roofMap.dispose(); this.roofMaterial.dispose(); this.reliefMaterial.dispose(); this.edgeMaterial.dispose(); this.renderer?.dispose(); this.scene.clear(); this.map = null; this.renderer = null; }
}
