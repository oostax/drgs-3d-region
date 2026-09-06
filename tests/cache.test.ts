import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const originalCwd=process.cwd();
const originalFetch=globalThis.fetch;
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-basemap-test-'));
// The module fixes its cache root on import. Keep every fixture outside the real cache.
process.chdir(folder);
const {basemapResponse}=await import('../src/lib/basemap-cache');
process.chdir(originalCwd);
const cacheRoot=path.join(folder,'data','public','cache','basemap');
const origin='http://127.0.0.1:3200';
const sourceUrl=(parts:string[])=>`https://tiles.openfreemap.org/${parts.map(encodeURIComponent).join('/')}`;
const cachePath=(parts:string[])=>path.join(cacheRoot,createHash('sha256').update(sourceUrl(parts)).digest('hex'));
function upstream(handler:(url:string,init:RequestInit|undefined)=>Response|Promise<Response>){
  globalThis.fetch=async(input,init)=>handler(String(input),init);
}
after(()=>{globalThis.fetch=originalFetch;process.chdir(originalCwd);fs.rmSync(folder,{recursive:true,force:true});});

test('basemap rejects unsupported paths and traversal before any upstream request',async()=>{
  let calls=0;upstream(()=>{calls++;throw new Error('Unexpected network call');});
  const rejected=[[],['private-data','atlas.sqlite'],['https://evil.invalid/map'],['//evil.invalid/map'],['planet','..','secret'],['fonts','../secret'],['planetary','tile'],['sprites', 'x'.repeat(501)]];
  for(const parts of rejected)assert.equal((await basemapResponse(parts,origin)).status,404);
  assert.equal(calls,0);
  assert.equal(fs.existsSync(cacheRoot),false);
});

test('all four public asset families use the fixed host without private headers or parameters',async()=>{
  const observed:{url:string;init:RequestInit|undefined}[]=[];
  upstream((url,init)=>{observed.push({url,init});return new Response(new Uint8Array([0,1,2]),{headers:{'Content-Type':'application/octet-stream'}});});
  const allowed=[['planet','fixture','2','1','0.pbf'],['fonts','Noto Sans Regular','0-255.pbf'],['sprites','fixture','ofm.png'],['natural_earth','ne2sr','0','0','0.png']];
  for(const parts of allowed){const response=await basemapResponse(parts,origin);assert.equal(response.status,200);assert.equal(response.headers.get('X-Atlas-Cache'),'miss');}
  assert.equal(observed.length,4);
  for(const {url,init}of observed){
    const target=new URL(url);
    assert.equal(target.origin,'https://tiles.openfreemap.org');assert.equal(target.search,'');assert.equal(target.hash,'');
    assert.equal(target.username,'');assert.equal(target.password,'');
    assert.deepEqual([...new Headers(init?.headers).entries()],[['user-agent','SberAtlas-local-pilot/0.1']]);
    assert.equal(init?.body,undefined);assert.equal(init?.credentials,undefined);
  }
  assert.equal(fs.existsSync(path.join(folder,'private-data')),false);
});

test('saved binary tile remains byte-identical offline without attempting the upstream',async()=>{
  const parts=['planet','offline-fixture','1','0','1.pbf'];
  const tile=new Uint8Array([0,255,128,10,13,200]);
  upstream(()=>new Response(tile,{headers:{'Content-Type':'application/vnd.mapbox-vector-tile'}}));
  const online=await basemapResponse(parts,origin);
  assert.equal(online.headers.get('X-Atlas-Cache'),'miss');
  assert.deepEqual(new Uint8Array(await online.arrayBuffer()),tile);
  let networkAttempts=0;upstream(()=>{networkAttempts++;throw new TypeError('Network unavailable');});
  const offline=await basemapResponse(parts,origin);
  assert.equal(offline.status,200);assert.equal(offline.headers.get('X-Atlas-Cache'),'hit');
  assert.equal(offline.headers.get('Content-Type'),'application/vnd.mapbox-vector-tile');
  assert.deepEqual(new Uint8Array(await offline.arrayBuffer()),tile);assert.equal(networkAttempts,0);
});

test('TileJSON stays reusable across local origins and resolves only map source URLs through the cache',async()=>{
  const parts=['planet'];
  upstream(()=>Response.json({tiles:['https://tiles.openfreemap.org/planet/fixture/{z}/{x}/{y}.pbf'],attribution:'Public map fixture'}));
  const first=await basemapResponse(parts,origin);
  assert.equal((await first.json()).tiles[0],origin+'/api/basemap/planet/fixture/{z}/{x}/{y}.pbf');
  const disk=fs.readFileSync(cachePath(parts),'utf8');
  assert.equal(disk.includes(origin),false);assert.equal(disk.includes('https://tiles.openfreemap.org/'),false);
  upstream(()=>{throw new TypeError('Offline');});
  const localOrigin='http://localhost:3200';
  const second=await basemapResponse(parts,localOrigin);
  assert.equal(second.headers.get('X-Atlas-Cache'),'hit');
  assert.equal((await second.json()).tiles[0],localOrigin+'/api/basemap/planet/fixture/{z}/{x}/{y}.pbf');
});

test('embedded URL syntax cannot become a destination or query string',async()=>{
  let actual='';upstream(url=>{actual=url;return new Response('fixture');});
  const parts=['fonts','https://evil.invalid/fixture?token=SYNTHETIC#fragment','0-255.pbf'];
  assert.equal((await basemapResponse(parts,origin)).status,200);
  const target=new URL(actual);
  assert.equal(target.origin,'https://tiles.openfreemap.org');assert.equal(target.search,'');assert.equal(target.hash,'');
  assert.ok(target.pathname.includes('https%3A%2F%2Fevil.invalid'));
});

test('uncached network failure and HTTP error return explicit failures without saving an empty tile',async()=>{
  const offlineParts=['planet','uncached-offline','0','0','0.pbf'];
  upstream(()=>{throw new TypeError('Network unavailable');});
  assert.equal((await basemapResponse(offlineParts,origin)).status,503);
  assert.equal(fs.existsSync(cachePath(offlineParts)),false);
  const httpParts=['planet','uncached-http-error','0','0','0.pbf'];
  upstream(()=>new Response('Upstream failed',{status:500}));
  assert.equal((await basemapResponse(httpParts,origin)).status,502);
  assert.equal(fs.existsSync(cachePath(httpParts)),false);
});
