'use client';

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {completeLiveSnapshot} from '@/lib/live-pagination';
import type {Mode, Signal} from '@/lib/types';
import type {LiveSignalChangesResponse, LiveSignalsResponse, LiveWorkerStatus} from '@/lib/live-types';

export type LiveWindowDays = 30 | 45 | 60;
type Bbox = [number, number, number, number];

export type LiveSignalFeedOptions = {
  mode: Mode;
  region?: string;
  territory: string;
  days: LiveWindowDays;
  archive?: boolean;
  ongoing: boolean;
  bbox?: Bbox | null;
  enabled?: boolean;
};

const POLL_MS = 30_000;
const PAGE_SIZE = 500;
const UNREAD_KEY='atlas:live-unread:v1';
const RECENT_KEY='atlas:live-recent:v1';
const RECENT_MS=24*60*60*1000;
const validSignals = (value:unknown):Signal[] => Array.isArray(value) ? value.filter((item):item is Signal => Boolean(item && typeof item === 'object' && typeof (item as Signal).id === 'string')) : [];
const storedIds=(key:string):string[]=>{try{const value=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'):[];}catch{return [];}};
const storedRecent=():Record<string,number>=>{try{const value=JSON.parse(localStorage.getItem(RECENT_KEY)||'{}');return value&&typeof value==='object'?value:{};}catch{return {};}};

export function mergeSignalChanges(current:readonly Signal[], upserts:readonly Signal[], removed:readonly string[]) {
  const drop = new Set(removed);
  const next = new Map(current.filter(item => !drop.has(item.id)).map(item => [item.id, item]));
  for (const item of upserts) next.set(item.id, item);
  return [...next.values()].sort((a,b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}
export const countNotifiableChanges=(upserts:readonly Signal[])=>upserts.filter(item=>item.live?.notifyEligible===true).length;

function query(options:LiveSignalFeedOptions, offset?:number) {
  const params = new URLSearchParams({mode:options.mode, region:options.region ?? 'RU-TA', territory:options.territory, days:String(options.days), archive:String(Boolean(options.archive)), ongoing:String(options.ongoing), limit:String(PAGE_SIZE)});
  if (offset) params.set('offset', String(offset));
  if (options.bbox) params.set('bbox', options.bbox.map(value => Number(value.toFixed(5))).join(','));
  return params;
}

async function json<T>(url:string, signal:AbortSignal, etag?:string) {
  const response = await fetch(url, {cache:'no-store', signal, headers:etag ? {'If-None-Match':etag} : undefined});
  if (response.status === 304) return {value:null as T|null, etag};
  if (!response.ok) throw new Error(`live-signals:${response.status}`);
  return {value:await response.json() as T, etag:response.headers.get('etag') ?? undefined};
}

async function snapshot(scope:string, signal:AbortSignal, etag?:string) {
  const result=await json<LiveSignalsResponse>(`/api/signals?${scope}`,signal,etag);
  if(!result.value)return result;
  const value=await completeLiveSnapshot(result.value,async offset=>{
    const next=new URLSearchParams(scope);next.set('offset',String(offset));
    const page=await json<LiveSignalsResponse>(`/api/signals?${next}`,signal);
    if(!page.value)throw new Error('Missing signal page');
    return page.value;
  },signal);
  return {...result,value};
}

export function useLiveSignals(options:LiveSignalFeedOptions) {
  const [signals,setSignals] = useState<Signal[]>([]);
  const [cursor,setCursor] = useState('');
  const [asOf,setAsOf] = useState('');
  const [total,setTotal] = useState(0);
  const [hasMore,setHasMore] = useState(false);
  const [worker,setWorker] = useState<LiveWorkerStatus|null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [unreadIds,setUnreadIds] = useState<string[]>(()=>typeof window==='undefined'?[]:storedIds(UNREAD_KEY));
  const [recentIds,setRecentIds] = useState<string[]>(()=>typeof window==='undefined'?[]:Object.entries(storedRecent()).filter(([,at])=>Number(at)>Date.now()-RECENT_MS).map(([id])=>id));
  const unreadRef=useRef(new Set(unreadIds));
  const signalsRef = useRef<Signal[]>([]), cursorRef = useRef(''), etagRef = useRef<string|undefined>(undefined), loadedOffsetRef=useRef(0);
  const scope = useMemo(() => query(options).toString(), [options.mode, options.region, options.territory, options.days, options.archive, options.ongoing, options.bbox?.join(',')]);
  const enabled = options.enabled !== false;

  const replace = useCallback((payload:LiveSignalsResponse) => {
    const items = validSignals(payload.signals);
    signalsRef.current = items; cursorRef.current = payload.cursor || ''; loadedOffsetRef.current=items.length;
    setSignals(items); setCursor(payload.cursor || ''); setAsOf(payload.asOf || ''); setTotal(Number(payload.total) || items.length); setHasMore(Boolean(payload.hasMore)); setWorker(payload.worker ?? null);
    const visible=new Set(items.map(item=>item.id));
    const nextUnread=[...unreadRef.current].filter(id=>visible.has(id));unreadRef.current=new Set(nextUnread);setUnreadIds(nextUnread);
    setError('');
  }, []);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    const controller = new AbortController();
    signalsRef.current=[]; cursorRef.current=''; etagRef.current=undefined; loadedOffsetRef.current=0;
    setSignals([]); setCursor(''); setLoading(true); setError('');
    snapshot(scope, controller.signal).then(result => {
      if (!result.value) return;
      etagRef.current=result.etag; replace(result.value);
    }).catch(() => { if (!controller.signal.aborted) setError('Live-лента временно недоступна. Показана сохранённая версия.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, replace, scope]);

  useEffect(() => {
    if (!enabled) return;
    let controller:AbortController|null=null, timer:ReturnType<typeof setTimeout>|null=null, disposed=false;
    const schedule=()=>{if(!disposed)timer=setTimeout(poll,POLL_MS);};
    const baseline=async()=>{
      controller?.abort(); controller=new AbortController();
      try { const result=await snapshot(scope,controller.signal,etagRef.current); if(result.value){etagRef.current=result.etag;replace(result.value);} setError(''); }
      catch { if(!controller.signal.aborted)setError('Связь с live-лентой прервана. Повторяем подключение.'); }
    };
    const poll=async()=>{
      if(document.hidden||!navigator.onLine){schedule();return;}
      if(!cursorRef.current){await baseline();schedule();return;}
      controller?.abort();controller=new AbortController();
      try{
        const result=await json<LiveSignalChangesResponse>(`/api/signals/changes?${scope}&after=${encodeURIComponent(cursorRef.current)}`,controller.signal);
        const payload=result.value;if(!payload)return;
        if(payload.reset){await baseline();schedule();return;}
        const upserts=validSignals(payload.upserts),known=new Set(signalsRef.current.map(item=>item.id));
        const added=upserts.filter(item=>!known.has(item.id)).length;
        const freshIds=upserts.filter(item=>!known.has(item.id)&&item.live?.notifyEligible===true).map(item=>item.id);
        const next=mergeSignalChanges(signalsRef.current,upserts,Array.isArray(payload.removed)?payload.removed:[]);
        signalsRef.current=next;cursorRef.current=payload.cursor||cursorRef.current;
        if(freshIds.length){const unread=new Set([...unreadRef.current,...freshIds]);unreadRef.current=unread;const ids=[...unread];setUnreadIds(ids);localStorage.setItem(UNREAD_KEY,JSON.stringify(ids));}
        setSignals(next);setCursor(cursorRef.current);setAsOf(payload.asOf||'');setTotal(value=>Math.max(0,value+added-(payload.removed?.length||0)));setWorker(payload.worker??null);setError('');
      }catch{if(!controller.signal.aborted)setError('Связь с live-лентой прервана. Повторяем подключение.');}
      schedule();
    };
    const wake=()=>{if(timer)clearTimeout(timer);timer=null;void poll();};
    const visible=()=>{if(!document.hidden)wake();};
    const online=()=>wake();
    timer=setTimeout(poll,POLL_MS);document.addEventListener('visibilitychange',visible);window.addEventListener('online',online);
    return()=>{disposed=true;if(timer)clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visible);window.removeEventListener('online',online);};
  },[enabled,replace,scope]);

  const loadMore=useCallback(async()=>{
    if(!enabled||loading||!hasMore)return;
    const controller=new AbortController();setLoading(true);
    try{const result=await json<LiveSignalsResponse>(`/api/signals?${query(options,loadedOffsetRef.current)}`,controller.signal);if(result.value){const page=validSignals(result.value.signals);loadedOffsetRef.current+=page.length;const next=mergeSignalChanges(signalsRef.current,page,[]);signalsRef.current=next;setSignals(next);setTotal(result.value.total);setHasMore(result.value.hasMore);setWorker(result.value.worker??null);}}
    catch{setError('Не удалось загрузить следующую часть ленты.');}finally{setLoading(false);}
  },[enabled,hasMore,loading,options]);

  const markRead=useCallback((id:string)=>{
    if(!unreadRef.current.has(id))return;
    const unread=new Set(unreadRef.current);unread.delete(id);unreadRef.current=unread;const ids=[...unread];setUnreadIds(ids);localStorage.setItem(UNREAD_KEY,JSON.stringify(ids));
    const recent={...storedRecent(),[id]:Date.now()};for(const [key,at] of Object.entries(recent))if(Number(at)<Date.now()-RECENT_MS)delete recent[key];localStorage.setItem(RECENT_KEY,JSON.stringify(recent));setRecentIds(Object.keys(recent));
  },[]);
  const acknowledgeNew=useCallback(()=>{unreadRef.current=new Set();setUnreadIds([]);localStorage.setItem(UNREAD_KEY,'[]');},[]);
  return {signals,cursor,asOf,total,hasMore,worker,loading,error,newCount:unreadIds.length,unreadIds,recentIds,markRead,acknowledgeNew,loadMore,reconnect:()=>window.dispatchEvent(new Event('online'))};
}

export function useLiveSignalDetail(id:string|null, fallback:Signal|null) {
  const [detail,setDetail]=useState<Signal|null>(fallback),[loading,setLoading]=useState(false);
  useEffect(()=>{
    setDetail(fallback);if(!id)return;
    const controller=new AbortController();setLoading(true);
    json<Signal>(`/api/signals/${encodeURIComponent(id)}`,controller.signal).then(result=>{if(result.value)setDetail(result.value);}).catch(()=>{}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[fallback,id]);
  return {detail,loading};
}
