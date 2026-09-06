import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as LibreMap } from 'maplibre-gl';
import type { Feature, Geometry, Position } from 'geojson';
import type { LightingState } from './solar';
import { SimulationClock, stableHash, drivableRoad } from './map-life-stability';
import type { Signal } from './types';
import type { SignalGroup } from './signal-markers';
import type { SignalIcon } from './signal-icon-nodes';
import { isCurrentSceneActivity } from './signal-activity';
import { normalizeSceneLifecycle } from './scene-lifecycle';
import type {SceneRecipe} from './scene-catalog';
import { sceneStoryboard } from './scene-storyboards';
import { buildTopicStory } from './map-scene-stories';
import { SIGNAL_ICON_NODES } from './signal-icon-nodes';
import type { LiveActivityKind } from './live-types';

export type SceneKind = LiveActivityKind | 'paused' | 'completed' | 'roads' | 'utilities' | 'landscaping' | 'social' | 'investment' | 'culture';
export type SceneDisplay = 'active' | 'static' | 'paused' | 'completed' | 'archive';
export type SceneCoverageMode = 'confirmed-source-scope' | 'linked-object-illustration';
export type EventScene = {
  id: string; title: string; kind: SceneKind; coordinates: [number, number];
  precision: 'site' | 'building' | 'street' | 'territory' | 'settlement'; planned: boolean;
  territoryId?: string | null; geometry?: Geometry; lifecycle?: Signal['lifecycle']; live?: Signal['live'];
  activityKind?: LiveActivityKind; activityExpiresAt?: number | null; display?: SceneDisplay;
  recipe?: Pick<SceneRecipe,'family'|'topic'|'icon'>; defectPositionConfirmed?:boolean;
  topic?: SignalGroup; icon?: SignalIcon;
  selected?: boolean; priority?: number; state?: string; entireStreet?: boolean; excavationConfirmed?: boolean;
  coverageMode?: SceneCoverageMode; lastKnownWork?: boolean;
};
export type SignalSceneOptions = { scenes: () => EventScene[]; enabled: () => boolean; animate: () => boolean; lighting: () => LightingState; mobile: boolean; reducedMotion: boolean; onError?: (error: unknown) => void };
type XY = [number, number];
type XYZ = [number, number, number];
export type MaterialName = 'edge' | 'soil' | 'grass' | 'leaf' | 'leafLight' | 'trunk' | 'cream' | 'glass' | 'steel' | 'rubber' | 'road' | 'ochre' | 'orange' | 'blue' | 'white' | 'skin' | 'water' | 'lamp' | 'blueprint' | 'asphalt' | 'gravel' | 'mesh';
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

/** A real metre stays a real metre at every camera scale. Area signals remain markers. */
export function getScenePresentation(event: EventScene, zoom: number, now = Date.now()) {
  const display = event.display ?? (event.live ? (normalizeSceneLifecycle(event, now).activeActivity ? 'active' : 'static') : 'active');
  const current = display !== 'active' || isCurrentSceneActivity(event, now);
  return { visible: current && ['site', 'building', 'street'].includes(event.precision) && zoom >= 13.2, scale: 1, offset: [0, 0, 0] as XYZ, angle: 0, detail: zoom >= 16.5 };
}

export type SceneWall = { a: XY; b: XY; length: number; outward: XY };
export type SceneAttachment = { type: 'building' | 'site' | 'street'; key: string; path: XY[]; holes?: XY[][]; walls: SceneWall[]; height: number; closed: boolean; length: number; sourceId: string; visibleRanges?: { start: number; end: number }[]; heightAt?: (x: number, y: number) => number };
export type SceneWorkZone = { start: number; end: number; center: number };

/** A bounded set of crews covers the supplied section; gaps in a MultiLineString stay gaps. */
export function getSceneWorkZones(attachment: SceneAttachment, mobile = false): SceneWorkZone[] {
  const sections: { start: number; end: number }[] = [];
  let distance = 0;
  for (const [index, wall] of attachment.walls.entries()) {
    const previous = attachment.walls[index - 1];
    if (!previous || Math.hypot(previous.b[0] - wall.a[0], previous.b[1] - wall.a[1]) > 0.1) sections.push({ start: distance, end: distance });
    distance += wall.length;
    sections.at(-1)!.end = distance;
  }
  const targetSections = attachment.visibleRanges?.length ? attachment.visibleRanges : sections;
  const candidates = targetSections.flatMap(section => {
    const count = Math.max(attachment.visibleRanges && section.end - section.start > 45 ? 2 : 1, Math.ceil((section.end - section.start - 0.001) / (attachment.visibleRanges ? 52 : 100)));
    return Array.from({ length: count }, (_, index) => {
      const center = section.start + (section.end - section.start) * (index + 0.5) / count;
      return { center, start: Math.max(section.start, center - 25), end: Math.min(section.end, center + 25) };
    });
  });
  const budget = attachment.visibleRanges ? mobile ? 5 : 12 : mobile ? 8 : 24;
  if (candidates.length <= budget) return candidates;
  return Array.from({ length: budget }, (_, index) => candidates[Math.floor((index + 0.5) * candidates.length / budget)]);
}

export function getSceneVisibleRanges(attachment: SceneAttachment, coordinates: [number, number], project: (point: [number, number]) => { x: number; y: number }, width: number, height: number) {
  const origin = MercatorCoordinate.fromLngLat(coordinates), unit = origin.meterInMercatorCoordinateUnits();
  const ranges: { start: number; end: number }[] = [];
  const screen = (point: XY) => { const value = new MercatorCoordinate(origin.x + point[0] * unit, origin.y - point[1] * unit).toLngLat(); return project([value.lng, value.lat]); };
  let distance = 0;
  for (const [index, wall] of attachment.walls.entries()) {
    const a = screen(wall.a), b = screen(wall.b), dx = b.x - a.x, dy = b.y - a.y;
    let start = 0, end = 1, visible = [a.x, a.y, b.x, b.y].every(Number.isFinite);
    for (const [p, q] of [[-dx, a.x + 35], [dx, width + 35 - a.x], [-dy, a.y + 35], [dy, height + 35 - a.y]]) {
      if (p === 0) { if (q < 0) visible = false; continue; }
      if (p < 0) start = Math.max(start, q / p); else end = Math.min(end, q / p);
    }
    if (visible && start <= end) {
      const next = { start: distance + wall.length * start, end: distance + wall.length * end }, previous = ranges.at(-1), previousWall = attachment.walls[index - 1];
      const connected = previousWall && Math.hypot(previousWall.b[0] - wall.a[0], previousWall.b[1] - wall.a[1]) < 0.1;
      if (previous && connected && next.start - previous.end < 0.1) previous.end = next.end; else ranges.push(next);
    }
    distance += wall.length;
  }
  return ranges.filter(range => range.end - range.start >= 3);
}

export function getSceneSiteLayout(attachment: SceneAttachment): { x: number; y: number; clearance: number }[] {
  if (!attachment.closed) return [];
  const rings = [attachment.path, ...(attachment.holes ?? [])];
  const minX = Math.min(...attachment.path.map(point => point[0])), maxX = Math.max(...attachment.path.map(point => point[0]));
  const minY = Math.min(...attachment.path.map(point => point[1])), maxY = Math.max(...attachment.path.map(point => point[1]));
  const candidates: { x: number; y: number; clearance: number }[] = [];
  for (let ix = 0; ix < 12; ix++) for (let iy = 0; iy < 12; iy++) {
    const point: XY = [minX + (maxX - minX) * (ix + 0.5) / 12, minY + (maxY - minY) * (iy + 0.5) / 12];
    if (!pointInSceneRing(point, attachment.path) || attachment.holes?.some(hole => pointInSceneRing(point, hole))) continue;
    let clearance = Infinity;
    for (const ring of rings) for (let index = 1; index < ring.length; index++) {
      const a = ring[index - 1], b = ring[index], dx = b[0] - a[0], dy = b[1] - a[1];
      const t = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      clearance = Math.min(clearance, Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t));
    }
    if (clearance >= 1.2) candidates.push({ x: point[0], y: point[1], clearance });
  }
  const pads: typeof candidates = [];
  for (const candidate of candidates.sort((a, b) => b.clearance - a.clearance || a.x - b.x || a.y - b.y)) {
    if (pads.every(pad => Math.hypot(pad.x - candidate.x, pad.y - candidate.y) >= Math.min(14, pad.clearance + candidate.clearance))) pads.push(candidate);
    if (pads.length === 8) break;
  }
  return pads;
}
function polygons(geometry: Geometry | null | undefined): Position[][][] { return geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []; }
function lines(geometry: Geometry | null | undefined): Position[][] { return geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : []; }
export function getSceneViewportPoint(event: EventScene, project: (point: [number, number]) => { x: number; y: number }, width: number, height: number) {
  const origin = project(event.coordinates);
  const inside = (point: { x: number; y: number }) => point.x >= -80 && point.y >= -80 && point.x <= width + 80 && point.y <= height + 80;
  if (inside(origin)) return origin;
  if (event.precision !== 'street' || !event.geometry) return null;
  // A long source section may cross the viewport while its address marker is
  // outside it. Clip each supplied segment; never connect separate lines.
  for (const line of lines(event.geometry)) for (let index = 1; index < line.length; index++) {
    const a = project([line[index - 1][0], line[index - 1][1]]), b = project([line[index][0], line[index][1]]);
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    let start = 0, end = 1, visible = true;
    for (const [p, q] of [[-dx, a.x + 80], [dx, width + 80 - a.x], [-dy, a.y + 80], [dy, height + 80 - a.y]]) {
      if (p === 0) { if (q < 0) visible = false; continue; }
      if (p < 0) start = Math.max(start, q / p); else end = Math.min(end, q / p);
    }
    if (visible && start <= end) return { x: a.x + dx * (start + end) / 2, y: a.y + dy * (start + end) / 2 };
  }
  return null;
}
export function pointInSceneRing(point: readonly number[], ring: readonly Position[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i], dx = b[0] - a[0], dy = b[1] - a[1], cross = (point[0] - a[0]) * dy - (point[1] - a[1]) * dx;
    if (Math.abs(cross) < 1e-12 && point[0] >= Math.min(a[0], b[0]) - 1e-10 && point[0] <= Math.max(a[0], b[0]) + 1e-10 && point[1] >= Math.min(a[1], b[1]) - 1e-10 && point[1] <= Math.max(a[1], b[1]) + 1e-10) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < dx * (point[1] - a[1]) / (dy || 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}
function inPolygon(point: XY, polygon: Position[][]) { return Boolean(polygon[0]?.length >= 4 && pointInSceneRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInSceneRing(point, hole))); }
function local(point: Position, origin: MercatorCoordinate): XY { const p = MercatorCoordinate.fromLngLat([point[0], point[1]]), unit = origin.meterInMercatorCoordinateUnits(); return [(p.x - origin.x) / unit, -(p.y - origin.y) / unit]; }
function area(ring: XY[]) { return ring.reduce((sum, p, index) => { const next = ring[(index + 1) % ring.length]; return sum + p[0] * next[1] - next[0] * p[1]; }, 0) / 2; }
function makeAttachment(type: SceneAttachment['type'], path: XY[], height: number, sourceId: string): SceneAttachment | null {
  if (path.length < 2 || path.some((p) => !p.every(Number.isFinite))) return null;
  const closed = type !== 'street';
  if (closed && Math.hypot(path[0][0] - path.at(-1)![0], path[0][1] - path.at(-1)![1]) > 0.01) path = [...path, path[0]];
  const clockwise = area(path) < 0, walls: SceneWall[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy); if (length < 0.1) continue;
    let outward: XY = clockwise ? [-dy / length, dx / length] : [dy / length, -dx / length];
    if (closed) {
      // Source polygons do not consistently keep GeoJSON ring winding after
      // clipping and tile decoding. Verify every normal geometrically so
      // equipment is always placed outside the building instead of being
      // swallowed by its depth volume.
      const middle: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const probe: XY = [middle[0] + outward[0] * 0.5, middle[1] + outward[1] * 0.5];
      if (pointInSceneRing(probe, path)) outward = [-outward[0], -outward[1]];
    }
    walls.push({ a, b, length, outward });
  }
  const length = walls.reduce((total, wall) => total + wall.length, 0); if (length < 3 || !walls.length) return null;
  return { type, key: `${type}:${sourceId}:${height}:${path.map((point) => point.map((v) => v.toFixed(2)).join(',')).join(';')}`, path, height, sourceId, walls, closed, length };
}
function along(attachment: SceneAttachment, distance: number, outset = 0) {
  let d = attachment.closed ? ((distance % attachment.length) + attachment.length) % attachment.length : clamp(distance, 0, attachment.length);
  for (let i = 0; i < attachment.walls.length; i++) { const wall = attachment.walls[i]; if (d <= wall.length || i === attachment.walls.length - 1) { const fraction = clamp(d / wall.length, 0, 1); return { x: wall.a[0] + (wall.b[0] - wall.a[0]) * fraction + wall.outward[0] * outset, y: wall.a[1] + (wall.b[1] - wall.a[1]) * fraction + wall.outward[1] * outset, angle: Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]) }; } d -= wall.length; }
  return { x: 0, y: 0, angle: 0 };
}
function nearestOnPath(path: XY[]) { let best = { distance: Infinity, chainage: 0 }, elapsed = 0; for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy), t = clamp(-(a[0] * dx + a[1] * dy) / (length * length || 1), 0, 1), distance = Math.hypot(a[0] + dx * t, a[1] + dy * t); if (distance < best.distance) best = { distance, chainage: elapsed + t * length }; elapsed += length; } return best; }

