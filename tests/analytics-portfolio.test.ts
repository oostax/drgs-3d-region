import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnalyticsFixture } from './fixtures/analytics';
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-analytics-'));
process.env.ATLAS_DB=path.join(folder,'private.sqlite');process.env.ATLAS_LIVE_DB=path.join(folder,'absent-live.sqlite');process.env.ATLAS_DATA_ROOT=folder;
const {territoryAnalytics,summarizeComplaints,complaintState,recentAnalyticsSignals,analyticsSignals}=await import('../src/lib/territory-analytics');
const {GET:analytics}=await import('../src/app/api/analytics/route');
const {GET:portfolio}=await import('../src/app/api/portfolio/route');
const {POST:enrich}=await import('../src/app/api/client-enrichment/route');
const publicBefore=territoryAnalytics('public'),openedBefore=fs.existsSync(process.env.ATLAS_DB);
const {db}=await import('../src/lib/db');createAnalyticsFixture(folder,db({create:true}));
const {loadClientPortfolio}=await import('../src/lib/client-portfolio');
const {lookupCompany}=await import('../src/lib/client-enrichment');
const {territoryIndex,isoDay}=await import('../src/lib/territory-scope');
const {getTerritories}=await import('../src/lib/atlas-data');
const {csvCell}=await import('../src/lib/portfolio-csv');
const request=(p:string,init?:RequestInit)=>new Request('http://127.0.0.1:3200'+p,init);
after(()=>{db().close();fs.rmSync(folder,{recursive:true,force:true});});
test('public analytics cannot open the private store or expose portfolio, complaints, INNs and addresses',async()=>{
  assert.equal(openedBefore,false);assert.equal(publicBefore.portfolio,null);assert.equal(publicBefore.complaints,null);
  const r=await analytics(request('/api/analytics?mode=public'));assert.equal(r.status,200);const body=await r.json();assert.equal(body.portfolio,null);assert.equal(body.complaints,null);assert.ok(!JSON.stringify(body).includes('Синтетический клиент'));assert.equal(r.headers.get('cache-control'),'private, no-store');
});
test('private APIs reject foreign origins and missing explicit mode, including mutations',async()=>{
  for(const headers of [{origin:'https://evil.test'}, {host:'evil.test'}, {'sec-fetch-site':'cross-site'}] as Record<string,string>[]){
    assert.equal((await portfolio(request('/api/portfolio?mode=work',{headers}))).status,403);
    assert.equal((await analytics(request('/api/analytics?mode=work',{headers}))).status,403);
    assert.equal((await enrich(request('/api/client-enrichment?mode=work',{method:'POST',headers,body:'{}'}))).status,403);
  }
  assert.equal((await portfolio(request('/api/portfolio'))).status,403);
});
test('complaint index partitions all records and progress is a subset, not double-counted',()=>{
  const result=territoryAnalytics('work','RU-TA');const c=result.complaints!;
  assert.equal(c.total,5);assert.equal(c.open,3);assert.equal(c.inProgress,1);assert.equal(c.closed,1);assert.equal(c.unknown,1);assert.equal(c.index,75);assert.equal(c.unknownDates,1);assert.equal(c.unassignedWithinScope,1);
  const district=territoryAnalytics('work','district-a');assert.equal(district.complaints!.total,4);assert.equal(district.complaints!.unassignedWithinScope,1);
  const settlement=territoryAnalytics('work','settlement-a');assert.equal(settlement.complaints!.total,3);assert.equal(settlement.complaints!.index,200/3);
  assert.equal(summarizeComplaints([]).index,null);assert.equal(complaintState({status:'???',closedAt:null,response:null}),'unknown');
});
test('portfolio consumes every client, map is not a 40-item page and uses the same filters',async()=>{
  const list=await (await portfolio(request('/api/portfolio?mode=work'))).json();assert.equal(list.total,85);assert.equal(list.items.length,40);
  const last=await (await portfolio(request('/api/portfolio?mode=work&offset=80'))).json();assert.equal(last.items.length,5);
  const map=await (await portfolio(request('/api/portfolio?mode=work&map=true'))).json();assert.equal(map.total,85);assert.equal(map.items.length,80);assert.equal(map.unlocated,5);assert.equal(map.portfolioInns.length,85);
  const filter='&location=missing';const missing=await (await portfolio(request('/api/portfolio?mode=work'+filter))).json();const mapMissing=await (await portfolio(request('/api/portfolio?mode=work&map=true'+filter))).json();assert.equal(missing.total,5);assert.equal(mapMissing.total,5);assert.equal(mapMissing.items.length,0);
  const search=await (await portfolio(request('/api/portfolio?mode=work&map=true&q=1650000000'))).json();assert.equal(search.total,1);
  assert.ok(!JSON.stringify(map.items).includes('expectedIncome'));assert.ok(!('income' in map.items[0]));
});
test('nullable sums, geographic accounting, payroll cohort and meetings use facts rather than GOSB',()=>{
  const p=loadClientPortfolio();assert.equal(p.rows.length,86);assert.equal(p.rows[0].income,0);assert.equal(p.summary.missingIncome,1);assert.equal(p.summary.payrollGrowth,100);assert.equal(p.summary.payrollComparableClients,1);
  const row=p.rows.find(r=>r.id==='fixture-0')!;assert.ok(row.actions.some(a=>a.rule==='contact'));assert.ok(row.actions.some(a=>a.rule==='payroll'));assert.deepEqual(row.scopes,['settlement-a','district-a','RU-TA']);
  assert.deepEqual(p.rows.find(r=>r.id==='fixture-84')!.scopes,[]);assert.deepEqual(p.rows.find(r=>r.id==='fixture-1')!.meetings,[null,null,null]);
  const a=territoryAnalytics('work','district-b');assert.equal(a.portfolio!.summary.offers,0);assert.equal(a.portfolio!.summary.income,null);assert.equal(a.portfolio!.unassigned.organizations,6);
});
test('fresh public signals use all pages, exact INN links and disjoint stage metrics',async()=>{
  const a=territoryAnalytics('work','RU-TA');assert.equal(a.signals.count,2);assert.equal(a.signals.work,1);assert.equal(a.signals.results,1);assert.equal(a.signals.problems,0);
  const p=await (await portfolio(request('/api/portfolio?mode=work&action=signal'))).json();assert.equal(p.total,1);assert.equal(p.items[0].inn,'1650000000');
  const banks=a.banks;assert.equal(a.priority.numbers.verifiedLocations,2);assert.equal(banks.length,2);assert.equal(banks.reduce((s,b)=>s+b.count,0),2);assert.equal(a.sberShare,50);
});
test('a running replacement cannot replace completed deals and unsafe mutable counters become unknown',()=>{
  db().prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?)').run('running','replacement.xlsx','offers_current','running','2099-01-01','{}','{}');
  db().prepare('INSERT INTO offers SELECT ?,?,inn,org_id,snapshot,product,amount,999999,stage,stage_date,?,data_json FROM offers WHERE id=?').run('running-row','running-offer','running','row-0');
  assert.equal(loadClientPortfolio().summary.offers,85);assert.equal(loadClientPortfolio().rows[0].income,0);
  db().prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?)').run('pay-running','pay-new.xlsx','payroll','running','2099-01-01','{}','{}');assert.equal(loadClientPortfolio().summary.payrollMarch,null);
  db().prepare('DELETE FROM imports WHERE id IN (?,?)').run('running','pay-running');db().prepare('DELETE FROM offers WHERE id=?').run('running-row');
});
test('duplicate and conflicting offer IDs never multiply totals',()=>{
  db().prepare('INSERT INTO offers SELECT ?,offer_id,inn,org_id,snapshot,product,amount,expected_income,stage,stage_date,source_id,data_json FROM offers WHERE id=?').run('dup','row-0');
  let p=loadClientPortfolio();assert.equal(p.summary.offers,85);assert.equal(p.summary.duplicateOffers,1);
  db().prepare('UPDATE offers SET expected_income=1000 WHERE id=?').run('dup');p=loadClientPortfolio();assert.equal(p.summary.offers,84);assert.equal(p.summary.ambiguousOffers,2);assert.equal(p.rows[0].income,null);
  db().prepare('DELETE FROM offers WHERE id=?').run('dup');
});
test('geometry requires polygons, handles holes and ambiguous borders without assigning clients to centroids',()=>{
  const territories=getTerritories(),index=territoryIndex(territories);assert.deepEqual(index.point([50,55.8]),['RU-TA']);assert.deepEqual(index.point([100,55]),[]);assert.deepEqual(index.point([200,55]),[]);
  const ring=[[49.15,55.7],[49.25,55.7],[49.25,55.85],[49.15,55.85],[49.15,55.7]];const t=structuredClone(territories);if(t[2].geometry?.type==='Polygon')t[2].geometry.coordinates.push(ring);assert.deepEqual(territoryIndex(t).point([49.2,55.8]),['district-a','RU-TA']);
  assert.equal(isoDay('2026-02-30'),null);assert.equal(isoDay('2026-09-06Tbad'),null);assert.equal(isoDay('2024-02-29'),'2024-02-29');assert.deepEqual(recentAnalyticsSignals([],45,'bad'),[]);
});
test('missing-address export guards formulas and cannot leak in public mode',async()=>{
  const r=await portfolio(request('/api/portfolio?mode=work&export=missing'));assert.equal(r.status,200);const csv=await r.text();assert.ok(csv.includes("'=1+1"));assert.ok(csv.includes('1650000084'));assert.ok(!csv.includes('999999'));
  assert.equal(csvCell('  =1+1'),`"'  =1+1"`);assert.equal(csvCell('@SUM(A1)'),`"'@SUM(A1)"`);assert.equal(csvCell('ООО "Тест"'),'"ООО ""Тест"""');
});
test('enrichment never sends anything without explicit consent or an optional server key',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('network not expected');};
  try { delete process.env.ATLAS_DADATA_TOKEN;const r=await enrich(request('/api/client-enrichment?mode=work',{method:'POST',body:JSON.stringify({action:'external',consent:false,orgIds:['fixture-84']})}));assert.equal(r.status,400);assert.equal(calls,0);assert.equal(await lookupCompany('165000000000','test'),null);assert.equal(calls,0); }
  finally {globalThis.fetch=old;}
});
test('external identity and coordinate precision are validated and only an INN leaves the process',async()=>{
  const old=globalThis.fetch;const inn='1650000084';let captured:RequestInit|undefined;
  const payload=(qc:string)=>({suggestions:[{data:{inn,type:'LEGAL',branch_type:'MAIN',name:{full_with_opf:'Тестовый клиент'},address:{value:'Тестовая, 1',data:{geo_lon:'49.2',geo_lat:'55.8',house:'1',qc_geo:qc}}}}]});
  try{globalThis.fetch=async(_url,init)=>{captured=init;return Response.json(payload('1'));};let c=await lookupCompany(inn,'test-token');assert.equal(c?.coordinates,null);assert.deepEqual(JSON.parse(String(captured?.body)),{query:inn,branch_type:'MAIN',type:'LEGAL',count:10});
    globalThis.fetch=async()=>Response.json(payload('0'));c=await lookupCompany(inn,'test-token');assert.deepEqual(c?.coordinates,[49.2,55.8]);assert.equal(c?.addressKind,'legal');assert.equal(c?.requiresMeetingConfirmation,true);
    globalThis.fetch=async()=>Response.json({...payload('0'),suggestions:[...payload('0').suggestions,...payload('0').suggestions]});assert.equal(await lookupCompany(inn,'test-token'),null);
  }finally{globalThis.fetch=old;}
});
test('manual points survive late enrichment and malformed payloads are rejected',async()=>{
  const {saveOrganizationLocation,organizationLocation}=await import('../src/lib/organization-locations');const {enrichClients}=await import('../src/lib/client-enrichment');const old=globalThis.fetch;process.env.ATLAS_DADATA_TOKEN='test';
  try{globalThis.fetch=async()=>{saveOrganizationLocation('work',{orgId:'fixture-84',kind:'legal',address:'Ручной адрес',coordinates:[49.3,55.8],precision:'building',sourceUrl:'',confirmed:true});return Response.json({suggestions:[{data:{inn:'1650000084',type:'LEGAL',branch_type:'MAIN',address:{value:'Другой адрес',data:{geo_lon:'49.2',geo_lat:'55.8',house:'1',qc_geo:'0'}}}}]});};const result=await enrichClients(['fixture-84'],true);assert.equal(result.results[0].status,'retained');assert.equal(organizationLocation('work',{id:'fixture-84',inn:'1650000084',name:'Test'})?.legalAddress?.address,'Ручной адрес');}
  finally{globalThis.fetch=old;delete process.env.ATLAS_DADATA_TOKEN;}
  const r=await enrich(request('/api/client-enrichment?mode=work',{method:'POST',body:'x'.repeat(17000)}));assert.equal(r.status,400);
});

