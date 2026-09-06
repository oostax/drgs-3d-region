import * as maplibregl from 'maplibre-gl';
import type { Map as LibreMap } from 'maplibre-gl';
import type { Signal } from './types';
import { markerImage } from './map-markers';
import { markerStatusIcon, signalMarker } from './signal-markers';
import { signalPriority } from './signal-priority';
import { signalHasVerifiedMapLocation } from './signal-location';
import { SIGNAL_ICON_NODES, type SignalIcon } from './signal-icon-nodes';

type DomMarker={marker:maplibregl.Marker;element:HTMLButtonElement;stop:()=>void};
type Point={x:number;y:number};
const SVG_NS='http://www.w3.org/2000/svg';

function interpolatePolyline(points:Point[],samples:number){return Array.from({length:samples},(_,i)=>points[Math.min(points.length-1,Math.round(i*(points.length-1)/(samples-1)))]);}
function iconStrokes(icon:SignalIcon,samples=18):Point[][]{
  const strokes:Point[][]=[];
  for(const [tag,attributes] of SIGNAL_ICON_NODES[icon] as readonly (readonly [string,object])[]){
    const a=attributes as Record<string,string|number>;
    if(tag==='path')for(const segment of String(a.d).split(/(?=M)/).filter(Boolean)){const path=document.createElementNS(SVG_NS,'path');path.setAttribute('d',segment);try{const length=path.getTotalLength();if(length>0)strokes.push(Array.from({length:samples},(_,i)=>{const p=path.getPointAtLength(length*i/(samples-1));return{x:p.x,y:p.y};}));}catch{/* skip invalid source path */}}
    else if(tag==='line')strokes.push(interpolatePolyline([{x:Number(a.x1),y:Number(a.y1)},{x:Number(a.x2),y:Number(a.y2)}],samples));
    else if(tag==='circle'||tag==='ellipse'){const cx=Number(a.cx),cy=Number(a.cy),rx=Number(tag==='circle'?a.r:a.rx),ry=Number(tag==='circle'?a.r:a.ry);strokes.push(Array.from({length:samples},(_,i)=>{const angle=Math.PI*2*i/(samples-1);return{x:cx+Math.cos(angle)*rx,y:cy+Math.sin(angle)*ry};}));}
    else if(tag==='rect'){const x=Number(a.x??0),y=Number(a.y??0),w=Number(a.width),h=Number(a.height);strokes.push(interpolatePolyline([{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h},{x,y}],samples));}
    else if(tag==='polyline'||tag==='polygon'){const values=String(a.points).trim().split(/[ ,]+/).map(Number),points:Point[]=[];for(let i=0;i<values.length;i+=2)points.push({x:values[i],y:values[i+1]});if(tag==='polygon'&&points.length)points.push(points[0]);if(points.length>1)strokes.push(interpolatePolyline(points,samples));}
  }
  return strokes.length?strokes:[Array.from({length:samples},()=>({x:12,y:12}))];
}
function centroid(points:Point[]){return points.reduce((sum,p)=>({x:sum.x+p.x/points.length,y:sum.y+p.y/points.length}),{x:0,y:0});}
function normalizedPaths(from:SignalIcon,to:SignalIcon){
  const a=iconStrokes(from),b=iconStrokes(to),count=Math.max(a.length,b.length),fromParts:string[]=[],toParts:string[]=[];
  for(let i=0;i<count;i++){const source=a[i%a.length],target=b[i%b.length],sa=i<a.length?source:source.map(()=>centroid(target)),sb=i<b.length?target:target.map(()=>centroid(source));fromParts.push(sa.map((p,n)=>`${n?'L':'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' '));toParts.push(sb.map((p,n)=>`${n?'L':'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' '));}
  return {from:fromParts.join(' '),to:toParts.join(' ')};
}
function pathInterpolator(from:string,to:string){
  const pattern=/-?\d+(?:\.\d+)?/g,fromNumbers=(from.match(pattern)??[]).map(Number),toNumbers=(to.match(pattern)??[]).map(Number),parts=from.split(pattern);
  return(amount:number)=>parts.map((part,index)=>index<fromNumbers.length?`${part}${(fromNumbers[index]+(toNumbers[index]-fromNumbers[index])*amount).toFixed(2)}`:part).join('');
}
function morphSvg(from:SignalIcon,to:SignalIcon){
  const svg=document.createElementNS(SVG_NS,'svg'),path=document.createElementNS(SVG_NS,'path'),geometry=normalizedPaths(from,to);svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');path.setAttribute('d',geometry.from);svg.append(path);
  if(window.matchMedia('(prefers-reduced-motion:reduce)').matches){path.setAttribute('d',geometry.to);return{svg,start:()=>()=>{}};}
  const interpolate=pathInterpolator(geometry.from,geometry.to);
  const start=()=>{let frame=0,stopped=false,started=performance.now();const tick=(now:number)=>{if(stopped)return;const phase=((now-started)%6400)/6400;let amount=phase<.34||phase>=.92?0:phase<.5?(phase-.34)/.16:phase<.76?1:1-(phase-.76)/.16;amount=amount*amount*(3-2*amount);path.setAttribute('d',interpolate(amount));frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);return()=>{stopped=true;cancelAnimationFrame(frame);};};
  return{svg,start};
}
function pinUrl(signal:Signal){const descriptor={...signalMarker(signal),visualState:undefined},image=markerImage('signal',undefined,descriptor,false),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d')!.putImageData(image,0,0);return canvas.toDataURL();}
function createElement(signal:Signal,onSignal:(id:string)=>void){const descriptor=signalMarker(signal),element=document.createElement('button');element.type='button';element.className='map-dom-signal-marker';element.style.backgroundImage=`url(${pinUrl(signal)})`;element.setAttribute('aria-label',`${descriptor.label}: ${signal.title}`);const glyph=document.createElement('span');glyph.className='map-dom-signal-glyph';const morph=morphSvg(descriptor.icon,markerStatusIcon(descriptor.visualState));glyph.append(morph.svg);element.append(glyph);element.addEventListener('click',event=>{event.stopPropagation();onSignal(signal.id);});return{element,start:morph.start};}
const pointFilter=(hidden:string[])=>hidden.length?['all',['!', ['has','point_count']],['!', ['in',['get','id'],['literal',hidden]]]]:['!', ['has','point_count']];

export function installDomSignalMarkers(map:LibreMap,getSignals:()=>readonly Signal[],onSignal:(id:string)=>void){
  const active=new Map<string,DomMarker>();let disposed=false;
  const sync=()=>{
    if(disposed||!map.getLayer('atlas-signal-points-circle'))return;
    const zoom=map.getZoom(),bounds=map.getBounds(),limit=window.matchMedia('(max-width:760px)').matches?6:12;
    const positions=new Map<string,[number,number]>();
    for(const feature of map.querySourceFeatures('atlas-signal-points',{filter:['!', ['has','point_count']]})) {
      if(feature.geometry.type==='Point') positions.set(String(feature.properties?.id),feature.geometry.coordinates as [number,number]);
    }
    const selected=zoom<15?[]:getSignals().filter(signal=>signalHasVerifiedMapLocation(signal)&&positions.has(signal.id)&&bounds.contains(positions.get(signal.id)!)).sort((a,b)=>signalPriority(b).rank-signalPriority(a).rank||b.publishedAt.localeCompare(a.publishedAt)).slice(0,limit);
    const ids=new Set(selected.map(signal=>signal.id));
    for(const [id,item] of active)if(!ids.has(id)){item.stop();item.marker.remove();active.delete(id);}
    for(const signal of selected){
      const point=positions.get(signal.id)!;
      if(active.has(signal.id)){active.get(signal.id)!.marker.setLngLat(point);continue;}
      const built=createElement(signal,onSignal),marker=new maplibregl.Marker({element:built.element,anchor:'bottom'}).setLngLat(point).addTo(map),stop=built.start();
      active.set(signal.id,{marker,element:built.element,stop});
    }
    map.setFilter('atlas-signal-points-circle',pointFilter([...ids]) as maplibregl.FilterSpecification);
  };
  const sourceLoaded=(event:{sourceId?:string;isSourceLoaded?:boolean})=>{if(event.sourceId==='atlas-signal-points'&&event.isSourceLoaded)sync();};
  sync();map.on('moveend',sync);map.on('sourcedata',sourceLoaded);
  return()=>{disposed=true;map.off('moveend',sync);map.off('sourcedata',sourceLoaded);for(const item of active.values()){item.stop();item.marker.remove();}active.clear();if(map.getLayer('atlas-signal-points-circle'))map.setFilter('atlas-signal-points-circle',['!', ['has','point_count']]);};
}
