import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-client-addresses-'));
process.env.ATLAS_DB=path.join(folder,'private.sqlite');
process.env.ATLAS_PUBLIC_ORG_INDEX=path.join(folder,'public-empty.json');
const {parseClientAddressFile,previewClientAddresses,importClientAddresses,restoreClientAddressImport}=await import('../src/lib/client-address-import');
const {db}=await import('../src/lib/db');
const {saveOrganizationLocation,organizationLocation}=await import('../src/lib/organization-locations');
const {clientMap}=await import('../src/lib/client-map');
const {GET,POST,PATCH}=await import('../src/app/api/client-addresses/route');
const csv=(rows:string[])=>Buffer.from('inn;name;gosb;address;addressKind;longitude;latitude\n'+rows.join('\n'));
after(()=>{db().close();fs.rmSync(folder,{recursive:true,force:true});});

test('public mode cannot open private database or parse an upload',async()=>{
  await assert.rejects(importClientAddresses('public','x.csv',csv([])),/рабочем/);
  assert.throws(()=>restoreClientAddressImport('public','unknown'),/рабочем/);
  assert.equal(fs.existsSync(process.env.ATLAS_DB!),false);
  db({create:true}).exec('CREATE TABLE organizations(id TEXT PRIMARY KEY,inn TEXT,gosb TEXT,name TEXT,data_json TEXT)');
  const add=db().prepare('INSERT INTO organizations VALUES(?,?,?,?,?)');
  for(let i=1;i<=9;i++)add.run('org-'+i,'165500000'+i,'8610','Fixture '+i,'{}');
  add.run('other-gosb','1655000009','1234','Fixture 9','{}');
});
test('CSV handles quoted addresses, Cyrillic headers and textual INN without padding',async()=>{
  const rows=await parseClientAddressFile('clients.csv',Buffer.from('\uFEFFИНН;Название;ГОСБ;Адрес;Тип адреса;Долгота;Широта\n0165500001;Фирма;8610;"Казань; улица Ленина, 3";office;49,1;55,2'));
  assert.equal(rows[0].inn,'0165500001');assert.equal(rows[0].address,'Казань; улица Ленина, 3');assert.equal(rows[0].addressKind,'office');
});
test('XLSX is parsed locally without formula execution',async()=>{
  const make=(formula=false)=>execFileSync('python3',['-c',`import io,sys,zipfile
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Адреса" sheetId="1" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>inn</t></is></c><c r="B1" t="inlineStr"><is><t>address</t></is></c></row><row r="2"><c r="A2"><v>1655000001</v></c><c r="B2" t="inlineStr">${formula?'<f>HYPERLINK("https://invalid")</f>':''}<is><t>Казань, улица Ленина, 3</t></is></c></row></sheetData></worksheet>')
sys.stdout.buffer.write(b.getvalue())`]);
  const result=await parseClientAddressFile('clients.xlsx',make());assert.equal(result[0].inn,'1655000001');assert.equal(result[0].address,'Казань, улица Ленина, 3');
  await assert.rejects(parseClientAddressFile('clients.xlsx',make(true)),/формул/);
});
test('preview changes no locations, apply requires preview and uses exact INN',async()=>{
  const payload=csv(['1655000001;Different name;8610;Казань, Ленина 1;office;49.1;55.2','1655000002;Fixture 2;8610;Казань, Ленина 2;legal;;','9999999999;Fixture 1;8610;Unknown;legal;49;55']);
  await assert.rejects(importClientAddresses('work','clients.csv',payload,true),/предпросмотр/);
  const preview=await importClientAddresses('work','clients.csv',payload);
  assert.equal(preview.total,3);assert.equal(preview.valid,2);assert.equal(preview.matched,2);assert.equal(preview.located,1);assert.equal(preview.rejected,1);
  assert.equal(db().prepare("SELECT name FROM sqlite_master WHERE name='organization_locations'").get(),undefined);
  const applied=await importClientAddresses('work','clients.csv',payload,true);assert.equal(applied.applied,true);assert.equal(applied.changed,2);
  const a=organizationLocation('work',{id:'org-1',inn:'1655000001',name:'Fixture 1'})!;
  assert.deepEqual(a.office?.coordinates,[49.1,55.2]);assert.equal(a.status,'source_exact');assert.equal(a.office?.confirmedByUser,false);
  const b=organizationLocation('work',{id:'org-2',inn:'1655000002',name:'Fixture 2'})!;assert.equal(b.legalAddress?.coordinates,null);assert.equal(b.status,'candidate');
  assert.deepEqual(clientMap().items.map(r=>r.id),['org-1']);
  assert.equal((db().prepare('SELECT count(*) n FROM client_address_imports').get() as {n:number}).n,1);
});
test('manual locations and competing addresses remain intact with imported candidates',async()=>{
  saveOrganizationLocation('work',{orgId:'org-3',kind:'office',address:'Manual address',coordinates:[49.2,55.3],precision:'building',confirmed:true});
  const payload=csv(['1655000003;Fixture 3;8610;Imported address;office;50;56','1655000004;Fixture 4;8610;First;legal;49;55','1655000004;Fixture 4;8610;Second;legal;49.5;55.5']);
  const preview=await importClientAddresses('work','clients.csv',payload);assert.deepEqual(preview.rows.map(r=>r.status),['preserved','candidate','candidate']);assert.equal(preview.located,0);
  await importClientAddresses('work','clients.csv',payload,true);
  const manual=organizationLocation('work',{id:'org-3',inn:'1655000003',name:'Fixture 3'})!;assert.equal(manual.office?.address,'Manual address');assert.equal(manual.office?.confirmedByUser,true);assert.equal(manual.candidates.length,1);
  const ambiguous=organizationLocation('work',{id:'org-4',inn:'1655000004',name:'Fixture 4'})!;assert.equal(ambiguous.legalAddress,null);assert.equal(ambiguous.candidates.length,2);assert.equal(ambiguous.status,'candidate');
});
test('multiple GOSB, malformed coordinates and exact row repeats are explicit in preview',async()=>{
  const rows=await parseClientAddressFile('clients.csv',csv(['1655000009;Fixture 9;;Address;legal;;','1655000005;Fixture 5;8610;Address;legal;49;','1655000006;Fixture 6;8610;Address;legal;;','1655000006;Fixture 6;8610;Address;legal;;']));
  const result=previewClientAddresses('work',rows,'x');assert.deepEqual(result.rows.map(r=>r.status),['rejected','rejected','unlocated','duplicate']);assert.equal(result.valid,1);assert.equal(result.located,0);
});
test('a manual correction between preview and apply requires another preview',async()=>{
  const payload=csv(['1655000007;Fixture 7;8610;Imported;office;49;55']);await importClientAddresses('work','clients.csv',payload);
  saveOrganizationLocation('work',{orgId:'org-7',kind:'office',address:'New manual',coordinates:[49.4,55.4],precision:'building',confirmed:true});
  await assert.rejects(importClientAddresses('work','clients.csv',payload,true),/изменились/);
  assert.equal(organizationLocation('work',{id:'org-7',inn:'1655000007',name:'Fixture 7'})?.office?.address,'New manual');
});
test('API rejects public and foreign requests and returns a header-only template',async()=>{
  assert.equal((await GET(new Request('http://127.0.0.1:3200/api/client-addresses?mode=public'))).status,403);
  const template=await GET(new Request('http://127.0.0.1:3200/api/client-addresses?mode=work'));assert.equal(template.status,200);assert.match(await template.text(),/inn;name;gosb;address/);
  const form=new FormData();form.set('mode','public');form.set('file',new File([csv([])],'clients.csv'));
  assert.equal((await POST(new Request('http://127.0.0.1:3200/api/client-addresses',{method:'POST',body:form}))).status,403);
  assert.equal((await POST(new Request('http://127.0.0.1:3200/api/client-addresses',{method:'POST',headers:{Origin:'https://foreign.invalid'},body:form}))).status,403);
});

