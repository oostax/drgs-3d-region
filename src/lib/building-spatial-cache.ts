import * as THREE from 'three';
import { refillGeometryBatch } from './map-geometry-batch';

type BatchObject = THREE.Mesh | THREE.LineSegments;
type CachedBatch = { object: BatchObject; bytes: number };
/** Fixed Mercator cells (~2.8 km at Kazan), independent of viewport and zoom. */
export function buildingSpatialCell(lng: number, lat: number) {
  const x = (lng + 180) / 360, sin = Math.sin(lat * Math.PI / 180);
  const y = .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return `${Math.floor(x * 8192)}:${Math.floor(y * 8192)}`;
}

/** Immutable merged GPU buffers. Cache hits never refill or re-upload attributes. */
export class BuildingSpatialCache {
  private items = new Map<string, CachedBatch>();
  hits = 0; misses = 0;
  constructor(private maxBytes: number, private readonly maxEntries = 256) {}
  get bytes() { let bytes = 0; for (const item of this.items.values()) bytes += item.bytes; return bytes; }
  get size() { return this.items.size; }
  setMaxBytes(maxBytes: number) { this.maxBytes = maxBytes; }
  acquire(cellAndMaterial: string, parts: THREE.BufferGeometry[], material: THREE.Material, lines = false): BatchObject | null {
    if (!parts.length) return null;
    // Order is canonical so ranking changes within an unchanged cell do not upload it again.
    const ordered = [...parts].sort((a, b) => a.uuid.localeCompare(b.uuid));
    const key = `${cellAndMaterial}|${ordered.map(part => part.uuid).join(',')}`;
    const cached = this.items.get(key);
    if (cached) { this.items.delete(key); this.items.set(key, cached); this.hits++; cached.object.material = material; return cached.object; }
    const geometry = refillGeometryBatch(undefined, ordered); if (!geometry) return null;
    const object = lines ? new THREE.LineSegments(geometry, material) : new THREE.Mesh(geometry, material);
    object.matrixAutoUpdate = false; object.frustumCulled = false; object.userData.batchKey = cellAndMaterial;
    const bytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
    this.items.set(key, { object, bytes }); this.misses++; return object;
  }
  prune(protectedObjects: ReadonlySet<THREE.Object3D>, discardInactive = false) {
    let bytes = this.bytes;
    for (const [key, item] of this.items) {
      if (!discardInactive && bytes <= this.maxBytes && this.items.size <= this.maxEntries) break;
      // Live and staging buffers are never released to satisfy a cache budget.
      if (protectedObjects.has(item.object)) continue;
      item.object.geometry.dispose(); this.items.delete(key); bytes -= item.bytes;
    }
  }
  clear() { for (const item of this.items.values()) item.object.geometry.dispose(); this.items.clear(); }
}
