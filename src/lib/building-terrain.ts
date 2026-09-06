import { MercatorCoordinate, type Map as LibreMap } from 'maplibre-gl';
import type { Position } from 'geojson';

/** Pinned MapLibre 6.7.0: data/extent.ts and fill_extrusion.vertex.glsl. */
const TILE_EXTENT = 8192;
export const BUILDING_TERRAIN_SKIRT = 10;
export type BuildingSourceTile = { z: number; x: number; y: number };

/** Same vertex-mean anchor as FillExtrusionBucket, not an area centroid or a corner.
 * Every ring contributes, but its duplicate closing vertex does not. Query-source
 * features carry their canonical tile; mirror loadGeometry's integer grid and
 * the bucket's floor rounding so a 3 cm roof clearance survives on a slope.
 * Plain GeoJSON has no tile metadata and uses the unquantized Mercator mean.
 */
export function buildingTerrainAnchor(polygon: Position[][], tile?: BuildingSourceTile): [number, number] | null {
  const validTile = tile && Number.isInteger(tile.z) && tile.z >= 0 && tile.z <= 24
    && Number.isInteger(tile.x) && Number.isInteger(tile.y)
    && tile.x >= 0 && tile.y >= 0 && tile.x < 2 ** tile.z && tile.y < 2 ** tile.z ? tile : null;
  const tiles = validTile ? 2 ** validTile.z : 1;
  const quantize = (n: number) => Math.max(-16384, Math.min(16383, Math.round(n)));
  let x = 0, y = 0, count = 0;
  for (const ring of polygon) for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (i === ring.length - 1 && i > 0 && p[0] === ring[0][0] && p[1] === ring[0][1]) continue;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[1]) > 85.051129) continue;
    const point = MercatorCoordinate.fromLngLat([p[0], p[1]]);
    x += validTile ? quantize((point.x * tiles - validTile.x) * TILE_EXTENT) : point.x;
    y += validTile ? quantize((point.y * tiles - validTile.y) * TILE_EXTENT) : point.y;
    count++;
  }
  if (!count) return null;
  const center = validTile
    ? new MercatorCoordinate((validTile.x + Math.floor(x / count) / TILE_EXTENT) / tiles, (validTile.y + Math.floor(y / count) / TILE_EXTENT) / tiles)
    : new MercatorCoordinate(x / count, y / count);
  const result = center.toLngLat();
  return [result.lng, result.lat];
}

/** MapLibre already applies terrain exaggeration. Negative sea-level elevations
 * are valid; unavailable/invalid DEM samples must never become NaN geometry.
 */
export function buildingTerrainAltitude(map: Pick<LibreMap, 'queryTerrainElevation'>, anchor: [number, number] | null): number {
  if (!anchor) return 0;
  const altitude = map.queryTerrainElevation(anchor);
  return typeof altitude === 'number' && Number.isFinite(altitude) ? altitude : 0;
}
