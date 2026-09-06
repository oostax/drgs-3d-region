import type { CustomLayerInterface, Map } from 'maplibre-gl';

export type MapGpuLayers = { solar: CustomLayerInterface; landmarks: CustomLayerInterface; details: CustomLayerInterface; life: CustomLayerInterface; scenes: CustomLayerInterface };
const layerIds = ['atlas-solar-light', 'atlas-landmarks', 'atlas-building-details', 'atlas-life', 'atlas-signal-scenes'];

/** MapLibre restores serialized vector layers, but cannot restore custom GPU
 * resources. Always ask for new instances: old layers may hold disposed meshes,
 * failed flags, stopped clocks and permanently aborted fetch controllers.
 */
export function recreateMapGpuLayers<T extends MapGpuLayers>(map: Pick<Map, 'getLayer' | 'removeLayer' | 'getStyle' | 'addLayer'>, create: () => T): T {
  for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
  const layers = create(), firstSymbol = map.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
  // Keep every custom object in the same 3D pass after the basemap
  // extrusions have populated the shared depth buffer. This order is stable
  // across initial load, style reload and WebGL context restoration.
  for (const layer of [layers.solar, layers.landmarks, layers.details, layers.life, layers.scenes]) map.addLayer(layer, firstSymbol);
  return layers;
}
