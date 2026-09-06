import {territorialAssessment} from '@/lib/territorial-assessment';
import type {Signal} from '@/lib/types';
import {categoryIcon,signalMarker} from '@/lib/signal-markers';
import {classifySignalRecency} from '@/lib/signal-recency';
import {normalizeSceneLifecycle} from '@/lib/scene-lifecycle';
import {signalSceneRecipe} from '@/lib/scene-catalog';
import {sceneCoverageDescription,shouldSuppressStreetScene} from '@/lib/signal-scenes';
import {signalPriority} from '@/lib/signal-priority';
import {shortDateTime} from '@/lib/format';
import SignalCategoryIcon from './SignalCategoryIcon';
import {Source} from './ui';
import {MapPin, ShieldCheck} from 'lucide-react';
import SignalTiming from './SignalTiming';

export const signalHeadline=(signal:Signal)=>signal.categoryBreakdown?.length===1?signal.categoryBreakdown[0].name:signal.title;
export const incidentCount=(n:number)=>`${n.toLocaleString('ru-RU')} ${n%100>=11&&n%100<=14?'обращений':n%10===1?'обращение':n%10>=2&&n%10<=4?'обращения':'обращений'}`;

export default function SignalDetail({signal,asOf,newsDays=45,onCategory}:{signal:Signal;asOf:string;newsDays?:30|45|60;onCategory:(category:string)=>void}){
  const marker=signalMarker(signal),recency=classifySignalRecency(signal,asOf,{newsDays}),isReport=signal.visibility==='private';
  const live=signal.live, regional=territorialAssessment(signal);
  const priority=signalPriority(signal),scene=normalizeSceneLifecycle(signal);
  const recipe=signalSceneRecipe(signal);
  const coverage=sceneCoverageDescription(signal);
  const sceneSuppressed=shouldSuppressStreetScene(signal);
  const hasHouse=(signal.addressCandidates??[]).some(a=>/[, ]+(?:д\.?\s*)?\d+[а-яa-z]?(?:\s*(?:к|корпус|стр)\.?\s*\d+)?[.;]?$/i.test(a));
  const unresolvedPlace=hasHouse?'Адрес указан в источнике · дом ещё не сопоставлен':'Не показано на карте · точный адрес или объект не подтверждён';
  const place=signal.address || (isReport?signal.title.split(': ').slice(1).join(': '):null);
  const stateLabel=live&&({reported:'Сообщают',planned:'Запланировано',in_progress:'В работе',paused:'Приостановлено',resolved:'Решено',cancelled:'Отменено',unknown:'Статус уточняется'} as const)[live.state];
  const sourceLabel=live&&({official:'Официальный источник',media:'СМИ',community:'Сообщение жителей',bank:'Банковский источник',utility:'Ресурсная организация'} as const)[live.sourceKind];
  return <article className="signal-card">
    <header className="signal-card-header">
      <h2 className="signal-card-title">{signalHeadline(signal)}</h2>
      <div className="signal-card-status"><span className={`signal-status state-${live?.state||'unknown'}`}><i aria-hidden="true"/>{stateLabel||recency.label}</span><span className="signal-priority" style={{color:priority.color}}>{priority.label}</span></div>
      {place&&<p className="signal-card-place"><MapPin size={17}/>{place}</p>}
      <div className="signal-card-meta"><SignalCategoryIcon icon={marker.icon} size={15}/><span>{marker.label}</span>{isReport&&<span>{incidentCount(signal.count??1)}</span>}</div>
      {recency.needsStatusVerification&&<p className="signal-status-note">Статус по последнему сообщению. Текущее состояние требует проверки.</p>}
    </header>
    {!isReport&&<section className="signal-brief"><h3>Что произошло</h3><p>{signal.summary}</p></section>}
    {signal.residentReport&&<section className="signal-report-totals" aria-label="Обращения по июльской выгрузке"><div><strong>{signal.residentReport.openCount}</strong><span>не закрыто</span></div><div><strong>{signal.residentReport.inProgressCount}</strong><span>из них в работе</span></div><div><strong>{signal.residentReport.closedCount}</strong><span>закрыто</span></div><p>По июльской выгрузке · первое обращение {shortDateTime(signal.residentReport.firstAt)}</p></section>}
    <SignalTiming signal={signal} asOf={asOf}/>
    <section className="signal-impact"><h3>Что это значит для территории</h3><dl><div><dt>Кого затрагивает</dt><dd>{regional.affected}</dd></div><div><dt>Почему важно</dt><dd>{regional.importance}</dd></div><div><dt>Что требуется</dt><dd>{regional.need}</dd></div></dl></section>
    {signal.nextStep&&<section className="signal-next"><h3>Следующий шаг</h3><p>{signal.nextStep.split(' Проверить конкретный участок')[0]}</p></section>}
    {signal.hypothesis&&!/требует (проверки|сопоставления)/.test(signal.hypothesis)&&<details className="signal-fold"><summary>Где может помочь Сбер · гипотеза</summary><p>{signal.hypothesis}</p></details>}
    <details className="signal-fold"><summary><MapPin size={16}/>Место и отображение на карте</summary>
    <p>{signal.precision==='street'?hasHouse?'Показана улица · дом из публикации ещё не сопоставлен':'Показана связанная улица · точный участок не указан':signal.precision==='territory'?unresolvedPlace:signal.precision==='site'?'Показана площадка объекта':signal.precision==='building'?'Привязано к зданию':'Показан населённый пункт'}</p>
    {coverage&&<p>{coverage}</p>}
    {signal.categoryBreakdown&&signal.categoryBreakdown.length>1&&<div className="category-breakdown">{signal.categoryBreakdown.map(category=><button key={category.name} onClick={()=>onCategory(category.name)}><span style={{color:marker.color}}><SignalCategoryIcon icon={categoryIcon(category.name,marker.group)}/></span><span>{category.name}</span><b>{category.count}</b></button>)}</div>}
    {recipe&&<p className="caption signal-scene-caption">{sceneSuppressed?'Точный участок работ не подтверждён: на карте оставлена только отметка на связанной улице. ':!['building','site','street'].includes(signal.precision??'')?'Для размещения сцены нужно уточнить место события. ':isReport?'Архивная 3D-иллюстрация темы при выборе на карте. ':scene.activeActivity?'Техника показывает вид работ; её положение условное. ':live?.state==='in_progress'?'Показан последний известный этап на дату источника; текущие работы не подтверждены. ':'3D-иллюстрация темы без имитации текущей работы техники. '}<a href={`/scenes?topic=${encodeURIComponent(recipe.id)}`} target="_blank" rel="noreferrer">Сцена в каталоге</a></p>}
    {!isReport&&!recipe&&<p className="caption signal-scene-caption">{scene.activeActivity?'3D-сцена иллюстрирует подтверждённый вид работ. Положение техники условное.':signal.precision==='territory'?'Для сцены требуется определить объект.':live?.outcome==='improvement'?'Зелёная отметка показывает открытие или завершённое улучшение.':'Показана тематическая отметка. '+scene.reason}</p>}
    </details>
    {live?.evidence?.length?<details className="signal-fold live-evidence"><summary>Публикации по событию · {live.evidence.length}</summary>{live.evidence.map(item=><article key={item.id}><div><strong>{item.label}</strong><span>{item.sourceKind==='community'?'Сообщение жителей':item.sourceKind==='official'?'Официальный источник':item.sourceKind==='media'?'СМИ':'Источник'}</span></div>{item.quote&&<p>{item.quote}</p>}<Source url={item.url}>Открыть публикацию</Source></article>)}</details>:null}
    <details className="signal-fold"><summary><ShieldCheck size={16}/>Достоверность и данные</summary><dl className="signal-dates"><div><dt>Достоверность</dt><dd>{live?.confidence==='high'?'Высокая':live?.confidence==='medium'?'Средняя':'Предварительная'}</dd></div><div><dt>Тип источника</dt><dd>{sourceLabel||signal.sourceName||'Не указан'}</dd></div><div><dt>Опубликовано</dt><dd>{shortDateTime(signal.publishedAt)}</dd></div><div><dt>Последнее изменение</dt><dd>{shortDateTime(live?.lastMeaningfulAt||signal.checkedAt)}</dd></div>{live&&<div><dt>Доказательства</dt><dd>{live.evidenceCount} публикаций{live.duplicateCount?` · ${live.duplicateCount} повторов объединено`:''}</dd></div>}</dl><p>{recency.reason}</p>{signal.lifecycle?.note&&<p>{signal.lifecycle.note}</p>}{signal.geographyNote&&<p>{signal.geographyNote}</p>}{signal.facts.map((f,i)=><p key={i}>{f}</p>)}<Source url={signal.sourceUrl}>{signal.sourceName||sourceLabel||'Публичная публикация'}</Source>{signal.coordinateSourceUrl&&<Source url={signal.coordinateSourceUrl}>Географическая привязка</Source>}{signal.relatedSources?.map(source=><Source key={source.url} url={source.url}>{source.label}</Source>)}{signal.checkedAt&&<p>Источник проверен {shortDateTime(signal.checkedAt)}. Проверка доступности не подтверждает статус события.</p>}</details>
  </article>;
}
