import type { Map as LibreMap } from 'maplibre-gl';

/** The first frame is the same flat schematic view as every later return to 2D. */
export const DEFAULT_MAP_3D = false;

export function naturalMapPitch(zoom: number): number {
  return zoom >= 13 ? 58 : zoom >= 10 ? 45 : 0;
}

/** Mode is a user's selection, not a measurement of an animating camera.
 * A 3D overview can be top-down; clicking again must still switch to 2D.
 */
export function nextMapMode(is3D: boolean, zoom: number) {
  const next3D = !is3D;
  return { next3D, pitch: next3D ? naturalMapPitch(zoom) : 0 };
}

type ViewMap = Pick<LibreMap, 'getLayer' | 'getLayoutProperty' | 'setLayoutProperty' | 'setPaintProperty' | 'getMaxPitch' | 'setMaxPitch' | 'touchPitch'>;
type ViewOptions = { buildings: boolean; bankFocus: boolean; maxPitch: number };

/** One presentation contract for initial load, mode changes, resize and GPU
 * restoration. Camera gestures cannot create a pitched, supposedly 2D map.
 */
export function applyMapViewMode(map: ViewMap, is3D: boolean, options: ViewOptions) {
  const visibility = (id: string, visible: boolean) => {
    if (!map.getLayer(id)) return;
    const value = visible ? 'visible' : 'none';
    if (map.getLayoutProperty(id, 'visibility') !== value) map.setLayoutProperty(id, 'visibility', value);
  };
  for (const id of ['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs']) {
    visibility(id, options.buildings && is3D);
    if (map.getLayer(id)) map.setPaintProperty(id, 'fill-extrusion-opacity', options.bankFocus ? 0.18 : 1);
  }
  visibility('atlas-building-flat', options.buildings && !is3D);
  if (map.getLayer('atlas-building-flat')) map.setPaintProperty('atlas-building-flat', 'fill-opacity', options.bankFocus ? 0.16 : 0.9);
  const maxPitch = is3D ? options.maxPitch : 0;
  if (map.getMaxPitch() !== maxPitch) map.setMaxPitch(maxPitch);
  if (is3D !== map.touchPitch.isEnabled()) {
    if (is3D) map.touchPitch.enable(); else map.touchPitch.disable();
  }
}
