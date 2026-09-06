import type { Map as LibreMap } from 'maplibre-gl';

/** One source of truth: 2D is a clean plan; 3D has textured volumes. */
export const DEFAULT_MAP_3D = false;

export function naturalMapPitch(zoom: number): number {
  return zoom >= 13 ? 58 : zoom >= 10 ? 45 : 0;
}

/** Pitch is camera geometry, not a third presentation mode. An overview or an
 * unfinished animation must never make the mode button disagree with layers. */
export function nextMapMode(is3D: boolean, _pitch: number, zoom: number) {
  const next3D = !is3D;
  return { next3D, pitch: next3D ? naturalMapPitch(zoom) : 0 };
}

type ModeMap = Pick<LibreMap, 'getLayer' | 'getLayoutProperty' | 'setLayoutProperty' | 'getMaxPitch' | 'setMaxPitch' | 'touchPitch'>;

/** Apply after style load, mode changes and resize. Never remove textures or
 * rebuild sources: returning to 3D reuses exactly the same surface materials. */
export function applyMapMode(map: ModeMap, is3D: boolean, buildings = true, mobile = false) {
  for (const id of ['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs', 'atlas-building-flat']) {
    const visible = buildings && (id === 'atlas-building-flat' ? !is3D : is3D);
    const visibility = visible ? 'visible' : 'none';
    if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== visibility) map.setLayoutProperty(id, 'visibility', visibility);
  }
  const maxPitch = is3D ? mobile ? 60 : 75 : 0;
  if (map.getMaxPitch() !== maxPitch) map.setMaxPitch(maxPitch);
  if (is3D && !map.touchPitch.isEnabled()) map.touchPitch.enable();
  else if (!is3D && map.touchPitch.isEnabled()) map.touchPitch.disable();
}