/** No synthetic fallback: only a containing building, confirmed site polygon, or nearby road. */
export function resolveSceneAttachment(event: EventScene, buildings: Feature<Geometry>[] = [], transportation: Feature<Geometry>[] = []): SceneAttachment | null {
  if (!event.coordinates.every(Number.isFinite) || ['territory', 'settlement'].includes(event.precision)) return null;
  const origin = MercatorCoordinate.fromLngLat(event.coordinates);
  if (event.precision === 'site') {
    const polygon = event.geometry ? polygons(event.geometry).find((polygon) => inPolygon(event.coordinates, polygon)) : null;
    const attachment = polygon ? makeAttachment('site', polygon[0].map((point) => local(point, origin)), 0, event.id) : null;
    return attachment && polygon ? { ...attachment, holes: polygon.slice(1).map(ring => ring.map(point => local(point, origin))) } : null;
  }
  if (event.precision === 'building') {
    const supplied: Feature<Geometry>[] = event.geometry && polygons(event.geometry).length ? [{ type: 'Feature', id: `verified:${event.id}`, geometry: event.geometry, properties: {} }] : [];
    const candidates = [...buildings, ...supplied].flatMap((feature) => polygons(feature.geometry).filter((polygon) => inPolygon(event.coordinates, polygon)).map((polygon) => ({ feature, path: polygon[0].map((point) => local(point, origin)) })));
    const partRank = (feature: Feature<Geometry>) => feature.properties?.atlasSceneFootprintRole === 'part' || feature.properties?.['building:part'] ? 1 : 0;
    candidates.sort((a, b) => partRank(a.feature) - partRank(b.feature) || Math.abs(area(a.path)) - Math.abs(area(b.path)) || String(a.feature.id).localeCompare(String(b.feature.id)));
    const candidate = candidates[0]; if (!candidate) return null;
    const properties = candidate.feature.properties ?? {}, measured = Number(properties.height ?? properties.render_height), floors = Number(properties.num_floors ?? properties['building:levels'] ?? properties.levels);
    const height = Number.isFinite(measured) && measured > 0 ? measured : Number.isFinite(floors) && floors > 0 ? floors * 3 : 8;
    return makeAttachment('building', candidate.path, height, String(candidate.feature.id ?? properties.id ?? properties.building_id ?? event.id));
  }
  if (event.precision === 'street') {
    const supplied: Feature<Geometry>[] = event.geometry && lines(event.geometry).length ? [{ type: 'Feature', id: `verified:${event.id}`, geometry: event.geometry, properties: {} }] : [];
    if(event.geometry&&supplied.length){
      const pieces=lines(event.geometry).map((line,index)=>makeAttachment('street',line.map(point=>local(point,origin)),0,event.geometry?.type==='LineString'?`verified:${event.id}`:`verified:${event.id}:${index}`)).filter((piece):piece is SceneAttachment=>Boolean(piece));
      if(pieces.length&&pieces.some(piece=>nearestOnPath(piece.path).distance<=60))return {...pieces[0],key:pieces.map(p=>p.key).join('|'),walls:pieces.flatMap(p=>p.walls),length:pieces.reduce((sum,p)=>sum+p.length,0)};
      return null;
    }
    const candidates = (supplied.length ? supplied : transportation.filter((feature) => drivableRoad(feature.properties ?? {}))).flatMap((feature) => lines(feature.geometry).map((line) => { const path = line.map((point) => local(point, origin)); return { path, feature, nearest: nearestOnPath(path) }; })).filter((entry) => entry.nearest.distance <= 60).sort((a, b) => a.nearest.distance - b.nearest.distance);
    const candidate = candidates[0]; if (!candidate) return null;
    const full = makeAttachment('street', candidate.path, 0, String(candidate.feature.id ?? candidate.feature.properties?.id ?? event.id)); if (!full) return null;
    return full;
  }
  return null;
}

class Resources {
  readonly box = new THREE.BoxGeometry(1, 1, 1);
  readonly cylinder = new THREE.CylinderGeometry(1, 1, 1, 8).rotateX(Math.PI / 2);
  readonly cone = new THREE.ConeGeometry(1, 1, 8).rotateX(Math.PI / 2);
  readonly sphere = new THREE.IcosahedronGeometry(1, 1);
  readonly signs = new Map<string, THREE.MeshBasicMaterial>();
  readonly materials = new Map<MaterialName, THREE.MeshStandardMaterial>();
  constructor() {
    const colors: Record<MaterialName, string> = { edge: '#536e65', soil: '#a58a68', grass: '#a4b784', leaf: '#436b40', leafLight: '#79964d', trunk: '#79644c', cream: '#e4d8c2', glass: '#58868b', steel: '#64787a', rubber: '#303b39', road: '#67716f', ochre: '#deb35e', orange: '#dc8550', blue: '#507c91', white: '#fff7e7', skin: '#d6ab8b', water: '#72adb3', lamp: '#ffe0a6', blueprint: '#82b9c1', asphalt: '#2b3739', gravel: '#b4aaa0', mesh: '#4c938e' };
    for (const name of Object.keys(colors) as MaterialName[]) this.materials.set(name, new THREE.MeshStandardMaterial({ color: colors[name], roughness: name === 'glass' ? 0.35 : 0.82, metalness: name === 'steel' ? 0.25 : 0 }));
    this.materials.get('lamp')!.emissive.set('#ffd397');
    this.materials.get('glass')!.emissive.set('#ffd397');
    this.materials.get('blueprint')!.emissive.set('#548ca4');
    this.materials.get('mesh')!.transparent = true;
    this.materials.get('mesh')!.opacity = 0.32;
    this.materials.get('mesh')!.depthWrite = false;
    this.materials.get('mesh')!.side = THREE.DoubleSide;
  }
  sign(icon: string) {
    const known=this.signs.get(icon); if(known)return known;
    const material=new THREE.MeshBasicMaterial({color:'#fff7e7',side:THREE.DoubleSide});
    if(typeof document!=='undefined') {
      const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;
      const ctx=canvas.getContext('2d');
      if(ctx){ctx.fillStyle='#fff7e7';ctx.fillRect(0,0,128,128);
        if(icon.startsWith('state:')){ctx.fillStyle='#245a43';ctx.font='bold 21px sans-serif';ctx.textAlign='center';ctx.fillText(icon.slice(6),64,72);}
        ctx.scale(4,4);ctx.translate(4,4);ctx.strokeStyle='#245a43';ctx.lineWidth=1.8;ctx.lineCap='round';ctx.lineJoin='round';
        const nodes=SIGNAL_ICON_NODES[icon as SignalIcon]??SIGNAL_ICON_NODES.construction;
        for(const [kind,raw] of icon.startsWith('state:')?[]:nodes){const a=raw as Record<string,string>;ctx.beginPath();
          if(kind==='path')ctx.stroke(new Path2D(a.d));
          else if(kind==='circle'){ctx.arc(+a.cx,+a.cy,+a.r,0,Math.PI*2);ctx.stroke();}
          else if(kind==='rect'){ctx.rect(+a.x,+a.y,+a.width,+a.height);ctx.stroke();}
          else if(kind==='line'){ctx.moveTo(+a.x1,+a.y1);ctx.lineTo(+a.x2,+a.y2);ctx.stroke();}
          else if(kind==='polyline'||kind==='polygon'){const points=a.points.split(/[ ,]+/).map(Number);for(let i=0;i<points.length;i+=2){if(i)ctx.lineTo(points[i],points[i+1]);else ctx.moveTo(points[i],points[i+1]);}if(kind==='polygon')ctx.closePath();ctx.stroke();}
        }
        material.map=new THREE.CanvasTexture(canvas);material.map.colorSpace=THREE.SRGBColorSpace;
      }
    }
    this.signs.set(icon,material);return material;
  }
  material(name: MaterialName) { return this.materials.get(name)!; }
  light(night: number) { this.material('lamp').emissiveIntensity = 0.4 + night * 1.5; this.material('glass').emissiveIntensity = night * 0.8; this.material('blueprint').emissiveIntensity = 0.12 + night * 0.5; }
  dispose() { [this.box, this.cylinder, this.cone, this.sphere].forEach((g) => g.dispose()); this.materials.forEach((m) => m.dispose()); this.materials.clear(); this.signs.forEach(m=>{m.map?.dispose();m.dispose();});this.signs.clear(); }
}

type Model = { root: THREE.Group; detail: THREE.Group; animated: boolean; update: (time: number) => void; dispose: () => void };
export class ModelBuilder {
  readonly root = new THREE.Group();
  readonly fixed = new THREE.Group();
  readonly detail = new THREE.Group();
  readonly motions: ((time: number) => void)[] = [];
  readonly owned: THREE.BufferGeometry[] = [];
  constructor(readonly pool: Resources, readonly event: EventScene, readonly attachment?: SceneAttachment) { this.root.add(this.fixed, this.detail); }
  group(parent: THREE.Group = this.root, point: XYZ = [0, 0, 0]) { const group = new THREE.Group(); group.position.set(...point); parent.add(group); return group; }
  part(parent: THREE.Group, geometry: THREE.BufferGeometry, material: MaterialName, point: XYZ, size: XYZ) { const mesh = new THREE.Mesh(geometry, this.pool.material(material)); mesh.position.set(...point); mesh.scale.set(...size); parent.add(mesh); return mesh; }
  box(parent: THREE.Group, material: MaterialName, point: XYZ, size: XYZ) { return this.part(parent, this.pool.box, material, point, size); }
  cylinder(parent: THREE.Group, material: MaterialName, point: XYZ, radius: number, height: number) { return this.part(parent, this.pool.cylinder, material, point, [radius, radius, height]); }
  ball(parent: THREE.Group, material: MaterialName, point: XYZ, size: XYZ) { return this.part(parent, this.pool.sphere, material, point, size); }
  beam(parent: THREE.Group, material: MaterialName, a: XYZ, b: XYZ, width = 0.35) {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), middle = from.clone().add(to).multiplyScalar(0.5), direction = to.sub(from);
    const mesh = this.cylinder(parent, material, middle.toArray() as XYZ, width, direction.length());
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize()); return mesh;
  }
  tree(parent: THREE.Group, x: number, y: number, size = 1) {
    this.cylinder(parent, 'trunk', [x, y, 2.2 * size], 0.35 * size, 4.4 * size);
    this.ball(parent, 'leaf', [x, y, 6.2 * size], [2.3 * size, 2.5 * size, 3.5 * size]);
    this.ball(parent, 'leafLight', [x - 0.8 * size, y - 0.6 * size, 7 * size], [1.7 * size, 1.7 * size, 2.1 * size]);
  }
  person(parent: THREE.Group, x: number, y: number, color: MaterialName = 'orange', worker = false) {
    const group = this.group(parent, [x, y, 0]); group.scale.setScalar(0.7);
    this.cylinder(group, color, [0, 0, 1.25], 0.42, 1.15); this.ball(group, 'skin', [0, 0, 2.1], [0.34, 0.34, 0.37]);
    this.box(group, 'steel', [-0.2, 0, 0.42], [0.25, 0.35, 0.85]); this.box(group, 'steel', [0.2, 0, 0.42], [0.25, 0.35, 0.85]);
    for (const side of [-1, 1]) {
      this.beam(group, color, [side * 0.35, 0, 1.62], [side * 0.5, -0.15, 0.93], 0.12);
      this.ball(group, worker ? 'cream' : 'skin', [side * 0.5, -0.15, 0.87], [0.12, 0.13, 0.16]);
      this.box(group, 'rubber', [side * 0.2, -0.08, 0.09], [0.31, 0.52, 0.2]);
    }
    if (worker) {
      this.ball(group, 'ochre', [0, 0, 2.34], [0.46, 0.43, 0.22]);
      this.cylinder(group, 'ochre', [0, 0, 2.28], 0.46, 0.07);
      for (const z of [1.02, 1.55]) this.box(group, 'white', [0, -0.4, z], [0.63, 0.04, 0.095]);
      for (const side of [-0.22, 0.22]) this.box(group, 'white', [side, -0.4, 1.39], [0.075, 0.04, 0.5]);
    }
    this.weld(group); return group;
  }
  vehicle(parent: THREE.Group, x: number, y: number, kind: 'truck' | 'van' | 'roller') {
    const group = this.group(parent, [x, y, 0]);
    if (kind === 'roller') {
      this.box(group, 'ochre', [0, 0, 1.05], [4.5, 2.3, 0.6]);
      for (const axle of [-1.65, 1.65]) {
        const drum = this.cylinder(group, 'steel', [axle, 0, 0.7], 0.7, 2.7); drum.rotation.x = Math.PI / 2;
        for (const side of [-1.4, 1.4]) this.box(group, 'ochre', [axle, side, 0.8], [1.8, 0.15, 0.32]);
      }
      this.box(group, 'ochre', [1, 0, 1.62], [1.5, 2.05, 0.6]);
      this.box(group, 'rubber', [-0.65, 0, 1.65], [0.8, 0.65, 0.3]);
      this.box(group, 'rubber', [-1.04, 0, 2], [0.18, 0.7, 0.8]);
      for (const px of [-1.2, 0.6]) for (const py of [-0.9, 0.9]) this.beam(group, 'steel', [px, py, 1.2], [px, py, 3.05], 0.045);
      this.box(group, 'ochre', [-0.3, 0, 3.1], [2.4, 2.15, 0.16]);
      this.beam(group, 'steel', [-0.1, 0, 1.4], [0.1, 0, 2.1], 0.05);
      this.cylinder(group, 'rubber', [0.1, 0, 2.1], 0.2, 0.06);
      this.cylinder(group, 'lamp', [-0.6, 0, 3.27], 0.12, 0.2);
      this.weld(group); return group;
    }
    this.box(group, kind === 'van' ? 'white' : 'ochre', [0, 0, 1.55], [kind === 'van' ? 5.2 : 6.5, 2.7, 1.6]);
    this.box(group, kind === 'van' ? 'white' : 'orange', [1.5, 0, 2.8], [2.2, 2.8, 1.8]);
    this.box(group, 'glass', [2.65, 0, 3], [0.06, 2.3, 0.9]);
    if (kind === 'truck') this.box(group, 'cream', [-1.7, 0, 2.8], [3.4, 2.65, 1.55]);
    for (const xWheel of [-2, 1.7]) for (const yWheel of [-1.4, 1.4]) { const wheel = this.cylinder(group, 'rubber', [xWheel, yWheel, 0.8], 0.85, 0.45); wheel.rotation.x = Math.PI / 2; }
    for (const yLamp of [-0.85, 0.85]) this.box(group, 'lamp', [2.75, yLamp, 1.6], [0.13, 0.5, 0.35]);
    for (const side of [-1, 1]) {
      this.box(group, 'glass', [1.5, side * 1.415, 3.05], [1.6, 0.045, 0.85]);
      this.box(group, 'orange', [-0.8, side * 1.365, 1.6], [kind === 'van' ? 3.5 : 3.1, 0.025, 0.2]);
      this.box(group, 'steel', [2.2, side * 1.65, 2.65], [0.4, 0.14, 0.3]);
    }
    this.box(group, 'steel', [3.18, 0, 1.02], [0.22, 2.6, 0.3]);
    this.cylinder(group, 'lamp', [1.3, 0, 3.75], 0.16, 0.16);
    this.weld(group); return group;
  }
  lamp(parent: THREE.Group, x: number, y: number, height = 9) {
    this.cylinder(parent, 'steel', [x, y, height / 2], 0.16, height);
    this.box(parent, 'steel', [x + 1, y, height], [2.2, 0.3, 0.3]);
    this.box(parent, 'lamp', [x + 1.5, y, height - 0.1], [1.2, 0.7, 0.3]);
  }
  /** Merge static primitives to a handful of draw calls; animated pivots stay separate. */
  weld(group: THREE.Group) {
    group.updateWorldMatrix(true, true);
    const inverse = group.matrixWorld.clone().invert(), batches = new Map<THREE.Material, THREE.BufferGeometry[]>(), meshes: THREE.Mesh[] = [];
    group.traverse((object) => { if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
      const geometry = (object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()).applyMatrix4(inverse.clone().multiply(object.matrixWorld));
      const list = batches.get(object.material) ?? []; list.push(geometry); batches.set(object.material, list); meshes.push(object);
    });
    meshes.forEach((mesh) => mesh.removeFromParent());
    for (const [material, parts] of batches) { const geometry = mergeGeometries(parts, false); parts.forEach((part) => part.dispose()); if (!geometry) continue; this.owned.push(geometry); group.add(new THREE.Mesh(geometry, material)); }
  }
  finish(allowMotion = true): Model {
    this.weld(this.fixed); this.weld(this.detail);
    this.motions.forEach(update => update(0));
    const heightAt = this.attachment?.heightAt;
    if (heightAt) for (const group of [this.fixed, this.detail]) group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const positions = object.geometry.getAttribute('position');
      for (let index = 0; index < positions.count; index++) positions.setZ(index, positions.getZ(index) + heightAt(positions.getX(index), positions.getY(index)));
      positions.needsUpdate = true; object.geometry.computeVertexNormals(); object.geometry.computeBoundingSphere();
    });
    const grounded = this.root.children.filter(child => child !== this.fixed && child !== this.detail).map(child => ({ child, z: child.position.z }));
    const ground = () => { if (heightAt) for (const { child, z } of grounded) child.position.z = z + heightAt(child.position.x, child.position.y); };
    ground();
    return { root: this.root, detail: this.detail, animated: allowMotion && this.motions.length > 0, update: (time) => { if (allowMotion) { this.motions.forEach((fn) => fn(time)); ground(); } }, dispose: () => { this.owned.forEach((g) => g.dispose()); this.root.clear(); } };
  }
}

