import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {getRegionConfig} from '../src/lib/regions';
import {normalizeStreet,type StreetIndex,type StreetRecord} from '../src/lib/street-geocoding';

// Public OSM geometries only. No incident text or client identifier leaves this process.
const regionId=process.argv[2]||'RU-TA',config=getRegionConfig(regionId);
const rawFile=process.argv[3]||'data/public/tatarstan-streets-osm.json';
type XY=[number,number];
type Place={id:string;name:string;kind:string;parentId:string|null;administrativeCenterName?:string;geometry?:GeoJSON.Polygon|GeoJSON.MultiPolygon};
type Way={id:number;nodes:number[];tags:Record<string,string>;geometry:{lon:number;lat:number}[]};
type Piece=Way&{owner:Place;part:number};
const raw=JSON.parse(fs.readFileSync(rawFile,'utf8')) as {elements:Way[];atlasFetchedAt?:string;partial?:boolean;coverageCells?:number;expectedCells?:number};
const places=JSON.parse(fs.readFileSync(config.territories,'utf8')) as Place[];
const byId=new Map(places.map(p=>[p.id,p]));
const bins=new Map<string,{place:Place;polygons:GeoJSON.Position[][][]}[]>();
function inside(point:XY,ring:GeoJSON.Position[]){let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
for(const place of places){
 if(!place.geometry||place.kind==='region')continue;
 const polygons=place.geometry.type==='Polygon'?[place.geometry.coordinates]:place.geometry.coordinates;
 const coords=polygons.flat(2);let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
 for(const [x,y] of coords){west=Math.min(west,x);east=Math.max(east,x);south=Math.min(south,y);north=Math.max(north,y);}
 for(let x=Math.floor(west*5);x<=Math.floor(east*5);x++)for(let y=Math.floor(south*5);y<=Math.floor(north*5);y++){const key=x+':'+y;const list=bins.get(key)||[];list.push({place,polygons});bins.set(key,list);}
}
function owner(point:XY){return (bins.get(Math.floor(point[0]*5)+':'+Math.floor(point[1]*5))||[]).filter(v=>v.polygons.some(p=>inside(point,p[0])&&!p.slice(1).some(h=>inside(point,h)))).sort((a,b)=>Number(b.place.kind==='settlement')-Number(a.place.kind==='settlement'))[0]?.place;}
const named=new Map<string,Piece[]>();let wayCount=0;
for(const way of raw.elements){
 if(!way.tags?.name||!way.geometry?.length||!way.nodes)continue;
 let current:Piece|undefined,part=0;
 for(let i=1;i<way.geometry.length;i++){
  const a=way.geometry[i-1],b=way.geometry[i];const place=owner([(a.lon+b.lon)/2,(a.lat+b.lat)/2]);
  if(!place){current=undefined;continue;}
  if(current?.owner.id===place.id){current.geometry.push(b);current.nodes.push(way.nodes[i]);continue;}
  current={...way,owner:place,part:part++,geometry:[a,b],nodes:[way.nodes[i-1],way.nodes[i]]};
  const n=normalizeStreet(way.tags['name:ru']||way.tags.name),key=place.id+'|'+n.kind+'|'+n.name;
  const list=named.get(key)||[];list.push(current);named.set(key,list);
 }
 if(part)wayCount++;
}
const streets:StreetRecord[]=[];
for(const ways of named.values()){
 const nodes=new Map<number,number[]>();ways.forEach((w,i)=>w.nodes.forEach(n=>{const v=nodes.get(n)||[];v.push(i);nodes.set(n,v);}));const visited=new Set<number>();
 for(let first=0;first<ways.length;first++){
  if(visited.has(first))continue;
  const queue=[first],component:Piece[]=[];visited.add(first);
  while(queue.length){const w=ways[queue.pop()!];component.push(w);for(const n of w.nodes)for(const i of nodes.get(n)||[])if(!visited.has(i)){visited.add(i);queue.push(i);}}
  const main=component.toSorted((a,b)=>a.id-b.id||a.part-b.part)[0];const lines=component.map(w=>w.geometry.map(p=>[p.lon,p.lat] as XY));const longest=lines.toSorted((a,b)=>b.length-a.length)[0];
  const scopeIds:string[]=[];let place:Place|undefined=main.owner;while(place&&!scopeIds.includes(place.id)){scopeIds.push(place.id);place=place.parentId?byId.get(place.parentId):undefined;}
  let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;for(const line of lines)for(const [x,y] of line){west=Math.min(west,x);east=Math.max(east,x);south=Math.min(south,y);north=Math.max(north,y);}
  const name=main.tags['name:ru']||main.tags.name,sourceUrls=[...new Set(component.map(w=>'https://www.openstreetmap.org/way/'+w.id))];
  streets.push({id:`osm-street-${main.id}-${main.owner.id}-${main.part}`,name,kind:normalizeStreet(name).kind,aliases:[...new Set(component.flatMap(w=>['name','name:ru','name:tt','alt_name','old_name','loc_name'].flatMap(k=>(w.tags[k]||'').split(';').filter(Boolean))))],territoryId:main.owner.id,scopeIds,coordinates:longest[Math.floor(longest.length/2)],geometry:lines.length===1?{type:'LineString',coordinates:lines[0]}:{type:'MultiLineString',coordinates:lines},bbox:[west,south,east,north],sourceUrl:sourceUrls[0],sourceUrls});
 }
}
// A partial regional refresh must not discard verified pilot coverage.
if(config.fallbackStreetIndex&&fs.existsSync(config.fallbackStreetIndex)){
 const fallback=JSON.parse(fs.readFileSync(config.fallbackStreetIndex,'utf8')) as StreetIndex;
 const keys=new Set(streets.map(s=>s.territoryId+'|'+normalizeStreet(s.name).name));
 for(const street of fallback.streets)if(!keys.has(street.territoryId+'|'+normalizeStreet(street.name).name))streets.push(street);
}
if(!streets.length)throw new Error('No regional streets matched: previous index is preserved');
const index:StreetIndex={schemaVersion:1,territoryId:regionId,regionId,partial:raw.partial??true,checkedAt:raw.atlasFetchedAt||new Date().toISOString(),sourceUrl:'https://www.openstreetmap.org',sourceKind:'osm-full-ways',territories:places.map(p=>({id:p.id,name:p.name,parentId:p.parentId,aliases:[...(config.aliases as Record<string,string[]>)[p.id]||[],...(p.administrativeCenterName?[p.administrativeCenterName.replace(/^(г|с|д|п|пгт)\s+/,'')]:[])]})),streets,limitations:['OSM street geometry is not a building address register.','Disconnected homonyms require review.','Coverage completeness is recorded separately from matching.']};
// An optional staging path lets coverage refreshes be validated before release.
const output=path.resolve(process.argv[4]||config.streetIndex);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output+'.tmp',JSON.stringify(index));fs.renameSync(output+'.tmp',output);
// Rebuilding street geometry must retain source-locality disambiguation.
if(regionId==='RU-TA'&&fs.existsSync('data/public/tatarstan-places-osm.json')){
 const python=fs.existsSync('data/public/.venv/bin/python')?'data/public/.venv/bin/python':'python3';
 const result=spawnSync(python,['scripts/build_locality_index.py','--streets',output,'--territories',config.territories,...(process.argv[4]?['--output',output+'.localities.json']:[])],{encoding:'utf8',timeout:60_000});
 if(result.status!==0)throw new Error('Street locality index refresh failed: '+(result.stderr||result.error?.message||'unknown error'));
}
console.log(JSON.stringify({ways:wayCount,streetComponents:streets.length,coveredTerritories:new Set(streets.map(s=>s.territoryId)).size,partial:index.partial,output}));
