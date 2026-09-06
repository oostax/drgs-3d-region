import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-operations-test-'));
process.env.ATLAS_DB=path.join(folder,'fixture.sqlite');
const {operationsData}=await import('../src/lib/operations-data');
const {incidentRecords}=await import('../src/lib/incidents-data');
const {matchesIncidentTerritory}=await import('../src/lib/atlas-data');
import type {Territory} from '../src/lib/types';
const {sourceStatus,canonicalSourceName,sourceKind,currentSourceId}=await import('../src/lib/source-status');
const publicPayload=operationsData('public');
const publicSources=sourceStatus('public');
const publicIncidents=incidentRecords('public','RU-TA','',0);
const databaseOpenedForPublic=fs.existsSync(process.env.ATLAS_DB);
const {db}=await import('../src/lib/db');
const {getImportStatus,reconcileImportJobs,processIdentity,importArguments,launchImport}=await import('../src/lib/import-jobs');

db({create:true}).exec(`CREATE TABLE imports(id TEXT PRIMARY KEY,file_name TEXT,file_hash TEXT,kind TEXT,status TEXT,rows_read INTEGER,rows_kept INTEGER,imported_at TEXT,period TEXT,report_json TEXT,error TEXT);
CREATE TABLE staff(id TEXT PRIMARY KEY,source_version TEXT,employee_id TEXT,data_json TEXT);
CREATE TABLE bank_clusters(gosb TEXT PRIMARY KEY,data_json TEXT);
CREATE TABLE complaint_summaries(id TEXT PRIMARY KEY,data_json TEXT);`);
const source=db().prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?,?)');
for(const [id,name,kind]of[['staff-a','штат.xlsx','staff'],['staff-b','штатка.xlsx','staff'],['clusters','кластеризация ГОСБ_2025-2026.xlsx','clusters'],['summary','обращения 2025-2026_свод.xlsx','complaint_summaries']])
  source.run(id,name,`hash-${id}`,kind,'complete',1,1,'2026-09-04','{}',JSON.stringify({source_path:'/private/should-not-leak',quality:{missing_gosb:1},counters:{rows:1}}),null);
const staff=db().prepare('INSERT INTO staff VALUES(?,?,?,?)');
for(const [version,sourceId,employee,role]of[['version-a','staff-a','one','Manager'],['version-a','staff-a','two','Manager'],['version-b','staff-b','one','Assistant']])
  staff.run(`${version}:${employee}`,version,employee,JSON.stringify({source:{source_id:sourceId},division_5:'Банк Татарстан',assigned_role:role,name:'PrivateStaffFixture',period:{start:'2026-01-01'}}));
db().prepare('INSERT INTO bank_clusters VALUES(?,?)').run('8610',JSON.stringify({name:'Банк Татарстан',tb:'ВВБ',cluster_2025:1,cluster_2026:1,source:{source_id:'clusters'}}));
for(const [sheet,filter,count]of[['d','(несколько элементов)',2],['все','(Все)',5]])db().prepare('INSERT INTO complaint_summaries VALUES(?,?)').run(String(sheet),JSON.stringify({source:{source_id:'summary'},sheet,filters:{'Приоритет клиента':filter},row_label:'Волго-Вятский банк',values:{январь:count}}));

