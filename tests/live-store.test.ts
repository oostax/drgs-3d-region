import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

test('live ledger separates documents from events, supports scoped deltas and exposes worker lag',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-live-')),file=path.join(folder,'live.sqlite');
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));process.env.ATLAS_LIVE_DB=file;
  const database=new Database(file);database.exec(fs.readFileSync(path.join(process.cwd(),'scripts/live/schema.sql'),'utf8'));
  const now=new Date(),stamp=now.toISOString(),old=new Date(now.getTime()-35*86_400_000).toISOString(),recent=new Date(now.getTime()-5*86_400_000).toISOString();
  database.prepare(`INSERT INTO worker_state(id,state,heartbeat_at,last_success_at,message) VALUES(1,'running',?,?,?)`).run(stamp,stamp,'Работает');
  database.prepare(`INSERT INTO sources(id,name,region_id,territory_id,url,adapter,source_kind,status,interval_seconds,languages_json,topics_json,coverage_json,fetch_allowed,ai_allowed,display_allowed,rights_note,provenance_url,created_at,updated_at) VALUES('s','Источник','RU-TA','t1','https://example.test/rss','rss','official','active',300,'["ru"]','["roads"]','["t1"]',1,1,1,'','https://example.test',?,?)`).run(stamp,stamp);
  database.prepare(`INSERT INTO documents(id,source_id,external_id,canonical_url,title,content_hash,published_at,last_seen_at,fetched_at) VALUES('d','s','1','https://example.test/1','Ремонт','h',?,?,?)`).run(old,stamp,stamp);
  database.prepare(`INSERT INTO events(id,legacy_id,region_id,territory_id,canonical_key,title,summary,category,topic,state,severity,confidence,source_kind,event_time,published_at,last_evidence_at,last_meaningful_at,address,longitude,latitude,precision,location_confidence,activity_kind,explicit_activity,data_json,updated_at) VALUES('e','legacy-e','RU-TA','t1','road:1','Ремонт дороги','Работы продолжаются','infrastructure','roads','in_progress','high','medium','official',?,?,?,?, 'ул. Тестовая, 1',49.1,55.7,'street','street','road_repair',1,?,?)`).run(old,old,recent,recent,JSON.stringify({sourceUrl:'https://example.test/1',facts:['Источник сообщает о работах.']}),stamp);
  database.prepare(`INSERT INTO event_documents(event_id,document_id,relation) VALUES('e','d','primary')`).run();
  database.prepare(`INSERT INTO event_evidence(id,event_id,document_id,source_id,label,url,observed_at,source_kind,supports) VALUES('proof','e','d','s','Источник','https://example.test/1',?,'official','report')`).run(stamp);
  database.prepare(`INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES('e','upsert',1,?)`).run(stamp);database.prepare(`UPDATE events SET revision=last_insert_rowid() WHERE id='e'`).run();
  database.prepare(`INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES('e','upsert',0,?)`).run(stamp);database.prepare(`UPDATE events SET revision=last_insert_rowid(),notify_eligible=0 WHERE id='e'`).run();
  database.close();
  const store=await import('../src/lib/live-store');
  assert.equal(store.liveSignalSnapshot({regionId:'RU-TA',territoryIds:['t1'],days:30}).total,0);
  const snapshot=store.liveSignalSnapshot({regionId:'RU-TA',territoryIds:['t1'],days:30,ongoing:true});
  assert.equal(snapshot.signals[0].id,'legacy-e');assert.equal(snapshot.signals[0].live.activityKind,'road_repair');assert.equal(snapshot.signals[0].live.evidenceCount,1);assert.equal(snapshot.worker.state,'running');
  const delta=store.liveSignalChanges({regionId:'RU-TA',territoryIds:['t1'],days:60},'0');assert.equal(delta.upserts[0].id,'legacy-e');assert.equal(delta.upserts[0].live.notifyEligible,true);assert.equal(delta.cursor,'2');
  const detail=store.liveSignalById('legacy-e');assert.equal(detail?.live.duplicateCount,0);
  const write=new Database(file);write.prepare("UPDATE events SET state='planned',event_time='2099-09-12T14:30:00+03:00' WHERE id='e'").run();write.close();
  const planned=store.liveSignalSnapshot({regionId:'RU-TA',territoryIds:['t1'],days:30});
  assert.equal(planned.total,1);assert.equal(planned.signals[0].live.eventTime,'2099-09-12T14:30:00+03:00');
  assert.equal(store.liveSignalChanges({regionId:'RU-TA',territoryIds:['t1'],days:30},'0').upserts.length,1);

});
