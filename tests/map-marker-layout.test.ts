import test from 'node:test';
import assert from 'node:assert/strict';
import {markerFanOffsets,spreadCoincidentMarkers,MARKER_LINK_MAX_PIXELS,MARKER_LINK_MAX_METRES} from '../src/lib/map-marker-layout';
import {markerGroupSegments,markerGroupSignature,signalGroupCounts,SIGNAL_CLUSTER_PROPERTIES} from '../src/lib/map-marker-groups';

const projection = {getZoom:()=>17,getCanvas:()=>({clientWidth:800,clientHeight:600}),project:([lng,lat]:[number,number])=>({x:(lng-49.1)*100000+400,y:(lat-55.7)*100000+300}),unproject:([x,y]:[number,number])=>({lng:(x-400)/100000+49.1,lat:(y-300)/100000+55.7})};
const points=(count:number):GeoJSON.FeatureCollection<GeoJSON.Point>=>({type:'FeatureCollection',features:Array.from({length:count},(_,index)=>({type:'Feature',id:`event-${index}`,properties:{id:`event-${index}`,markerColor:'#3485a6'},geometry:{type:'Point',coordinates:[49.1,55.7]}}))});

test('coincident events become individually clickable without changing their evidence anchors',()=>{
  const original=points(3),before=structuredClone(original),display=spreadCoincidentMarkers(original,projection);
  assert.deepEqual(original,before);assert.equal(display.points.features.length,3);assert.equal(display.links.features.length,3);
  assert.equal(new Set(display.points.features.map(point=>point.geometry.coordinates.join(','))).size,3);
  for(const feature of display.points.features){assert.equal(feature.properties?.anchorLng,49.1);assert.equal(feature.properties?.anchorLat,55.7);assert.equal(feature.properties?.markerSpread,true);}
  for(const line of display.links.features)assert.deepEqual(line.geometry.coordinates[0],[49.1,55.7]);
  const reversed=spreadCoincidentMarkers({...original,features:[...original.features].reverse()},projection);
  for(const feature of display.points.features)assert.deepEqual(feature.geometry,reversed.points.features.find(point=>point.id===feature.id)!.geometry);
  assert.equal(spreadCoincidentMarkers(original,{...projection,getZoom:()=>14}).points,original);
});

test('fans keep separate hit areas and stay finite even for a dense shared address',()=>{
  for(const count of [2,3,4,8,12,24,100]){
    const offsets=markerFanOffsets(count);assert.equal(offsets.length,count);
    for(let i=0;i<offsets.length;i++)for(let j=i+1;j<offsets.length;j++)assert.ok(Math.hypot(offsets[i][0]-offsets[j][0],offsets[i][1]-offsets[j][1])>32);
  }
  const display=spreadCoincidentMarkers(points(1000),projection);assert.equal(display.points.features.length,1000);
  assert.ok(display.links.features.length>2);assert.ok(display.links.features.length<1000,'dense addresses never create screen-spanning fan legs');
  for(const link of display.links.features) {const a=projection.project(link.geometry.coordinates[0] as [number,number]),b=projection.project(link.geometry.coordinates[1] as [number,number]);assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<=MARKER_LINK_MAX_PIXELS+0.001);}
  for(const feature of display.points.features)assert.ok(feature.geometry.coordinates.every(Number.isFinite));
});

test('cluster rings encode category shares and actual bank object counts',()=>{
  const counts=signalGroupCounts([{category:'ЖКХ'},{category:'utilities'},{category:'Дороги'}]);assert.equal(counts.group_utilities,2);assert.equal(counts.group_roads,1);
  const segments=markerGroupSegments(counts);assert.deepEqual(segments.map(segment=>segment.count),[2,1]);
  assert.deepEqual(markerGroupSegments({point_count:5,sber_count:2},true).map(segment=>segment.count),[2,3]);
  assert.deepEqual(markerGroupSegments({point_count:5,sber_count:8},true).map(segment=>segment.count),[5]);
  assert.deepEqual(Object.keys(SIGNAL_CLUSTER_PROPERTIES).sort(),Object.keys(signalGroupCounts(Object.keys(SIGNAL_CLUSTER_PROPERTIES).map(key=>({category:key.slice(6)})))).sort());
  const signature=markerGroupSignature(segments);assert.equal(signature,markerGroupSignature(segments.map(segment=>({...segment,count:segment.count*100}))));
  assert.equal(signature.split('_').reduce((sum,part)=>sum+Number(part.split('-')[1]),0),64);
});


test('offscreen coincidences never enter layout or unproject behind the tilted camera',()=>{
  let inverseCalls=0;
  const offscreen={...projection,project:()=>({x:-20000,y:30000}),unproject:()=>{inverseCalls++;throw new Error('offscreen point must not be unprojected');}};
  const original=points(2),result=spreadCoincidentMarkers(original,offscreen);
  assert.equal(result.links.features.length,0);assert.equal(inverseCalls,0);assert.deepEqual(result.points,original);
  const behind={...projection,unproject:()=>({lng:20,lat:65})};
  const hidden=spreadCoincidentMarkers(original,behind);assert.equal(hidden.links.features.length,0);assert.deepEqual(hidden.points,original);
});

test('a pathological near-horizon projection cannot generate kilometre-long geographic legs',()=>{
  const compressed={...projection,project:([lng,lat]:[number,number])=>({x:400+(lng-49.1)*2,y:300+(lat-55.7)*100000}),unproject:([x,y]:[number,number])=>({lng:49.1+(x-400)/2,lat:55.7+(y-300)/100000})};
  const original=points(2),result=spreadCoincidentMarkers(original,compressed);
  assert.equal(result.links.features.length,0);assert.deepEqual(result.points,original);
  const invalid={...projection,unproject:([x,y]:[number,number])=>x===400&&y===300?{lng:49.1,lat:55.7}:{lng:NaN,lat:Infinity}};
  assert.equal(spreadCoincidentMarkers(original,invalid).links.features.length,0);
});

test('only visible coincidences spread and every published connector is short in screen and ground space',()=>{
  const original=points(4);original.features[2].geometry.coordinates=[52,56];original.features[3].geometry.coordinates=[52,56];
  const result=spreadCoincidentMarkers(original,projection);assert.equal(result.links.features.length,2);
  assert.deepEqual(result.points.features.slice(2),original.features.slice(2));
  for(const feature of result.links.features) {
    const [a,b]=feature.geometry.coordinates,pa=projection.project(a as [number,number]),pb=projection.project(b as [number,number]);
    assert.ok(Math.hypot(pa.x-pb.x,pa.y-pb.y)<=MARKER_LINK_MAX_PIXELS);
    assert.ok(Math.hypot((a[0]-b[0])*Math.cos(a[1]*Math.PI/180),a[1]-b[1])*111320<=MARKER_LINK_MAX_METRES);
  }
});

test('a projection error near the horizon skips that point without aborting the map refresh',()=>{
  const original=points(2),throwing={...projection,unproject:()=>{throw new Error('ray has no ground intersection');}};
  const result=spreadCoincidentMarkers(original,throwing);assert.equal(result.links.features.length,0);assert.deepEqual(result.points,original);
});
