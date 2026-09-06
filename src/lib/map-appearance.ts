import type { Map as LibreMap, ExpressionSpecification } from 'maplibre-gl';
import type { LightingState } from './solar';
import { surfaceRole, themedColorValue } from './map-style-colors';
import { BUILDING_FACADE_COLOR, BUILDING_ROOF_COLOR, getBuildingLight } from './building-materials';
import { spatialLightingAmount } from './map-solar-light';
import { applyGroundMaterials, isManagedGroundLayer } from './map-ground-materials';
import { applyRoadStyle, isManagedRoadLayer } from './map-road-style';

type PaintEntry = { id: string; property: string; value: unknown; type: string; layer: unknown; appliedBucket: number };
type AppearanceCache = { paint: Map<string, PaintEntry>; lightKey: string; roofBucket: number; surfaceLayers: Map<string, unknown> };
const appearances = new WeakMap<LibreMap, AppearanceCache>();
export const ROOF_COLOR: ExpressionSpecification = BUILDING_ROOF_COLOR;

export function applyMapLighting(map: LibreMap, state: LightingState, geographic = false) {
  const style = map.getStyle();
  // React/HMR cleanup may remove a map before a queued timer or moveend runs.
  if (!style?.layers) { appearances.delete(map); return; }
  let cache = appearances.get(map);
  if (!cache) { cache = { paint: new Map(), lightKey: '', roofBucket: -1, surfaceLayers: new Map() }; appearances.set(map, cache); }
  const spatial = geographic ? spatialLightingAmount(map.getZoom()) : 0;
  const bucket = Math.round(Math.max(0, Math.min(1, state.nightAmount)) * (1 - spatial) * 20), night = bucket / 20;
  const labelBucket = Math.round((night + spatial * (0.85 - night)) * 20);
  let changed = applyGroundMaterials(map, style.layers, night);
  changed = applyRoadStyle(map, style.layers, night) || changed;
  for (const layer of style.layers) {
    if (isManagedGroundLayer(layer) || isManagedRoadLayer(layer)) continue;
    // Preserve analytic overlay colors; only their text/halos and flat building surfaces need the scene palette.
    const atlasOverlay = layer.id.startsWith('atlas-') && layer.id !== 'atlas-building-flat' && layer.id !== 'atlas-russia-ground' && layer.id !== 'atlas-region-context-ground';
    if (atlasOverlay && layer.type !== 'symbol') continue;
    const paint = 'paint' in layer ? layer.paint ?? {} : {};
    const values: Record<string, unknown> = { ...paint };
    if (layer.type === 'background' && values['background-color'] === undefined) values['background-color'] = '#ffffff';
    if (layer.type === 'fill' && values['fill-color'] === undefined && !values['fill-pattern']) values['fill-color'] = '#ffffff';
    if (layer.type === 'symbol') { if (values['text-color'] === undefined) values['text-color'] = '#374e48'; if (values['text-halo-color'] === undefined) values['text-halo-color'] = '#e2e8df'; }
    for (const [property, value] of Object.entries(values)) {
      if (!property.endsWith('-color') || atlasOverlay && !property.startsWith('text-')) continue;
      const key = `${layer.id}:${property}`, liveLayer = map.getLayer(layer.id); let entry = cache.paint.get(key);
      if (!entry || entry.layer !== liveLayer) { entry = { id: layer.id, property, value, type: layer.type, layer: liveLayer, appliedBucket: -1 }; cache.paint.set(key, entry); }
      const outside = geographic && layer.type === 'background';
      const colorBucket = layer.type === 'symbol' ? labelBucket : bucket;
      if (entry.appliedBucket === colorBucket || !liveLayer) continue;
      map.setPaintProperty(entry.id, property as Parameters<LibreMap['setPaintProperty']>[1], themedColorValue(outside ? '#b9c1b0' : entry.value, surfaceRole(entry.id, entry.type, property), colorBucket / 20) as Parameters<LibreMap['setPaintProperty']>[2]); entry.appliedBucket = colorBucket; changed = true;
    }
    if (layer.type === 'raster') {
      // Natural Earth imagery has its own colors and otherwise remains bright underneath vector layers.
      const key = `${layer.id}:raster-brightness-max`; let entry = cache.paint.get(key);
      if (!entry) { entry = { id: layer.id, property: 'raster-brightness-max', value: 1, type: layer.type, layer: map.getLayer(layer.id), appliedBucket: -1 }; cache.paint.set(key, entry); }
      if (entry.appliedBucket !== bucket) { map.setPaintProperty(layer.id, 'raster-brightness-max', 1 - night * 0.79); map.setPaintProperty(layer.id, 'raster-brightness-min', 0); map.setPaintProperty(layer.id, 'raster-saturation', -0.22 - night * 0.2); entry.appliedBucket = bucket; changed = true; }
    }
  }
  const surfaces = ['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs', 'atlas-building-flat'];
  const patterned = new Set(style.layers.filter(layer => 'paint' in layer && layer.paint && 'fill-extrusion-pattern' in layer.paint && layer.paint['fill-extrusion-pattern']).map(layer => layer.id));
  const newSurfaces = surfaces.some((id) => map.getLayer(id) && cache.surfaceLayers.get(id) !== map.getLayer(id));
  if (cache.roofBucket !== bucket || changed || newSurfaces) {
    // Keep most of each building's pigment at night. Replacing every endpoint with
    // one dark color erased both source evidence and the separation of walls/roofs.
    const roofs: ExpressionSpecification = ['interpolate', ['linear'], night * 0.35, 0, BUILDING_ROOF_COLOR, 1, '#647788'];
    const facades: ExpressionSpecification = ['interpolate', ['linear'], night * 0.42, 0, BUILDING_FACADE_COLOR, 1, '#718494'];
    // Patterns already carry pigment and use the shared scene light. Evaluating
    // an unused, source-dependent colour allocates buffers on every vector tile.
    for (const id of ['atlas-building-3d', 'atlas-building-parts-3d']) if (map.getLayer(id) && !patterned.has(id)) map.setPaintProperty(id, 'fill-extrusion-color', facades);
    for (const id of ['atlas-building-roofs', 'atlas-building-part-roofs']) if (map.getLayer(id) && !patterned.has(id)) map.setPaintProperty(id, 'fill-extrusion-color', roofs);
    if (map.getLayer('atlas-building-flat')) map.setPaintProperty('atlas-building-flat', 'fill-color', facades);
    cache.roofBucket = bucket; for (const id of surfaces) cache.surfaceLayers.set(id, map.getLayer(id)); changed = true;
  }
  const light = getBuildingLight(state);
  const lightKey = `${bucket}:${Math.round(state.sunAzimuth * 2)}:${Math.round(state.sunElevation * 2)}:${Math.round(state.brightness * 40)}`;
  if (cache.lightKey !== lightKey) {
    // This is architectural fill at night, not an underground sun: MapLibre's
    // polar angle >90 degrees illuminates the underside and hides roof form.
    // Keep the actual daylight direction, smoothly lifting the twilight fill.
    const localNight = Math.max(0, Math.min(1, state.nightAmount));
    const fill = localNight * localNight * (3 - 2 * localNight);
    const elevation = Math.max(0, state.sunElevation) * (1 - fill) + Math.max(32, state.sunElevation) * fill;
    map.setLight({ anchor: 'map', color: light.mapColor, intensity: light.legacyIntensity, position: [1.5, state.sunAzimuth, Math.max(0, Math.min(90, 90 - elevation))] }); cache.lightKey = lightKey; changed = true;
  }
  if (changed) map.triggerRepaint();
}
