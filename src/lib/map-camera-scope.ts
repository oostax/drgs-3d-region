import type { FeatureCollection, Geometry, Position } from 'geojson';
import type { Coordinates, Territory } from './types';

function inRing(point: Coordinates, ring: Position[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function geometryContains(geometry: Geometry | null | undefined, point: Coordinates) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(polygon => polygon.length && inRing(point, polygon[0]) && !polygon.slice(1).some(hole => inRing(point, hole)));
}

/** Full municipal polygons, independent of visible tiles and hidden boundary layers. */
export function cameraTerritory(point: Coordinates, zoom: number, territories: readonly Territory[], boundaries: FeatureCollection, current = 'RU-TA'): string | null {
  const regional = territories.filter(t => t.kind === 'district' || t.kind === 'urban_district');
  const candidates = regional.filter(t => !t.bbox || (point[0] >= t.bbox[0] && point[0] <= t.bbox[2] && point[1] >= t.bbox[1] && point[1] <= t.bbox[3]));
  const ids = new Set(candidates.map(t => t.id));
  const district = boundaries.features.find(f => ids.has(String(f.properties?.territoryId)) && geometryContains(f.geometry, point));
  const region = boundaries.features.find(f => f.properties?.territoryId === 'RU-TA');
  if (!district && !geometryContains(region?.geometry, point)) return null;
  // A small zoom dead band avoids alternating region/district around the cutoff.
  if (zoom < (current === 'RU-TA' ? 7.8 : 7.2)) return 'RU-TA';
  return district ? String(district.properties?.territoryId) : 'RU-TA';
}

export function territoryScopeIds(territories: readonly Territory[], root: string) {
  const ids = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const territory of territories) if (territory.parentId && ids.has(territory.parentId) && !ids.has(territory.id)) { ids.add(territory.id); changed = true; }
  }
  return ids;
}
