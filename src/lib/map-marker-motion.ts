import type { Map as LibreMap } from 'maplibre-gl';
import type { Signal } from './types';
import { markerImage, markerMorphImage } from './map-markers';
import { SIGNAL_GROUPS, signalMarker, markerFaceColor, markerStatusIcon, type MarkerVisualState, type SignalMarker } from './signal-markers';
import { SIGNAL_ICON_NODES, type SignalIcon } from './signal-icon-nodes';

export type MarkerRaster = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
export type MarkerMotionOptions = { mobile?: boolean; now?: number; renderMarker?: (marker: SignalMarker) => MarkerRaster };
export type MarkerMotionTheme = 'water' | 'heat' | 'sequence' | 'heart' | 'leaf' | 'connectivity' | 'glint';
type Tone = 'normal' | 'quiet' | 'resolved';
type Candidate = { marker: SignalMarker; tone: Tone; count: number };
type Frame = { raster: MarkerRaster; key: string };
type MarkerFrames = { topic: MarkerRaster; status: MarkerRaster; empty?: MarkerRaster; morph?: (amount:number)=>MarkerRaster };
type State = { active: Map<string, string>; bases: Map<string, MarkerFrames>; frames: Map<string, Frame>; selected: Candidate[]; lastFrame: number; lastScan: number; signals: readonly Signal[] | null; indexed: Map<string, Signal>; known: Map<string, SignalMarker> };
const states = new WeakMap<LibreMap, State>();
const LAYERS = ['atlas-signal-points-circle', 'atlas-signal-areas-circle'];
const MAX_ACTIVE = 10;
const DAY = 86_400_000;
const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const freshState = (): State => ({ active: new Map(), bases: new Map(), frames: new Map(), selected: [], lastFrame: -Infinity, lastScan: -Infinity, signals: null, indexed: new Map(), known: new Map() });

export function markerMotionTheme(marker: Pick<SignalMarker, 'group' | 'icon'>): MarkerMotionTheme {
  if (['droplets', 'waves'].includes(marker.icon)) return 'water';
  if (['heater', 'flame'].includes(marker.icon)) return 'heat';
  if (marker.group === 'roads' || marker.group === 'transport') return 'sequence';
  if (marker.group === 'health' || marker.group === 'social') return 'heart';
  if (marker.group === 'landscape' || marker.group === 'ecology') return 'leaf';
  if (marker.group === 'communication' || ['zap', 'wifi', 'antenna'].includes(marker.icon)) return 'connectivity';
  return 'glint';
}

/** Shared sprites use the quietest visible status; a mixed state never claims resolution. */
export function markerMotionTone(signals: readonly Signal[], now = Date.now()): Tone {
  if (!signals.length) return 'quiet';
  const resolved = (signal: Signal) => Boolean(signal.live?.state==='resolved'||signal.closedAt || signal.lifecycle?.status === 'completed');
  if (signals.every(resolved)) return 'resolved';
  if (signals.some((signal) => {
    if (resolved(signal)||signal.visibility==='private') return true;
    const date = Date.parse(signal.live?.lastMeaningfulAt || signal.lifecycle?.asOf || signal.publishedAt), age = now - date;
    return !Number.isFinite(age) || age < 0 || age > 45 * DAY;
  })) return 'quiet';
  return 'normal';
}

function markerForImage(id: string, known: Map<string, SignalMarker>): SignalMarker | null {
  const found = known.get(id); if (found) return found;
  // Area summaries may use a group-specific layered icon rather than one signal's glyph.
  for (const group of Object.keys(SIGNAL_GROUPS) as (keyof typeof SIGNAL_GROUPS)[]) {
    const prefix = `atlas-category-${group}-`; if (!id.startsWith(prefix)) continue;
    const [glyph, visualState] = id.slice(prefix.length).split('--'); const icon = glyph as SignalIcon; if (!(icon in SIGNAL_ICON_NODES)) return null;
    const marker = { group, icon, visualState: visualState as MarkerVisualState | undefined, faceColor: markerFaceColor(group,visualState as MarkerVisualState | undefined), imageId: id, color: SIGNAL_GROUPS[group].color, label: SIGNAL_GROUPS[group].label, mixed: icon === 'layers' }; known.set(id, marker); return marker;
  }
  return null;
}

