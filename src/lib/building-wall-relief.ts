import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import type { BuildingProfile } from './building-materials';

type XY = [number, number];
type XYZ = [number, number, number];
type Edge = { a: XY; along: XY; out: XY; length: number; middle: XY; outer: boolean };
const MAX_RELIEF_VERTICES = 1980;
const residential = new Set(['apartments', 'panel', 'brick', 'residential', 'contemporary', 'hotel', 'house']);
const classical = new Set(['historic', 'civic', 'university', 'cultural', 'religious']);
const service = new Set(['garage', 'shed', 'utility', 'outbuilding', 'agricultural', 'greenhouse']);

function edgesOf(rings: XY[][]): Edge[] {
  const result: Edge[] = [];
  rings.forEach((input, index) => {
    const ring = input.length > 2 && Math.hypot(input[0][0] - input.at(-1)![0], input[0][1] - input.at(-1)![1]) < 0.001 ? input.slice(0, -1) : input;
    if (ring.length < 3 || ring.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return;
    const area = ring.reduce((sum, point, i) => { const next = ring[(i + 1) % ring.length]; return sum + point[0] * next[1] - point[1] * next[0]; }, 0);
    if (Math.abs(area) < 0.001) return;
    const direction = (area > 0 ? 1 : -1) * (index === 0 ? 1 : -1);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      if (length < 1.2) continue;
      result.push({ a, along: [dx / length, dy / length], out: [dy / length * direction, -dx / length * direction], length, middle: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], outer: index === 0 });
    }
  });
  return result.sort((a, b) => b.length - a.length || a.middle[1] - b.middle[1] || a.middle[0] - b.middle[0]);
}

/** Illustrative architecture in physical metres, independent of camera zoom.
 * Five/six-face solids merge into the viewport's one vertex-color relief batch.
 * Level 1 supplies a cornice below the eaves; level 2 adds selected real-depth
 * balconies, belt courses, pilasters and an entrance canopy. No roof parapet.
 */
