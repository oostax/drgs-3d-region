import test from 'node:test';
import assert from 'node:assert/strict';
import type { Map as LibreMap } from 'maplibre-gl';
import type { Signal } from '../src/lib/types';
import { SIGNAL_ICON_NODES } from '../src/lib/signal-icon-nodes';
import { signalMarker } from '../src/lib/signal-markers';
import { blendMarkerRasters, disposeMarkerMotion, markerMotionTheme, markerMotionTone, markerPhase, morphMarkerRasters, renderMarkerMotion, renderMarkerSequence, updateMarkerMotion, type MarkerRaster } from '../src/lib/map-marker-motion';

const now = Date.parse('2026-09-04T12:00:00Z');
const signal = (id: string, category = 'ЖКХ', title = 'Водоснабжение'): Signal => ({ id, category, title, publishedAt: '2026-09-01', coordinates: [49.12,55.79], precision: 'street' } as Signal);
const raster = (): MarkerRaster => { const data = new Uint8ClampedArray(112*136*4); for(let i=0;i<data.length;i+=4){data[i]=40;data[i+1]=90;data[i+2]=130;data[i+3]=255;}return {width:112,height:136,data}; };
function fixture(signals: Signal[] = [signal('water')]) {
  let visible = signals.map(s => ({ id:s.id, properties:{id:s.id,marker:signalMarker(s).imageId} })), removed = false;
  const writes: {id:string;image:MarkerRaster}[] = []; let scans = 0, renders = 0;
  const map = {getStyle:()=>{if(removed)throw new Error('removed');return {layers:[]};},getLayer:()=>({}),getCanvas:()=>({clientWidth:1000}),hasImage:()=>true,queryRenderedFeatures:()=>{scans++;return visible;},updateImage:(id:string,image:MarkerRaster)=>writes.push({id,image})} as unknown as LibreMap;
  const options = {now,renderMarker:()=>{renders++;return raster();}};
  return {map,options,writes,visible:(features:typeof visible)=>{visible=features;},remove:()=>{removed=true;},counts:()=>({scans,renders})};
}

test('theme motion follows taxonomy while mixed status never gets a false resolved check',()=>{
  for(const [category,title,theme] of [['ЖКХ','Водоснабжение','water'],['ЖКХ','Отопление','heat'],['Дороги','Ремонт дороги','sequence'],['Социальная поддержка','Пособия','heart'],['Здравоохранение','Медпомощь','heart'],['Благоустройство','Озеленение','leaf'],['Связь','Интернет','connectivity']] as const)assert.equal(markerMotionTheme(signalMarker(signal('s',category,title))),theme);
  const fresh=signal('fresh'),old={...fresh,publishedAt:'2026-07-01'},resolved={...fresh,closedAt:'2026-09-03'};
  assert.equal(markerMotionTone([fresh],now),'normal');assert.equal(markerMotionTone([old],now),'quiet');assert.equal(markerMotionTone([resolved],now),'resolved');assert.equal(markerMotionTone([fresh,resolved],now),'quiet');
});

test('the full pin breathes on a smooth cycle; archive and resolved sprites stay static',()=>{
  const base=raster(), original = new Uint8ClampedArray(base.data);
  for(const theme of ['water','heat','sequence','heart','leaf','connectivity','glint'] as const){
    const start=renderMarkerMotion(base,theme,0,'normal'),peak=renderMarkerMotion(base,theme,.5,'normal'),end=renderMarkerMotion(base,theme,1,'normal');
    assert.deepEqual(start,base);assert.deepEqual(end,base);assert.equal(peak.width,base.width);assert.equal(peak.height,base.height);
    let changed=0;for(let i=0;i<base.data.length;i++)if(peak.data[i]!==base.data[i])changed++;
    assert.ok(changed>1000,'the face itself conveys activity, not a tiny decoration below');
    for(const tone of ['quiet','resolved'] as const) assert.deepEqual(renderMarkerMotion(base,theme,.5,tone),base);
  }
  assert.deepEqual(base.data,original,'cached source sprite remains immutable');
});

test('current markers progress from their topic glyph to their status glyph without a hard cut',()=>{
  const topic=raster(),status={...raster(),data:new Uint8ClampedArray(raster().data.map((value,index)=>index%4===0?200:value))};
  assert.equal(markerPhase(.2),'topic');assert.equal(markerPhase(.42),'to-status');assert.equal(markerPhase(.7),'status');assert.equal(markerPhase(.84),'to-topic');
  assert.deepEqual(renderMarkerSequence(topic,status,'water',.7,'normal'),status);
  assert.notDeepEqual(blendMarkerRasters(topic,status,.5),topic);
  assert.notDeepEqual(blendMarkerRasters(topic,status,.5),status);
  assert.deepEqual(renderMarkerSequence(topic,status,'water',.7,'resolved'),topic);
});

