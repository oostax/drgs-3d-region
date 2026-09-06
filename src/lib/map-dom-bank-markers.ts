import * as maplibregl from 'maplibre-gl';
import type { Map as LibreMap } from 'maplibre-gl';
import type { BankOffice } from './types';
import { markerImage } from './map-markers';
import { sberOfficeRole } from './sber-structure';

type SupportedBank='sber'|'vtb'|'akbars'|'psb'|'gpb';
type Brand={label:string;lines?:readonly string[];color:string;viewBox:[number,number,number,number];paths:readonly string[]};
type MorphAssets={logo:ImageData;name:ImageData;logoSdf:Float32Array;nameSdf:Float32Array};
type DomMarker={marker:maplibregl.Marker;render:(amount:number)=>void};

const SIZE=64;
const MORPH_DURATION=6400;

// Geometry is copied from the banks' published SVG marks. It is deliberately kept
// as paths: the resting frame is the real mark, while the in-between frames use
// its alpha field and never substitute a generic banking pictogram.
const BRANDS:Record<SupportedBank,Brand>={
  sber:{
    label:'СБЕР',color:'#21A038',viewBox:[0,0,46.5,47.25],paths:[
      'M41.605 9.547c1.094 1.43 2.008 2.996 2.782 4.656L23.312 29.926l-8.851-5.625V17.57l8.805 5.578z',
      'M5.473 23.84c0-.324 0-.598.047-.922l-5.336-.277c0 .37-.047.785-.047 1.152 0 6.457 2.601 12.313 6.797 16.555l3.785-3.828c-3.239-3.227-5.246-7.7-5.246-12.68z',
      'M23.266 5.855c.32 0 .593 0 .914.047l.273-5.394c-.367 0-.777-.047-1.14-.047-6.387 0-12.18 2.629-16.38 6.871l3.786 3.828c3.195-3.273 7.664-5.305 12.547-5.305z',
      'M23.266 41.824c-.32 0-.594 0-.914-.047l-.274 5.395c.367 0 .777.047 1.14.047 6.387 0 12.184-2.63 16.38-6.871l-3.786-3.828c-3.195 3.32-7.62 5.304-12.546 5.304z',
      'M33.3 8.992l4.516-3.367C33.848 2.398 28.785.414 23.266.414v5.395c3.742.046 7.207 1.199 10.035 3.183z',
      'M46.441 23.84c0-1.43-.136-2.813-.367-4.195l-4.972 3.734v.461c0 5.305-2.282 10.055-5.883 13.328l3.601 4.012c4.657-4.243 7.621-10.47 7.621-17.34z',
      'M23.266 41.824c-5.247 0-9.946-2.305-13.184-5.949l-3.969 3.645c4.242 4.75 10.356 7.699 17.153 7.699z',
      'M11.36 10.512L7.753 6.5C3.055 10.79.137 16.969.137 23.84h5.336c0-5.258 2.28-10.051 5.886-13.328z',
    ]
  },
  vtb:{
    label:'ВТБ',color:'#0663EF',viewBox:[0,0,66.81,41.44],paths:[
      'M14.957.378l-3.742 10.265h51.849L66.805.378zm-5.614 15.395L5.602 26.036H57.45l3.742-10.263zM3.742 31.17L0 41.431h51.849l3.739-10.262z',
    ]
  },
  akbars:{
    label:'АК БАРС',lines:['АК','БАРС'],color:'#009B3A',viewBox:[0,16.64,43,15.5],paths:[
      'M39.029 21.857c1.623-.288 3.116.555 3.722 2.13.605 1.552.086 3.216-1.32 4.148l-4.869 3.238a3.4 3.4 0 0 1-3.548.133c-1.147-.643-1.818-1.796-1.818-3.127V17.886c0-.576.455-1.042 1.017-1.042.563 0 1.017.466 1.017 1.042V28.38c0 .554.281 1.042.757 1.308.476.244 1.017.244 1.472-.067l4.868-3.238c.671-.444.714-1.131.519-1.641-.194-.51-.692-.998-1.471-.843l-3.31.621c-.541.089-1.061-.288-1.169-.843-.086-.555.281-1.087.822-1.198zm-16.947.621l3.377-.621c1.655-.288 3.178.555 3.796 2.13.618 1.574.088 3.238-1.324 4.148l-4.966 3.238a3.55 3.55 0 0 1-3.62.133c-1.17-.643-1.853-1.796-1.853-3.127v-7.964c0-.554-.287-1.042-.773-1.309-.485-.244-1.037-.244-1.5.067L2.727 27.314c-.684.443-.728 1.13-.53 1.641.2.51.685.998 1.501.843l10.902-1.974c.552-.089 1.082.288 1.192.843.089.555-.287 1.087-.838 1.198L4.05 31.839c-1.655.288-3.178-.555-3.796-2.13-.618-1.574-.088-3.238 1.324-4.148l12.492-8.14a3.52 3.52 0 0 1 3.62-.134c1.17.644 1.854 1.797 1.854 3.128v7.964c0 .554.287 1.042.772 1.308.486.244 1.038.244 1.501-.067l4.966-3.238c.684-.444.728-1.131.53-1.641-.2-.51-.707-.998-1.502-.843l-3.376.621c-.552.089-1.082-.288-1.192-.843-.088-.555.287-1.087.839-1.198z',
    ]
  },
  psb:{
    label:'ПСБ',color:'#000F3C',viewBox:[0,0,26.08,26.88],paths:[
      'M17.346 0L8.692 8.985h8.654v17.893l8.727-8.909V0z',
      'M8.727 26.878l8.654-8.984H8.727V0L0 8.91v17.968z',
    ]
  },
  gpb:{
    label:'ГПБ',color:'#2355D7',viewBox:[0,0,216,216],paths:[
      'M108 209c55.781 0 101-45.219 101-101S163.781 7 108 7 7 52.22 7 108s45.22 101 101 101m0 7c59.647 0 108-48.353 108-108S167.647 0 108 0 0 48.353 0 108s48.353 108 108 108',
      'M80.334 141.552c6.32-2.497 16.06-4.599 27.687-6.929C146.443 126.55 183 118.185 183 95.776c0-5.514-2.818-10.82-8.518-15.377q.249-1.654.249-3.433c0-8.677-6.217-16.958-19.791-22.555C148.204 40.803 129.532 33 108.021 33c-13.492 0-28.288 2.767-40.288 9.53v4.848c17.035-8.24 31.625-8.802 40.288-8.802 7.253 0 25.842 1.665 34.609 12.027-9.036-2.06-20.082-3.267-33.324-3.267-23.709 0-46.546 7.179-62.421 17.52v5.16c13.367-7.366 32.557-15.668 62.421-15.668 26.506 0 54.255 6.18 54.773 19.913-12.289-5.43-30.63-8.864-55.25-8.864-33.075 0-59.291 10.487-72.306 18.186v5.16c22.403-11.61 47.769-16.084 71.933-16.084 9.989 0 19.149.624 27.21 1.768-6.32 2.497-16.061 4.599-27.687 6.93C69.557 89.428 33 97.793 33 120.202c0 5.514 2.819 10.82 8.517 15.398a23 23 0 0 0-.248 3.433c0 8.677 6.217 16.958 19.791 22.555C67.796 175.197 86.468 183 107.98 183c13.492 0 28.288-2.767 40.288-9.53v-4.848c-17.035 8.24-31.625 8.802-40.288 8.802-7.253 0-25.842-1.665-34.609-12.027 9.036 2.06 20.082 3.267 33.324 3.267 23.709 0 46.546-7.179 62.421-17.52v-5.16c-13.367 7.366-32.557 15.668-62.421 15.668-26.506 0-54.255-6.18-54.773-19.913 12.29 5.431 30.63 8.864 55.25 8.864 33.075 0 59.291-10.487 72.306-18.186v-5.16c-22.403 11.611-47.769 16.084-71.933 16.084-9.989 0-19.149-.624-27.21-1.768zm92.573-47.462c0 14.503-24.371 21.848-64.886 30.233-21.408 4.432-35.687 9.384-42.132 14.337-4.518-1.228-8.435-2.643-11.71-4.245 5.285-7.179 20.58-12.901 53.842-20.787 38.235-9.051 56.099-15.855 63.021-25.01 1.223 1.748 1.865 3.579 1.865 5.493zM43.113 121.89c0-14.503 24.33-21.91 64.887-30.233 21.201-4.349 35.231-9.114 42.049-14.357 4.559 1.227 8.497 2.663 11.792 4.265-5.285 7.158-20.6 12.838-53.841 20.787-38.153 9.113-56.058 15.897-63 25.031-1.244-1.748-1.887-3.6-1.887-5.514z',
    ]
  },
};

