import { dataPath } from './runtime-paths';
import fs from 'node:fs';
import {getRegionConfig} from './regions';
import {matchIncidentStreet} from './street-geocoding';
import type {IncidentGeolocation,StreetIndex} from './street-geocoding';

let cached:{file:string;mtime:number;index:StreetIndex}|null=null;
export function getIncidentStreetIndex():StreetIndex|null {
  try {
    const config=getRegionConfig();const regional=dataPath(config.streetIndex),file=fs.existsSync(regional)?regional:dataPath(config.fallbackStreetIndex);
    const mtime=fs.statSync(/* turbopackIgnore: true */ file).mtimeMs;if(cached?.file===file&&cached.mtime===mtime)return cached.index;
    const index=JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file,'utf8')) as StreetIndex;
    if(index.schemaVersion!==1||!Array.isArray(index.streets))return null;
    cached={file,mtime,index};return index;
  }catch{return null;}
}
export type IncidentAggregateRow={municipality:string;topic_group:string;topic?:string|null;settlement?:string|null;street?:string|null;object?:string|null;count:number;firstDate?:string|null;lastDate?:string|null;closedCount?:number;openCount?:number;inProgressCount?:number;lastClosedAt?:string|null};
export type LocatedIncidentGroup=IncidentAggregateRow&{geolocation:IncidentGeolocation;categoryBreakdown:{name:string;count:number}[]};

/** Each record count belongs to exactly one street group or one unresolved territory group. */
export function groupIncidentGeography(rows:readonly IncidentAggregateRow[],index:StreetIndex|null) {
  const groups=new Map<string,LocatedIncidentGroup>();const topics=new Map<string,number>();
  const locations = new Map<string,IncidentGeolocation>();
  const geocoding={streetMatched:0,ambiguous:0,unmatched:0};let count=0;
  for(const row of rows){
    const locationKey=JSON.stringify([row.municipality,row.settlement??null,row.street??null]);
    let geo=locations.get(locationKey);
    if(!geo) { geo=matchIncidentStreet(row.street,row.municipality,index,row.settlement); locations.set(locationKey,geo); }
    const status=geo.status==='matched'?'streetMatched':geo.status;
    geocoding[status]+=row.count;count+=row.count;topics.set(row.topic_group,(topics.get(row.topic_group)||0)+row.count);
    const key=JSON.stringify([row.municipality,row.topic_group,geo.status==='matched'?geo.streetId:null,geo.status==='matched'?null:row.settlement||null,geo.status==='matched'?null:row.street||null,row.object||null]);
    const old=groups.get(key);
    const name=row.topic?.trim()||row.topic_group;
    if(old){old.count+=row.count;old.closedCount=(old.closedCount||0)+(row.closedCount||0);old.openCount=(old.openCount||0)+(row.openCount||0);old.inProgressCount=(old.inProgressCount||0)+(row.inProgressCount||0);if(row.lastClosedAt&&(!old.lastClosedAt||row.lastClosedAt>old.lastClosedAt))old.lastClosedAt=row.lastClosedAt;const category=old.categoryBreakdown.find(item=>item.name===name);if(category)category.count+=row.count;else old.categoryBreakdown.push({name,count:row.count});if(row.firstDate&&(!old.firstDate||row.firstDate<old.firstDate))old.firstDate=row.firstDate;if(row.lastDate&&(!old.lastDate||row.lastDate>old.lastDate))old.lastDate=row.lastDate;}
    else groups.set(key,{...row,geolocation:geo,count:row.count,categoryBreakdown:[{name,count:row.count}]});
  }
  return {groups:[...groups.values()].sort((a,b)=>b.count-a.count),count,geocoding,topics:[...topics].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count)};
}