function scaffold(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean) {
  const height = Math.min(attachment.height + 0.5, 65), walls = attachment.walls;
  for (const wall of walls) {
    const count = Math.min(24, Math.max(1, Math.ceil(wall.length / 3))), length = wall.length, dx = (wall.b[0] - wall.a[0]) / length, dy = (wall.b[1] - wall.a[1]) / length;
    const p = (distance: number, side: number, z: number): XYZ => [wall.a[0] + dx * distance + wall.outward[0] * side, wall.a[1] + dy * distance + wall.outward[1] * side, z];
    for (let i = 0; i <= count; i++) for (const side of [0.25, 1.3]) b.beam(b.fixed, 'steel', p(length * i / count, side, 0.1), p(length * i / count, side, height), 0.045);
    for (let z = 2.7; z <= height; z += 2.7) {
      const deck = b.box(b.fixed, 'cream', p(length / 2, 0.78, z), [length, 1.2, 0.13]); deck.rotation.z = Math.atan2(dy, dx);
      for (const side of [0.25, 1.3]) b.beam(b.fixed, 'steel', p(0, side, z + 0.9), p(length, side, z + 0.9), 0.04);
      for (let i = 0; i < count; i++) b.beam(b.detail, 'steel', p(length * i / count, 1.3, z - 2.7), p(length * (i + 1) / count, 1.3, z), 0.03);
    }
    if (height >= 5) {
      const veil = b.box(b.detail, 'mesh', p(length / 2, 1.32, height * 0.53), [length, 0.025, height * 0.9]); veil.rotation.z = Math.atan2(dy, dx);
      for (const fraction of mobile ? [0.35] : [0.28, 0.72]) {
        const at = p(length * fraction, 0.78, Math.min(5.4, Math.floor((height - 2) / 2.7) * 2.7));
        const worker = b.person(b.detail, at[0], at[1], 'orange', true); worker.position.z = Math.max(0.1, at[2]); worker.rotation.z = Math.atan2(dy, dx);
      }
    }
  }
}
function crane(b: ModelBuilder, attachment: SceneAttachment) {
  const wall = [...attachment.walls].sort((a, b) => b.length - a.length)[0], height = clamp(attachment.height + 6, 10, 40);
  const pad = attachment.type === 'site' ? getSceneSiteLayout(attachment)[0] : null;
  if (attachment.type === 'site' && (!pad || pad.clearance < 8)) return;
  const reach = pad ? Math.min(23, pad.clearance - 1) : clamp(wall.length * 0.45, 8, 23);
  const x = pad?.x ?? (wall.a[0] + wall.b[0]) / 2 + wall.outward[0] * 5, y = pad?.y ?? (wall.a[1] + wall.b[1]) / 2 + wall.outward[1] * 5;
  const tower = b.group(b.root, [x, y, 0]);
  for (const x of [-0.8, 0.8]) for (const y of [-0.8, 0.8]) b.beam(tower, 'ochre', [x, y, 0], [x, y, height], 0.13);
  for (let z = 0; z < height; z += 2.8) for (const side of [-0.8, 0.8]) { b.beam(tower, 'ochre', [-0.8, side, z], [0.8, side, Math.min(z + 2.8, height)], 0.075); b.beam(tower, 'ochre', [-0.8, side, Math.min(z + 2.8, height)], [0.8, side, Math.min(z + 2.8, height)], 0.09); }
  b.box(tower, 'steel', [0, 0, 0.3], [3.2, 3.2, 0.6]); b.weld(tower);
  const arm = b.group(tower, [0, 0, height]);
  b.box(arm, 'ochre', [(reach - 6) / 2, 0, 0], [reach + 6, 1.2, 0.45]);
  for (let x = -6; x < reach - 1; x += 2) { b.beam(arm, 'ochre', [x, 0, 0], [x + 1, 0, 1.1], 0.065); b.beam(arm, 'ochre', [x + 1, 0, 1.1], [Math.min(x + 2, reach), 0, 0], 0.065); }
  b.box(arm, 'steel', [-4.5, 0, -0.7], [2.8, 2.3, 1.5]); b.box(arm, 'glass', [1, -0.8, -0.65], [1.7, 1.5, 1.7]);
  b.beam(arm, 'steel', [0, 0, 3.3], [reach, 0, 0], 0.04); b.beam(arm, 'steel', [0, 0, 3.3], [-6, 0, 0], 0.04); b.weld(arm);
  const trolley = b.group(arm, [reach * 0.65, 0, -0.3]); b.box(trolley, 'steel', [0, 0, 0], [1.2, 1.5, 0.4]);
  const cable = b.cylinder(trolley, 'steel', [0, 0, -3], 0.03, 6), load = b.group(trolley);
  b.box(load, 'ochre', [0, 0, 0], [0.4, 0.4, 0.6]); b.beam(load, 'steel', [0, 0, -0.3], [-0.7, 0, -1], 0.035); b.beam(load, 'steel', [0, 0, -0.3], [0.7, 0, -1], 0.035); b.box(load, 'cream', [0, 0, -1.3], [1.8, 1.1, 0.5]); b.weld(load);
  const inward = Math.atan2(-wall.outward[1], -wall.outward[0]);
  b.motions.push((t) => { arm.rotation.z = inward + Math.sin(t / 13) * 0.45; trolley.position.x = reach * (0.58 + Math.sin(t / 8) * 0.18); const length = clamp(height - attachment.height - 2.2 + Math.sin(t / 6) * 0.6, 1.4, 8); cable.scale.z = length; cable.position.z = -length / 2; load.position.set(Math.sin(t * 0.8) * 0.1, 0, -length); });
}
function crew(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean) {
  if (attachment.type === 'site') {
    for (const pad of getSceneSiteLayout(attachment).slice(-1 * (mobile ? 2 : 4))) workingPerson(b, b.root, pad.x, pad.y, true);
    return;
  }
  for (let i = 0; i < (mobile ? 1 : 3); i++) {
    const person = b.person(b.root, 0, 0, i % 2 ? 'blue' : 'orange', true);
    b.motions.push((t) => { const progress = t * 0.55 + i * attachment.length / 3, distance = attachment.closed ? progress : (1 - Math.abs((progress / attachment.length) % 2 - 1)) * attachment.length, p = along(attachment, distance, attachment.type === 'street' ? 2.6 : attachment.type === 'site' ? -1.9 : 1.9); person.position.set(p.x, p.y, 0.08); person.rotation.z = p.angle; });
  }
}
function boundary(b: ModelBuilder, attachment: SceneAttachment) {
  const count = Math.min(64, Math.max(4, Math.ceil(attachment.length / 3)));
  const spacing=attachment.length/count;
  for (let i = 0; i < count; i++) {
    const p=along(attachment,i*spacing),panel=b.group(b.fixed,[p.x,p.y,0]);panel.rotation.z=p.angle;
    b.cylinder(panel,'steel',[0,0,1],.065,2);
    b.box(panel,i%2?'cream':'ochre',[spacing*.45,0,1],[Math.min(3,spacing*.9),.1,1.65]);
    b.box(panel,'steel',[spacing*.45,0,1.9],[Math.min(3,spacing*.9),.14,.09]);
  }
}
function excavator(b:ModelBuilder,parent:THREE.Group,x:number,y:number,animated=true){
  const machine=b.group(parent,[x,y,0]);
  for(const side of [-1.2,1.2]){
    b.box(machine,'rubber',[0,side,.55],[4.4,.65,1.1]);
    for(const axle of [-1.5,-.5,.5,1.5]){const wheel=b.cylinder(machine,'steel',[axle,side,.55],.38,.7);wheel.rotation.x=Math.PI/2;}
  }
  b.box(machine,'ochre',[0,0,1.2],[3.5,2.6,.65]);
  b.weld(machine);
  const cabin=b.group(machine,[0,0,1.6]);
  b.box(cabin,'orange',[-.8,0,.55],[2.5,2.3,1.1]);
  b.box(cabin,'glass',[.2,-.7,1.15],[1.4,1.1,1.8]);
  b.box(cabin,'ochre',[.2,-.7,2.1],[1.65,1.3,.18]);
  b.weld(cabin);
  const boom=b.group(cabin,[.8,.45,.4]);
  b.beam(boom,'ochre',[0,0,0],[2.3,0,2.8],.23);
  b.beam(boom,'steel',[.2,-.15,.2],[2,-.15,2.4],.07);
  b.beam(boom,'ochre',[2.3,0,2.8],[4.3,0,.2],.18);
  b.box(boom,'steel',[4.4,0,-.1],[1,1.3,.8]);
  for(const tooth of [-.45,0,.45])b.box(boom,'steel',[4.85,tooth,-.45],[.5,.17,.18]);
  b.weld(boom);
  if(animated)b.motions.push(t=>{cabin.rotation.z=Math.sin(t*.18)*.12;boom.rotation.y=Math.sin(t*.35)*.09;});
  return machine;
}

function constructionSite(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean) {
  boundary(b, attachment);
  const pads = getSceneSiteLayout(attachment), topic = b.event.recipe?.topic ?? '';
  b.root.userData.workZones = pads.length;
  b.root.userData.placement = 'confirmed-site-footprint';
  if (/Подготовка|Котлован/.test(topic) || b.event.excavationConfirmed) {
    const shape = new THREE.Shape(attachment.path.map(point => new THREE.Vector2(...point)));
    shape.holes = (attachment.holes ?? []).map(ring => new THREE.Path(ring.map(point => new THREE.Vector2(...point))));
    const geometry = new THREE.ShapeGeometry(shape); b.owned.push(geometry);
    b.part(b.fixed, geometry, 'soil', [0, 0, 0.025], [1, 1, 1]);
  }
  const cranePad = pads[0]?.clearance >= 8 ? pads[0] : null;
  if (cranePad) crane(b, { ...attachment, height: 8 });
  const stagePad = pads.find(pad => pad.clearance >= 4);
  if (stagePad && /Фундамент|каркаса|перекрытий|Отделка|Ввод объекта|Котлован/.test(topic)) {
    const radius = Math.min(20, stagePad.clearance * 0.7), x = stagePad.x, y = stagePad.y;
    const frame = /каркаса|перекрытий|Отделка|Ввод объекта/.test(topic);
    b.root.userData.constructionStage = topic;
    if (/Котлован/.test(topic)) {
      b.box(b.fixed, 'soil', [x, y, 0.055], [radius * 2, radius * 1.5, 0.11]);
      b.box(b.fixed, 'asphalt', [x, y, 0.13], [radius * 1.75, radius * 1.25, 0.08]);
      for (const side of [-1, 1]) b.box(b.fixed, 'cream', [x, y + side * radius * 0.7, 0.5], [radius * 2, 0.18, 1]);
    } else {
      for (const side of [-1, 1]) {
        b.box(b.fixed, 'cream', [x, y + side * radius * 0.7, 0.5], [radius * 2, 0.55, 1]);
        b.box(b.fixed, 'cream', [x + side * radius, y, 0.5], [0.55, radius * 1.4, 1]);
      }
      for (let at = -radius + 1; at < radius; at += 1.5) b.beam(b.detail, 'steel', [x + at, y - radius * 0.7, 0.9], [x + at, y + radius * 0.7, 0.9], 0.04);
    }
    if (frame) {
      const floors = /перекрытий|Отделка|Ввод/.test(topic) ? 3 : 2;
      for (let floor = 1; floor <= floors; floor++) {
        const z = floor * 3.1;
        for (const px of [-radius, 0, radius]) for (const py of [-radius * 0.7, radius * 0.7]) b.box(b.fixed, 'cream', [x + px, y + py, z - 1.55], [0.4, 0.4, 3.1]);
        for (const side of [-1, 1]) b.box(b.fixed, 'cream', [x, y + side * radius * 0.7, z], [radius * 2 + 0.4, 0.4, 0.35]);
        if (/перекрытий|Отделка|Ввод/.test(topic)) b.box(b.fixed, 'cream', [x, y, z], [radius * 2 + 0.4, radius * 1.4 + 0.4, 0.2]);
      }
    }
  }
  const machines = pads.filter(pad => pad !== cranePad).slice(0, mobile ? 2 : 4);
  for (const [index, pad] of machines.entries()) {
    if (pad.clearance >= 7 && index === 0) {
      excavator(b, b.root, pad.x, pad.y);
      for (const offset of [-3.5, -1, 1.5]) b.ball(b.detail, 'soil', [pad.x + offset, pad.y + 4, 0.7], [1.2, 0.9, 0.85]);
    } else if (pad.clearance >= 4.3 && index < 2) {
      b.vehicle(b.fixed, pad.x, pad.y, 'truck');
    } else {
      const size = Math.min(2, pad.clearance * 0.65);
      for (const z of [0.16, 0.46, 0.76]) for (const y of [-0.4, 0.4]) b.box(b.fixed, 'cream', [pad.x, pad.y + y, z], [size, 0.7, 0.28]);
      for (const x of [-0.5, 0.5]) b.box(b.detail, 'steel', [pad.x + x, pad.y, 0.88], [0.06, 1.6, 0.035]);
    }
  }
  // A land parcel gives no evidence for the height or footprint of a future
  // building. Equipment, fenced perimeter and material bays occupy the site;
  // a construction shell is only attached to an actual building footprint.
}

