import * as THREE from 'three';
import type { BuildingProfile } from './building-materials';
import { acquireFacadeArtwork, releaseFacadeArtwork } from './building-facade-artwork';

export type FacadeTextures = { diffuse: THREE.DataTexture; emissive: THREE.DataTexture; normal: THREE.DataTexture };
const SIZE = 256, CELL = SIZE / 4;
const floorBucket = (height: number) => height < 2.75 ? 2.5 : height < 3.25 ? 3 : height < 3.75 ? 3.5 : height < 4.5 ? 4 : height < 6 ? 5 : 7;
/** IDs, colours, floor counts and decorative variants do not multiply draw calls. */
export function buildingTextureKey(profile: BuildingProfile) {
  return `${profile.kind}${profile.kind === 'neutral' ? profile.facadeVariant : ''}:${profile.surface}:${profile.windows}:${profile.tiny ? 'tiny' : floorBucket(profile.floorHeight)}`;
}

type FacadeRecipe = { width: number; glazing: number; band: number; pier: number; glow: number; accent: [number, number, number] };
const recipe = (width: number, glazing: number, band: number, pier: number, glow: number, accent: [number, number, number] = [194, 202, 196]): FacadeRecipe => ({ width, glazing, band, pier, glow, accent });
/** Architectural vocabulary: cues are illustrative; the semantic family comes only from source tags. */
const recipes: Record<string, FacadeRecipe> = {
  neutral: recipe(25, 1, 0, 0, .22),
  residential: recipe(27, 1, 2, 0, .38),
  apartments: recipe(29, 1, 3, 0, .43),
  panel: recipe(30, 1, 2, 2, .4, [200, 211, 208]),
  brick: recipe(26, 1, 4, 1, .4, [221, 202, 183]),
  contemporary: recipe(39, 1.22, 5, 5, .36, [195, 207, 209]),
  house: recipe(25, 1.05, 5, 0, .48, [224, 216, 194]),
  office: recipe(48, 1.28, 4, 3, .18, [188, 211, 217]),
  commercial: recipe(37, 1.16, 4, 1, .22, [208, 209, 197]),
  retail: recipe(50, 1.25, 6, 2, .35, [148, 177, 166]),
  education: recipe(42, 1.0, 4, 2, .12, [212, 199, 169]),
  kindergarten: recipe(35, .94, 8, 3, .08, [232, 195, 144]),
  university: recipe(31, 1.22, 5, 5, .15, [222, 214, 191]),
  hospital: recipe(34, 1.12, 5, 3, .65, [182, 212, 209]),
  clinic: recipe(38, 1, 7, 1, .18, [185, 210, 200]),
  medical: recipe(32, 1.08, 2, 4, .35, [209, 219, 211]),
  industrial: recipe(49, .42, 2, 5, .18, [189, 198, 197]),
  warehouse: recipe(0, 0, 5, 3, 0, [185, 199, 203]),
  garage: recipe(0, 0, 3, 2, 0, [180, 193, 184]),
  shed: recipe(0, 0, 2, 1, 0, [200, 188, 164]),
  outbuilding: recipe(0, 0, 1, 2, 0, [191, 194, 180]),
  religious: recipe(20, 1.8, 5, 2, .1, [238, 230, 209]),
  historic: recipe(23, 1.28, 5, 4, .3, [250, 240, 213]),
  utility: recipe(0, 0, 0, 3, 0, [176, 188, 186]),
  stadium: recipe(0, 0, 7, 5, 0, [207, 219, 224]),
  sports: recipe(46, .65, 9, 4, .2, [179, 205, 211]),
  civic: recipe(29, 1.3, 6, 6, .14, [228, 222, 204]),
  cultural: recipe(24, 1.55, 7, 8, .22, [219, 205, 185]),
  hotel: recipe(28, 1.24, 3, 4, .55, [204, 213, 211]),
  transport: recipe(52, 1.42, 8, 5, .4, [189, 207, 217]),
  agricultural: recipe(15, .6, 5, 3, .05, [205, 192, 165]),
  greenhouse: recipe(55, 1.7, 2, 2, 0, [219, 233, 227]),
};
const texture = (data: Uint8Array, color = true) => {
  const result = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.magFilter = THREE.LinearFilter; result.minFilter = THREE.LinearMipmapLinearFilter;
  result.generateMipmaps = true; result.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  result.needsUpdate = true;
  return result;
};

