import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {all,db,hasTable,safeJson} from './db';
import {appPath,appRoot} from './runtime-paths';
import {ensureLocationSchema,publicOrganizationIndex,sourceOrganizationLocation} from './organization-locations';
import type {AddressCandidate,OrganizationLocation,LocationPoint} from './planning-types';
import type {Coordinates,Mode} from './types';

export const CLIENT_ADDRESS_TEMPLATE='inn;name;gosb;address;addressKind;longitude;latitude\r\n';
export const CLIENT_ADDRESS_MAX_BYTES=5*1024*1024;
export type ClientAddressInput={row:number;inn:string;name:string;gosb:string;address:string;addressKind:string;longitude:string;latitude:string};
export type ClientAddressPreviewRow=ClientAddressInput&{orgId:string|null;portfolioName?:string;status:'ready'|'unlocated'|'candidate'|'preserved'|'rejected'|'duplicate';valid:boolean;matched:boolean;located:boolean;message:string;coordinates:Coordinates|null};
export type ClientAddressImportResult={total:number;valid:number;located:number;matched:number;rejected:number;errors:string[];rows:ClientAddressPreviewRow[];applied:boolean;fileHash:string;changed?:number;importId?:string};
type PreviewRecord={expires:number;planHash:string};
const globalPreview=globalThis as unknown as {atlasClientAddressPreviews?:Map<string,PreviewRecord>};
const previews=globalPreview.atlasClientAddressPreviews??=new Map<string,PreviewRecord>();
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const text=(value:unknown)=>String(value??'').trim();
const header=(value:unknown)=>text(value).toLocaleLowerCase('ru-RU').replace(/[\s_-]/g,'');
const aliases:Record<string,string>={inn:'inn','инн':'inn',name:'name','название':'name','наименование':'name','наименованиеорганизации':'name',gosb:'gosb','госб':'gosb',address:'address','адрес':'address',addresskind:'addressKind','типадреса':'addressKind',longitude:'longitude','долгота':'longitude',lng:'longitude',latitude:'latitude','широта':'latitude',lat:'latitude'};
const identifier=(value:unknown)=>text(value).replace(/^'/,'').replace(/\.0$/,'');
const samePoint=(a:LocationPoint|AddressCandidate,b:LocationPoint|AddressCandidate)=>a.address===b.address&&JSON.stringify(a.coordinates)===JSON.stringify(b.coordinates);

export async function parseClientAddressFile(filename:string,payload:Buffer):Promise<ClientAddressInput[]>{
  if(payload.length>CLIENT_ADDRESS_MAX_BYTES)throw new Error('Файл должен быть не больше 5 МБ.');
  const extension=path.extname(filename).toLowerCase();if(!['.csv','.xlsx'].includes(extension))throw new Error('Выберите CSV или XLSX.');
  const python=process.env.ATLAS_PYTHON||'python3';
  const parsed=await new Promise<{headers:unknown[];rows:unknown[][]}>((resolve,reject)=>{
    const child=spawn(python,[appPath('scripts','parse_client_addresses.py'),extension.slice(1)],{cwd:appRoot,stdio:['pipe','pipe','pipe']});
    let stdout='',overflow=false;const timer=setTimeout(()=>{child.kill();reject(new Error('Чтение файла заняло слишком много времени.'));},12_000);
    child.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>12*1024*1024){overflow=true;child.kill();}});
    // Parser diagnostics never include uploaded client records in server logs.
    child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',()=>{clearTimeout(timer);reject(new Error('Локальный обработчик файлов недоступен.'));});
    child.on('close',code=>{clearTimeout(timer);if(overflow){reject(new Error('Файл содержит слишком много данных.'));return;}
      try{const value=JSON.parse(stdout);if(code!==0||value.error)throw new Error(typeof value.error==='string'?value.error:'Не удалось прочитать файл.');if(!Array.isArray(value.headers)||!Array.isArray(value.rows))throw new Error('Некорректная таблица.');resolve(value);}catch(error){reject(error instanceof Error?error:new Error('Не удалось прочитать файл.'));}});
    child.stdin.end(payload);
  });
  const headers=parsed.headers.map(value=>aliases[header(value)]||'');
  if(!headers.includes('inn')||!headers.includes('address'))throw new Error('Нужны столбцы inn (ИНН) и address (адрес).');
  const mapped=headers.filter(Boolean);if(new Set(mapped).size!==mapped.length)throw new Error('Один столбец шаблона указан несколько раз.');
  return parsed.rows.map((values,index)=>{
    const row:ClientAddressInput={row:index+2,inn:'',name:'',gosb:'',address:'',addressKind:'legal',longitude:'',latitude:''};
    headers.forEach((key,i)=>{if(key)(row as unknown as Record<string,unknown>)[key]=text(values[i]);});
    row.inn=identifier(row.inn);row.gosb=identifier(row.gosb);return row;
  });
}
function blank(orgId:string):OrganizationLocation{return {orgId,status:'unlocated',legalAddress:null,office:null,meeting:null,candidates:[],updatedAt:null,note:'Адрес импортирован локально. Место встречи требует отдельного подтверждения.'};}
function coordinate(lng:string,lat:string):Coordinates|null{
  if(!lng&&!lat)return null;
  if(!lng||!lat)throw new Error('Долгота и широта должны быть заполнены вместе.');
  const values=[lng,lat].map(v=>v.replace(',','.'));
  if(!values.every(v=>/^-?\d+(?:\.\d+)?$/.test(v)))throw new Error('Координаты должны быть числами.');
  const point=values.map(Number) as Coordinates;
  if(Math.abs(point[0])>180||Math.abs(point[1])>90||point.every(v=>v===0))throw new Error('Координаты вне допустимого диапазона.');
  return point;
}
export function previewClientAddresses(mode:Mode,inputs:ClientAddressInput[],fileHash:string):ClientAddressImportResult{
  if(mode!=='work')throw new Error('Адреса клиентов доступны только в рабочем режиме.');
  if(inputs.length>5000)throw new Error('Можно импортировать не больше 5000 строк.');
  const organizations=hasTable('organizations')?all<{id:string;inn:string;name:string;gosb:string}>('SELECT id,inn,name,gosb FROM organizations'):[];
  const byInn=new Map<string,typeof organizations>();for(const org of organizations){const list=byInn.get(org.inn)||[];list.push(org);byInn.set(org.inn,list);}
  const saved=hasTable('organization_locations')?new Map(all<{org_id:string;data_json:string}>('SELECT org_id,data_json FROM organization_locations').map(r=>[r.org_id,safeJson<OrganizationLocation|null>(r.data_json,null)])):new Map<string,OrganizationLocation|null>();
  const index=publicOrganizationIndex();
  const effective=new Map<string,OrganizationLocation>();
  const seen=new Set<string>();
  const rows=inputs.map(input=>{
    const row:ClientAddressPreviewRow={...input,orgId:null,status:'rejected',valid:false,matched:false,located:false,message:'',coordinates:null};
    try{
      if(!/^(\d{10}|\d{12})$/.test(row.inn))throw new Error('ИНН должен содержать 10 или 12 цифр без округления.');
      if(!row.address||row.address.length>1000)throw new Error('Укажите адрес длиной до 1000 символов.');
      row.addressKind=({legal:'legal',office:'office','юридический':'legal','офис':'office'} as Record<string,string>)[row.addressKind.toLowerCase()]||row.addressKind;
      if(!['legal','office'].includes(row.addressKind))throw new Error('Тип адреса должен быть legal или office.');
      row.coordinates=coordinate(row.longitude,row.latitude);
      const matches=(byInn.get(row.inn)||[]).filter(org=>!row.gosb||org.gosb===row.gosb);
      row.matched=matches.length>0;
      if(!matches.length)throw new Error('ИНН и ГОСБ не найдены в клиентском портфеле.');
      if(matches.length>1)throw new Error('ИНН встречается в нескольких записях. Укажите ГОСБ.');
      row.orgId=matches[0].id;row.portfolioName=matches[0].name;
      const signature=JSON.stringify([row.orgId,row.addressKind,row.address,row.coordinates]);
      if(seen.has(signature)){row.status='duplicate';row.message='Повтор строки в файле пропущен.';return row;}seen.add(signature);
      const previous=saved.get(row.orgId)??effective.get(row.orgId)??sourceOrganizationLocation(matches[0],index);effective.set(row.orgId,previous);
      const current=previous[row.addressKind==='legal'?'legalAddress':'office'];
      row.valid=true;row.located=Boolean(row.coordinates);row.status=row.coordinates?'ready':'unlocated';
      row.message=row.coordinates?'Адрес и координаты из файла; точное совпадение ИНН.':'Адрес сохранится без точки на карте.';
      if(current?.confirmedByUser){row.status='preserved';row.located=false;row.message='Ручной адрес сохранится; импорт будет кандидатом.';}
      else if(current&&!samePoint(current,{address:row.address,coordinates:row.coordinates} as LocationPoint)){
        row.status='candidate';row.located=false;row.message='Другой адрес уже сохранён; импорт будет кандидатом.';
      }else if(previous?.candidates?.some(candidate=>candidate.addressKind===row.addressKind&&!samePoint(candidate,{address:row.address,coordinates:row.coordinates} as LocationPoint))){
        row.status='candidate';row.located=false;row.message='Есть неоднозначные кандидаты; требуется выбор адреса.';
      }
    }catch(error){row.message=error instanceof Error?error.message:'Некорректная строка.';}
    return row;
  });
  const groups=new Map<string,ClientAddressPreviewRow[]>();for(const row of rows){if(!row.valid||!row.orgId)continue;const key=row.orgId+'|'+row.addressKind;const list=groups.get(key)||[];list.push(row);groups.set(key,list);}
  for(const group of groups.values())if(group.length>1)for(const row of group){if(row.status!=='preserved')row.status='candidate';row.located=false;row.message='В файле несколько разных адресов одного типа; сохранятся кандидатами.';}
  return {total:rows.length,valid:rows.filter(r=>r.valid).length,located:rows.filter(r=>r.located).length,matched:rows.filter(r=>r.matched).length,rejected:rows.filter(r=>!r.valid).length,errors:rows.filter(r=>r.status==='rejected').map(r=>`Строка ${r.row}: ${r.message}`),rows,applied:false,fileHash};
}
function planHash(result:ClientAddressImportResult){return hash(JSON.stringify(result.rows));}
export async function importClientAddresses(mode:Mode,filename:string,payload:Buffer,apply=false):Promise<ClientAddressImportResult>{
  if(mode!=='work')throw new Error('Адреса клиентов доступны только в рабочем режиме.');
  const fileHash=hash(payload),inputs=await parseClientAddressFile(filename,payload),result=previewClientAddresses(mode,inputs,fileHash);
  for(const [key,item] of previews)if(item.expires<Date.now())previews.delete(key);
  if(!apply){if(previews.size>=20)previews.delete(previews.keys().next().value!);previews.set(fileHash,{expires:Date.now()+30*60_000,planHash:planHash(result)});return result;}
  const preview=previews.get(fileHash);
  if(!preview||preview.expires<Date.now())throw new Error('Сначала проверьте предпросмотр этого файла.');
  if(preview.planHash!==planHash(result))throw new Error('Адреса или портфель изменились. Повторите предпросмотр.');
  if(!result.valid)throw new Error('В файле нет строк, доступных для импорта.');
  ensureLocationSchema();let changed=0;const importId=randomUUID();
  const sourceIndex=publicOrganizationIndex();
  const organizations=new Map(all<{id:string;inn:string;name:string}>('SELECT id,inn,name FROM organizations').map(org=>[org.id,org]));
  const now=new Date().toISOString(),sourceNote=`Локальный импорт ${path.basename(filename).slice(0,180)}; координаты не геокодировались и не передавались наружу.`;
  const save=db().prepare('INSERT INTO organization_locations(org_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at');
  const read=db().prepare('SELECT data_json,updated_at FROM organization_locations WHERE org_id=?');
  db().transaction(()=>{
    if(planHash(previewClientAddresses(mode,inputs,fileHash))!==preview.planHash)throw new Error('Адреса изменились. Повторите предпросмотр.');
    ensureImportSchema();
    const originals=new Map<string,unknown>();
    for(const row of result.rows){if(row.valid&&row.orgId&&!originals.has(row.orgId))originals.set(row.orgId,read.get(row.orgId)||null);}
    db().prepare('INSERT INTO client_address_imports(id,file_hash,file_name,applied_at,row_count,previous_locations_json) VALUES(?,?,?,?,?,?)').run(importId,fileHash,path.basename(filename).slice(0,180),now,result.valid,JSON.stringify(Object.fromEntries(originals)));
    for(const row of result.rows){
    if(!row.valid||!row.orgId)continue;
    const stored=read.get(row.orgId) as {data_json:string}|undefined;
    const initial=sourceOrganizationLocation(organizations.get(row.orgId)!,sourceIndex);
    const location=stored?safeJson<OrganizationLocation>(stored.data_json,initial):initial;
    const point:LocationPoint={address:row.address,coordinates:row.coordinates,precision:row.coordinates?'site':'territory',sourceUrl:'',checkedAt:now,confirmedByUser:false,note:sourceNote,requiresMeetingConfirmation:true};
    if(['candidate','preserved'].includes(row.status)){
      const candidate:AddressCandidate={...point,id:'import-'+fileHash.slice(0,16)+'-'+row.row,name:row.name,inn:row.inn,addressKind:row.addressKind as 'legal'|'office',autoMatchEligible:false};
      if(!location.candidates.some(c=>samePoint(c,candidate)&&c.addressKind===candidate.addressKind))location.candidates.push(candidate);
      if(!location.legalAddress&&!location.office&&!location.meeting)location.status='candidate';
    }else{
      location[row.addressKind==='legal'?'legalAddress':'office']=point;
      if(![location.legalAddress,location.office,location.meeting].some(p=>p?.confirmedByUser))location.status=[location.legalAddress,location.office,location.meeting].some(p=>p?.coordinates)?'source_exact':'candidate';
    }
    location.updatedAt=now;location.note=sourceNote+' Место встречи требует подтверждения.';
    save.run(row.orgId,JSON.stringify(location),now);changed++;
  }
    const applied=new Map([...originals.keys()].map(id=>[id,read.get(id)||null]));
    db().prepare('UPDATE client_address_imports SET applied_locations_json=? WHERE id=?').run(JSON.stringify(Object.fromEntries(applied)),importId);
  }).immediate();
  previews.delete(fileHash);return {...result,applied:true,changed,importId};
}

