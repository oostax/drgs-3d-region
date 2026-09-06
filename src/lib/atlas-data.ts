import {organizationSupplement} from './supplemental-data';
import { publicDataPath } from './runtime-paths';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import { all, one, hasTable, safeJson, db } from './db';
import { canonicalSourceName, currentSourceId, offerSourceSelection } from './source-status';
import {organizationLocation,publicOrganizationIndex} from './organization-locations';
import {getIncidentStreetIndex,groupIncidentGeography} from './incident-geography';
import type {IncidentAggregateRow} from './incident-geography';
import type { AtlasPayload, Territory, Signal, BankOffice, Manifest, Mode, Organization, Offer } from './types';

const cache = new Map<string,{mtime:number;data:unknown}>();
const lowerRegistered = new WeakSet<object>();
function ensureUnicodeSearch() {
  const database = db();
  if (lowerRegistered.has(database)) return;
  database.function('atlas_lower', {deterministic:true}, (value:unknown) => String(value??'').toLocaleLowerCase('ru-RU'));
  lowerRegistered.add(database);
}
function selectedOffers(snapshot:string,alias='') {
  const prefix=alias?`${alias}.`:'';
  const selection=offerSourceSelection(snapshot);
  return {sql:`${prefix}snapshot=?${selection.tracked?` AND ${prefix}source_id=?`:''}`,params:[snapshot,...(selection.tracked?[selection.sourceId]:[])]};
}
export function publicFile<T>(name:string, fallback:T):T {
  const file = publicDataPath(name);
  try {
    const mtime = fs.statSync(/* turbopackIgnore: true */ file).mtimeMs;
    const previous = cache.get(file);
    if(previous?.mtime===mtime) return previous.data as T;
    const data=JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file,'utf8'));
    cache.set(file,{mtime,data});return data;
  } catch { return fallback; }
}
export function getTerritories():Territory[] {
  const items=publicFile<Territory[]>('territories.json',[]);
  if(!items.some(t=>t.id==='RU-TA')) items.unshift({id:'RU-TA',name:'Татарстан',kind:'region',parentId:null,center:[50.9,55.4],bbox:[47.2,53.9,54.3,56.8],geometryStatus:'missing',sourceUrl:'https://16.rosstat.gov.ru/list_of_municipalities'});
  return items;
}
const normalize=(s:string)=>s.toLowerCase().replace(/ё/g,'е').replace(/городской округ|муниципальный район|муниципальный округ|городское поселение|сельское поселение|республика|татарстан|район|город|г\.о\.|м\.р\.|г\./g,'').replace(/[^а-яa-z0-9]/g,'');
export function descendantIds(territories:Territory[],id:string) {
  const ids=new Set([id]);let changed=true;
  while(changed){changed=false;for(const t of territories)if(t.parentId&&ids.has(t.parentId)&&!ids.has(t.id)){ids.add(t.id);changed=true;}}
  return ids;
}
export function matchMunicipality(label:string, territories:Territory[]) {
  const n=normalize(label);
  return territories.find(t=>['district','urban_district'].includes(t.kind)&&normalize(t.name)===n)
    || territories.find(t=>t.id==='mo-92701000'&&n==='казань')
    || territories.find(t=>t.id==='mo-92730000'&&n==='набережныечелны');
}
export function matchesIncidentTerritory(municipality:string,settlement:string|null|undefined,territories:Territory[],territoryId:string) {
  if(territoryId==='RU-TA'||territoryId==='RU')return true;
  const selected=territories.find(t=>t.id===territoryId);
  if(!selected)return false;
  const parent=matchMunicipality(municipality,territories);
  if(selected.kind==='settlement')return parent?.id===selected.parentId&&normalize(settlement||'')===normalize(selected.name);
  return parent?.id===selected.id;
}
const topicsAdvice:Record<string,[string,string]>={
  'ЖКХ':['Обсудить планы модернизации коммунальной инфраструктуры и расчётные сервисы оператора.','Установить ответственного оператора и проверить утверждённые мероприятия, сроки и источники финансирования.'],
  'Благоустройство':['Обсудить муниципальные проекты общественных пространств и обслуживание подрядчиков.','Проверить планы работ и закупки; определить заказчика и подрядчиков до формирования предложения.'],
  'Дороги':['Проверить проекты ремонта дорог и возможные потребности подрядчиков в гарантиях и расчётах.','Сопоставить обращения с планом дорожных работ и действующими контрактами.'],
  'Образование':['Обсудить оснащение учреждений и цифровые сервисы для образовательной инфраструктуры.','Уточнить учреждение, планы закупок и действующих поставщиков.'],
  'Общественный транспорт':['Обсудить обновление транспорта и доступность безналичной оплаты.','Уточнить оператора перевозок и муниципальную программу.'],
};
function internalSignals(territories:Territory[],territoryId:string):{signals:Signal[];count:number;topics:{name:string;count:number}[]} {
  if(!hasTable('incidents'))return {signals:[],count:0,topics:[]};
  ensureUnicodeSearch();
  const tracked=hasTable('imports');
  const columns=new Set(all<{name:string}>('PRAGMA table_info(incidents)').map(column=>column.name));
  const field=(name:string)=>columns.has(name)?name:`NULL AS ${name}`;
  const date=(name:string)=>columns.has('created_at')?`${name==='firstDate'?'MIN':'MAX'}(created_at) AS ${name}`:`NULL AS ${name}`;
  const closed=columns.has('closed_at')?`SUM(CASE WHEN NULLIF(TRIM(closed_at),'') IS NOT NULL OR lower(COALESCE(status,''))='closed' THEN 1 ELSE 0 END) AS closedCount,SUM(CASE WHEN NULLIF(TRIM(closed_at),'') IS NULL AND lower(COALESCE(status,''))!='closed' THEN 1 ELSE 0 END) AS openCount,MAX(closed_at) AS lastClosedAt`:'0 AS closedCount,COUNT(*) AS openCount,NULL AS lastClosedAt';
  const working=columns.has('data_json')&&columns.has('closed_at')?`SUM(CASE WHEN NULLIF(TRIM(closed_at),'') IS NULL AND COALESCE(status,'')!='closed' AND (atlas_lower(json_extract(data_json,'$.first_response')) LIKE '%приня%в работу%' OR lower(COALESCE(status,''))='in_progress') THEN 1 ELSE 0 END) AS inProgressCount`:'0 AS inProgressCount';
  const groups=all<IncidentAggregateRow>(`SELECT municipality,topic_group,${field('topic')},settlement,${field('street')},${field('object')},${date('firstDate')},${date('lastDate')},${closed},${working},COUNT(*) count FROM incidents ${tracked?'WHERE source_id=?':''} GROUP BY municipality,topic_group,settlement${columns.has('topic')?',topic':''}${columns.has('street')?',street':''}${columns.has('object')?',object':''}`,...(tracked?[currentSourceId('incidents')]:[]));
  const grouped=groupIncidentGeography(groups.filter(g=>matchesIncidentTerritory(g.municipality,g.settlement,territories,territoryId)),getIncidentStreetIndex());
  const signals=grouped.groups.map(g=>{
    const t=matchMunicipality(g.municipality,territories);
    const advice=topicsAdvice[g.topic_group]||['Проверить муниципальные инициативы по этой теме и определить подходящие сервисы.','Уточнить ответственные организации, действующие проекты и потребности на встрече.'];
    const geo=g.geolocation;const located=geo.status==='matched';
    const dates=g.firstDate&&g.lastDate?`${g.firstDate.slice(0,10)} — ${g.lastDate.slice(0,10)}`:'июль 2026';
    const addressParts=located?[g.object]:[g.settlement,g.street,g.object];
    const addressId=addressParts.some(Boolean)?':address-'+createHash('sha256').update(JSON.stringify(addressParts)).digest('hex').slice(0,12):'';
    const base:Signal={id:`incident:${t?.id||encodeURIComponent(g.municipality)}:${encodeURIComponent(g.topic_group)}${located?`:${geo.streetId}`:''}${addressId}`,title:`${g.topic_group}: ${located?geo.streetName:g.settlement||g.municipality}${g.object?` · ${g.object}`:""}`,summary:`${g.count.toLocaleString('ru-RU')} обращений · ${dates}. ${located?'Улица найдена; точные адреса не подтверждены.':'Остаток без однозначной уличной привязки.'}`,category:g.topic_group,territoryId:t?.id||'RU-TA',coordinates:located?geo.coordinates:t?.center||null,precision:located?'street':'territory',sourceUrl:'',sourceName:'Обращения жителей · июль 2026',publishedAt:g.lastDate||'2026-07-31',checkedAt:located?geo.checkedAt||'':'',facts:[`${g.count} записей в предоставленной выгрузке за период ${dates}.`,located?`География: ${g.municipality}, ${geo.streetName}. ${geo.note}`:`География: ${g.municipality}. Это тематический остаток без однозначного адреса, не точка происшествия.`,`Исторические обращения за июль 2026 года не подтверждают текущие дорожные работы или действующую чрезвычайную ситуацию.`],hypothesis:advice[0],nextStep:located?`${advice[1]} Проверить конкретный участок и текущий статус; найденное название улицы не устанавливает место каждой записи.`:advice[1],visibility:'private',count:g.count,categoryBreakdown:g.categoryBreakdown};
    if(located){base.address=geo.streetName||g.street||undefined;base.siteGeometry=geo.geometry!;base.siteBbox=geo.bbox!;base.siteZoom=15;base.coordinateSourceUrl=geo.sourceUrl||undefined;base.locationVerificationMethod=geo.method;base.geographyNote=geo.note;base.relatedSources=geo.sourceUrls.slice(0,8).map((url,i)=>({label:`Геометрия улицы OSM ${i+1}`,url}));base.lifecycle={status:'unknown',asOf:base.publishedAt,sourceUrl:'',currentStatusVerified:false,animationEligible:false,note:'Исторический агрегат обращений, сгруппированный по найденной улице. Текущий объект или фронт работ не подтверждён.'};}
    base.residentReport={openCount:g.openCount||0,inProgressCount:g.inProgressCount||0,closedCount:g.closedCount||0,firstAt:g.firstDate||null,lastAt:g.lastDate||null};
    const statusSummary=g.openCount?`${g.openCount.toLocaleString('ru-RU')} не закрыто, ${(g.closedCount||0).toLocaleString('ru-RU')} закрыто`:`${(g.closedCount||g.count).toLocaleString('ru-RU')} закрыто`;
    base.summary=`${g.count.toLocaleString('ru-RU')} обращений · ${statusSummary} · ${dates}. ${located?'Улица найдена; точные адреса не подтверждены.':'Остаток без однозначной уличной привязки.'}`;
    // A mixed group is never declared closed because just one constituent ended.
    if(g.closedCount===g.count&&g.lastClosedAt)base.closedAt=g.lastClosedAt;
    return base;
  });
  return {signals,count:grouped.count,topics:grouped.topics};
}
export function atlasPayload(mode:Mode, territoryId='RU-TA',snapshot='current', options:{residentSignals?:boolean}={}):AtlasPayload {
  const territories=getTerritories();const ids=descendantIds(territories,territoryId);
  const allSignals=publicFile<Signal[]>('signals.json',[]).map(s=>({...s,visibility:'public' as const}));
  const allOffices=publicFile<BankOffice[]>('bank-offices.json',[]);
  const regional=territoryId==='RU-TA'||territoryId==='RU';
  const signals=regional?allSignals:allSignals.filter(s=>s.territoryId&&ids.has(s.territoryId));
  const offices=regional?allOffices:allOffices.filter(o=>o.territoryId&&ids.has(o.territoryId));
  const manifest=publicFile<Manifest>('manifest.json',{sources:[],coverage:{},limitations:['Географические источники подготавливаются.']});
  const payload:AtlasPayload={mode,territories:territories.map(({geometry,...t})=>t),signals,offices,manifest,summary:{incidents:null,offers:null,organizations:null,expectedIncome:null,meetings:null,imported:0},topics:[],snapshot,territoryId};
  // Public mode returns before the private SQLite store is opened.
  if(mode==='public')return payload;
  const internal=options.residentSignals === false ? {signals:[],count:0,topics:[]} : internalSignals(territories,territoryId);payload.signals=[...signals,...internal.signals];payload.topics=internal.topics;
  payload.summary.incidents=options.residentSignals !== false && hasTable('incidents')?internal.count:null;
  if(hasTable('imports'))payload.summary.imported=one<{n:number}>("SELECT COUNT(*) n FROM imports WHERE status='complete'")?.n||0;
  // Portfolio figures are not allocated to municipalities without verified locations.
  if(regional){
    if(hasTable('offers')){const selection=selectedOffers(snapshot);const row=one<{n:number;income:number|null}>(`SELECT COUNT(*) n,SUM(expected_income) income FROM offers WHERE ${selection.sql}`,...selection.params);payload.summary.offers=row?.n??0;payload.summary.expectedIncome=row?.income??null;}
    if(hasTable('organizations'))payload.summary.organizations=one<{n:number}>('SELECT COUNT(*) n FROM organizations')?.n??0;
    if(hasTable('meetings')){const row=one<{q1:number;q2:number;q3:number}>('SELECT SUM(q1) q1,SUM(q2) q2,SUM(q3) q3 FROM meetings WHERE COALESCE(conflict,0)=0');payload.summary.meetings=row?[row.q1,row.q2,row.q3]:null;}
  }
  return payload;
}
export function organizations(mode:Mode,query='',snapshot='current',offset=0) {
  if(mode==='public'||!hasTable('organizations'))return {items:[] as Organization[],total:0,unlocated:true};
  ensureUnicodeSearch();
  const term=`%${query.replace(/[\\%_]/g,'\\$&')}%`;
  const where="(atlas_lower(o.name) LIKE atlas_lower(?) ESCAPE '\\' OR o.inn LIKE ? ESCAPE '\\')";
  const total=one<{n:number}>(`SELECT COUNT(*) n FROM organizations o WHERE ${where}`,term,term)?.n||0;
  const offerJoin=hasTable('offers');
  const selection=offerJoin?selectedOffers(snapshot):{sql:'',params:[]};
  const items=all<Organization>(`SELECT o.id,o.inn,o.gosb,o.name,${offerJoin?'COALESCE(f.n,0)':'0'} offerCount,${offerJoin?'f.income':'NULL'} expectedIncome FROM organizations o ${offerJoin?`LEFT JOIN (SELECT org_id,COUNT(*) n,SUM(expected_income) income FROM offers WHERE ${selection.sql} GROUP BY org_id) f ON f.org_id=o.id`:''} WHERE ${where} ORDER BY offerCount DESC,o.name LIMIT 40 OFFSET ?`,...selection.params,term,term,Math.max(0,offset));
  const index=publicOrganizationIndex();
  return {items:items.map(o=>{const location=organizationLocation(mode,o,index)!;return {...o,geoStatus:location.status,location};}),total,unlocated:true};
}
export function organizationDetail(mode:Mode,id:string,snapshot='current'):Organization|null {
  if(mode==='public'||!hasTable('organizations'))return null;
  const org=one<{id:string;inn:string;gosb:string;name:string;data_json:string}>('SELECT * FROM organizations WHERE id=?',id);if(!org)return null;
  const payroll=hasTable('payroll')?one<Organization['payroll']>('SELECT fot_march,fot_july,recipients_march,recipients_july,cumulative_april,cumulative_august FROM payroll WHERE org_id=?',id):undefined;
  const meetings=hasTable('meetings')?one<Organization['meetings']>('SELECT q1,q2,q3,conflict FROM meetings WHERE org_id=?',id):undefined;
  const offers=organizationOffers(id,snapshot);
  const income=offers.map(o=>o.expected_income).filter((v):v is number=>v!==null);
  const offerSource=organizationOfferSource(snapshot,offers);
  const location=organizationLocation(mode,org)!;
  return {...org,details:{...safeJson<Record<string,unknown>>(org.data_json,{}),cardRegistry:organizationSupplement(org.inn,org.gosb)},payroll,meetings,offers:offers.map(offer=>({...offer,sourceLabel:offerSource.label,sourceDateInferred:offerSource.dateInferred})),offerSource,offerChanges:organizationOfferChanges(id,snapshot,offers),offerCount:offers.length,expectedIncome:income.length?income.reduce((a,b)=>a+b,0):null,geoStatus:location.status,location,sourceNames:['Предоставленные локальные выгрузки','Принадлежность к ГОСБ не определяет адрес']};
}

