'use client';

import {useEffect, useId, useRef, useState} from 'react';
import {AlertCircle, CheckCircle2, ChevronRight, Clock3, Database, Download, FileSpreadsheet, MapPin, Radio, RefreshCw, ShieldCheck, Upload, Users} from 'lucide-react';
import type {Manifest, Mode, Signal} from '@/lib/types';
import type {OperationsPayload} from '@/lib/operations-data';
import type {PublicRefreshStatus} from '@/lib/public-refresh';
import type {LiveSourceStatus, LiveSourcesResponse} from '@/lib/live-types';
import {number, shortDate} from '@/lib/format';
import {Empty, Source} from './ui';

type ImportItem = {
  id:string; file_name:string; kind:string; status:string; rows_read:number; rows_kept:number;
  imported_at:string|null; period:string|null; error:string|null; is_current?:boolean;
  report:{questions?:{question:string;respondents:number;counts:Record<string,number>;average:number|null}[]; aggregation?:string;quality?:Record<string,unknown>; counters?:Record<string,unknown>; progress?:{rows_read?:number; rows_kept?:number; elapsed_seconds?:number}};
};
type ImportStatus = {
  sources:{name:string; available:boolean}[]; imports:ImportItem[];
  jobs:{id:string; file_name:string; status:string; started_at:string; completed_at:string|null; error:string|null}[];
};
type Tab = 'live'|'general'|'imports'|'team';

const sourceNames:Record<string,string> = {
  'rosstat-oktmo-index':'Росстат · каталог открытых данных', 'rosstat-oktmo':'Росстат · справочник ОКТМО',
  'overture-buildings':'Overture Maps · контуры зданий',
  'news-feed-rosstat':'Татарстанстат · новые публикации', 'news-feed-tatarstan':'Официальный Татарстан · новостная лента',
  'news-feed-minstroy':'Минстрой Татарстана · новостная лента',
  'osm-tatarstan-boundaries':'OpenStreetMap · границы Татарстана', 'osm-russia-regions-snapshot':'Обзор регионов России',
  'osm-russia-region-identifiers':'OpenStreetMap · названия регионов', 'osm-bank-locations':'OpenStreetMap · расположение банков',
  'cbr-sber':'Банк России · Сбер', 'cbr-vtb':'Банк России · ВТБ', 'cbr-akbars':'Банк России · Ак Барс',
  'cbr-psb':'Банк России · ПСБ', 'cbr-gazprombank':'Банк России · Газпромбанк',
};
const qualityNames:Record<string,string> = {
  invalid_numeric_cells:'Нераспознанные числовые значения', ambiguous_org_join:'Неоднозначная связь с организацией',
  invalid_inn_checksum_or_length:'ИНН требует проверки', missing_inn:'Не указан ИНН',
  inn_restored_leading_zero:'Восстановлен ведущий ноль ИНН', normalization_collision:'Совпадения после нормализации',
  meeting_conflicts:'Расхождения в показателях встреч', payroll_conflicts:'Расхождения в показателях ФОТ',
  missing_employee_id:'Не указан идентификатор сотрудника', missing_gosb:'Не указан ГОСБ', missing_offer_id:'Не указан номер предложения',
  unparsed_closed_dates:'Дата закрытия требует проверки', unparsed_created_dates:'Дата создания требует проверки',
  unparsed_stage_dates:'Дата этапа требует проверки', equal_duplicate_rows:'Повторяющиеся одинаковые строки',
  pilot_source_rows:'Строки, относящиеся к пилоту', source_offer_rows:'Строки предложений в источнике',
  technical_sheets_skipped:'Служебные листы пропущены',
};
const kindNames:Record<string,string> = {
  client_cards:'Карточки клиентов и филиалов',model_details:'Модельные предложения · отдельный срез',july_results:'Июльские своды · отдельные представления',mood_survey:'Опрос КМ · шкала 1–3',
  recipients:'Получатели ФОТ', payroll:'Объём ФОТ', meetings:'Встречи', offers_current:'Предложения в работе',
  offers_q1:'Предложения · I квартал', offers_q2:'Предложения · II квартал', offers_q3:'Предложения · III квартал',
  staff:'Команда', clusters:'Кластеры ГОСБ', complaint_summaries:'Обращения · сводные срезы', incidents:'Сигналы жителей',
};

