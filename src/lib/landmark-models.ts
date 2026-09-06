import * as THREE from 'three';

/**
 * Original, hand-authored architectural interpretations, not surveyed/BIM models.
 * All geometry is in metres: X east, Y north, Z UP, footprint centre at (0, 0),
 * ground at z=0. Default front faces -Y. The caller applies catalog rotation
 * around Z and the Mercator transform (including Mercator's southward Y axis).
 * No textures, network requests or renderer/global state are created here.
 */
export type LandmarkDetail = 'high' | 'low';

type Tone = 'stone' | 'light' | 'shadow' | 'glass' | 'turquoise' | 'green' | 'gold' | 'brick' | 'bronze' | 'wood' | 'water' | 'grass';
const COLORS: Record<Tone, number> = {
  stone: 0xe5ddc9, light: 0xf5f0df, shadow: 0xb6b49f, glass: 0x366c73,
  turquoise: 0x43a9b1, green: 0x477360, gold: 0xc9a75d, brick: 0xae7968,
  bronze: 0x66563c, wood: 0xb19a74, water: 0x75b6af, grass: 0x849b79,
};
type Placement = { position?: [number, number, number]; scale?: [number, number, number]; rotation?: [number, number, number]; quaternion?: THREE.Quaternion };

class Architecture {
  readonly group = new THREE.Group();
  readonly radial: number;
  readonly fine: boolean;
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<Tone, THREE.MeshStandardMaterial>();
  private readonly batches = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] }>();

  constructor(readonly detail: LandmarkDetail) {
    this.fine = detail === 'high';
    this.radial = this.fine ? 32 : 12;
  }

  geometry(key: string, create: () => THREE.BufferGeometry) {
    let geometry = this.geometries.get(key);
    if (!geometry) { geometry = create(); this.geometries.set(key, geometry); }
    return geometry;
  }

  put(key: string, geometry: THREE.BufferGeometry, tone: Tone, placement: Placement = {}) {
    let material = this.materials.get(tone);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: COLORS[tone], roughness: tone === 'glass' ? 0.22 : tone === 'gold' ? 0.42 : 0.83,
        metalness: tone === 'gold' || tone === 'bronze' ? 0.45 : tone === 'glass' ? 0.25 : 0,
        side: THREE.DoubleSide,
      });
      this.materials.set(tone, material);
    }
    const id = `${key}:${tone}`;
    let batch = this.batches.get(id);
    if (!batch) { batch = { geometry, material, matrices: [] }; this.batches.set(id, batch); }
    const q = placement.quaternion ?? new THREE.Quaternion().setFromEuler(new THREE.Euler(...(placement.rotation ?? [0, 0, 0])));
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...(placement.position ?? [0, 0, 0])), q,
      new THREE.Vector3(...(placement.scale ?? [1, 1, 1])),
    );
    batch.matrices.push(matrix);
  }

  box(x: number, y: number, z: number, w: number, d: number, h: number, tone: Tone = 'stone', rotation = 0) {
    this.put('box', this.geometry('box', () => new THREE.BoxGeometry(1, 1, 1)), tone,
      { position: [x, y, z + h / 2], scale: [w, d, h], rotation: [0, 0, rotation] });
  }

  cylinder(x: number, y: number, z: number, radius: number, height: number, tone: Tone = 'stone', topRatio = 1, sides = this.radial) {
    const key = `cylinder:${sides}:${topRatio}`;
    this.put(key, this.geometry(key, () => new THREE.CylinderGeometry(topRatio, 1, 1, sides).rotateX(Math.PI / 2).rotateZ(sides === 8 ? Math.PI / 8 : 0)), tone,
      { position: [x, y, z + height / 2], scale: [radius, radius, height] });
  }

  torus(x: number, y: number, z: number, radius: number, tube: number, tone: Tone = 'stone', rx = 0, rz = 0) {
    const key = `torus:${radius}:${tube}:${rx}`;
    this.put(key, this.geometry(key, () => new THREE.TorusGeometry(radius, tube, this.fine ? 6 : 4, this.radial).rotateX(rx)), tone,
      { position: [x, y, z], rotation: [0, 0, rz] });
  }

  lathe(x: number, y: number, z: number, profile: [number, number][], tone: Tone, key: string, scale: [number, number, number] = [1, 1, 1]) {
    this.put(key, this.geometry(key, () => new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), this.radial).rotateX(Math.PI / 2)), tone,
      { position: [x, y, z], scale });
  }

  dome(x: number, y: number, z: number, radius: number, height: number, tone: Tone = 'turquoise') {
    // Slightly bulbous drum-to-crown profile rather than a generic hemisphere.
    const profile: [number, number][] = [[0, 0], [0.9, 0], [1, 0.13], [0.99, 0.32], [0.89, 0.55], [0.66, 0.78], [0.32, 0.94], [0, 1]];
    this.lathe(x, y, z, profile, tone, 'dome', [radius, radius, height]);
  }

  beam(a: [number, number, number], b: [number, number, number], radius: number, tone: Tone = 'stone', topRatio = 1) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
    const key = `beam:${topRatio}`;
    this.put(key, this.geometry(key, () => new THREE.CylinderGeometry(topRatio, 1, 1, this.fine ? 8 : 5).rotateX(Math.PI / 2)), tone,
      { position: start.add(end).multiplyScalar(0.5).toArray() as [number, number, number], scale: [radius, radius, delta.length()], quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), delta.normalize()) });
  }

  ring(x: number, y: number, z: number, outer: number, inner: number, height: number, tone: Tone) {
    const key = `ring:${outer}:${inner}:${height}`;
    this.put(key, this.geometry(key, () => {
      const shape = new THREE.Shape(); shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
      const hole = new THREE.Path(); hole.absarc(0, 0, inner, 0, Math.PI * 2, true); shape.holes.push(hole);
      return new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: this.radial });
    }), tone, { position: [x, y, z] });
  }

  arch(x: number, y: number, z: number, width: number, height: number, border: number, depth: number, tone: Tone = 'light', angle = 0, glazed = false) {
    const key = `arch:${width}:${height}:${border}:${depth}`;
    const spring = height - width / 2;
    this.put(key, this.geometry(key, () => {
      // One open-bottom U-shaped solid: the doorway is a genuine geometric void.
      const s = new THREE.Shape(), r = width / 2, ri = r - border;
      s.moveTo(-r, 0); s.lineTo(-r, spring); s.absarc(0, spring, r, Math.PI, 0, true);
      s.lineTo(r, 0); s.lineTo(ri, 0); s.lineTo(ri, spring);
      s.absarc(0, spring, ri, 0, Math.PI, false); s.lineTo(-ri, 0); s.closePath();
      return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: this.fine ? 12 : 5 }).rotateX(Math.PI / 2).translate(0, depth / 2, 0);
    }), tone, { position: [x, y, z], rotation: [0, 0, angle] });
    if (glazed) {
      const paneKey = `pane:${width}:${height}:${border}`;
      this.put(paneKey, this.geometry(paneKey, () => {
        const r = width / 2 - border, s = new THREE.Shape();
        s.moveTo(-r, 0); s.lineTo(r, 0); s.lineTo(r, spring); s.absarc(0, spring, r, 0, Math.PI, false); s.closePath();
        return new THREE.ShapeGeometry(s, this.fine ? 12 : 5).rotateX(Math.PI / 2);
      }), 'glass', { position: [x + Math.sin(angle) * depth * 0.2, y - Math.cos(angle) * depth * 0.2, z], rotation: [0, 0, angle] });
      if (this.fine) {
        this.box(x, y - depth * 0.42, z, border * 0.6, depth * 0.35, height - border, 'gold', angle);
      }
    }
  }

  finial(x: number, y: number, z: number, size = 1, crescent = true) {
    this.cylinder(x, y, z, 0.11 * size, 1.6 * size, 'gold', 0.4, 6);
    if (crescent) {
      const key = 'crescent';
      this.put(key, this.geometry(key, () => new THREE.TorusGeometry(0.65, 0.12, 5, this.fine ? 24 : 12, Math.PI * 1.55).rotateZ(Math.PI * 0.23)), 'gold',
        { position: [x, y, z + 1.95 * size], scale: [size, size, size], rotation: [Math.PI / 2, 0, 0] });
    }
  }

  windows(x: number, y: number, z: number, columns: number, floors: number, spacingX: number, spacingZ: number, width = 1.6, height = 2.5, angle = 0) {
    for (let row = 0; row < floors; row++) for (let col = 0; col < columns; col++) {
      const dx = (col - (columns - 1) / 2) * spacingX;
      this.arch(x + dx * Math.cos(angle), y + dx * Math.sin(angle), z + row * spacingZ, width, height, 0.2, 0.25, 'light', angle, true);
    }
  }

  finish(kind: string) {
    let triangles = 0;
    for (const [name, batch] of this.batches) {
      const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
      batch.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.name = name; mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.computeBoundingSphere(); mesh.computeBoundingBox();
      triangles += ((batch.geometry.index?.count ?? batch.geometry.getAttribute('position').count) / 3) * batch.matrices.length;
      this.group.add(mesh);
    }
    this.group.name = `${kind}-${this.detail}`;
    this.group.userData = { kind, detail: this.detail, coordinateSystem: 'Z-up, metres, front -Y', triangles, authorship: 'Original procedural interpretation; not a survey' };
    return this.group;
  }
}

