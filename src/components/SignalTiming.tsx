import {Clock3, CalendarDays, ArrowUpRight} from 'lucide-react';
import type {Signal} from '@/lib/types';
import {shortDateTime} from '@/lib/format';
import {calculateSignalTiming, stageLabels} from '@/lib/signal-timing';
import {Source} from './ui';

export default function SignalTiming({signal,asOf}:{signal:Signal;asOf:string}){
  const live=signal.live;
  if(!live)return null;
  const timing=live.timing??calculateSignalTiming(live.state,live.history??[],[],null,asOf);
  const now=Date.parse(asOf),deadline=timing.officialDeadline;
  const overdue=deadline&&Date.parse(deadline.at)<now&&!['resolved','cancelled'].includes(live.state);
  const estimate=timing.estimate;
  const days=estimate?Math.max(0,Math.ceil((Date.parse(estimate.to)-now)/86400000)):null;
  const elapsed=timing.startedAt?Math.max(0,Math.floor((now-Date.parse(timing.startedAt))/86400000)):null;
  const history=[...(live.history??[])].sort((a,b)=>Date.parse(a.sourcePublishedAt||a.at)-Date.parse(b.sourcePublishedAt||b.at)||Date.parse(a.at)-Date.parse(b.at));
  const emptyTitle=live.state==='resolved'?'Событие завершено':live.state==='cancelled'?'Событие отменено':live.state==='paused'?'Работы приостановлены':live.state==='planned'?'Ожидаем начала работ':'Пока недостаточно данных';
  return <>
    <section className="signal-timing" aria-label="Сроки и прогноз">
      <h3><Clock3 size={18}/>Сроки и прогноз</h3>
      <div className="signal-estimate"><span>{estimate?'Ориентир завершения':'Прогноз завершения'}</span><strong>{estimate?`В пределах ${days} дн.`:emptyTitle}</strong>{estimate&&<p>{shortDateTime(estimate.from)} — {shortDateTime(estimate.to)}</p>}{!estimate&&<p>{timing.reason}</p>}</div>
      <dl className="signal-dates">
        <div><dt><CalendarDays size={15}/>Официальный срок</dt><dd>{deadline?<><strong>{shortDateTime(deadline.dateOnly?deadline.at.slice(0,10):deadline.at)}</strong><Source url={deadline.sourceUrl}>Заявленный срок</Source></>:'В доступных данных не подтверждён'}</dd></div>
        {overdue&&<div className="signal-deadline-alert"><dt>Срок прошёл</dt><dd>Подтверждения завершения нет. Уточните статус у исполнителя.</dd></div>}
        {live.eventTime&&<div><dt>{live.state==='planned'?'Запланированное событие':'Дата события'}</dt><dd>{shortDateTime(live.eventTime)}</dd></div>}
        {timing.startedAt&&<div><dt>О начале сообщили</dt><dd>{shortDateTime(timing.startedAt)}<small>С сообщения прошло {elapsed} дн.</small></dd></div>}
      </dl>
      {estimate&&deadline&&Date.parse(estimate.to)>Date.parse(deadline.at)&&<p className="signal-status-note">Прогноз выходит за официальный срок. Есть риск задержки — уточните план завершения.</p>}
      {estimate&&<details className="signal-fold"><summary>На чём основан прогноз · {estimate.sampleCount} аналогов</summary><p>{timing.reason}</p><ul className="signal-analogs">{estimate.samples.map(sample=><li key={sample.id}><Source url={sample.sourceUrl}>{sample.title}</Source><span>{Math.round(sample.days*10)/10} дн.</span></li>)}</ul></details>}
      {deadline&&<details className="signal-fold"><summary>Формулировка срока в источнике</summary><blockquote>{deadline.quote}</blockquote></details>}
    </section>
    <section className="signal-stages"><h3>Как развивается событие <span>{history.length||'—'}</span></h3>
      {history.length?<ol>{history.map((item,index)=><li key={`${item.at}-${index}`} className={index===history.length-1?'is-latest':''}><i aria-hidden="true"/><div><strong>{stageLabels[item.state]||item.label}</strong><time>{shortDateTime(item.sourcePublishedAt||item.at)}</time><p>{item.label}{!item.sourcePublishedAt?' · дата фиксации в системе':''}</p>{item.sourceUrl&&<a href={item.sourceUrl} target="_blank" rel="noreferrer">Источник <ArrowUpRight size={12}/></a>}</div></li>)}</ol>:<p className="signal-empty">Переходы между стадиями ещё не зафиксированы. Текущий статус — {stageLabels[live.state].toLocaleLowerCase('ru-RU')}.</p>}
    </section>
  </>;
}
