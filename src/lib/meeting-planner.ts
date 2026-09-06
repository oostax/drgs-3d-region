import {randomUUID} from 'node:crypto';
import {all,db,hasTable,one,safeJson} from './db';
import {organizationDetail,organizations} from './atlas-data';
import {locatedOrganizationIds,validCoordinates} from './organization-locations';
import {offerSourceSelection,selectedSourceIds} from './source-status';
import {organizationOpportunities} from './opportunities';
import type {Coordinates,Mode} from './types';
import type {ManagerOption,MeetingPlan,PlanInput,PlanningOrganization,PlanningPayload,PlanStop} from './planning-types';

const schemaReady=new WeakSet<object>();
function ensurePlanSchema(){const database=db();if(schemaReady.has(database))return;database.exec('CREATE TABLE IF NOT EXISTS meeting_plans(id TEXT PRIMARY KEY,mode TEXT NOT NULL,content_json TEXT NOT NULL,updated_at TEXT NOT NULL)');schemaReady.add(database);}
const fold=(value:string)=>value.toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/\s+/g,' ').trim();
export function managers(mode:Mode):ManagerOption[]{
  if(mode==='public'||!hasTable('staff'))return [];
  const selected=selectedSourceIds();const allowed=new Set(Object.entries(selected).filter(([kind])=>kind.startsWith('staff:')).map(([,id])=>id));
  const result=new Map<string,ManagerOption>();
  for(const row of all<{employee_id:string|null;data_json:string}>('SELECT employee_id,data_json FROM staff')){const data=safeJson<Record<string,unknown>&{source?:{source_id?:string}}>(row.data_json,{});
    if(!row.employee_id||typeof data.name!=='string'||!allowed.has(data.source?.source_id||''))continue;
    if(![data.division_3,data.division_4,data.division_5].some(v=>String(v||'').toLocaleLowerCase('ru-RU').includes('татарстан')))continue;
    if(!result.has(row.employee_id))result.set(row.employee_id,{id:row.employee_id,name:data.name,role:String(data.assigned_role||data.role||data.position||''),sourceLabel:'Локальный штат · версия источника',assignmentKnown:false});
  }return [...result.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'));
}
function assignedManagers(orgId:string,options:ManagerOption[]):ManagerOption[]{
  if(!hasTable('offers'))return [];
  const columns=all<{name:string}>('PRAGMA table_info(offers)');if(!columns.some(row=>row.name==='data_json'))return [];
  const selected=offerSourceSelection('current');
  const rows=all<{data_json:string}>(`SELECT data_json FROM offers WHERE org_id=? AND snapshot='current'${selected.tracked?' AND source_id=?':''}`,orgId,...(selected.tracked?[selected.sourceId]:[]));
  const names=new Set(rows.map(row=>safeJson<{manager?:unknown}>(row.data_json,{}).manager).filter((name):name is string=>typeof name==='string').map(fold));
  return options.filter(option=>names.has(fold(option.name))).map(option=>({...option,assignmentKnown:true,sourceLabel:'КМ в текущих предложениях; имя совпало со штатом'}));
}
function planningOrganization(id:string,options:ManagerOption[]):PlanningOrganization|null{
  const org=organizationDetail('work',id,'current');if(!org)return null;
  const safeSource=(kind:string)=>{if(!hasTable('imports'))return true;const source=one<{status:string}>('SELECT status FROM imports WHERE kind=? ORDER BY imported_at DESC,rowid DESC LIMIT 1',kind);return !source||source.status==='complete';};
  const rulesOrg={...org,payroll:safeSource('payroll')?org.payroll:undefined,meetings:safeSource('meetings')?org.meetings:undefined};
  return {...org,opportunities:organizationOpportunities(rulesOrg),assignedManagers:assignedManagers(id,options)};
}
export function planningOrganizationDetail(mode:Mode,id:string):PlanningOrganization|null{return mode==='public'?null:planningOrganization(id,managers(mode));}
export function listMeetingPlans(mode:Mode):MeetingPlan[]{if(mode==='public')return [];ensurePlanSchema();return all<{content_json:string}>("SELECT content_json FROM meeting_plans WHERE mode='work' ORDER BY updated_at DESC LIMIT 30").map(row=>safeJson<MeetingPlan|null>(row.content_json,null)).filter((plan):plan is MeetingPlan=>plan!==null);}
export function planningData(mode:Mode,query='',offset=0):PlanningPayload|null{
  if(mode==='public')return null;
  const options=managers(mode);const page=organizations(mode,query,'current',offset);
  const items=page.items.map(org=>planningOrganization(org.id,options)).filter((org):org is PlanningOrganization=>org!==null);
  const located=locatedOrganizationIds().slice(0,80).map(id=>planningOrganization(id,options)).filter((org):org is PlanningOrganization=>org!==null);
  return {organizations:items,total:page.total,locatedOrganizations:located,managers:options,plans:listMeetingPlans(mode),routing:{method:'straight-line-estimate',label:'Оценка по прямой, коэффициенту объезда и заданной скорости'},limits:['Все предложения продуктов — гипотезы для обсуждения; применимость, условия и полномочия клиента требуют проверки.','Даты выгрузок предполагаются. География клиента не выводится из его ГОСБ.','Дорожный маршрутизатор не подключён. Линия и время — расчётная оценка без пробок, перекрытий и расписания КМ.','Время — Москва (UTC+3). Сохранённый план не является согласованной встречей.']};
}
export function distanceKm(a:Coordinates,b:Coordinates){const radians=(value:number)=>value*Math.PI/180;const dlat=radians(b[1]-a[1]),dlon=radians(b[0]-a[0]);const h=Math.sin(dlat/2)**2+Math.cos(radians(a[1]))*Math.cos(radians(b[1]))*Math.sin(dlon/2)**2;return 6371*2*Math.asin(Math.min(1,Math.sqrt(h)));}
function localTime(value:string){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error('Укажите дату и время по Москве.');const parsed=Date.parse(value+':00+03:00');if(!Number.isFinite(parsed)||new Date(parsed+3*3600000).toISOString().slice(0,16)!==value)throw new Error('Дата или время некорректны.');return parsed;}
const asMoscow=(time:number)=>new Date(time+3*3600000).toISOString().slice(0,19)+'+03:00';
export function createMeetingPlan(mode:Mode,input:PlanInput):MeetingPlan{
  if(mode==='public')throw new Error('Планы встреч доступны только в рабочем режиме.');
  if(!input.title.trim()||input.title.length>200||input.orgIds.length<1||input.orgIds.length>12||new Set(input.orgIds).size!==input.orgIds.length)throw new Error('Выберите от 1 до 12 разных организаций и название плана.');
  for(const [value,min,max]of [[input.meetingMinutes,10,240],[input.bufferMinutes,0,120],[input.speedKmh,5,100],[input.detourFactor,1,3]])if(!Number.isFinite(value)||value<min||value>max)throw new Error('Проверьте длительность, буфер, скорость и коэффициент объезда.');
  if(input.startCoordinates!=null&&!validCoordinates(input.startCoordinates))throw new Error('Начальная точка задана некорректно.');
  const start=localTime(input.startAt),options=managers(mode);
  const selected=input.orgIds.map(id=>planningOrganization(id,options));if(selected.some(org=>!org))throw new Error('Одна из организаций не найдена.');
  const locations=selected.map(org=>{const meeting=org!.location?.meeting,office=org!.location?.office;const point=meeting||office;
    if(!point?.coordinates||!validCoordinates(point.coordinates)||!['building','street'].includes(point.precision)||(!point.confirmedByUser&&point.requiresMeetingConfirmation))throw new Error(`Подтвердите место встречи или адрес офиса с точными координатами: ${org!.name}. Юридический адрес не используется автоматически.`);
    return {org:org!,point,kind:(meeting?'meeting':'office') as 'meeting'|'office'};
  });
  let remaining=[...locations],ordered:typeof locations=[],cursor=input.startCoordinates||null;
  while(remaining.length){let next=0;if(input.optimize&&cursor)next=remaining.reduce((best,item,index)=>distanceKm(cursor!,item.point.coordinates!)<distanceKm(cursor!,remaining[best].point.coordinates!)?index:best,0);const [item]=remaining.splice(next,1);ordered.push(item);cursor=item.point.coordinates;}
  const manager=input.managerId?options.find(option=>option.id===input.managerId):undefined;if(input.managerId&&!manager)throw new Error('Выбранный КМ не найден в актуальной версии штата.');
  const known=selected.flatMap(org=>org!.assignedManagers);const sameManager=known.length>0&&selected.every(org=>org!.assignedManagers.length===1&&org!.assignedManagers[0].id===known[0].id)?known[0]:null;
  const warnings=['Оценка: расстояние по прямой × коэффициент объезда; время по заданной скорости. Реальные дороги, пробки и перекрытия не учтены.','Доступность КМ и клиента не проверялась; встречи нужно согласовать.'];
  if(!input.startCoordinates)warnings.push('Начало маршрута — первая организация; дорога к первой встрече не учтена.');
  if(!manager&&!sameManager)warnings.push('Ответственный КМ не определён однозначно; выберите его перед согласованием.');
  let time=start;cursor=input.startCoordinates||null;const stops:PlanStop[]=[];let totalDistance=0,totalTravel=0;
  for(const item of ordered){const direct=cursor?distanceKm(cursor,item.point.coordinates!):0;const estimated=direct*input.detourFactor;const travel=Math.ceil(estimated/input.speedKmh*60);time+=travel*60000;const arrival=time;time+=input.meetingMinutes*60000;
    const notes=item.kind==='office'?['Использован адрес офиса; подтвердите место встречи.']:[];
    const hour=new Date(arrival+3*3600000).getUTCHours(),endHour=new Date(time+3*3600000).getUTCHours(),weekday=new Date(arrival+3*3600000).getUTCDay();
    if(weekday===0||weekday===6||hour<9||endHour>=18)notes.push('Встреча вне ориентировочного рабочего окна 09:00–18:00 по будням.');
    stops.push({orgId:item.org.id,name:item.org.name,coordinates:item.point.coordinates!,address:item.point.address,locationKind:item.kind,locationSource:item.point.sourceUrl,arrivalAt:asMoscow(arrival),meetingEndsAt:asMoscow(time),travelMinutes:travel,straightLineKm:Number(direct.toFixed(2)),estimatedDistanceKm:Number(estimated.toFixed(2)),bufferMinutes:input.bufferMinutes,warnings:notes});
    time+=input.bufferMinutes*60000;cursor=item.point.coordinates;totalDistance+=estimated;totalTravel+=travel;
  }
  const geometryCoordinates=[...(input.startCoordinates?[input.startCoordinates]:[]),...stops.map(stop=>stop.coordinates)];if(geometryCoordinates.length===1)geometryCoordinates.push(geometryCoordinates[0]);
  const plan:MeetingPlan={id:randomUUID(),title:input.title.trim(),createdAt:new Date().toISOString(),timezone:'Europe/Moscow',startAt:asMoscow(start),endsAt:stops.at(-1)!.meetingEndsAt,manager:manager||sameManager,method:'straight-line-estimate',methodLabel:'Оценочный маршрут; не навигация по дорогам',input,stops,geometry:{type:'LineString',coordinates:geometryCoordinates},totalDistanceKm:Number(totalDistance.toFixed(2)),totalTravelMinutes:totalTravel,warnings};
  ensurePlanSchema();db().prepare('INSERT INTO meeting_plans(id,mode,content_json,updated_at) VALUES(?,?,?,?)').run(plan.id,'work',JSON.stringify(plan),plan.createdAt);return plan;
}
/** Explicit user action; only coordinates reach this fixed public road service. */
export async function refinePlanByRoad(mode:Mode,id:string):Promise<MeetingPlan>{
  if(mode==='public')throw new Error('Маршруты клиентов доступны только в рабочем режиме.');
  const plan=listMeetingPlans(mode).find(item=>item.id===id);if(!plan)throw new Error('План не найден.');
  if(plan.stops.length>8)throw new Error('Для уточнения по дорогам выберите не более 8 встреч.');
  const coordinates=[...(plan.input.startCoordinates?[plan.input.startCoordinates]:[]),...plan.stops.map(stop=>stop.coordinates)];
  if(coordinates.length<2)throw new Error('Нужны две разные точки маршрута или начальная точка.');
  if(!coordinates.every(validCoordinates))throw new Error('Координаты маршрута требуют проверки.');
  const url='https://router.project-osrm.org/route/v1/driving/'+coordinates.map(point=>point.map(n=>Number(n.toFixed(6))).join(',')).join(';')+'?overview=full&geometries=geojson&steps=false';
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(12000),redirect:'error',headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error('Service unavailable');
    const text=await response.text();if(text.length>5_000_000)throw new Error('Response too large');
    const data=JSON.parse(text) as {code:string;routes?:{distance:number;duration:number;geometry:GeoJSON.LineString;legs:{distance:number;duration:number}[]}[]};
    const route=data.routes?.[0];
    if(data.code!=='Ok'||!route||route.geometry?.type!=='LineString'||!Array.isArray(route.geometry.coordinates)||!route.geometry.coordinates.every(validCoordinates)||route.legs?.length!==coordinates.length-1||!route.legs.every(leg=>Number.isFinite(leg.distance)&&leg.distance>=0&&Number.isFinite(leg.duration)&&leg.duration>=0)||!Number.isFinite(route.distance)||!Number.isFinite(route.duration))throw new Error('Invalid route');
    let time=localTime(plan.input.startAt),totalTravel=0;
    const stops=plan.stops.map((stop,index)=>{const legIndex=plan.input.startCoordinates?index:index-1;const leg=legIndex<0?null:route.legs[legIndex];const travel=leg?Math.ceil(leg.duration/60):0;totalTravel+=travel;time+=travel*60000;const arrival=time;time+=plan.input.meetingMinutes*60000;const end=time;time+=plan.input.bufferMinutes*60000;return {...stop,arrivalAt:asMoscow(arrival),meetingEndsAt:asMoscow(end),travelMinutes:travel,estimatedDistanceKm:leg?Number((leg.distance/1000).toFixed(2)):0,warnings:stop.warnings.filter(note=>!note.includes('рабочего окна'))};});
    for(const stop of stops){const local=new Date(Date.parse(stop.arrivalAt)+3*3600000),end=new Date(Date.parse(stop.meetingEndsAt)+3*3600000);if([0,6].includes(local.getUTCDay())||local.getUTCHours()<9||end.getUTCHours()>=18)stop.warnings.push('Встреча вне ориентировочного рабочего окна 09:00–18:00 по будням.');}
    const updated:MeetingPlan={...plan,stops,endsAt:stops.at(-1)!.meetingEndsAt,method:'road',methodLabel:'Дорожный маршрут OSRM · без пробок',geometry:route.geometry,totalDistanceKm:Number((route.distance/1000).toFixed(2)),totalTravelMinutes:totalTravel,routingSourceUrl:'https://project-osrm.org/docs/v5.24.0/api/#route-service',routingCheckedAt:new Date().toISOString(),routingError:undefined,warnings:[...plan.warnings.filter(note=>!note.startsWith('Оценка:')),'OSRM рассчитал маршрут по дорожной сети. Пробки, текущие перекрытия и доступность КМ не учтены. Порядок остановок не является доказанно оптимальным.']};
    db().prepare('UPDATE meeting_plans SET content_json=?,updated_at=? WHERE id=? AND mode=?').run(JSON.stringify(updated),new Date().toISOString(),id,'work');return updated;
  }catch{
    const updated={...plan,routingError:'Дорожный сервис не ответил или не нашёл маршрут. Сохранён предыдущий маршрут; его метод указан выше.'};
    db().prepare('UPDATE meeting_plans SET content_json=?,updated_at=? WHERE id=? AND mode=?').run(JSON.stringify(updated),new Date().toISOString(),id,'work');return updated;
  }
}