after(()=>{db().close();fs.rmSync(folder,{recursive:true,force:true});});
test('presentation operations and source status return null without opening SQLite',()=>{
  assert.equal(publicPayload,null);assert.equal(publicSources,null);assert.equal(databaseOpenedForPublic,false);
  assert.deepEqual(publicIncidents,{items:[],total:0,unlocated:0});
});
test('operations preserve staff versions, compare common IDs and do not invent geography or years',()=>{
  const p=operationsData('work')!;
  assert.equal(p.staff.versions.length,2);assert.equal(p.staff.comparison?.common,1);
  assert.equal(p.staff.comparison?.onlyLeft,1);assert.equal(p.staff.comparison?.changedEmployees,1);
  assert.deepEqual(p.staff.versions.map(v=>v.count).sort(),[1,2]);
  assert.equal(p.scope.municipalityAllocation,false);assert.equal(p.bankSummary.views.length,2);
  assert.ok(p.bankSummary.views.every(v=>v.year===null));
  assert.equal(JSON.stringify(p).includes('PrivateStaffFixture'),false);
  assert.equal(JSON.stringify(p).includes('/private/should-not-leak'),false);
});
test('UUID upload names resolve to the original kind and subprocess arguments are structured',()=>{
  const original='Получатели ФОТ (март, июль).xlsx';
  const upload=`12345678-abcd-4321-abcd-123456789012-${original}`;
  assert.equal(canonicalSourceName(upload),original);assert.equal(sourceKind(upload),'recipients');
  const args=importArguments(path.join(folder,upload),original,process.env.ATLAS_DB);
  assert.equal(args[args.indexOf('--kind')+1],'recipients');
  assert.equal(args[args.indexOf('--file')+1],path.join(folder,upload));
  assert.throws(()=>importArguments('anything','toString'));
});
test('stale jobs are recovered but a live worker is not interrupted',()=>{
  getImportStatus();
  const insert=db().prepare('INSERT INTO import_jobs(id,file_name,status,started_at,worker_pid,worker_identity,source_hash) VALUES(?,?,?,?,?,?,?)');
  insert.run('stale','fixture.xlsx','running','2000-01-01',null,null,null);
  insert.run('finished','fixture.xlsx','running','2000-01-01',999999999,null,'hash-staff-a');
  insert.run('alive','fixture.xlsx','running','2000-01-01',process.pid,processIdentity(process.pid),null);
  reconcileImportJobs();
  const statuses=Object.fromEntries((db().prepare('SELECT id,status FROM import_jobs').all() as {id:string;status:string}[]).map(r=>[r.id,r.status]));
  assert.equal(statuses.stale,'error');assert.equal(statuses.finished,'complete');assert.equal(statuses.alive,'running');
  assert.equal(currentSourceId('staff','штат.xlsx'),'staff-a');
  assert.equal(db().prepare('SELECT COUNT(*) n FROM staff').get() && (db().prepare('SELECT COUNT(*) n FROM staff').get() as {n:number}).n,3);
  db().prepare("UPDATE import_jobs SET status='complete' WHERE id='alive'").run();
});
test('a UUID-named upload completes through the actual background worker',async()=>{
  const original='Получатели ФОТ (март, июль).xlsx';
  const upload=path.join(folder,`12345678-abcd-4321-abcd-123456789012-${original}`);
  const bundled=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  const python=process.env.ATLAS_PYTHON||(fs.existsSync(bundled)?bundled:'python3');
  execFileSync(python,['-B','-c',"import sys; from pathlib import Path; sys.path.insert(0,str(Path.cwd()/'scripts')); from test_import import fixture,make_inn; fixture(Path(sys.argv[1]),[(1,{'D':'INN'}),(2,{'B':8610,'D':make_inn(),'L':1,'M':0})])",upload],{stdio:'ignore'});
  const job=launchImport(upload,original);
  let status='running';
  for(let n=0;n<200&&status==='running';n++){
    await new Promise(resolve=>setTimeout(resolve,25));
    status=(db().prepare('SELECT status FROM import_jobs WHERE id=?').get(job.id) as {status:string}).status;
  }
  assert.equal(status,'complete');
  const row=db().prepare("SELECT file_name,status FROM imports WHERE kind='recipients'").get() as {file_name:string;status:string};
  assert.equal(row.file_name,original);assert.equal(row.status,'complete');
  assert.deepEqual(db().prepare('SELECT recipients_march,recipients_july FROM payroll').get(),{recipients_march:1,recipients_july:0});
});
test('incident records select the latest completed source without retaining old or partial rows',()=>{
  for(const [id,status,at]of[['inc-old','complete','2026-09-01'],['inc-new','complete','2026-09-02'],['inc-pending','running','2026-09-03']])
    source.run(id,'Сбер_июль_2026.xlsx',`hash-${id}`,'incidents',status,1,1,at,'{}','{}',null);
  const add=db().prepare('INSERT INTO incidents(id,municipality,settlement,topic_group,topic,source_id) VALUES(?,?,?,?,?,?)');
  for(const [id,sourceId]of[['old-row','inc-old'],['new-row','inc-new'],['partial-row','inc-pending']])add.run(id,'Казань г.о.','Казань','ЖКХ','Освещение',sourceId);
  const current=incidentRecords('work','RU-TA','освещение',0);
  assert.equal(current.total,1);assert.equal(current.items[0]?.id,'new-row');
  assert.equal(incidentRecords('work','RU','',0).total,1);
  assert.equal(incidentRecords('work','missing-territory','',0).total,0);
  assert.equal(incidentRecords('work','RU-TA','',1).items.length,0);
  assert.equal(incidentRecords('work','RU-TA','',-1).items[0]?.id,'new-row');
});
test('settlement scopes use exact normalized names within the correct municipality',()=>{
  const common={center:null,geometryStatus:'missing',sourceUrl:''};
  const territories:Territory[]=[{...common,id:'district',name:'Тестовый муниципальный район',kind:'district',parentId:'RU-TA'},
    {...common,id:'settlement',name:'Ключи сельское поселение',kind:'settlement',parentId:'district'}];
  assert.equal(matchesIncidentTerritory('Тестовый район','КЛЮЧИ',territories,'settlement'),true);
  assert.equal(matchesIncidentTerritory('Тестовый район','Новые Ключи',territories,'settlement'),false);
  assert.equal(matchesIncidentTerritory('Другой район','Ключи',territories,'settlement'),false);
  assert.equal(matchesIncidentTerritory('Тестовый район',null,territories,'settlement'),false);
});
