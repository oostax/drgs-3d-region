export const MARKER_SPREAD_ZOOM = 15;
export const MARKER_LINK_MAX_PIXELS = 160;
export const MARKER_LINK_MAX_METRES = 250;
const VIEWPORT_MARGIN = 64;
type Projector = {
  getZoom(): number;
  getCanvas(): {clientWidth:number;clientHeight:number};
  project(coordinates: [number,number]): {x:number;y:number};
  unproject(point: [number,number]): {lng:number;lat:number};
};
type PointFeature = GeoJSON.Feature<GeoJSON.Point>;
type Entry = {feature:PointFeature;x:number;y:number;index:number};
const validCoordinates = (coordinates: readonly number[]) => coordinates.length>=2 && coordinates.every(Number.isFinite) && Math.abs(coordinates[0])<=180 && Math.abs(coordinates[1])<=85.051129;
const groundDistance = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0]-b[0])*Math.cos((a[1]+b[1])/2*Math.PI/180),a[1]-b[1])*111_320;

/** Balanced offsets keep every record individually clickable, including identical coordinates. */
export function markerFanOffsets(count: number, separation = 46): [number,number][] {
  if(count<=1) return [[0,0]];
  if(count===2) return [[-separation/2,0],[separation/2,0]];
  if(count===3) return [[-separation,-5],[0,-separation*.8],[separation,-5]];
  const offsets: [number,number][] = [];
  let left = count, ring = 0;
  while(left>0) {
    const capacity = 8 + ring*6, size = Math.min(left,capacity), radius = Math.max(separation*.8,Math.min(count,8)*separation/(Math.PI*2)) + ring*separation;
    for(let index=0;index<size;index++) { const angle = -Math.PI/2+Math.PI*2*index/size+(ring%2?Math.PI/size:0); offsets.push([Math.cos(angle)*radius,Math.sin(angle)*radius]); }
    left-=size;ring++;
  }
  return offsets;
}

/**
 * Only display geometry moves. anchorLng/anchorLat and connector lines retain the real
 * geographic point; card navigation and evidence continue to use the original signal.
 * Run after moveend at street scales, passing the original (unspread) collection.
 */
export function spreadCoincidentMarkers(points: GeoJSON.FeatureCollection<GeoJSON.Point>, map: Projector) {
  const links: GeoJSON.FeatureCollection<GeoJSON.LineString> = {type:'FeatureCollection',features:[]};
  if(map.getZoom()<MARKER_SPREAD_ZOOM) return {points,links};
  const canvas=map.getCanvas(),width=canvas.clientWidth,height=canvas.clientHeight;
  if(!(width>0&&height>0)) return {points,links};
  const project = (coordinates:[number,number]) => { try { return map.project(coordinates); } catch { return null; } };
  const unproject = (point:[number,number]) => { try { return map.unproject(point); } catch { return null; } };
  const inViewport = (point:{x:number;y:number}) => Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=-VIEWPORT_MARGIN&&point.y>=-VIEWPORT_MARGIN&&point.x<=width+VIEWPORT_MARGIN&&point.y<=height+VIEWPORT_MARGIN;
  const maxGroundShift = (latitude:number) => Math.min(MARKER_LINK_MAX_METRES,Math.max(35,40_075_016.686*Math.cos(latitude*Math.PI/180)/(512*2**map.getZoom())*MARKER_LINK_MAX_PIXELS*4));
  const features = [...points.features], groups: Entry[][] = [], cells = new Map<string,number[]>(), cellSize=42;
  const ordered = points.features.map((feature,index)=>({feature,index})).sort((a,b)=>String(a.feature.id??a.feature.properties?.id??a.index).localeCompare(String(b.feature.id??b.feature.properties?.id??b.index)));
  for(const item of ordered) {
    const anchor=item.feature.geometry.coordinates;
    if(!validCoordinates(anchor)) continue;
    const xy = project(anchor as [number,number]);
    if(!xy||!inViewport(xy)) continue;
    // Behind-camera world points can project to finite screen positions at high
    // pitch. Only the visible ground intersection may participate in a fan.
    const inverse=unproject([xy.x,xy.y]); if(!inverse) continue;
    const recovered=[inverse.lng,inverse.lat];
    if(!validCoordinates(recovered)||groundDistance(anchor,recovered)>3) continue;
    const cx=Math.floor(xy.x/cellSize),cy=Math.floor(xy.y/cellSize);
    let target=-1,best=cellSize;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const index of cells.get(`${cx+dx}:${cy+dy}`)??[]) {
      const lead=groups[index][0],distance=Math.hypot(lead.x-xy.x,lead.y-xy.y);
      if(distance<best&&groundDistance(anchor,lead.feature.geometry.coordinates)<=maxGroundShift(anchor[1])) {best=distance;target=index;}
    }
    const entry = {...item,x:xy.x,y:xy.y};
    if(target>=0) groups[target].push(entry);
    else { const index=groups.length;groups.push([entry]);const key=`${cx}:${cy}`;cells.set(key,[...(cells.get(key)??[]),index]); }
  }
  for(const group of groups) {
    if(group.length<2) continue;
    const center={x:group.reduce((sum,item)=>sum+item.x,0)/group.length,y:group.reduce((sum,item)=>sum+item.y,0)/group.length},offsets=markerFanOffsets(group.length);
    for(let index=0;index<group.length;index++) {
      const entry=group[index],feature=entry.feature,anchor=feature.geometry.coordinates,offset=offsets[index];
      const target={x:center.x+offset[0],y:center.y+offset[1]};
      if(!inViewport(target)||Math.hypot(target.x-entry.x,target.y-entry.y)>MARKER_LINK_MAX_PIXELS) continue;
      const location=unproject([target.x,target.y]); if(!location) continue;
      const coordinates=[location.lng,location.lat];
      if(!validCoordinates(coordinates)||groundDistance(anchor,coordinates)>maxGroundShift(anchor[1])) continue;
      const projected=project(coordinates as [number,number]);
      if(!projected||!inViewport(projected)||Math.hypot(projected.x-target.x,projected.y-target.y)>2) continue;
      features[entry.index]={...feature,geometry:{type:'Point',coordinates},properties:{...feature.properties,anchorLng:anchor[0],anchorLat:anchor[1],markerSpread:true,stackSize:group.length}};
      links.features.push({type:'Feature',id:feature.id,properties:{id:feature.properties?.id??feature.id,color:feature.properties?.markerColor??'#698778'},geometry:{type:'LineString',coordinates:[anchor,coordinates]}});
    }
  }
  return {points:{...points,features},links};
}
