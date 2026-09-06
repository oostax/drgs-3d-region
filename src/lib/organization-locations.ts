import { publicDataPath } from './runtime-paths';
import fs from 'node:fs';
import path from 'node:path';
import {all,db,hasTable,one,safeJson} from './db';
import type {Coordinates,Mode,Precision} from './types';
import type {AddressCandidate,LocationInput,LocationPoint,OrganizationLocation} from './planning-types';

const ensured=new WeakSet<object>();
export function ensureLocationSchema(){const database=db();if(ensured.has(database))return;database.exec('CREATE TABLE IF NOT EXISTS organization_locations(org_id TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at TEXT NOT NULL)');ensured.add(database);}
const normalizedName=(value:string|null|undefined)=>String(value||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^а-яa-z0-9]/g,'');
export function validCoordinates(value:unknown):value is Coordinates{return Array.isArray(value)&&value.length===2&&value.every(v=>typeof v==='number'&&Number.isFinite(v))&&Math.abs(value[0])<=180&&Math.abs(value[1])<=90;}
function safeUrl(value:unknown){if(typeof value!=='string')return '';try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.toString():'';}catch{return '';}}
export function publicOrganizationIndex():AddressCandidate[]{
  const file=process.env.ATLAS_PUBLIC_ORG_INDEX||publicDataPath('organization-addresses.json');
  try{const raw=JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file,'utf8'));if(!Array.isArray(raw))return [];
    return raw.flatMap((row,index)=>{
      if(!row||typeof row.name!=='string'||!row.name.trim()||typeof row.address!=='string'||!row.address.trim()||!safeUrl(row.sourceUrl))return [];
      return [{id:String(row.id||`public-${index}`),name:row.name,inn:typeof row.inn==='string'&&/^(\d{10}|\d{12})$/.test(row.inn)?row.inn:null,address:row.address,coordinates:validCoordinates(row.coordinates)?row.coordinates:null,precision:(['building','street','settlement','territory','site'].includes(row.precision)?row.precision:'territory') as Precision,sourceUrl:safeUrl(row.sourceUrl),coordinateSourceUrl:safeUrl(row.coordinateSourceUrl)||undefined,identitySourceUrl:safeUrl(row.identitySourceUrl)||undefined,checkedAt:typeof row.checkedAt==='string'?row.checkedAt:'',confirmedByUser:false,addressKind:row.addressKind==='office'?'office' as const:'legal' as const,autoMatchEligible:row.autoMatchEligible!==false,legalAddress:typeof row.legalAddress==='string'?row.legalAddress:undefined,note:typeof row.note==='string'?row.note:undefined,requiresMeetingConfirmation:row.meetingPlaceVerified!==true}];
    });
  }catch{return [];}
}
function blank(orgId:string):OrganizationLocation{return {orgId,status:'unlocated',legalAddress:null,office:null,meeting:null,candidates:[],updatedAt:null,note:'Адрес организации не определён. Принадлежность к ГОСБ не задаёт её местоположение.'};}
export function sourceOrganizationLocation(org:{id:string;inn:string;name:string},index:AddressCandidate[]):OrganizationLocation{
  const result=blank(org.id);const exact=index.filter(row=>row.inn!==null&&row.inn===org.inn);
  if(exact.length){
    result.candidates.push(...exact.filter(row=>row.autoMatchEligible===false));
    for(const [kind,key]of [['legal','legalAddress'],['office','office']] as const){const matching=exact.filter(row=>row.addressKind===kind&&row.autoMatchEligible!==false);const unique=new Map(matching.map(row=>[`${row.address}|${JSON.stringify(row.coordinates)}`,row]));if(unique.size===1)result[key]=[...unique.values()][0];else if(unique.size>1)result.candidates.push(...matching);}
    const office=result.office as AddressCandidate|null;if(!result.legalAddress&&office?.legalAddress)result.legalAddress={...office,address:office.legalAddress,coordinates:office.legalAddress===office.address?office.coordinates:null};
    result.status=result.legalAddress||result.office?'source_exact':'candidate';result.note='Точное совпадение ИНН с открытым источником. Юридический адрес и место встречи различаются.';
  }else{result.candidates=index.filter(row=>normalizedName(row.name)===normalizedName(org.name));if(result.candidates.length){result.status='candidate';result.note='Совпало только название. Подтвердите организацию и адрес; кандидат не используется в маршруте.';}}
  return result;
}
export function organizationLocation(mode:Mode,org:{id:string;inn:string;name:string},index=publicOrganizationIndex()):OrganizationLocation|null{
  if(mode==='public')return null;ensureLocationSchema();
  const saved=one<{data_json:string}>('SELECT data_json FROM organization_locations WHERE org_id=?',org.id);
  return saved?safeJson(saved.data_json,sourceOrganizationLocation(org,index)):sourceOrganizationLocation(org,index);
}
export function saveOrganizationLocation(mode:Mode,input:LocationInput){
  if(mode==='public')throw new Error('Адреса клиентов доступны только в рабочем режиме.');
  if(input.confirmed!==true)throw new Error('Подтвердите организацию, адрес и точность координат.');
  if(!['legal','office','meeting'].includes(input.kind)||!input.address.trim()||input.address.length>1000)throw new Error('Укажите корректный адрес.');
  if(input.coordinates!==null&&!validCoordinates(input.coordinates))throw new Error('Координаты должны содержать долготу и широту.');
  if(input.sourceUrl?.trim()&&!safeUrl(input.sourceUrl))throw new Error('Укажите ссылку на источник с http:// или https:// либо оставьте поле пустым.');
  if(!['building','street','settlement','territory','site'].includes(input.precision))throw new Error('Укажите точность адреса.');
  const org=hasTable('organizations')?one<{id:string;inn:string;name:string}>('SELECT id,inn,name FROM organizations WHERE id=?',input.orgId):undefined;if(!org)throw new Error('Организация не найдена.');
  const location=organizationLocation('work',org)!;const now=new Date().toISOString();
  const point:LocationPoint={address:input.address.trim(),coordinates:input.coordinates,precision:input.precision,sourceUrl:safeUrl(input.sourceUrl),checkedAt:now,confirmedByUser:true};
  location[input.kind==='legal'?'legalAddress':input.kind]=point;location.status='verified';location.updatedAt=now;location.note='Адрес подтверждён пользователем локально. Подтверждение адреса не означает согласование встречи.';
  db().prepare('INSERT INTO organization_locations(org_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(org.id,JSON.stringify(location),now);
  return location;
}
export function syncPublicOrganizationLocations(mode:Mode){
  if(mode==='public')throw new Error('Сопоставление доступно только в рабочем режиме.');ensureLocationSchema();
  if(!hasTable('organizations'))return {matched:0,retainedManual:0,candidates:0};
  const index=publicOrganizationIndex();let matched=0,retainedManual=0,candidates=0;
  const save=db().prepare('INSERT INTO organization_locations(org_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at');
  db().transaction(()=>{for(const org of all<{id:string;inn:string;name:string}>('SELECT id,inn,name FROM organizations')){const location=sourceOrganizationLocation(org,index);if(location.status==='unlocated')continue;
    const stored=one<{data_json:string}>('SELECT data_json FROM organization_locations WHERE org_id=?',org.id);const previous=stored?safeJson<OrganizationLocation|null>(stored.data_json,null):null;
    if(previous&&[previous.legalAddress,previous.office,previous.meeting].some(p=>p?.confirmedByUser)){retainedManual++;continue;}
    const now=new Date().toISOString();location.updatedAt=now;save.run(org.id,JSON.stringify(location),now);if(location.status==='source_exact')matched++;else candidates++;
  }})();return {matched,retainedManual,candidates};
}
export function locatedOrganizationIds():string[]{
  ensureLocationSchema();if(!hasTable('organizations'))return [];
  const inns=[...new Set(publicOrganizationIndex().map(row=>row.inn).filter((inn):inn is string=>Boolean(inn)))];
  const saved=all<{org_id:string}>('SELECT org_id FROM organization_locations').map(row=>row.org_id);
  const matches=inns.length?all<{id:string}>(`SELECT id FROM organizations WHERE inn IN (${inns.map(()=>'?').join(',')})`,...inns).map(row=>row.id):[];
  return [...new Set([...saved,...matches])];
}
