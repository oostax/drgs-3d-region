import test from 'node:test';
import assert from 'node:assert/strict';
import type {Map as LibreMap} from 'maplibre-gl';
import type {ClientMapPoint} from '../src/lib/client-map-types';
import {refreshClientLayers} from '../src/lib/map-client-layer';
const client:ClientMapPoint={id:'org',inn:'1234567890',name:'Клиент',gosb:'test',address:'Адрес объекта',addressKind:'office',coordinates:[49.12,55.79],precision:'building',sourceUrl:'https://example.org/client',confirmedByUser:false};
function setup(){const uploads:unknown[]=[],visibility:unknown[]=[];let source={setData:(data:unknown)=>uploads.push(data)};const map={getSource:()=>source,getLayer:()=>({}),setLayoutProperty:(...args:unknown[])=>visibility.push(args)} as unknown as LibreMap;return {map,uploads,visibility,replace:()=>{source={setData:(data:unknown)=>uploads.push(data)};}};}
test('hidden client portfolios do not start clustering and repeated camera renders do no work',()=>{
 const {map,uploads,visibility}=setup(),clients=[client];refreshClientLayers(map,clients,false);assert.equal(uploads.length,0);assert.equal(visibility.length,3);
 refreshClientLayers(map,clients,false);assert.equal(uploads.length,0);assert.equal(visibility.length,3);
 refreshClientLayers(map,clients,true);assert.equal(uploads.length,1);assert.equal(visibility.length,6);
 refreshClientLayers(map,clients,true);assert.equal(uploads.length,1);assert.equal(visibility.length,6);
});
test('switching to public clears private points once while fresh empty arrays stay cheap',()=>{
 const {map,uploads}=setup();refreshClientLayers(map,[client],true);refreshClientLayers(map,[],false);assert.equal(uploads.length,2);assert.deepEqual((uploads[1]as {features:unknown[]}).features,[]);
 for(let i=0;i<50;i++)refreshClientLayers(map,[],false);assert.equal(uploads.length,2);
});
test('new client locations and recreated map sources invalidate the upload cache',()=>{
 const {map,uploads,replace}=setup(),clients=[client];refreshClientLayers(map,clients,true);const updated=[{...client,coordinates:[49.2,55.8] as [number,number]}];refreshClientLayers(map,updated,false);assert.equal(uploads.length,1);
 refreshClientLayers(map,updated,true);assert.equal(uploads.length,2);assert.deepEqual((uploads[1]as {features:{geometry:{coordinates:number[]}}[]}).features[0].geometry.coordinates,[49.2,55.8]);
 replace();refreshClientLayers(map,updated,true);assert.equal(uploads.length,3);
});
