import type { Map } from 'maplibre-gl';
import { configureBuildingGrounding } from './map-building-grounding';

/** Matches the local PMTiles pyramid. Detailed z13–15 payloads are retained. */
export const BUILDING_MIN_ZOOM = 10;
export const BUILDING_MAX_ZOOM = 15;
export const BUILDING_DETAIL_MIN_ZOOM = 13;
export const BUILDING_TILESET_VERSION = 'lod10-ba327015';

/** A new URL invalidates both browser range caches and PMTiles header caches. */
export function buildingTileSourceUrl(origin: string): string {
  return `pmtiles://${new URL(`/api/tiles/buildings?v=${BUILDING_TILESET_VERSION}`, origin).href}`;
}

/** Configure immediately after addSource and before its layers, also after a
 * style/source replacement. Terrain grounding and native tile LOD share this
 * lifecycle; a minimal LOD-only adapter can still implement just the one method.
 * These are tile-coverage limits, not a measured frame-rate guarantee.
 */
export function configureBuildingTileLod(map: Pick<Map, 'setSourceTileLodParams'>, sourceId = 'atlas-buildings'): void {
  const fullMap = map as Map;
  if (sourceId === 'atlas-buildings' && typeof fullMap.getSource === 'function' && typeof fullMap.addSource === 'function') configureBuildingGrounding(fullMap);
  map.setSourceTileLodParams(4, 3, sourceId);
}