test('import preserves an unsaved public-source address and restore reveals it again',async()=>{
  fs.writeFileSync(process.env.ATLAS_PUBLIC_ORG_INDEX!,JSON.stringify([{id:'source-office',inn:'1655000008',name:'Fixture 8',addressKind:'office',address:'Source office',coordinates:[49.7,55.7],precision:'building',sourceUrl:'https://example.org/office',checkedAt:'2026-09-05'}]));
  try{
    const payload=csv(['1655000008;Fixture 8;8610;Different imported office;office;49.8;55.8']);
    const preview=await importClientAddresses('work','source-conflict.csv',payload);
    assert.equal(preview.rows[0].status,'candidate');assert.equal(preview.located,0);
    assert.equal(db().prepare('SELECT data_json FROM organization_locations WHERE org_id=?').get('org-8'),undefined);
    const applied=await importClientAddresses('work','source-conflict.csv',payload,true);
    const location=organizationLocation('work',{id:'org-8',inn:'1655000008',name:'Fixture 8'})!;
    assert.equal(location.office?.address,'Source office');assert.equal(location.candidates[0].address,'Different imported office');
    assert.deepEqual(restoreClientAddressImport('work',applied.importId!),{restored:true,changed:1});
    assert.equal(db().prepare('SELECT data_json FROM organization_locations WHERE org_id=?').get('org-8'),undefined);
    assert.equal(organizationLocation('work',{id:'org-8',inn:'1655000008',name:'Fixture 8'})?.office?.address,'Source office');
    assert.deepEqual(restoreClientAddressImport('work',applied.importId!),{restored:true,changed:0});
  }finally{fs.rmSync(process.env.ATLAS_PUBLIC_ORG_INDEX!,{force:true});}
});
test('restore is atomic and cannot overwrite a subsequent manual correction',async()=>{
  const payload=csv(['1655000005;Fixture 5;8610;Imported five;office;49.1;55.1','1655000008;Fixture 8;8610;Imported eight;office;49.8;55.8']);
  await importClientAddresses('work','rollback-guard.csv',payload);const applied=await importClientAddresses('work','rollback-guard.csv',payload,true);
  saveOrganizationLocation('work',{orgId:'org-8',kind:'office',address:'New manual eight',coordinates:[49.85,55.85],precision:'building',confirmed:true});
  assert.throws(()=>restoreClientAddressImport('work',applied.importId!),/изменились/);
  assert.equal(organizationLocation('work',{id:'org-5',inn:'1655000005',name:'Fixture 5'})?.office?.address,'Imported five');
  assert.equal(organizationLocation('work',{id:'org-8',inn:'1655000008',name:'Fixture 8'})?.office?.address,'New manual eight');
});
test('API preview/apply/restore stays local, retains portfolio membership and checks the exact file',async()=>{
  const payload=csv(['1655000006;Fixture 6;8610;API office;office;49.6;55.6']);
  const count=(db().prepare('SELECT count(*) n FROM organizations').get() as {n:number}).n;
  const request=(apply:boolean,body=payload)=>{const form=new FormData();form.set('mode','work');form.set('apply',String(apply));form.set('file',new File([body],'api.csv'));return new Request('http://127.0.0.1:3200/api/client-addresses',{method:'POST',body:form});};
  const publicRequest=request(false);assert.equal((await POST(new Request(publicRequest.url+'?mode=public',publicRequest))).status,403);
  const preview=await POST(request(false));assert.equal(preview.status,200);assert.equal((await preview.json()).applied,false);assert.equal(preview.headers.get('Cache-Control'),'private, no-store');
  assert.equal((await POST(request(true,csv(['1655000006;Fixture 6;8610;Changed;office;49.6;55.6'])))).status,400);
  const response=await POST(request(true));assert.equal(response.status,200);const applied=await response.json();assert.ok(applied.importId);
  const restoreRequest=(mode:string,origin?:string)=>new Request('http://127.0.0.1:3200/api/client-addresses',{method:'PATCH',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify({mode,importId:applied.importId})});
  assert.equal((await PATCH(restoreRequest('public'))).status,403);assert.equal((await PATCH(restoreRequest('work','https://foreign.invalid'))).status,403);
  const restored=await PATCH(restoreRequest('work'));assert.equal(restored.status,200);assert.equal((await restored.json()).restored,true);
  assert.equal(db().prepare('SELECT data_json FROM organization_locations WHERE org_id=?').get('org-6'),undefined);
  assert.equal((db().prepare('SELECT count(*) n FROM organizations').get() as {n:number}).n,count);
});
test('API caps the streamed upload even when Content-Length is absent',async()=>{
  const data=new Uint8Array(5*1024*1024+100_001);
  const request=new Request('http://127.0.0.1:3200/api/client-addresses',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=x'},body:data});
  assert.equal(request.headers.has('content-length'),false);assert.equal((await POST(request)).status,413);
});