function buildingWorks(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean) {
  const topic = b.event.recipe?.topic ?? '';
  b.root.userData.constructionStage = topic || 'Строительные работы';
  b.root.userData.spanMetres = Math.round(attachment.length);
  b.root.userData.workZones = attachment.walls.length;
  b.root.userData.placement = 'building-perimeter';
  if (/Заброшенн|Несанкционирован/i.test(topic)) {
    b.root.userData.effect = /Заброшенн/i.test(topic) ? 'abandoned-building' : 'unapproved-building';
    for (const wall of attachment.walls) {
      const count = Math.min(16, Math.ceil(wall.length / 5)), angle = Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
      for (let index = 0; index < count; index++) {
        const x = wall.a[0] + (wall.b[0] - wall.a[0]) * (index + 0.5) / count + wall.outward[0] * 0.16, y = wall.a[1] + (wall.b[1] - wall.a[1]) * (index + 0.5) / count + wall.outward[1] * 0.16;
        const panel = b.group(b.fixed, [x, y, 1.8]); panel.rotation.z = angle;
        b.box(panel, 'soil', [0, 0, 0], [2.1, 0.12, 2.2]); b.beam(panel, 'ochre', [-1, -0.1, -1], [1, -0.1, 1], 0.08); b.beam(panel, 'ochre', [-1, -0.1, 1], [1, -0.1, -1], 0.08);
      }
      const middle = { x: (wall.a[0] + wall.b[0]) / 2 + wall.outward[0] * 3, y: (wall.a[1] + wall.b[1]) / 2 + wall.outward[1] * 3 };
      roadBarrier(b, b.fixed, middle.x, middle.y, angle);
      if (/Заброшенн/i.test(topic)) b.ball(b.detail, 'leaf', [middle.x + wall.outward[0], middle.y + wall.outward[1], 0.7], [1.2, 1.1, 0.8]);
    }
    return;
  }
  if (/кровли|кровл|водосток/i.test(topic)) {
    const shape = new THREE.Shape(attachment.path.map(point => new THREE.Vector2(...point)));
    const roof = new THREE.ShapeGeometry(shape); b.owned.push(roof);
    b.part(b.fixed, roof, 'asphalt', [0, 0, attachment.height + 0.16], [1, 1, 1]);
    for (const wall of attachment.walls) {
      b.beam(b.fixed, 'ochre', [...wall.a, attachment.height + 0.9], [...wall.b, attachment.height + 0.9], 0.055);
      const steps = Math.min(20, Math.ceil(wall.length / 4));
      for (let index = 0; index <= steps; index++) {
        const x = wall.a[0] + (wall.b[0] - wall.a[0]) * index / steps, y = wall.a[1] + (wall.b[1] - wall.a[1]) * index / steps;
        b.beam(b.fixed, 'steel', [x, y, attachment.height], [x, y, attachment.height + 1], 0.045);
      }
    }
    for (const pad of getSceneSiteLayout(attachment).slice(0, mobile ? 2 : 5)) {
      const worker = b.person(b.detail, pad.x, pad.y, 'orange', true); worker.position.z = attachment.height + 0.2;
      b.cylinder(b.detail, 'rubber', [pad.x + 1.2, pad.y, attachment.height + 0.4], 0.3, 0.6);
      b.box(b.detail, 'ochre', [pad.x, pad.y + 1, attachment.height + 0.45], [1.2, 0.7, 0.5]);
    }
    if (/Протечк|водосток/i.test(topic)) for (const wall of attachment.walls.slice(0, mobile ? 2 : 4)) {
      const x = wall.a[0] + wall.outward[0] * 0.4, y = wall.a[1] + wall.outward[1] * 0.4;
      b.beam(b.fixed, 'blue', [x, y, attachment.height], [x, y, 0.35], 0.18);
      b.ball(b.fixed, 'water', [x + wall.outward[0], y + wall.outward[1], 0.08], [1.4, 1, 0.08]);
    }
  } else if (/входной группы|закрытие здания/.test(topic)) {
    const wall = [...attachment.walls].sort((a, b) => b.length - a.length)[0], center: XY = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
    const entrance = b.group(b.fixed, [...center, 0]); entrance.rotation.z = Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
    for (const step of [0, 1, 2]) b.box(entrance, 'cream', [0, -1.1 - step * 0.5, 0.15 + (2 - step) * 0.25], [6, 1.2, 0.3 + (2 - step) * 0.5]);
    for (const side of [-3, 3]) b.beam(entrance, 'steel', [side, -0.8, 1.2], [side, -3, 0.8], 0.065);
    for (const x of [-3.5, 3.5]) b.beam(entrance, 'steel', [x, -2.5, 0], [x, -2.5, 4], 0.09);
    b.box(entrance, 'mesh', [0, -2.5, 2], [7, 0.05, 4]);
    roadBarrier(b, entrance, 0, -4, 0);
  } else {
    scaffold(b, attachment, mobile);
    if (b.event.recipe?.family !== 'renovation') crane(b, attachment);
  }
  crew(b, attachment, mobile);
}

function roadBarrier(b: ModelBuilder, parent: THREE.Group, x: number, y: number, angle: number) {
  const barrier = b.group(parent, [x, y, 0]); barrier.rotation.z = angle;
  for (const side of [-0.9, 0.9]) {
    b.box(barrier, 'rubber', [side, 0, 0.07], [0.55, 0.7, 0.14]);
    b.cylinder(barrier, 'steel', [side, 0, 0.65], 0.055, 1.2);
  }
  b.box(barrier, 'white', [0, 0, 0.9], [2.2, 0.13, 0.36]);
  for (const x of [-0.8, -0.25, 0.3, 0.85]) {
    const stripe = b.box(barrier, 'orange', [x, -0.075, 0.9], [0.24, 0.025, 0.36]); stripe.rotation.y = -0.2;
  }
  b.cylinder(barrier, 'lamp', [-0.9, 0, 1.35], 0.12, 0.18);
}

function paver(b: ModelBuilder, parent: THREE.Group, x: number, y: number) {
  const machine = b.group(parent, [x, y, 0]);
  for (const side of [-1, 1]) b.box(machine, 'rubber', [0, side, 0.4], [3.8, 0.5, 0.75]);
  b.box(machine, 'ochre', [0, 0, 1.1], [4.2, 2.1, 1]);
  b.box(machine, 'asphalt', [2, 0, 1.05], [1.5, 2.5, 0.25]);
  for (const side of [-1.25, 1.25]) b.box(machine, 'ochre', [2, side, 1.4], [1.7, 0.16, 0.9]);
  b.box(machine, 'steel', [-2.4, 0, 0.22], [1.2, 3.2, 0.4]);
  for (const side of [-0.85, 0.85]) b.beam(machine, 'steel', [-0.9, side, 1.5], [-0.9, side, 3.15], 0.055);
  b.box(machine, 'ochre', [-0.4, 0, 3.2], [2.7, 2.6, 0.14]);
  b.box(machine, 'rubber', [-0.7, 0, 1.8], [0.75, 0.75, 0.25]);
  b.cylinder(machine, 'lamp', [-0.4, 0, 3.4], 0.12, 0.2);
  b.weld(machine); return machine;
}

function workingPerson(b: ModelBuilder, parent: THREE.Group, x: number, y: number, animated: boolean, rake = false) {
  const person = b.person(parent, x, y, 'orange', true);
  b.beam(person, 'trunk', [0.55, -0.2, 1.3], [0.85, -0.75, 0.15], 0.035);
  b.box(person, 'steel', [0.85, -0.75, 0.1], rake ? [0.75, 0.15, 0.1] : [0.3, 0.35, 0.07]);
  if (animated) b.motions.push(time => { person.rotation.x = Math.sin(time * 0.85 + x) * 0.06; });
  return person;
}

function streetWorks(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean) {
  const candidateZones = getSceneWorkZones(attachment, mobile);
  const topic = b.event.recipe?.topic ?? '';
  const workMode = /разметк/i.test(topic) ? 'marking' : /бордюр/i.test(topic) ? 'curb' : /ливнев/i.test(topic) ? 'drainage' : /фрезер/i.test(topic) ? 'milling' : 'surface';
  const pavement = workMode === 'surface' || workMode === 'milling';
  b.root.userData.effect = 'road-maintenance';
  b.root.userData.workMode = workMode;
  const sourceScope = b.event.entireStreet ? 'whole-street' : b.event.coverageMode === 'confirmed-source-scope' ? 'confirmed-source-section' : 'unspecified-work-extent';
  // A selected signal without source boundaries is an illustration around its
  // address anchor. Spreading identical equipment over the linked 2 km street
  // makes the scene both misleading and practically invisible.
  const zones = b.event.selected && sourceScope === 'unspecified-work-extent' && candidateZones.length
    ? [candidateZones.reduce((nearest, zone) => {
        const point = along(attachment, zone.center);
        const nearestPoint = along(attachment, nearest.center);
        return Math.hypot(point.x, point.y) < Math.hypot(nearestPoint.x, nearestPoint.y) ? zone : nearest;
      })]
    : candidateZones;
  b.root.userData.workZones = zones.length;
  b.root.userData.workZoneChainages = zones.map(zone => Math.round(zone.center));
  b.root.userData.viewportSpanMetres = attachment.visibleRanges?.reduce((sum, range) => sum + range.end - range.start, 0);
  b.root.userData.spanMetres = Math.round(attachment.length);
  b.root.userData.sourceScope = sourceScope;
  b.root.userData.focusedAtSignal = b.event.selected && sourceScope === 'unspecified-work-extent';
  // These ribbons use the actual road polyline. There are no connectors between
  // separate source sections, and no expansion of an unconfirmed work length.
  let chainage = 0;
  for (const wall of attachment.walls) {
    const angle = Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
    if (!b.event.selected || sourceScope !== 'unspecified-work-extent') for (const side of [-3.1, 3.1]) {
      b.beam(b.fixed, 'ochre', [wall.a[0] + wall.outward[0] * side, wall.a[1] + wall.outward[1] * side, 0.16], [wall.b[0] + wall.outward[0] * side, wall.b[1] + wall.outward[1] * side, 0.16], 0.12);
    }
    const pieces = Math.max(1, Math.ceil(wall.length / Math.max(12, attachment.length / 192)));
    for (let index = 0; index < pieces; index++) {
      const from = chainage + wall.length * index / pieces, to = chainage + wall.length * (index + 1) / pieces;
      const p = along(attachment, (from + to) / 2, 0.2);
      const inWorkZone = zones.some(zone => (from + to) / 2 >= zone.start && (from + to) / 2 <= zone.end);
      if (inWorkZone) for (const side of [-3.1, 3.1]) {
        const edge = along(attachment, (from + to) / 2, side);
        const rail = b.box(b.fixed, 'ochre', [edge.x, edge.y, 0.16], [to - from, 0.28, 0.2]); rail.rotation.z = angle;
      }
      if (pavement) {
        if (inWorkZone) { const strip = b.box(b.fixed, workMode === 'milling' ? 'gravel' : 'asphalt', [p.x, p.y, 0.11], [to - from, 5.8, 0.2]); strip.rotation.z = angle; }
      }
      if (workMode === 'marking') {
        const dash = b.box(b.fixed, 'white', [p.x, p.y, 0.08], [Math.min(3, (to - from) * 0.5), 0.18, 0.045]); dash.rotation.z = angle;
      }
      if (workMode === 'curb') {
        const at = along(attachment, (from + to) / 2, -3.1);
        const shoulder = b.box(b.fixed, 'soil', [at.x, at.y, 0.095], [to - from, 1.1, 0.15]); shoulder.rotation.z = angle;
        const curb = b.box(b.fixed, 'cream', [at.x, at.y, 0.18], [to - from, 0.35, 0.36]); curb.rotation.z = angle;
      }
    }
    chainage += wall.length;
  }
  for (const zone of zones) {
    const coneCount = Math.max(4, Math.ceil((zone.end - zone.start) / 4));
    for (let index = 0; index <= coneCount; index++) for (const side of mobile ? [3.25] : [-3.25, 3.25]) {
      const p = along(attachment, zone.start + (zone.end - zone.start) * index / coneCount, side);
      b.box(b.fixed, 'rubber', [p.x, p.y, 0.05], [0.5, 0.5, 0.1]);
      b.part(b.fixed, b.pool.cone, 'orange', [p.x, p.y, 0.55], [0.3, 0.3, 1.05]);
      b.cylinder(b.fixed, 'white', [p.x, p.y, 0.5], 0.15, 0.13);
    }
  }
  for (const [index, zone] of zones.entries()) {
    for (let distance = zone.start + 3; distance < zone.end - 2; distance += 7) {
      const at = along(attachment, distance, 3.15); roadBarrier(b, b.fixed, at.x, at.y, at.angle);
    }
    for (const distance of [zone.start + 1.5, zone.end - 1.5]) {
      const at = along(attachment, distance, 0.2); roadBarrier(b, b.fixed, at.x, at.y, at.angle + Math.PI / 2);
    }
    const rollerAt = along(attachment, zone.start + (zone.end - zone.start) * 0.28, 0.2);
    if (pavement && zone.end - zone.start >= 10) {
      const animated = index < (mobile ? 1 : 2);
      const roller = b.vehicle(animated ? b.root : b.fixed, rollerAt.x, rollerAt.y, workMode === 'milling' ? 'truck' : 'roller'); roller.rotation.z = rollerAt.angle;
      if (animated) b.motions.push(time => {
        const at = along(attachment, zone.start + (zone.end - zone.start) * 0.28 + Math.sin(time * 0.16 + index) * Math.min(3, (zone.end - zone.start) * 0.09), 0.2);
        roller.position.set(at.x, at.y, 0); roller.rotation.z = at.angle;
      });
    }
    if (workMode === 'surface' && zone.end - zone.start > 22) {
      const at = along(attachment, zone.start + (zone.end - zone.start) * 0.7, 0.2);
      const machine = paver(b, b.fixed, at.x, at.y); machine.rotation.z = at.angle;
    }
    if (!pavement) {
      const at = along(attachment, zone.center, workMode === 'drainage' ? -2.6 : 0.2), work = b.group(b.fixed, [at.x, at.y, 0]); work.rotation.z = at.angle;
      if (workMode === 'curb' || workMode === 'drainage') {
        const delivery = along(attachment, zone.start + (zone.end - zone.start) * 0.28, -0.6);
        const van = b.vehicle(b.fixed, delivery.x, delivery.y, 'van'); van.rotation.z = delivery.angle;
      }
      if (workMode === 'marking') {
        b.box(work, 'ochre', [0, 0, 0.55], [1.6, 0.75, 0.7]);
        b.cylinder(work, 'white', [-0.3, 0, 1.25], 0.32, 0.65);
        for (const x of [-0.6, 0.6]) for (const y of [-0.43, 0.43]) b.ball(work, 'rubber', [x, y, 0.25], [0.25, 0.13, 0.25]);
        b.beam(work, 'steel', [-0.6, 0, 0.8], [-1.3, 0, 1.2], 0.05);
      } else if (workMode === 'drainage') {
        b.box(work, 'steel', [0, 0, 0.08], [2.8, 0.95, 0.15]);
        for (let x = -1.2; x <= 1.2; x += 0.24) b.box(work, 'rubber', [x, 0, 0.17], [0.11, 0.8, 0.04]);
        b.box(work, 'blue', [2.6, 0, 0.55], [1, 0.8, 1]);
        b.beam(work, 'rubber', [2.6, 0, 0.2], [0, 0, 0.18], 0.065);
      } else {
        b.box(work, 'ochre', [0, 0, 0.45], [1, 0.7, 0.85]);
        b.beam(work, 'steel', [-0.35, 0, 0.8], [-0.8, 0, 1.4], 0.045);
      }
    }
    for (let personIndex = 0; personIndex < (mobile ? 2 : 4); personIndex++) {
      const distance = zone.center - 5 + personIndex * 3, at = along(attachment, clamp(distance, zone.start + 3, zone.end - 3), -2.1);
      const animated = index === 0 && personIndex === 0;
      const person = workingPerson(b, animated ? b.root : b.detail, at.x, at.y, animated, true); person.rotation.z = at.angle;
    }
    const supplies = along(attachment, zone.center, -3.3), stack = b.group(b.detail, [supplies.x, supplies.y, 0]); stack.rotation.z = supplies.angle;
    for (const x of [-1, 0, 1]) for (const z of [0.2, 0.6]) b.box(stack, 'cream', [x, 0, z], [0.85, 0.55, 0.35]);
    for (const x of [-2.8, -2]) b.ball(stack, 'gravel', [x, 0, 0.25], [0.6, 0.6, 0.3]);
  }
}

