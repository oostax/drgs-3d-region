import type { Coordinates, Territory } from './types';

/** Geometry only. Never infer a customer's address from a bank department. */
export function territoryIndex(territories: readonly Territory[]) {
  const byId = new Map(territories.map(t => [t.id, t]));
  const memo = new Map<string, string[]>();
  const chain = (id: string): string[] => {
    if (memo.has(id)) return memo.get(id)!;
    const result: string[] = [], seen = new Set<string>();
    let item = byId.get(id);
    while (item && !seen.has(item.id)) {
      seen.add(item.id); result.push(item.id); item = byId.get(item.parentId || '');
    }
    memo.set(id, result); return result;
  };
  // Check detailed polygons first; a matching child already establishes its
  // parent chain, avoiding an expensive region polygon test per customer.
  const levels = [...new Set(territories.map(t => chain(t.id).length))].sort((a, b) => b - a);
  const byDepth = levels.map(depth => territories.filter(t => chain(t.id).length === depth));
  const point = (coordinates: Coordinates | null): string[] => {
    if (!coordinates || coordinates.length !== 2 || !coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) return [];
    for (const group of byDepth) {
      const matches = group.filter(t => containsPoint(t, coordinates));
      if (matches.length) return chain(matches[0].id).filter(id => matches.every(t => chain(t.id).includes(id)));
    }
    return [];
  };
  return { byId, chain, point };
}
function inRing(point: Coordinates, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const cross = (point[1] - a[1]) * (b[0] - a[0]) - (point[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(cross) < 1e-12 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) && point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function containsPoint(territory: Territory, point: Coordinates) {
  const b = territory.bbox;
  if (b && (point[0] < b[0] || point[0] > b[2] || point[1] < b[1] || point[1] > b[3])) return false;
  const g = territory.geometry;
  const polygons = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
  return polygons.some(rings => rings.length && inRing(point, rings[0]) && !rings.slice(1).some(ring => inRing(point, ring)));
}
export function safeSourceUrl(value: string | null | undefined): boolean {
  try { const u = new URL(value || ''); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export function isoDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  const day = value.slice(0, 10), time = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? day : null;
}
