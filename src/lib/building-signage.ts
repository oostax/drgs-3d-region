import * as THREE from 'three';
import type { BuildingProfile, BuildingProfileKind } from './building-materials';

type XY = [number, number];
type SignIcon = 'book' | 'sun' | 'cross' | 'cap' | 'stadium' | 'ball' | 'columns' | 'art' | 'train' | 'briefcase' | 'shop' | 'factory' | 'box' | 'bed';
export type BuildingSignageSpec = { kind: BuildingProfileKind; label: string; background: string; icon: SignIcon; width: number; slot: number };

// Purpose labels are illustrative wayfinding, not recovered names, numbers, or real signs.
// Broad source categories keep broad wording: civic != town hall, cultural != museum.
const definitions: [BuildingProfileKind, string, string, SignIcon, number][] = [
  ['education', 'ШКОЛА', '#365d78', 'book', 6.2],
  ['kindergarten', 'ДЕТСКИЙ САД', '#905528', 'sun', 7.2],
  ['hospital', 'БОЛЬНИЦА', '#236856', 'cross', 7.2],
  ['clinic', 'КЛИНИКА', '#377667', 'cross', 6.4],
  ['medical', 'МЕДИЦИНА', '#477568', 'cross', 6.4],
  ['university', 'УЧЕБНЫЙ КОРПУС', '#3e586e', 'cap', 8.2],
  ['stadium', 'СТАДИОН', '#286968', 'stadium', 9.2],
  ['sports', 'СПОРТКОМПЛЕКС', '#376575', 'ball', 8.6],
  ['civic', 'УЧРЕЖДЕНИЕ', '#536052', 'columns', 7.6],
  ['cultural', 'КУЛЬТУРА', '#754f59', 'art', 7.2],
  ['transport', 'ТРАНСПОРТ', '#436879', 'train', 8.2],
  ['hotel', 'ГОСТИНИЦА', '#785747', 'bed', 7.2],
  ['office', 'ОФИСЫ', '#485f77', 'briefcase', 6.2],
  ['retail', 'МАГАЗИНЫ', '#3d785d', 'shop', 7.2],
  ['industrial', 'ПРОИЗВОДСТВО', '#57666b', 'factory', 8.2],
  ['warehouse', 'СКЛАД', '#706555', 'box', 6.2],
];

export const BUILDING_SIGNAGE_ATLAS = Object.freeze({ width: 1024, height: 1024, columns: 2, rows: 8, cellWidth: 512, cellHeight: 128 });
const specs = new Map(definitions.map(([kind, label, background, icon, width], slot) => [kind, Object.freeze({ kind, label, background, icon, width, slot })]));

/** Only a source-classified purpose gets a sign; ID, color and geometry cannot invent use. */
export function getBuildingSignage(profile: Pick<BuildingProfile, 'kind'>): Readonly<BuildingSignageSpec> | null {
  return specs.get(profile.kind) ?? null;
}

/** One six-vertex entrance sign on the longest exterior wall. Rings use local metres, Z is up.
 * UVs stay readable under either winding; holes never receive an exterior entrance sign.
 * Ground-only gating prevents a floating building part from gaining a fictitious entrance.
 */