/** Static albedo, emission and relief. Time changes light uniforms, never bitmap uploads. */
export function makeFacadeTextures(profile: BuildingProfile, _night?: number): FacadeTextures {
  const artwork = acquireFacadeArtwork(profile);
  if (artwork) return artwork;
  const diffuse = new Uint8Array(SIZE * SIZE * 4), emissive = new Uint8Array(SIZE * SIZE * 4);
  const heights = new Float32Array(SIZE * SIZE), normal = new Uint8Array(SIZE * SIZE * 4);
  const kind = profile.kind, spec = recipes[kind] ?? recipes.neutral, h = floorBucket(profile.floorHeight);
  const housing = ['residential', 'apartments', 'panel', 'brick', 'contemporary', 'hotel'].includes(kind);
  const framed = ['historic', 'civic', 'cultural', 'university', 'house'].includes(kind);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const column = Math.floor(x / CELL), row = Math.floor(y / CELL), u = x % CELL, v = y % CELL, at = (y * SIZE + x) * 4;
    const grain = ((x * 17 + y * 13 + (x * y) % 23) % 11) / 3;
    const panelTone = (column * 7 + row * 3) % 4 * 2;
    let rgb: number[] = [246 - grain - panelTone, 246 - grain - panelTone, 243 - grain - panelTone], relief = .52, emission = 0;
    // Seams have a recessed centre and a lit lip, which also feeds the normal map.
    const seam = (condition: boolean, lip: boolean) => {
      if (condition) { rgb = [201, 201, 191]; relief = .42; }
      else if (lip) { rgb = [252, 251, 242]; relief = .55; }
    };
    if (profile.surface === 'brick') seam(y % 8 === 0 || (x + Math.floor(y / 8) % 2 * 10) % 20 === 0, y % 8 === 1);
    if (profile.surface === 'panel') seam(v < 2 || u < 2, v === 2 || u === 2);
    if (profile.surface === 'wood') { seam(y % 10 < 2, y % 10 === 2); if ((x * 3 + y) % 37 === 0) rgb = [216, 210, 190]; }
    if (profile.surface === 'metal') { const rib = x % 8; rgb = [220 + rib * 3, 226 + rib * 2, 225 + rib * 2]; relief = .46 + rib * .018; }
    if (profile.surface === 'stone') seam(y % 16 < 2 || (x + Math.floor(y / 16) % 2 * 20) % 40 < 2, y % 16 === 2);
    if (spec.band && v < spec.band) { rgb = spec.accent; relief = .62; }
    if (spec.band && v === spec.band) { rgb = [255, 253, 243]; relief = .65; }
    if (spec.pier && (u < spec.pier || u > CELL - spec.pier)) { rgb = spec.accent.map(c => Math.min(255, c + 16)); relief = .62; }
    if (kind === 'kindergarten' && (column + row) % 3 === 0 && u < 12) { rgb = [195, 217, 204]; relief = .58; }
    if (kind === 'contemporary' && column === 2 && u < 17) { rgb = [170, 184, 189]; relief = .59; }
    if (kind === 'warehouse' || kind === 'stadium' || kind === 'sports') {
      if (u % (kind === 'stadium' ? 8 : 12) < 2) { rgb = spec.accent; relief = .64; }
      if (kind === 'stadium' && v > 20 && v < 45) { rgb = v % 6 < 2 ? [162, 187, 199] : [213, 226, 231]; relief = v % 6 < 2 ? .4 : .58; }
    }
    if (kind === 'shed' && v % 9 === 0) { rgb = [198, 190, 172]; relief = .43; }
    if (kind === 'outbuilding' && (v % 18 === 0 || u === 1)) { rgb = [204, 207, 191]; relief = .46; }
    if (kind === 'utility' && v > 20 && v < 45 && u > 17 && u < 46) { rgb = v % 5 < 2 ? [137, 156, 159] : [203, 211, 201]; relief = v % 5 < 2 ? .32 : .57; }
    if (kind === 'agricultural' && u % 16 < 2) { rgb = [213, 203, 183]; relief = .63; }

    let width = spec.width + (column === 1 && housing ? 5 : 0);
    let bottom = Math.max(8, Math.round(.8 / h * CELL)), top = Math.min(57, bottom + Math.round(1.55 / h * CELL * spec.glazing));
    let hasWindow = profile.windows !== 'none' && !profile.tiny;
    if (kind === 'house' && column % 2 === 1) hasWindow = false;
    if (kind === 'industrial') { bottom = 43; top = 57; }
    if (kind === 'retail' && row === 0) { width = 54; bottom = 6; top = 49; }
    if (kind === 'religious') { hasWindow = !profile.tiny && row === 0 && column % 2 === 0; bottom = 10; top = 55; }
    if (kind === 'greenhouse' || profile.surface === 'glass') { hasWindow = !profile.tiny; width = 55; bottom = 4; top = 60; }
    const left = Math.round((CELL - width) / 2), right = CELL - left, trim = framed ? 3 : 2;
    const arch = kind !== 'religious' || v < top - width / 2 || (u - CELL / 2) ** 2 + (v - (top - width / 2)) ** 2 < (width / 2 + trim) ** 2;
    if (hasWindow && u >= left - trim && u <= right + trim && v >= bottom - trim && v <= top + trim && arch) {
      rgb = framed ? [255, 247, 225] : [229, 237, 232]; relief = .64;
      if (u > left && u < right && v > bottom && v < top) {
        const reflection = (v - bottom) / Math.max(1, top - bottom), pane = (column * 11 + row * 7) % 9;
        rgb = [88 + reflection * 30 + pane, 120 + reflection * 25 + pane, 133 + reflection * 24]; relief = .27;
        // Dark head/reveal and a small diagonal sky reflection make glazing read as depth.
        if (v > top - 4 || u < left + 2) rgb = [67, 91, 102];
        if ((u + v * .38 + column * 6) % 37 < 4) rgb = rgb.map(c => c + 19);
        const occupied = (column * 13 + row * 7 + 5) % 17 / 17 < spec.glow;
        if (occupied) emission = 145 + (column + row) % 4 * 24;
        const mullion = (width > 37 && Math.abs(u - CELL / 2) < 1.5) || framed && v === Math.round(bottom + (top - bottom) * .66);
        if (mullion) { rgb = [213, 225, 222]; relief = .55; emission = 0; }
      }
      if (v === bottom - trim) { rgb = [171, 182, 178]; relief = .72; }
    }
    // Balcony fronts and brackets share a normal map; no per-window meshes or lights.
    if (housing && column % 2 === 0 && hasWindow && u > left - 5 && u < right + 5 && v >= bottom - 8 && v < bottom - 3) {
      rgb = v === bottom - 4 ? [249, 245, 231] : column === 0 ? [188, 201, 193] : [201, 207, 207];
      relief = v === bottom - 4 ? .85 : .69; emission = 0;
      if (u % 8 === 0 && v < bottom - 5) { rgb = [143, 166, 161]; relief = .55; }
    }
    if (framed && v === top + 5 && u > left - 5 && u < right + 5) { rgb = [253, 246, 224]; relief = .76; }
    if (kind === 'retail' && row === 0 && v > 52 && v < 60) { rgb = spec.accent; relief = .8; emission = 0; }
    if (kind === 'garage' && !profile.tiny && row === 0 && u > 5 && u < 59 && v > 3 && v < 51) {
      rgb = v % 7 < 2 ? [149, 168, 168] : [192, 207, 203]; relief = v % 7 < 2 ? .33 : .48;
      if (u === 33 && v < 18) { rgb = [116, 135, 136]; relief = .63; }
    }
    diffuse.set([rgb[0], rgb[1], rgb[2], 255], at);
    emissive.set([emission, emission * .86, emission * .62, 255], at);
    heights[y * SIZE + x] = relief;
  }
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const dx = (heights[y * SIZE + (x + SIZE - 1) % SIZE] - heights[y * SIZE + (x + 1) % SIZE]) * 2;
    const dy = (heights[((y + SIZE - 1) % SIZE) * SIZE + x] - heights[((y + 1) % SIZE) * SIZE + x]) * 2;
    const length = Math.hypot(dx, dy, 1), at = (y * SIZE + x) * 4;
    normal.set([(dx / length * .5 + .5) * 255, (dy / length * .5 + .5) * 255, (1 / length * .5 + .5) * 255, 255], at);
  }
  return { diffuse: texture(diffuse), emissive: texture(emissive), normal: texture(normal, false) };
}

