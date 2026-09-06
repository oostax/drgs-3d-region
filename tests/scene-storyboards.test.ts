import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createHash} from 'node:crypto';
import {sceneCatalog} from '../src/lib/scene-catalog';
import {sceneStoryboard,sceneStoryboards} from '../src/lib/scene-storyboards';
import {TOPIC_STORY_RENDERERS,topicStoryPlacement} from '../src/lib/map-scene-stories';
import {createScenePreview,type SceneAttachment} from '../src/lib/map-signal-scenes';

const recipe=(id:string)=>{const found=sceneCatalog.recipes.find(r=>r.id===id);assert.ok(found,id);return found;};
test('all 300 exact topics have authored heroes, actions and a complete renderer route',()=>{
 assert.equal(sceneStoryboards.length,300);assert.equal(new Set(sceneStoryboards.map(s=>s.id)).size,300);
 assert.equal(sceneStoryboards.filter(s=>s.renderer==='topic').length,232);
 for(const r of sceneCatalog.recipes){const s=sceneStoryboard(r);assert.ok(s,r.id);assert.equal(s.id,r.id);assert.ok(s.hero.length>8);assert.ok(s.action.length>20);assert.ok(!s.action.includes('Геометрия источника определяет'));assert.notEqual(s.variant,s.topic);if(s.renderer==='topic'){assert.ok(TOPIC_STORY_RENDERERS[s.composition],s.composition);assert.equal(s.selfContained,true);}}
 assert.equal(sceneStoryboard({family:'unknown',topic:'Неизвестная тема'}),null);
});
test('regulatory and delivery topics never become an invented physical emergency or repair',()=>{
 for(const id of ['complaints:b6f54fa348d4e36d','complaints:fda6c07591b1c7a0','complaints:345d177f17b7b8c2','complaints:9f1bdd7f9269a7eb','complaints:1d9abbd0b6267e59','complaints:62b48a2344079068','complaints:5cbafd9d04f1392e','complaints:18eaeef4ba53c3db']){assert.equal(sceneStoryboard(recipe(id))?.renderer,'topic',id);}
});
test('cameras span a real street and missing playgrounds remain absent, independent of lifecycle state',()=>{
 const camera=sceneStoryboard(recipe('complaints:18003c2c7cda6a8f'))!,missing=sceneStoryboard(recipe('complaints:933d7c6e8c98a7b1'))!,evacuation=sceneStoryboard(recipe('complaints:bdaf630b8fe0e44e'))!;
 assert.equal(camera.context,'street');assert.equal(camera.composition,'camera');assert.equal(evacuation.context,'site');assert.equal(evacuation.variant,'evacuation');assert.equal(missing.absence,true);assert.equal(missing.variant,'missing');
 for(const state of ['planned','in_progress','paused','resolved','cancelled','archive']){const scene=createScenePreview(recipe(missing.id),state);assert.equal(scene.root.userData.storyboard.absence,true);assert.equal(scene.animated,false);scene.dispose();}
 const preview=createScenePreview(recipe(camera.id),'in_progress');assert.equal(preview.attachment.type,'street');assert.equal(preview.root.userData.effect,'topic-story:camera:gantry');assert.equal(preview.animated,true);preview.dispose();
});
test('every topic illustration fills a readable metric footprint and merges static primitives',()=>{
 const seen=new Map<string,string>();
 for(const spec of sceneStoryboards.filter(s=>s.renderer==='topic')){
  const preview=createScenePreview(recipe(spec.id),'in_progress');assert.equal(preview.root.userData.effect,`topic-story:${spec.composition}:${spec.variant}`);
  preview.root.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(preview.root),size=bounds.getSize(new THREE.Vector3());
  assert.ok(size.x>=20&&size.y>=10,`${spec.id}: ${size.toArray()}`);assert.ok(size.x<65&&size.y<65&&size.z<35,`${spec.id}: implausible extent ${size.toArray()}`);
  const hash=createHash('sha256');let meshes=0,vertices=0;preview.root.traverse(object=>{if(object instanceof THREE.Mesh){meshes++;const positions=object.geometry.getAttribute('position');vertices+=positions.count;for(const value of positions.array)assert.ok(Number.isFinite(value),spec.id);hash.update(Buffer.from(positions.array.buffer));hash.update(JSON.stringify(object.matrixWorld.toArray()));const material=object.material as THREE.MeshStandardMaterial;hash.update(String(material.color.getHex()));}});
  const fingerprint=hash.digest('hex');assert.ok(!seen.has(fingerprint),`${spec.id} repeats ${seen.get(fingerprint)}`);seen.set(fingerprint,spec.id);
  assert.ok(meshes<=24,`${spec.id}: unbatched draw calls ${meshes}`);assert.ok(vertices>150,`${spec.id}: empty toy`);preview.dispose();
 }
});
test('topic placement stays near the source anchor on long streets and inside concave sites',()=>{
 const street={type:'street',path:[[-10000,2],[30000,2]],walls:[{a:[-10000,2],b:[30000,2],length:40000,outward:[0,1]}],closed:false,height:0,length:40000,key:'long',sourceId:'long'} as SceneAttachment;
 assert.deepEqual(topicStoryPlacement(street,'camera'),{x:0,y:2,angle:0});
 assert.deepEqual(topicStoryPlacement(street,'vehicles'),{x:0,y:11,angle:0});
 const site={...street,type:'site',closed:true,path:[[-20,-20],[20,-20],[20,-8],[-8,-8],[-8,20],[-20,20],[-20,-20]],walls:[]} as SceneAttachment;
 const position=topicStoryPlacement(site,'playground');assert.ok(position.x<-8||position.y<-8,JSON.stringify(position));
 const withHole={...site,path:[[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]],holes:[[[-5,-5],[5,-5],[5,5],[-5,5],[-5,-5]]]} as SceneAttachment;
 const outsideHole=topicStoryPlacement(withHole,'plaza');assert.ok(Math.abs(outsideHole.x)>5||Math.abs(outsideHole.y)>5);
});
test('reported, paused and archival illustrations remain static even when their active version has motion',()=>{
 for(const id of ['complaints:18003c2c7cda6a8f','complaints:bdaf630b8fe0e44e',...sceneCatalog.recipes.filter(r=>['housing','transit','economy'].includes(r.family)).map(r=>r.id)]){
  for(const state of ['reported','planned','paused','resolved','cancelled','archive']){const preview=createScenePreview(recipe(id),state);assert.equal(preview.animated,false,`${id} ${state}`);const before=new THREE.Box3().setFromObject(preview.root);preview.update(39);const after=new THREE.Box3().setFromObject(preview.root);assert.ok(before.equals(after),`${id}: moved in ${state}`);preview.dispose();}
 }
});
