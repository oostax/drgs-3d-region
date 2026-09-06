/** Optional browser regression: run against a built local atlas with Playwright.
 * Uses explicit synthetic map data: no private SQLite or remote tiles required.
 * PLAYWRIGHT_MODULE may point to an isolated Playwright installation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const baseURL = process.env.ATLAS_BROWSER_URL || 'http://127.0.0.1:3200';
const output = process.env.ATLAS_BROWSER_OUTPUT || '/tmp/atlas-map-browser';
await fs.mkdir(output, { recursive: true });
const feature = (id, x, y, width, depth, properties) => ({ type: 'Feature', id, properties: { id, ...properties }, geometry: { type: 'Polygon', coordinates: [[[x,y],[x+width,y],[x+width,y+depth],[x,y+depth],[x,y]]] } });
const features = [];
for (let row = 0; row < 4; row++) for (let column = 0; column < 5; column++) {
  const index = row * 5 + column;
  features.push(feature(`test-${index}`,49.127 + column * .0012,55.784 + row * .00085,.0007,.00036,
    { class: ['apartments','office','warehouse','house','yes'][column], height: [18,14,8,6,8][column], num_floors: [6,4,2,2,0][column] }));
}
const data = { type:'FeatureCollection', features };
// A valid empty PMTiles archive allows the real source lifecycle to complete.
// Buildings for this test are supplied explicitly below, not claimed as real OSM.
const metadata = Buffer.from(JSON.stringify({vector_layers:[{id:'building',fields:{}},{id:'building_part',fields:{}}]}));
const archive = Buffer.alloc(128 + metadata.length);
archive.write('PMTiles',0); archive[7]=3;
const u64=(offset,value)=>archive.writeBigUInt64LE(BigInt(value),offset);
u64(8,127);u64(16,1);u64(24,128);u64(32,metadata.length);u64(40,archive.length);u64(56,archive.length);
archive[96]=1;archive[97]=1;archive[98]=1;archive[99]=1;archive[100]=10;archive[101]=15;
archive.writeInt32LE(-1800000000,102);archive.writeInt32LE(-850000000,106);archive.writeInt32LE(1800000000,110);archive.writeInt32LE(850000000,114);
archive[118]=13;metadata.copy(archive,128);
const browser = await chromium.launch({ headless:true, args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const report = { fixture:'synthetic buildings; actual Atlas React UI, MapLibre and Three.js', snapshots:[], pageErrors:[], mapErrors:[] };
try {
  const context = await browser.newContext({ viewport:{width:1440,height:900}, reducedMotion:'reduce' });
  await context.addInitScript(() => {
    const RealDate = Date, fixed = new RealDate('2026-09-06T14:21:00Z').getTime();
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };
  });
  const page = await context.newPage();
  page.on('pageerror', error=>report.pageErrors.push(String(error)));
  await page.route('**/api/map/style', route=>route.fulfill({json:{version:8,glyphs:`${baseURL}/__fixture/fonts/{fontstack}/{range}.pbf`,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#bdc6b8'}}]}}));
  await page.route('**/__fixture/fonts/**', route=>route.fulfill({body:Buffer.alloc(0),contentType:'application/x-protobuf'}));
  await page.route('**/api/tiles/buildings*', route=> {
    const match=/bytes=(\d+)-(\d*)/.exec(route.request().headers().range||'');
    const start=match?Number(match[1]):0, end=match?Math.min(archive.length-1,match[2]?Number(match[2]):archive.length-1):archive.length-1;
    return route.fulfill({status:match?206:200,headers:{'content-type':'application/octet-stream','accept-ranges':'bytes',...(match?{'content-range':`bytes ${start}-${end}/${archive.length}`}:{})},body:archive.subarray(start,end+1)});
  });
  await page.goto(`${baseURL}/?mode=public&diagnostics`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__atlasMap && document.querySelector('[data-atlas-ready="true"]'),null,{timeout:60000});
  await page.evaluate(data=> {
    const map=window.__atlasMap;
    window.__mapReviewErrors=[]; map.on('error',event=>window.__mapReviewErrors.push(String(event.error)));
    map.addSource('appearance-fixture',{type:'geojson',data});
    const ids=['atlas-building-flat','atlas-building-3d','atlas-building-parts-3d','atlas-building-roofs','atlas-building-part-roofs'];
    for (const id of ids) {
      const layer=structuredClone(map.getStyle().layers.find(item=>item.id===id));
      if(!layer)throw new Error(`Missing ${id}`);
      map.removeLayer(id);layer.source='appearance-fixture';delete layer['source-layer'];
      if(id.includes('part'))layer.filter=['==',['get','id'],'no-parts-in-fixture'];
      map.addLayer(layer,'atlas-solar-light');
    }
    const query=map.querySourceFeatures.bind(map);
    map.querySourceFeatures=(id,options)=>id==='atlas-buildings'?(options?.sourceLayer==='building'?data.features:[]):query(id,options);
    map.fire('sourcedata',{sourceId:'atlas-buildings',sourceDataType:'content',isSourceLoaded:true});
    map.jumpTo({center:[49.1297,55.7855],zoom:16.2,pitch:0});
  },data);
  const modeButton=()=>page.getByRole('button',{name:/Перейти в [23]D/});
  const settle=async()=> { await page.waitForFunction(()=>window.__atlasMap&&!window.__atlasMap.isMoving()); await page.waitForTimeout(1600); };
  const snapshot=async label=> {
    await settle();
    const state=await page.evaluate(()=>{
      const map=window.__atlasMap,ids=['atlas-building-flat','atlas-building-3d','atlas-building-parts-3d','atlas-building-roofs','atlas-building-part-roofs'];
      return {mode:document.querySelector('main.atlas').dataset.mapMode,pitch:map.getPitch(),maxPitch:map.getMaxPitch(),touchPitch:map.touchPitch.isEnabled(),
        layers:Object.fromEntries(ids.map(id=>[id,map.getLayoutProperty(id,'visibility')])),
        pattern:map.getPaintProperty('atlas-building-3d','fill-extrusion-pattern'),light:map.getLight(),details:map.getCanvas().dataset.buildingDetails};
    });
    report.snapshots.push({label,...state});return state;
  };
  const flat=await snapshot('initial-2d');
  assert.equal(flat.mode,'2d');assert.equal(flat.pitch,0);assert.equal(flat.maxPitch,0);
  assert.equal(flat.layers['atlas-building-flat'],'visible');
  assert.equal(flat.layers['atlas-building-3d'],'none');
  assert.equal(await modeButton().innerText(),'2D');
  await page.screenshot({path:path.join(output,'initial-2d.png')});
  for (let cycle=0;cycle<3;cycle++) {
    await modeButton().click();
    const three=await snapshot(`3d-${cycle}`);
    assert.equal(three.mode,'3d');assert.ok(three.pitch>5);assert.equal(three.layers['atlas-building-flat'],'none');
    assert.equal(three.layers['atlas-building-3d'],'visible');assert.deepEqual(three.pattern,flat.pattern);
    assert.equal(await modeButton().innerText(),'3D');
    if(cycle===0)await page.screenshot({path:path.join(output,'sunset-3d.png')});
    await modeButton().click();
    const two=await snapshot(`2d-${cycle}`);
    assert.equal(two.mode,'2d');assert.equal(two.pitch,0);assert.equal(two.maxPitch,0);assert.deepEqual(two.layers,flat.layers);
  }
  await modeButton().click();await settle();
  await page.evaluate(()=>window.__atlasMap.jumpTo({pitch:0}));await settle();
  assert.equal(await modeButton().innerText(),'3D');
  await modeButton().click();assert.equal((await snapshot('top-down-3d-to-2d')).mode,'2d');
  await page.setViewportSize({width:390,height:844});
  assert.equal((await snapshot('mobile-2d')).maxPitch,0);
  await modeButton().click();assert.equal((await snapshot('mobile-3d')).maxPitch,60);
  await page.screenshot({path:path.join(output,'mobile-3d.png')});
  await page.setViewportSize({width:1440,height:900});
  assert.equal((await snapshot('desktop-restored')).maxPitch,75);
  await modeButton().click();await settle();
  await page.screenshot({path:path.join(output,'returned-2d.png')});
  report.mapErrors=await page.evaluate(()=>window.__mapReviewErrors);
  assert.deepEqual(report.pageErrors,[]);
  assert.deepEqual(report.mapErrors,[]);
  report.result='passed';
} catch(error) {
  report.result='failed';report.failure=String(error);throw error;
} finally {
  await fs.writeFile(path.join(output,'browser-report.json'),JSON.stringify(report,null,2));
  await browser.close();
}
