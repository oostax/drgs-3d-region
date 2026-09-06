import type { ExpressionSpecification, FillLayerSpecification, LayerSpecification, Map as LibreMap } from 'maplibre-gl';
import { mixCssColor } from './map-style-colors';

type GroundPattern = 'vegetation' | 'mineral' | 'soil';
type GroundRole = 'neutral' | 'residential' | 'industrial' | 'campus' | 'park' | 'wood' | 'grass' | 'farmland' | 'wetland' | 'sand' | 'rock' | 'ice';
export const GROUND_PALETTE: Record<GroundRole, { day: string; night: string }> = {
  neutral: { day: '#b7b29e', night: '#30372f' },
  residential: { day: '#c4bca6', night: '#3a3d34' },
  industrial: { day: '#a0a99f', night: '#313a36' },
  campus: { day: '#c1b69d', night: '#393c32' },
  park: { day: '#93aa7b', night: '#2c3d2d' },
  wood: { day: '#64865f', night: '#243a2c' },
  grass: { day: '#91ac70', night: '#30422c' },
  farmland: { day: '#afa975', night: '#3d4230' },
  wetland: { day: '#7e9b80', night: '#2a4037' },
  sand: { day: '#c5b28c', night: '#484535' },
  rock: { day: '#aca793', night: '#3b4039' },
  ice: { day: '#dce5df', night: '#495653' },
};

const PATTERN_SIZE = 128;
const PATTERNS: GroundPattern[] = ['vegetation', 'mineral', 'soil'];
const images = new Map<GroundPattern, { width: number; height: number; data: Uint8Array }>();
const patternId = (kind: GroundPattern) => `atlas-ground-grain-rgb-${kind}`;
const polygon: ExpressionSpecification = ['==', ['geometry-type'], 'Polygon'];
const landuseClasses = ['residential', 'suburb', 'quarter', 'neighbourhood', 'industrial', 'commercial', 'retail', 'garages', 'school', 'university', 'kindergarten', 'college', 'library', 'hospital', 'cemetery', 'military', 'quarry'];
const landcoverClasses = ['wood', 'grass', 'farmland', 'wetland', 'sand', 'rock', 'ice'];
const inClass = (classes: string[]): ExpressionSpecification => ['in', ['get', 'class'], ['literal', classes]];
const matchClass = (pairs: (string | string[] | ExpressionSpecification)[], fallback: string): ExpressionSpecification => ['match', ['get', 'class'], ...pairs, fallback] as unknown as ExpressionSpecification;

/** No vegetation is inferred outside mapped landcover; the regional base is mineral. */
export function groundColor(role: GroundRole, night: number) {
  const palette = GROUND_PALETTE[role];
  return mixCssColor(palette.day, palette.night, Math.max(0, Math.min(1, night)));
}

export function groundColorExpression(sourceLayer: 'landuse' | 'landcover' | 'park', night: number): ExpressionSpecification | string {
  const color = (role: GroundRole) => groundColor(role, night);
  if (sourceLayer === 'park') return color('park');
  if (sourceLayer === 'landuse') return matchClass([
    ['residential', 'suburb', 'quarter', 'neighbourhood'], color('residential'),
    ['industrial', 'commercial', 'retail', 'garages'], color('industrial'),
    ['school', 'university', 'kindergarten', 'college', 'library', 'hospital'], color('campus'),
    'cemetery', color('park'), 'military', color('neutral'), 'quarry', color('sand'),
  ], color('neutral'));
  return matchClass([
    'wood', color('wood'), 'grass', color('grass'), 'farmland', color('farmland'),
    'wetland', color('wetland'), 'sand', color('sand'), 'rock', color('rock'), 'ice', color('ice'),
  ], color('neutral'));
}

function patternExpression(sourceLayer: 'landuse' | 'landcover'): ExpressionSpecification {
  if (sourceLayer === 'landuse') return matchClass(['cemetery', patternId('vegetation'), 'quarry', patternId('soil')], patternId('mineral'));
  return matchClass([['wood', 'grass', 'wetland'], patternId('vegetation'), ['farmland', 'sand'], patternId('soil')], patternId('mineral'));
}