export function disposeFacadeTextures(textures: FacadeTextures) {
  if (releaseFacadeArtwork(textures)) return;
  textures.diffuse.dispose(); textures.emissive.dispose(); textures.normal.dispose();
}

/** Ground-only shopfronts and doors must not repeat on every fourth floor. */
export function applyGroundFloorTexture(material: THREE.MeshStandardMaterial, profile: BuildingProfile) {
  if (!['retail', 'garage', 'religious'].includes(profile.kind)) return;
  material.customProgramCacheKey = () => 'atlas-ground-floor-facade-v2';
  material.onBeforeCompile = shader => {
    shader.fragmentShader = `vec2 atlasGroundUV(vec2 uv) {
      float level = uv.y * 4.0;
      float row = level < 1.0 ? 0.0 : 1.0 + mod(floor(level) - 1.0, 3.0);
      return vec2(uv.x, (row + fract(level)) / 4.0);
    }\n` + shader.fragmentShader
      .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replaceAll('vMapUv', 'atlasGroundUV(vMapUv)'))
      .replace('#include <emissivemap_fragment>', THREE.ShaderChunk.emissivemap_fragment.replaceAll('vEmissiveMapUv', 'atlasGroundUV(vEmissiveMapUv)'))
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replaceAll('vNormalMapUv', 'atlasGroundUV(vNormalMapUv)'));
  };
}
