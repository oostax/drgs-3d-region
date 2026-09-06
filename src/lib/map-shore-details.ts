import * as THREE from 'three';
import type { Feature, Geometry } from 'geojson';
import { worldPoint, pointLineDistance } from './map-life-stability';

type XY = [number, number];
type Options = { mobile: boolean; center: XY; radius: number; toLocal: (p: XY) => XY; terrain: (p: XY) => number };
export function insideShorePolygon(p: XY, rings: XY[][]) {
  const inside = (ring: XY[]) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  };
  return !!rings[0]?.length && inside(rings[0]) && !rings.slice(1).some(inside);
}
const polygons = (features: Feature<Geometry>[]) => features.flatMap(f =>
  (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [])
    .map(p => p.map(r => r.map(worldPoint))));

/** Illustrative furniture within mapped sand; mapped piers only, never new coastlines.
 * A world-fixed lattice and shared instance batches keep details stable and bounded. */
export function createShoreDetails(land: Feature<Geometry>[], transportation: Feature<Geometry>[], water: Feature<Geometry>[], options: Options) {
  const group = new THREE.Group(); group.name = 'atlas-shore-details';
  const box = new THREE.BoxGeometry(1, 1, 1), canopy = new THREE.ConeGeometry(1, 1, 8);
  canopy.rotateX(Math.PI / 2);
  type Batch = { geometry: THREE.BufferGeometry; matrices: THREE.Matrix4[]; colors: THREE.Color[] };
  const boxes: Batch = { geometry: box, matrices: [], colors: [] }, umbrellas: Batch = { geometry: canopy, matrices: [], colors: [] };
  const quaternion = new THREE.Quaternion(), axis = new THREE.Vector3(0, 0, 1);
  const add = (batch: Batch, p: XY, z: number, dimensions: [number, number, number], angle: number, color: string) => {
    if (batch.matrices.length >= (options.mobile ? 2400 : 6000)) return;
    quaternion.setFromAxisAngle(axis, angle);
    batch.matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(p[0], p[1], z), quaternion, new THREE.Vector3(...dimensions)));
    batch.colors.push(new THREE.Color(color));
  };
  const origin = options.toLocal(options.center), unitPoint = options.toLocal([options.center[0] + 1, options.center[1]]);
  const scale = Math.hypot(unitPoint[0] - origin[0], unitPoint[1] - origin[1]);
  const waterPolygons = polygons(water), sand = polygons(land.filter(f => ['sand', 'beach'].includes(String(f.properties?.class)) || f.properties?.natural === 'beach'));
  const maxFurniture = options.mobile ? 40 : 110, step = 24 / scale;
  let furniture = 0, piers = 0, plankCount = 0;
  const occupied = new Set<string>();
  // Samples are based on world coordinates, independent of camera and polygon order.
  for (const rings of sand) {
    const outer = rings[0]; if (!outer?.length) continue;
    const minX = Math.max(options.center[0] - options.radius, Math.min(...outer.map(p => p[0])));
    const maxX = Math.min(options.center[0] + options.radius, Math.max(...outer.map(p => p[0])));
    const minY = Math.max(options.center[1] - options.radius, Math.min(...outer.map(p => p[1])));
    const maxY = Math.min(options.center[1] + options.radius, Math.max(...outer.map(p => p[1])));
    for (let x = Math.ceil(minX / step); x <= Math.floor(maxX / step) && furniture < maxFurniture; x++) {
      for (let y = Math.ceil(minY / step); y <= Math.floor(maxY / step) && furniture < maxFurniture; y++) {
        const key = `${x}:${y}`, p: XY = [x * step, y * step];
        const footprint = [[0,0],[-4,-4],[-4,4],[4,-4],[4,4]].map(([dx,dy]) => [p[0]+dx/scale,p[1]+dy/scale] as XY);
        if (occupied.has(key) || !footprint.every(q => insideShorePolygon(q,rings) && !waterPolygons.some(w => insideShorePolygon(q,w)))) continue;
        // Restrict furnishing to the shoreline strip, not inland sand/quarries.
        let distance = Infinity, nearest: XY | null = null;
        for (const polygon of waterPolygons) for (const ring of polygon) for (let i=1;i<ring.length;i++) {
          const a=ring[i-1],b=ring[i],dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
          const q:XY=[a[0]+t*dx,a[1]+t*dy],d=Math.hypot(p[0]-q[0],p[1]-q[1]);
          if(d<distance){distance=d;nearest=q;}
        }
        if (!nearest || distance * scale > 80 || distance * scale < 5) continue;
        occupied.add(key); furniture++;
        const local = options.toLocal(p), z = options.terrain(p), angle = Math.atan2(nearest[1]-p[1],nearest[0]-p[0]);
        const tint = (x+y)%3===0 ? '#819783' : '#eee2bf';
        add(boxes, local, z+1.15, [.09,.09,2.3], 0, '#897459');
        add(umbrellas, local, z+2.4, [1.85,1.85,.65], angle, tint);
        for (const side of [-1,1]) {
          const q:XY=[local[0]-Math.sin(angle)*side*2.2,local[1]+Math.cos(angle)*side*2.2];
          add(boxes,q,z+.3,[2,.72,.16],angle,'#e0cba6');
          add(boxes,[q[0]-Math.cos(angle)*.8,q[1]-Math.sin(angle)*.8],z+.55,[.5,.72,.52],angle,tint);
          for(const end of [-.65,.65]) add(boxes,[q[0]+Math.cos(angle)*end,q[1]+Math.sin(angle)*end],z+.13,[.12,.65,.25],angle,'#8c7960');
        }
      }
    }
  }
  const seenSegments = new Set<string>();
  for (const feature of transportation) {
    if (feature.properties?.class !== 'pier' && feature.properties?.man_made !== 'pier') continue;
    const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [];
    for (const line of lines) {
      const world = line.map(worldPoint);
      if (pointLineDistance(options.center,world)>options.radius) continue;
      const mappedWidth=Number(feature.properties?.width), width=Number.isFinite(mappedWidth)&&mappedWidth>0?Math.min(12,Math.max(1.2,mappedWidth)):3;
      for (let i=1;i<world.length;i++) {
        const a=options.toLocal(world[i-1]),b=options.toLocal(world[i]),length=Math.hypot(b[0]-a[0],b[1]-a[1]);
        if(length<.2 || length>5000) continue;
        const id=[world[i-1],world[i]].map(p=>p.map(n=>n.toFixed(2)).join(',')).sort().join('|');
        if(seenSegments.has(id))continue;seenSegments.add(id);piers++;
        const angle=Math.atan2(b[1]-a[1],b[0]-a[0]),c=Math.cos(angle),s=Math.sin(angle),z=options.terrain(world[i-1]);
        const pos=(d:number,side=0):XY=>[a[0]+c*d-s*side,a[1]+s*d+c*side];
        // Continuous structural deck with transverse boards and low edge beams.
        add(boxes,pos(length/2),z+.42,[length,width,.4],angle,'#887b65');
        for(const side of [-1,1]) add(boxes,pos(length/2,side*(width/2-.06)),z+.69,[length,.12,.14],angle,'#b8a180');
        for(let d=.4;d<length && plankCount<(options.mobile?1400:3500);d+=.8){
          const p=pos(d);if(Math.hypot(p[0]-origin[0],p[1]-origin[1])>options.radius*scale)continue;
          add(boxes,p,z+.64,[Math.min(.77,length-d),width-.28,.06],angle,plankCount%4===0?'#c7b58f':'#bbaa87');plankCount++;
        }
        for(let d=1;d<length;d+=10) for(const side of [-1,1]) {
          const p=pos(d,side*(width/2-.3));
          if(Math.hypot(p[0]-origin[0],p[1]-origin[1])>options.radius*scale)continue;
          add(boxes,p,z-.05,[.25,.25,1.25],angle,'#696958');
          add(boxes,p,z+.82,[.18,.18,.42],angle,'#76776b');
        }
      }
    }
  }
  for (const batch of [boxes,umbrellas]) {
    if(!batch.matrices.length){batch.geometry.dispose();continue;}
    const mesh=new THREE.InstancedMesh(batch.geometry,new THREE.MeshStandardMaterial({roughness:.88}),batch.matrices.length);
    batch.matrices.forEach((m,i)=>{mesh.setMatrixAt(i,m);mesh.setColorAt(i,batch.colors[i]);});
    mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
    mesh.receiveShadow=true;mesh.castShadow=true;mesh.computeBoundingSphere();group.add(mesh);
  }
  group.userData.shore={furniture,piers,planks:plankCount,illustrative:true};
  return group;
}
