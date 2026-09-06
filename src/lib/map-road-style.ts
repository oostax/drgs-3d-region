import type { ExpressionSpecification, LayerSpecification, LineLayerSpecification, Map as LibreMap } from 'maplibre-gl';
import { mixCssColor } from './map-style-colors';
import { ROAD_ASPHALT_COLOR, roadGeometryProfile } from './map-transport-profile';

const majorClasses = ['motorway', 'trunk', 'primary'];
const carClasses = [...majorClasses, 'secondary', 'tertiary', 'minor', 'service', 'track'];
const classExpression: ExpressionSpecification = ['to-string', ['coalesce', ['get', 'roadClass'], ['get', 'class'], 'minor']];
const inValues = (value: ExpressionSpecification, values: (string | number | boolean)[]): ExpressionSpecification => ['in', value, ['literal', values]];
function bindVariables(...items: (string | ExpressionSpecification)[]): ExpressionSpecification {
  let result = items.at(-1) as ExpressionSpecification;
  for (let index = items.length - 3; index >= 0; index -= 2) result = ['let', items[index] as string, items[index + 1] as ExpressionSpecification, result];
  return result;
}
const positiveSourceNumber = (name: string): ExpressionSpecification => bindVariables('raw', ['to-string', ['coalesce', ['get', name], '']], 'unit', ['index-of', 'm', ['var', 'raw']],
  ['max', 0, ['to-number', ['case', ['all', ['>=', ['var', 'unit'], 0], inValues(['slice', ['var', 'raw'], ['var', 'unit']], ['m', 'm ', 'm  '])], ['slice', ['var', 'raw'], 0, ['var', 'unit']], ['var', 'raw']], 0]]);
const major = roadGeometryProfile({ class: 'primary' }), minor = roadGeometryProfile({ class: 'minor' }), service = roadGeometryProfile({ class: 'service' });

/** Same physical rules as Three's roadGeometryProfile, evaluated by the tile renderer. */
export const ROAD_WIDTH_METRES: ExpressionSpecification = bindVariables(
  'road_class', classExpression,
  'service', ['any', inValues(['var', 'road_class'], ['service', 'track']), ['==', ['get', 'subclass'], 'service']],
  'major', inValues(['var', 'road_class'], majorClasses),
  'one_way', ['any', ['==', ['get', 'oneway'], true], inValues(['to-string', ['coalesce', ['get', 'oneway'], '']], ['1', '-1', 'yes'])],
  'source_lanes', positiveSourceNumber('lanes'), 'source_width', positiveSourceNumber('width'),
  'lane_count', ['max', 1, ['min', 8, ['round', ['case', ['>', ['var', 'source_lanes'], 0], ['var', 'source_lanes'], ['any', ['var', 'service'], ['var', 'one_way']], service.lanes, ['var', 'major'], major.lanes, minor.lanes]]]],
  ['max', 3, ['min', 36, ['case', ['>', ['var', 'source_width'], 0], ['var', 'source_width'], ['+', 0.6, ['*', ['var', 'lane_count'], ['case', ['var', 'major'], (major.width - 0.6) / major.lanes, ['var', 'service'], (service.width - 0.6) / service.lanes, (minor.width - 0.6) / minor.lanes]]]]]]);

/** MapLibre line widths are CSS pixels; Mercator uses a 512px tile reference. */
export function metresToLinePixels(metres: ExpressionSpecification | number, latitude: number, minimum = 0): ExpressionSpecification {
  const latitudeRadians = Math.max(-85, Math.min(85, latitude)) * Math.PI / 180;
  const scale = 1 / (78271.51696 * Math.cos(latitudeRadians));
  const width = (zoom: number): ExpressionSpecification => ['*', metres, scale * 2 ** zoom];
  // A modest overview width becomes exact physical width from z14 onward.
  // Base-2 interpolation exactly follows Mercator at every fractional zoom.
  return ['interpolate', ['exponential', 2], ['zoom'], 0, ['max', minimum * 0.2, width(0)], 10, ['max', minimum, width(10)], 14, width(14), 24, width(24)];
}

type RoadRole = 'asphalt' | 'casing' | 'ballast' | 'sleepers' | 'marking' | 'glow' | 'rails';
function roadRole(layer: LayerSpecification): RoadRole | null {
  if (layer.type !== 'line' || layer.source !== 'openmaptiles' || layer['source-layer'] !== 'transportation') return null;
  if (layer.id === 'atlas-road-soft-light') return 'glow';
  if (layer.id === 'atlas-road-lane-markings') return 'marking';
  if (layer.id.startsWith('atlas-rail-steel-')) return 'rails';
  if (/^railway/.test(layer.id)) return /dashline/.test(layer.id) ? 'sleepers' : 'ballast';
  if (!/^(?:highway_(?:minor|major|motorway)|tunnel_motorway)/.test(layer.id)) return null;
  return /casing/.test(layer.id) ? 'casing' : 'asphalt';
}
export const isManagedRoadLayer = (layer: LayerSpecification) => roadRole(layer) !== null;

