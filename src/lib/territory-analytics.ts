import { getTerritories, matchMunicipality, publicFile } from './atlas-data';
import { all, db, hasTable, LocalDataUnavailable, safeJson } from './db';
import { currentSourceId, canonicalSourceName } from './source-status';
import { liveSignalSnapshot, liveSources } from './live-store';
import { bankKey, territoryPriorities } from './territory-priorities';
import { loadClientPortfolio, portfolioActions, summarizePortfolio } from './client-portfolio';
import { isoDay, safeSourceUrl, territoryIndex } from './territory-scope';
import type { BankOffice, Mode, Signal, Territory } from './types';
import type { PortfolioData, PortfolioRow } from './portfolio-types';

export type ComplaintGroup = { municipality: string; settlement: string | null; topic: string; status: string; createdAt: string | null; closedAt: string | null; response: string | null; count: number; scopes?: string[] };
export function complaintState(row: Pick<ComplaintGroup, 'status' | 'closedAt' | 'response'>): 'closed' | 'progress' | 'open' | 'unknown' {
  const s = String(row.status || '').trim().toLocaleLowerCase('ru-RU');
  if (isoDay(row.closedAt) || ['closed', 'resolved', 'закрыто', 'решено'].includes(s)) return 'closed';
  if (['in_progress', 'в работе', 'принято в работу'].includes(s) || /приня[тл][\s\S]*в работу/i.test(row.response || '')) return 'progress';
  if (['open', 'reported', 'accepted', 'открыто', 'зарегистрировано'].includes(s)) return 'open';
  return 'unknown';
}
export function summarizeComplaints(rows: readonly ComplaintGroup[]) {
  let total = 0, open = 0, closed = 0, inProgress = 0, unknown = 0, unknownDates = 0;
  const topics = new Map<string, { name: string; total: number; open: number }>(), months = new Map<string, number>(), dates: string[] = [];
  for (const row of rows) {
    const n = Number.isFinite(row.count) ? Math.max(0, Math.trunc(row.count)) : 0, status = complaintState(row), day = isoDay(row.createdAt); total += n;
    if (status === 'closed') closed += n; else if (status === 'unknown') unknown += n; else { open += n; if (status === 'progress') inProgress += n; }
    if (day) { dates.push(day); const month = day.slice(0, 7); months.set(month, (months.get(month) || 0) + n); } else unknownDates += n;
    const topic = row.topic || 'Тема не указана', t = topics.get(topic) || { name: topic, total: 0, open: 0 };
    t.total += n; if (status === 'open' || status === 'progress') t.open += n; topics.set(topic, t);
  }
  dates.sort();
  return { total, open, closed, inProgress, unknown, unknownDates, index: open + closed ? 100 * open / (open + closed) : null,
    firstAt: dates[0] || null, lastAt: dates.at(-1) || null, topics: [...topics.values()].sort((a, b) => b.open - a.open || b.total - a.total),
    months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count })) };
}
const fold = (s: string) => s.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/городское поселение|сельское поселение|муниципальный округ|город|поселок|село|деревня/g, '').replace(/[^\p{L}\p{N}]/gu, '');
function complaintGroups(territories: Territory[]) {
  const tracked = hasTable('imports'), sourceId = currentSourceId('incidents');
  if (!hasTable('incidents') || tracked && !sourceId) return null;
  const cols = new Set(all<{name: string}>('PRAGMA table_info(incidents)').map(c => c.name));
  const optional = (field: string) => cols.has(field) ? field : 'NULL';
  const response = cols.has('data_json') ? "CASE WHEN json_valid(data_json) THEN json_extract(data_json,'$.first_response') ELSE NULL END" : 'NULL';
  const rows = all<ComplaintGroup>(`SELECT municipality,settlement,topic_group topic,status,${optional('created_at')} createdAt,${optional('closed_at')} closedAt,${response} response,COUNT(*) count FROM incidents ${tracked ? 'WHERE source_id=?' : ''} GROUP BY municipality,settlement,topic_group,status,createdAt,closedAt,response`, ...(tracked ? [sourceId] : []));
  const index = territoryIndex(territories), matches = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.municipality + '|' + row.settlement;
    if (!matches.has(key)) {
      const parent = matchMunicipality(String(row.municipality || ''), territories);
      const children = parent && row.settlement ? territories.filter(t => t.parentId === parent.id && fold(t.name) === fold(row.settlement!)) : [];
      matches.set(key, children.length === 1 ? index.chain(children[0].id) : parent ? index.chain(parent.id) : ['RU-TA']);
    }
    row.scopes = matches.get(key);
  }
  const src = sourceId ? all<{file_name: string; imported_at: string; period: string}>('SELECT file_name,imported_at,period FROM imports WHERE id=?', sourceId)[0] : null;
  return { rows, source: src ? canonicalSourceName(src.file_name) : 'Локальные обращения без версии источника', importedAt: src?.imported_at || null };
}