function minaret(a: Architecture, x: number, y: number, height: number, radius = 1.8, whiteRoof = false) {
  const shaft = height * 0.7;
  a.cylinder(x, y, 0.5, radius * 1.28, 4, 'light', 1, 8);
  a.cylinder(x, y, 4.5, radius, shaft - 4, 'light', 0.7, a.fine ? 16 : 8);
  for (const fraction of [0.42, 0.68]) {
    const z = height * fraction;
    a.cylinder(x, y, z, radius * 1.4, 0.7, 'stone', 1, 16);
    a.cylinder(x, y, z + 0.7, radius * 1.25, 1.0, 'light', 0.95, 16);
    if (a.fine) for (let i = 0; i < 16; i++) {
      const t = i * Math.PI / 8;
      a.cylinder(x + Math.cos(t) * radius * 1.18, y + Math.sin(t) * radius * 1.18, z + 0.7, 0.07, 1, 'gold', 1, 5);
    }
  }
  a.cylinder(x, y, shaft, radius * 0.74, height * 0.09, 'light', 0.9, 8);
  a.cylinder(x, y, height * 0.79, radius * 0.98, height * 0.17, whiteRoof ? 'light' : 'turquoise', 0, a.fine ? 16 : 8);
  a.finial(x, y, height * 0.96, height / 55);
}

