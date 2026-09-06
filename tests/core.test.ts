import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-test-'));
process.env.ATLAS_DB=path.join(temp,'test.sqlite');
const {db}=await import('../src/lib/db');
const {atlasPayload,organizationDetail,organizations}=await import('../src/lib/atlas-data');
const {createDossier,getDossier,saveDossier,resolveDossierSignals,dossierContent}=await import('../src/lib/dossiers');
const {parseRange}=await import('../src/lib/tiles');
db({create:true}).exec(`
CREATE TABLE organizations(id TEXT PRIMARY KEY,inn TEXT,gosb TEXT,name TEXT,data_json TEXT);
CREATE TABLE payroll(org_id TEXT,fot_march REAL,fot_july REAL,recipients_march INTEGER,recipients_july INTEGER,cumulative_april REAL,cumulative_august REAL);
CREATE TABLE meetings(org_id TEXT,q1 INTEGER,q2 INTEGER,q3 INTEGER,conflict INTEGER);
CREATE TABLE offers(id TEXT PRIMARY KEY,offer_id TEXT,inn TEXT,org_id TEXT,snapshot TEXT,product TEXT,amount REAL,expected_income REAL,stage TEXT,stage_date TEXT,source_id TEXT);
CREATE TABLE incidents(municipality TEXT,settlement TEXT,topic_group TEXT,source_id TEXT);
INSERT INTO organizations VALUES ('8610:test','1234567890','8610','SensitiveClientFixture','{}');
INSERT INTO payroll VALUES ('8610:test',NULL,0,NULL,0,NULL,0);
INSERT INTO meetings VALUES ('8610:test',4,5,6,0);
INSERT INTO offers VALUES ('current:a','a','1234567890','8610:test','current','Расчёты',100,40,'В работе',NULL,'old-current'),('current:b','b','1234567890','8610:test','current','Гарантии',200,30,'В работе',NULL,'old-current'),('q1:a','a','1234567890','8610:test','q1','Расчёты',80,10,'В работе',NULL,'q1-source');
INSERT INTO incidents VALUES ('Казань г.о.','Казань','ЖКХ',NULL),('Казань г.о.','Казань','ЖКХ',NULL),('Спасский район','Болгар','Дороги',NULL);
`);
after(()=>{db().close();fs.rmSync(temp,{recursive:true,force:true});});
test('public mode contains no private portfolio or aggregates',()=>{const p=atlasPayload('public');assert.equal(p.summary.expectedIncome,null);assert.equal(p.summary.incidents,null);assert.equal(p.summary.organizations,null);assert.equal(p.signals.some(s=>s.visibility==='private'),false);assert.equal(JSON.stringify(p).includes('SensitiveClientFixture'),false);assert.equal(organizationDetail('public','8610:test'),null);assert.deepEqual(organizations('public').items,[]);});
test('offer snapshots are isolated and joins do not multiply sums',()=>{assert.equal(atlasPayload('work','RU-TA','current').summary.expectedIncome,70);assert.equal(atlasPayload('work','RU-TA','q1').summary.expectedIncome,10);assert.equal(organizationDetail('work','8610:test')?.offerCount,2);});
test('zero and missing payroll remain different',()=>{const p=organizationDetail('work','8610:test')!.payroll!;assert.equal(p.fot_march,null);assert.equal(p.fot_july,0);});
test('municipal dossier does not allocate bank portfolio to location',()=>{const p=atlasPayload('work','mo-92701000');assert.equal(p.summary.offers,null);assert.equal(p.summary.expectedIncome,null);assert.equal(p.summary.incidents,2);});
test('dossier persists and is partitioned by mode',()=>{const d=createDossier({mode:'work',territoryId:'RU-TA',signalIds:[],organizationIds:['8610:test'],snapshot:'current'});assert.ok(d.facts.some(f=>f.includes('SensitiveClientFixture')));assert.equal(getDossier(d.id,'public'),null);saveDossier({...d,notes:'Следующая встреча в октябре'});assert.equal(getDossier(d.id,'work')?.notes,'Следующая встреча в октябре');});
test('dossier signal resolution preserves order and resolves live aliases',()=>{const existing=atlasPayload('public').signals[0];const live={...existing,id:'live-alias',title:'Live signal'};const result=resolveDossierSignals([existing.id,'live-alias'],[existing],id=>id==='live-alias'?live:null);assert.deepEqual(result.map(item=>item.id),[existing.id,'live-alias']);});
test('meeting draft requires explicit selection and never borrows territory signals',()=>{
  const before=db().prepare('SELECT COUNT(*) AS count FROM saved_dossiers').get() as {count:number};
  assert.throws(()=>createDossier({mode:'work',territoryId:'RU-TA',signalIds:[],organizationIds:[],snapshot:'current'}),/Выберите клиента или сигнал/);
  assert.throws(()=>createDossier({mode:'work',territoryId:'RU-TA',signalIds:[],organizationIds:['missing-client'],snapshot:'current'}),/недоступна/);
  assert.equal((db().prepare('SELECT COUNT(*) AS count FROM saved_dossiers').get() as {count:number}).count,before.count);
  const dossier=createDossier({mode:'work',territoryId:'RU-TA',signalIds:[],organizationIds:['8610:test','8610:test'],snapshot:'current'});
  assert.deepEqual(dossier.signalIds,[]);assert.deepEqual(dossier.organizationIds,['8610:test']);
  assert.match(dossier.title,/SensitiveClientFixture/);assert.match(dossier.questions,/ИНН 1234567890/);
  assert.match(dossier.questions,/2 предложений/);assert.match(dossier.questions,/Расчёты, Гарантии/);
  assert.match(dossier.notes,/Цель встречи:/);assert.match(dossier.notes,/Участники:/);
});
test('meeting facts preserve address evidence, missing amounts, source names and distinct hypotheses',()=>{
  const org=organizationDetail('work','8610:test')!;
  const content=dossierContent([],[{...org,expectedIncome:null,offerSource:{snapshot:'current',fileName:'Предложения.xlsx',date:null,dateInferred:false,label:'Последний срез',qualityNotes:[]},location:{orgId:org.id,status:'source_exact',updatedAt:null,note:'',meeting:null,office:{address:'Казань, Баумана, 1',coordinates:null,precision:'building',sourceUrl:'https://example.org/client-office',checkedAt:'2026-09-05',confirmedByUser:false,requiresMeetingConfirmation:true},legalAddress:null,candidates:[]}}]);
  assert.ok(content.facts.some(fact=>fact.includes('Баумана, 1')&&fact.includes('требует подтверждения')));
  assert.equal(content.facts.some(fact=>fact.includes('ожидаемый доход')),false);
  assert.ok(content.sources.some(source=>source.label.includes('Предложения.xlsx')));
  assert.ok(content.sources.some(source=>source.url==='https://example.org/client-office'));
  assert.deepEqual(content.hypotheses,[]);
});
test('PMTiles range parsing handles partial and invalid requests',()=>{assert.deepEqual(parseRange('bytes=0-127',1000),{start:0,end:127});assert.deepEqual(parseRange('bytes=-100',1000),{start:900,end:999});assert.deepEqual(parseRange('bytes=500-',1000),{start:500,end:999});assert.throws(()=>parseRange('bytes=1000-',1000));assert.throws(()=>parseRange('bytes=0-1,5-6',1000));assert.throws(()=>parseRange('bytes=-',1000));});
test('a new completed source replaces old snapshot amounts and a running source is excluded',()=>{
  db().exec(`CREATE TABLE imports(id TEXT PRIMARY KEY,kind TEXT,status TEXT,imported_at TEXT);
    INSERT INTO imports VALUES ('old-current','offers_current','complete','2026-09-01'),('new-current','offers_current','complete','2026-09-02'),('pending-current','offers_current','running','2026-09-03'),('q1-source','offers_q1','complete','2026-09-01');
    INSERT INTO offers VALUES ('replacement','a','1234567890','8610:test','current','Расчёты',500,12,'В работе',NULL,'new-current'),('partial','a','1234567890','8610:test','current','Расчёты',999,999,'В работе',NULL,'pending-current');`);
  try {
    assert.equal(atlasPayload('work','RU-TA','current').summary.expectedIncome,12);
    assert.equal(atlasPayload('work','RU-TA','current').summary.offers,1);
    assert.equal(atlasPayload('work','RU-TA','q1').summary.expectedIncome,10);
    assert.equal(organizationDetail('work','8610:test')?.expectedIncome,12);
    assert.equal(organizations('work').items.find(o=>o.id==='8610:test')?.offerCount,1);
  } finally { db().exec("DELETE FROM offers WHERE id IN ('replacement','partial'); DROP TABLE imports;"); }
});
test('Cyrillic search ignores case and an unlinked same-INN organization has no financials',()=>{
  db().prepare('INSERT INTO organizations VALUES (?,?,?,?,?)').run('8610:separate','1234567890','8610','МУНИЦИПАЛЬНОЕ УЧРЕЖДЕНИЕ Тест','{}');
  try {
    const found=organizations('work','муниципальное учреждение').items;
    assert.equal(found.length,1);assert.equal(found[0].id,'8610:separate');
    assert.equal(found[0].offerCount,0);assert.equal(found[0].expectedIncome,null);
    const detail=organizationDetail('work','8610:separate');
    assert.equal(detail?.offerCount,0);assert.equal(detail?.expectedIncome,null);
  } finally { db().prepare('DELETE FROM organizations WHERE id=?').run('8610:separate'); }
});
test('regional signal output retains groups beyond the first fifty',()=>{
  const insert=db().prepare('INSERT INTO incidents VALUES (?,?,?,NULL)');
  db().transaction(()=>{for(let n=0;n<60;n++)insert.run('Казань г.о.','Казань',`CoverageFixture${n}`);})();
  try { assert.equal(atlasPayload('work').signals.filter(s=>s.category.startsWith('CoverageFixture')).length,60); }
  finally { db().prepare("DELETE FROM incidents WHERE topic_group LIKE 'CoverageFixture%'").run(); }
});
test('organization changes compare offer IDs from completed adjacent snapshots and preserve missing data',()=>{
  db().exec(`CREATE TABLE imports(id TEXT PRIMARY KEY,kind TEXT,status TEXT,imported_at TEXT,file_name TEXT,period TEXT);
    INSERT INTO imports VALUES ('old-current','offers_current','complete','2026-09-01','Текущий.xlsx','{"snapshot_date":"2026-08-31","date_inferred":true}'),
      ('old-q3','offers_q3','complete','2026-09-01','Предыдущий.xlsx','{}'),('new-q3','offers_q3','complete','2026-09-02','Предыдущий.xlsx','{}'),('pending-q3','offers_q3','running','2026-09-03','Предыдущий.xlsx','{}');
    INSERT INTO offers VALUES ('compare:old','a','1234567890','8610:test','q3','Расчёты',999,999,'В работе',NULL,'old-q3'),
      ('compare:a','a','1234567890','8610:test','q3','Расчёты',80,10,'В работе',NULL,'new-q3'),
      ('compare:c','c','1234567890','8610:test','q3','Гарантии',70,7,'В работе',NULL,'new-q3'),
      ('compare:pending','a','1234567890','8610:test','q3','Расчёты',777,777,'В работе',NULL,'pending-q3'),
      ('compare:other','z','1234567890','8610:another','q3','Расчёты',999,999,'В работе',NULL,'new-q3');`);
  try {
    const card=organizationDetail('work','8610:test')!;
    assert.equal(card.offerChanges?.comparedSnapshot,'q3');assert.equal(card.offerChanges?.comparable,true);
    assert.equal(card.offerChanges?.added,1);assert.equal(card.offerChanges?.removed,1);assert.equal(card.offerChanges?.changed,1);
    assert.equal(card.offerChanges?.incomeDelta,53);
    assert.equal(card.offerSource?.dateInferred,true);assert.ok(card.offers?.every(offer=>offer.sourceLabel?.includes('дата предполагается')));
    assert.ok(card.offerChanges?.note.includes('Историческая принадлежность к ГОСБ не подтверждена'));
    db().prepare("UPDATE offers SET expected_income=NULL WHERE id='compare:c'").run();
    assert.equal(organizationDetail('work','8610:test')?.offerChanges?.incomeDelta,null);
    db().prepare("UPDATE offers SET offer_id='a' WHERE id='compare:c'").run();
    assert.equal(organizationDetail('work','8610:test')?.offerChanges?.comparable,false);
    db().prepare("DELETE FROM offers WHERE source_id='new-q3' AND org_id='8610:test'").run();
    const unavailable=organizationDetail('work','8610:test')!.offerChanges!;
    assert.equal(unavailable.comparable,false);assert.equal(unavailable.incomeDelta,null);assert.equal(unavailable.removed,0);
    assert.ok(unavailable.note.includes('Отсутствие данных не означает отсутствие сделок'));
    assert.equal(organizationDetail('work','8610:test','q1')?.offerChanges?.comparable,false);
    assert.equal(organizationDetail('public','8610:test'),null);
  } finally {db().exec("DELETE FROM offers WHERE id LIKE 'compare:%'; DROP TABLE imports;");}
});