/** Consume every source page. A moving cursor is retried, never presented as a complete snapshot. */
export function analyticsSignals(regionId = 'RU-TA'): Signal[] {
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows: Signal[] = [], first = liveSignalSnapshot({ regionId, archive: true, limit: 1000 });
    let page = first, stable = true;
    for (;;) {
      rows.push(...page.signals);
      if (!page.hasMore) break;
      if (!page.signals.length) { stable = false; break; }
      page = liveSignalSnapshot({ regionId, archive: true, limit: 1000, offset: rows.length });
      if (page.cursor !== first.cursor || page.total !== first.total) { stable = false; break; }
    }
    if (stable) return [...new Map(rows.filter(s => s.visibility === 'public').map(s => [s.id, s])).values()];
  }
  throw new Error('Лента обновилась во время расчёта. Повторите обновление аналитики.');
}
export function recentAnalyticsSignals(signals: readonly Signal[], days: number, asOf: string) {
  const today = isoDay(asOf);
  if (!today || !Number.isInteger(days) || days < 1) return [];
  const first = new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  return signals.filter(s => { const day = isoDay(s.publishedAt); return day && day >= first && day <= today && safeSourceUrl(s.sourceUrl); });
}
const brief = ({ geometry: _geometry, ...territory }: Territory) => territory;
export function territoryAnalytics(mode: Mode, territoryId = 'RU-TA', days = 45, snapshot = 'current', asOf = new Date().toISOString()) {
  const territories = getTerritories(), index = territoryIndex(territories), selected = index.byId.get(territoryId);
  if (!selected) throw new RangeError('Территория не входит в подключённый справочник аналитики.');
  const rootId = index.chain(territoryId).at(-1) || 'RU-TA';
  const signals = recentAnalyticsSignals(analyticsSignals(rootId), days, asOf);
  const scoped = (s: Signal, id: string) => (s.territoryId && index.byId.has(s.territoryId) ? index.chain(s.territoryId) : s.precision !== 'territory' ? index.point(s.coordinates) : []).includes(id);
  const currentSignals = signals.filter(s => scoped(s, territoryId));
  const offices = publicFile<BankOffice[]>('bank-offices.json', []);
  const priorities = territoryPriorities(signals, offices, territories, { asOf, maxSignalAgeDays: days });
  const priority = priorities.find(p => p.id === territoryId)!;
  const banks = [...new Set(offices.map(o => bankKey(o.bank)))].map(bank => {
    const p = territoryPriorities([], offices.filter(o => bankKey(o.bank) === bank), territories, { asOf }).find(p => p.id === territoryId)!;
    return { bank, count: p.numbers.verifiedLocations, stale: p.numbers.staleBankRecords, missing: p.numbers.unlocatedBankRecords };
  }).filter(b => b.count || b.stale || b.missing).sort((a, b) => b.count - a.count);
  let complaints: ReturnType<typeof complaintGroups> = null, portfolio: PortfolioData | null = null, privateError: string | null = null;
  if (mode === 'work') {
    try { db().transaction(() => { complaints = complaintGroups(territories); portfolio = loadClientPortfolio(snapshot, territories, asOf); })(); }
    catch (e) { if (!(e instanceof LocalDataUnavailable)) throw e; privateError = e.message; }
  }
  // Assignment inside a synchronous transaction is deliberate; nothing private is read in public mode.
  const complaintData = complaints as ReturnType<typeof complaintGroups>, privatePortfolio = portfolio as PortfolioData | null;
  const complaintStats = (id: string) => complaintData ? summarizeComplaints(complaintData.rows.filter(r => r.scopes?.includes(id))) : null;
  const scopeRows = (id: string) => privatePortfolio?.rows.filter(r => r.scopes.includes(id)) || [];
  const selectedRows = scopeRows(territoryId);
  for (const row of selectedRows) row.actions = portfolioActions(row, privatePortfolio!.sourceLabel, snapshot, signals);
  const children = territories.filter(t => t.parentId === territoryId).map(t => {
    const p = priorities.find(row => row.id === t.id)!;
    return { territory: brief(t), complaints: complaintStats(t.id), signals: signals.filter(s => scoped(s, t.id)).length,
      priority: p.score, banks: p.numbers.verifiedLocations, sber: p.numbers.verifiedSberLocations,
      portfolio: privatePortfolio ? summarizePortfolio(scopeRows(t.id)) : null };
  }).sort((a, b) => (b.complaints?.open || 0) - (a.complaints?.open || 0) || b.signals - a.signals || a.territory.name.localeCompare(b.territory.name, 'ru'));
  const sourceCoverage = liveSources();
  const signalStage = (s: Signal) => s.live?.state || (s.lifecycle?.status === 'completed' ? 'resolved' : s.lifecycle?.status === 'under_construction' ? 'in_progress' : s.lifecycle?.status === 'planned' ? 'planned' : 'reported');
  return { mode, asOf, days, snapshot, territory: brief(selected), ancestors: index.chain(territoryId).slice(1).map(id => brief(index.byId.get(id)!)),
    territories: territories.map(brief), children, privateError,
    complaints: complaintData ? { ...complaintStats(territoryId)!, source: complaintData.source, importedAt: complaintData.importedAt,
      unassignedWithinScope: complaintData.rows.filter(r => r.scopes?.includes(territoryId) && !children.some(c => r.scopes?.includes(c.territory.id))).reduce((n, r) => n + r.count, 0) } : null,
    signals: { count: currentSignals.length, problems: currentSignals.filter(s => !['planned', 'in_progress', 'paused', 'resolved'].includes(signalStage(s))).length,
      work: currentSignals.filter(s => ['planned', 'in_progress', 'paused'].includes(signalStage(s))).length,
      results: currentSignals.filter(s => signalStage(s) === 'resolved').length,
      items: currentSignals.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 30).map(s => ({ id: s.id, title: s.title, publishedAt: s.publishedAt, sourceUrl: s.sourceUrl, sourceName: s.sourceName })),
      coverage: sourceCoverage.coverage.find(c => c.territoryId === territoryId) || null, worker: sourceCoverage.worker.message },
    banks, priority, sberShare: priority.numbers.verifiedLocations ? 100 * (priority.numbers.verifiedSberLocations || 0) / priority.numbers.verifiedLocations : null,
    portfolio: privatePortfolio ? { available: privatePortfolio.available, offersAvailable: privatePortfolio.offersAvailable, sourceLabel: privatePortfolio.sourceLabel,
      summary: summarizePortfolio(selectedRows), all: privatePortfolio.summary,
      unassigned: summarizePortfolio(privatePortfolio.rows.filter(r => !r.scopes.length)), notes: privatePortfolio.notes,
      actions: selectedRows.filter(r => r.actions.length).sort((a, b) => b.stalled - a.stalled || (b.income || 0) - (a.income || 0)).slice(0, 12) } : null };
}
export type TerritoryAnalytics = ReturnType<typeof territoryAnalytics>;
