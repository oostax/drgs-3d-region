'use client';

import {useEffect, useState} from 'react';
import {BriefcaseBusiness, CalendarPlus, ChevronRight} from 'lucide-react';
import type {SignalRelevanceResponse} from '@/lib/live-types';

export default function SignalRelevance({signalId,snapshot,onOrganization,onPlan}:{signalId:string;snapshot:string;onOrganization:(id:string)=>void;onPlan:(id:string)=>void}) {
  const [data,setData]=useState<SignalRelevanceResponse|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');setData(null);
    fetch(`/api/work/signal-relevance?signalId=${encodeURIComponent(signalId)}&snapshot=${encodeURIComponent(snapshot)}`,{cache:'no-store',signal:controller.signal})
      .then(async response=>{if(!response.ok)throw new Error();return response.json() as Promise<SignalRelevanceResponse>;}).then(setData)
      .catch(()=>{if(!controller.signal.aborted)setError('Банковский контекст пока недоступен.');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();},[signalId,snapshot]);
  if(loading)return <section className="live-relevance" aria-busy="true"><p className="caption">Сопоставляем с локальным банковским контекстом…</p></section>;
  if(error)return <section className="live-relevance"><p className="caption">{error}</p></section>;
  if(!data?.items.length)return null;
  return <section className="live-relevance"><div className="live-section-title"><BriefcaseBusiness size={15}/><h3>Контекст для Сбера</h3></div>
    {data.items.slice(0,5).map((item,index)=><article className="live-relevance-card" key={`${item.reason}-${item.organizationId??index}`}>
      <div><strong>{item.label}</strong><span className={`live-confidence confidence-${item.confidence}`}>{item.confidence==='high'?'Высокая связь':item.confidence==='medium'?'Нужно проверить':'Гипотеза'}</span></div>
      <p>{item.explanation}</p>
      {item.organizationId&&<div className="live-relevance-actions"><button onClick={()=>onOrganization(item.organizationId!)}>Открыть организацию <ChevronRight size={13}/></button><button onClick={()=>onPlan(item.organizationId!)}><CalendarPlus size={13}/>Встреча</button></div>}
    </article>)}
    {data.limitations.length>0&&<details><summary>Ограничения сопоставления</summary><ul>{data.limitations.map((item,index)=><li key={index}>{item}</li>)}</ul></details>}
  </section>;
}
