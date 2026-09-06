'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Download, MapPin, RefreshCw, Search } from 'lucide-react';
import ClientAddressImport from './ClientAddressImport';
import type { PortfolioRow, PortfolioSummary } from '@/lib/portfolio-types';
import type { ClientMapPoint } from '@/lib/client-map-types';
import styles from './ClientPortfolio.module.css';

type Payload = { items: PortfolioRow[]; total: number; offset: number; summary: PortfolioSummary; all: PortfolioSummary; offersAvailable: boolean; sourceLabel: string; notes: string[]; filters: { products: string[]; stages: string[] } };
type Enrichment = { configured: boolean; pending: number; orgIds: string[]; individual: number; message: string };
type Props = { snapshot: string; territoryId: string; territoryName: string; refresh: number; onOpen: (id: string) => void; onPlan: (id: string) => void; onMap: (point: ClientMapPoint) => void; onImported: () => void; onFilter: (query: string) => void; onSources: () => void; onSignal: (id: string) => void };
const money = (value: number | null) => value === null ? 'Нет данных' : value.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
const rules = [['stalled','Длительная стадия'],['contact','Контакт по предложениям'],['payroll','Рост зарплатных выплат'],['signal','Публичный повод по ИНН'],['income','Нет ожидаемого дохода'],['address','Нужен адрес'],['duplicates','Конфликт ID предложений'],['offers','Предложения из среза']];