function organizationOffers(id:string,snapshot:string):Offer[] {
  if(!hasTable('offers'))return [];
  const selection=selectedOffers(snapshot);
  return all<Offer>(`SELECT id,offer_id,snapshot,product,amount,expected_income,stage,stage_date FROM offers WHERE org_id=? AND ${selection.sql} ORDER BY expected_income DESC,id`,id,...selection.params);
}
const snapshotLabels:Record<string,string>={current:'Последний срез',q3:'III квартал',q2:'II квартал',q1:'I квартал'};
const historicalScopeNote='Сравнение одной организации по ID предложений. Историческая принадлежность к ГОСБ не подтверждена; изменение не является динамикой портфеля ГОСБ.';
function organizationOfferSource(snapshot:string,offers:Offer[]):NonNullable<Organization['offerSource']> {
  const selection=offerSourceSelection(snapshot);
  const source=selection.sourceId?one<{file_name?:string;period?:string}>('SELECT * FROM imports WHERE id=?',selection.sourceId):undefined;
  const period=safeJson<{snapshot_date?:string;date_inferred?:boolean}>(source?.period,{});
  const date=typeof period.snapshot_date==='string'?period.snapshot_date:null;
  const dateInferred=period.date_inferred===true;
  const label=`${snapshotLabels[snapshot]||snapshot}${date?` · ${date}${dateInferred?' (дата предполагается)':''}`:''}`;
  const qualityNotes:string[]=[];
  if(selection.tracked&&!source)qualityNotes.push('Завершённый источник этого среза не загружен.');
  if(dateInferred)qualityNotes.push('Дата среза предположена по поставке; дата отчётности не подтверждена.');
  if(!date)qualityNotes.push('Дата среза не установлена.');
  if(snapshot!=='current')qualityNotes.push('История отобрана по ИНН пилотных организаций; историческая принадлежность к ГОСБ не подтверждена.');
  const missingIncome=offers.filter(offer=>offer.expected_income===null).length;
  const missingAmount=offers.filter(offer=>offer.amount===null).length;
  if(missingIncome)qualityNotes.push(`Ожидаемый доход не указан у ${missingIncome} предложений; изменение дохода не рассчитывается.`);
  if(missingAmount)qualityNotes.push(`Сумма не указана у ${missingAmount} предложений.`);
  return {snapshot,fileName:source?.file_name?canonicalSourceName(source.file_name):'',date,dateInferred,label,qualityNotes};
}
function organizationOfferChanges(id:string,snapshot:string,offers:Offer[]):NonNullable<Organization['offerChanges']> {
  const comparedSnapshot=({current:'q3',q3:'q2',q2:'q1'} as Record<string,string>)[snapshot]||'';
  const unavailable=(reason:string):NonNullable<Organization['offerChanges']>=>({comparedSnapshot,added:0,removed:0,changed:0,incomeDelta:null,comparable:false,note:`${reason} ${historicalScopeNote}`});
  if(!comparedSnapshot)return unavailable('Предыдущий срез для сравнения не предусмотрен.');
  const previous=organizationOffers(id,comparedSnapshot);
  if(!offers.length||!previous.length)return unavailable('В одном из срезов нет доступных предложений этой организации. Отсутствие данных не означает отсутствие сделок.');
  const byId=(items:Offer[])=>new Map(items.map(offer=>[offer.offer_id,offer]));
  const currentMap=byId(offers),previousMap=byId(previous);
  if(currentMap.size!==offers.length||previousMap.size!==previous.length||[...offers,...previous].some(offer=>!offer.offer_id?.trim()))return unavailable('Есть пустые или повторяющиеся ID предложений; однозначное сравнение невозможно.');
  const keys=['product','amount','expected_income','stage','stage_date'] as const;
  const added=offers.filter(offer=>!previousMap.has(offer.offer_id)).length;
  const removed=previous.filter(offer=>!currentMap.has(offer.offer_id)).length;
  const changed=offers.filter(offer=>{const before=previousMap.get(offer.offer_id);return before&&keys.some(key=>offer[key]!==before[key]);}).length;
  const incomeComplete=[...offers,...previous].every(offer=>offer.expected_income!==null&&Number.isFinite(offer.expected_income));
  const incomeDelta=incomeComplete?Number((offers.reduce((sum,offer)=>sum+offer.expected_income!,0)-previous.reduce((sum,offer)=>sum+offer.expected_income!,0)).toFixed(2)):null;
  return {comparedSnapshot,added,removed,changed,incomeDelta,comparable:true,note:`Изменение определяется по продукту, сумме, ожидаемому доходу, стадии и дате перехода. Появление и исчезновение ID отражает состав выгрузок и не доказывает создание или закрытие сделки. ${!incomeComplete?'Доход указан не полностью; изменение дохода не рассчитано. ':''}${historicalScopeNote}`};
}
