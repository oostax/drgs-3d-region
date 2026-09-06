import * as THREE from 'three';
import type { Feature, Geometry } from 'geojson';
import { classifyBuilding, getBuildingRenderCap } from './building-materials';
import { geometryKey, worldPoint } from './map-life-stability';

type XY = [number, number];
export type SportsDetailOptions = { mobile: boolean; center: XY; radius: number; toLocal: (point: XY) => XY; terrain: (point: XY) => number };
const area = (ring: XY[]) => Math.abs(ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - a[1] * b[0]; }, 0)) / 2;
function inside(p: XY, ring: XY[]) { let result = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if ((ring[i][1] > p[1]) !== (ring[j][1] > p[1]) && p[0] < (ring[j][0] - ring[i][0]) * (p[1] - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0]) result = !result; return result; }
const clean = (ring: XY[]) => ring.filter((p, i) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && (!i || Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > .01)).filter((p, i, all) => !i || i !== all.length - 1 || Math.hypot(p[0] - all[0][0], p[1] - all[0][1]) > .01);

/** Minimum-area orientation follows the mapped venue, including rotated fields. */
export function sportsFrame(ring: XY[]) {
  let best: { center: XY; u: XY; v: XY; length: number; width: number; area: number } | null = null;
  for (let i = 0; i < ring.length; i += Math.max(1, Math.floor(ring.length / 64))) {
    const a = ring[i], b = ring[(i + 1) % ring.length], d = Math.hypot(b[0] - a[0], b[1] - a[1]); if (d < .1) continue;
    let u: XY = [(b[0] - a[0]) / d, (b[1] - a[1]) / d], v: XY = [-u[1], u[0]];
    const us = ring.map(p => p[0] * u[0] + p[1] * u[1]), vs = ring.map(p => p[0] * v[0] + p[1] * v[1]);
    const loU = Math.min(...us), hiU = Math.max(...us), loV = Math.min(...vs), hiV = Math.max(...vs);
    let length = hiU - loU, width = hiV - loV;
    const center: XY = [u[0] * (hiU + loU) / 2 + v[0] * (hiV + loV) / 2, u[1] * (hiU + loU) / 2 + v[1] * (hiV + loV) / 2];
    if (width > length) { [length, width] = [width, length]; [u, v] = [v, [-u[0], -u[1]]]; }
    if (!best || length * width < best.area) best = { center, u, v, length, width, area: length * width };
  }
  return best;
}

/** Source-backed stadium holes and mapped pitches only. Generic field markings
 * illustrate the venue; they are not a survey of its current layout or usage. */
