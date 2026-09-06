import {all,hasTable} from './db';
import {getTerritories,matchMunicipality,matchesIncidentTerritory} from './atlas-data';
import {currentSourceId} from './source-status';
import {getIncidentStreetIndex} from './incident-geography';
import {matchIncidentStreet} from './street-geocoding';
import type {Mode} from './types';
export function incidentRecords(mode:Mode,territoryId:string,query:string,offset:number){
 if(mode==='public'||!hasTable('incidents'))return {items:[],total:0,unlocated:0};
 const territories=getTerritories();const term=query.trim().toLocaleLowerCase('ru-RU');
 const tracked=hasTable('imports');
 const rows=all<{id:string;municipality:string;settlement:string|null;street:string|null;object:string|null;topic_group:string;topic:string;created_at:string|null;closed_at:string|null;status:string}>(`SELECT id,municipality,settlement,street,object,topic_group,topic,created_at,closed_at,status FROM incidents ${tracked?'WHERE source_id=?':''} ORDER BY created_at DESC,id`,...(tracked?[currentSourceId('incidents')]:[]));
 const selected=rows.filter(r=>matchesIncidentTerritory(r.municipality,r.settlement,territories,territoryId)&&(!term||[r.municipality,r.settlement,r.street,r.object,r.topic_group,r.topic].join(' ').toLocaleLowerCase('ru-RU').includes(term)));
 const start=Number.isFinite(offset)?Math.max(0,Math.floor(offset)):0;
 const index=getIncidentStreetIndex();
 const located=selected.map(r=>({row:r,geolocation:matchIncidentStreet(r.street,r.municipality,index)}));
 const geocoding={streetMatched:located.filter(r=>r.geolocation.status==='matched').length,ambiguous:located.filter(r=>r.geolocation.status==='ambiguous').length,unmatched:located.filter(r=>r.geolocation.status==='unmatched').length};
 return {items:located.slice(start,start+50).map(({row,geolocation})=>({...row,precision:geolocation.precision,coordinateStatus:geolocation.status==='matched'?'street-matched':geolocation.status==='ambiguous'?'needs-review':'not-geocoded',geolocation})),total:selected.length,unlocated:selected.filter(r=>!matchMunicipality(r.municipality,territories)).length,geocoding,geocodingNote:'Сопоставление улицы не устанавливает точный дом или место происшествия. Исторические обращения не подтверждают текущие работы; полные тексты не передаются внешнему геокодеру.'};
}
