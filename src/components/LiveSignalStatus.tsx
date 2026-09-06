'use client';

import {AlertCircle, Radio, WifiOff} from 'lucide-react';
import type {LiveWorkerStatus} from '@/lib/live-types';

export default function LiveSignalStatus({worker,error,loading,newCount,onNew,onRetry}:{worker:LiveWorkerStatus|null;error:string;loading:boolean;newCount:number;onNew:()=>void;onRetry:()=>void}) {
  const offline=worker?.state==='offline'||worker?.state==='error'||Boolean(error);
  const label=error?'Нет связи с приложением':worker?.state==='error'?'Ошибка сборщика':worker?.state==='offline'?(worker.heartbeatAt?'Сбор приостановлен':'Мониторинг не подключён'):loading?'Подключаемся':'Сигналы';
  const signals=<button type="button" key={newCount} className={`live-new-badge glass ${newCount?'has-new':''}`} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.preventDefault();event.stopPropagation();onNew();}} aria-label={newCount?`Показать новые сигналы: ${newCount}`:'Открыть сигналы'}><Radio size={15}/>{newCount>0&&<strong>{newCount}</strong>}<span>{newCount>0?'новых сигналов':'Сигналы'}</span></button>;
  if(!offline)return signals;
  return <>{signals}<div className="live-worker-chip glass is-warning" role="status" title={error||worker?.message||undefined}>
    <WifiOff size={14}/><span>{label}</span><button onClick={onRetry} aria-label="Повторить подключение"><AlertCircle size={14}/></button>
  </div></>;
}
