import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import type { Feature, Geometry } from 'geojson';
import { createSportsDetails, sportsFrame } from '../src/lib/map-sports-details';
import { worldPoint, worldLngLat } from '../src/lib/map-life-stability';

type XY = [number,number];
const center: XY = worldPoint([49.103,55.797]);
const options = { mobile:false, center, radius:2500, toLocal:(p:XY):XY=>[p[0]-center[0],p[1]-center[1]], terrain:()=>72 };
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/stadium.geojson',import.meta.url),'utf8'));
const polygon = (ring:XY[], properties:Record<string,unknown>):Feature<Geometry>=>({type:'Feature',properties,geometry:{type:'Polygon',coordinates:[ring.map(p=>worldLngLat([center[0]+p[0],center[1]+p[1]]))]}});
const dispose=(group:THREE.Group)=>group.traverse(object=>{if(object instanceof THREE.Mesh||object instanceof THREE.LineSegments){object.geometry.dispose();for(const material of Array.isArray(object.material)?object.material:[object.material])material.dispose();}});

test('actual OSM stadium receives a field, track, seating and goals with two total draw calls',()=>{
 const group=createSportsDetails(fixture.features,options), stats=group.userData.sports;
 assert.equal(stats.stadiums,1);assert.equal(stats.goals,2);assert.equal(stats.drawCalls,2);assert.ok(stats.vertices>500&&stats.vertices<20000);
 for(const child of group.children){const geometry=(child as THREE.Mesh).geometry,p=geometry.getAttribute('position');for(let i=0;i<p.count;i++){assert.ok(Number.isFinite(p.getX(i)));assert.ok(Number.isFinite(p.getY(i)));assert.ok(p.getZ(i)>=72);}}
 const colors=(group.children[0] as THREE.Mesh).geometry.getAttribute('color');const distinct=new Set(Array.from({length:colors.count},(_,i)=>[colors.getX(i),colors.getY(i),colors.getZ(i)].join(',')));assert.ok(distinct.size>=6,'track, grass stripes, markings and seating stay distinct');dispose(group);
});

test('a sports building or stadium without a mapped courtyard is never covered by a fabricated pitch',()=>{
 for(const tags of [{class:'sports_hall'},{class:'stadium'},{class:'residential'}]){const group=createSportsDetails([polygon([[0,0],[100,0],[100,70],[0,70]],tags)],options);assert.equal(group.children.length,0);dispose(group);}
});

test('a duplicate landuse pitch never suppresses the stadium track and markings',()=>{
 const stadium=fixture.features[0],hole=stadium.geometry.coordinates[1];
 const pitch:Feature<Geometry>={type:'Feature',properties:{class:'pitch'},geometry:{type:'Polygon',coordinates:[hole]}};
 for(const features of [[pitch,stadium],[stadium,pitch]]){const group=createSportsDetails(features,options);assert.equal(group.userData.sports.stadiums,1);assert.equal(group.userData.sports.goals,2);assert.equal(group.userData.sports.pitches,0);dispose(group);}
});

test('sport-specific markings require evidence and do not convert tennis into football',()=>{
 for(const sport of ['soccer','tennis','']){const group=createSportsDetails([polygon([[0,0],[105,0],[105,68],[0,68]],{class:'pitch',sport})],options);assert.equal(group.userData.sports.pitches,1);assert.equal(group.userData.sports.goals,sport==='soccer'?2:0);dispose(group);}
});

test('rotated pitch orientation is stable and duplicate tile copies do not double the surface',()=>{
 const angle=.73,ring:XY[]=[[0,0],[105,0],[105,68],[0,68]].map(([x,y])=>[x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)]);
 const frame=sportsFrame(ring)!;assert.ok(Math.abs(frame.length-105)<1e-7);assert.ok(Math.abs(frame.width-68)<1e-7);assert.ok(Math.abs(Math.abs(frame.u[0])-Math.cos(angle))<1e-7);
 const feature=polygon(ring,{class:'pitch',sport:'soccer'}),group=createSportsDetails([feature,feature,feature],options);assert.equal(group.userData.sports.pitches,1);assert.equal(group.userData.sports.goals,2);dispose(group);
});
