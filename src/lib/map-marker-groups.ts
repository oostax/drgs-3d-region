import type { Map as LibreMap, ExpressionSpecification, GeoJSONSourceSpecification } from 'maplibre-gl';
import { SIGNAL_GROUPS, signalGroup } from './signal-markers';
import type { Signal } from './types';

const GROUPS = Object.keys(SIGNAL_GROUPS) as (keyof typeof SIGNAL_GROUPS)[];
export const SIGNAL_CLUSTER_PROPERTIES: NonNullable<GeoJSONSourceSpecification['clusterProperties']> = Object.fromEntries(
  GROUPS.map(group => [`group_${group}`, ['+', ['coalesce', ['get', `group_${group}`], 0]]]),
);
/** Counts represent actual map records; district-only aggregate totals are never invented points. */
export function signalGroupCounts(signals: readonly Pick<Signal, 'category'>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const signal of signals) { const key = `group_${signalGroup(signal.category)}`; counts[key] = (counts[key] || 0) + 1; }
  return counts;
}
export type MarkerSegment = { color: string; count: number };
export function markerGroupSegments(properties: Record<string, unknown>, bank = false): MarkerSegment[] {
  if (bank) {
    const total=Math.max(0,Number(properties.point_count)||0),palette=[['sber_count','#21A038'],['vtb_count','#0663EF'],['akbars_count','#173C30'],['psb_count','#FF6200'],['gpb_count','#2355D7']] as const;
    let remaining=total;const segments:MarkerSegment[]=[];
    for(const [key,color] of palette){const count=Math.min(remaining,Math.max(0,Number(properties[key])||0));if(count)segments.push({color,count});remaining-=count;}
    if(remaining)segments.push({color:'#708078',count:remaining});return segments;
  }
  const segments = GROUPS.map(group => ({ color: SIGNAL_GROUPS[group].color, count: Math.max(0, Number(properties[`group_${group}`]) || 0) })).filter(segment => segment.count > 0);
  return segments.length ? segments : [{ color:'#7b817e', count:1 }];
}

/** Quantized only for a reusable sprite cache; the GeoJSON preserves exact counts. */
export function markerGroupSignature(segments: readonly MarkerSegment[]): string {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0) || 1;
  const shares = segments.map(segment => ({ color:segment.color, exact:segment.count / total * 64, slots:Math.floor(segment.count / total * 64) }));
  let remaining = 64 - shares.reduce((sum, share) => sum + share.slots, 0);
  for (const share of [...shares].sort((a,b) => (b.exact-b.slots)-(a.exact-a.slots))) if (remaining-- > 0) share.slots++;
  return shares.filter(share => share.slots > 0).map(share => `${share.color.slice(1)}-${share.slots}`).join('_');
}

