import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

test('Sber relevance is computed locally by INN while live signal stays public',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-relevance-')),liveFile=path.join(folder,'live.sqlite'),privateFile=path.join(folder,'private.sqlite');
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));process.env.ATLAS_LIVE_DB=liveFile;process.env.ATLAS_DB=privateFile;
  const stamp=new Date().toISOString(),live=new Database(liveFile);live.exec(fs.readFileSync(path.join(process.cwd(),'scripts/live/schema.sql'),'utf8'));
  live.prepare(`INSERT INTO events(id,region_id,territory_id,canonical_key,title,summary,category,topic,state,severity,confidence,source_kind,event_time,published_at,last_evidence_at,last_meaningful_at,longitude,latitude,precision,location_confidence,activity_kind,explicit_activity,data_json,updated_at) VALUES('event','RU-TA','t1','event','Капремонт школы','Начались работы','construction','education','in_progress','medium','medium','media',?,?,?,?,49,55,'building','building','construction',1,?,?)`).run(stamp,stamp,stamp,stamp,JSON.stringify({sourceUrl:'https://example.test/news',organizationInn:'1650000000',facts:['В публикации указан ИНН.']}),stamp);live.prepare(`INSERT INTO revisions(event_id,operation,created_at) VALUES('event','upsert',?)`).run(stamp);live.prepare(`UPDATE events SET revision=last_insert_rowid() WHERE id='event'`).run();live.close();
  const privateDb=new Database(privateFile);privateDb.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY,inn TEXT,gosb TEXT,name TEXT,data_json TEXT);CREATE TABLE imports(id TEXT PRIMARY KEY,file_name TEXT,kind TEXT,status TEXT,rows_read INTEGER,rows_kept INTEGER,imported_at TEXT,period TEXT,report_json TEXT,error TEXT);CREATE TABLE offers(id TEXT PRIMARY KEY,offer_id TEXT,inn TEXT,org_id TEXT,snapshot TEXT,product TEXT,amount REAL,expected_income REAL,stage TEXT,stage_date TEXT,data_json TEXT,source_id TEXT);`);
  privateDb.prepare(`INSERT INTO organizations VALUES('org','1650000000','ГОСБ-1','Школа № 1','{}')`).run();privateDb.prepare(`INSERT INTO imports VALUES('src','x','offers_current','complete',1,1,?,'{}','{}',NULL)`).run(stamp);privateDb.prepare(`INSERT INTO offers VALUES('offer','O-1','1650000000','org','current','Эквайринг',100,5,'Новая',?,'{}','src')`).run(stamp);privateDb.close();
  const {liveSignalSnapshot}=await import('../src/lib/live-store');const {signalRelevance}=await import('../src/lib/signal-relevance');
  const publicJson=JSON.stringify(liveSignalSnapshot({days:30}));assert.doesNotMatch(publicJson,/ГОСБ-1|Эквайринг|O-1/);
  const relevance=signalRelevance('event','current');assert.equal(relevance.items[0].relationship,'exact_inn');assert.deepEqual(relevance.items[0].offerIds,['O-1']);
});
