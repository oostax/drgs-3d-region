/** Synthetic source fixture. Never copies local customer data into tests or CI. */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
const rect = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] });
export function createAnalyticsFixture(folder: string, database: Database.Database, count = 85) {
  const target = path.join(folder, 'public', 'data'); fs.mkdirSync(target, { recursive: true });
  const territory = (id: string, name: string, kind: string, parentId: string | null, bbox: number[]) => ({ id, name, kind, parentId, bbox, center: [(bbox[0]+bbox[2])/2,(bbox[1]+bbox[3])/2], geometry: rect(...bbox as [number,number,number,number]), geometryStatus: 'matched', sourceUrl: 'https://example.test/territories' });
  fs.writeFileSync(path.join(target, 'territories.json'), JSON.stringify([
    territory('RU-TA','Тестовый Татарстан','region',null,[48,54,52,58]),
    territory('district-a','Тестовый муниципальный район','district','RU-TA',[49,55,50,56]),
    territory('settlement-a','Тестовое сельское поселение','settlement','district-a',[49.1,55.6,49.4,55.9]),
    territory('district-b','Второй муниципальный район','district','RU-TA',[50,55,51,56]),
  ]));
  const date = new Date().toISOString().slice(0,10);
  const signal = (id: string, territoryId: string, category: string, status: string) => ({ id, title: 'Синтетический публичный проект '+id, category, territoryId, summary: 'Тест', coordinates: [49.2,55.8], precision: 'territory', sourceUrl: 'https://example.test/signals/'+id, sourceName: 'Тестовый источник', publishedAt: date, checkedAt: date, facts: [], hypothesis: 'Проверить', nextStep: 'Уточнить участников проекта.', visibility: 'public', lifecycle: { status, asOf: date, sourceUrl:'https://example.test/state',currentStatusVerified:true } });
  fs.writeFileSync(path.join(target, 'signals.json'), JSON.stringify([{...signal('one','settlement-a','construction','under_construction'),organizationInn:'1650000000'},signal('two','district-b','investment','completed')]));
  const bank = (id: string, name: string, x: number) => ({id,bank:name,name:'Синтетический офис',address:'Тестовая улица, 1',coordinates:[x,55.8],precision:'building',territoryId:'settlement-a',sourceUrl:'https://example.test/banks/'+id,coordinateSourceUrl:'https://example.test/coords/'+id,checkedAt:date});
  fs.writeFileSync(path.join(target,'bank-offices.json'),JSON.stringify([bank('sber-1','sber',49.2),bank('sber-duplicate','Сбер',49.2),bank('vtb-1','vtb',49.21)]));
  database.exec(`CREATE TABLE imports(id TEXT PRIMARY KEY,file_name TEXT,kind TEXT,status TEXT,imported_at TEXT,period TEXT,report_json TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,inn TEXT,gosb TEXT,name TEXT,data_json TEXT);
    CREATE TABLE offers(id TEXT PRIMARY KEY,offer_id TEXT,inn TEXT,org_id TEXT,snapshot TEXT,product TEXT,amount REAL,expected_income REAL,stage TEXT,stage_date TEXT,source_id TEXT,data_json TEXT);
    CREATE TABLE payroll(org_id TEXT,fot_march REAL,fot_july REAL,source_json TEXT);
    CREATE TABLE meetings(org_id TEXT,q1 INTEGER,q2 INTEGER,q3 INTEGER,conflict INTEGER,data_json TEXT);
    CREATE TABLE incidents(id TEXT PRIMARY KEY,municipality TEXT,settlement TEXT,topic_group TEXT,topic TEXT,status TEXT,created_at TEXT,closed_at TEXT,street TEXT,object TEXT,source_id TEXT,data_json TEXT);
    CREATE TABLE meeting_plans(id TEXT PRIMARY KEY,mode TEXT,content_json TEXT);
  `);
  const addImport = database.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?)');
  for (const [id,kind] of [['current','offers_current'],['pay','payroll'],['meet','meetings'],['complaints','incidents']]) addImport.run(id,id+'.xlsx',kind,'complete',date,JSON.stringify({snapshot_date:date}),'{}');
  const addOrg=database.prepare('INSERT INTO organizations VALUES(?,?,?,?,?)'), addOffer=database.prepare('INSERT INTO offers VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const addresses=[];
  for(let i=0;i<count;i++){
    const id='fixture-'+i,inn=String(1650000000+i);addOrg.run(id,inn,'8610',i===count-1?'  =1+1':'Синтетический клиент '+String(i).padStart(3,'0'),'{}');
    addOffer.run('row-'+i,'offer-'+i,inn,id,'current',i%2?'Кредит':'Расчёты',100+i,i===2?null:i===0?0:10+i,'Реализация',date,'current',JSON.stringify({manager:'Тестовый КМ',days_in_stage:i%2?40:5}));
    if(i<count-5) addresses.push({id:'addr-'+i,inn,name:'Синтетический клиент '+i,address:'Тестовая улица, '+(i+1),addressKind:'office',coordinates:[49.2,55.8],precision:'building',sourceUrl:'https://example.test/address/'+i,checkedAt:date});
  }
  addOrg.run('without-deals','1660000000','8610','Только зарплатный источник','{}');
  fs.writeFileSync(path.join(target,'organization-addresses.json'),JSON.stringify(addresses));
  database.prepare('INSERT INTO payroll VALUES(?,?,?,?)').run('fixture-0',100,200,JSON.stringify({fot_march:{source_id:'pay'},fot_july:{source_id:'pay'}}));
  database.prepare('INSERT INTO meetings VALUES(?,?,?,?,?,?)').run('fixture-0',0,0,0,0,JSON.stringify({source:{source_id:'meet'}}));
  const incident=database.prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  incident.run('open','Тестовый','Тестовое','ЖКХ','Вода','open','2026-07-02',null,null,null,'complaints','{}');
  incident.run('progress','Тестовый','Тестовое','ЖКХ','Вода','open','2026-07-03',null,null,null,'complaints',JSON.stringify({first_response:'Принято в работу'}));
  incident.run('closed','Тестовый','Тестовое','Дороги','Ремонт','closed','2026-07-04','2026-07-05',null,null,'complaints','{}');
  incident.run('unknown','Тестовый',null,'Дороги','Ремонт','other','bad',null,null,null,'complaints','{}');
  incident.run('unassigned','Неизвестный',null,'ЖКХ','Вода','open','2026-07-06',null,null,null,'complaints','{}');
}
