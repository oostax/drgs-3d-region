import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Organization} from '../src/lib/types';
import type {PlanInput} from '../src/lib/planning-types';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-planning-test-'));
process.env.ATLAS_DB=path.join(folder,'private.sqlite');
process.env.ATLAS_PUBLIC_ORG_INDEX=path.join(folder,'organizations.json');
const originalFetch=globalThis.fetch;
const {organizationLocation,saveOrganizationLocation,syncPublicOrganizationLocations}=await import('../src/lib/organization-locations');
const {planningData,planningOrganizationDetail,createMeetingPlan,listMeetingPlans,refinePlanByRoad,managers}=await import('../src/lib/meeting-planner');
const {organizationOpportunities}=await import('../src/lib/opportunities');
const {nextWeekdayStart}=await import('../src/lib/planning-time');
const a='8610:1655018018',b='8610:1655258235',c='8610:1628008395',d='8610:1615011993';
const orgA={id:a,inn:'1655018018',name:'Fixture Secret A'};
const blank:Organization={...orgA,gosb:'8610',offerCount:0,expectedIncome:null,geoStatus:'unlocated'};
const publicBeforeOpen={planning:planningData('public'),plans:listMeetingPlans('public'),location:organizationLocation('public',orgA)};
const publicOpenedDb=fs.existsSync(process.env.ATLAS_DB);
const {db}=await import('../src/lib/db');
db({create:true}).exec(`CREATE TABLE imports(id TEXT PRIMARY KEY,file_name TEXT,file_hash TEXT,kind TEXT,status TEXT,rows_read INTEGER,rows_kept INTEGER,imported_at TEXT,period TEXT,report_json TEXT,error TEXT);
CREATE TABLE organizations(id TEXT PRIMARY KEY,inn TEXT,gosb TEXT,name TEXT,data_json TEXT);
CREATE TABLE payroll(org_id TEXT,fot_march REAL,fot_july REAL,recipients_march INTEGER,recipients_july INTEGER,cumulative_april REAL,cumulative_august REAL);
CREATE TABLE meetings(org_id TEXT,q1 INTEGER,q2 INTEGER,q3 INTEGER,conflict INTEGER);
CREATE TABLE offers(id TEXT PRIMARY KEY,offer_id TEXT,inn TEXT,org_id TEXT,snapshot TEXT,product TEXT,amount REAL,expected_income REAL,stage TEXT,stage_date TEXT,source_id TEXT,data_json TEXT);
CREATE TABLE staff(id TEXT PRIMARY KEY,source_version TEXT,employee_id TEXT,data_json TEXT);`);
const addOrg=db().prepare('INSERT INTO organizations VALUES(?,?,?,?,?)');
for(const [id,inn,name]of [[a,'1655018018','Fixture Secret A'],[b,'1655258235','Fixture Secret B'],[c,'1628008395','Name-only school'],[d,'1615011993','Conflicting office']])addOrg.run(id,inn,'8610',name,'{}');
addOrg.run('8610:missing-name',null,'8610',null,'{}');
db().prepare('INSERT INTO payroll VALUES(?,?,?,?,?,?,?)').run(a,100,200,10,20,null,null);
db().prepare('INSERT INTO meetings VALUES(?,?,?,?,?)').run(a,0,0,0,0);
db().prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('current','current.xlsx','hash','offers_current','complete',1,1,'2026-09-04','{}','{}',null);
db().prepare('INSERT INTO offers VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('offer-a','offer-a','1655018018',a,'current','Расчёты',100,20,'В работе',null,'current','{}');
const base={precision:'building',sourceUrl:'https://public.example.test/source',checkedAt:'2026-09-04',meetingPlaceVerified:false};
fs.writeFileSync(process.env.ATLAS_PUBLIC_ORG_INDEX,JSON.stringify([
 {...base,id:'a',inn:'1655018018',name:'Public A',address:'Legal A',coordinates:[49,55],addressKind:'legal'},
 {...base,id:'b',inn:'1655258235',name:'Public B',address:'Office B',coordinates:[49.2,55],addressKind:'office',note:'Место приёма требует подтверждения'},
 {...base,id:'c',inn:null,name:'Name-only school',address:'Candidate C',coordinates:[49.1,55],addressKind:'office'},
 {...base,id:'d',inn:'1615011993',name:'Conflicting office',address:'Uncertain D',coordinates:null,addressKind:'legal',autoMatchEligible:false}
]));
const input:PlanInput={title:'Synthetic meetings',orgIds:[a,b,c],startAt:'2026-09-07T09:00',meetingMinutes:45,bufferMinutes:15,speedKmh:30,detourFactor:1.4,optimize:true,startCoordinates:[49,55]};
after(()=>{globalThis.fetch=originalFetch;db().close();fs.rmSync(folder,{recursive:true,force:true});});

test('planning public mode neither opens the database nor returns private records',async()=>{
  assert.deepEqual(publicBeforeOpen,{planning:null,plans:[],location:null});assert.equal(publicOpenedDb,false);
  assert.throws(()=>createMeetingPlan('public',input));assert.throws(()=>syncPublicOrganizationLocations('public'));
  await assert.rejects(refinePlanByRoad('public','anything'));
});
test('exact INN links sources, names and conflicting source addresses remain candidates',()=>{
  const exact=organizationLocation('work',orgA)!;assert.equal(exact.status,'source_exact');assert.equal(exact.legalAddress?.address,'Legal A');assert.equal(exact.meeting,null);
  const candidate=organizationLocation('work',{id:c,inn:'1628008395',name:'Name-only school'})!;assert.equal(candidate.status,'candidate');assert.equal(candidate.office,null);
  const conflict=organizationLocation('work',{id:d,inn:'1615011993',name:'Conflicting office'})!;assert.equal(conflict.status,'candidate');assert.equal(conflict.legalAddress,null);
  assert.throws(()=>createMeetingPlan('work',{...input,orgIds:[a]}),/Подтвердите/);
  assert.throws(()=>createMeetingPlan('work',{...input,orgIds:[b]}),/Подтвердите/);
});
test('verified meeting point is separate from legal address and survives public re-sync',()=>{
  assert.deepEqual(syncPublicOrganizationLocations('work'),{matched:2,retainedManual:0,candidates:2});
  assert.throws(()=>saveOrganizationLocation('work',{orgId:a,kind:'meeting',address:'Meeting A',coordinates:[49,55],precision:'building',confirmed:false}),/Подтвердите/);
  for(const [id,longitude]of [[a,49],[b,49.2],[c,49.1]] as const)saveOrganizationLocation('work',{orgId:id,kind:'meeting',address:`Confirmed ${id}`,coordinates:[longitude,55],precision:'building',confirmed:true});
  const saved=organizationLocation('work',orgA)!;assert.equal(saved.legalAddress?.address,'Legal A');assert.equal(saved.meeting?.address,`Confirmed ${a}`);assert.equal(saved.meeting?.confirmedByUser,true);
  assert.equal(syncPublicOrganizationLocations('work').retainedManual,3);
  assert.equal(organizationLocation('work',orgA)?.meeting?.address,`Confirmed ${a}`);
});
test('opportunity evidence distinguishes missing counters, zero, growth and historical offers',()=>{
  const org={...blank,offerCount:1,expectedIncome:20,offers:[{id:'a',offer_id:'a',snapshot:'current',product:'Расчёты',amount:100,expected_income:20,stage:'В работе',stage_date:null}],payroll:{fot_march:100,fot_july:200,recipients_march:10,recipients_july:20,cumulative_april:null,cumulative_august:null},meetings:{q1:0,q2:0,q3:0,conflict:0}};
  assert.deepEqual(organizationOpportunities(org).map(item=>item.rule),['current_offers','payroll_growth','no_meetings']);
  assert.equal(organizationOpportunities({...org,payroll:{...org.payroll,fot_march:0},meetings:{...org.meetings,q1:null}}).length,1);
  assert.equal(organizationOpportunities({...blank,offers:[{...org.offers[0],snapshot:'q1'}]}).length,0);
  assert.ok(organizationOpportunities(org).every(item=>item.facts.length&&item.hypothesis&&item.nextStep));
});
test('local itinerary uses nearest order, Moscow time and buffers and persists only in work mode',()=>{
  const plan=createMeetingPlan('work',input);
  assert.equal(plan.method,'straight-line-estimate');assert.deepEqual(plan.stops.map(stop=>stop.orgId),[a,c,b]);
  assert.equal(plan.stops[0].arrivalAt,'2026-09-07T09:00:00+03:00');assert.equal(plan.stops[0].meetingEndsAt,'2026-09-07T09:45:00+03:00');
  for(let index=1;index<plan.stops.length;index++)assert.equal(Date.parse(plan.stops[index].arrivalAt)-Date.parse(plan.stops[index-1].meetingEndsAt),(15+plan.stops[index].travelMinutes)*60000);
  assert.ok(plan.warnings.some(note=>note.includes('не проверялась')));assert.ok(listMeetingPlans('work').some(saved=>saved.id===plan.id));assert.deepEqual(listMeetingPlans('public'),[]);
  assert.throws(()=>createMeetingPlan('work',{...input,startAt:'2026-02-30T09:00'}),/некорректны/);
  assert.throws(()=>createMeetingPlan('work',{...input,orgIds:[a,a]}),/разных/);
});
test('road refinement sends only coordinates to fixed OSRM, recomputes agenda and persists geometry',async()=>{
  const plan=createMeetingPlan('work',input);let sent='';let headers:Headers|undefined;
  globalThis.fetch=async(url,options)=>{sent=String(url);headers=new Headers(options?.headers);assert.equal(options?.body,undefined);assert.equal(options?.redirect,'error');return Response.json({code:'Ok',routes:[{distance:9000,duration:900,geometry:{type:'LineString',coordinates:[[49,55],[49.05,55.01],[49.1,55],[49.2,55]]},legs:[{distance:0,duration:0},{distance:4000,duration:420},{distance:5000,duration:480}]}]});};
  const updated=await refinePlanByRoad('work',plan.id);
  assert.equal(new URL(sent).origin,'https://router.project-osrm.org');assert.equal(sent.includes('1655018018'),false);assert.equal(sent.includes('Secret'),false);assert.equal(headers?.get('Authorization'),null);
  assert.equal(updated.method,'road');assert.equal(updated.totalTravelMinutes,15);assert.equal(updated.totalDistanceKm,9);
  assert.equal(updated.stops[1].arrivalAt,'2026-09-07T10:07:00+03:00');assert.equal(updated.geometry.coordinates.length,4);assert.ok(updated.routingCheckedAt);
  assert.equal(listMeetingPlans('work').find(saved=>saved.id===plan.id)?.method,'road');
});
test('failed road provider preserves a clearly labelled estimate without inventing road geometry',async()=>{
  const plan=createMeetingPlan('work',input);globalThis.fetch=async()=>{throw new TypeError('Offline');};
  const result=await refinePlanByRoad('work',plan.id);assert.equal(result.method,'straight-line-estimate');assert.deepEqual(result.geometry,plan.geometry);assert.ok(result.routingError);
});
test('default meeting time is a future Moscow weekday across weekends and UTC date boundaries',()=>{
  assert.equal(nextWeekdayStart(new Date('2026-09-04T12:00:00Z')),'2026-09-07T09:00');
  assert.equal(nextWeekdayStart(new Date('2026-09-06T20:00:00Z')),'2026-09-07T09:00');
  assert.equal(nextWeekdayStart(new Date('2026-09-06T22:00:00Z')),'2026-09-08T09:00');
});
test('manager assignment requires an exact current-offer name match in an active staff source',()=>{
  db().prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('staff-source','штат.xlsx','staffhash','staff','complete',1,1,'2026-09-04','{}','{}',null);
  db().prepare('INSERT INTO staff VALUES(?,?,?,?)').run('manager-row','version1','employee-1',JSON.stringify({name:'Synthetic Manager',division_5:'Татарстан',assigned_role:'КМ',source:{source_id:'staff-source'}}));
  db().prepare('UPDATE offers SET data_json=? WHERE id=?').run(JSON.stringify({manager:'Synthetic Manager'}),'offer-a');
  assert.equal(managers('work').length,1);assert.equal(planningOrganizationDetail('work',a)?.assignedManagers[0]?.assignmentKnown,true);
  assert.deepEqual(planningOrganizationDetail('work',b)?.assignedManagers,[]);
  assert.equal(createMeetingPlan('work',{...input,orgIds:[a]}).manager?.id,'employee-1');
  assert.equal(createMeetingPlan('work',input).manager,null);
  assert.throws(()=>createMeetingPlan('work',{...input,managerId:'not-in-source'}),/КМ не найден/);
});
test('API handlers reject public writes, foreign origins and unconsented coordinate sharing',async()=>{
  const {NextRequest}=await import('next/server');const {GET,POST}=await import('../src/app/api/[...path]/route');
  const context=(parts:string[])=>({params:Promise.resolve({path:parts})});
  const publicRead=await GET(new NextRequest('http://127.0.0.1:3200/api/planning?mode=public'),context(['planning']));assert.equal(publicRead.status,200);assert.equal(await publicRead.json(),null);
  const makeRequest=(route:string,body:unknown,headers:Record<string,string>={})=>new NextRequest('http://127.0.0.1:3200/api/'+route,{method:'POST',headers:{Host:'127.0.0.1:3200','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await POST(makeRequest('plans',{mode:'public',...input}),context(['plans']))).status,403);
  assert.equal((await POST(makeRequest('plans',{mode:'work',...input},{Origin:'http://foreign.invalid'}),context(['plans']))).status,403);
  assert.equal((await POST(makeRequest('organization-locations/sync',{mode:'public'}),context(['organization-locations','sync']))).status,403);
  const plan=createMeetingPlan('work',input);let attempts=0;globalThis.fetch=async()=>{attempts++;throw new Error('Not expected');};
  assert.equal((await POST(makeRequest(`plans/${plan.id}/road`,{mode:'work',shareCoordinates:false}),context(['plans',plan.id,'road']))).status,400);assert.equal(attempts,0);
});
test('partial or failed latest payroll and meetings imports cannot produce opportunity facts',()=>{
  const add=db().prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  add.run('partial-payroll','payroll.xlsx','partial-payroll','payroll','running',1,1,'2026-09-05','{}','{}',null);
  add.run('failed-meetings','meetings.xlsx','failed-meetings','meetings','error',1,1,'2026-09-05','{}','{}','fixture');
  try{assert.deepEqual(planningOrganizationDetail('work',a)?.opportunities.map(item=>item.rule),['current_offers']);}
  finally{db().prepare("DELETE FROM imports WHERE id IN ('partial-payroll','failed-meetings')").run();}
});