export function getSceneClosureGates(attachment: SceneAttachment) {
  const nodes = new Map<string, { distance: number; point: XY; degree: number; angle: number }>();
  let chainage = 0, anchor = { distance: Infinity, chainage: 0, point: [0, 0] as XY, angle: 0 };
  for (const wall of attachment.walls) {
    const angle = Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
    for (const [point, distance] of [[wall.a, chainage], [wall.b, chainage + wall.length]] as [XY, number][]) {
      const key = point.map(value => Math.round(value * 10)).join(',');
      const node = nodes.get(key); if (node) node.degree++; else nodes.set(key, { point, distance, degree: 1, angle });
    }
    const nearest = nearestOnPath([wall.a, wall.b]);
    if (nearest.distance < anchor.distance) {
      const fraction = nearest.chainage / wall.length;
      anchor = { distance: nearest.distance, chainage: chainage + nearest.chainage, point: [wall.a[0] + (wall.b[0] - wall.a[0]) * fraction, wall.a[1] + (wall.b[1] - wall.a[1]) * fraction], angle };
    }
    chainage += wall.length;
  }
  const visible = (distance: number) => !attachment.visibleRanges?.length || attachment.visibleRanges.some(range => distance >= range.start && distance <= range.end);
  const candidates = [...nodes.values()].filter(node => node.degree !== 2 && visible(node.distance)).sort((a, b) => Math.abs(a.distance - anchor.chainage) - Math.abs(b.distance - anchor.chainage));
  const gates = candidates.slice(0, 3).map(node => ({ distance: node.distance, point: node.point, angle: node.angle }));
  if (visible(anchor.chainage) && (!gates.length || gates.every(gate => Math.abs(gate.distance - anchor.chainage) > 80))) gates.unshift({ distance: anchor.chainage, point: anchor.point, angle: anchor.angle });
  return gates.slice(0, 3);
}

function streetRestriction(b: ModelBuilder, attachment: SceneAttachment, _mobile: boolean) {
  const gates = getSceneClosureGates(attachment);
  b.root.userData.effect = b.event.planned ? 'planned-road-restriction' : 'illustrated-road-restriction';
  b.root.userData.spanMetres = Math.round(attachment.length);
  b.root.userData.workZones = gates.length;
  b.root.userData.workZoneChainages = gates.map(gate => Math.round(gate.distance));
  b.root.userData.sourceScope = b.event.entireStreet ? 'whole-street' : b.event.coverageMode === 'confirmed-source-scope' ? 'confirmed-source-section' : 'unspecified-work-extent';
  b.root.userData.presentation = b.event.planned ? 'planned-object-illustration' : 'source-object-illustration';
  b.root.userData.roadSurface = 'unchanged';
  // A closure changes access, never the asphalt. Only entry / junction control
  // points are illustrated: no painted ribbon, arrows or fences along the road.
  for (const gate of gates) {
    const group = b.group(b.fixed, [...gate.point, 0.08]); group.rotation.z = gate.angle;
    for (const side of [-1.65, 1.65]) {
      roadBarrier(b, group, 0, side, Math.PI / 2);
      b.box(group, 'rubber', [0, side, 0.13], [0.7, 2.8, 0.26]);
    }
    // One recognisable no-entry device belongs to each gate, alongside two
    // bollards. The scene remains quiet between these concrete control points.
    b.cylinder(group, 'steel', [0, -3.7, 1.45], 0.085, 2.9);
    const sign = b.cylinder(group, 'orange', [0, -3.7, 2.65], 0.62, 0.1); sign.rotation.y = Math.PI / 2;
    b.box(group, 'white', [0.065, -3.7, 2.65], [0.025, 0.85, 0.17]);
    for (const x of [-2.3, 2.3]) {
      b.box(group, 'rubber', [x, -3, 0.08], [0.6, 0.6, 0.16]);
      b.part(group, b.pool.cone, 'orange', [x, -3, 0.65], [0.3, 0.3, 1.14]);
      b.cylinder(group, 'white', [x, -3, 0.66], 0.2, 0.16);
    }
  }
}

function roadTopicInfrastructure(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean): boolean {
  const topic = b.event.recipe?.topic ?? '';
  const mode = /Велосипед/i.test(topic) ? 'cycleway' : /светофор/i.test(topic) ? 'traffic-lights' : /пешеходных переход/i.test(topic) ? 'crossing' : /знак/i.test(topic) ? 'road-signs' : /неровност|лежачих/i.test(topic) ? 'speed-table' : /Оплата проезда/i.test(topic) ? 'toll-gate' : /Крупногабарит/i.test(topic) ? 'weighbridge' : /Уборка/i.test(topic) ? 'street-cleanup' : /грунтовых/i.test(topic) ? 'gravel-road' : null;
  if (!mode) return false;
  const zones = getSceneWorkZones(attachment, mobile);
  b.root.userData.effect = 'road-infrastructure:' + mode;
  b.root.userData.workZones = zones.length; b.root.userData.spanMetres = Math.round(attachment.length);
  for (const wall of attachment.walls) {
    const angle = Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
    if (['cycleway', 'gravel-road'].includes(mode)) {
      const at: XY = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
      const surface = b.box(b.fixed, mode === 'cycleway' ? 'leaf' : 'gravel', [...at, 0.12], [wall.length, mode === 'cycleway' ? 2.8 : 5.8, 0.15]); surface.rotation.z = angle;
    }
  }
  for (const zone of zones) {
    const at = along(attachment, zone.center), group = b.group(b.fixed, [at.x, at.y, 0.12]); group.rotation.z = at.angle;
    if (mode === 'cycleway') {
      for (const x of [-1.1, 1.1]) { const wheel = b.cylinder(group, 'white', [x, 0, 0.02], 0.45, 0.06); wheel.rotation.x = 0; }
      b.beam(group, 'white', [-1.1, 0, 0.07], [0, 0.8, 0.07], 0.065); b.beam(group, 'white', [0, 0.8, 0.07], [1.1, 0, 0.07], 0.065); b.beam(group, 'white', [-1.1, 0, 0.07], [0.6, 0, 0.07], 0.065);
      for (const side of [-1.65, 1.65]) b.cylinder(group, 'steel', [0, side, 0.55], 0.1, 1.1);
    } else if (mode === 'traffic-lights') {
      for (const side of [-4, 4]) {
        b.cylinder(group, 'steel', [0, side, 2.8], 0.15, 5.6); b.beam(group, 'steel', [0, side, 5.6], [0, side > 0 ? 0.8 : -0.8, 5.6], 0.12);
        b.box(group, 'rubber', [0, side > 0 ? 0.8 : -0.8, 4.9], [0.55, 0.5, 1.5]);
        for (const [index, color] of (['orange', 'ochre', 'leaf'] as MaterialName[]).entries()) b.ball(group, color, [0.3, side > 0 ? 0.8 : -0.8, 5.4 - index * 0.48], [0.09, 0.18, 0.18]);
      }
    } else if (mode === 'crossing') {
      for (let x = -4; x <= 4; x += 1.15) b.box(group, 'white', [x, 0, 0.06], [0.6, 5.8, 0.055]);
      for (const side of [-4, 4]) { b.box(group, 'cream', [0, side, 0.18], [10, 1.5, 0.35]); b.box(group, 'ochre', [0, side > 0 ? 3.3 : -3.3, 0.38], [8, 0.8, 0.08]); b.person(group, -3, side, 'blue'); }
    } else if (mode === 'road-signs') {
      for (const side of [-3.8, 3.8]) { b.cylinder(group, 'steel', [0, side, 1.9], 0.09, 3.8); b.box(group, 'blue', [0, side, 3.35], [0.12, 1.3, 1.1]); for (const z of [3.15, 3.55]) b.box(group, 'white', [0.07, side, z], [0.025, 0.85, 0.09]); }
    } else if (mode === 'speed-table') {
      b.box(group, 'rubber', [0, 0, 0.13], [1.3, 5.8, 0.22]); for (const y of [-2.4, -1.2, 0, 1.2, 2.4]) b.box(group, 'ochre', [0, y, 0.26], [1.15, 0.55, 0.045]);
    } else if (mode === 'toll-gate' || mode === 'weighbridge') {
      b.box(group, 'steel', [0, 0, 0.12], [9, 5.8, 0.2]);
      for (const side of [-4, 4]) b.box(group, 'cream', [0, side, 1.5], [3, 2, 3]);
      b.box(group, 'ochre', [0, 0, 4.5], [3.2, 10, 0.5]);
      for (const side of [-4.5, 4.5]) b.beam(group, 'steel', [0, side, 0], [0, side, 4.5], 0.18);
      if (mode === 'weighbridge') b.vehicle(group, 0, 0, 'truck'); else roadBarrier(b, group, 1.8, 0, Math.PI / 2);
    } else {
      const truck = b.vehicle(group, 0, 0, mode === 'gravel-road' ? 'roller' : 'van'); truck.rotation.z = 0;
      for (const x of [-7, -5, -3]) b.ball(group, mode === 'gravel-road' ? 'gravel' : 'soil', [x, -2.4, 0.17], [1, 0.5, 0.18]);
      for (const x of [-5, 5]) workingPerson(b, group, x, -2.5, false, true);
    }
  }
  return true;
}
function activityAnchor(b: ModelBuilder, attachment: SceneAttachment, buildingClearance = 1.4) {
  const p = along(attachment, attachment.length * 0.36, attachment.type === 'street' ? 5.4 : attachment.type === 'site' ? -2.3 : buildingClearance);
  const group = b.group(b.root, [p.x, p.y, 0.08]); group.rotation.z = p.angle; return group;
}
function communityActivity(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean) {
  const group = activityAnchor(b, attachment), topic = b.event.topic;
  const helper = b.person(group, -0.7, 0.2, topic === 'health' ? 'white' : 'blue');
  b.motions.push((t) => { helper.rotation.z = Math.sin(t * 0.55) * 0.09; });
  if (b.event.icon === 'accessibility') {
    b.root.userData.effect = 'accessible-assistance';
    const chair = b.group(group, [0.6, 0.1, 0]);
    for (const side of [-0.34, 0.34]) { const wheel = b.cylinder(chair, 'rubber', [0, side, 0.33], 0.32, 0.07); wheel.rotation.x = Math.PI / 2; b.beam(chair, 'steel', [-0.32, side, 0.18], [0.23, side, 0.7], 0.025); }
    b.box(chair, 'blue', [0, 0, 0.56], [0.43, 0.6, 0.08]); b.box(chair, 'blue', [-0.21, 0, 0.84], [0.08, 0.6, 0.5]);
    b.ball(chair, 'skin', [0, 0, 1.29], [0.17, 0.17, 0.19]); b.box(chair, 'cream', [0, 0, 0.98], [0.32, 0.42, 0.4]); b.weld(chair);
  } else if (topic === 'education' || ['school', 'baby', 'graduation-cap', 'book-open', 'notebook-pen'].includes(b.event.icon ?? '')) {
    b.root.userData.effect = 'education-arrival';
    for (let i = 0; i < (mobile ? 1 : 2); i++) { const child = b.person(group, 0.45 + i * 0.8, 0.3, i ? 'cream' : 'blue'); child.scale.multiplyScalar(0.74); b.box(child, 'ochre', [-0.12, -0.39, 1.25], [0.48, 0.22, 0.65]); b.motions.push((t) => { child.position.y = 0.3 + Math.sin(t * 0.75 + i) * 0.12; }); }
  } else if (topic === 'health' || ['hospital', 'heart-pulse', 'ambulance', 'pill', 'syringe'].includes(b.event.icon ?? '')) {
    b.root.userData.effect = 'medical-assistance';
    b.box(group, 'blue', [0.25, 0, 0.25], [0.54, 0.34, 0.45]); b.box(group, 'white', [0.25, -0.18, 0.25], [0.1, 0.025, 0.27]); b.box(group, 'white', [0.25, -0.18, 0.25], [0.29, 0.025, 0.1]);
    if (!mobile) b.person(group, 1.1, 0.35, 'cream');
  } else if (b.event.kind === 'culture') {
    b.root.userData.effect = 'culture-meeting';
    b.person(group, 0.65, 0.2, 'cream'); b.cylinder(group, 'steel', [1.35, 0.5, 0.85], 0.025, 1.7); b.box(group, 'blue', [1.55, 0.5, 1.5], [0.4, 0.025, 0.25]);
  } else if (b.event.kind === 'investment') {
    b.root.userData.effect = 'business-meeting';
    b.person(group, 0.65, 0.2, 'cream'); b.box(group, 'steel', [0.95, 0.2, 0.57], [0.34, 0.14, 0.27]);
  } else {
    b.root.userData.effect = 'social-assistance';
    b.person(group, 0.65, 0.2, 'cream'); b.box(group, 'white', [0, 0, 0.97], [0.28, 0.18, 0.025]); b.box(group, 'blue', [0, 0, 0.99], [0.23, 0.025, 0.015]);
  }
}
function utilityActivity(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean) {
  const heat = ['heater', 'flame'].includes(b.event.icon ?? '') || b.event.recipe?.family === 'heating';
  const power = ['zap', 'lamp-desk'].includes(b.event.icon ?? '') || ['electricity', 'lighting'].includes(b.event.recipe?.family ?? '');
  const pipeMaterial: MaterialName = power ? 'rubber' : heat ? 'ochre' : 'blue';
  const clearance = attachment.type === 'site' ? -2.4 : 2.4;
  // Coverage follows every facade / supplied line. This communicates the
  // linked affected object; it does not purport to be a surveyed pipe route.
  for (const wall of attachment.walls) {
    const a: XYZ = [wall.a[0] + wall.outward[0] * clearance, wall.a[1] + wall.outward[1] * clearance, 0.45];
    const z: XYZ = [wall.b[0] + wall.outward[0] * clearance, wall.b[1] + wall.outward[1] * clearance, 0.45];
    b.beam(b.fixed, pipeMaterial, a, z, power ? 0.12 : 0.24);
    const supports = Math.min(24, Math.max(1, Math.ceil(wall.length / 6)));
    for (let index = 0; index <= supports; index++) {
      const t = index / supports;
      b.box(b.fixed, 'cream', [a[0] + (z[0] - a[0]) * t, a[1] + (z[1] - a[1]) * t, 0.15], [0.65, 0.65, 0.3]);
    }
  }
  const candidates = attachment.walls.flatMap(wall => {
    const count = Math.max(1, Math.ceil(wall.length / 55));
    return Array.from({ length: count }, (_, index): SceneWall => {
      const a: XY = [wall.a[0] + (wall.b[0] - wall.a[0]) * index / count, wall.a[1] + (wall.b[1] - wall.a[1]) * index / count];
      const z: XY = [wall.a[0] + (wall.b[0] - wall.a[0]) * (index + 1) / count, wall.a[1] + (wall.b[1] - wall.a[1]) * (index + 1) / count];
      return { ...wall, a, b: z, length: wall.length / count };
    });
  }).filter(wall => wall.length >= 7);
  const budget = mobile ? 4 : 10;
  const bays = candidates.length <= budget ? candidates : Array.from({ length: budget }, (_, index) => candidates[Math.floor((index + 0.5) * candidates.length / budget)]);
  for (const [index, wall] of bays.entries()) utilityBay(b, attachment, mobile, wall, index < (mobile ? 1 : 2));
  b.root.userData.spanMetres = Math.round(attachment.length);
  b.root.userData.workZones = bays.length;
  b.root.userData.placement = attachment.type === 'building' ? 'building-perimeter' : 'whole-linked-utility-object';
  utilitySubject(b, attachment);
}