const assetCache=new Map<SupportedBank,MorphAssets>();

function canonicalBank(bank:string):SupportedBank|null{return bank==='gazprombank'?'gpb':bank in BRANDS?bank as SupportedBank:null;}
function validCoordinates(coordinates:BankOffice['coordinates']):coordinates is [number,number]{return Boolean(coordinates&&coordinates.length===2&&coordinates.every(Number.isFinite)&&Math.abs(coordinates[0])<=180&&Math.abs(coordinates[1])<=85);}
function canvas(){const value=document.createElement('canvas');value.width=SIZE;value.height=SIZE;return value;}
function drawLogo(brand:Brand){
  const surface=canvas(),ctx=surface.getContext('2d')!,[x,y,width,height]=brand.viewBox,padding=7,scale=Math.min((SIZE-padding*2)/width,(SIZE-padding*2)/height);
  ctx.setTransform(scale,0,0,scale,(SIZE-width*scale)/2-x*scale,(SIZE-height*scale)/2-y*scale);ctx.fillStyle='#fff';
  for(const path of brand.paths)ctx.fill(new Path2D(path),'evenodd');
  ctx.setTransform(1,0,0,1,0,0);return ctx.getImageData(0,0,SIZE,SIZE);
}
function drawName(brand:Brand){
  const surface=canvas(),ctx=surface.getContext('2d')!,lines=brand.lines??[brand.label];let fontSize=lines.length>1?21:24;ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';
  do{ctx.font=`900 ${fontSize}px system-ui, sans-serif`;fontSize--;}while(Math.max(...lines.map(line=>ctx.measureText(line).width))>SIZE-4&&fontSize>14);
  const lineHeight=(fontSize+1)*.82,start=SIZE/2-(lines.length-1)*lineHeight/2+1;
  lines.forEach((line,index)=>ctx.fillText(line,SIZE/2,start+index*lineHeight));return ctx.getImageData(0,0,SIZE,SIZE);
}
function distanceField(mask:Uint8Array,target:number){
  const result=new Float32Array(mask.length),far=SIZE*2;for(let i=0;i<result.length;i++)result[i]=mask[i]===target?0:far;
  for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){const i=y*SIZE+x;result[i]=Math.min(result[i],x?result[i-1]+1:far,y?result[i-SIZE]+1:far,x&&y?result[i-SIZE-1]+1.414:far,x+1<SIZE&&y?result[i-SIZE+1]+1.414:far);}
  for(let y=SIZE-1;y>=0;y--)for(let x=SIZE-1;x>=0;x--){const i=y*SIZE+x;result[i]=Math.min(result[i],x+1<SIZE?result[i+1]+1:far,y+1<SIZE?result[i+SIZE]+1:far,x+1<SIZE&&y+1<SIZE?result[i+SIZE+1]+1.414:far,x&&y+1<SIZE?result[i+SIZE-1]+1.414:far);}
  return result;
}
function signedDistance(data:ImageData){
  const mask=new Uint8Array(SIZE*SIZE);for(let i=0;i<mask.length;i++)mask[i]=data.data[i*4+3]>80?1:0;
  const inside=distanceField(mask,1),outside=distanceField(mask,0),signed=new Float32Array(mask.length);for(let i=0;i<signed.length;i++)signed[i]=inside[i]-outside[i];return signed;
}
function assets(bank:SupportedBank){
  let cached=assetCache.get(bank);if(cached)return cached;const logo=drawLogo(BRANDS[bank]),name=drawName(BRANDS[bank]);cached={logo,name,logoSdf:signedDistance(logo),nameSdf:signedDistance(name)};assetCache.set(bank,cached);return cached;
}
function drawMorph(ctx:CanvasRenderingContext2D,source:MorphAssets,amount:number,frame:ImageData){
  if(amount<=0){ctx.putImageData(source.logo,0,0);return;}if(amount>=1){ctx.putImageData(source.name,0,0);return;}
  for(let i=0;i<source.logoSdf.length;i++){const sdf=source.logoSdf[i]*(1-amount)+source.nameSdf[i]*amount,coverage=Math.max(0,Math.min(1,.5-sdf*.72)),offset=i*4;frame.data[offset]=255;frame.data[offset+1]=255;frame.data[offset+2]=255;frame.data[offset+3]=Math.round(coverage*255);}
  ctx.putImageData(frame,0,0);
}
function morphCanvas(bank:SupportedBank){
  const element=canvas(),ctx=element.getContext('2d')!,source=assets(bank),frame=ctx.createImageData(SIZE,SIZE);let last=-1;
  const render=(amount:number)=>{if(Math.abs(amount-last)<=.001)return;drawMorph(ctx,source,amount,frame);last=amount;};render(0);return{element,render};
}
function pinUrl(bank:SupportedBank){const image=markerImage('organization',bank,undefined,false),surface=document.createElement('canvas');surface.width=image.width;surface.height=image.height;surface.getContext('2d')!.putImageData(image,0,0);return surface.toDataURL();}
function createElement(office:BankOffice,bank:SupportedBank,onOffice:(id:string)=>void){
  const element=document.createElement('button');element.type='button';element.className='map-dom-bank-marker';element.style.backgroundImage=`url(${pinUrl(bank)})`;element.setAttribute('aria-label',`${BRANDS[bank].label}: ${office.name}`);
  const glyph=document.createElement('span');glyph.className='map-dom-bank-glyph';const morph=morphCanvas(bank);glyph.append(morph.element);element.append(glyph);element.addEventListener('click',event=>{event.stopPropagation();onOffice(office.id);});return{element,render:morph.render};
}
const pointFilter=(hidden:string[])=>hidden.length?['all',['!', ['has','point_count']],['!', ['in',['get','id'],['literal',hidden]]]]:['!', ['has','point_count']];