test('analytics reads signals beyond the first thousand without dropping the final source page',()=>{
  const file=path.join(folder,'public/data/signals.json'),original=fs.readFileSync(file,'utf8');
  const sample=JSON.parse(original)[0];
  try {
    fs.writeFileSync(file,JSON.stringify(Array.from({length:1025},(_,i)=>({...sample,id:`page-${i}`}))));
    const rows=analyticsSignals();
    assert.equal(rows.length,1025);assert.equal(new Set(rows.map(r=>r.id)).size,1025);
    assert.ok(rows.some(r=>r.id==='page-1024'));
  } finally { fs.writeFileSync(file,original); }
});


test('client view hides overlapping analytic pins without changing saved map preferences', async () => {
  const { clientViewLayers } = await import('../src/lib/client-map-visibility');
  const layers = { banks: true, signals: true, landmarks: true, buildings: true, boundaries: false, terrain: true };
  assert.equal(clientViewLayers(layers, false), layers);
  const focused = clientViewLayers(layers, true);
  assert.deepEqual(focused, { ...layers, banks: false, signals: false, landmarks: false });
  assert.equal(layers.banks, true); assert.equal(layers.signals, true); assert.equal(layers.landmarks, true);
  assert.equal(clientViewLayers(layers, false), layers, 'leaving client view restores the original preferences');
});