function periodicNoise(x: number, y: number, cells: number, seed: number) {
  const gx = x / PATTERN_SIZE * cells, gy = y / PATTERN_SIZE * cells;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fade = (value: number) => value * value * (3 - 2 * value);
  const sample = (a: number, b: number) => {
    let n = Math.imul((a % cells) + seed, 374761393) ^ Math.imul((b % cells) + seed * 3, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const u = fade(gx - ix), v = fade(gy - iy);
  const top = sample(ix, iy) * (1 - u) + sample(ix + 1, iy) * u;
  const bottom = sample(ix, iy + 1) * (1 - u) + sample(ix + 1, iy + 1) * u;
  return top * (1 - v) + bottom * v;
}

/** Three immutable 128² pigments: broad mottling + soft grain, no single-pixel noise. */
export function groundPatternImage(kind: GroundPattern) {
  const cached = images.get(kind); if (cached) return cached;
  const seed = { vegetation: 17, mineral: 47, soil: 83 }[kind];
  const data = new Uint8Array(PATTERN_SIZE * PATTERN_SIZE * 4);
  for (let y = 0; y < PATTERN_SIZE; y++) for (let x = 0; x < PATTERN_SIZE; x++) {
    const broad = periodicNoise(x, y, 3, seed), grain = periodicNoise(x, y, 32, seed + 13);
    const middle = periodicNoise(x, y, kind === 'mineral' ? 16 : 9, seed + 5);
    const pigment = kind === 'vegetation' ? [145, 172, 112] : kind === 'soil' ? [180, 164, 125] : [174, 168, 151];
    const variation = 0.78 + 0.4 * (broad * 0.56 + middle * 0.3 + grain * 0.14);
    const offset = (y * PATTERN_SIZE + x) * 4;
    for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.round(pigment[channel] * variation);
    // Fully colored pixels remain a natural pigment even where tile polygons
    // overlap. No black alpha mask and no offscreen layer-opacity composite.
    data[offset + 3] = 255;
  }
  const image = { width: PATTERN_SIZE, height: PATTERN_SIZE, data }; images.set(kind, image); return image;
}

type GroundCache = { entries: Map<string, { layer: unknown; bucket: number }>; replaced: Map<string, unknown>; night?: number; diagnosticBound?: boolean };
const maps = new WeakMap<LibreMap, GroundCache>();
const groundSource = (layer: LayerSpecification) => layer.type === 'fill' && layer.source === 'openmaptiles' && ['landuse', 'landcover', 'park'].includes(layer['source-layer'] ?? '');

/** Shared semantic passes replace the sparse basemap fills, retaining tile geometry. */
export function isManagedGroundLayer(layer: LayerSpecification) {
  return layer.id === 'atlas-russia-ground' || layer.id.startsWith('atlas-ground-') || (!layer.id.startsWith('atlas-') && groundSource(layer));
}

export function applyGroundMaterials(map: LibreMap, layers: LayerSpecification[], night: number): boolean {
  if (!map.getSource('openmaptiles')) return false;
  let cache = maps.get(map);
  if (!cache) { cache = { entries: new Map(), replaced: new Map() }; maps.set(map, cache); }
  const bucket = Math.round(Math.max(0, Math.min(1, night)) * 20), amount = bucket / 20;
  const patternOpacity = (strength: number) => textureOpacity(amount, strength);
  cache.night = amount;
  let changed = false;
  const write = (id: string, property: 'fill-color' | 'fill-opacity' | 'fill-layer-opacity' | 'fill-pattern', value: string | number | ExpressionSpecification) => {
    const layer = map.getLayer(id); if (!layer) return;
    const key = `${id}:${property}`, entry = cache.entries.get(key);
    if (entry?.layer === layer && entry.bucket === bucket) return;
    map.setPaintProperty(id, property, value);
    cache.entries.set(key, { layer, bucket }); changed = true;
  };
  for (const kind of PATTERNS) if (!map.hasImage(patternId(kind))) {
    map.addImage(patternId(kind), groundPatternImage(kind), { pixelRatio: 1 }); changed = true;
  }
  // Every pass remains below water, buildings, roads and analytical overlays.
  // Existing residential ended at z16, and the base style omitted grass/soil.
  const before = layers.find((layer) => layer.type !== 'background' && layer.type !== 'raster' && layer.id !== 'atlas-russia-ground')?.id;
  const add = (layer: FillLayerSpecification) => { if (!map.getLayer(layer.id)) { map.addLayer(layer, before); changed = true; } };
  const setPatternVisibility = (id: string) => {
    if (typeof map.setLayoutProperty !== 'function') return;
    const key = `${id}:visibility`, live = map.getLayer(id), entry = cache.entries.get(key);
    if (!live || entry?.layer === live) return;
    map.setLayoutProperty(id, 'visibility', 'visible');
    cache.entries.set(key, { layer: live, bucket: 0 }); changed = true;
  };
  if (map.getLayer('atlas-russia-ground') && map.getSource('atlas-russia')) {
    write('atlas-russia-ground', 'fill-color', groundColor('neutral', amount));
    add({ id: 'atlas-ground-neutral-grain', type: 'fill', source: 'atlas-russia', minzoom: 9, paint: { 'fill-pattern': patternId('mineral'), 'fill-opacity': 0 } });
    setPatternVisibility('atlas-ground-neutral-grain');
    write('atlas-ground-neutral-grain', 'fill-layer-opacity', 1);
    write('atlas-ground-neutral-grain', 'fill-pattern', patternId('mineral'));
    write('atlas-ground-neutral-grain', 'fill-opacity', patternOpacity(0.22));
  }
  for (const sourceLayer of ['landuse', 'park', 'landcover'] as const) {
    const id = `atlas-ground-${sourceLayer}`;
    const fillColor = groundColorExpression(sourceLayer, amount);
    const filter: ExpressionSpecification = sourceLayer === 'park' ? polygon : ['all', polygon, inClass(sourceLayer === 'landuse' ? landuseClasses : landcoverClasses)];
    const opacity: ExpressionSpecification | number = sourceLayer === 'park' ? 0.25 : ['interpolate', ['linear'], ['zoom'], 4, 0.4, 9, 0.85, 12, 1];
    add({ id, type: 'fill', source: 'openmaptiles', 'source-layer': sourceLayer, filter, paint: { 'fill-color': fillColor, 'fill-opacity': opacity } });
    write(id, 'fill-color', fillColor);
    // A protected-area boundary alone does not prove grass or tree cover.
    // Keep its designation tint quiet; actual vegetation receives texture below.
    if (sourceLayer !== 'park') {
      const patternFilter: ExpressionSpecification = sourceLayer === 'landcover' ? ['all', filter, ['!=', ['get', 'class'], 'ice']] : filter;
      add({ id: `${id}-grain`, type: 'fill', source: 'openmaptiles', 'source-layer': sourceLayer, minzoom: 9, filter: patternFilter, paint: { 'fill-pattern': patternExpression(sourceLayer), 'fill-opacity': 0 } });
      setPatternVisibility(`${id}-grain`);
      // fill-layer-opacity used a scratch FBO and produced black landcover at
      // source-tile zooms with terrain. Ordinary fill-opacity uses the normal
      // tile draw path; overlapping colored pigments stay naturally bounded.
      write(`${id}-grain`, 'fill-layer-opacity', 1);
      write(`${id}-grain`, 'fill-pattern', patternExpression(sourceLayer));
      write(`${id}-grain`, 'fill-opacity', patternOpacity(sourceLayer === 'landcover' ? 0.42 : 0.32));
    }
  }
  for (const layer of layers) if (!layer.id.startsWith('atlas-') && groundSource(layer)) {
    const live = map.getLayer(layer.id);
    if (live && cache.replaced.get(layer.id) !== live) {
      map.setPaintProperty(layer.id, 'fill-opacity', 0); cache.replaced.set(layer.id, live); changed = true;
    }
  }
  if (process.env.NODE_ENV !== 'production' && typeof map.getCanvas === 'function') {
    if (!cache.diagnosticBound && typeof map.on === 'function') {
      cache.diagnosticBound = true;
      map.on('moveend', () => publishGroundDiagnostics(map));
    }
    publishGroundDiagnostics(map);
  }
  return changed;
}

function publishGroundDiagnostics(map: LibreMap) {
  const canvas = map.getCanvas(), style = map.getStyle(); if (!canvas?.dataset || !style?.layers) return;
  canvas.dataset.groundMaterials = JSON.stringify({
    revision: 'ground-rgb-v3', zoom: Number(map.getZoom().toFixed(3)), night: maps.get(map)?.night,
    patternImages: PATTERNS.filter(kind => map.hasImage(patternId(kind))).length, compositedLayers: 0,
  });
}

export function textureOpacity(night: number, strength: number): ExpressionSpecification {
  // Day pigment never glows over the night palette; textures reuse the same
  // images, fading out while the base surface carries the night appearance.
  const intensity = strength * (1 - Math.max(0, Math.min(1, night))) ** 2;
  return ['interpolate', ['linear'], ['zoom'], 9, 0, 12, intensity * 0.72, 15, intensity, 20, intensity];
}
