import { dataPath } from './runtime-paths';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Signal, Precision } from './types';
import type { LiveConfidence, LiveCoverageItem, LiveEventMeta, LiveEventState, LiveSignal, LiveSignalChangesResponse, LiveSignalsResponse, LiveSourceItem, LiveSourcesResponse, LiveWorkerStatus } from './live-types';
import { publicFile } from './atlas-data';
import {matchesLiveScope} from './live-scope';
import {liveWorkerMessage} from './live-worker-message';
import {DEFAULT_REGION_ID} from './regions';
import {calculateSignalTiming, extractOfficialDeadline, type TimingSample} from './signal-timing';
import {parseSignalUsefulness} from './signal-usefulness-meta';

export const liveDatabasePath=process.env.ATLAS_LIVE_DB||dataPath('data','live','atlas-live.sqlite');
const state=globalThis as unknown as {atlasLiveDatabase?:Database.Database};
function liveDb(){
  if(state.atlasLiveDatabase)return state.atlasLiveDatabase;
  if(!fs.existsSync(/* turbopackIgnore: true */ liveDatabasePath))return null;
  try{const database=new Database(liveDatabasePath,{readonly:true,fileMustExist:true});database.pragma('query_only = ON');database.pragma('busy_timeout = 1500');state.atlasLiveDatabase=database;return database;}catch{return null;}
}
const json=<T>(value:unknown,fallback:T):T=>{try{return typeof value==='string'?JSON.parse(value) as T:fallback;}catch{return fallback;}};
const strings=(value:unknown)=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string').slice(0,50):[];
const point=(lng:unknown,lat:unknown):[number,number]|null=>typeof lng==='number'&&typeof lat==='number'&&Number.isFinite(lng)&&Number.isFinite(lat)&&Math.abs(lng)<=180&&Math.abs(lat)<=90?[lng,lat]:null;
const precision=(value:unknown,coordinates:[number,number]|null):Precision=>{
  const valid=new Set<Precision>(['territory','settlement','street','building','site']);
  return typeof value==='string'&&valid.has(value as Precision)?value as Precision:coordinates?'settlement':'territory';
};
const isoNow=()=>new Date().toISOString();
const legacyState=(signal:Signal):LiveEventState=>signal.closedAt||signal.lifecycle?.status==='completed'?'resolved':signal.lifecycle?.status==='planned'?'planned':signal.lifecycle?.status==='under_construction'?'in_progress':'reported';
function meta(signal:Signal,revision=0):LiveEventMeta {
  if(signal.live)return {...signal.live,revision};
  const last=signal.lifecycle?.asOf||signal.publishedAt||signal.checkedAt;
  return {regionId:DEFAULT_REGION_ID,topic:signal.category,state:legacyState(signal),severity:'medium',confidence:'medium',sourceKind:'official',eventTime:signal.publishedAt||null,lastEvidenceAt:last,lastMeaningfulAt:last,ongoing:['planned','in_progress','paused'].includes(legacyState(signal)),locationConfidence:signal.coordinates?signal.precision:'unknown',evidenceCount:1,duplicateCount:0,revision,activityKind:'generic',explicitActivity:false,notifyEligible:false};
}
function legacyLiveSignals():LiveSignal[]{return publicFile<Signal[]>('signals.json',[]).map(signal=>({...signal,visibility:'public',live:meta(signal)}));}
type EventRow={id:string;legacyId:string|null;regionId:string;territoryId:string|null;title:string;summary:string;category:string;topic:string;state:LiveEventState;severity:LiveEventMeta['severity'];confidence:LiveConfidence;sourceKind:LiveEventMeta['sourceKind'];eventTime:string|null;publishedAt:string;lastEvidenceAt:string;lastMeaningfulAt:string;closedAt:string|null;address:string|null;longitude:number|null;latitude:number|null;precision:Precision;locationConfidence:LiveEventMeta['locationConfidence'];activityKind:LiveEventMeta['activityKind'];explicitActivity:number;notifyEligible:number;dataJson:string;revision:number;evidenceCount:number;documentCount:number};
const SELECT_EVENTS=`SELECT id,legacy_id legacyId,region_id regionId,territory_id territoryId,title,summary,category,topic,state,severity,confidence,source_kind sourceKind,event_time eventTime,published_at publishedAt,last_evidence_at lastEvidenceAt,last_meaningful_at lastMeaningfulAt,closed_at closedAt,address,longitude,latitude,precision,location_confidence locationConfidence,activity_kind activityKind,explicit_activity explicitActivity,notify_eligible notifyEligible,data_json dataJson,revision,(SELECT COUNT(*) FROM event_evidence WHERE event_id=events.id) evidenceCount,(SELECT COUNT(*) FROM event_documents WHERE event_id=events.id) documentCount FROM events`;
function rowSignal(row:EventRow,details=false):LiveSignal{
  const raw=json<Partial<Signal>&{outcome?:LiveEventMeta['outcome']}>(row.dataJson,{}),coordinates=point(row.longitude,row.latitude);
  const base:Signal={
    id:row.legacyId||row.id,title:row.title,summary:row.summary,category:row.category,territoryId:row.territoryId,
    coordinates,precision:precision(row.precision,coordinates),sourceUrl:typeof raw.sourceUrl==='string'?raw.sourceUrl:'',publishedAt:row.publishedAt,
    checkedAt:row.lastEvidenceAt,facts:strings(raw.facts),hypothesis:typeof raw.hypothesis==='string'?raw.hypothesis:'Сигнал требует сопоставления с задачами территории.',
    nextStep:typeof raw.nextStep==='string'?raw.nextStep:'Открыть источники и уточнить текущее состояние.',visibility:'public',
    count:typeof raw.count==='number'?raw.count:undefined,sourceName:typeof raw.sourceName==='string'?raw.sourceName:undefined,closedAt:row.closedAt||undefined,
    organizationInn:typeof raw.organizationInn==='string'?raw.organizationInn:undefined,
    address:row.address||undefined,addressSourceUrl:typeof raw.addressSourceUrl==='string'?raw.addressSourceUrl:undefined,
    coordinateSourceUrl:typeof raw.coordinateSourceUrl==='string'?raw.coordinateSourceUrl:undefined,
    locationVerificationMethod:typeof raw.locationVerificationMethod==='string'?raw.locationVerificationMethod:undefined,
    addressCandidates:strings(raw.addressCandidates),geographyNote:typeof raw.geographyNote==='string'?raw.geographyNote:undefined,
    siteGeometry:raw.siteGeometry,siteBbox:raw.siteBbox,siteZoom:raw.siteZoom,
    lifecycle:raw.lifecycle,categoryBreakdown:Array.isArray(raw.categoryBreakdown)?raw.categoryBreakdown:undefined,
    signalUsefulness:parseSignalUsefulness(raw.signalUsefulness),
    relatedSources:Array.isArray(raw.relatedSources)?raw.relatedSources.filter(item=>item&&typeof item.label==='string'&&typeof item.url==='string').slice(0,20):undefined,
  };
  const live:LiveEventMeta={regionId:row.regionId,topic:row.topic,state:row.state,severity:row.severity,confidence:row.confidence,sourceKind:row.sourceKind,eventTime:row.eventTime,lastEvidenceAt:row.lastEvidenceAt,lastMeaningfulAt:row.lastMeaningfulAt,ongoing:['planned','in_progress','paused'].includes(row.state),locationConfidence:row.locationConfidence,evidenceCount:row.evidenceCount||0,duplicateCount:Math.max(0,(row.documentCount||0)-1),revision:row.revision,activityKind:row.activityKind,explicitActivity:Boolean(row.explicitActivity),notifyEligible:Boolean(row.notifyEligible)};
  if(['problem','improvement','development','information'].includes(String(raw.outcome)))live.outcome=raw.outcome as LiveEventMeta['outcome'];
  const database=details?liveDb():null;
  if(database){
    live.evidence=database.prepare(`SELECT id,document_id documentId,source_id sourceId,label,url,published_at publishedAt,observed_at observedAt,event_time eventTime,quote,source_kind sourceKind,supports FROM event_evidence WHERE event_id=? ORDER BY observed_at DESC LIMIT 50`).all(row.id) as LiveEventMeta['evidence'];
    const hasSourceTime=(database.prepare('PRAGMA table_info(event_history)').all() as {name:string}[]).some(column=>column.name==='source_published_at');
    const readHistory=(id:string)=>database.prepare(`SELECT state,at,label,source_url sourceUrl,${hasSourceTime?'source_published_at':'NULL'} sourcePublishedAt FROM event_history WHERE event_id=? ORDER BY at ASC,id ASC`).all(id) as NonNullable<LiveEventMeta['history']>;
    live.history=readHistory(row.id);
    const candidates=hasSourceTime&&row.state==='in_progress'&&row.territoryId&&row.activityKind!=='generic'?database.prepare(`SELECT id,title,data_json dataJson FROM events WHERE deleted=0 AND state='resolved' AND region_id=? AND territory_id=? AND topic=? AND activity_kind=? AND id<>? ORDER BY last_meaningful_at DESC LIMIT 100`).all(row.regionId,row.territoryId,row.topic,row.activityKind,row.id) as {id:string;title:string;dataJson:string}[]:[];
    const samples:TimingSample[]=candidates.map(item=>({id:item.id,title:item.title,sourceUrl:json<{sourceUrl?:string}>(item.dataJson,{}).sourceUrl||'',history:readHistory(item.id)}));
    const officialEvidence=(live.evidence??[]).filter(item=>['official','utility'].includes(item.sourceKind)&&item.supports!=='dispute'&&item.publishedAt).sort((a,b)=>Date.parse(b.publishedAt!)-Date.parse(a.publishedAt!)||Date.parse(b.observedAt)-Date.parse(a.observedAt));
    const latestOfficial=officialEvidence[0];
    // A document edit can withdraw a deadline. Read the latest stored document,
    // never combine historical evidence quotes into a current commitment.
    const officialDocument=latestOfficial?.documentId?database.prepare('SELECT title,body,excerpt,deleted_at deletedAt FROM documents WHERE id=?').get(latestOfficial.documentId) as {title:string;body:string|null;excerpt:string;deletedAt:string|null}|undefined:undefined;
    const officialText=officialDocument?(officialDocument.deletedAt?'':`${officialDocument.title}\n${officialDocument.body||officialDocument.excerpt}`):latestOfficial?.quote||'';
    const officialDeadline=latestOfficial?extractOfficialDeadline(officialText,latestOfficial.url):null;
    live.timing=calculateSignalTiming(row.state,live.history,samples,officialDeadline,isoNow());
    live.evidenceCount=row.evidenceCount||0;
    live.duplicateCount=Math.max(0,(database.prepare('SELECT COUNT(*) n FROM event_documents WHERE event_id=?').get(row.id) as {n:number}|undefined)?.n??1)-1;
    if(!base.sourceUrl&&live.evidence?.[0]?.url)base.sourceUrl=live.evidence[0].url;
    if(!base.sourceName&&live.evidence?.[0]?.label)base.sourceName=live.evidence[0].label;
  }
  return {...base,live};
}