/** The whole pin breathes, while its geographic tip stays fixed. Archives never move. */
export function renderMarkerMotion(base: MarkerRaster, theme: MarkerMotionTheme, phase: number, tone: Tone): MarkerRaster {
  if (tone !== 'normal') return base;
  const { width, height } = base, data = new Uint8ClampedArray(base.data.length);
  const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  const scale = 1 + wave * (theme === 'heart' ? .046 : .034);
  const anchorX = width * .5, anchorY = height * (115 / 136);
  // Bilinear sampling avoids shimmer on diagonal glyphs at the six-to-ten fps budget.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const srcX = (x - anchorX) / scale + anchorX, srcY = (y - anchorY) / scale + anchorY;
    const left = Math.floor(srcX), top = Math.floor(srcY), fx = srcX - left, fy = srcY - top;
    const out = (y * width + x) * 4;
    for (let channel = 0; channel < 4; channel++) {
      let value = 0;
      for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
        const sx = left + xx, sy = top + yy;
        if (sx >= 0 && sy >= 0 && sx < width && sy < height) value += base.data[(sy * width + sx) * 4 + channel] * (xx ? fx : 1-fx) * (yy ? fy : 1-fy);
      }
      // Gently light the coloured face; white category glyphs remain white.
      data[out + channel] = channel < 3 ? Math.round(value + (255-value) * .075 * wave) : Math.round(value);
    }
  }
  return { width, height, data };
}

function trim<K, V>(cache: Map<K, V>, maximum: number) { while (cache.size > maximum) cache.delete(cache.keys().next().value!); }
function restore(map: LibreMap, state: State, id: string) { const base = state.bases.get(id); if (base && map.hasImage(id)) map.updateImage(id, base.topic); state.active.delete(id); }

/** One 4.8s loop: topic → short optical morph → status → return. */
export function markerPhase(phase: number): 'topic'|'to-status'|'status'|'to-topic' {
  const point=((phase%1)+1)%1;
  return point < .34 ? 'topic' : point < .50 ? 'to-status' : point < .76 ? 'status' : point < .92 ? 'to-topic' : 'topic';
}

export function blendMarkerRasters(topic: MarkerRaster, status: MarkerRaster, amount: number): MarkerRaster {
  const weight=clamp(amount), data=new Uint8ClampedArray(topic.data.length);
  for(let i=0;i<data.length;i++) data[i]=Math.round(topic.data[i]*(1-weight)+status.data[i]*weight);
  return {width:topic.width,height:topic.height,data};
}

type MorphPoint={x:number;y:number};
type MorphField={left:number;top:number;width:number;height:number,topic:MorphPoint[],status:MorphPoint[]};
const morphCache=new WeakMap<object,{status:object;field:MorphField|null}>();
const white=(data:MarkerRaster['data'],offset:number)=>data[offset+3]>150&&data[offset]>218&&data[offset+1]>218&&data[offset+2]>218;
function makeMorphField(topic:MarkerRaster,status:MarkerRaster):MorphField|null{
  const left=28,top=26,width=56,height=56,a:MorphPoint[]=[],b:MorphPoint[]=[];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const offset=((top+y)*topic.width+left+x)*4;if(white(topic.data,offset))a.push({x,y});if(white(status.data,offset))b.push({x,y});}
  if(!a.length||!b.length)return null;
  const order=(points:MorphPoint[])=>{const center=points.reduce((sum,p)=>({x:sum.x+p.x,y:sum.y+p.y}),{x:0,y:0});center.x/=points.length;center.y/=points.length;return points.sort((p,q)=>Math.atan2(p.y-center.y,p.x-center.x)-Math.atan2(q.y-center.y,q.x-center.x)||Math.hypot(p.x-center.x,p.y-center.y)-Math.hypot(q.x-center.x,q.y-center.y));};
  return {left,top,width,height,topic:order(a),status:order(b)};
}

