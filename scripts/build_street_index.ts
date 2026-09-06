import fs from 'node:fs';
import path from 'node:path';
import {normalizeStreet} from '../src/lib/street-geocoding';
import type {StreetIndex,StreetRecord} from '../src/lib/street-geocoding';

// This query is a public city-wide extract. It never reads the incidents database or private files.
const query='[out:json][timeout:90];area(3600367666)->.city;way["highway"]["name"](area.city);out body geom;';
const dir=path.join(process.cwd(),'data','public');
const rawFile=path.join(dir,'kazan-streets-osm.json');
const indexFile=path.join(dir,'kazan-street-index.json');
type Way={id:number;nodes:number[];tags:Record<string,string>;geometry:{lat:number;lon:number}[]};
type Extract={elements:Way[];osm3s?:{timestamp_osm_base?:string};remark?:string;atlasFetchedAt?:string;atlasSourceUrl?:string};
let raw:Extract;
if(fs.existsSync(rawFile)&&!process.argv.includes('--refresh'))raw=JSON.parse(fs.readFileSync(rawFile,'utf8'));
else {
  let failure:unknown;
  for(const endpoint of ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter']){
    try {
      const response=await fetch(`${endpoint}?data=${encodeURIComponent(query)}`,{signal:AbortSignal.timeout(55000),headers:{'User-Agent':'SberAtlas-public-city-street-index/0.1'}});
      if(!response.ok)throw new Error(`OSM public source HTTP ${response.status}`);
      raw=await response.json() as Extract;
      if(raw.remark||!Array.isArray(raw.elements)||!raw.elements.length)throw new Error(raw.remark||'Empty city extract');
      raw.atlasFetchedAt=new Date().toISOString();raw.atlasSourceUrl=`${endpoint}?data=${encodeURIComponent(query)}`;
      fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(rawFile,JSON.stringify(raw));failure=undefined;break;
    }catch(error){failure=error;}
  }
  if(failure)throw failure;
}
const ways=raw!.elements.filter(way=>way.tags?.name&&way.nodes?.length>=2&&way.geometry?.length>=2);
const byName=new Map<string,Way[]>();
for(const way of ways){const n=normalizeStreet(way.tags['name:ru']||way.tags.name);const key=`${n.kind||''}:${n.name}`;const list=byName.get(key)||[];list.push(way);byName.set(key,list);}
const streets:StreetRecord[]=[];
for(const namedWays of byName.values()){
  const owners=new Map<number,number[]>();namedWays.forEach((way,i)=>way.nodes.forEach(node=>{const list=owners.get(node)||[];list.push(i);owners.set(node,list);}));
  const visited=new Set<number>();
  for(let start=0;start<namedWays.length;start++){
    if(visited.has(start))continue;
    const queue=[start],component:Way[]=[];visited.add(start);
    while(queue.length){const index=queue.pop()!,way=namedWays[index];component.push(way);for(const node of way.nodes)for(const neighbour of owners.get(node)||[])if(!visited.has(neighbour)){visited.add(neighbour);queue.push(neighbour);}}
    const lines=component.map(way=>way.geometry.map(point=>[point.lon,point.lat]));
    const all=lines.flat();const largest=[...lines].sort((a,b)=>b.length-a.length)[0];
    const center=largest[Math.floor(largest.length/2)] as [number,number];
    const main=[...component].sort((a,b)=>a.id-b.id)[0];const name=main.tags['name:ru']||main.tags.name;
    const aliases=[...new Set(component.flatMap(way=>['name','name:ru','alt_name','old_name','short_name','loc_name'].flatMap(key=>(way.tags[key]||'').split(';').filter(Boolean))))];
    const sourceUrls=component.map(way=>`https://www.openstreetmap.org/way/${way.id}`);
    streets.push({id:`osm-street-${main.id}`,name,kind:normalizeStreet(name).kind,aliases,territoryId:'mo-92701000',coordinates:center,
      geometry:lines.length===1?{type:'LineString',coordinates:lines[0]}:{type:'MultiLineString',coordinates:lines},
      bbox:[Math.min(...all.map(p=>p[0])),Math.min(...all.map(p=>p[1])),Math.max(...all.map(p=>p[0])),Math.max(...all.map(p=>p[1]))],sourceUrl:sourceUrls[0],sourceUrls});
  }
}
const index:StreetIndex={schemaVersion:1,territoryId:'mo-92701000',checkedAt:raw!.atlasFetchedAt||new Date().toISOString(),sourceUrl:raw!.atlasSourceUrl||'https://www.openstreetmap.org/relation/367666',sourceKind:'osm-full-ways',osmBase:raw!.osm3s?.timestamp_osm_base,streets,limitations:['OSM names and connected road ways, not an address register or current repair status.','Disconnected homonymous components require manual review.','No private incidents or addresses are read by this script.']};
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(indexFile,JSON.stringify(index));
console.log(JSON.stringify({publicWays:ways.length,streetComponents:streets.length,distinctNames:byName.size,checkedAt:index.checkedAt,indexFile}));