function qolSharif(a: Architecture) {
  a.box(0, 0, 0, 51, 45, 1.2, 'stone');
  for (let step = 0; step < 4; step++) a.box(0, -25 + step * 0.65, step * 0.3, 20 - step * 0.6, 2, 0.3, 'light');
  a.box(0, 0, 1.2, 30, 30, 16, 'light');
  a.box(0, 0, 1.2, 27, 27, 16, 'light', Math.PI / 4);
  a.cylinder(0, 0, 17, 14.9, 3.5, 'stone', 0.76, 8);
  a.cylinder(0, 0, 20.5, 9.2, 4.5, 'light', 1, 16);
  a.dome(0, 0, 25, 8.6, 10.5); a.finial(0, 0, 35.5, 0.75);
  for (const x of [-19, 19]) for (const y of [-17, 17]) minaret(a, x, y, 55, 1.6);
  for (const x of [-10.5, 10.5]) minaret(a, x, -21, 26, 1.05);
  for (let side = 0; side < 4; side++) {
    const angle = side * Math.PI / 2;
    a.windows(Math.sin(angle) * 15.2, -Math.cos(angle) * 15.2, 5.2, 3, 1, 6.5, 0, 3.3, 10, angle);
  }
  a.arch(0, -22, 1.2, 12, 16, 1.9, 3, 'light', 0, true);
  a.arch(0, -23.6, 1.2, 8.3, 12, 0.45, 0.4, 'gold');
  for (let i = 0; i < (a.fine ? 16 : 8); i++) {
    const t = i * Math.PI * 2 / (a.fine ? 16 : 8);
    a.arch(Math.sin(t) * 9.25, -Math.cos(t) * 9.25, 21.2, 1.25, 3.1, 0.15, 0.2, 'gold', t, true);
  }
}