export function makeBuildingSignageGeometry(rings: XY[][], profile: BuildingProfile, detailLevel: 0 | 1 | 2 = 2): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([], 2));
  const spec = getBuildingSignage(profile);
  if (!spec || detailLevel < 2 || profile.tiny || profile.base > 0.15 || !Number.isFinite(profile.eaves) || profile.eaves < 2.95) return geometry;
  const input = rings[0];
  if (!input || input.length < 3 || input.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return geometry;
  const ring = Math.hypot(input[0][0] - input.at(-1)![0], input[0][1] - input.at(-1)![1]) < 0.001 ? input.slice(0, -1) : input;
  if (ring.length < 3) return geometry;
  const area = ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - a[1] * b[0]; }, 0);
  if (Math.abs(area) < 0.001) return geometry;
  const winding = area > 0 ? 1 : -1;
  const edges = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    return { length, center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as XY, outward: [dy / length * winding + 0, -dx / length * winding + 0] as XY };
  }).filter(edge => edge.length >= 4.2).sort((a, b) => b.length - a.length || a.center[1] - b.center[1] || a.center[0] - b.center[0]);
  const edge = edges[0];
  if (!edge) return geometry;
  const width = Math.min(spec.width, edge.length - 0.9), height = Math.min(1.35, width / 5.2, profile.eaves - 2.4);
  if (height < 0.5) return geometry;
  const canopyHeight = Math.min(3.2, Math.max(2.2, profile.floorHeight * 0.8), profile.eaves - 0.6);
  const bottom = Math.max(2.15, Math.min(canopyHeight + 0.16, profile.eaves - height - 0.22));
  const top = bottom + height;
  // On a low building the sign forms the canopy fascia; otherwise it sits just off the wall.
  const intersectsCanopy = bottom < canopyHeight + 0.06 && top > canopyHeight - 0.18;
  const offset = intersectsCanopy ? 1.1 : 0.085;
  const right: XY = [-edge.outward[1], edge.outward[0]];
  const point = (u: number, z: number) => [edge.center[0] + edge.outward[0] * offset + right[0] * u, edge.center[1] + edge.outward[1] * offset + right[1] * u, z];
  const a = point(-width / 2, bottom), b = point(width / 2, bottom), c = point(width / 2, top), d = point(-width / 2, top);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [...edge.outward, 0]).flat(), 3));
  // CanvasTexture flips Y during upload, hence top-origin atlas rows become 1-v.
  const atlas = BUILDING_SIGNAGE_ATLAS, column = spec.slot % atlas.columns, row = Math.floor(spec.slot / atlas.columns), inset = 1.5;
  const leftU = (column * atlas.cellWidth + inset) / atlas.width, rightU = ((column + 1) * atlas.cellWidth - inset) / atlas.width;
  const topV = 1 - (row * atlas.cellHeight + inset) / atlas.height, bottomV = 1 - ((row + 1) * atlas.cellHeight - inset) / atlas.height;
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([leftU, bottomV, rightU, bottomV, rightU, topV, leftU, bottomV, rightU, topV, leftU, topV], 2));
  geometry.userData = { signageKind: spec.kind, label: spec.label, width, height, bottom, offset };
  return geometry;
}

type SignContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
function drawIcon(context: SignContext, icon: SignIcon) {
  context.save(); context.translate(26, 28); context.scale(3, 3);
  context.strokeStyle = '#fffdf3'; context.fillStyle = '#fffdf3'; context.lineWidth = 1.75; context.lineJoin = 'round'; context.lineCap = 'round';
  const path = (points: number[][], closed = false) => { context.beginPath(); points.forEach(([x, y], i) => i ? context.lineTo(x, y) : context.moveTo(x, y)); if (closed) context.closePath(); context.stroke(); };
  const rect = (x: number, y: number, width: number, height: number) => context.strokeRect(x, y, width, height);
  const circle = (x: number, y: number, radius: number) => { context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.stroke(); };
  if (icon === 'cross') { context.fillRect(9, 3, 6, 18); context.fillRect(3, 9, 18, 6); }
  else if (icon === 'book') { path([[12, 6], [6, 3], [2, 4], [2, 19], [7, 18], [12, 21], [17, 18], [22, 19], [22, 4], [18, 3], [12, 6], [12, 21]]); }
  else if (icon === 'sun') { circle(12, 12, 5); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; path([[12 + Math.cos(a) * 8, 12 + Math.sin(a) * 8], [12 + Math.cos(a) * 10.5, 12 + Math.sin(a) * 10.5]]); } }
  else if (icon === 'cap') { path([[1, 8], [12, 3], [23, 8], [12, 13]], true); path([[5, 11], [5, 17], [12, 21], [19, 17], [19, 11]]); path([[23, 8], [23, 17]]); }
  else if (icon === 'stadium') { context.beginPath(); context.ellipse(12, 8, 10, 5, 0, 0, Math.PI * 2); context.stroke(); path([[2, 8], [2, 17], [7, 21], [17, 21], [22, 17], [22, 8]]); path([[7, 12], [7, 20]]); path([[17, 12], [17, 20]]); }
  else if (icon === 'ball') { circle(12, 12, 10); path([[4, 6], [9, 9], [7, 16], [2, 16]]); path([[9, 9], [16, 8], [20, 4]]); path([[16, 8], [19, 15], [16, 21]]); path([[7, 16], [14, 18], [19, 15]]); }
  else if (icon === 'columns') { path([[2, 7], [12, 2], [22, 7]], true); path([[1, 22], [23, 22]]); for (const x of [5, 12, 19]) path([[x, 10], [x, 19]]); path([[2, 19], [22, 19]]); }
  else if (icon === 'art') { rect(2, 3, 20, 18); path([[3, 18], [9, 10], [13, 15], [17, 11], [22, 17]]); circle(17, 7, 1.5); }
  else if (icon === 'train') { rect(5, 2, 14, 17); rect(7.5, 5, 9, 6); circle(8, 16, 1); circle(16, 16, 1); path([[8, 19], [5, 23]]); path([[16, 19], [19, 23]]); }
  else if (icon === 'briefcase') { rect(2, 7, 20, 15); path([[8, 7], [8, 3], [16, 3], [16, 7]]); path([[2, 12], [12, 15], [22, 12]]); path([[12, 12], [12, 17]]); }
  else if (icon === 'shop') { path([[2, 9], [5, 3], [19, 3], [22, 9]], true); path([[4, 10], [4, 22], [20, 22], [20, 10]]); rect(8, 14, 8, 8); for (const x of [7, 12, 17]) path([[x, 3], [x, 9]]); }
  else if (icon === 'factory') { path([[2, 22], [2, 11], [9, 7], [9, 12], [16, 8], [16, 22]], true); path([[16, 22], [22, 22], [21, 2], [18, 2], [17, 17]]); for (const x of [5, 11]) rect(x, 16, 2, 2); }
  else if (icon === 'box') { path([[2, 7], [12, 2], [22, 7], [22, 18], [12, 23], [2, 18]], true); path([[2, 7], [12, 12], [22, 7]]); path([[12, 12], [12, 23]]); path([[7, 4.5], [17, 9.5]]); }
  else if (icon === 'bed') { path([[2, 5], [2, 22]]); path([[2, 17], [22, 17], [22, 22]]); rect(5, 9, 6, 6); path([[12, 15], [12, 8], [20, 8], [22, 11], [22, 17]]); }
  context.restore();
}

