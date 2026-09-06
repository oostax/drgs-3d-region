import * as THREE from 'three';
import type { BuildingProfile } from './building-materials';

type Point = [number, number];
type Triangle = [Point, Point, Point];
type Plane = [number, number, number];
export type BuildingRoofKind = 'flat' | 'gabled' | 'hipped' | 'skillion' | 'barrel' | 'sawtooth';
export const BUILDING_ROOF_VERTEX_LIMIT = 2496;
const CLEARANCE = 0.09, EPSILON = 1e-7;
const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const planeAt = (plane: Plane, p: Point) => plane[0] * p[0] + plane[1] * p[1] + plane[2];
const area = (ring: Point[]) => ring.reduce((sum, p, i) => sum + p[0] * ring[(i + 1) % ring.length][1] - p[1] * ring[(i + 1) % ring.length][0], 0) / 2;

/** Clip an already triangulated footprint patch to a roof plane's half-space. */
function clip(polygon: Point[], plane: Plane): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], da = planeAt(plane, a), db = planeAt(plane, b);
    if (da >= -EPSILON) result.push(a);
    if ((da > EPSILON && db < -EPSILON) || (da < -EPSILON && db > EPSILON)) {
      const t = da / (da - db); result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return result;
}

function selectKind(profile: BuildingProfile, span: number): { kind: BuildingRoofKind; inferred: boolean } {
  const aliases: Record<string, BuildingRoofKind> = { flat: 'flat', gabled: 'gabled', gable: 'gabled', hipped: 'hipped', hip: 'hipped', pyramidal: 'hipped', skillion: 'skillion', shed: 'skillion', sawtooth: 'sawtooth', barrel: 'barrel', round: 'barrel' };
  if (profile.roofShape && aliases[profile.roofShape]) return { kind: aliases[profile.roofShape], inferred: false };
  if (profile.roofShape || profile.kind === 'religious') return { kind: 'flat', inferred: true };
  if (profile.tiny || span < 3) return { kind: 'skillion', inferred: true };
  if (['sports', 'stadium', 'transport', 'greenhouse'].includes(profile.kind)) return { kind: 'barrel', inferred: true };
  if (['industrial', 'agricultural'].includes(profile.kind) && span > 10) return { kind: 'sawtooth', inferred: true };
  if (['warehouse', 'shed', 'garage', 'outbuilding'].includes(profile.kind)) return { kind: profile.facadeVariant === 1 ? 'skillion' : 'gabled', inferred: true };
  if (profile.height >= 23 || ['panel', 'contemporary', 'office', 'hospital', 'hotel', 'civic', 'commercial'].includes(profile.kind)) return { kind: 'flat', inferred: true };
  if (['house', 'historic', 'kindergarten', 'education', 'university', 'cultural', 'brick'].includes(profile.kind)) return { kind: profile.facadeVariant === 1 ? 'hipped' : 'gabled', inferred: true };
  // Unknown low-rise buildings receive restrained illustrations, never asserted survey data.
  return { kind: (['gabled', 'flat', 'hipped'] as const)[profile.facadeVariant ?? 0], inferred: true };
}

/**
 * Low-poly architectural illustration in local metres. The vector-map cap stays
 * authoritative at profile.height, so illustrative surfaces clear it by 9 cm.
 * A caller that lowers both vector cap and walls to a surveyed eave may pass
 * capHeight=profile.eaves; then a supported source pitch keeps its full height.
 */