function suyumbike(a: Architecture) {
  a.box(0, 0, 0, 19, 19, 0.6, 'stone');
  // Seven receding brick stages, pierced gate, octagonal belfry and steep tent.
  a.box(-5.55, 0, 0.6, 5.9, 16, 12, 'brick'); a.box(5.55, 0, 0.6, 5.9, 16, 12, 'brick');
  a.box(0, 0, 10, 17, 16, 2.6, 'brick');
  a.arch(0, 0, 0.6, 6.4, 10, 0.8, 16, 'brick');
  a.arch(0, -8.2, 0.6, 6.7, 10.3, 0.45, 0.5, 'stone');
  for (const [z, width, height] of [[12.6, 14.6, 10], [22.6, 11.4, 9]] as const) {
    a.box(0, 0, z, width, width, height, 'brick');
    a.box(0, 0, z, width + 1, width + 1, 0.55, 'stone');
    a.box(0, 0, z + height - 0.65, width + 0.9, width + 0.9, 0.65, 'stone');
    for (let side = 0; side < 4; side++) {
      const t = side * Math.PI / 2;
      a.windows(Math.sin(t) * (width / 2 + 0.12), -Math.cos(t) * (width / 2 + 0.12), z + 2.1, 2, 1, width * 0.38, 0, 1.8, 4.3, t);
    }
  }
  for (const [z, radius, height] of [[31.6, 5.3, 6.4], [38, 4.45, 4.6]] as const) {
    a.cylinder(0, 0, z, radius, height, 'brick', 1, 8);
    a.cylinder(0, 0, z + height - 0.45, radius + 0.45, 0.45, 'stone', 1, 8);
    for (let i = 0; i < 8; i++) { const t = i * Math.PI / 4; a.arch(Math.sin(t) * radius * 0.925, -Math.cos(t) * radius * 0.925, z + 1, 1.5, height - 1.5, 0.23, 0.3, 'stone', t, true); }
  }
  a.cylinder(0, 0, 42.6, 4.6, 10, 'brick', 0.12, 8);
  a.cylinder(0, 0, 52.6, 0.65, 3, 'green', 0.1, 8); a.finial(0, 0, 55.4, 1.05);
  if (a.fine) for (let z = 1.2; z < 31; z += 1.3) {
    const width = z < 12.6 ? 17 : z < 22.6 ? 14.6 : 11.4;
    for (const sign of [-1, 1]) a.box(sign * (width / 2 - 0.6), -width / 2 - 0.04, z, 1.1, 0.28, 0.24, 'stone');
  }
}

function spasskaya(a: Architecture) {
  a.box(-8.4, 0, 0, 6.2, 22, 13, 'light'); a.box(8.4, 0, 0, 6.2, 22, 13, 'light');
  a.arch(0, 0, 0, 11.1, 12.5, 2, 22, 'light');
  a.box(0, 0, 12.5, 23, 22, 5, 'light'); a.box(0, 0, 17.5, 24, 23, 0.9, 'stone');
  a.cylinder(0, 0, 18.4, 10, 9.5, 'light', 1, 8); a.cylinder(0, 0, 27.9, 10.6, 0.8, 'stone', 1, 8);
  a.cylinder(0, 0, 28.7, 8, 6.5, 'light', 1, 8);
  for (let i = 0; i < 8; i++) { const t = i * Math.PI / 4; a.arch(Math.sin(t) * 7.5, -Math.cos(t) * 7.5, 29.4, 2.4, 4.9, 0.3, 0.25, 'stone', t, true); }
  a.cylinder(0, 0, 35.2, 8.6, 9.8, 'light', 0.02, 8);
  for (let i = 0; i < 4; i++) {
    const t = i * Math.PI / 2, x = Math.sin(t) * 9.36, y = -Math.cos(t) * 9.36;
    a.torus(x, y, 23.3, 2.1, 0.2, 'gold', Math.PI / 2, t);
    const key = 'clock-face';
    a.put(key, a.geometry(key, () => new THREE.CircleGeometry(1.96, a.radial).rotateX(Math.PI / 2)), 'shadow', { position: [x, y, 23.3], rotation: [0, 0, t] });
    const handX = x + Math.sin(t) * 0.15, handY = y - Math.cos(t) * 0.15;
    a.beam([handX, handY, 23.3], [handX + Math.cos(t) * 1.1, handY + Math.sin(t) * 1.1, 24], 0.11, 'gold');
    a.beam([handX, handY, 23.3], [handX, handY, 24.85], 0.1, 'gold');
  }
  a.cylinder(0, 0, 45, 0.12, 1.1, 'gold', 1, 6);
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) { const t = Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.55 : 1.4; if (!i) star.moveTo(Math.cos(t) * r, Math.sin(t) * r); else star.lineTo(Math.cos(t) * r, Math.sin(t) * r); }
  star.closePath();
  a.put('star', a.geometry('star', () => new THREE.ExtrudeGeometry(star, { depth: 0.25, bevelEnabled: false }).rotateX(Math.PI / 2)), 'gold', { position: [0, 0, 47] });
  for (let side = -1; side <= 1; side += 2) {
    a.box(side * 20, 2, 0, 18, 3.5, 7.7, 'light');
    for (let i = 0; i < 7; i++) a.box(side * (12 + i * 2.6), 2, 7.7, 1.4, 3.5, 1.5, 'light');
  }
}

