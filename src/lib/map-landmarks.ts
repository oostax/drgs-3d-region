import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as LibreMap } from 'maplibre-gl';
import { LANDMARKS, type Landmark } from './landmarks';
import { createLandmarkModel, disposeLandmarkModel, type LandmarkDetail } from './landmark-models';
import type { LightingState } from './solar';
import { getBuildingLight } from './building-materials';

/** Exact OSM-record matches in Overture; provenance: public/data/landmark-buildings.json.
 * Only these 8 parent buildings and their 29 linked parts are substituted.
 */
export const LANDMARK_BUILDING_IDS: Record<string, readonly string[]> = {
  'qol-sharif': ['65bec153-c7ef-4afa-b71c-322edb2741d0'],
  'suyumbike': ['3d7c4c6f-87ab-446a-bfb8-3ba2a7e9582c'],
  'spasskaya': ['93353e22-ac5a-4f2c-9060-a070d46a21a8'],
  'farmers-palace': ['49106643-eb01-47ea-84f0-f63202c020f4'],
  'kazan-family-center': ['a8a7332c-9e49-44eb-9d64-c8620b864337'],
  'innopolis-university': ['2506a6d9-1834-4465-ab18-61ddf82cd5da'],
  'popov-technopark': ['efe7e105-c490-4126-924c-f53867aa62dd'],
  'white-mosque-bolgar': ['8af79095-4384-4ad0-b200-5bf5929fb85b'],
};

type Entry = {
  landmark: Landmark;
  scene: THREE.Scene;
  models: Partial<Record<LandmarkDetail, THREE.Group>>;
  current: THREE.Group | null;
  projection: THREE.Matrix4 | null;
  lighting: LightingState | null;
};

/** MapLibre 6 custom-layer bridge. Procedural models are Z-up, in metres. */
export class LandmarkMapLayer implements CustomLayerInterface {
  readonly id = 'atlas-landmarks';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map: LibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly camera = new THREE.Camera();
  private readonly entries: Entry[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private renderFailed = false;

  constructor(private readonly options: { visible: () => boolean; mobile: boolean; lighting?: () => LightingState; onError?: (error: unknown) => void }) {}

  onAdd(map: LibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
      this.renderer.autoClear = false;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;
      this.camera.matrixAutoUpdate = false;
      for (const landmark of LANDMARKS) {
        const scene = new THREE.Scene();
        const sky = new THREE.HemisphereLight(0xf0f8ed, 0x70816a, 2.1);
        sky.position.set(0, 0, 1); scene.add(sky);
        const sun = new THREE.DirectionalLight(0xffefd3, 2.9); sun.position.set(-70, -95, 140); scene.add(sun);
        const fill = new THREE.DirectionalLight(0xcfede4, 0.9); fill.position.set(70, 80, 40); scene.add(fill);
        this.entries.push({ landmark, scene, models: {}, current: null, projection: null, lighting: null });
      }
    } catch (error) { this.renderFailed = true; this.options.onError?.(error); }
  }

