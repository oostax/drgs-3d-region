import type {Map as LibreMap,GeoJSONSource} from 'maplibre-gl';
import type {ClientMapPoint} from './client-map-types';
import {SBER_HEAD_OFFICES} from './sber-structure';

const clientLayerState=new WeakMap<LibreMap,{source:GeoJSONSource;uploaded?:readonly ClientMapPoint[];visible?:boolean}>();

function headImage(role:string){
  const canvas=document.createElement('canvas');canvas.width=216;canvas.height=108;
  const context=canvas.getContext('2d')!;
  context.shadowColor='#123f3633';context.shadowBlur=9;context.shadowOffsetY=4;
  context.fillStyle='#fffef5';context.beginPath();context.roundRect(7,5,202,86,23);context.fill();context.shadowBlur=0;context.shadowOffsetY=0;
  context.fillStyle=role==='ТБ'?'#154d3c':'#147555';context.beginPath();context.roundRect(12,10,192,76,19);context.fill();
  context.strokeStyle='#daff77';context.lineWidth=4;context.lineCap='round';context.beginPath();context.arc(44,47,16,.2,Math.PI*1.77);context.stroke();context.beginPath();context.moveTo(34,44);context.lineTo(44,53);context.lineTo(65,30);context.stroke();
  context.fillStyle='#fff';context.font='700 29px system-ui';context.textBaseline='middle';context.fillText(role,78,49);
  context.fillStyle='#fffef5';context.beginPath();context.moveTo(98,90);context.lineTo(108,104);context.lineTo(118,90);context.fill();
  return context.getImageData(0,0,216,108);
}
export function addClientLayers(map:LibreMap){
  for(const role of ['ТБ','ГОСБ'])map.addImage(`atlas-head-${role}`,headImage(role),{pixelRatio:2});
  map.addSource('atlas-head-offices',{type:'geojson',data:{type:'FeatureCollection',features:SBER_HEAD_OFFICES.map(office=>({type:'Feature',properties:{id:office.id,role:office.role,name:office.name},geometry:{type:'Point',coordinates:office.coordinates!}}))}});
  map.addLayer({id:'atlas-head-offices',type:'symbol',source:'atlas-head-offices',layout:{'icon-image':['concat','atlas-head-',['get','role']],'icon-size':['interpolate',['linear'],['zoom'],4,.62,10,.78,16,.9],'icon-anchor':'bottom','icon-allow-overlap':true,'icon-ignore-placement':true}});
  map.addLayer({id:'atlas-head-office-names',type:'symbol',source:'atlas-head-offices',minzoom:10,layout:{'text-field':['get','name'],'text-font':['Noto Sans Regular'],'text-size':11,'text-offset':[0,.6],'text-anchor':'top','text-max-width':18},paint:{'text-color':'#154d3c','text-halo-color':'#fffdf5','text-halo-width':2}});
  map.addSource('atlas-clients',{type:'geojson',data:{type:'FeatureCollection',features:[]},cluster:true,clusterRadius:34,clusterMaxZoom:16});
  map.addLayer({id:'atlas-client-groups',type:'symbol',source:'atlas-clients',filter:['has','point_count'],layout:{'icon-image':'atlas-pin-organization','icon-size':.85,'icon-anchor':'bottom','icon-allow-overlap':true}});
  map.addLayer({id:'atlas-client-points',type:'symbol',source:'atlas-clients',filter:['!',['has','point_count']],layout:{'icon-image':'atlas-pin-organization','icon-size':['interpolate',['linear'],['zoom'],7,.58,15,.85],'icon-anchor':'bottom','icon-allow-overlap':true}});
  map.addLayer({id:'atlas-client-names',type:'symbol',source:'atlas-clients',minzoom:14,filter:['!',['has','point_count']],layout:{'text-field':['concat',['get','name'],'\n',['case',['==',['get','addressKind'],'legal'],'Юридический адрес','Адрес объекта']],'text-font':['Noto Sans Regular'],'text-size':11,'text-offset':[0,.55],'text-anchor':'top','text-max-width':19},paint:{'text-color':'#205d59','text-halo-color':'#fffdf5','text-halo-width':2}});
}
export function refreshClientLayers(map:LibreMap,clients:readonly ClientMapPoint[],visible:boolean){
  const source=map.getSource('atlas-clients') as GeoJSONSource|undefined;if(!source)return;
  let state=clientLayerState.get(map);if(!state||state.source!==source){state={source};clientLayerState.set(map,state);}
  const unchanged=state.uploaded===clients||clients.length===0&&state.uploaded?.length===0;
  // Keep hidden portfolios out of the clustering worker until they are shown.
  // Empty input still clears previously uploaded private points immediately.
  if((visible||clients.length===0)&&!unchanged){
    source.setData({type:'FeatureCollection',features:clients.map(client=>({type:'Feature',id:client.id,properties:{id:client.id,name:client.name.length>64?client.name.slice(0,61)+'…':client.name,inn:client.inn,addressKind:client.addressKind},geometry:{type:'Point',coordinates:client.coordinates}}))});
    state.uploaded=clients;
  }
  if(state.visible!==visible){for(const id of ['atlas-client-groups','atlas-client-points','atlas-client-names'])if(map.getLayer(id))map.setLayoutProperty(id,'visibility',visible?'visible':'none');state.visible=visible;}
}