/** The list is paginated, the synchronized map is not. No financial values enter map sources. */
export default function ClientPortfolio({ snapshot, territoryId, territoryName, refresh, onOpen, onPlan, onMap, onImported, onFilter, onSources, onSignal }: Props) {
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [location, setLocation] = useState(''), [product, setProduct] = useState(''), [stage, setStage] = useState(''), [action, setAction] = useState(''), [sort, setSort] = useState('priority'), [all, setAll] = useState(false), [local, setLocal] = useState(false);
  const [offset, setOffset] = useState(0), [version, setVersion] = useState(0), [data, setData] = useState<Payload | null>(null), [error, setError] = useState('');
  const [enrichment, setEnrichment] = useState<Enrichment | null>(null), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => () => { mutation.current?.abort(); mutation.current = null; }, []);
  const filter = useMemo(() => {
    const p = new URLSearchParams({ scope: all ? 'all' : 'deals', q: search, location, product, stage, action, sort });
    if (local) p.set('territory', territoryId);
    return p.toString();
  }, [all, search, location, product, stage, action, sort, local, territoryId]);
  useEffect(() => { setOffset(0); onFilter(filter); }, [filter, snapshot, onFilter]);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError('');
    fetch(`/api/portfolio?mode=work&snapshot=${encodeURIComponent(snapshot)}&${filter}&offset=${offset}`, { signal: controller.signal, cache: 'no-store' }).then(async response => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'Портфель недоступен.'); if (!controller.signal.aborted) setData(payload); }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Не удалось загрузить портфель.'); });
    return () => controller.abort();
  }, [filter, offset, snapshot, refresh, version]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/client-enrichment?mode=work', { signal: controller.signal, cache: 'no-store' }).then(async r => { if (!r.ok) return; const body = await r.json(); if (!controller.signal.aborted) setEnrichment(body); }).catch(() => {});
    return () => controller.abort();
  }, [refresh, version]);
  function updated() { setVersion(v => v + 1); onImported(); }
  async function matchAddresses(external: boolean) {
    if (mutation.current || external && (!consent || !enrichment?.configured)) return;
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setMessage('');
    try {
      if (!external) {
        const r = await fetch('/api/client-enrichment?mode=work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'local' }), signal: controller.signal });
        const body = await r.json(); if (!r.ok) throw new Error(body.error || 'Справочник не сопоставлен.');
        if (!controller.signal.aborted) setMessage('Локальный справочник сопоставлен по точному ИНН. Ручные адреса сохранены.');
      } else {
        let done = 0, located = 0;
        const ids = enrichment!.orgIds;
        for (let i = 0; i < ids.length && !controller.signal.aborted; i += 5) {
          const r = await fetch('/api/client-enrichment?mode=work', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'external', consent: true, orgIds: ids.slice(i, i + 5) }), signal: controller.signal });
          const body = await r.json(); if (!r.ok) throw new Error(body.error || 'Адреса не сопоставлены.');
          for (const result of body.results) { done++; if (result.status === 'located') located++; if (result.status === 'error') throw new Error(result.message); }
          if (!controller.signal.aborted) setMessage(`Проверено ${done} из ${ids.length}. Новых точных адресов: ${located}. Остальные остаются для проверки.`);
        }
      }
    } catch (e) { if (!controller.signal.aborted) setMessage(e instanceof Error ? e.message : 'Не удалось сопоставить адреса.'); }
    finally { if (mutation.current === controller) { mutation.current = null; setBusy(false); updated(); } }
  }
  const exportUrl = `/api/portfolio?mode=work&snapshot=${encodeURIComponent(snapshot)}&${filter}&export=missing`;
  return <section className={styles.root} aria-label="Клиентский портфель и возможности">
    <div className={styles.heading}><div><h3>Клиенты и возможности</h3><p>Сделки → адрес → следующий контакт</p></div><button title="Обновить портфель" aria-label="Обновить портфель" onClick={() => updated()}><RefreshCw size={17}/></button></div>
    <label className={styles.search}><Search size={17}/><input aria-label="Поиск клиентов по ИНН, названию, ГОСБ или КМ" placeholder="ИНН, клиент, ГОСБ или КМ" value={query} maxLength={200} onChange={e => setQuery(e.target.value)}/></label>
    <div className={styles.filters}>
      <label>География<select aria-label="География клиентов" value={location} onChange={e => setLocation(e.target.value)}><option value="">Все адреса</option><option value="located">С точкой на карте</option><option value="missing">Требуют адреса</option></select></label>
      <label>Приоритет<select aria-label="Возможности клиентов" value={action} onChange={e => setAction(e.target.value)}><option value="">Все возможности</option>{rules.map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label>Продукт<select aria-label="Продукт клиента" value={product} onChange={e => setProduct(e.target.value)}><option value="">Все продукты</option>{(data?.filters.products || (product ? [product] : [])).map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Стадия<select aria-label="Стадия предложения" value={stage} onChange={e => setStage(e.target.value)}><option value="">Все стадии</option>{(data?.filters.stages || (stage ? [stage] : [])).map(p => <option key={p}>{p}</option>)}</select></label>
    </div>
    <div className={styles.checks}><label><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)}/>Весь справочник, включая без сделок</label><label><input type="checkbox" checked={local} onChange={e => setLocal(e.target.checked)}/>Только {territoryName}</label></div>
    <p className={styles.caption}>Фильтры действуют и на список, и на карту. Все подтверждённые точки, а не только текущая страница. Без адреса не означает «нет клиента». В этом разделе банковские и событийные маркеры временно скрыты, чтобы не перекрывать клиентов; они вернутся при смене раздела.</p>
    {error && <div role="alert" className={styles.notice}>{error}<button onClick={onSources}>Открыть источники</button><button onClick={() => setVersion(v => v + 1)}>Повторить</button></div>}
    {!error && !data && <p role="status" className={styles.caption}>Сопоставляем портфель и географию…</p>}
    {data && <>
      <div className={styles.metrics}><div><strong>{data.total.toLocaleString('ru-RU')}</strong><span>Записей в выборке</span></div><div><strong>{data.summary.located.toLocaleString('ru-RU')}</strong><span>На карте</span></div><div><strong>{data.summary.unlocated.toLocaleString('ru-RU')}</strong><span>Без точного адреса</span></div><div><strong>{money(data.summary.income)}</strong><span>Известный ожидаемый доход</span></div></div>
      <p className={styles.caption}>{data.sourceLabel}. {data.summary.uniqueInns} уникальных ИНН. ОД не указан у {data.summary.missingIncome} предложений.</p>
      {!data.offersAvailable && <aside className={styles.notice}>Завершённый источник выбранного среза не подключён. <button onClick={onSources}>Загрузить сделки</button></aside>}
      <details className={styles.addresses}><summary>Разместить клиентов · адреса и проверка</summary><p>Сначала используются подтверждённые офисы/места встреч и юридические адреса по ИНН. Юридический адрес не доказывает место деятельности.</p>
        <div className={styles.rowButtons}><button disabled={busy} onClick={() => matchAddresses(false)}>Сопоставить локальный справочник</button><a href={exportUrl} download><Download size={15}/>Выгрузить без адреса</a></div>
        <ClientAddressImport onImported={updated}/>
        <details><summary>Поиск юридических адресов по ИНН</summary><p className={styles.caption}>{enrichment?.message || 'Внешний поиск выключен. Передача ИНН возможна только после отдельного согласия.'}</p>
          {!enrichment?.configured ? <p className={styles.notice}>Для разрешённого внешнего поиска добавьте <code>ATLAS_DADATA_TOKEN</code> в локальный <code>.env</code> и перезапустите сервер. Ключ не нужен для импорта адресов и ручной проверки. Не публикуйте его в GitHub.</p> : <><p>Без адреса в текущем портфеле: {enrichment.pending}; ИП с 12-значным ИНН: {enrichment.individual}. Для ИП укажите рабочий адрес вручную.</p><label className={styles.consent}><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)}/>Разрешаю отправить ИНН этих клиентов в DaData. Передача разрешена правилами моей организации.</label><button disabled={busy || !consent || !enrichment.pending} onClick={() => matchAddresses(true)}>Найти адреса клиентов текущего портфеля</button></>}
        </details>
        {busy && <button onClick={() => { mutation.current?.abort(); setMessage('Остановлено. Уже сохранённые адреса не отменяются.'); }}>Остановить сопоставление</button>}
        {message && <p role="status" className={styles.notice}>{message}</p>}
      </details>
      <div className={styles.sort}><span>{data.total ? `${offset + 1}–${Math.min(offset + 40, data.total)} из ${data.total}` : 'Нет совпадений'}</span><select aria-label="Сортировка клиентов" value={sort} onChange={e => setSort(e.target.value)}><option value="priority">По следующим действиям</option><option value="income">По ожидаемому доходу</option><option value="name">По названию</option></select></div>
      <div className={styles.list}>{data.items.map(row => <article key={row.id} data-client-id={row.id} className={styles.card}>
        <button className={styles.clientName} onClick={() => onOpen(row.id)}><strong>{row.name}</strong><ArrowUpRight size={16}/></button><small>ИНН {row.inn || 'не указан'} · ГОСБ {row.gosb || 'не указан'}</small>
        <div className={styles.facts}><span>{row.offers} предложений</span><b>{money(row.income)}</b></div>
        <p className={styles.caption}>{row.point ? `${row.point.addressKind === 'legal' ? 'Юридический адрес' : row.point.addressKind === 'meeting' ? 'Место встречи' : 'Офис'}: ${row.point.address}` : row.locationReason}</p>
        {row.managers.length > 0 && <p className={styles.caption}>КМ из среза: {row.managers.join(', ')}</p>}
        <details><summary>{row.actions.length ? `Следующие действия · ${row.actions.length}` : 'Данных для следующего действия недостаточно'}</summary>{row.actions.map((item,i) => <div className={styles.action} key={item.rule + i}><b>{item.title}</b>{item.facts.map(f => <p key={f}>{f}</p>)}<p className={styles.next}>{item.nextStep}</p>{item.signalId && <button onClick={() => onSignal(item.signalId!)}>Открыть сигнал</button>}</div>)}</details>
        <div className={styles.rowButtons}>{row.point && <button onClick={() => onMap(row.point!)}><MapPin size={14}/>На карте</button>}<button onClick={() => onPlan(row.id)}>{row.point ? 'Адрес и встреча' : 'Указать адрес / встречу'}</button></div>
      </article>)}</div>
      {!data.items.length && <p className={styles.notice}>Нет организаций по этим условиям. Проверьте источник или ослабьте фильтры; отсутствие точек не означает отсутствие клиентов.</p>}
      <nav className={styles.pages} aria-label="Страницы клиентов"><button disabled={offset === 0} onClick={() => setOffset(v => Math.max(0, v - 40))}><ChevronLeft size={16}/>Назад</button><span>{Math.floor(offset / 40) + 1} / {Math.max(1, Math.ceil(data.total / 40))}</span><button disabled={offset + 40 >= data.total} onClick={() => setOffset(v => v + 40)}>Далее<ChevronRight size={16}/></button></nav>
      <details className={styles.method}><summary>Что считается возможностью</summary>{data.notes.map(n => <p key={n}>{n}</p>)}<p>Возможности — объяснимые поводы для проверки, а не одобрение продукта или оценка кредитоспособности. Ни одна жалоба района не приписывается клиенту по соседству. Публичный повод связывается только по точному ИНН.</p></details>
    </>}
  </section>;
}