export function createSportsDetails(features: Feature<Geometry>[], options: SportsDetailOptions) {
  const group = new THREE.Group(); group.name = 'atlas-sports-details';
  const positions: number[] = [], colors: number[] = [];
  const palette = new Map<string, THREE.Color>();
  const triangle = (a: XY, b: XY, c: XY, z: number, color: string) => {
    const tint = palette.get(color) ?? new THREE.Color(color); palette.set(color, tint);
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) [b, c] = [c, b];
    for (const point of [a, b, c]) { positions.push(point[0], point[1], z); colors.push(tint.r, tint.g, tint.b); }
  };
  const fill = (ring: XY[], z: number, color: string) => { const vectors = ring.map(p => new THREE.Vector2(...p)); for (const face of THREE.ShapeUtils.triangulateShape(vectors, [])) triangle(ring[face[0]], ring[face[1]], ring[face[2]], z, color); };
  const line = (points: XY[], z: number, width = .15, color = '#eee9d8') => {
    for (let i = 1; i < points.length; i++) { const a = points[i - 1], b = points[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]); if (length < .01) continue; const nx = -(b[1] - a[1]) / length * width / 2, ny = (b[0] - a[0]) / length * width / 2;
      const aa: XY = [a[0] + nx, a[1] + ny], ab: XY = [a[0] - nx, a[1] - ny], ba: XY = [b[0] + nx, b[1] + ny], bb: XY = [b[0] - nx, b[1] - ny]; triangle(aa, ab, bb, z, color); triangle(aa, bb, ba, z, color); }
  };
  const candidates = new Map<string, { rings: XY[][]; world: XY; stadium: boolean; football: boolean; cap: number; key: string }>();
  for (const feature of features) {
    const p = feature.properties ?? {}, kind = String(p.class ?? p.leisure ?? ''), stadium = ['class', 'building', 'leisure', 'building:use'].some(key => ['stadium', 'grandstand'].includes(String(p[key] ?? '').trim().toLowerCase()));
    if (!stadium && kind !== 'pitch' && p.leisure !== 'pitch') continue;
    const sport = String(p.sport ?? p.subclass ?? '').toLowerCase();
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
    for (const polygon of polygons) {
      const rings = polygon.map(ring => clean(ring.map(point => options.toLocal(worldPoint(point)))));
      if (rings[0]?.length < 3 || stadium && rings.length < 2) continue;
      const field = stadium ? rings.slice(1).sort((a, b) => area(b) - area(a))[0] : rings[0];
      if (!field || area(field) < 150) continue;
      const world = worldPoint(polygon[0][0]);
      if (Math.hypot(world[0] - options.center[0], world[1] - options.center[1]) > options.radius + 500) continue;
      const key = `${p.id ?? feature.id ?? 'sports'}:${geometryKey(polygon.flatMap(r => r.map(worldPoint)))}`;
      const cap = stadium ? getBuildingRenderCap(classifyBuilding(p, area(rings[0]))) : 0;
      candidates.set(key, { rings: stadium ? [rings[0], field] : [field], world, stadium, football: sport === 'soccer' || sport === 'football' || stadium && !sport, cap, key });
    }
  }
  // A landuse pitch often duplicates a stadium's inner field. Keep the richer
  // stadium first, so its track, markings and seating survive spatial deduplication.
  const selected = [...candidates.values()].sort((a, b) => Number(b.stadium) - Number(a.stadium) || Math.hypot(a.world[0] - options.center[0], a.world[1] - options.center[1]) - Math.hypot(b.world[0] - options.center[0], b.world[1] - options.center[1])).slice(0, options.mobile ? 5 : 16);
  const occupied: XY[] = []; let stadiums = 0, pitches = 0, goals = 0;
  const goalPositions: number[] = [];
  for (const venue of selected) {
    const field = venue.rings[venue.stadium ? 1 : 0], frame = sportsFrame(field); if (!frame || !inside(frame.center, field) || occupied.some(p => Math.hypot(p[0] - frame.center[0], p[1] - frame.center[1]) < 20)) continue;
    occupied.push(frame.center); const ground = options.terrain(venue.world), z = ground + .18;
    const scaleRing = (scale: number) => field.map(p => [frame.center[0] + (p[0] - frame.center[0]) * scale, frame.center[1] + (p[1] - frame.center[1]) * scale] as XY);
    fill(field, z, venue.stadium ? '#a46550' : '#5b8248');
    const inner = venue.stadium ? scaleRing(.77) : scaleRing(.98);
    fill(inner, z + .025, '#548246');
    if (venue.stadium) {
      stadiums++;
      for (let i = 0; i < 5; i++) { const ring = scaleRing(.81 + i * .037); line([...ring, ring[0]], z + .035, .13, '#d5b8a1'); }
      // Concentric seating rows fit only where the mapped grandstand exists.
      for (let tier = 0; tier < 6; tier++) {
        const near = scaleRing(1.025 + tier * .022), far = scaleRing(1.043 + tier * .022);
        for (let i = 0; i < field.length; i++) { const j = (i + 1) % field.length; if (![near[i], near[j], far[i], far[j]].every(p => inside(p, venue.rings[0]))) continue;
          const color = (Math.floor(i / 4) + tier) % 3 === 0 ? '#bbc8bb' : '#6a9293';
          triangle(near[i], far[i], far[j], ground + venue.cap + .18 + tier * .25, color); triangle(near[i], far[j], near[j], ground + venue.cap + .18 + tier * .25, color);
        }
      }
    } else pitches++;
    if (!venue.football) continue;
    let length = Math.min(105, frame.length * (venue.stadium ? .72 : .91)), width = Math.min(68, length / 1.54, frame.width * (venue.stadium ? .68 : .9));
    const at = (x: number, y: number): XY => [frame.center[0] + frame.u[0] * x + frame.v[0] * y, frame.center[1] + frame.u[1] * x + frame.v[1] * y];
    const rect = (x0: number, y0: number, x1: number, y1: number) => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
    for (let attempt = 0; attempt < 20 && !rect(-length / 2, -width / 2, length / 2, width / 2).every(p => inside(p, inner)); attempt++) { length *= .94; width *= .94; }
    if (length < 20 || width < 12) continue;
    const half = length / 2, side = width / 2, unit = length / 105;
    for (let i = 0; i < 10; i++) fill(rect(-half + i * length / 10, -side, -half + (i + 1) * length / 10, side), z + .04, i % 2 ? '#608c4b' : '#4d7a40');
    line(rect(-half, -side, half, side), z + .065, .18);
    line([at(0, -side), at(0, side)], z + .065, .18);
    const circle = Array.from({ length: 49 }, (_, i) => at(Math.cos(i / 48 * Math.PI * 2) * 9.15 * unit, Math.sin(i / 48 * Math.PI * 2) * 9.15 * unit)); line(circle, z + .065, .17);
    fill(Array.from({ length: 12 }, (_, i) => at(Math.cos(i / 12 * Math.PI * 2) * .3, Math.sin(i / 12 * Math.PI * 2) * .3)), z + .066, '#eee9d8');
    for (const end of [-1, 1]) {
      line(rect(end * half, -20.16 * unit, end * (half - 16.5 * unit), 20.16 * unit), z + .065, .17);
      line(rect(end * half, -9.16 * unit, end * (half - 5.5 * unit), 9.16 * unit), z + .065, .17);
      const a = at(end * (half + .1), -3.66 * unit), b = at(end * (half + .1), 3.66 * unit), backA = at(end * (half + 2 * unit), -3.66 * unit), backB = at(end * (half + 2 * unit), 3.66 * unit), height = 2.44 * unit;
      const segment = (p: XY, pz: number, q: XY, qz: number) => goalPositions.push(p[0], p[1], pz, q[0], q[1], qz);
      segment(a, z, a, z + height); segment(a, z + height, b, z + height); segment(b, z + height, b, z); segment(a, z + height, backA, z); segment(b, z + height, backB, z); segment(backA, z, backB, z);
      for (let i = 1; i < 9; i++) { const t = i / 9, p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], q: XY = [backA[0] + (backB[0] - backA[0]) * t, backA[1] + (backB[1] - backA[1]) * t]; segment(p, z + height, q, z); }
      goals++;
    }
  }
  if (positions.length) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })); mesh.frustumCulled = false; group.add(mesh);
  }
  if (goalPositions.length) { const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(goalPositions, 3)); const nets = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#f0eee1' })); nets.frustumCulled = false; group.add(nets); }
  group.userData.sports = { stadiums, pitches, goals, vertices: (positions.length + goalPositions.length) / 3, drawCalls: group.children.length };
  return group;
}