test('the icon changes geometry inside one immutable pin instead of crossfading whole sprites',()=>{
  const topic=raster(),status=raster(),box={left:35,top:23};
  for(let y=0;y<26;y++)for(let x=0;x<3;x++){const a=((box.top+y)*112+box.left+8+x)*4;topic.data[a]=topic.data[a+1]=topic.data[a+2]=255;const b=((box.top+12+y%3)*112+box.left+x+4)*4;status.data[b]=status.data[b+1]=status.data[b+2]=255;}
  const frame=morphMarkerRasters(topic,status,.5);
  assert.deepEqual(frame.data.slice(0,400),topic.data.slice(0,400),'pin pixels outside the face stay unchanged');
  assert.notDeepEqual(frame.data,blendMarkerRasters(topic,status,.5).data,'shape morph differs from a whole-image dissolve');
});

test('updates touch existing visible category sprites only, throttle scans and restore on pause',()=>{
  const records=[signal('water'),signal('hidden','Социальная поддержка','Помощь гражданам')],f=fixture(records);f.visible([{id:'water',properties:{id:'water',marker:signalMarker(records[0]).imageId}}]);
  const first=updateMarkerMotion(f.map,records,0,true,f.options);assert.equal(first.activeSprites,1);assert.equal(f.writes.length,1);assert.equal(f.counts().renders,1);
  for(const t of [10,20,50,99])updateMarkerMotion(f.map,records,t,true,f.options);assert.equal(f.writes.length,1);assert.equal(f.counts().scans,1);
  updateMarkerMotion(f.map,records,250,true,f.options);assert.equal(f.writes.length,2);assert.equal(f.counts().renders,1);assert.ok(f.writes.every(write=>write.id===signalMarker(records[0]).imageId));
  updateMarkerMotion(f.map,records,260,false,f.options);assert.equal(f.writes.length,3);assert.deepEqual(f.writes.at(-1)!.image,raster());updateMarkerMotion(f.map,records,270,false,f.options);assert.equal(f.writes.length,3);disposeMarkerMotion(f.map);
});

test('mobile never uploads more than six animation frames per second',()=>{
  const records=[signal('water')],f=fixture(records);for(let t=0;t<1000;t+=10)updateMarkerMotion(f.map,records,t,true,{...f.options,mobile:true});assert.ok(f.writes.length<=6);disposeMarkerMotion(f.map);
});

test('active sprites and raster caches stay bounded across many visible categories',()=>{
  const f=fixture([]),icons=Object.keys(SIGNAL_ICON_NODES);
  for(let step=0;step<40;step++){f.visible(Array.from({length:16},(_,i)=>({id:`s-${step}-${i}`,properties:{id:`s-${step}-${i}`,marker:`atlas-category-utilities-${icons[(step*9+i)%icons.length]}`}})));const stats=updateMarkerMotion(f.map,[],step*500,true,f.options);assert.ok(stats.activeSprites<=10);assert.ok(stats.cachedFrames<=64);assert.ok(stats.cachedBases<=32);}
  disposeMarkerMotion(f.map);
});

test('shared resolved category is static, offscreen sprites restore, removed maps are harmless',()=>{
  const records=[{...signal('closed'),closedAt:'2026-09-03'}],f=fixture(records);updateMarkerMotion(f.map,records,0,true,f.options);for(const t of [500,1000,1500])updateMarkerMotion(f.map,records,t,true,f.options);assert.equal(f.writes.length,1);
  f.visible([]);updateMarkerMotion(f.map,records,2000,true,f.options);assert.equal(f.writes.length,2);assert.deepEqual(f.writes.at(-1)!.image,raster());
  f.remove();assert.doesNotThrow(()=>updateMarkerMotion(f.map,records,2500,true,f.options));assert.doesNotThrow(()=>disposeMarkerMotion(f.map));
});

test('a fresh event at settlement precision never animates an approximate geographic centre',()=>{
  const records=[{...signal('locality'),precision:'settlement' as const}],f=fixture(records);
  updateMarkerMotion(f.map,records,0,true,f.options);
  for(const t of [250,500,750,1000])updateMarkerMotion(f.map,records,t,true,f.options);
  assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].image,raster());disposeMarkerMotion(f.map);
});