  private readonly renderTransform = new THREE.Matrix4();
  private readonly renderScale = new THREE.Matrix4();
  private readonly renderProjection = new THREE.Matrix4();

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map, renderer = this.renderer;
    if (!map || !renderer || this.renderFailed) return;
    // No continuous repaint loop: camera/source changes already schedule frames.
    if (!this.options.visible() || map.getZoom() < 13.8) {
      this.entries.forEach((entry) => { entry.projection = null; });
      return;
    }
    try {
      const bounds = map.getBounds();
      const detail: LandmarkDetail = this.options.mobile || map.getZoom() < 17 ? 'low' : 'high';
      renderer.resetState();
      renderer.setViewport(0, 0, map.getCanvas().width, map.getCanvas().height);
      const projection = this.renderProjection.fromArray(args.defaultProjectionData.mainMatrix);
      for (const entry of this.entries) {
        if (!bounds.contains(entry.landmark.coordinates)) { entry.projection = null; continue; }
        let model = entry.models[detail];
        if (!model) {
          model = createLandmarkModel(entry.landmark.modelKind, detail);
          // Authored landmark geometry is static; camera movement changes only projection.
          model.traverse(object => { object.updateMatrix(); object.matrixAutoUpdate = false; });
          entry.models[detail] = model; entry.scene.add(model); entry.lighting = null;
        }
        for (const candidate of Object.values(entry.models)) candidate.visible = candidate === model;
        entry.current = model;
        const lighting = this.options.lighting?.();
        if (lighting && entry.lighting !== lighting) {
          const light = getBuildingLight(lighting);
          const sky = entry.scene.children[0] as THREE.HemisphereLight, sun = entry.scene.children[1] as THREE.DirectionalLight, fill = entry.scene.children[2] as THREE.DirectionalLight;
          sky.intensity = 0.45 + lighting.brightness * 1.7; sky.color.set(light.ambientColor);
          sun.intensity = 0.15 + lighting.brightness * 2.9; sun.color.set(light.sunColor);
          const d = lighting.sunDirection; sun.position.set(d[0] * 150, d[1] * 150, Math.max(18, d[2] * 150));
          fill.intensity = 0.75 + lighting.nightAmount * 1.1; fill.color.set(light.ambientColor); fill.position.set(20, -80, 20);
          for (const candidate of Object.values(entry.models)) candidate.traverse((object) => { if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial && object.material.color.getHex() === 0x366c73) { object.material.emissive.set('#ffd6a0'); object.material.emissiveIntensity = lighting.nightAmount * 0.85; } });
          entry.lighting = lighting;
        }
        const elevation = map.getTerrain() ? map.queryTerrainElevation(entry.landmark.coordinates) ?? 0 : 0;
        const coordinate = MercatorCoordinate.fromLngLat(entry.landmark.coordinates, elevation + 0.15);
        const scale = coordinate.meterInMercatorCoordinateUnits();
        // Multiplication stays in JS doubles; vertices stay near a local origin.
        // Mercator Y points south, while the authored models' Y points north.
        const transform = this.renderTransform.makeTranslation(coordinate.x, coordinate.y, coordinate.z)
          .multiply(this.renderScale.makeScale(scale, -scale, scale))
          .multiply(new THREE.Matrix4().makeRotationZ(entry.landmark.rotation));
        this.camera.projectionMatrix.copy(projection).multiply(transform);
        this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
        (entry.projection ??= new THREE.Matrix4()).copy(this.camera.projectionMatrix);
        renderer.render(entry.scene, this.camera);
      }
      renderer.resetState();
    } catch (error) {
      this.renderFailed = true; renderer.resetState(); this.options.onError?.(error);
    }
  }

  /** Raycast actual instanced geometry; called before the underlying map layers. */
  pick(point: { x: number; y: number }): string | null {
    const map = this.map;
    if (!map || !this.options.visible() || this.renderFailed) return null;
    const width = map.getCanvas().clientWidth, height = map.getCanvas().clientHeight;
    const x = point.x / width * 2 - 1, y = 1 - point.y / height * 2;
    let hit: { id: string; distance: number } | null = null;
    for (const entry of this.entries) {
      if (!entry.projection || !entry.current) continue;
      const inverse = entry.projection.clone().invert();
      const near = new THREE.Vector3(x, y, -1).applyMatrix4(inverse);
      const far = new THREE.Vector3(x, y, 1).applyMatrix4(inverse);
      this.raycaster.ray.set(near, far.sub(near).normalize());
      const intersection = this.raycaster.intersectObject(entry.current, true)[0];
      if (intersection && (!hit || intersection.distance < hit.distance)) hit = { id: entry.landmark.id, distance: intersection.distance };
    }
    return hit?.id ?? null;
  }

  onRemove() {
    for (const entry of this.entries) {
      Object.values(entry.models).forEach(disposeLandmarkModel); entry.scene.clear();
    }
    this.entries.length = 0;
    this.renderer?.dispose(); // Never forceContextLoss: MapLibre owns the context.
    this.renderer = null; this.map = null;
  }
}