export function ensureRoadDetails(map: LibreMap, layers: LayerSpecification[]) {
  if (!map.getSource('openmaptiles')) return false;
  let changed = false;
  const before = layers.find((layer) => layer.type === 'symbol')?.id;
  const groundRoad: ExpressionSpecification = ['all', inValues(['get', 'class'], carClasses), ['!', inValues(['get', 'subclass'], ['footway', 'pedestrian', 'cycleway', 'steps'])], ['!', inValues(['get', 'brunnel'], ['tunnel', 'bridge'])]];
  const add = (layer: LineLayerSpecification, beforeId = before) => { if (!map.getLayer(layer.id)) { map.addLayer(layer, beforeId); changed = true; } };
  add({ id: 'atlas-road-soft-light', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 14.2, filter: groundRoad, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d4b58a', 'line-opacity': 0, 'line-width': 1, 'line-blur': 1.5 } });
  add({ id: 'atlas-road-lane-markings', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 15.7, filter: ['all', groundRoad, inValues(['get', 'class'], majorClasses.concat(['secondary', 'tertiary']))], layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': '#cbc8b7', 'line-opacity': 0.46, 'line-dasharray': [24, 28], 'line-width': 0.5 } });
  // Insert both rail heads immediately after their own base pass. This retains
  // the existing bridge/tunnel draw order instead of floating tracks over roads.
  for (let index = 0; index < layers.length; index++) {
    const layer = layers[index]; if (roadRole(layer) !== 'sleepers') continue;
    const original = layer as LineLayerSpecification;
    const next = layers[index + 1]?.id;
    const filter: ExpressionSpecification = ['all', original.filter as ExpressionSpecification, ['!=', ['get', 'brunnel'], 'tunnel'], ['!', inValues(['get', 'subclass'], ['subway', 'abandoned', 'disused', 'construction'])]];
    for (const side of ['left', 'right']) add({ id: `atlas-rail-steel-${side}-${layer.id}`, type: 'line', source: original.source, 'source-layer': original['source-layer'], minzoom: original.minzoom, maxzoom: original.maxzoom, filter, layout: { 'line-join': 'round' }, paint: { 'line-color': '#8b9590', 'line-opacity': 0, 'line-width': 0.2, 'line-offset': 0 } }, next);
  }
  return changed;
}

type RoadCache = Map<string, { layer: unknown; key: string }>;
const maps = new WeakMap<LibreMap, RoadCache>();
export function applyRoadStyle(map: LibreMap, layers: LayerSpecification[], night: number): boolean {
  if (!map.getSource('openmaptiles')) return false;
  let cache = maps.get(map); if (!cache) { cache = new Map(); maps.set(map, cache); }
  const latitude = Math.round((typeof map.getCenter === 'function' ? map.getCenter().lat : 55) * 20) / 20;
  const nightBucket = Math.round(Math.max(0, Math.min(1, night)) * 20), amount = nightBucket / 20;
  let changed = ensureRoadDetails(map, layers);
  const write = (id: string, property: string, value: unknown, key: string) => {
    const live = map.getLayer(id); if (!live) return;
    const entryId = `${id}:${property}`, entry = cache!.get(entryId);
    if (entry?.layer === live && entry.key === key) return;
    map.setPaintProperty(id, property as Parameters<LibreMap['setPaintProperty']>[1], value as Parameters<LibreMap['setPaintProperty']>[2]);
    cache!.set(entryId, { layer: live, key }); changed = true;
  };
  const allLayers = map.getStyle()?.layers ?? layers;
  for (const layer of allLayers) {
    const role = roadRole(layer); if (!role) continue;
    const id = layer.id, geometryKey = String(latitude), colorKey = String(nightBucket);
    if (role === 'asphalt' || role === 'casing') {
      const casing = role === 'casing';
      const width: ExpressionSpecification = casing ? ['+', ROAD_WIDTH_METRES, /bridge/.test(id) ? 1.2 : 0.8] : ROAD_WIDTH_METRES;
      write(id, 'line-width', metresToLinePixels(width, latitude, casing ? 1.15 : 0.8), geometryKey);
      write(id, 'line-color', mixCssColor(casing ? '#93968a' : ROAD_ASPHALT_COLOR, casing ? '#4c554e' : '#383d3c', amount), colorKey);
    } else if (role === 'ballast' || role === 'sleepers' || role === 'rails') {
      const width = role === 'ballast' ? 3.5 : role === 'sleepers' ? 2.55 : 0.115;
      write(id, 'line-width', metresToLinePixels(width, latitude, role === 'ballast' ? 0.75 : 0.2), geometryKey);
      write(id, 'line-color', mixCssColor(role === 'ballast' ? '#74736a' : role === 'sleepers' ? '#595b53' : '#8b9590', role === 'ballast' ? '#353b35' : role === 'sleepers' ? '#292f2b' : '#626e6b', amount), colorKey);
      if (role === 'ballast') write(id, 'line-opacity', 0.9, 'constant');
      else write(id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 12, 0.45, 15.15, 0.7, 15.4, 0], 'constant');
      if (role === 'sleepers') write(id, 'line-dasharray', [0.12, 0.24], 'constant');
      if (role === 'rails') write(id, 'line-offset', metresToLinePixels(id.includes('-left-') ? -0.76 : 0.76, latitude), geometryKey);
    } else {
      const marking = role === 'marking';
      write(id, 'line-width', metresToLinePixels(marking ? 0.14 : ['*', ROAD_WIDTH_METRES, 0.32], latitude), geometryKey);
      write(id, 'line-color', mixCssColor(marking ? '#cbc8b7' : '#d4b58a', marking ? '#a5b0a8' : '#d4b58a', amount), colorKey);
      write(id, 'line-opacity', marking ? 0.46 - amount * 0.14 : amount * 0.14, colorKey);
    }
  }
  return changed;
}
