import type { ExpressionSpecification, Map as LibreMap } from 'maplibre-gl';
import { installBuildingTerrain, terrainBuildingHeight, terrainBuildingBase } from './building-terrain';

const SOURCE = 'atlas-buildings';
const LAYERS = ['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs'];
const disposers = new WeakMap<LibreMap, () => void>();

/** Called immediately after the vector source is added, before any of its layers.
 * All setup stays in the map library; React and the UI need no special lifecycle.
 */
export function configureBuildingGrounding(map: LibreMap) {
  disposers.get(map)?.();
  const source = map.getSource(SOURCE);
  const specification = source?.serialize();
  if (!specification || specification.type !== 'vector') return;
  if (specification.promoteId !== 'id') {
    if (map.getStyle().layers.some(layer => 'source' in layer && layer.source === SOURCE)) {
      throw new Error('Configure building grounding before adding building layers');
    }
    // Use the public source API, not private source/worker fields. The original
    // URL, attribution, bounds and tile limits are retained exactly.
    map.removeSource(SOURCE);
    map.addSource(SOURCE, { ...specification, promoteId: 'id' });
  }
  const controller = installBuildingTerrain(map);
  const applied = new Map<string, unknown>();
  const configurePaint = () => {
    for (const id of LAYERS) {
      const layer = map.getLayer(id);
      if (!layer || applied.get(id) === layer) continue;
      // Mark before setPaintProperty: style notifications can be synchronous.
      applied.set(id, layer);
      const height = map.getPaintProperty(id, 'fill-extrusion-height') as ExpressionSpecification;
      const base = map.getPaintProperty(id, 'fill-extrusion-base') as ExpressionSpecification;
      // Also tolerate a style restored from getStyle() without double lifting.
      if (!JSON.stringify(height).includes('atlasTerrainLift')) map.setPaintProperty(id, 'fill-extrusion-height', terrainBuildingHeight(height));
      if (!JSON.stringify(base).includes('atlasTerrainLift')) map.setPaintProperty(id, 'fill-extrusion-base', terrainBuildingBase(base));
    }
  };
  const dispose = () => {
    map.off('styledata', configurePaint); map.off('remove', dispose);
    controller.dispose(); applied.clear();
    if (disposers.get(map) === dispose) disposers.delete(map);
  };
  disposers.set(map, dispose);
  map.on('styledata', configurePaint); map.on('remove', dispose);
  configurePaint();
}