export function makeBuildingWallRelief(rings: XY[][], profile: BuildingProfile, detailLevel: 0 | 1 | 2): BufferGeometry {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  const geometry = () => {
    const result = new BufferGeometry();
    result.setAttribute('position', new Float32BufferAttribute(positions, 3));
    result.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    result.setAttribute('color', new Float32BufferAttribute(colors, 3));
    return result;
  };
  const usableHeight = profile.eaves - profile.base;
  if (detailLevel === 0 || profile.tiny || !Number.isFinite(usableHeight) || usableHeight < 2) return geometry();
  const edges = edgesOf(rings), outside = edges.filter(edge => edge.outer), first = outside[0];
  if (!first) return geometry();
  const facade = new Color(profile.facadeColor), trim = facade.clone().lerp(new Color('#f1ebdb'), classical.has(profile.kind) ? 0.32 : 0.18);
  const panel = facade.clone().lerp(new Color('#7d9394'), profile.kind === 'contemporary' ? 0.35 : 0.16), canopy = new Color(profile.roofColor).lerp(trim, 0.12);

  function quad(a: XYZ, b: XYZ, c: XYZ, d: XYZ, normal: XYZ, color: Color) {
    const ab = b.map((value, i) => value - a[i]), ac = c.map((value, i) => value - a[i]);
    const orientation = (ab[1] * ac[2] - ab[2] * ac[1]) * normal[0] + (ab[2] * ac[0] - ab[0] * ac[2]) * normal[1] + (ab[0] * ac[1] - ab[1] * ac[0]) * normal[2];
    const points = orientation >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
    for (const point of points) { positions.push(...point); normals.push(...normal); colors.push(color.r, color.g, color.b); }
  }
  function box(edge: Edge, from: number, to: number, near: number, far: number, bottom: number, top: number, color: Color, back = false) {
    const count = back ? 36 : 30;
    if (to <= from || far <= near || top <= bottom || positions.length / 3 + count > (detailLevel === 1 ? 432 : MAX_RELIEF_VERTICES)) return false;
    const p = (u: number, v: number, z: number): XYZ => [edge.a[0] + edge.along[0] * u + edge.out[0] * v, edge.a[1] + edge.along[1] * u + edge.out[1] * v, z];
    const a = p(from, near, bottom), b = p(to, near, bottom), c = p(to, far, bottom), d = p(from, far, bottom);
    const e = p(from, near, top), f = p(to, near, top), g = p(to, far, top), h = p(from, far, top);
    quad(d, c, g, h, [...edge.out, 0], color);
    if (back) quad(b, a, e, f, [-edge.out[0], -edge.out[1], 0], color);
    quad(a, d, h, e, [-edge.along[0], -edge.along[1], 0], color);
    quad(c, b, f, g, [...edge.along, 0], color);
    quad(e, h, g, f, [0, 0, 1], color);
    quad(d, a, b, c, [0, 0, -1], color);
    return true;
  }

  // These are ledges under the existing roof; the source eaves/roof height stays intact.
  const corniceDepth = classical.has(profile.kind) ? 0.43 : 0.27 + profile.facadeVariant * 0.045;
  for (const edge of edges.slice(0, detailLevel === 1 ? 2 : 8)) box(edge, -0.08, edge.length + 0.08, -0.035, corniceDepth, profile.eaves - 0.5, profile.eaves - 0.24, trim);
  if (detailLevel === 1 || service.has(profile.kind)) return geometry();

  const floors = Math.min(1000, Math.max(1, Math.floor(profile.floors))), floorHeight = profile.floorHeight;
  const regularFloors = Number.isFinite(floorHeight) && floorHeight >= 2.3 && floorHeight <= 6;
  if (floors >= 2 && regularFloors) {
    const bands = [...new Set([1, Math.max(1, Math.floor(floors / 2))])];
    for (const floor of bands) for (const edge of outside.slice(0, 2)) {
      const z = profile.base + floor * floorHeight;
      if (z + 0.2 < profile.eaves - 0.6) box(edge, 0, edge.length, -0.035, 0.25, z - 0.1, z + 0.12, trim);
    }
  }

  // Selected stacks, not a separate mesh per apartment. Even a skyscraper has
  // at most eight modeled balconies; all other floors use the shared facade.
  if (residential.has(profile.kind) && floors >= 2 && regularFloors && first.length >= 6) {
    const levels = Math.min(4, floors - 1), faces = profile.facadeVariant === 2 && outside[1]?.length >= 10 ? outside.slice(0, 2) : [first];
    let balconies = 0;
    for (const edge of faces) {
      const bays = faces.length === 1 && edge.length >= 14 ? 2 : 1, width = Math.min(3, Math.max(1.7, profile.windowSpacing * 0.8));
      for (let bay = 0; bay < bays; bay++) for (let level = 0; level < levels; level++) {
        if (balconies >= 8 || positions.length / 3 + 138 > MAX_RELIEF_VERTICES) break;
        const floor = levels === 1 ? 1 : 1 + Math.round(level / (levels - 1) * (floors - 2));
        const z = profile.base + floor * floorHeight, middle = edge.length * (bay + 1) / (bays + 1), from = middle - width / 2, to = middle + width / 2;
        if (z + 1.1 >= profile.eaves - 0.15) continue;
        box(edge, from, to, -0.035, 0.9, z - 0.14, z + 0.04, trim);
        box(edge, from, to, 0.76, 0.88, z + 0.04, z + 0.97, panel, true);
        box(edge, from, from + 0.1, 0.025, 0.88, z + 0.04, z + 0.97, panel, true);
        box(edge, to - 0.1, to, 0.025, 0.88, z + 0.04, z + 0.97, panel, true);
        balconies++;
      }
    }
  }

  // Unknown use still gets conservative structural relief, without assuming
  // residential balconies, branding or a particular construction material.
  const pilasters = classical.has(profile.kind) || profile.kind === 'neutral' || ['office', 'education', 'kindergarten', 'hospital', 'clinic', 'stadium', 'sports', 'transport'].includes(profile.kind);
  if (pilasters && first.length >= 8) {
    const depth = classical.has(profile.kind) ? 0.4 : profile.kind === 'stadium' ? 0.5 : 0.28;
    const width = classical.has(profile.kind) ? 0.55 : 0.4;
    for (const edge of outside.slice(0, 2)) for (const fraction of [0.2, 0.8]) {
      const middle = edge.length * fraction;
      box(edge, middle - width / 2, middle + width / 2, -0.035, depth, profile.base + 0.18, profile.eaves - 0.55, trim);
    }
  }
  // Entrances stay at the physical ground floor, never at a floating part base.
  if (profile.base <= 0.15 && first.length >= 5 && usableHeight >= 2.8) {
    const width = profile.kind === 'house' ? 2.1 : Math.min(4, first.length * 0.24), middle = first.length * 0.5;
    const z = Math.min(3.2, Math.max(2.2, floorHeight * 0.8), profile.eaves - 0.6);
    box(first, middle - width / 2, middle + width / 2, -0.035, 1.05, z - 0.16, z + 0.04, canopy);
  }
  return geometry();
}