export type BuildingSignageTexture = THREE.CanvasTexture<HTMLCanvasElement | OffscreenCanvas>;
function makeSignageAtlas(): BuildingSignageTexture {
  const atlas = BUILDING_SIGNAGE_ATLAS;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(atlas.width, atlas.height) : typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!canvas) throw new Error('Building signage textures require a browser canvas');
  canvas.width = atlas.width; canvas.height = atlas.height;
  const context = canvas.getContext('2d') as SignContext | null;
  if (!context) throw new Error('Unable to create building signage canvas');
  context.fillStyle = '#eee9da'; context.fillRect(0, 0, atlas.width, atlas.height);
  for (const spec of specs.values()) {
    context.save(); context.translate(spec.slot % atlas.columns * atlas.cellWidth, Math.floor(spec.slot / atlas.columns) * atlas.cellHeight);
    context.fillStyle = spec.background; context.fillRect(4, 4, atlas.cellWidth - 8, atlas.cellHeight - 8);
    drawIcon(context, spec.icon);
    context.fillStyle = '#fffdf3'; context.textBaseline = 'middle'; context.textAlign = 'left';
    let size = 52;
    do { context.font = `700 ${size}px Manrope, Arial, sans-serif`; if (context.measureText(spec.label).width <= 380) break; size -= 2; } while (size > 26);
    context.fillText(spec.label, 112, atlas.cellHeight / 2 + 2, 380);
    context.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'atlas-building-purpose-signs'; texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping; texture.generateMipmaps = true; texture.anisotropy = 4;
  return texture;
}

type SharedSignage = { material: THREE.MeshBasicMaterial; texture: BuildingSignageTexture; users: number };
let shared: SharedSignage | null = null;

/** All buildings/scenes share one atlas and one material. Each scene releases its lease once. */
export function acquireBuildingSignageResources(): { material: THREE.MeshBasicMaterial; texture: BuildingSignageTexture; release: () => void } {
  if (!shared) {
    const texture = makeSignageAtlas();
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false, transparent: true, depthTest: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    material.name = 'atlas-building-purpose-signs';
    shared = { texture, material, users: 0 };
  }
  const resources = shared; resources.users++;
  let released = false;
  return { material: resources.material, texture: resources.texture, release: () => {
    if (released) return; released = true;
    if (--resources.users === 0) { resources.material.dispose(); resources.texture.dispose(); if (shared === resources) shared = null; }
  } };
}