function farmersPalace(a: Architecture) {
  a.box(0, 0, 0, 118, 44, 1, 'stone');
  for (const s of [-1, 1]) {
    a.box(s * 37, 0, 1, 42, 30, 21, 'light');
    a.box(s * 37, 0, 21.5, 44, 32, 1, 'stone');
    a.box(s * 37, 0, 22.5, 42, 30, 4.5, 'green');
    a.windows(s * 37, -15.2, 3.1, a.fine ? 8 : 6, 3, a.fine ? 4.7 : 6.1, 5.5, 2.1, 3.8);
    for (let i = 0; i < 9; i++) {
      const x = s * 37 + (i - 4) * 4.8;
      a.cylinder(x, -16.4, 2.5, 0.52, 17.3, 'light', 0.88, a.fine ? 12 : 6);
      a.box(x, -16.4, 19.5, 1.55, 1.55, 0.75, 'stone');
    }
    a.box(s * 54, -1, 1, 11, 34, 24, 'light'); a.dome(s * 54, -1, 25, 7.8, 4, 'green');
  }
  a.box(0, 7, 1, 31, 17, 26, 'light');
  a.arch(0, -13.8, 1, 30, 26, 3.8, 8, 'light', 0, true);
  a.arch(0, -18, 1, 24, 23.5, 0.6, 0.5, 'gold');
  a.cylinder(0, 3, 27, 13.5, 5, 'light', 1, 16); a.dome(0, 3, 32, 13, 11.5, 'green');
  a.cylinder(0, 3, 43, 2.7, 3.4, 'light', 1, 8); a.dome(0, 3, 46.4, 3, 2.2, 'green'); a.finial(0, 3, 48.6, 0.6, false);
  for (let i = 0; i < 16; i++) { const t = i * Math.PI / 8; a.arch(Math.sin(t) * 13.6, 3 - Math.cos(t) * 13.6, 27.7, 1.8, 3.9, 0.25, 0.3, 'stone', t, true); }
  // The bronze tree is the palace's key visual feature: actual branching tubes.
  a.beam([0, -18.8, 1.2], [0, -18.8, 16.3], 1, 'bronze', 0.45);
  for (let i = 0; i < (a.fine ? 23 : 13); i++) {
    const t = i * 2.39996, z = 7 + (i % 8) * 1.3;
    const start: [number, number, number] = [0, -18.8, z];
    const mid: [number, number, number] = [Math.cos(t) * (3.8 + i % 3), -18.8 + Math.sin(t) * 0.35, 15 + Math.sin(t) * 4];
    const end: [number, number, number] = [Math.cos(t) * (7.8 + i % 2), -18.8 + Math.sin(t) * 0.6, 16 + Math.sin(t) * 6];
    a.beam(start, mid, 0.3, 'bronze', 0.55); a.beam(mid, end, 0.18, 'bronze', 0.1);
    if (a.fine) a.beam(mid, [end[0] * 0.8, end[1], end[2] + 2.3], 0.12, 'bronze', 0.08);
  }
}