function ensureImportSchema(){
  db().exec('CREATE TABLE IF NOT EXISTS client_address_imports(id TEXT PRIMARY KEY,file_hash TEXT NOT NULL,file_name TEXT NOT NULL,applied_at TEXT NOT NULL,row_count INTEGER NOT NULL,previous_locations_json TEXT NOT NULL,applied_locations_json TEXT,reverted_at TEXT)');
  const columns=new Set(all<{name:string}>('PRAGMA table_info(client_address_imports)').map(column=>column.name));
  if(!columns.has('applied_locations_json'))db().exec('ALTER TABLE client_address_imports ADD COLUMN applied_locations_json TEXT');
  if(!columns.has('reverted_at'))db().exec('ALTER TABLE client_address_imports ADD COLUMN reverted_at TEXT');
}
/** Restore only this import's writes. Any later address edit stops the entire restore. */
export function restoreClientAddressImport(mode:Mode,importId:string){
  if(mode!=='work')throw new Error('Адреса клиентов доступны только в рабочем режиме.');
  if(!hasTable('client_address_imports'))throw new Error('Импорт не найден.');
  ensureImportSchema();
  return db().transaction(()=>{
    const record=db().prepare('SELECT previous_locations_json,applied_locations_json,reverted_at FROM client_address_imports WHERE id=?').get(importId) as {previous_locations_json:string;applied_locations_json:string|null;reverted_at:string|null}|undefined;
    if(!record)throw new Error('Импорт не найден.');
    if(record.reverted_at)return {restored:true,changed:0};
    if(!record.applied_locations_json)throw new Error('Этот импорт не содержит снимка для безопасной отмены.');
    type Row={data_json:string;updated_at:string}|null;
    const previous=JSON.parse(record.previous_locations_json) as Record<string,Row>,applied=JSON.parse(record.applied_locations_json) as Record<string,Row>;
    const read=db().prepare('SELECT data_json,updated_at FROM organization_locations WHERE org_id=?');
    for(const [id,expected] of Object.entries(applied))if(JSON.stringify(read.get(id)||null)!==JSON.stringify(expected))throw new Error('После импорта адреса изменились. Отмена остановлена, чтобы сохранить новые правки.');
    const save=db().prepare('INSERT INTO organization_locations(org_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at');
    for(const [id,row] of Object.entries(previous)){if(row)save.run(id,row.data_json,row.updated_at);else db().prepare('DELETE FROM organization_locations WHERE org_id=?').run(id);}
    db().prepare('UPDATE client_address_imports SET reverted_at=? WHERE id=?').run(new Date().toISOString(),importId);
    return {restored:true,changed:Object.keys(previous).length};
  }).immediate();
}
