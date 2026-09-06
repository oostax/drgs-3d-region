import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createShoreDetails, insideShorePolygon } from '../src/lib/map-shore-details';
import { drivableRoad, worldPoint } from '../src/lib/map-life-stability';

test('pier geometry is not a road for simulated cars and highway lamps',()=>{
  assert.equal(drivableRoad({class:'pier'}),false);
  assert.equal(drivableRoad({class:'primary'}),true);
});
test('shore furniture excludes water and holes, and duplicate pier tiles share one deck',()=>{
  assert.equal(insideShorePolygon([2,2],[[[0,0],[10,0],[10,10],[0,10]],[[1,1],[3,1],[3,3],[1,3]]]),false);
  const feature:GeoJSON.Feature<GeoJSON.LineString>={type:'Feature',properties:{class:'pier'},geometry:{type:'LineString',coordinates:[[49,55],[49.001,55]]}};
  const center=worldPoint([49,55]);
  const options={mobile:true,center,radius:300,toLocal:(p:[number,number]):[number,number]=>[p[0]-center[0],p[1]-center[1]],terrain:()=>0};
  const group=createShoreDetails([], [feature,feature], [],options);
  assert.equal(group.userData.shore.piers,1);
  assert.ok(group.userData.shore.planks>20);
  assert.equal(group.userData.shore.furniture,0);
  assert.ok(group.children.length<=2);
  for(const child of group.children){const mesh=child as THREE.InstancedMesh;assert.ok(mesh.count<=2400);assert.ok([...mesh.instanceMatrix.array].every(Number.isFinite));}
});