function utilitySubject(b: ModelBuilder, attachment: SceneAttachment) {
  const family = b.event.recipe?.family, topic = b.event.recipe?.topic ?? '';
  if (!family) return;
  const wall = [...attachment.walls].sort((a, b) => b.length - a.length)[0];
  const point = attachment.type === 'building' ? { x: (wall.a[0] + wall.b[0]) / 2 + wall.outward[0] * 10, y: (wall.a[1] + wall.b[1]) / 2 + wall.outward[1] * 10, angle: Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]) } : { x: 0, y: 0, angle: 0 };
  const group = b.group(b.fixed, [point.x, point.y, 0.12]); group.rotation.z = point.angle;
  b.root.userData.utilityVariant = topic;
  if (family === 'water') {
    if (/люки|колонки|колодц/i.test(topic)) {
      const well = /колонки|колодц/i.test(topic);
      b.cylinder(group, 'cream', [0, 0, 0.55], well ? 1.8 : 1.4, 1.1);
      b.cylinder(group, 'asphalt', [0, 0, 1.12], well ? 1.5 : 1.1, 0.08);
      if (well) { b.beam(group, 'blue', [0, 0, 0.7], [0, 0, 2.6], 0.18); b.beam(group, 'blue', [0, 0, 2.6], [1, 0, 2.6], 0.18); b.beam(group, 'steel', [-0.4, 0, 2], [0.4, 0, 2], 0.07); }
      else { const lid = b.cylinder(group, 'steel', [2.4, 0, 0.12], 1.25, 0.16); lid.rotation.y = 0.14; for (let x = -0.8; x <= 0.8; x += 0.25) b.box(group, 'steel', [x, 0, 1.2], [0.07, 1.8, 0.08]); }
    } else if (/качеств|температур|давлен|Отсутствие/i.test(topic)) {
      const dirty = /качеств/i.test(topic), absent = /Отсутствие/i.test(topic);
      for (const x of [-2.5, 2.5]) {
        b.cylinder(group, 'cream', [x, 0, 0.18], 1.65, 0.35);
        b.cylinder(group, 'mesh', [x, 0, 1.5], 1.5, 2.7);
        if (!absent) b.cylinder(group, dirty && x > 0 ? 'soil' : 'water', [x, 0, dirty ? 1 : 0.5], 1.37, dirty ? 1.6 : 0.6);
        b.beam(group, 'blue', [x, 0, 0.5], [x, -2.5, 0.5], 0.22);
      }
      b.cylinder(group, 'steel', [0, -1, 2], 0.7, 0.16).rotation.x = Math.PI / 2;
      b.beam(group, absent ? 'orange' : 'blue', [0, -1.12, 2], [0.35, -1.12, 1.7], 0.06);
      if (absent) roadBarrier(b, group, 0, -3.5, 0);
    } else if (/водоотведен|засор|Канализац/i.test(topic)) {
      for (const x of [-3, 0, 3]) { b.cylinder(group, 'cream', [x, 0, 0.8], 1.3, 1.6); b.cylinder(group, 'soil', [x, 0, 1.62], 1.05, 0.04); }
      b.beam(group, 'steel', [-5, 0, 0.5], [5, 0, 0.5], 0.38);
      for (const x of [-3, 3]) b.box(group, 'steel', [x, 0, 1.8], [2.8, 0.12, 0.16]);
    } else {
      for (const x of [-2.8, 2.8]) {
        b.box(group, 'blue', [x, 0, 0.85], [2.6, 1.7, 1.6]);
        b.cylinder(group, 'steel', [x, 0, 1.9], 0.65, 0.5);
        b.beam(group, 'blue', [x, -0.8, 0.55], [x, -3, 0.55], 0.32);
      }
      b.beam(group, 'steel', [-4.5, 2, 0.65], [4.5, 2, 0.65], 0.4);
      if (/Прорыв|Аварии/i.test(topic)) b.ball(group, 'water', [0, -2, 0.17], [3.8, 2, 0.15]);
      if (/Откачк/i.test(topic)) { b.ball(group, 'water', [0, -3, 0.12], [4.2, 2, 0.1]); b.beam(group, 'rubber', [-2.8, -0.8, 0.55], [0, -3, 0.2], 0.15); }
    }
  } else if (family === 'heating') {
    for (const x of [-2.3, 2.3]) { b.box(group, 'steel', [x, 0, 1.5], [2.8, 2, 3]); for (let offset = -1.2; offset <= 1.2; offset += 0.25) b.box(group, 'cream', [x + offset, -1.05, 1.5], [0.12, 0.15, 2.6]); }
    for (const [y, color] of [[-2, 'orange'], [2, 'blue']] as const) b.beam(group, color, [-5, y, 0.75], [5, y, 0.75], 0.25);
  } else if (family === 'electricity' && /топлив|уголь|брикеты/i.test(topic)) {
    for (const x of [-3.5, 0, 3.5]) { b.box(group, 'steel', [x, 0, 0.8], [3, 3, 1.6]); if (!/Нехватк/i.test(topic) || x < 0) for (const y of [-0.8, 0, 0.8]) b.ball(group, 'rubber', [x, y, 1.7], [1, 0.7, 0.5]); }
    if (/доставк/i.test(topic)) b.vehicle(group, 0, 5, 'truck');
  } else if (family === 'electricity') {
    for (const x of [-3, 3]) { b.box(group, 'steel', [x, 0, 1.65], [3, 2.6, 3.3]); for (let y = -1; y <= 1; y += 0.3) b.box(group, 'cream', [x + 1.55, y, 1.7], [0.13, 0.12, 2.6]); for (const y of [-0.7, 0.7]) { b.cylinder(group, 'cream', [x, y, 3.75], 0.16, 0.8); b.beam(group, 'steel', [x, y, 4.2], [0, y, 5.2], 0.04); } }
    for (const y of [-1, 1]) b.beam(group, 'steel', [-5, y, 5.5], [5, y, 5.5], 0.04);
  } else if (family === 'gas') {
    b.box(group, 'ochre', [0, 0, 1.65], [4.4, 2.8, 3.3]);
    for (const x of [-4, 4]) { b.beam(group, 'ochre', [x, 0, 0.5], [x, 0, 2.2], 0.25); b.beam(group, 'ochre', [x, 0, 2.2], [x < 0 ? -2.3 : 2.3, 0, 2.2], 0.25); b.cylinder(group, 'orange', [x, 0, 2.5], 0.4, 0.1); }
    for (let x = -1.7; x <= 1.7; x += 0.3) b.box(group, 'steel', [x, -1.43, 1.5], [0.12, 0.04, 1.7]);
  }
}

function utilityBay(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean, wall: SceneWall, dynamic: boolean) {
  const heat = ['heater', 'flame'].includes(b.event.icon ?? '') || b.event.recipe?.family === 'heating';
  const power = ['zap', 'lamp-desk'].includes(b.event.icon ?? '') || ['electricity', 'lighting'].includes(b.event.recipe?.family ?? '');
  const water = ['droplets', 'waves'].includes(b.event.icon ?? '') || b.event.recipe?.family === 'water';
  const span = clamp(wall.length * 0.85, 6, 44);
  const p = {
    x: (wall.a[0] + wall.b[0]) / 2 + wall.outward[0] * (attachment.type === 'site' ? -4.5 : 6.5),
    y: (wall.a[1] + wall.b[1]) / 2 + wall.outward[1] * (attachment.type === 'site' ? -4.5 : 6.5),
    angle: Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]),
  };
  const group = b.group(dynamic ? b.root : b.fixed, [p.x, p.y, 0.08]); group.rotation.z = p.angle;
  const fixed = b.group(b.fixed, [p.x, p.y, 0.08]); fixed.rotation.z = p.angle;
  const detail = b.group(b.detail, [p.x, p.y, 0.08]); detail.rotation.z = p.angle;
  b.root.userData.effect = power ? 'power-maintenance' : heat ? 'heating-maintenance' : water ? 'water-maintenance' : 'utility-inspection';
  b.root.userData.placement = attachment.type === 'building' ? 'facade-service-bay' : 'source-service-bay';
  b.root.userData.excavation = Boolean((water || heat) && b.event.excavationConfirmed);
  b.root.userData.spanMetres = Math.round(span);
  const truck = b.vehicle(fixed, span * 0.28, 3.25, 'van'); truck.rotation.z = 0;
  for (const x of [-span / 2, span / 2]) roadBarrier(b, fixed, x, 0, Math.PI / 2);
  for (let x = -span / 2 + 2; x < span / 2; x += 3) {
    b.box(fixed, 'rubber', [x, -2, 0.06], [0.5, 0.5, 0.12]);
    b.part(fixed, b.pool.cone, 'orange', [x, -2, 0.48], [0.24, 0.24, 0.85]);
    b.cylinder(fixed, 'white', [x, -2, 0.55], 0.15, 0.12);
  }
  b.box(fixed, 'steel', [-span * 0.3, 2.6, 0.45], [1.8, 1, 0.9]);
  b.box(fixed, 'rubber', [-span * 0.3, 2.6, 0.95], [1.9, 1.1, 0.12]);
  for (const x of [-span * 0.3 - 0.6, -span * 0.3 + 0.6]) b.box(detail, 'ochre', [x, 2.08, 0.5], [0.12, 0.05, 0.25]);
  if (power) {
    b.box(fixed, 'steel', [0, 0, 1.05], [1.2, 0.75, 2.1]);
    b.box(fixed, 'ochre', [0, -0.39, 1.4], [0.4, 0.03, 0.45]);
    for (const x of [-0.3, 0, 0.3]) b.box(detail, 'blue', [x, -0.395, 0.7], [0.11, 0.03, 0.22]);
    b.beam(fixed, 'rubber', [0.4, 0, 0.1], [3.5, 0.7, 0.12], 0.065);
    const spool = b.cylinder(fixed, 'ochre', [-3, 0, 0.85], 0.85, 0.6); spool.rotation.x = Math.PI / 2;
  } else if (water || heat) {
    const color: MaterialName = heat ? 'ochre' : 'blue';
    if (b.event.excavationConfirmed) {
      // The title/evidence must explicitly describe excavation. This is a
      // bounded work bay at that address, never a claimed surveyed pipe route.
      const trenchLength = Math.max(4, span - 4);
      b.box(fixed, 'soil', [0, 0, 0.035], [trenchLength, 1.8, 0.07]);
      b.box(fixed, 'asphalt', [0, 0, 0.08], [trenchLength - 0.25, 1.3, 0.05]);
      for (let x = -trenchLength / 2 + 1; x < trenchLength / 2; x += 2.4) {
        b.ball(detail, 'soil', [x, 1.6, 0.4], [1, 0.6, 0.5]);
        b.box(detail, 'cream', [x, -0.77, 0.35], [1.8, 0.12, 0.65]);
      }
      b.beam(fixed, color, [-trenchLength / 2 + 0.5, 0, 0.22], [trenchLength / 2 - 0.5, 0, 0.22], 0.23);
      const crossing = b.box(detail, 'steel', [-trenchLength * 0.25, 0, 0.4], [1, 2.7, 0.09]); crossing.rotation.z = 0;
    } else {
      for (const x of [-span * 0.28, span * 0.05]) {
        b.beam(fixed, color, [x - 2.1, 0, 0.45], [x + 2.1, 0, 0.45], heat ? 0.23 : 0.28);
        for (const side of [-1.65, 1.65]) {
          const flange = b.cylinder(fixed, 'steel', [x + side, 0, 0.45], 0.38, 0.14); flange.rotation.y = Math.PI / 2;
          b.box(fixed, 'cream', [x + side, 0, 0.14], [0.5, 0.9, 0.28]);
        }
      }
    }
    b.beam(fixed, 'steel', [0, 0, 0.25], [0, 0, 0.9], 0.07);
    const valve = b.group(group, [0, 0, 0.9]);
    for (const angle of [0, Math.PI / 2]) {
      const handle = b.box(valve, color, [0, 0, 0], [0.8, 0.09, 0.09]); handle.rotation.z = angle;
    }
    b.weld(valve); if (dynamic) b.motions.push(time => { valve.rotation.z = Math.sin(time * 0.25) * 0.22; });
    b.box(fixed, 'blue', [-span * 0.28, -1.15, 0.5], [1.1, 0.8, 1]);
    b.beam(fixed, 'rubber', [-span * 0.28, -1.15, 0.25], [0, 0, 0.2], 0.07);
    for (const x of [-1.4, 0, 1.4]) {
      const pipe = b.cylinder(detail, color, [x + span * 0.22, 1.7, 0.35], 0.25, 1.2); pipe.rotation.y = Math.PI / 2;
    }
  } else b.box(fixed, 'steel', [0.2, 0, 0.3], [0.75, 0.5, 0.6]);
  const lead = workingPerson(b, group, -1.6, -0.9, dynamic); lead.rotation.z = Math.PI;
  for (let index = 0; index < (mobile ? 1 : 3); index++) b.person(detail, -span * 0.34 + index * span * 0.28, 1.25, index % 2 ? 'blue' : 'orange', true);
}
function landscapeActivity(b: ModelBuilder, attachment: SceneAttachment) {
  const group = activityAnchor(b, attachment), cleanup = ['trash-2', 'recycle'].includes(b.event.icon ?? '');
  b.root.userData.effect = cleanup ? 'landscape-cleanup' : 'garden-care';
  b.person(group, -0.8, 0.2, 'leaf');
  if (cleanup) { b.cylinder(group, 'edge', [0.6, 0.1, 0.38], 0.28, 0.75); b.ball(group, 'rubber', [0.8, 0.55, 0.22], [0.23, 0.22, 0.26]); }
  else { b.tree(group, 0.9, 0.2, 0.25); b.cylinder(group, 'blue', [-0.15, -0.4, 0.18], 0.15, 0.3); b.beam(group, 'blue', [-0.15, -0.4, 0.18], [0.2, -0.4, 0.35], 0.045); }
}

function statusMarker(b: ModelBuilder, attachment: SceneAttachment, effect: string, material: MaterialName = 'blue', recordEffect = true) {
  if (recordEffect) b.root.userData.effect = effect;
  const group = activityAnchor(b, attachment);
  b.cylinder(group, 'steel', [0, 0, 0.85], 0.07, 1.7);
  b.box(group, material, [0, 0, 1.62], [1.25, 0.12, 0.72]);
  if(b.event.recipe){const face=new THREE.Mesh(b.pool.box,b.pool.sign(b.event.recipe.icon));face.position.set(0,-0.075,1.62);face.scale.set(.6,.018,.6);group.add(face);}
  else b.box(group, 'white', [0, -0.07, 1.62], [0.62, 0.025, 0.1]);
}

