import type {LiveEventHistoryItem, LiveEventState} from './live-types';

export const stageLabels:Record<LiveEventState,string>={reported:'Сообщение получено',planned:'Запланировано',in_progress:'В работе',paused:'Приостановлено',resolved:'Завершено',cancelled:'Отменено',unknown:'Статус уточняется'};
export type OfficialDeadline={at:string;sourceUrl:string;quote:string;dateOnly?:boolean};
export type TimingSample={id:string;title:string;sourceUrl:string;history:LiveEventHistoryItem[]};
export type SignalTiming={officialDeadline:OfficialDeadline|null;startedAt:string|null;estimate:{from:string;to:string;sampleCount:number;samples:{id:string;title:string;days:number;sourceUrl:string}[]}|null;reason:string};
const DAY=86_400_000;
const time=(value:string|null|undefined)=>value?Date.parse(value):NaN;

// Only explicit completion dates from official/utility publications qualify.
// Neither a publication date nor a bare event date is a completion commitment.
export function extractOfficialDeadline(text:string,sourceUrl:string):OfficialDeadline|null{
  if(/(?:не\s+(?:заверш|законч|восстанов)|срок[^.!?\n]{0,30}(?:неизвест|не\s+определ)|план[^.!?\n]{0,30}отмен|срок[^.!?\n]{0,35}перенес|перенес[^.!?\n]{0,35}срок)/iu.test(text))return null;
  const matches=[...text.matchAll(/(?:заверш(?:ить|ат|ение|ения)|оконч(?:ание|ания)|восстанов(?:ить|ят)|законч(?:ить|ат))[^.!?\n]{0,65}?(?:до|к|на)\s+(\d{1,2})[.](\d{1,2})[.](20\d{2})(?:\s*(?:г\.?\s*)?(?:в|до)\s*(\d{1,2}):(\d{2}))?/giu)];
  if(matches.length!==1||!sourceUrl)return null;
  const m=matches[0],day=Number(m[1]),month=Number(m[2]),year=Number(m[3]),hour=m[4]?Number(m[4]):23,minute=m[5]?Number(m[5]):59;
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||hour>23||minute>59)return null;
  return {at:`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+03:00`,sourceUrl,quote:m[0],dateOnly:!m[4]};
}

export function observedWorkPeriod(history:LiveEventHistoryItem[]){
  // Old rows hold ingestion time only; they must never train the forecast.
  const versions=new Map<string,LiveEventHistoryItem>();
  for(const item of [...history].sort((a,b)=>time(a.at)-time(b.at))){
    if(item.sourcePublishedAt&&item.sourceUrl&&Number.isFinite(time(item.sourcePublishedAt)))versions.set(`${item.sourceUrl}|${item.sourcePublishedAt}`,item);
  }
  const rows=[...versions.values()].sort((a,b)=>time(a.sourcePublishedAt)-time(b.sourcePublishedAt));
  const start=rows.find(h=>h.state==='in_progress');
  if(!start)return null;
  const end=rows.find(h=>h.state==='resolved'&&time(h.sourcePublishedAt)>time(start.sourcePublishedAt));
  if(rows.some(h=>['paused','cancelled'].includes(h.state))||rows.filter(h=>h.state==='in_progress'&&end&&time(h.sourcePublishedAt)>time(end.sourcePublishedAt)).length)return null;
  return {start:start.sourcePublishedAt!,end:end?.sourcePublishedAt??null};
}

export function calculateSignalTiming(state:LiveEventState,history:LiveEventHistoryItem[],samples:TimingSample[],officialDeadline:OfficialDeadline|null,asOf:string):SignalTiming{
  const now=time(asOf),period=observedWorkPeriod(history),startedAt=period?.start??null;
  const result:SignalTiming={officialDeadline,startedAt,estimate:null,reason:''};
  if(state==='resolved'||state==='cancelled')return {...result,reason:state==='resolved'?'Завершение отмечено в источнике.':'Событие отменено; прогноз не рассчитывается.'};
  if(state==='paused')return {...result,reason:'Прогноз появится после подтверждения возобновления работ.'};
  if(state!=='in_progress')return {...result,reason:'Для прогноза нужно сообщение о начале работ.'};
  if(!startedAt||!Number.isFinite(now)||time(startedAt)>now)return {...result,reason:'Дата сообщения о начале работ не подтверждена.'};
  const seen=new Set<string>();
  const valid=samples.flatMap(sample=>{
    if(seen.has(sample.id))return [];seen.add(sample.id);
    const p=observedWorkPeriod(sample.history);
    if(!p?.end||time(p.end)>now||!sample.sourceUrl)return [];
    const days=(time(p.end)-time(p.start))/DAY;
    return days>0&&days<=730?[{id:sample.id,title:sample.title,days,sourceUrl:sample.sourceUrl}]:[];
  }).sort((a,b)=>a.days-b.days);
  if(valid.length<5)return {...result,reason:`Нужно минимум 5 завершённых аналогов с историей. Сейчас подходящих: ${valid.length}.`};
  const from=time(startedAt)+valid[Math.floor((valid.length-1)*.2)].days*DAY;
  const to=time(startedAt)+valid[Math.ceil((valid.length-1)*.8)].days*DAY;
  if(to<now)return {...result,reason:'Обычный срок аналогов уже прошёл. Нужно новое сообщение о ходе работ.'};
  return {...result,estimate:{from:new Date(Math.max(now,from)).toISOString(),to:new Date(to).toISOString(),sampleCount:valid.length,samples:valid},reason:'Диапазон 20–80% длительностей аналогов того же типа и территории. Считаем между сообщениями о начале и завершении; это оценка, не обещание исполнителя.'};
}