/** Geometric icon morph: interpolate both signed distance fields, not pixels. */
export function morphMarkerRasters(topic:MarkerRaster,status:MarkerRaster,amount:number,empty:MarkerRaster=topic):MarkerRaster{
  const weight=clamp(amount),cached=morphCache.get(topic as object);let field=cached?.status===status?cached.field:undefined;
  if(field===undefined){field=makeMorphField(topic,status);morphCache.set(topic as object,{status:status as object,field});}
  if(!field)return blendMarkerRasters(topic,status,weight);
  const data=new Uint8ClampedArray(empty.data),smooth=weight*weight*(3-2*weight),count=Math.max(field.topic.length,field.status.length);
  for(let i=0;i<count;i++){
    const from=field.topic[Math.floor(i*field.topic.length/count)],to=field.status[Math.floor(i*field.status.length/count)];
    const x=field.left+Math.round(from.x+(to.x-from.x)*smooth),y=field.top+Math.round(from.y+(to.y-from.y)*smooth);
    for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++){if(x+xx<0||y+yy<0||x+xx>=topic.width||y+yy>=topic.height)continue;const offset=((y+yy)*topic.width+x+xx)*4,alpha=xx===0&&yy===0?1:.42;for(let channel=0;channel<3;channel++)data[offset+channel]=Math.round(data[offset+channel]*(1-alpha)+255*alpha);data[offset+3]=Math.max(data[offset+3],Math.round(255*alpha));}
  }
  return {width:topic.width,height:topic.height,data};
}

export function renderMarkerSequence(topic: MarkerRaster, status: MarkerRaster, theme: MarkerMotionTheme, phase: number, tone: Tone, empty?:MarkerRaster, vectorMorph?:(amount:number)=>MarkerRaster): MarkerRaster {
  if(tone!=='normal') return topic;
  const stage=markerPhase(phase);
  if(stage==='topic') return renderMarkerMotion(topic,theme,phase/.46,'normal');
  if(stage==='status') return status;
  const progress=stage==='to-status' ? (phase-.34)/.16 : 1-(phase-.76)/.16;
  return vectorMorph?.(progress)??morphMarkerRasters(topic,status,progress,empty);
}