/**
 * Status is a separate visual truth from the subject of a publication.
 * A planned school and a planned pipe both use the planned scene; machinery is
 * reserved for fresh, source-backed `in_progress` activity below.
 */
function statusScene(b: ModelBuilder, attachment: SceneAttachment) {
  // Direct low-level callers may hand us an unverified event.  The public
  // mapper never does that; keep the hard guard here as a second boundary.
  if (!b.event.display && !b.event.live) return;
  const state = b.event.display === 'archive' ? 'archive' : b.event.planned ? 'planned' : b.event.state ?? b.event.live?.state ?? 'unknown';
  // A traffic restriction already is the physical status representation: its
  // sparse gates must not acquire an extra slab that can read as roadworks.
  if (b.event.recipe?.family === 'traffic') {
    b.root.userData.statusEffect = state === 'planned' ? 'status-planned' : `status-${state}`;
    return;
  }
  const group = activityAnchor(b, attachment);
  const marker = (effect: string, material: MaterialName) => {
    b.root.userData.statusEffect = effect;
    // A compact status token supplements the topic scene.  It cannot become
    // a fake worksite, replace a building, or read as a full road surface.
    b.cylinder(group, material, [0, 0, .12], .48, .12);
    return group;
  };
  if (state === 'reported') {
    marker('status-reported', 'blue');
    b.box(group, 'blue', [0, 0, .38], [.28, .12, .34]);
  } else if (state === 'planned') {
    marker('status-planned', 'blueprint');
    b.box(group, 'blueprint', [0, 0, .25], [.66, .46, .04]);
    b.beam(group, 'white', [-.2, -.13, .29], [.2, .13, .29], .02);
  } else if (state === 'in_progress') {
    marker('status-in-progress', 'leaf');
    b.cylinder(group, 'leaf', [0, 0, .31], .2, .28);
  } else if (state === 'paused') {
    marker('status-paused', 'ochre');
    b.box(group, 'ochre', [0, 0, .31], [.54, .1, .1]);
  } else if (state === 'resolved') {
    marker('status-resolved', 'leaf');
    b.ball(group, 'leaf', [0, 0, .34], [.3, .3, .3]);
  } else if (state === 'cancelled' || state === 'archive') {
    marker(state === 'cancelled' ? 'status-cancelled' : 'status-archive', 'edge');
    const strike = b.box(group, 'edge', [0, -.11, .32], [.64, .04, .08]);
    strike.rotation.z = -.42;
  } else {
    marker('status-unknown', 'steel');
    b.cylinder(group, 'steel', [0, 0, .3], .18, .26);
  }
}

function roadDefect(b: ModelBuilder, attachment: SceneAttachment) {
  b.root.userData.effect = 'reported-road-defect';
  if(!b.event.defectPositionConfirmed){for(const wall of attachment.walls)b.beam(b.fixed,'ochre',[...wall.a,.09],[...wall.b,.09],.1);b.root.userData.placement='whole-road-section';return;}
  for (const [distance, outset, radius] of [[0.42, 0, 0.72], [0.53, 0.5, 0.4], [0.34, -0.4, 0.3]] as const) {
    const p = along(attachment, attachment.length * distance, outset);
    b.cylinder(b.fixed, 'rubber', [p.x, p.y, 0.025], radius, 0.05);
    b.cylinder(b.detail, 'soil', [p.x, p.y, 0.045], radius * 0.6, 0.025);
  }
}

function utilityFault(b: ModelBuilder, attachment: SceneAttachment) {
  b.root.userData.effect = 'reported-utility-fault';
  b.root.userData.placement = attachment.type === 'building' ? 'building-perimeter' : 'linked-utility-object';
  // The source confirms work at the linked object but does not locate an
  // excavation. Show a legible perimeter service scene without inventing a
  // trench or a precise defect point.
  const walls = attachment.walls.slice(0, attachment.type === 'building' ? 12 : 8);
  for (const [index, wall] of walls.entries()) {
    const outset = attachment.type === 'building' ? 3.2 : 1.8;
    const a:[number,number,number]=[wall.a[0]+wall.outward[0]*outset,wall.a[1]+wall.outward[1]*outset,.2];
    const z:[number,number,number]=[wall.b[0]+wall.outward[0]*outset,wall.b[1]+wall.outward[1]*outset,.2];
    b.beam(b.fixed, 'blue', a, z, .12);
    if(index%2===0){
      const x=(a[0]+z[0])/2,y=(a[1]+z[1])/2,angle=Math.atan2(z[1]-a[1],z[0]-a[0]);
      const bay=b.group(b.fixed,[x,y,0]);bay.rotation.z=angle;
      b.box(bay,'steel',[0,0,.65],[2.4,.9,1.3]);
      b.cylinder(bay,'blue',[-.72,-.52,.34],.24,.68);
      b.cylinder(bay,'blue',[.72,-.52,.34],.24,.68);
      b.box(bay,'orange',[0,-.62,1.55],[1.8,.12,.52]);
    }
  }
  const crew = activityAnchor(b, attachment, attachment.type === 'building' ? 5.2 : 2.4);
  b.vehicle(crew, -2.8, 0, 'van');
  workingPerson(b, crew, 1.2, -.7, false);
  workingPerson(b, crew, 3.1, .8, false);
  for(const x of [-4.8,4.8]) b.cylinder(crew,'orange',[x,0,.35],.28,.7);
}

function wasteMarker(b: ModelBuilder, attachment: SceneAttachment) {
  b.root.userData.effect = 'reported-waste';
  const group = activityAnchor(b, attachment);
  b.cylinder(group, 'edge', [0, 0, 0.43], 0.34, 0.86);
  b.ball(group, 'rubber', [0.62, 0.15, 0.22], [0.32, 0.28, 0.26]);
  b.ball(group, 'soil', [-0.55, 0.25, 0.18], [0.26, 0.24, 0.2]);
}

function surfaceHazard(b: ModelBuilder, attachment: SceneAttachment, kind: 'flood' | 'snow_ice') {
  b.root.userData.effect = kind === 'flood' ? 'reported-flood' : 'reported-snow-ice';
  const material: MaterialName = kind === 'flood' ? 'water' : 'white';
  for (const [distance, outset, radius] of [[0.35, 0, 1], [0.5, 0.7, 0.7], [0.62, -0.5, 0.55]] as const) {
    const p = along(attachment, attachment.length * distance, outset);
    b.cylinder(b.fixed, material, [p.x, p.y, 0.035], radius, 0.07);
  }
}

function hazardMarker(b: ModelBuilder, attachment: SceneAttachment, kind: 'emergency' | 'fire', active: boolean) {
  b.root.userData.effect = kind === 'fire' ? 'reported-fire' : 'reported-emergency';
  const group = activityAnchor(b, attachment);
  b.cylinder(group, 'steel', [0, 0, 0.65], 0.08, 1.3);
  const beacon = b.ball(group, kind === 'fire' ? 'orange' : 'lamp', [0, 0, 1.45], [0.38, 0.38, 0.45]);
  b.box(group, 'steel', [0, 0, 1.12], [0.65, 0.65, 0.12]);
  if (active) b.motions.push((time) => beacon.scale.setScalar(0.92 + Math.sin(time * 2.2) * 0.08));
}

function staticScene(b: ModelBuilder, attachment: SceneAttachment, kind: SceneKind) {
  if (kind === 'road_defect') roadDefect(b, attachment);
  else if (kind === 'utility_fault') utilityFault(b, attachment);
  else if (kind === 'waste') wasteMarker(b, attachment);
  else if (kind === 'flood' || kind === 'snow_ice') surfaceHazard(b, attachment, kind);
  else if (kind === 'emergency' || kind === 'fire') hazardMarker(b, attachment, kind, false);
  else if (kind === 'paused') statusMarker(b, attachment, 'activity-paused', 'ochre');
  else if (kind === 'completed') statusMarker(b, attachment, 'activity-completed', 'leaf');
  else if (kind === 'construction' && b.event.planned) statusMarker(b, attachment, 'planned-construction', 'blueprint');
  else statusMarker(b, attachment, kind === 'place_event' ? 'place-event' : 'reported-place');
}

function catalogEquipment(b: ModelBuilder, attachment: SceneAttachment) {
  const family = b.event.recipe?.family;
  if (!['gas', 'trees', 'waste'].includes(family ?? '')) return;
  const group = activityAnchor(b, attachment);
  if (family === 'gas') {
    for (const x of [-0.8, 0.8]) {
      b.beam(group, 'ochre', [x, -1, 0.5], [x, 1, 0.5], 0.16);
      b.cylinder(group, 'steel', [x, 0, 0.85], 0.25, 0.1);
    }
    b.box(group, 'steel', [1.7, 0, 0.6], [0.7, 0.7, 1.2]);
  } else if (family === 'trees') {
    b.tree(group, 1, 1, 0.45); b.person(group, -1, 0, 'orange', true);
  } else {
    for (const x of [-1.2, 0, 1.2]) {
      b.box(group, 'leaf', [x, 0, 0.6], [0.85, 0.8, 1.2]);
      b.box(group, 'steel', [x, 0, 1.25], [0.95, 0.9, 0.12]);
    }
  }
}

function buildPhysicalStory(b: ModelBuilder, attachment: SceneAttachment, mobile: boolean): boolean {
  const family = b.event.recipe?.family;
  if (!family || !['construction', 'renovation', 'roads', 'water', 'heating', 'electricity', 'gas', 'bridge', 'traffic'].includes(family)) return false;
  const topic = b.event.recipe?.topic ?? '';
  b.root.userData.storyFamily = family;
  b.root.userData.storyTopic = topic;
  b.root.userData.spanMetres = Math.round(attachment.length);
  if (family === 'construction' || family === 'renovation') {
    b.root.userData.effect = 'construction-stage-illustration';
    if (attachment.type === 'building') buildingWorks(b, attachment, mobile);
    else { constructionSite(b, attachment, mobile); crew(b, attachment, mobile); }
  } else if (family === 'traffic') {
    if (attachment.type === 'street') streetRestriction(b, attachment, mobile);
  } else if (family === 'bridge') {
    if (attachment.type !== 'street') return false;
    b.root.userData.effect = 'bridge-span-illustration';
    const zones = getSceneWorkZones(attachment, mobile); b.root.userData.workZones = zones.length;
    for (const wall of attachment.walls) {
      const angle = Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
      const deck = b.box(b.fixed, 'steel', [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2, 0.18], [wall.length, 6.4, 0.35]); deck.rotation.z = angle;
      for (const side of [-3.15, 3.15]) b.beam(b.fixed, 'cream', [wall.a[0] + wall.outward[0] * side, wall.a[1] + wall.outward[1] * side, 1.2], [wall.b[0] + wall.outward[0] * side, wall.b[1] + wall.outward[1] * side, 1.2], 0.11);
    }
    for (const zone of zones) {
      for (let distance = zone.start + 1; distance < zone.end; distance += 3) {
        for (const side of [-3.15, 3.15]) { const at = along(attachment, distance, side); b.beam(b.fixed, 'steel', [at.x, at.y, 0.2], [at.x, at.y, 1.3], 0.065); }
      }
      const at = along(attachment, zone.center), work = b.group(b.fixed, [at.x, at.y, 0.4]); work.rotation.z = at.angle;
      if (!/Восстановление движения/.test(topic) && b.event.display !== 'completed') { b.vehicle(work, 0, 0, 'van'); roadBarrier(b, work, -7, 0, Math.PI / 2); for (const x of [-4, 4]) workingPerson(b, work, x, -2, false); }
      else { for (const x of [-6, 0, 6]) b.box(work, 'white', [x, 0, 0.04], [3, 0.16, 0.05]); }
    }
  } else if (family === 'roads') {
    if (attachment.type !== 'street') return false;
    if (!roadTopicInfrastructure(b, attachment, mobile)) {
      if (b.event.planned || /ограждений/.test(topic)) streetRestriction(b, attachment, mobile);
      else streetWorks(b, attachment, mobile);
    }
  } else {
    utilityActivity(b, attachment, mobile);
  }
  return true;
}

function createModel(pool: Resources, event: EventScene, attachment: SceneAttachment, mobile: boolean): Model {
  const builder = new ModelBuilder(pool, event, attachment);
  const active = (event.display ?? 'active') === 'active' && isCurrentSceneActivity(event, Date.now());
  const illustratedWork = !active && event.lastKnownWork && event.display !== 'completed' && event.live?.state !== 'cancelled' && !event.planned;
  builder.root.userData.coverageMode = event.coverageMode ?? (event.entireStreet || attachment.type === 'site' ? 'confirmed-source-scope' : 'linked-object-illustration');
  builder.root.userData.presentation = active ? 'current-activity' : illustratedWork ? 'last-known-stage-illustration' : event.display;
  if (event.recipe && (active || event.display || event.live)) {
    if (buildTopicStory(builder, attachment)) { if (!active) statusScene(builder, attachment); return builder.finish(active); }
    if (buildPhysicalStory(builder, attachment, mobile)) { if (!active) statusScene(builder, attachment); return builder.finish(active); }
  }
  const roadIllustration = attachment.type === 'street' && (['roads', 'traffic', 'bridge'].includes(event.recipe?.family ?? '') || ['roads', 'road_repair'].includes(event.kind));
  if (roadIllustration && (event.planned || event.recipe?.family === 'traffic' || !active && !illustratedWork && Boolean(event.display))) {
    streetRestriction(builder, attachment, mobile);
    if (!active) statusScene(builder, attachment);
    return builder.finish(false);
  }
  if (!active && !illustratedWork) {
    if (event.display || event.live) staticScene(builder, attachment, event.kind);
    statusScene(builder, attachment);
    return builder.finish();
  }
  catalogEquipment(builder,attachment);
  // Only an explicit, current activity kind chooses equipment. Location only supplies placement and scale.
  const workKind = illustratedWork && ['paused', 'generic'].includes(event.kind) ? event.activityKind : event.kind;
  if (workKind === 'construction') {
    builder.root.userData.effect = 'verified-construction';
    if (attachment.type === 'building') buildingWorks(builder, attachment, mobile);
    else if (attachment.type === 'site') { constructionSite(builder, attachment, mobile); crew(builder, attachment, mobile); }
  } else if (workKind === 'road_repair' || workKind === 'roads') {
    if (attachment.type === 'street') streetWorks(builder, attachment, mobile);
  } else if (workKind === 'utility_repair' || workKind === 'utilities') utilityActivity(builder, attachment, mobile);
  else if (event.kind === 'cleanup' || event.kind === 'landscaping') landscapeActivity(builder, attachment);
  else if (event.kind === 'emergency' || event.kind === 'fire') hazardMarker(builder, attachment, event.kind, true);
  else if (['social', 'investment', 'culture'].includes(event.kind)) communityActivity(builder, attachment, mobile);
  else staticScene(builder, attachment, event.kind);
  return builder.finish(active);
}

type Entry = { event: EventScene; signature: string; sourceSignature: string; attachment: SceneAttachment; model: Model; scene: THREE.Scene; sky: THREE.HemisphereLight; sun: THREE.DirectionalLight; fill: THREE.DirectionalLight; coordinate: MercatorCoordinate; projection: THREE.Matrix4 | null; phase: number };

