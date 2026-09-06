import type { ExpressionSpecification, Map as LibreMap } from 'maplibre-gl';
import { BUILDING_FACADE_VARIANT } from './building-materials';

type Surface = 'regular' | 'wide' | 'plain' | 'roof';
const surfaces: Surface[] = ['regular', 'wide', 'plain', 'roof'];
// A bounded atlas, independent of the number of buildings. Overview pigments
// approximate source colours; the close architectural pass retains exact colours.
const walls = ['#c5b999', '#aa816a', '#a2b0a0', '#a0adaa', '#d2cbbb', '#839da0', '#b59477', '#747b78'];
const roofs = ['#637b76', '#97705c', '#79866c', '#687981', '#998e78', '#567579', '#856e60', '#525e60'];
const id = (surface: Surface, swatch: number, zoom: number) => `atlas-surface-${surface}-${swatch}-z${zoom}`;
const images = new Map<string, { width: number; height: number; data: Uint8Array }>();

export function buildingSurfaceImage(surface: Surface, swatch = 0) {
  const key = `${surface}-${swatch}`, found = images.get(key);
  if (found) return found;
  const hex = (surface === 'roof' ? roofs : walls)[swatch];
  const pigment = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x % 16, v = y % 16, grain = ((x * 13 + y * 17) % 7 - 3) * 0.7;
    let rgb = pigment.map(channel => channel + grain);
    if (surface === 'roof') {
      const shade = x % 16 === 0 ? -13 : x % 16 === 1 ? 9 : y % 32 === 0 ? -5 : 0;
      rgb = rgb.map(channel => channel + shade);
    } else if (surface === 'plain') {
      // Unclassified buildings get material joints, never an invented use or lit windows.
      const shade = y % 16 === 0 || x % 32 === 0 ? -13 : 0;
      rgb = rgb.map(channel => channel + shade);
    } else {
      const left = surface === 'wide' ? 2 : 4, right = surface === 'wide' ? 14 : 12;
      if (u >= left && u <= right && v >= 4 && v <= 12) rgb = [65 + v, 87 + v, 94 + v];
      if (u >= left - 1 && u <= right + 1 && (v === 3 || v === 13)) rgb = pigment.map(channel => channel + (v === 3 ? 13 : -26));
      if (y % 16 === 0) rgb = pigment.map(channel => channel - 9);
    }
    data.set([...rgb.map(channel => Math.max(0, Math.min(255, Math.round(channel)))), 255], (y * size + x) * 4);
  }
  const image = { width: size, height: size, data }; images.set(key, image); return image;
}

/** Aliases share the same 32 CPU images. Integer-zoom scaling keeps a four-floor
 * / 12 m vertical repeat, without downloading textures or rebuilding JS meshes.
 */
export function registerBuildingSurfaces(map: Pick<LibreMap, 'hasImage' | 'addImage'>) {
  for (const surface of surfaces) for (let swatch = 0; swatch < walls.length; swatch++) for (let zoom = 10; zoom <= 20; zoom++) {
    const key = id(surface, swatch, zoom);
    if (!map.hasImage(key)) map.addImage(key, buildingSurfaceImage(surface, swatch), { pixelRatio: 64 / (12 * 2 ** (zoom - 16)) });
  }
}

// The overview needs only window layout, not the full architectural catalogue.
// Close models still use the full classifier, including inherited/source tags.
const purpose: ExpressionSpecification = ['downcase', ['to-string', ['coalesce', ['get', 'class'], ['get', 'amenity'], ['get', 'building'], '']]];
const family: ExpressionSpecification = ['match', purpose,
  ['apartments', 'panel', 'brick', 'house', 'residential', 'hotel', 'historic', 'education', 'kindergarten', 'university', 'hospital', 'clinic', 'medical', 'civic', 'cultural'], 'regular',
  ['office', 'retail', 'commercial', 'contemporary', 'transport', 'greenhouse'], 'wide', 'plain'];

function overviewPigment(roof: boolean): ExpressionSpecification {
  const raw: ExpressionSpecification = ['coalesce', ...(
    roof ? ['roof_color', 'roof:colour', 'roof:color'] : ['facade_color', 'building:colour', 'building:color']
  ).map(key => ['get', key] as ExpressionSpecification), ''];
  const variation: ExpressionSpecification = ['match', BUILDING_FACADE_VARIANT, 1, roof ? 1 : 4, 2, roof ? 3 : 2, 0];
  const fallback: ExpressionSpecification = roof ? variation : ['match', purpose,
    'brick', 1, ['historic', 'education', 'university', 'cultural'], 6,
    ['office', 'commercial'], 5, ['industrial', 'warehouse', 'contemporary'], 3, variation];
  // Coarse source-pigment bins keep this per-feature expression small. Repeated
  // nearest-colour searches through the full architectural expression are costly.
  return ['let', 'pigment', ['to-color', raw, 'transparent'],
    ['let', 'r', ['at', 0, ['to-rgba', ['var', 'pigment']]],
      'g', ['at', 1, ['to-rgba', ['var', 'pigment']]], 'b', ['at', 2, ['to-rgba', ['var', 'pigment']]],
      ['case', ['<', ['at', 3, ['to-rgba', ['var', 'pigment']]], 0.9], fallback,
        ['<', ['max', ['var', 'r'], ['var', 'g'], ['var', 'b']], 95], 7,
        ['all', ['>', ['var', 'r'], ['+', ['var', 'g'], 22]], ['>', ['var', 'r'], ['+', ['var', 'b'], 22]]], 1,
        ['>', ['var', 'b'], ['+', ['var', 'r'], 12]], 5,
        ['>', ['var', 'g'], ['+', ['var', 'r'], 9]], 2,
        ['>', ['var', 'r'], ['+', ['var', 'b'], 25]], roof ? 4 : 0,
        ['>', ['min', ['var', 'r'], ['var', 'g'], ['var', 'b']], 190], 4, 3]]] as ExpressionSpecification;
}

export function buildingSurfacePattern(roof = false): ExpressionSpecification {
  const at = (zoom: number): ExpressionSpecification => ['image', ['concat', 'atlas-surface-', ['var', 'surfaceFamily'], '-', ['to-string', ['var', 'swatch']], `-z${zoom}`]];
  // Hoist expensive property classification above the zoom branches.
  return ['let', 'surfaceFamily', roof ? 'roof' : family, 'swatch', overviewPigment(roof),
    ['step', ['zoom'], at(10), ...Array.from({ length: 10 }, (_, index) => { const zoom = index + 11; return [zoom, at(zoom)]; }).flat()]] as ExpressionSpecification;
}