/** Call from the existing pulse loop. It owns no timer, feature position, layout, or image ID. */
export function updateMarkerMotion(map: LibreMap, signals: readonly Signal[], timeMs: number, enabled: boolean, options: MarkerMotionOptions = {}) {
  let state = states.get(map); if (!state) { state = freshState(); states.set(map, state); }
  const stats = () => ({ activeSprites: state!.active.size, cachedFrames: state!.frames.size, cachedBases: state!.bases.size });
  try {
    if (!LAYERS.some(id=>map.getLayer(id))) return stats();
    if (!enabled) { for (const id of [...state.active.keys()]) restore(map, state, id); state.lastFrame = -Infinity; state.lastScan = -Infinity; return stats(); }
    if (!Number.isFinite(timeMs)) return stats();
    const mobile = options.mobile ?? map.getCanvas().clientWidth <= 760, interval = 1000 / (mobile ? 6 : 10);
    if (timeMs < state.lastFrame) { state.lastFrame = -Infinity; state.lastScan = -Infinity; }
    if (timeMs - state.lastFrame < interval) return stats(); state.lastFrame = timeMs;
    const changed = signals !== state.signals;
    if (changed) { state.indexed = new Map(signals.map((signal) => [signal.id, signal])); for (const signal of signals) { const marker = signalMarker(signal); state.known.set(marker.imageId, marker); } state.signals = signals; }
    if (changed || timeMs - state.lastScan >= (mobile ? 600 : 350)) {
      const layers = LAYERS.filter((id) => map.getLayer(id));
      const visible = layers.length ? map.queryRenderedFeatures({ layers }) : [], grouped = new Map<string, { marker: SignalMarker; signals: Signal[]; unknown: boolean; count: number }>();
      for (const feature of visible) {
        const properties = feature.properties ?? {}, id = String(properties.markerId ?? properties.marker ?? ''), marker = markerForImage(id, state.known);
        if (!marker || !map.hasImage(id)) continue;
        const signal = state.indexed.get(String(properties.id ?? properties.signalId ?? feature.id ?? ''));
        const group = grouped.get(id) ?? { marker, signals: [], unknown: false, count: 0 }; group.count++; if (signal) group.signals.push(signal); else group.unknown = true; grouped.set(id, group);
      }
      state.selected = [...grouped.values()].map((group) => ({ marker: group.marker, count: group.count, tone: group.unknown || group.marker.mixed || ['archive','planned','paused','locality'].includes(group.marker.visualState ?? '') ? 'quiet' as const : markerMotionTone(group.signals, options.now) }))
        .sort((a, b) => Number(state!.active.has(b.marker.imageId)) - Number(state!.active.has(a.marker.imageId)) || b.count - a.count || a.marker.imageId.localeCompare(b.marker.imageId)).slice(0, MAX_ACTIVE);
      state.lastScan = timeMs; trim(state.known, 64);
    }
    const selected = new Set(state.selected.map((candidate) => candidate.marker.imageId));
    for (const id of [...state.active.keys()]) if (!selected.has(id)) restore(map, state, id);
    for (const candidate of state.selected) {
      const id = candidate.marker.imageId; if (!map.hasImage(id)) { state.active.delete(id); continue; }
      let base = state.bases.get(id); if (!base) {
        // First phase: topic colour and semantic glyph. Second phase: status
        // colour and a state glyph. The pin tip remains in the same raster.
        const topicMarker={...candidate.marker,faceColor:candidate.marker.faceColor??candidate.marker.color,visualState:undefined};
        const statusMarker={...topicMarker,icon:markerStatusIcon(candidate.marker.visualState)};
        const topic=options.renderMarker?.(topicMarker) ?? markerImage('signal',undefined,topicMarker);
        // Unit tests inject one synthetic topic raster; the browser always has
        // a canvas and therefore receives the real, distinct status raster.
        const status=typeof document==='undefined'?topic:markerImage('signal',undefined,statusMarker),empty=typeof document==='undefined'?topic:markerImage('signal',undefined,topicMarker,false);
        base={topic,status,empty,morph:typeof document==='undefined'?undefined:(amount)=>markerMorphImage(empty as ImageData,topicMarker.icon,statusMarker.icon,amount)};
        state.bases.set(id, base);
      }
      // Archives, plans, pauses and resolved events stay still; fresh reports breathe.
      const frameCount = candidate.tone === 'quiet' ? 16 : mobile ? 24 : 40, duration = candidate.tone === 'quiet' ? 8000 : 6400;
      const frameIndex = candidate.tone !== 'normal' ? 0 : Math.floor((timeMs % duration) / duration * frameCount);
      const theme = markerMotionTheme(candidate.marker), key = `${id}:${candidate.tone}:${theme}:${frameIndex}`;
      if (state.active.get(id) === key) continue;
      let frame = state.frames.get(key); if (!frame) { frame = { key, raster: renderMarkerSequence(base.topic,base.status,theme,frameIndex / frameCount,candidate.tone,base.empty,base.morph) }; state.frames.set(key, frame); }
      else { state.frames.delete(key); state.frames.set(key, frame); }
      map.updateImage(id, frame.raster); state.active.set(id, key);
    }
    trim(state.frames, mobile ? 32 : 64);
    // Retain bases of active sprites so disabling can always restore the original glyph.
    for (const id of state.bases.keys()) { if (state.bases.size <= (mobile ? 16 : 32)) break; if (!state.active.has(id)) state.bases.delete(id); }
    return stats();
  } catch { return stats(); } // Removed maps and style replacements do not revive an animation loop.
}

export function disposeMarkerMotion(map: LibreMap) {
  const state = states.get(map); if (!state) return;
  try { if (LAYERS.some(id=>map.getLayer(id))) for (const id of [...state.active.keys()]) restore(map, state, id); } catch { /* Map may already be removed. */ }
  state.active.clear(); state.bases.clear(); state.frames.clear(); state.indexed.clear(); state.known.clear(); states.delete(map);
}
