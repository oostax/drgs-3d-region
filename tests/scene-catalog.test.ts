import test from 'node:test';
import assert from 'node:assert/strict';
import {sceneCatalog,recipePresentation,sceneRecipe} from '../src/lib/scene-catalog';
import {createScenePreview} from '../src/lib/map-signal-scenes';
import {roadElevationAt,updateRoadTerrain,makeRoad,connectedRoute} from '../src/lib/map-life-stability';

test('topic words do not match unrelated substrings or the wrong utility',()=>{
 const cases:[string,string][]=[
  ['Мусорные полигоны, мусоросжигательные и мусороперерабатывающие заводы (в т.ч. строительство и закрытие)','waste'],
  ['Оплата проезда в общественном транспорте (в т.ч. рост стоимости)','transit'],
  ['Низкая температура воды или слабое давление','water'],
  ['Ненадлежащее качество или отключение отопления','heating'],
  ['Некачественные ремонт и реконструкция мостов (в т.ч. нарушение технологий, сроков)','bridge'],
 ];
 for(const [topic,family] of cases)assert.equal(sceneCatalog.recipes.find(r=>r.topic===topic)?.family,family,topic);
});

test('all 247 original topics have unique, versioned recipes with explicit geometry and fallback',()=>{
 const original=sceneCatalog.recipes.filter(r=>r.source==='complaints');assert.equal(original.length,247);assert.equal(new Set(original.map(r=>r.group)).size,26);
 assert.equal(new Set(sceneCatalog.recipes.map(r=>r.id)).size,300);
 for(const r of original){assert.ok(r.geometry.length);assert.ok(r.activityTtlHours>0);assert.equal(sceneRecipe(r.group,r.topic)?.id,r.id);assert.equal(recipePresentation(r,'in_progress','territory',true).animate,false);assert.equal(recipePresentation(r,'cancelled',r.geometry[0],true).kind,'generic');}
 assert.equal(recipePresentation(null,'reported','building',true).mode,'review');
});
test('all recipe families build finite geometry for every state; cancelled/paused examples never animate',()=>{
 for(const recipe of sceneCatalog.recipes){
 for(const state of [...Object.keys(sceneCatalog.states),'archive']){const preview=createScenePreview(recipe,state);assert.ok(preview.root.children.length);if(state!=='in_progress')assert.equal(preview.animated,false);preview.root.traverse((node:any)=>{const a=node.geometry?.getAttribute('position');if(a)for(const value of a.array)assert.ok(Number.isFinite(value));});preview.dispose();}
 }
});
test('status scenes use one explicit vocabulary independently of the topic recipe',()=>{
 const recipe=sceneCatalog.recipes.find(item=>item.family==='construction')!;
 const expected:Record<string,string>={reported:'status-reported',planned:'status-planned',paused:'status-paused',resolved:'status-resolved',cancelled:'status-cancelled',archive:'status-archive'};
 for(const [state,effect] of Object.entries(expected)){
  const preview=createScenePreview(recipe,state);
  assert.equal(preview.root.userData.statusEffect,effect,state);
  assert.equal(preview.animated,false,state);
  preview.dispose();
 }
});
test('road elevation follows hills, retains late DEM gaps and joins bridge abutments without a fake offset',()=>{
 const road=makeRoad('r','r',[[0,0],[100,0]]);updateRoadTerrain(road,([x])=>x/10);assert.equal(roadElevationAt(road,50),5);updateRoadTerrain(road,()=>null);assert.equal(roadElevationAt(road,50),5);
 const bridge=makeRoad('b','b',[[100,0],[200,0]],0,false,true);updateRoadTerrain(bridge,([x])=>x===100?10:x===200?12:-10);assert.equal(roadElevationAt(bridge,50),11);
 const route=connectedRoute([road,bridge],road,1,false,200);assert.equal(roadElevationAt(route,50),5);assert.equal(roadElevationAt(route,150),11);
});

test('routes split at junctions see DEM updates made after the route was cached',()=>{
 const main=makeRoad('main','main',[[0,0],[100,0],[200,0]]);
 const branch=makeRoad('branch','branch',[[100,0],[100,100]]);
 const route=connectedRoute([main,branch],main,9,false,90);
 updateRoadTerrain(main,([x])=>x/10);
 assert.equal(roadElevationAt(route,50),5);
 updateRoadTerrain(main,([x])=>x/5);
 assert.equal(roadElevationAt(route,50),10);
});