function familyCenter(a: Architecture) {
  a.cylinder(0, 0, 0, 35, 1.2, 'stone', 1, a.radial);
  a.cylinder(0, 0, 1.2, 21, 2, 'light');
  a.cylinder(0, 0, 3.2, 13, 12.5, 'glass');
  for (let i = 0; i < 8; i++) {
    const t = i * Math.PI / 4, c = Math.cos(t), s = Math.sin(t);
    a.beam([c * 20, s * 20, 2.5], [c * 11, s * 11, 16], 1.3, 'bronze', 0.7);
    a.beam([c * 20, s * 20, 2.5], [c * 18, s * 18, 15.5], 0.9, 'gold', 0.45);
  }
  a.lathe(0, 0, 13, [[0, 0], [10, 0], [13, 1.2], [17, 3.5], [21, 7], [23.5, 12], [24, 16], [23.7, 17], [21.7, 17], [21.7, 15.5]], 'gold', 'cauldron');
  a.ring(0, 0, 29.5, 24.3, 21.7, 1, 'bronze');
  a.cylinder(0, 0, 30, 21.6, 0.45, 'stone');
  a.ring(0, 0, 30.45, 22.8, 22.5, 1.2, 'gold');
  const count = a.fine ? 56 : 24;
  for (let i = 0; i < count; i++) {
    const t = i * Math.PI * 2 / count, c = Math.cos(t), s = Math.sin(t);
    const p = [[12.9, 14.2], [17.2, 16.6], [21.2, 20.2], [23.7, 25], [24.1, 29]];
    for (let j = 1; j < p.length; j++) a.beam([c * p[j - 1][0], s * p[j - 1][0], p[j - 1][1]], [c * p[j][0], s * p[j][0], p[j][1]], a.fine ? 0.13 : 0.18, 'bronze');
  }
  for (let i = 0; i < 24; i++) { const t = i * Math.PI / 12; a.cylinder(Math.cos(t) * 12.9, Math.sin(t) * 12.9, 4, 0.15, 9, 'gold', 1, 5); }
}

function university(a: Architecture) {
  // Main academic building, not the parallel dormitories: OSM way 308285819.
  // The verified bent footprint is retained; the elevations are authored.
  const footprint: [number, number][] = [[-52.98, -1.17], [-41.77, 43.34], [-40.28, 49.21], [-28.75, 95.02], [7.47, 86.21], [-8.1, 23.52], [18.45, -15.58], [47.51, -55.15], [52.98, -66.61], [10.71, -95.02], [5.5, -83.56], [-22.72, -43.8], [-43.84, -14.05], [-48.28, -7.9]];
  const shape = new THREE.Shape(footprint.map(([x, y]) => new THREE.Vector2(x, y)));
  a.put('university-body', a.geometry('university-body', () => new THREE.ExtrudeGeometry(shape, { depth: 18.5, bevelEnabled: false })), 'glass', { position: [0, 0, 0.8] });
  a.put('university-roof', a.geometry('university-roof', () => new THREE.ExtrudeGeometry(shape, { depth: 0.7, bevelEnabled: false })), 'light', { position: [0, 0, 19.3] });
  a.put('university-base', a.geometry('university-base', () => new THREE.ExtrudeGeometry(shape, { depth: 0.8, bevelEnabled: false })), 'stone');
  for (let i = 0; i < footprint.length; i++) {
    const p = footprint[i], q = footprint[(i + 1) % footprint.length];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    for (let level = 0; level < 5; level++) a.box(mx, my, 1 + level * 3.65, length, 0.6, 0.6, level ? 'wood' : 'light', angle);
    a.box(mx, my, 19.7, length + 0.6, 1.1, 0.5, 'light', angle);
    const bays = Math.max(1, Math.floor(length / (a.fine ? 2.8 : 6)));
    for (let bay = 0; bay <= bays; bay++) {
      const t = bay / bays, x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
      a.box(x, y, 1, 0.18, 0.65, 18.3, bay % 4 ? 'light' : 'wood', angle);
    }
    if (length > 15) a.beam([p[0] * 0.96, p[1] * 0.96, 0.8], [p[0], p[1], 20.3], 0.75, 'light');
  }
  if (a.fine) for (let i = 0; i < 7; i++) a.box(-23 + i * 5, -8 - i * 6, 20, 3.2, 5, 1.2, 'shadow', -0.9);
}