export function markerGroupImage(segments: readonly MarkerSegment[], bank = false) {
  const canvas = document.createElement('canvas'); canvas.width = 88; canvas.height = 88;
  const ctx = canvas.getContext('2d')!;
  ctx.shadowColor = 'rgba(21,49,39,.22)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
  ctx.beginPath(); ctx.arc(44,42,35,0,Math.PI*2); ctx.fillStyle = '#fcfff9'; ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  const total = segments.reduce((sum, segment) => sum + segment.count, 0) || 1;
  let angle = -Math.PI/2;
  for (const segment of segments) {
    const extent = segment.count/total*Math.PI*2, gap = segments.length > 1 ? Math.min(.055,extent*.15) : 0;
    ctx.beginPath(); ctx.arc(44,42,28,angle+gap/2,angle+extent-gap/2); ctx.lineWidth = 8; ctx.strokeStyle = segment.color; ctx.stroke(); angle += extent;
  }
  {
    const count=segments.reduce((sum,segment)=>sum+segment.count,0),label=count>999?'999+':String(count);
    ctx.fillStyle='#28463c';ctx.font=`900 ${label.length>2?17:21}px system-ui, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,44,43);
  }
  return ctx.getImageData(0,0,88,88);
}
export function addMarkerGroupImages(map: LibreMap) {
  for (const bank of [false,true]) { const id = `atlas-group-${bank?'banks':'signals'}-default`; if(!map.hasImage(id)) map.addImage(id,markerGroupImage([{color:bank?'#169464':'#7b817e',count:1}],bank),{pixelRatio:2}); }
}

type GroupLayer = { id:string; source:string; bank?:boolean; leaf?:boolean };
const LAYERS: GroupLayer[] = [
  {id:'atlas-bank-clusters',source:'atlas-offices',bank:true},
  {id:'atlas-signal-clusters',source:'atlas-signal-points'},
  {id:'atlas-signal-areas-circle',source:'atlas-signal-areas',leaf:true},
];
/** One GPU symbol layer per collection; no DOM marker per event and no source mutations. */
export function installMarkerGroups(map: LibreMap) {
  const images = new Map<string, number>(), fingerprints = new Map<string,string>(); let disposed = false, scheduled = false;
  addMarkerGroupImages(map);
  const refresh = () => {
    scheduled = false; if(disposed) return;
    const used = new Set<string>(), now = performance.now();
    try {
      const canvas = map.getCanvas(), zoom = map.getZoom();
      for (const config of LAYERS) {
        if(!map.getLayer(config.id) || !map.getSource(config.source)) continue;
        if(config.source==='atlas-signal-areas' && zoom>=11) continue;
        const expression: unknown[] = ['match',['get',config.leaf?'territoryId':'cluster_id']], seen = new Set<string|number>();
        const fallback = `atlas-group-${config.bank?'banks':'signals'}-default`;
        const features = map.querySourceFeatures(config.source,{filter:config.leaf?['!',['has','point_count']]:['has','point_count']});
        for(const feature of features) {
          if(feature.geometry.type!=='Point') continue;
          const properties = feature.properties ?? {}, key = config.leaf ? String(properties.territoryId || feature.id || '') : Number(properties.cluster_id);
          if(seen.has(key)) continue; seen.add(key);
          const xy = map.project(feature.geometry.coordinates as [number,number]);
          if(xy.x < -80 || xy.y < -80 || xy.x > canvas.clientWidth+80 || xy.y > canvas.clientHeight+80) continue;
          const segments = markerGroupSegments(properties,config.bank), signature = markerGroupSignature(segments);
          const count = segments.reduce((sum,segment)=>sum+segment.count,0);
          const imageId = `atlas-mixture-${config.bank?'bank':'signal'}-${signature}-${Math.min(count,1000)}`;
          if(!map.hasImage(imageId)) map.addImage(imageId,markerGroupImage(segments,config.bank),{pixelRatio:2});
          images.set(imageId,now); used.add(imageId); expression.push(key,imageId);
          if(expression.length>=642) break; // At most 320 visible compositions per collection.
        }
        const value = expression.length>2 ? [...expression,fallback] as ExpressionSpecification : fallback;
        const fingerprint = JSON.stringify(value);
        if(fingerprints.get(config.id)!==fingerprint) { map.setLayoutProperty(config.id,'icon-image',value); fingerprints.set(config.id,fingerprint); }
      }
      // Remove only sprites no longer referenced by any layer expression.
      const references = [...fingerprints.values()].join('');
      for(const [id,lastSeen] of images) if(!used.has(id) && !references.includes(id) && (images.size>256 || now-lastSeen>120_000)) { if(map.hasImage(id)) map.removeImage(id); images.delete(id); }
    } catch { /* A style can be replaced while a source finishes loading. */ }
  };
  const schedule = () => { if(!scheduled&&!disposed) { scheduled=true; requestAnimationFrame(refresh); } };
  const onSource = (event: {sourceId?:string;isSourceLoaded?:boolean}) => { if(event.isSourceLoaded && LAYERS.some(layer=>layer.source===event.sourceId)) schedule(); };
  map.on('moveend',schedule); map.on('sourcedata',onSource); schedule();
  return () => { disposed=true; map.off('moveend',schedule); map.off('sourcedata',onSource); images.clear(); fingerprints.clear(); };
}