/** Footprint-bound accessories in fixed metres; the existing map supplies the actual buildings. */
export class SignalSceneLayer implements CustomLayerInterface {
  readonly id = 'atlas-signal-scenes'; readonly type = 'custom' as const; readonly renderingMode = '3d' as const;
  private map: LibreMap | null = null; private renderer: THREE.WebGLRenderer | null = null;
  private readonly camera = new THREE.Camera(); private readonly raycaster = new THREE.Raycaster();
  private readonly entries = new Map<string, Entry>(); private pool = new Resources(); private readonly clock = new SimulationClock();
  private terrainRevision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null; private settleTimer: ReturnType<typeof setTimeout> | null = null; private dirty = true; private failed = false; private removed = false;
  constructor(private readonly options: SignalSceneOptions) {}
  onAdd(map: LibreMap, gl: WebGL2RenderingContext) {
    this.map = map; this.removed = false;
    try { this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl }); this.renderer.autoClear = false; this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.12; this.camera.matrixAutoUpdate = false;
      map.on('moveend', this.cameraChanged); map.on('zoomend', this.cameraChanged); map.on('sourcedata', this.sourceChanged); document.addEventListener('visibilitychange', this.visibilityChanged); this.refresh();
    } catch (error) { this.fail(error); }
  }
  private cameraChanged = () => this.refresh();
  private sourceChanged = (event: { sourceId?: string; isSourceLoaded?: boolean; sourceDataType?: string }) => {
    if (event.sourceDataType === 'metadata' || event.sourceDataType === 'visibility') return;
    if (event.sourceId === this.map?.getTerrain()?.source && event.isSourceLoaded) this.terrainRevision++;
    if (['atlas-buildings', 'openmaptiles', this.map?.getTerrain()?.source].includes(event.sourceId ?? '')) this.refresh();
  };
  private visibilityChanged = () => { this.stopTimer(); this.clock.step(performance.now(), false); if (!document.hidden) this.map?.triggerRepaint(); };
  private stopTimer() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private stopSettleTimer() { if (this.settleTimer !== null) clearTimeout(this.settleTimer); this.settleTimer = null; }
  private scheduleSettledRefresh() {
    if (this.removed || this.settleTimer !== null) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.removed || !this.dirty) return;
      this.map?.triggerRepaint();
      if (this.map?.isMoving()) this.scheduleSettledRefresh();
    }, 80);
  }
  private fail(error: unknown) { this.failed = true; this.stopTimer(); this.stopSettleTimer(); for (const entry of this.entries.values()) entry.projection = null; this.options.onError?.(error); }
  refresh() { if (this.removed) return; this.dirty = true; this.stopTimer(); this.clock.step(performance.now(), false); this.map?.triggerRepaint(); this.scheduleSettledRefresh(); }
  private query(source: string, sourceLayer: string): Feature<Geometry>[] { if (!this.map?.getSource(source)) return []; try { return this.map.querySourceFeatures(source, { sourceLayer }); } catch { return []; } }
  private entry(event: EventScene, signature: string, attachment: SceneAttachment): Entry {
    const model = createModel(this.pool, event, attachment, this.options.mobile), scene = new THREE.Scene(), sky = new THREE.HemisphereLight(0xedf3e8, 0x728173, 2); sky.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xffefd6, 2.7), fill = new THREE.DirectionalLight(0xffd6a4, 0.35); fill.position.set(30, -60, 45); scene.add(model.root, sky, sun, fill);
    const elevation = this.map?.getTerrain() ? this.map.queryTerrainElevation(event.coordinates) ?? 0 : 0;
    return { event, signature, sourceSignature: signature, attachment, model, scene, sky, sun, fill, coordinate: MercatorCoordinate.fromLngLat(event.coordinates, elevation + 0.06), projection: null, phase: stableHash(event.id) / 4294967296 * 120 };
  }
  private reconcile() {
    const map = this.map; if (!map) return; if (map.isMoving()) { this.scheduleSettledRefresh(); return; } this.stopSettleTimer(); const zoom = map.getZoom(), canvas = map.getCanvas(), active = new Set<string>();
    const candidates = this.options.scenes().filter((event) => event.coordinates.every(Number.isFinite) && getScenePresentation(event, zoom).visible).map((event) => ({ event, point: getSceneViewportPoint(event, point => map.project(point), canvas.clientWidth, canvas.clientHeight) })).filter(({ point }) => point !== null).sort((a, b) => Number(b.event.selected)-Number(a.event.selected) || (b.event.priority??0)-(a.event.priority??0) || Number(this.entries.has(b.event.id)) - Number(this.entries.has(a.event.id)) || stableHash(a.event.id) - stableHash(b.event.id));
    // Source queries materialize all loaded tile features. Do that only when a
    // visible new scene actually needs a basemap attachment, once per pass.
    let buildings: Feature<Geometry>[] | undefined, roads: Feature<Geometry>[] | undefined;
    const resolve = (event: EventScene) => {
      if (event.precision === 'building' && !buildings) buildings = [...this.query('atlas-buildings', 'building').map(feature => ({ ...feature, properties: { ...feature.properties, atlasSceneFootprintRole: 'building' } })), ...this.query('atlas-buildings', 'building_part').map(feature => ({ ...feature, properties: { ...feature.properties, atlasSceneFootprintRole: 'part' } }))];
      if (event.precision === 'street' && !(event.geometry && lines(event.geometry).length) && !roads) roads = this.query('openmaptiles', 'transportation');
      return resolveSceneAttachment(event, buildings ?? [], roads ?? []);
    };
    for (const { event } of candidates) {
      if (active.size >= (this.options.mobile ? 5 : 12)) break;
      if (active.has(event.id)) continue;
      const sourceSignature = [event.kind, event.activityKind, event.display, event.state, event.activityExpiresAt, event.topic, event.icon, event.selected, JSON.stringify(event.recipe),
        event.precision, event.planned, event.entireStreet, event.excavationConfirmed, event.coverageMode, event.lastKnownWork, JSON.stringify(event.live ?? null), JSON.stringify(event.lifecycle ?? null),
        ...event.coordinates, JSON.stringify(event.geometry ?? null)].join(':');
      const existing = this.entries.get(event.id);
      const baseAttachment = existing?.sourceSignature === sourceSignature ? existing.attachment : resolve(event);
      // During tile replacement a source can briefly answer with no features.
      // Keep the last grounded scene until a settled source event can rebuild it.
      if (!baseAttachment) { if(existing){existing.event=event;active.add(event.id);} continue; }
      // A signal is tied to its verified geometry, never to the current
      // viewport. Replacing a street attachment with its visible sub-range
      // made the cones and crews slide along the road when panning or zooming.
      // The renderer's projection already moves this fixed geometry with the
      // map, so camera changes must not enter the scene signature.
      const signature = sourceSignature + ':geometry:fixed:terrain:' + Boolean(map.getTerrain()) + ':' + this.terrainRevision;
      if (existing?.signature === signature) { existing.event = event; active.add(event.id); continue; }
      const attachment = { ...baseAttachment, visibleRanges: undefined };
      if (map.getTerrain()) {
        const origin = MercatorCoordinate.fromLngLat(event.coordinates), unit = origin.meterInMercatorCoordinateUnits(), baseHeight = map.queryTerrainElevation(event.coordinates) ?? 0;
        const cache = new Map<string, number>();
        attachment.heightAt = (x, y) => {
          const key = `${Math.round(x / 12)},${Math.round(y / 12)}`;
          const cached = cache.get(key); if (cached !== undefined) return cached;
          const at = new MercatorCoordinate(origin.x + x * unit, origin.y - y * unit).toLngLat();
          const value = (map.queryTerrainElevation([at.lng, at.lat]) ?? baseHeight) - baseHeight;
          cache.set(key, value); return value;
        };
      } else attachment.heightAt = undefined;
      if (existing) { existing.model.dispose(); existing.scene.clear(); }
      const entry = this.entry(event, signature, attachment); entry.sourceSignature = sourceSignature;
      this.entries.set(event.id, entry); active.add(event.id);
    }
    for (const [id, entry] of this.entries) if (!active.has(id)) { entry.model.dispose(); entry.scene.clear(); this.entries.delete(id); }
    const host=map.getContainer?.();
    if(host)host.dataset.atlasScenes=JSON.stringify([...this.entries.values()].map(e=>({id:e.event.id,display:e.event.display,family:e.event.recipe?.family,effect:e.model.root.userData.effect,animated:e.model.animated,selected:!!e.event.selected,spanMetres:e.model.root.userData.spanMetres,workZones:e.model.root.userData.workZones,workZoneChainages:e.model.root.userData.workZoneChainages,viewportSpanMetres:e.model.root.userData.viewportSpanMetres,sourceScope:e.model.root.userData.sourceScope,coverageMode:e.model.root.userData.coverageMode,presentation:e.model.root.userData.presentation,excavation:e.model.root.userData.excavation})));
    this.dirty = false;
  }
  private readonly renderTransform = new THREE.Matrix4();
  private readonly renderScale = new THREE.Matrix4();
  private readonly renderProjection = new THREE.Matrix4();

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map, renderer = this.renderer; if (!map || !renderer || this.failed || this.removed) return;
    if (!this.options.enabled() || map.getZoom() < 13.2 || (typeof document !== 'undefined' && document.hidden)) { this.stopTimer(); this.clock.step(performance.now(), false); for (const entry of this.entries.values()) entry.projection = null; return; }
    try {
      if (this.dirty) this.reconcile();
      const zoom = map.getZoom(), lighting = this.options.lighting();
      const canvas = map.getCanvas(), visibleEntries = [...this.entries.values()].filter(entry => {
        const visible = getScenePresentation(entry.event, zoom).visible && Boolean(getSceneViewportPoint(entry.event, point => map.project(point), canvas.clientWidth, canvas.clientHeight));
        if (!visible) entry.projection = null;
        return visible;
      });
      const running = this.options.animate() && !this.options.reducedMotion && visibleEntries.some((entry) => entry.model.animated);
      const time = this.clock.step(performance.now(), running);
      this.pool.light(lighting.nightAmount); const projection = this.renderProjection.fromArray(args.defaultProjectionData.mainMatrix); renderer.resetState(); renderer.setViewport(0, 0, map.getCanvas().width, map.getCanvas().height); let visible = 0;
      for (const entry of visibleEntries) {
        visible++;
        entry.model.root.scale.setScalar(1); entry.model.root.position.set(0, 0, 0); entry.model.root.rotation.set(0, 0, 0); entry.model.detail.visible = zoom >= (entry.event.selected ? 15.6 : 16.5) && !this.options.mobile; entry.model.update(time + entry.phase);
        entry.sky.intensity = 0.65 + lighting.brightness * 1.7; entry.sky.color.set(lighting.nightAmount > 0.5 ? '#9aaec5' : '#edf4e5'); entry.sun.intensity = 0.2 + lighting.brightness * 2.5; entry.sun.color.set(lighting.sunElevation < 15 ? '#ffc997' : '#fff1db'); const d = lighting.sunDirection; entry.sun.position.set(d[0] * 140, d[1] * 140, Math.max(18, d[2] * 140)); entry.fill.intensity = 0.25 + lighting.nightAmount * 0.8;
        const coordinate = entry.coordinate, metre = coordinate.meterInMercatorCoordinateUnits(), transform = this.renderTransform.makeTranslation(coordinate.x, coordinate.y, coordinate.z).multiply(this.renderScale.makeScale(metre, -metre, metre));
        this.camera.projectionMatrix.copy(projection).multiply(transform); this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert(); (entry.projection ??= new THREE.Matrix4()).copy(this.camera.projectionMatrix); renderer.render(entry.scene, this.camera);
      }
      if (!running || !visible) this.stopTimer(); else if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; if (!this.removed) this.map?.triggerRepaint(); }, this.options.mobile ? 70 : 42);
    } catch (error) { this.fail(error); } finally { renderer.resetState(); }
  }
  pick(point: { x: number; y: number }): string | null {
    if (!this.map || !this.options.enabled() || this.failed || this.removed) return null; const canvas = this.map.getCanvas(); if (!canvas.clientWidth || !canvas.clientHeight) return null;
    const x = point.x / canvas.clientWidth * 2 - 1, y = 1 - point.y / canvas.clientHeight * 2; let nearest: { id: string; depth: number } | null = null;
    for (const entry of this.entries.values()) { if (!entry.projection) continue; const inverse = entry.projection.clone().invert(), near = new THREE.Vector3(x, y, -1).applyMatrix4(inverse), far = new THREE.Vector3(x, y, 1).applyMatrix4(inverse); this.raycaster.ray.set(near, far.sub(near).normalize()); const hit = this.raycaster.intersectObject(entry.model.root, true).find((hit) => { let object: THREE.Object3D | null = hit.object; while (object) { if (!object.visible) return false; object = object.parent; } return true; }); if (!hit) continue; const depth = hit.point.clone().applyMatrix4(entry.projection).z; if (depth >= -1 && depth <= 1 && (!nearest || depth < nearest.depth)) nearest = { id: entry.event.id, depth }; }
    return nearest?.id ?? null;
  }
  onRemove() { this.removed = true; this.stopTimer(); this.stopSettleTimer(); this.clock.step(performance.now(), false); this.map?.off('moveend', this.cameraChanged); this.map?.off('zoomend', this.cameraChanged); this.map?.off('sourcedata', this.sourceChanged); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityChanged); for (const entry of this.entries.values()) { entry.model.dispose(); entry.scene.clear(); } this.entries.clear(); this.pool.dispose(); this.renderer?.dispose(); this.renderer = null; this.map = null; }
}

/** Isolated gallery fixtures. This helper never writes to the event store. */
export function createScenePreview(recipe: SceneRecipe, state: string) {
  const pool=new Resources(), storyboard=sceneStoryboard(recipe), precise=(storyboard?.context ?? (recipe.family==='construction'&&recipe.geometry.includes('site')?'site':recipe.geometry[0])) as SceneAttachment['type'];
  const [width,depth]=storyboard?.footprint??[24,20];
  const a=makeAttachment(precise,precise==='street'?(storyboard?.renderer==='physical'?[[-60,0],[60,0]]:[[-width/2,0],[width/2,0]]):[[-width/2,-depth/2],[width/2,-depth/2],[width/2,depth/2],[-width/2,depth/2],[-width/2,-depth/2]],12,'gallery')!;
  const event:EventScene={id:'gallery:'+recipe.id,title:recipe.topic,state,kind:(state==='cancelled'?'generic':state==='paused'?'paused':state==='resolved'?'completed':recipe.sceneKind) as SceneKind,coordinates:[49.12,55.79],precision:precise,planned:state==='planned',recipe,defectPositionConfirmed:true,
    display:state==='archive'?'archive':state==='in_progress'?'active':state==='resolved'?'completed':state==='paused'?'paused':'static',lifecycle:{status:'under_construction',asOf:new Date().toISOString(),sourceUrl:'https://example.org/gallery-fixture',currentStatusVerified:true,animationEligible:state==='in_progress',note:'Демонстрационный пример'}};
  const model=createModel(pool,event,a,false);if(storyboard)model.root.userData.storyboard={...storyboard};return {...model,attachment:a,dispose:()=>{model.dispose();pool.dispose();}};
}