function popov(a: Architecture) {
  a.cylinder(0, 0, 0, 67, 0.7, 'stone', 1, a.radial);
  a.cylinder(0, 0, 0.7, 32.5, 0.18, 'grass', 1, a.radial);
  a.ring(0, 0, 1, 59, 34, 25.2, 'glass');
  for (let floor = 0; floor <= 7; floor++) a.ring(0, 0, 1 + floor * 3.6, 59.5, 33.5, 0.32, 'light');
  a.ring(0, 0, 26.6, 60, 33.2, 1, 'stone');
  const count = a.fine ? 144 : 56;
  for (let i = 0; i < count; i++) {
    const t = i * Math.PI * 2 / count;
    for (const radius of [59.12, 33.82]) a.cylinder(Math.cos(t) * radius, Math.sin(t) * radius, 1, 0.16, 25.3, i % 3 ? 'light' : 'gold', 1, 5);
  }
  for (let i = 0; i < 8; i++) {
    const t = i * Math.PI / 4, x = Math.cos(t) * 46, y = Math.sin(t) * 46;
    a.dome(x, y, 27.6, 10.2, 3, i % 2 ? 'glass' : 'light');
    a.box(Math.cos(t) * 17, Math.sin(t) * 17, 0.9, 3, 34, 0.08, 'stone', t + Math.PI / 2);
  }
  a.box(0, -58, 0.7, 19, 14, 5.4, 'glass'); a.box(0, -62, 6.1, 24, 12, 0.7, 'light');
  for (const x of [-9, 9]) a.cylinder(x, -66, 0.7, 0.22, 5.4, 'light', 1, 6);
}

function whiteMosque(a: Architecture) {
  a.box(0, 0, 0, 102, 86, 0.7, 'stone');
  a.box(0, -19, 0.72, 34, 33, 0.12, 'water');
  a.box(0, 22, 0.7, 29, 26, 14.5, 'light');
  a.cylinder(0, 22, 15.2, 9.5, 2.6, 'light', 1, 16); a.dome(0, 22, 17.8, 9.3, 10, 'light'); a.finial(0, 22, 27.8, 0.8);
  for (const s of [-1, 1]) {
    a.box(s * 27, 22, 0.7, 24, 21, 10.2, 'light');
    a.cylinder(s * 27, 22, 10.9, 6, 2, 'light'); a.dome(s * 27, 22, 12.9, 6.3, 5.4, 'light'); a.finial(s * 27, 22, 18.3, 0.55);
    minaret(a, s * 19.5, 9, 46.5, 1.7, true);
    a.arch(s * 27, 11.4, 1.2, 8.1, 8.7, 0.9, 1.4, 'light', 0, true);
    a.box(s * 44, -7, 7.4, 5.8, 55, 0.8, 'light');
    for (let i = 0; i < 10; i++) a.arch(s * 44, -32 + i * 5.5, 0.7, 5.5, 6.7, 0.55, 2, 'light', Math.PI / 2);
  }
  a.arch(0, 8.4, 0.7, 15, 14, 1.6, 3.2, 'light', 0, true);
  a.arch(0, 6.6, 0.7, 10.7, 11.3, 0.35, 0.5, 'gold');
  a.box(0, -37, 7.4, 93, 5.8, 0.8, 'light');
  for (let i = 0; i < 16; i++) a.arch(-42 + i * 5.6, -37, 0.7, 5.6, 6.7, 0.55, 2, 'light');
  a.windows(0, 35.2, 4, 3, 1, 7, 0, 3.4, 7, Math.PI);
  for (let i = 0; i < 8; i++) { const t = i * Math.PI / 4; a.arch(Math.sin(t) * 9.5, 22 - Math.cos(t) * 9.5, 15.4, 1.5, 2.3, 0.2, 0.2, 'gold', t, true); }
}

const FACTORIES: Record<string, (architecture: Architecture) => void> = {
  QolSharif: qolSharif, SuyumbikeTower: suyumbike, SpasskayaTower: spasskaya,
  FarmersPalace: farmersPalace, KazanFamilyCenter: familyCenter,
  InnopolisUniversity: university, PopovTechnopark: popov, WhiteMosqueBolgar: whiteMosque,
};

/** Each call returns independently owned geometries/materials, safe to dispose. */
export function createLandmarkModel(kind: string, detail: LandmarkDetail = 'high'): THREE.Group {
  const factory = FACTORIES[kind];
  if (!factory) throw new Error(`Unknown landmark model: ${kind}`);
  const architecture = new Architecture(detail);
  factory(architecture);
  return architecture.finish(kind);
}

export function disposeLandmarkModel(group: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      geometries.add(object.geometry);
      (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => materials.add(material));
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  group.clear();
}
