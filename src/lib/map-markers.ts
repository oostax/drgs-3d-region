import type { Map as LibreMap, LayerSpecification } from 'maplibre-gl';
import type { Signal } from './types';
import { signalMarker, SIGNAL_GROUPS, type SignalMarker, type SignalGroup } from './signal-markers';
import { SIGNAL_ICON_NODES, type SignalIcon } from './signal-icon-nodes';
import { addMarkerGroupImages } from './map-marker-groups';

const paths: Record<string, string[]> = {
  construction: ['M5 21V3h3v18M5 4h16l-6 4H5M17 4v9M15 13h4v3h-4Z M3 21h7'],
  roads: ['M8 3 4 21M16 3l4 18M12 3v3M12 10v4M12 18v3'],
  utilities: ['M3 10l9-7 9 7M5 9v12h14V9M9 21v-8h6v8'],
  landscaping: ['M12 21v-9M12 16C2 16 3 5 3 5s9-1 9 11ZM12 12C12 3 21 3 21 3s1 9-9 9Z'],
  social: ['M3 21V9l9-6 9 6v12ZM9 21v-7h6v7M7 11h1M16 11h1'],
  investment: ['M4 21V8h6V3h10v18ZM7 12h0M7 16h0M14 7h2M14 11h2M14 15h2M10 21V8'],
  culture: ['M3 9l9-6 9 6ZM4 21h16M6 10v8M12 10v8M18 10v8'],
  signal: ['M12 9v4M12 17h.01M9 3h6l7 12-4 6H6l-4-6Z'],
  place: ['M4 21V9h16v12M3 9l9-7 9 7M8 21v-8M16 21v-8'],
  organization: ['M4 21V4h10v17M14 10h6v11M8 8h2M8 12h2M8 16h2'],
  cluster: ['M4 9l8-5 8 5-8 5ZM4 13l8 5 8-5M4 17l8 5 8-5'],
};
const tones: Record<string,string> = {construction:'#c28632',roads:'#b96546',utilities:'#3485a6',landscaping:'#36835d',social:'#538898',investment:'#7274a7',culture:'#b47f58',signal:'#b98a39',place:'#68867f',organization:'#308d85',cluster:'#546b67'};