export function makeBuildingRoofGeometry(input: Point[][], profile: BuildingProfile, options: { detailLevel?: 0 | 1 | 2; capHeight?: number } = {}) {
  const detailLevel = options.detailLevel ?? 1, eave = (options.capHeight ?? profile.height) + CLEARANCE;
  const roofPositions: number[] = [], roofUV: number[] = [], trimPositions: number[] = [], trimUV: number[] = [];
  let kind: BuildingRoofKind = 'flat', rise = 0, estimated = true;
  let along: Point = [1, 0], across: Point = [0, 1];
  const geometry = (positions: number[], uv: number[]) => {
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    result.computeVertexNormals(); result.computeBoundingBox(); result.computeBoundingSphere(); return result;
  };
  const result = () => ({ roof: geometry(roofPositions, roofUV), trim: geometry(trimPositions, trimUV), kind, estimated, eave, rise });
  const original = input.map((ring, index) => {
    let points = ring.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[0], p[1]] as Point);
    points = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > EPSILON);
    if (points.length > 1 && Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) < EPSILON) points.pop();
    if ((area(points) > 0) !== (index === 0)) points.reverse(); return points;
  });
  if (!original[0] || original[0].length < 3 || !Number.isFinite(eave)) return result();
  let longest = 0;
  for (let i = 0; i < original[0].length; i++) {
    const a = original[0][i], b = original[0][(i + 1) % original[0].length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > longest) { longest = length; along = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]; }
  }
  across = [-along[1], along[0]];
  if (profile.roofDirection !== null) {
    const radians = profile.roofDirection * Math.PI / 180;
    across = [Math.sin(radians), Math.cos(radians)]; along = [across[1], -across[0]];
  }
  const rings = original.filter(ring => ring.length >= 3).map(ring => ring.map(p => [p[0] * along[0] + p[1] * along[1], p[0] * across[0] + p[1] * across[1]] as Point));
  const vertices = rings.flat(), vectors = rings.map(ring => ring.map(p => new THREE.Vector2(...p)));
  const triangles = THREE.ShapeUtils.triangulateShape(vectors[0], vectors.slice(1)).map(indices => indices.map(i => vertices[i]) as Triangle);
  if (triangles.length * 3 > BUILDING_ROOF_VERTEX_LIMIT || !triangles.length) return result();
  const uMin = Math.min(...rings[0].map(p => p[0])), uMax = Math.max(...rings[0].map(p => p[0]));
  const vMin = Math.min(...rings[0].map(p => p[1])), vMax = Math.max(...rings[0].map(p => p[1]));
  const span = Math.min(uMax - uMin, vMax - vMin), width = vMax - vMin;
  if (span < EPSILON) return result();
  const selection = selectKind(profile, span); kind = detailLevel === 0 ? 'flat' : selection.kind;
  const sourceAligned = !selection.inferred && profile.roofHeight > 0 && options.capHeight !== undefined && Math.abs(options.capHeight - profile.eaves) < 0.001;
  estimated = selection.inferred || kind !== selection.kind || kind !== 'flat' && !sourceAligned;
  rise = kind === 'flat' ? 0 : sourceAligned ? profile.roofHeight : profile.roofHeight > 0 ? Math.min(profile.roofHeight, 8, span * 0.65) : Math.min(kind === 'barrel' ? 5 : 4, Math.max(0.65, span * (kind === 'skillion' ? 0.16 : 0.26)));
  const append = (destination: 'roof' | 'trim', points: [Point, number][]) => {
    if ((roofPositions.length + trimPositions.length) / 3 + points.length > BUILDING_ROOF_VERTEX_LIMIT) return;
    const positions = destination === 'roof' ? roofPositions : trimPositions, uv = destination === 'roof' ? roofUV : trimUV;
    for (const [p, z] of points) { const x = p[0] * along[0] + p[1] * across[0], y = p[0] * along[1] + p[1] * across[1]; positions.push(x, y, z); uv.push(x / 8, y / 8); }
  };
  const face = (destination: 'roof' | 'trim', polygon: Point[], height: (p: Point) => number) => {
    for (let i = 1; i < polygon.length - 1; i++) {
      let a = polygon[0], b = polygon[i], c = polygon[i + 1];
      if (Math.abs(cross(a, b, c)) < EPSILON) continue;
      if (cross(a, b, c) < 0) [b, c] = [c, b];
      append(destination, [[a, height(a)], [b, height(b)], [c, height(c)]]);
    }
  };
  const wall = (a: Point, b: Point, low: number, za: number, zb = za) => {
    if (Math.max(za, zb) - low < EPSILON) return;
    append('trim', [[a, low], [b, low], [b, zb], [a, low], [b, zb], [a, za]]);
  };
  let heightAt: (p: Point) => number = () => eave;
  let cuts: Plane[] = [];
  let patches: { polygon: Point[]; height: (p: Point) => number }[] = [];
  if (kind === 'hipped') {
    const slope = rise / (span / 2), planes: Plane[] = [[slope, 0, -slope * uMin], [-slope, 0, slope * uMax], [0, slope, -slope * vMin], [0, -slope, slope * vMax]];
    heightAt = p => eave + Math.max(0, Math.min(...planes.map(plane => planeAt(plane, p))));
    for (let i = 0; i < planes.length; i++) {
      const constraints = planes.flatMap((plane, j) => j === i ? [] : [[plane[0] - planes[i][0], plane[1] - planes[i][1], plane[2] - planes[i][2]] as Plane]);
      cuts.push(...constraints);
      for (const triangle of triangles) { let polygon: Point[] = triangle; for (const plane of constraints) polygon = clip(polygon, plane); if (polygon.length > 2) patches.push({ polygon, height: heightAt }); }
    }
  } else if (kind !== 'flat') {
    const stops: [number, number][] = [[vMin, 0]];
    if (kind === 'gabled') stops.push([(vMin + vMax) / 2, rise], [vMax, 0]);
    else if (kind === 'skillion') stops.push([vMax, rise]);
    else if (kind === 'barrel') { const bands = detailLevel === 0 ? 4 : 6; for (let i = 1; i <= bands; i++) stops.push([vMin + width * i / bands, Math.sin(Math.PI * i / bands) * rise]); }
    else { const teeth = Math.max(2, Math.min(4, Math.round(width / 9))); for (let i = 0; i < teeth; i++) stops.push([vMin + width * (i + 0.76) / teeth, rise], [vMin + width * (i + 1) / teeth, 0]); }
    heightAt = p => {
      for (let i = 1; i < stops.length; i++) if (p[1] <= stops[i][0] + EPSILON) { const a = stops[i - 1], b = stops[i], t = Math.max(0, Math.min(1, (p[1] - a[0]) / (b[0] - a[0]))); return eave + a[1] + (b[1] - a[1]) * t; }
      return eave + stops.at(-1)![1];
    };
    cuts = stops.slice(1, -1).map(stop => [0, 1, -stop[0]]);
    for (let i = 1; i < stops.length; i++) for (const triangle of triangles) {
      const polygon = clip(clip(triangle, [0, 1, -stops[i - 1][0]]), [0, -1, stops[i][0]]);
      if (polygon.length > 2) patches.push({ polygon, height: heightAt });
    }
  } else patches = triangles.map(polygon => ({ polygon, height: heightAt }));
  // Complex outlines keep their exact flat footprint instead of dropping roof triangles.
  if (patches.reduce((sum, patch) => sum + (patch.polygon.length - 2) * 3, 0) > 1800) {
    kind = 'flat'; rise = 0; estimated = true; cuts = []; heightAt = () => eave;
    patches = triangles.map(polygon => ({ polygon, height: heightAt }));
  }
  for (const patch of patches) face('roof', patch.polygon, patch.height);
  if (kind !== 'flat') {
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], stops = [0, 1];
      for (const plane of cuts) { const da = planeAt(plane, a), db = planeAt(plane, b), t = da / (da - db); if (Number.isFinite(t) && t > EPSILON && t < 1 - EPSILON) stops.push(t); }
      stops.sort((a, b) => a - b);
      for (let j = 1; j < stops.length; j++) {
        if (stops[j] - stops[j - 1] < EPSILON) continue;
        const p: Point = [a[0] + (b[0] - a[0]) * stops[j - 1], a[1] + (b[1] - a[1]) * stops[j - 1]], q: Point = [a[0] + (b[0] - a[0]) * stops[j], a[1] + (b[1] - a[1]) * stops[j]];
        wall(p, q, eave, heightAt(p), heightAt(q));
      }
    }
  } else if (!profile.tiny && detailLevel > 1) {
    // Parapets are actual walls, 45–65 cm high. Their top strips are clipped to
    // the footprint too, so inset corners and courtyard openings stay empty.
    const parapet = profile.height > 25 ? 0.65 : 0.45, thickness = 0.22;
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      if (length < thickness) continue;
      wall(a, b, eave, eave + parapet);
      const nx = -dy / length, ny = dx / length, tx = dx / length, ty = dy / length;
      const constraints: Plane[] = [[nx, ny, -nx * a[0] - ny * a[1]], [-nx, -ny, nx * a[0] + ny * a[1] + thickness], [tx, ty, -tx * a[0] - ty * a[1]], [-tx, -ty, tx * b[0] + ty * b[1]]];
      for (const triangle of triangles) {
        let polygon: Point[] = triangle; for (const plane of constraints) polygon = clip(polygon, plane);
        if (polygon.length < 3) continue;
        face('trim', polygon, () => eave + parapet);
        for (let j = 0; j < polygon.length; j++) { const p = polygon[j], q = polygon[(j + 1) % polygon.length]; if (Math.abs(planeAt(constraints[1], p)) < EPSILON && Math.abs(planeAt(constraints[1], q)) < EPSILON) wall(q, p, eave, eave + parapet); }
      }
    }
    if (detailLevel > 1 && span > 7 && !['religious', 'greenhouse'].includes(profile.kind)) {
      // Fit one mechanical penthouse inside the largest triangle's incircle.
      // This guarantees it never straddles a courtyard, notch, or another parcel.
      const triangle = triangles.reduce((best, next) => Math.abs(cross(...next)) > Math.abs(cross(...best)) ? next : best), [a, b, c] = triangle;
      const lengths = [Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(a[0] - c[0], a[1] - c[1]), Math.hypot(a[0] - b[0], a[1] - b[1])], perimeter = lengths.reduce((sum, n) => sum + n, 0);
      const radius = Math.abs(cross(a, b, c)) / perimeter;
      const center: Point = [(a[0] * lengths[0] + b[0] * lengths[1] + c[0] * lengths[2]) / perimeter, (a[1] * lengths[0] + b[1] * lengths[1] + c[1] * lengths[2]) / perimeter];
      const halfWidth = Math.min(4.5, radius * 0.65), halfDepth = Math.min(2.8, radius * 0.55);
      if (halfWidth > 0.7 && halfDepth > 0.7) {
        const rectangle: Point[] = [[center[0] - halfWidth, center[1] - halfDepth], [center[0] + halfWidth, center[1] - halfDepth], [center[0] + halfWidth, center[1] + halfDepth], [center[0] - halfWidth, center[1] + halfDepth]];
        const top = eave + Math.min(2.2, 1.15 + profile.height * 0.018);
        face('trim', rectangle, () => top);
        for (let i = 0; i < rectangle.length; i++) wall(rectangle[i], rectangle[(i + 1) % rectangle.length], eave, top);
      }
    }
  }
  return result();
}
