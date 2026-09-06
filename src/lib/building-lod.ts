import type { Map } from 'maplibre-gl';

/** Matches the local PMTiles pyramid. Detailed z13–15 payloads are retained. */
export const BUILDING_MIN_ZOOM = 10;
export const BUILDING_MAX_ZOOM = 15;
export const BUILDING_DETAIL_MIN_ZOOM = 13;
export const BUILDING_TILESET_VERSION = 'lod10-ba327015';

/** A new URL invalidates both browser range caches and PMTiles header caches. */
export function buildingTileSourceUrl(origin: string): string {
  return `pmtiles://${new URL(`/api/tiles/buildings?v=${BUILDING_TILESET_VERSION}`, origin).href}`;
}

/** Keep distance LOD without asking for full-resolution tiles across the horizon.
 * Call after addSource, and again after replacing the style/source.
 * These are tile-coverage limits, not a measured frame-rate guarantee.
 */
export function configureBuildingTileLod(map: Pick<Map, 'setSourceTileLodParams'>, sourceId = 'atlas-buildings'): void {
  map.setSourceTileLodParams(4, 3, sourceId);
}