function formatTimestamp(value:string|null|undefined) {
  if(!value)return 'Успешная загрузка не подтверждена';
  const date=new Date(value);
  return Number.isNaN(+date)?'Дата не указана':date.toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
}
function numeric(value:unknown):number|null { return typeof value==='number'&&Number.isFinite(value)?value:null; }
function object(value:unknown):Record<string,unknown> { return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}; }
function periodLabel(value:string|Record<string,unknown>|null|undefined):string {
  if(!value)return 'Период не указан';
  let period:Record<string,unknown>;
  try { period=typeof value==='string'?object(JSON.parse(value)):value; } catch { return 'Период требует проверки'; }
  if(typeof period.snapshot_date==='string')return `Срез на ${shortDate(period.snapshot_date)}${period.date_inferred?' · дата определена по контексту':''}`;
  if(typeof period.start==='string'&&typeof period.end==='string')return `${shortDate(period.start)} — ${shortDate(period.end)}`;
  if(Array.isArray(period.years))return period.years.join(' / ');
  const year=numeric(period.year);
  if(Array.isArray(period.months)) {
    const months=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
    const label=period.months.map(m=>months[Number(m)-1]).filter(Boolean).join(', ');
    return `${label}${year?` ${year}`:' · год не указан'}${period.year_inferred_from_companion?' · год определён по связанной выгрузке':''}`;
  }
  if(Array.isArray(period.quarters))return `${period.quarters.join(', ')} кварталы${year?` ${year}`:''}${period.year_inferred?' · год определён по контексту':''}`;
  return period.period_from_rows?'Период указан в строках источника':'Период не указан';
}
async function readJson<T>(url:string,signal?:AbortSignal):Promise<T> {
  const response=await fetch(url,{cache:'no-store',signal});
  if(!response.ok)throw new Error('Не удалось прочитать данные. Повторите попытку.');
  return response.json() as Promise<T>;
}
function Status({value,error=false}:{value:string;error?:boolean}) {
  const failed=error||['error','unavailable','stale'].includes(value);
  const active=['running','queued'].includes(value);
  const text=failed?'Нужна проверка':active?'Обрабатывается':value==='complete'?'Импортировано':value==='ok'?'Обновлено':'Сохранённая версия';
  const Icon=failed?AlertCircle:active?Clock3:CheckCircle2;
  return <span className={`source-status ${failed?'warning':active?'pending':'success'}`}><Icon size={14} aria-hidden="true"/>{text}</span>;
}
function Metric({value,label,detail}:{value:number|null;label:string;detail?:string}) {
  return <div className="source-metric"><strong>{number(value)}</strong><span>{label}</span>{detail&&<small>{detail}</small>}</div>;
}

