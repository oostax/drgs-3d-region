import * as THREE from 'three';
import type { BuildingProfile } from './building-materials';
import type { FacadeTextures } from './building-facade-textures';

export const FACADE_ARTWORK_URL = '/textures/buildings/facades-v2.png';
const SIZE = 384;
let pixels: Uint8ClampedArray[] | null = null;
let loading: Promise<boolean> | null = null;
const shared = new Map<string, { textures: FacadeTextures; users: number }>();

/** Eight authored material families; an unknown use stays unknown. Its stable
 * decorative variant changes the architectural finish without assigning a use. */
export function facadeArtworkTile(profile: BuildingProfile): number | null {
  if (profile.tiny || profile.windows === 'none') return null;
  if (profile.surface === 'brick') return 2;
  if (profile.surface === 'glass') return 4;
  switch (profile.kind) {
    case 'neutral': return [0, 1, 3][profile.facadeVariant ?? 0];
    case 'panel': case 'apartments': case 'residential': return 1;
    case 'contemporary': case 'hotel': return 3;
    case 'office': case 'commercial': case 'transport': case 'greenhouse': return 4;
    case 'education': case 'kindergarten': case 'university': return 5;
    case 'hospital': case 'clinic': case 'medical': return 6;
    case 'industrial': case 'sports': return 7;
    case 'historic': case 'civic': case 'cultural': case 'house': case 'brick': return 0;
    default: return null;
  }
}

/** Decode once on demand. Only eight 384px tiles are retained, without a second
 * full-resolution GPU atlas. Sampling crops the incomplete fourth source floor;
 * UV repetition below keeps the three complete floors at their physical height. */
export function loadFacadeArtwork(): Promise<boolean> {
  if (pixels) return Promise.resolve(true);
  if (typeof document === 'undefined') return Promise.resolve(false);
  if (loading) return loading;
  loading = new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = SIZE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) { resolve(false); return; }
        pixels = Array.from({ length: 8 }, (_, tile) => {
          const width = image.width / 4, height = image.height / 2;
          context.drawImage(image, tile % 4 * width + 1, Math.floor(tile / 4) * height + 1, width - 2, height * .835 - 2, 0, 0, SIZE, SIZE);
          return context.getImageData(0, 0, SIZE, SIZE).data;
        });
        resolve(true);
      } catch { pixels = null; resolve(false); }
    };
    image.onerror = () => resolve(false);
    image.src = FACADE_ARTWORK_URL;
  });
  const pending = loading;
  void pending.then(ready => { if (!ready && loading === pending) loading = null; });
  return pending;
}

function texture(data: Uint8Array, color: boolean) {
  const map = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.y = 4 / 3;
  map.generateMipmaps = true; map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter; map.needsUpdate = true;
  return map;
}

export function acquireFacadeArtwork(profile: BuildingProfile): FacadeTextures | null {
  const tile = facadeArtworkTile(profile);
  if (!pixels || tile === null) return null;
  // One shared emission pattern per material family, with unclassified buildings
  // kept unlit. No textures or point lights per individual window/building.
  const occupied = profile.kind === 'neutral' ? 0 : ['hospital', 'hotel'].includes(profile.kind) ? .58 : ['education', 'kindergarten', 'university', 'industrial'].includes(profile.kind) ? .1 : .32;
  const key = `${tile}:${occupied}`;
  const existing = shared.get(key);
  if (existing) { existing.users++; return existing.textures; }
  const diffuse = new Uint8Array(SIZE * SIZE * 4), emission = new Uint8Array(diffuse.length), normal = new Uint8Array(diffuse.length);
  const height = new Float32Array(SIZE * SIZE), source = pixels[tile];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const at = (y * SIZE + x) * 4, sourceAt = ((SIZE - y - 1) * SIZE + x) * 4;
    const r = source[sourceAt], g = source[sourceAt + 1], b = source[sourceAt + 2];
    diffuse.set([r, g, b, 255], at);
    const u = (x / SIZE * 4) % 1, v = (y / SIZE * 3) % 1;
    const glazing = u > .15 && u < .85 && v > .16 && v < .89 && b > r * 1.08 && g > r * 1.04 && r < 145;
    const column = Math.floor(x / SIZE * 4), row = Math.floor(y / SIZE * 3);
    const lit = (column * 13 + row * 7 + 5) % 17 / 17 < occupied;
    const glow = glazing && lit ? Math.min(145, 50 + (r + g + b) / 6) : 0;
    emission.set([glow, glow * .82, glow * .55, 255], at);
    height[y * SIZE + x] = glazing ? .2 : .48 + (r + g + b) / 765 * .15;
  }
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const dx = (height[y * SIZE + (x + SIZE - 1) % SIZE] - height[y * SIZE + (x + 1) % SIZE]) * 1.6;
    const dy = (height[((y + SIZE - 1) % SIZE) * SIZE + x] - height[((y + 1) % SIZE) * SIZE + x]) * 1.6;
    const length = Math.hypot(dx, dy, 1);
    normal.set([(dx / length * .5 + .5) * 255, (dy / length * .5 + .5) * 255, (.5 / length + .5) * 255, 255], (y * SIZE + x) * 4);
  }
  const textures = { diffuse: texture(diffuse, true), emissive: texture(emission, true), normal: texture(normal, false) };
  for (const map of Object.values(textures)) map.userData.facadeArtworkKey = key;
  shared.set(key, { textures, users: 1 });
  return textures;
}

export function releaseFacadeArtwork(textures: FacadeTextures): boolean {
  const key = textures.diffuse.userData.facadeArtworkKey as string | undefined;
  if (!key) return false;
  const entry = shared.get(key);
  if (entry && --entry.users <= 0) {
    Object.values(entry.textures).forEach(map => map.dispose()); shared.delete(key);
  }
  return true;
}