export type LiveSignalQuery={regionId?:string;territoryIds?:string[];days?:30|45|60;archive?:boolean;bbox?:[number,number,number,number];ongoing?:boolean;category?:string;limit?:number;offset?:number};
function worker(database=liveDb()):LiveWorkerStatus{
  if(!database)return {state:'offline',heartbeatAt:null,lastSuccessAt:null,queueDepth:0,analysisQueueDepth:0,lagSeconds:null,message:'База мониторинга не подключена. Показан сохранённый публичный набор.'};
  const row=database.prepare('SELECT state,heartbeat_at heartbeatAt,last_success_at lastSuccessAt,message FROM worker_state WHERE id=1').get() as {state:LiveWorkerStatus['state'];heartbeatAt:string|null;lastSuccessAt:string|null;message:string}|undefined;
  const queue=(database.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')").get() as {n:number}).n;
  const analysis=(database.prepare("SELECT COUNT(*) n FROM documents WHERE analysis_status IN ('pending','running','rule_based_queued') AND deleted_at IS NULL").get() as {n:number}).n;
  const heartbeat=row?.heartbeatAt?Date.parse(row.heartbeatAt):NaN,lag=Number.isFinite(heartbeat)?Math.max(0,Math.round((Date.now()-heartbeat)/1000)):null;
  const actualState=lag!==null&&lag>180? 'offline':row?.state||'idle';
  return {state:actualState,heartbeatAt:row?.heartbeatAt||null,lastSuccessAt:row?.lastSuccessAt||null,queueDepth:queue,analysisQueueDepth:analysis,lagSeconds:lag,message:actualState==='offline'?'Mac или сборщик сейчас недоступен. Сохранённые сигналы остаются на карте.':liveWorkerMessage(row?.message||'')};
}
function cursor(database=liveDb()){return String(database?(database.prepare('SELECT COALESCE(MAX(revision),0) n FROM revisions').get() as {n:number}).n:0);}
function eventWhere(query:LiveSignalQuery){
  const sql=['deleted=0'],params:(string|number)[]=[];
  sql.push('region_id=?');params.push(query.regionId||DEFAULT_REGION_ID);
  sql.push('published_at<=?');params.push(isoNow());
  if(query.territoryIds?.length){sql.push(`territory_id IN (${query.territoryIds.map(()=>'?').join(',')})`);params.push(...query.territoryIds);}
  if(!query.archive){
  const cutoff=new Date(Date.now()-(query.days||45)*86_400_000).toISOString();sql.push(query.ongoing?"(state='planned' OR published_at>=? OR (state IN ('in_progress','paused') AND last_meaningful_at>=?))":"(state='planned' OR published_at>=?)");params.push(cutoff);if(query.ongoing)params.push(new Date(Date.now()-30*86_400_000).toISOString());
  }
  if(query.category){sql.push('category=?');params.push(query.category);}
  if(query.bbox){sql.push('longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ?');params.push(query.bbox[0],query.bbox[2],query.bbox[1],query.bbox[3]);}
  return {sql:sql.join(' AND '),params};
}
export function liveSignalSnapshot(query:LiveSignalQuery={}):LiveSignalsResponse{
  const database=liveDb(),asOf=isoNow();
  if(!database){const all=legacyLiveSignals().filter(s=>matchesLiveScope(s,query));const offset=Math.max(0,query.offset||0),limit=Math.min(1000,Math.max(1,query.limit||500));return {signals:all.slice(offset,offset+limit),cursor:'0',asOf,total:all.length,hasMore:offset+limit<all.length,worker:worker(null)};}
  return database.transaction(()=>{
    const where=eventWhere(query),limit=Math.min(1000,Math.max(1,query.limit||500)),offset=Math.max(0,query.offset||0);
    const total=(database.prepare(`SELECT COUNT(*) n FROM events WHERE ${where.sql}`).get(...where.params) as {n:number}).n;
    const rows=database.prepare(`${SELECT_EVENTS} WHERE ${where.sql} ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,ROW_NUMBER() OVER(PARTITION BY territory_id ORDER BY last_evidence_at DESC,id),last_evidence_at DESC,id LIMIT ? OFFSET ?`).all(...where.params,limit,offset) as EventRow[];
    return {signals:rows.map(row=>rowSignal(row)),cursor:cursor(database),asOf,total,hasMore:offset+limit<total,worker:worker(database)};
  })();
}
export function liveSignalChanges(query:LiveSignalQuery,after:string):LiveSignalChangesResponse{
  const database=liveDb(),asOf=isoNow();if(!database)return {upserts:[],removed:[],cursor:'0',asOf,reset:true,worker:worker(null)};
  return database.transaction(()=>{
    const start=Number(after),end=Number(cursor(database));if(!Number.isSafeInteger(start)||start<0||start>end)return {upserts:[],removed:[],cursor:String(end),asOf,reset:true,worker:worker(database)};
    const changes=database.prepare('SELECT revision,event_id eventId,operation,notify_eligible notifyEligible FROM revisions WHERE revision>? AND revision<=? ORDER BY revision LIMIT 2001').all(start,end) as {revision:number;eventId:string;operation:string;notifyEligible:number}[];
    if(changes.length>2000)return {upserts:[],removed:[],cursor:String(end),asOf,reset:true,worker:worker(database)};
    const latest=new Map<string,{revision:number;operation:string;notifyEligible:number}>();for(const item of changes){const prior=latest.get(item.eventId);latest.set(item.eventId,{...item,notifyEligible:Number(Boolean(item.notifyEligible||prior?.notifyEligible))});}
    const removed:string[]=[],upserts:LiveSignal[]=[];const where=eventWhere(query);
    for(const [eventId,change] of latest){
      const identity=database.prepare('SELECT COALESCE(legacy_id,id) id FROM events WHERE id=?').get(eventId) as {id:string}|undefined;
      const row=database.prepare(`${SELECT_EVENTS} WHERE id=? AND ${where.sql}`).get(eventId,...where.params) as EventRow|undefined;
      if(change.operation==='delete'||!row)removed.push(identity?.id||eventId);else{const signal=rowSignal(row);signal.live.notifyEligible=Boolean(change.notifyEligible);upserts.push(signal);}
    }
    return {upserts,removed,cursor:String(end),asOf,reset:false,worker:worker(database)};
  })();
}
export function liveSignalById(id:string){const database=liveDb();if(database){const row=database.prepare(`${SELECT_EVENTS} WHERE id=? OR legacy_id=? OR id=(SELECT event_id FROM event_aliases WHERE alias=?) LIMIT 1`).get(id,id,id) as EventRow|undefined;if(row)return rowSignal(row,true);}const signal=legacyLiveSignals().find(item=>item.id===id);return signal?{...signal,live:{...signal.live,evidence:[{id:`legacy:${id}`,documentId:null,sourceId:null,label:signal.sourceName||'Публичный источник',url:signal.sourceUrl,publishedAt:signal.publishedAt,observedAt:signal.checkedAt||signal.publishedAt,eventTime:signal.publishedAt,sourceKind:signal.live.sourceKind,supports:'report' as const}],history:[]}}:null;}

function sourceItem(row:Record<string,any>):LiveSourceItem{return {id:String(row.id),name:String(row.name),regionId:String(row.regionId||row.region_id||DEFAULT_REGION_ID),territoryId:row.territoryId||row.territory_id||null,url:String(row.url),adapter:({'rss-discovery':'rss','tatarstan-html':'html','vodokanal-incidents':'html'}[row.adapter as string]||row.adapter) as LiveSourceItem['adapter'],sourceKind:(row.sourceKind||row.source_kind) as LiveSourceItem['sourceKind'],status:String(row.status).replaceAll('-','_') as LiveSourceItem['status'],intervalSeconds:Number(row.intervalSeconds||row.interval_seconds)||3600,languages:strings(row.languages||json(row.languagesJson||row.languages_json,[])),topics:strings(row.topics||json(row.topicsJson||row.topics_json,[])),coverageTerritoryIds:strings(row.coverageTerritoryIds||row.coverage_territory_ids||json(row.coverageJson||row.coverage_json,[])?.map?.((entry:any)=>typeof entry==='string'?entry:entry.territory_id)||row.coverage?.map((entry:{territory_id?:string})=>entry.territory_id)),fetchAllowed:Boolean(row.fetchAllowed??row.fetch_allowed),aiAllowed:Boolean(row.aiAllowed??row.ai_allowed),displayAllowed:Boolean(row.displayAllowed??row.display_allowed),rightsNote:String(row.rightsNote||row.rights_note||''),provenanceUrl:String(row.provenanceUrl||row.provenance_url||row.url),lastAttemptAt:row.lastAttemptAt||row.last_attempt_at||null,lastSuccessAt:row.lastSuccessAt||row.last_success_at||null,latestPublicationAt:row.latestPublicationAt||row.latest_publication_at||null,error:row.error||null};}
function sourceRegistry():LiveSourceItem[]{
  const file=dataPath('data','live','sources.json');
  try{
    const value=JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file,'utf8')),rows=(Array.isArray(value)?value:value.sources||[]) as Record<string,any>[];
    return rows.map(sourceItem);
  }catch{return [];}
}
function coverageRegistry():LiveCoverageItem[]{const file=dataPath('data','live','coverage.json');try{const value=JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file,'utf8'));return (Array.isArray(value)?value:value.coverage||[]) as LiveCoverageItem[];}catch{return [];}}
export function liveSources():LiveSourcesResponse{
  const database=liveDb();let sources=sourceRegistry(),coverage=coverageRegistry();
  if(database){sources=database.prepare(`SELECT id,name,region_id regionId,territory_id territoryId,url,adapter,source_kind sourceKind,status,interval_seconds intervalSeconds,languages_json languagesJson,topics_json topicsJson,coverage_json coverageJson,fetch_allowed fetchAllowed,ai_allowed aiAllowed,display_allowed displayAllowed,rights_note rightsNote,provenance_url provenanceUrl,last_attempt_at lastAttemptAt,last_success_at lastSuccessAt,latest_publication_at latestPublicationAt,error FROM sources ORDER BY name`).all().map((row:any)=>sourceItem(row));}
  const links=database?database.prepare('SELECT territory_id,source_id,coverage_level FROM source_coverage').all() as {territory_id:string;source_id:string;coverage_level:string}[]:[];
  if(database)coverage=coverage.map(item=>{
    const entries=links.filter(link=>link.territory_id===item.territoryId),ids=entries.map(link=>link.source_id);
    const available=sources.filter(source=>ids.includes(source.id)&&source.fetchAllowed&&source.lastSuccessAt);
    const latest=(values:(string|null)[])=>values.filter((v):v is string=>Boolean(v)).sort().at(-1)??null;
    const success=latest(available.map(s=>s.lastSuccessAt)),published=latest(available.map(s=>s.latestPublicationAt));
    const healthy=available.some(s=>s.status==='active'&&Date.now()-Date.parse(s.lastSuccessAt!)<=Math.max(3600,s.intervalSeconds*3)*1000);
    const level:LiveCoverageItem['level']=entries.some(e=>e.coverage_level==='direct')?'direct':entries.some(e=>e.coverage_level.includes('district'))?'inherited_district':entries.length?'inherited_region':'missing';
    return {...item,sourceIds:ids,level,lastSuccessAt:success,latestPublicationAt:published,health:!entries.length?'missing':!healthy?'unavailable':!published||Date.now()-Date.parse(published)>7*86400000?'quiet':'active'};
  });
  const direct=coverage.filter(item=>item.level==='direct').length,inherited=coverage.filter(item=>item.level.startsWith('inherited')).length,missing=coverage.filter(item=>item.level==='missing').length;
  return {sources,coverage,worker:worker(database),summary:{candidates:sources.length,active:sources.filter(item=>item.status==='active').length,territories:coverage.length,direct,inherited,missing}};
}
const csvCell=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;
export function liveSourcesCsv(){const {sources}=liveSources();const keys:(keyof LiveSourceItem)[]=['id','name','regionId','territoryId','url','adapter','sourceKind','status','intervalSeconds','languages','topics','coverageTerritoryIds','fetchAllowed','aiAllowed','displayAllowed','rightsNote','provenanceUrl','lastAttemptAt','lastSuccessAt','latestPublicationAt','error'];return '\uFEFF'+[keys.join(','),...sources.map(source=>keys.map(key=>csvCell(Array.isArray(source[key])?(source[key] as string[]).join('|'):source[key])).join(','))].join('\n');}