export default function SourcesPanel({mode}:{mode:Mode}) {
  const [tab,setTab]=useState<Tab>('live');
  const id=useId();
  const selected=mode==='public'&&(tab==='imports'||tab==='team')?'general':tab;
  const tabs:{id:Tab;label:string}[]=mode==='work'?[{id:'live',label:'Live-ленты'},{id:'general',label:'Карты'},{id:'imports',label:'Импорт'},{id:'team',label:'Команда'}]:[{id:'live',label:'Live-ленты'},{id:'general',label:'Карты'}];
  return <div className="sources-panel">
    <div className="source-tabs" role="tablist" aria-label="Разделы источников">
      {tabs.map(item=><button key={item.id} id={`${id}-tab-${item.id}`} role="tab" aria-selected={selected===item.id}
        aria-controls={`${id}-panel`} tabIndex={selected===item.id?0:-1} className={selected===item.id?'active':''}
        onClick={()=>setTab(item.id)} onKeyDown={event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          event.preventDefault();
          const index=tabs.findIndex(t=>t.id===selected);
          const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
          setTab(tabs[next].id);document.getElementById(`${id}-tab-${tabs[next].id}`)?.focus();
        }}>{item.label}</button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${selected}`} tabIndex={0}>
      {selected==='live'&&<LiveSources/>}
      {selected==='general'&&<PublicSources/>}
      {mode==='work'&&selected==='imports'&&<ImportSources/>}
      {mode==='work'&&selected==='team'&&<TeamSources onImport={()=>setTab('imports')}/>}
    </div>
  </div>;
}

const liveStatusLabel:Record<LiveSourceStatus,string>={discovered:'Найден',active:'Работает',unavailable:'Недоступен',needs_adapter:'Нужен адаптер',rights_review:'Проверка прав',duplicate:'Дубликат',irrelevant:'Не подходит',disabled:'Отключён'};
function WorkerLine({data}:{data:LiveSourcesResponse}){
  const worker=data.worker,healthy=worker.state==='idle'||worker.state==='running';
  return <div className={`live-source-worker ${healthy?'':'is-warning'}`} role="status"><span><Radio size={15}/><strong>{healthy?'Сборщик работает':'Сборщик требует внимания'}</strong></span><p>{worker.message}</p><small>{worker.lastSuccessAt?`Последний успешный цикл: ${formatTimestamp(worker.lastSuccessAt)}`:'Успешный цикл ещё не зафиксирован'}{worker.lagSeconds!==null?` · задержка ${Math.round(worker.lagSeconds/60)} мин`:''} · очередь {number(worker.queueDepth+worker.analysisQueueDepth)}</small></div>;
}
function LiveSources(){
  const [data,setData]=useState<LiveSourcesResponse|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[query,setQuery]=useState(''),[status,setStatus]=useState<'all'|LiveSourceStatus>('all'),[reload,setReload]=useState(0);
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');readJson<LiveSourcesResponse>('/api/sources',controller.signal).then(setData).catch(()=>{if(!controller.signal.aborted)setError('Реестр live-источников пока недоступен.');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[reload]);
  const rows=(data?.sources||[]).filter(source=>(status==='all'||source.status===status)&&`${source.name} ${source.url} ${source.topics.join(' ')}`.toLocaleLowerCase('ru-RU').includes(query.toLocaleLowerCase('ru-RU')));
  const missing=(data?.coverage||[]).filter(item=>item.level==='missing');
  return <>
    <div className="source-toolbar"><p className="muted">Ленты, покрытие муниципалитетов и состояние локального сборщика.</p><div className="live-source-actions"><a className="secondary" href="/api/sources/export" download><Download size={14}/>CSV</a><button className="secondary" disabled={loading} onClick={()=>setReload(value=>value+1)}><RefreshCw size={14}/>Обновить</button></div></div>
    {error&&<p className="error" role="alert">{error}</p>}
    {loading&&!data?<Empty><Radio size={26}/><p>Читаем реестр источников…</p></Empty>:data&&<>
      <WorkerLine data={data}/>
      <div className="source-summary-grid live-source-summary"><Metric value={data.summary.active} label="подключённых источников"/><Metric value={data.summary.candidates} label="кандидатов"/><Metric value={data.summary.direct} label="территорий с прямым источником"/><Metric value={data.summary.missing} label="пробелов покрытия"/></div>
      <div className="live-source-filters"><label className="field">Поиск<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Название, адрес или тема"/></label><label className="field">Статус<select value={status} onChange={event=>setStatus(event.target.value as 'all'|LiveSourceStatus)}><option value="all">Все статусы</option>{Object.entries(liveStatusLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
      {missing.length>0&&<details className="source-details live-coverage-gaps"><summary><MapPin size={14}/>Пробелы покрытия · {missing.length}</summary><p className="caption">Нет прямого или наследуемого источника. Это пробел реестра, а не отсутствие событий.</p><ul>{missing.slice(0,80).map(item=><li key={item.territoryId}>{item.territoryName}</li>)}</ul>{missing.length>80&&<p className="caption">Показаны первые 80 территорий. Полный список есть в CSV.</p>}</details>}
      <section className="source-section"><h3>Реестр лент · {rows.length}</h3>{!rows.length?<Empty><p>По выбранным условиям источников нет.</p></Empty>:<div className="source-list live-source-list">{rows.map(source=><article className="source-card" key={source.id}>
        <div className="source-card-head"><strong>{source.name}</strong><span className={`source-status live-status-${source.status}`}>{source.error?"Нет связи":source.fetchAllowed&&!source.lastSuccessAt?"Ожидает проверки":liveStatusLabel[source.status]}</span></div>
        <p className="caption">{source.adapter.toUpperCase()} · {source.sourceKind==='community'?'сообщения жителей':source.sourceKind==='official'?'официальный':source.sourceKind==='media'?'СМИ':source.sourceKind}</p>
        <div className="live-source-rights"><span className={source.fetchAllowed?'ok':''}>Сбор</span><span className={source.aiAllowed?'ok':''}>Анализ</span><span className={source.displayAllowed?'ok':''}>Показ</span></div>
        <p>{source.rightsNote||'Условия использования не описаны.'}</p><p className="caption">Последняя публикация: {formatTimestamp(source.latestPublicationAt)}<br/>Последний успешный сбор: {formatTimestamp(source.lastSuccessAt)}</p>
        {source.error&&<p className="source-warning">{source.error}</p>}<Source url={source.provenanceUrl||source.url}>Карточка первоисточника</Source>
      </article>)}</div>}</section>
    </>}
  </>;
}

function PublicSources() {
  const [data,setData]=useState<{manifest:Manifest;titles:Record<string,string>}|null>(null);
  const [error,setError]=useState('');
  const [reload,setReload]=useState(0);
  const [loading,setLoading]=useState(true);
  const [refreshStatus,setRefreshStatus]=useState<PublicRefreshStatus|null>(null),[startingRefresh,setStartingRefresh]=useState(false),[refreshError,setRefreshError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    readJson<PublicRefreshStatus>('/api/sources/refresh',controller.signal).then(setRefreshStatus)
      .catch(()=>{if(!controller.signal.aborted)setRefreshError('Статус обновления пока недоступен. Сохранённые источники показаны ниже.');});
    return()=>controller.abort();
  },[]);
  useEffect(()=>{
    if(refreshStatus?.status!=='running')return;
    const controller=new AbortController();
    const interval=setInterval(()=>{
      readJson<PublicRefreshStatus>('/api/sources/refresh',controller.signal).then(status=>{
        setRefreshStatus(status);setRefreshError('');
        if(status.status!=='running')setReload(n=>n+1);
      }).catch(()=>{if(!controller.signal.aborted)setRefreshError('Не удалось получить новый статус. Проверка может продолжаться.');});
    },3000);
    return()=>{controller.abort();clearInterval(interval);};
  },[refreshStatus?.status]);
  async function refreshNews(){
    setStartingRefresh(true);setRefreshError('');
    try{
      const response=await fetch('/api/sources/refresh',{method:'POST'});
      if(!response.ok)throw new Error();
      setRefreshStatus(await response.json() as PublicRefreshStatus);
      setReload(n=>n+1);
    }catch{setRefreshError('Не удалось запустить проверку новостей. Повторите попытку позже.');}
    finally{setStartingRefresh(false);}
  }
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    Promise.all([readJson<Manifest>('/data/manifest.json',controller.signal),readJson<Signal[]>('/data/signals.json',controller.signal)])
      .then(([manifest,signals])=>setData({manifest,titles:Object.fromEntries(signals.map(s=>['news-'+s.id,s.title]))}))
      .catch(()=>{if(!controller.signal.aborted)setError('Не удалось прочитать сведения об источниках.');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[reload]);
  const coverage=data?.manifest.coverage||{};
  const buildings=object(coverage.buildings),footprints=object(buildings.building);
  const shapes=numeric(coverage.withGeometry),total=numeric(coverage.territoriesIncludingRegion);
  return <>
    <div className="source-toolbar"><p className="muted">Происхождение данных и границы их точности.</p><button className="secondary" disabled={startingRefresh||refreshStatus?.status==='running'} onClick={refreshNews}><RefreshCw size={15} aria-hidden="true"/>{startingRefresh||refreshStatus?.status==='running'?'Проверяем новости…':'Обновить новости'}</button></div>
    {refreshStatus&&<div className="source-notice" role="status"><p>{refreshStatus.message}</p>{refreshStatus.status==='running'?<progress aria-label="Проверка официальных лент"/>:<p className="caption">Последняя успешная загрузка ленты: {formatTimestamp(refreshStatus.lastSuccessAt)}{refreshStatus.status==='complete'&&<> · новых материалов: {number(refreshStatus.added)}</>}</p>}<p className="caption">Следующая проверка: {formatTimestamp(refreshStatus.nextRefreshAt)} · пока локальное приложение работает.</p></div>}
    {refreshError&&<p className="source-warning" role="status">{refreshError}</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {loading&&!data?<Empty><Database size={26}/><p>Читаем сведения об источниках…</p></Empty>:data&&<>
      <div className="source-summary-grid">
        <Metric value={numeric(coverage.municipalities)} label="муниципалитетов" detail={`ОКТМО · ${shortDate(String(coverage.officialRegistryAsOf||''))}`}/>
        <Metric value={shapes} label="границ сопоставлено" detail={total?`из ${number(total)} · регион и муниципалитеты`:undefined}/>
        <Metric value={numeric(footprints.count)} label="доступных контуров зданий"/>
        <Metric value={numeric(coverage.publicSignals)} label="публичных сигналов"/>
      </div>
      <section className="source-section source-notice"><h3>Как показана высота зданий</h3><p>Сначала используется высота из источника. Если её нет — оценка 3 м на этаж. Без этажности показан условный объём 8 м.</p><p className="caption">Оценка помогает читать городскую среду и не является измерением. Высота указана в источнике для {number(numeric(footprints.withKnownHeight))} зданий.</p></section>
      <section className="source-section"><h3>Проверенные источники</h3><p className="caption">Сборка данных: {formatTimestamp(data.manifest.generatedAt)}. Сохранённая публикация не подтверждает сегодняшнюю стадию проекта.</p>
        <div className="source-list">{data.manifest.sources.map(source=><article className="source-card" key={source.id}>
          <div className="source-card-head"><strong>{sourceNames[source.id]||data.titles[source.id]||'Открытый источник'}</strong><Status value={source.status} error={Boolean(source.error)}/></div>
          <p className="caption">Последняя успешная загрузка: {formatTimestamp(source.lastSuccessAt)}</p>
          {source.error&&<p className="source-warning">Источник временно не ответил. {source.lastSuccessAt?'Доступна сохранённая версия.':'Используется редакционно проверенный материал, если он доступен.'}{source.lastAttemptAt&&<> Проверка: {formatTimestamp(source.lastAttemptAt)}.</>}</p>}
          <Source url={source.url}>Открыть первоисточник</Source>
        </article>)}</div>
      </section>
      <details className="source-details"><summary>Что учитывать при работе с данными</summary><ul>{data.manifest.limitations.map((text,index)=><li key={index}>{text}</li>)}</ul></details>
    </>}
  </>;
}

function ImportSources() {
  const [data,setData]=useState<ImportStatus|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [reload,setReload]=useState(0),[loading,setLoading]=useState(true),[submitting,setSubmitting]=useState<string|null>(null);
  const [uploadProgress,setUploadProgress]=useState<number|null>(null);
  const inputRef=useRef<HTMLInputElement>(null),xhrRef=useRef<XMLHttpRequest|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    readJson<ImportStatus>('/api/imports?mode=work',controller.signal).then(setData)
      .catch(()=>{if(!controller.signal.aborted)setError('Не удалось прочитать статус импорта.');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[reload]);
  const running=Boolean(data?.jobs.some(job=>job.status==='running')||data?.imports.some(item=>item.status==='running'));
  useEffect(()=>{
    if(!running)return;
    const interval=setInterval(()=>setReload(n=>n+1),2500);return()=>clearInterval(interval);
  },[running]);
  useEffect(()=>()=>xhrRef.current?.abort(),[]);
  const busy=Boolean(submitting)||running;
  async function importKnown(fileName:string) {
    if(busy)return;
    setSubmitting(fileName);setError('');setNotice('');
    try {
      const response=await fetch('/api/imports?mode=work',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileName})});
      if(!response.ok)throw new Error();
      setNotice('Импорт запущен. Статус обновляется автоматически.');setReload(n=>n+1);
    }catch{setError('Не удалось начать импорт. Проверьте наличие файла и дождитесь завершения предыдущей обработки.');}
    finally{setSubmitting(null);}
  }
  function upload(file:File|undefined) {
    if(!file||busy)return;
    if(!file.name.toLowerCase().endsWith('.xlsx')){setError('Выберите файл XLSX.');return;}
    if(file.size>512*1024*1024){setError('Файл должен быть не больше 512 МБ.');return;}
    setSubmitting(file.name);setUploadProgress(0);setError('');setNotice('');
    const xhr=new XMLHttpRequest();xhrRef.current=xhr;
    xhr.open('POST','/api/imports?mode=work');xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('x-file-name',encodeURIComponent(file.name));
    xhr.upload.onprogress=event=>{if(event.lengthComputable)setUploadProgress(Math.round(event.loaded/event.total*100));};
    xhr.onload=()=>{
      if(xhr.status>=200&&xhr.status<300){setNotice('Файл принят в обработку. Статус обновляется автоматически.');setReload(n=>n+1);}
      else setError('Не удалось обработать файл. Проверьте формат, название и заголовки выгрузки.');
      setSubmitting(null);setUploadProgress(null);xhrRef.current=null;
    };
    xhr.onerror=()=>{setError('Передача файла прервалась. Выберите файл ещё раз.');setSubmitting(null);setUploadProgress(null);xhrRef.current=null;};
    xhr.send(file);
  }
  const latestByName=new Map<string,ImportItem>();
  for(const item of data?.imports||[])if(!latestByName.has(item.file_name))latestByName.set(item.file_name,item);
  return <>
    <section className="source-section source-notice"><ShieldCheck size={19} aria-hidden="true"/><div><h3>Закрытые данные остаются на этом компьютере</h3><p>Импортируйте подготовленную выгрузку или выберите XLSX. Публичная презентация не использует эти записи.</p></div></section>
    <div className="source-toolbar"><button className="primary upload-control" disabled={busy} onClick={()=>inputRef.current?.click()}><Upload size={16} aria-hidden="true"/>Выбрать XLSX</button><button className="secondary" onClick={()=>{setError('');setReload(n=>n+1);}}><RefreshCw size={15} aria-hidden="true"/>Обновить статус</button>
      <input ref={inputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden aria-label="Файл для импорта" onChange={event=>{upload(event.target.files?.[0]);event.currentTarget.value='';}}/>
    </div>
    {uploadProgress!==null&&<div className="import-progress" role="status"><p>Передаём «{submitting}» · {uploadProgress}%</p><progress max={100} value={uploadProgress} aria-label="Передача файла"/></div>}
    {notice&&<p className="source-notice" role="status">{notice}</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {loading&&!data?<Empty><FileSpreadsheet size={26}/><p>Читаем список выгрузок…</p></Empty>:data&&<>
      {data.jobs.filter(job=>job.status==='running').map(job=><div className="import-progress" role="status" key={job.id}><strong>{job.file_name}</strong><p>Обрабатываем строки. Начало: {formatTimestamp(job.started_at)}.</p><progress aria-label="Обработка выгрузки"/></div>)}
      <h3 className="section-title">Подготовленные выгрузки</h3>
      <div className="source-list">{data.sources.map(source=>{
        const item=latestByName.get(source.name);
        return <article className="source-card" key={source.name}><div className="source-card-head"><strong>{source.name}</strong>{item&&<Status value={item.status}/>}</div>
          <p className="caption">{item?`${number(item.rows_kept)} записей принято · ${formatTimestamp(item.imported_at)}`:source.available?'Файл найден в папке «Загрузки»':'Файл не найден в папке «Загрузки»'}</p>
          <button className="secondary" disabled={!source.available||busy} onClick={()=>importKnown(source.name)}><FileSpreadsheet size={15} aria-hidden="true"/>{submitting===source.name?'Запускаем…':item?.status==='complete'?'Обновить импорт':'Импортировать'}</button>
        </article>;
      })}</div>
      <h3 className="section-title">История и качество данных</h3>
      {!data.imports.length?<Empty><p>После импорта здесь появится отчёт о принятых строках и замечаниях.</p></Empty>:data.imports.map(item=><ImportReport key={item.id} item={item}/>)}
      {data.jobs.filter(job=>job.status==='error').slice(0,3).map(job=><p className="source-warning" key={job.id}><AlertCircle size={15} aria-hidden="true"/>«{job.file_name}» не обработан. Проверьте формат и повторите импорт.</p>)}
    </>}
  </>;
}

function ImportReport({item}:{item:ImportItem}) {
  const issues=Object.entries(item.report?.quality||{}).filter(([,value])=>typeof value==='number'&&value>0);
  const counters=Object.entries(item.report?.counters||{}).filter(([key,value])=>qualityNames[key]&&typeof value==='number');
  const known=issues.filter(([key])=>qualityNames[key]);
  const other=issues.filter(([key])=>!qualityNames[key]).reduce((sum,[,value])=>sum+Number(value),0);
  return <details className="source-details"><summary><span><strong>{item.file_name}</strong><small>{kindNames[item.kind]||'Выгрузка'} · {number(item.rows_kept)} записей</small></span><Status value={item.status}/></summary>
    {item.is_current&&<p className="caption">Эта версия используется в текущих расчётах.</p>}
    <dl className="source-definition-list"><div><dt>Период</dt><dd>{periodLabel(item.period)}</dd></div><div><dt>Строк прочитано</dt><dd>{number(item.rows_read)}</dd></div><div><dt>Записей принято</dt><dd>{number(item.rows_kept)}</dd></div><div><dt>Последняя обработка</dt><dd>{formatTimestamp(item.imported_at)}</dd></div></dl>
    {item.status==='running'&&<p className="caption" role="status">Обработка продолжается; показатели ещё изменятся.</p>}
    {item.error&&<p className="error">Файл не обработан полностью. Проверьте его структуру и повторите импорт.</p>}
    {item.report.questions&&<><h4>Ответы КМ</h4><p className="caption">1 — плохо · 2 — нормально · 3 — отлично. Число ответивших рассчитано отдельно по каждому вопросу.</p><div className="source-table-wrap"><table><thead><tr><th>Вопрос</th><th>Ответили</th><th>Плохо</th><th>Нормально</th><th>Отлично</th></tr></thead><tbody>{item.report.questions.map(q=><tr key={q.question}><th>{q.question}</th><td>{q.respondents}</td><td>{q.counts['1']||0}</td><td>{q.counts['2']||0}</td><td>{q.counts['3']||0}</td></tr>)}</tbody></table></div></>}
    {item.report.aggregation&&<p className="caption">Самостоятельный срез. Пересекающиеся своды и предложения не прибавляются к текущему портфелю.</p>}
    <h4>Проверки качества</h4>
    {!issues.length?<p className="caption">{item.status==='complete'?'Замечаний при обработке не зарегистрировано.':'Окончательный отчёт появится после завершения обработки.'}</p>:<ul>{known.map(([key,value])=><li key={key}>{qualityNames[key]}: {number(Number(value))}</li>)}{other>0&&<li>Другие значения требуют проверки: {number(other)}</li>}</ul>}
    {counters.length>0&&<dl className="source-definition-list">{counters.map(([key,value])=><div key={key}><dt>{qualityNames[key]}</dt><dd>{number(Number(value))}</dd></div>)}</dl>}
  </details>;
}

function TeamSources({onImport}:{onImport:()=>void}) {
  const [data,setData]=useState<OperationsPayload|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[query,setQuery]=useState('');
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    readJson<OperationsPayload>('/api/operations?mode=work',controller.signal).then(setData)
      .catch(()=>{if(!controller.signal.aborted)setError('Не удалось прочитать данные команды.');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[reload]);
  const clusterRows=(data?.clusters.rows||[]).filter(row=>`${row.gosb} ${row.name} ${row.tb}`.toLocaleLowerCase('ru-RU').includes(query.toLocaleLowerCase('ru-RU')));
  const comparedNames=data?.staff.comparison?{
    left:data.staff.versions.find(version=>version.id===data.staff.comparison?.leftVersion)?.fileName||'первая версия',
    right:data.staff.versions.find(version=>version.id===data.staff.comparison?.rightVersion)?.fileName||'вторая версия',
  }:null;
  return <>
    <div className="source-toolbar"><p className="muted">Команда, кластеры и отдельные срезы источников.</p><button className="secondary" disabled={loading} onClick={()=>setReload(n=>n+1)}><RefreshCw size={15} aria-hidden="true"/>Обновить</button></div>
    {error&&<p className="error" role="alert">{error}</p>}
    {loading&&!data?<Empty><Users size={26}/><p>Читаем данные команды…</p></Empty>:data&&<>
      <p className="source-notice">{data.scope.label} Эти показатели не распределяются по муниципалитетам автоматически.</p>
      <section className="source-section"><h3>Состав команды</h3>
        {!data.staff.versions.length?<Empty><p>Выгрузка команды ещё не импортирована.</p><button className="text-button" onClick={onImport}>Перейти к импорту<ChevronRight size={15}/></button></Empty>:<>
          <p className="caption">Каждая выгрузка показана отдельно. Версии не складываются.</p>
          {data.staff.versions.map(version=><details className="source-details" key={version.id}><summary><span><strong>{version.fileName}</strong><small>{number(version.uniqueEmployees)} сотрудников · {number(version.count)} строк</small></span></summary>
            <p className="caption">{periodLabel(version.period)} · В пилоте: {number(version.pilotCount)} строк</p>
            <dl className="source-definition-list">{version.roles.map(role=><div key={role.name}><dt>{role.name||'Роль не указана'}</dt><dd>{number(role.count)}</dd></div>)}</dl>
          </details>)}
          {data.staff.comparison&&<div className="source-card"><h4>Сопоставление версий</h4><p className="caption">{comparedNames?.left} и {comparedNames?.right}</p><div className="source-summary-grid"><Metric value={data.staff.comparison.common} label="общих сотрудников"/><Metric value={data.staff.comparison.onlyLeft} label={`только в ${comparedNames?.left}`}/><Metric value={data.staff.comparison.onlyRight} label={`только в ${comparedNames?.right}`}/><Metric value={data.staff.comparison.changedEmployees} label="с изменениями"/></div>
            <dl className="source-definition-list">{data.staff.comparison.changesByField.map(field=><div key={field.field}><dt>{field.label}</dt><dd>{number(field.count)}</dd></div>)}</dl></div>}
        </>}
      </section>
      <section className="source-section"><h3>Кластеры ГОСБ</h3><label className="field">Поиск ГОСБ<input type="search" placeholder="Номер или название" value={query} onChange={event=>setQuery(event.target.value)}/></label>
        {data.clusters.unresolvedCount>0&&<p className="caption">Требуют уточнения: {number(data.clusters.unresolvedCount)} записей.</p>}
        {!clusterRows.length?<Empty><p>{query?'По этому запросу ничего не найдено.':'Выгрузка кластеров ещё не импортирована.'}</p></Empty>:<div className="source-table-wrap"><table className="source-table"><thead><tr><th>ГОСБ</th><th>Название</th><th>2025</th><th>2026</th></tr></thead><tbody>{clusterRows.slice(0,100).map((row,index)=><tr key={`${row.gosb}-${index}`}><td>{row.unresolved?'Нужно уточнить':row.gosb||'Не указан'}</td><td>{row.name}<small>{row.tb}</small>{row.unresolved&&<small>Нужно уточнить сопоставление</small>}</td><td>{number(row.cluster2025)}</td><td>{number(row.cluster2026)}</td></tr>)}</tbody></table></div>}
        {clusterRows.length>100&&<p className="caption">Показаны первые 100 записей. Уточните поиск.</p>}
      </section>
      <section className="source-section"><h3>Сводные обращения к банкам</h3><p className="caption">Листы представляют отдельные срезы. Их итоги не складываются; неизвестный год не восстанавливается автоматически.</p>
        {!data.bankSummary.views.length?<Empty><p>Сводная выгрузка ещё не импортирована.</p></Empty>:data.bankSummary.views.map((view,index)=><details className="source-details" key={`${view.sourceId}-${view.sheet}-${index}`}><summary><span><strong>{view.sheet}</strong><small>{view.year??'Год не указан'} · {number(view.rows.length)} строк</small></span></summary>
          <dl className="source-definition-list">{Object.entries(view.filters).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value||'Не указан'}</dd></div>)}</dl>
          <div className="source-table-wrap"><table className="source-table"><thead><tr><th>Банк</th>{view.columns.map(column=><th key={column}>{column}</th>)}</tr></thead><tbody>{view.rows.map((row,rowIndex)=><tr key={`${row.bank}-${rowIndex}`} className={row.isTotal?'total':''}><th scope="row">{row.bank}</th>{view.columns.map(column=><td key={column}>{number(row.values[column])}</td>)}</tr>)}</tbody></table></div>
        </details>)}
      </section>
      {data.limits.length>0&&<details className="source-details"><summary>Особенности этих выгрузок</summary><ul>{data.limits.map((limit,index)=><li key={index}>{limit}</li>)}</ul></details>}
    </>}
  </>;
}