export function installDomBankMarkers(map:LibreMap,getOffices:()=>readonly BankOffice[],onOffice:(id:string)=>void){
  const active=new Map<string,DomMarker>(),reduced=window.matchMedia('(prefers-reduced-motion:reduce)').matches;let disposed=false,request=0,started=performance.now();
  const sync=()=>{
    if(disposed||!map.getLayer('atlas-banks-circle'))return;const bounds=map.getBounds();
    const visibleSourceIds=new Set(map.querySourceFeatures('atlas-offices',{filter:['!', ['has','point_count']] as maplibregl.FilterSpecification}).map(feature=>String(feature.properties?.id??'')));
    const selected=getOffices().filter(office=>canonicalBank(office.bank)&&!sberOfficeRole(office)&&validCoordinates(office.coordinates)&&office.precision==='building'&&Boolean(office.coordinateSourceUrl)&&bounds.contains(office.coordinates)&&visibleSourceIds.has(office.id)),ids=new Set(selected.map(office=>office.id));
    for(const [id,item] of active)if(!ids.has(id)){item.marker.remove();active.delete(id);}
    for(const office of selected)if(!active.has(office.id)){const bank=canonicalBank(office.bank);if(bank){const built=createElement(office,bank,onOffice),marker=new maplibregl.Marker({element:built.element,anchor:'bottom'}).setLngLat(office.coordinates!).addTo(map);if(reduced)built.render(1);active.set(office.id,{marker,render:built.render});}}
    map.setFilter('atlas-banks-circle',pointFilter([...ids]) as maplibregl.FilterSpecification);
  };
  const onSourceData=(event:maplibregl.MapSourceDataEvent)=>{if(event.sourceId==='atlas-offices'&&event.isSourceLoaded)sync();};
  const tick=(now:number)=>{if(disposed)return;const phase=((now-started)%MORPH_DURATION)/MORPH_DURATION;let amount=phase<.34||phase>=.92?0:phase<.5?(phase-.34)/.16:phase<.76?1:1-(phase-.76)/.16;amount=amount*amount*(3-2*amount);for(const item of active.values())item.render(amount);request=requestAnimationFrame(tick);};
  sync();if(!reduced)request=requestAnimationFrame(tick);map.on('moveend',sync);map.on('zoomend',sync);map.on('sourcedata',onSourceData);
  return()=>{disposed=true;cancelAnimationFrame(request);map.off('moveend',sync);map.off('zoomend',sync);map.off('sourcedata',onSourceData);for(const item of active.values())item.marker.remove();active.clear();if(map.getLayer('atlas-banks-circle'))map.setFilter('atlas-banks-circle',['!', ['has','point_count']]);};
}