export function markerImage(kind: string, bank?: string, category?:SignalMarker, drawGlyph = true) {
  const canvas = document.createElement('canvas'); canvas.width=112; canvas.height=136;
  const ctx=canvas.getContext('2d')!;
  const bankColors: Record<string,string>={sber:'#21A038',vtb:'#0663EF',akbars:'#009B3A',psb:'#000F3C',gpb:'#2355D7'};
  const bankGradients:Record<string,readonly [string,string,...string[]]>={
    // Sber stays unmistakably green; the second brand hue is used only as a
    // restrained green-teal finish instead of turning the marker turquoise.
    sber:['#2DBE50','#21A038','#078A56'],
    vtb:['#0A7BFF','#0663EF','#003B91'],
    // Ak Bars uses its green against a near-black field in the published mark.
    // The dark face also keeps it decisively separate from Sber at map scale.
    akbars:['#172923','#0C4735','#009B3A'],
    psb:['#FF6200','#5B54E7'],
    gpb:['#4778FF','#2355D7'],
  };
  const color=category?.faceColor ?? category?.color ?? (bank ? bankColors[bank] ?? '#5a7786' : tones[kind] ?? tones.signal);
  const locality = category?.visualState === 'locality';
  ctx.shadowColor=locality?'rgba(16,40,38,.16)':'rgba(16,40,38,.28)'; ctx.shadowBlur=10; ctx.shadowOffsetY=7;
  ctx.beginPath(); ctx.roundRect(12,10,88,88,28); ctx.fillStyle='#f8fbfc'; ctx.fill();
  ctx.shadowBlur=0; ctx.shadowOffsetY=0;
  if (!locality) { ctx.beginPath(); ctx.moveTo(44,95);ctx.lineTo(56,115);ctx.lineTo(68,95);ctx.closePath();ctx.fill(); }
  const gradient=ctx.createLinearGradient(18,16,94,92),stops=bank?bankGradients[bank]:undefined;
  if(stops)stops.forEach((stop,index)=>gradient.addColorStop(index/(stops.length-1),stop));
  else{gradient.addColorStop(0,color);gradient.addColorStop(1,color+'dd');}
  ctx.fillStyle=gradient;ctx.beginPath();ctx.roundRect(18,16,76,76,23);ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,.38)';ctx.lineWidth=2;ctx.stroke();
  ctx.strokeStyle=locality?category!.color:'white'; ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';
  ctx.save();ctx.translate(30,28);ctx.scale(2.15,2.15);
  if(drawGlyph && bank==='sber') {ctx.beginPath();ctx.arc(12,12,8.5,.05,Math.PI*1.8);ctx.stroke();ctx.stroke(new Path2D('M7 11l4 4L22 4'));}
  else if(drawGlyph && bank) {ctx.restore();ctx.font=`700 ${bank==='akbars'?23:26}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(bank==='vtb'?'ВТБ':bank==='akbars'?'АК':bank==='psb'?'ПСБ':'ГПБ',56,56);ctx.save();}
  else if(category && drawGlyph) {
    for (const [tag, attributes] of SIGNAL_ICON_NODES[category.icon] as readonly (readonly [string,object])[]) {
      const a=attributes as Record<string,string|number>;ctx.beginPath();
      if(tag==='path') {ctx.stroke(new Path2D(String(a.d)));continue;}
      if(tag==='circle')ctx.arc(Number(a.cx),Number(a.cy),Number(a.r),0,Math.PI*2);
      else if(tag==='ellipse')ctx.ellipse(Number(a.cx),Number(a.cy),Number(a.rx),Number(a.ry),0,0,Math.PI*2);
      else if(tag==='rect')ctx.roundRect(Number(a.x??0),Number(a.y??0),Number(a.width),Number(a.height),Number(a.rx??0));
      else if(tag==='line'){ctx.moveTo(Number(a.x1),Number(a.y1));ctx.lineTo(Number(a.x2),Number(a.y2));}
      else if(tag==='polyline'||tag==='polygon'){const coords=String(a.points).trim().split(/[ ,]+/).map(Number);for(let i=0;i<coords.length;i+=2){if(i===0)ctx.moveTo(coords[i],coords[i+1]);else ctx.lineTo(coords[i],coords[i+1]);}if(tag==='polygon')ctx.closePath();}
      ctx.stroke();
    }
  } else if(!category && !bank && kind !== 'cluster') for(const path of paths[kind]??paths.signal) ctx.stroke(new Path2D(path));
  ctx.restore();
  // A pale face and dashed contour denote a locality centre, never an address.
  if (locality) {
    ctx.strokeStyle=category!.color;ctx.lineWidth=2.7;ctx.setLineDash([7,5]);
    ctx.beginPath();ctx.roundRect(19,17,74,74,23);ctx.stroke();ctx.setLineDash([]);
  }
  // Status belongs to the pin, not to a detached circle or label below it.
  if (category?.visualState === 'planned' || category?.visualState === 'paused') {
    ctx.strokeStyle='#ffffff';ctx.lineWidth=2;ctx.setLineDash(category.visualState === 'planned' ? [5,4] : []);
    ctx.beginPath();ctx.roundRect(22,20,68,68,20);ctx.stroke();ctx.setLineDash([]);
  }
  if (category?.visualState === 'active' || category?.visualState === 'urgent') {
    ctx.strokeStyle=category.visualState === 'urgent'?'#ffe2cc':'#dbfff0';ctx.lineWidth=3;
    ctx.beginPath();ctx.roundRect(20,18,72,72,21);ctx.stroke();
  }
  return ctx.getImageData(0,0,canvas.width,canvas.height);
}

type GlyphPoint={x:number;y:number};
function sampledStrokes(icon:SignalIcon,samples=28):GlyphPoint[][]{
  const strokes:GlyphPoint[][]=[];
  const samplePath=(d:string)=>{
    for(const segment of d.split(/(?=M)/).filter(Boolean)){
      const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',segment);
      let length=0;try{length=path.getTotalLength();}catch{continue;}if(!Number.isFinite(length)||length<=0)continue;
      strokes.push(Array.from({length:samples},(_,index)=>{const point=path.getPointAtLength(length*index/(samples-1));return{x:point.x,y:point.y};}));
    }
  };
  for(const [tag,attributes] of SIGNAL_ICON_NODES[icon] as readonly (readonly [string,object])[]){
    const a=attributes as Record<string,string|number>;
    if(tag==='path'){samplePath(String(a.d));continue;}
    if(tag==='line'){const x1=Number(a.x1),y1=Number(a.y1),x2=Number(a.x2),y2=Number(a.y2);strokes.push(Array.from({length:samples},(_,i)=>({x:x1+(x2-x1)*i/(samples-1),y:y1+(y2-y1)*i/(samples-1)})));continue;}
    if(tag==='circle'||tag==='ellipse'){const cx=Number(a.cx),cy=Number(a.cy),rx=Number(tag==='circle'?a.r:a.rx),ry=Number(tag==='circle'?a.r:a.ry);strokes.push(Array.from({length:samples},(_,i)=>{const angle=Math.PI*2*i/(samples-1);return{x:cx+Math.cos(angle)*rx,y:cy+Math.sin(angle)*ry};}));continue;}
    if(tag==='rect'){const x=Number(a.x??0),y=Number(a.y??0),w=Number(a.width),h=Number(a.height),perimeter=2*(w+h);strokes.push(Array.from({length:samples},(_,i)=>{const distance=perimeter*i/(samples-1);if(distance<=w)return{x:x+distance,y};if(distance<=w+h)return{x:x+w,y:y+distance-w};if(distance<=2*w+h)return{x:x+w-(distance-w-h),y:y+h};return{x,y:y+h-(distance-2*w-h)};}));continue;}
    if(tag==='polyline'||tag==='polygon'){const values=String(a.points).trim().split(/[ ,]+/).map(Number),points:Array<GlyphPoint>=[];for(let i=0;i<values.length;i+=2)points.push({x:values[i],y:values[i+1]});if(tag==='polygon'&&points.length)points.push(points[0]);if(points.length>1)strokes.push(Array.from({length:samples},(_,i)=>points[Math.min(points.length-1,Math.round(i*(points.length-1)/(samples-1)))]));}
  }
  const centroid=(stroke:GlyphPoint[])=>stroke.reduce((sum,p)=>({x:sum.x+p.x/stroke.length,y:sum.y+p.y/stroke.length}),{x:0,y:0});
  return strokes.sort((a,b)=>{const ca=centroid(a),cb=centroid(b);return Math.atan2(ca.y-12,ca.x-12)-Math.atan2(cb.y-12,cb.x-12)||a.length-b.length;});
}

/** Draw one interpolated vector glyph into the already-rendered original pin. */
export function markerMorphImage(empty:ImageData,from:SignalIcon,to:SignalIcon,amount:number){
  const canvas=document.createElement('canvas');canvas.width=empty.width;canvas.height=empty.height;const ctx=canvas.getContext('2d')!;ctx.putImageData(empty,0,0);
  const source=sampledStrokes(from),target=sampledStrokes(to),count=Math.max(source.length,target.length),progress=Math.max(0,Math.min(1,amount));
  ctx.save();ctx.translate(30,28);ctx.scale(2.15,2.15);ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';
  const center=(stroke:GlyphPoint[])=>stroke.reduce((sum,p)=>({x:sum.x+p.x/stroke.length,y:sum.y+p.y/stroke.length}),{x:0,y:0});
  for(let index=0;index<count;index++){
    const rawFrom=source[index%source.length],rawTo=target[index%target.length],fromCenter=center(rawFrom),toCenter=center(rawTo);
    const a=index<source.length?rawFrom:rawFrom.map(()=>fromCenter),b=index<target.length?rawTo:rawTo.map(()=>toCenter);
    ctx.beginPath();for(let point=0;point<a.length;point++){const x=a[point].x+(b[point].x-a[point].x)*progress,y=a[point].y+(b[point].y-a[point].y)*progress;if(point===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();
  }
  ctx.restore();return ctx.getImageData(0,0,canvas.width,canvas.height);
}

export function addMapMarkers(map: LibreMap) {
  addMarkerGroupImages(map);
  for(const kind of Object.keys(paths)) if(!map.hasImage(`atlas-pin-${kind}`)) map.addImage(`atlas-pin-${kind}`,markerImage(kind),{pixelRatio:2});
  for(const bank of ['sber','vtb','akbars','psb','gpb']) if(!map.hasImage(`atlas-pin-${bank}`)) map.addImage(`atlas-pin-${bank}`,markerImage('organization',bank),{pixelRatio:2});
  if(!map.hasImage('atlas-pin-banks')) map.addImage('atlas-pin-banks',markerImage('organization'),{pixelRatio:2});
}

/** Rasterize only the category/group pairs actually present, not their Cartesian product. */
export function ensureSignalMarkers(map:LibreMap, signals:readonly Signal[]) {
  for(const signal of signals){const marker=signalMarker(signal);if(!map.hasImage(marker.imageId))map.addImage(marker.imageId,markerImage('signal',undefined,marker),{pixelRatio:2});}
  for(const group of Object.keys(SIGNAL_GROUPS) as SignalGroup[]){const imageId=`atlas-category-${group}-layers`;if(!map.hasImage(imageId))map.addImage(imageId,markerImage('signal',undefined,{group,icon:'layers',imageId,label:'Несколько категорий',color:SIGNAL_GROUPS[group].color,mixed:true}),{pixelRatio:2});}
}

export function upgradeMapMarkers(map: LibreMap) {
  const replace = (id: string, layer: LayerSpecification) => {
    const layers = map.getStyle().layers, index = layers.findIndex(l=>l.id===id), before = layers[index+1]?.id;
    if(index<0) return;
    map.removeLayer(id); map.addLayer(layer,before);
  };
  const plain = { 'icon-anchor':'bottom' as const, 'icon-padding':4, 'icon-allow-overlap':true, 'icon-ignore-placement':true, 'icon-pitch-alignment':'viewport' as const, 'icon-rotation-alignment':'viewport' as const };
  replace('atlas-banks-circle',{id:'atlas-banks-circle',type:'symbol',source:'atlas-offices',filter:['!',['has','point_count']],layout:{...plain,'icon-image':['concat','atlas-pin-',['match',['get','bank'],['sber','vtb','akbars','psb','gpb'],['get','bank'],'gpb']],'icon-size':['interpolate',['linear'],['zoom'],8,0.55,14,0.72,17,.86]}});
  for (const [id, source, minzoom] of [['atlas-bank-clusters','atlas-offices',0],['atlas-signal-clusters','atlas-signal-points',0]] as const) {
    replace(id,{id,type:'symbol',source,minzoom,filter:['has','point_count'],layout:{...plain,'icon-anchor':'center','icon-image':id==='atlas-bank-clusters'?'atlas-group-banks-default':'atlas-group-signals-default','icon-size':1}});
  }
  for (const id of ['atlas-bank-cluster-count','atlas-signal-cluster-count','atlas-signal-point-cluster-count','atlas-bank-label','atlas-signal-areas-label','atlas-signal-areas-card','atlas-signal-topics']) if(map.getLayer(id)) map.setLayoutProperty(id,'text-field','');
  replace('atlas-signal-points-circle',{id:'atlas-signal-points-circle',type:'symbol',source:'atlas-signal-points',filter:['!',['has','point_count']],layout:{...plain,'icon-image':['get','marker'],'symbol-sort-key':['get','priorityRank'],'icon-size':['interpolate',['linear'],['zoom'],0,['match',['get','severity'],'critical',.78,'high',.72,.62],15,['match',['get','severity'],'critical',.96,'high',.9,.8],18,['match',['get','severity'],'critical',1.05,'high',.98,.88]]}});
  replace('atlas-signal-areas-circle',{id:'atlas-signal-areas-circle',type:'symbol',source:'atlas-signal-areas',maxzoom:11,filter:['!',['has','point_count']],layout:{...plain,'icon-anchor':'center','icon-image':['get','marker'],'icon-size':.88}});
  replace('atlas-signal-area-fallback',{id:'atlas-signal-area-fallback',type:'symbol',source:'atlas-signal-areas',minzoom:10,filter:['all',['!', ['has','point_count']],['>',['get','fallbackCount'],0]],layout:{...plain,'icon-anchor':'center','icon-image':['get','marker'],'icon-size':['interpolate',['linear'],['zoom'],10,.78,14,.66,18,.58]},paint:{'icon-opacity':.82}});
  replace('atlas-landmark-dot',{id:'atlas-landmark-dot',type:'symbol',source:'atlas-landmark-points',minzoom:10,maxzoom:15.3,layout:{...plain,'icon-image':'atlas-pin-place','icon-size':0.62}});
  replace('atlas-focused-org-dot',{id:'atlas-focused-org-dot',type:'symbol',source:'atlas-focused-org',layout:{...plain,'icon-image':'atlas-pin-organization','icon-size':.9,'icon-allow-overlap':true}});
}
