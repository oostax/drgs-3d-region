import { all, hasTable, safeJson, db } from './db';
import { canonicalSourceName, currentSourceId, offerSourceSelection } from './source-status';
import { getTerritories } from './atlas-data';
import { publicOrganizationIndex, sourceOrganizationLocation, validCoordinates } from './organization-locations';
import { safeSourceUrl, territoryIndex } from './territory-scope';
import type { OrganizationLocation, MeetingPlan } from './planning-types';
import type { ClientMapPoint } from './client-map-types';
import type { PortfolioData, PortfolioRow, PortfolioSummary } from './portfolio-types';
import type { Signal, Territory } from './types';

const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const unique = (v: string[]) => [...new Set(v.filter(Boolean))];
type Org = { id: string; inn: string; name: string; gosb: string };
type Offer = { id: string; offer_id: string; org_id: string; product: string; stage: string; amount: number | null; expected_income: number | null; stage_date: string | null; data_json?: string };

export function locationForClient(org: Org, location: OrganizationLocation): { point: ClientMapPoint | null; reason: string } {
  for (const [addressKind, p] of [['meeting', location.meeting], ['office', location.office], ['legal', location.legalAddress]] as const) {
    if (!p || !text(p.address) || !validCoordinates(p.coordinates) || Math.abs(p.coordinates[1]) > 85.051129 || !['building', 'site'].includes(p.precision)) continue;
    if (!p.confirmedByUser && (!['source_exact', 'verified'].includes(location.status) || !safeSourceUrl(p.sourceUrl))) continue;
    return { point: { ...org, addressKind, address: p.address, coordinates: p.coordinates, precision: p.precision, sourceUrl: p.sourceUrl, confirmedByUser: p.confirmedByUser }, reason: addressKind === 'legal' ? 'Юридический адрес; место деятельности и встречи не подтверждено.' : 'Адрес объекта; встречу необходимо согласовать.' };
  }
  return { point: null, reason: location.candidates.length ? 'Есть неоднозначные адреса: требуется подтверждение.' : [location.office, location.legalAddress, location.meeting].some(Boolean) ? 'Адрес есть, но точность до здания не подтверждена.' : 'Нет адреса с подтверждёнными координатами. ИНН и ГОСБ не задают точку.' };
}

/** Count rows only after selecting ONE completed source. Equal IDs are not summed twice. */
export function deduplicateOffers(rows: Offer[]) {
  const groups = new Map<string, Offer[]>(), output: Offer[] = [];
  let duplicates = 0, ambiguous = 0;
  for (const row of rows) { const key = text(row.offer_id); if (!key) { ambiguous++; continue; } const g = groups.get(key) || []; g.push(row); groups.set(key, g); }
  for (const group of groups.values()) {
    const signatures = new Set(group.map(r => JSON.stringify([r.org_id, r.product, r.stage, r.stage_date, r.amount, r.expected_income])));
    if (signatures.size > 1) { ambiguous += group.length; continue; }
    output.push(group[0]); duplicates += group.length - 1;
  }
  return { rows: output, duplicates, ambiguous };
}
export function summarizePortfolio(rows: readonly PortfolioRow[]): PortfolioSummary {
  const sum = (values: (number | null)[]) => { const known = values.filter((n): n is number => n !== null); return known.length ? known.reduce((a, b) => a + b, 0) : null; };
  const comparable = rows.filter(r => r.payroll.march !== null && r.payroll.july !== null);
  const march = sum(comparable.map(r => r.payroll.march)), july = sum(comparable.map(r => r.payroll.july));
  return { organizations: rows.length, uniqueInns: new Set(rows.map(r => r.inn).filter(Boolean)).size,
    offerClients: rows.filter(r => r.offers > 0).length, offers: rows.reduce((n, r) => n + r.offers, 0),
    income: sum(rows.map(r => r.income)), missingIncome: rows.reduce((n, r) => n + r.missingIncome, 0),
    amount: sum(rows.map(r => r.amount)), missingAmount: rows.reduce((n, r) => n + r.missingAmount, 0),
    located: rows.filter(r => r.point).length, unlocated: rows.filter(r => !r.point).length,
    duplicateOffers: rows.reduce((n, r) => n + r.duplicateOffers, 0), ambiguousOffers: rows.reduce((n, r) => n + r.ambiguousOffers, 0),
    payrollMarch: march, payrollJuly: july, payrollComparableClients: comparable.length,
    payrollGrowth: march !== null && july !== null && march > 0 ? (july / march - 1) * 100 : null,
    meetingCounts: [0, 1, 2].map(i => sum(rows.map(r => r.meetings[i]))),
    meetingKnown: [0, 1, 2].map(i => rows.filter(r => r.meetings[i] !== null).length),
    plannedClients: rows.filter(r => r.plans > 0).length, plannedStops: rows.reduce((n, r) => n + r.plans, 0) };
}
export function portfolioActions(row: PortfolioRow, sourceLabel: string, snapshot: string, signals: readonly Signal[] = []) {
  const actions: PortfolioRow['actions'] = [];
  if (snapshot === 'current' && row.stalled) actions.push({ rule: 'stalled', title: 'Разобрать длительную стадию', facts: [`У ${row.stalled} предложений в самой выгрузке указано не менее 30 дней на стадии.`, sourceLabel], nextStep: 'Проверить актуальный статус, препятствие и следующий контакт. 30 дней — порог проверки, не норматив просрочки.' });
  if (snapshot === 'current' && row.offers && row.meetings.every(n => n === 0) && !row.plans) actions.push({ rule: 'contact', title: 'Подготовить контакт по предложениям', facts: [`${row.offers} предложений; в трёх загруженных квартальных счётчиках указано 0 встреч.`, 'В локальных планах нет будущей встречи с этой организацией.'], nextStep: 'Проверить контакты вне выгрузки и согласовать встречу с КМ и клиентом.' });
  if (row.payroll.march !== null && row.payroll.july !== null && row.payroll.march > 0 && row.payroll.july > row.payroll.march) actions.push({ rule: 'payroll', title: 'Уточнить рост зарплатных выплат', facts: [`Март: ${row.payroll.march.toLocaleString('ru-RU')} ₽; июль: ${row.payroll.july.toLocaleString('ru-RU')} ₽.`, 'Это две точки наблюдения, а не доказательство расширения штата.'], nextStep: 'Уточнить сезонность и премии, затем обсудить зарплатные и расчётные сервисы.' });
  if (row.missingIncome) actions.push({ rule: 'income', title: 'Уточнить ожидаемый доход', facts: [`Доход не указан у ${row.missingIncome} предложений; он не заменён нулём.`], nextStep: 'Проверить карточки предложений и дополнить исходную выгрузку.' });
  if (row.ambiguousOffers) actions.push({ rule: 'duplicates', title: 'Разобрать идентификаторы предложений', facts: [`${row.ambiguousOffers} строк с пустым или конфликтующим ID исключены из сумм.`], nextStep: 'Проверить ID и повторяющиеся строки в выбранном источнике.' });
  if ((row.offers || row.ambiguousOffers) && !row.point) actions.push({ rule: 'address', title: 'Подтвердить адрес клиента', facts: [row.locationReason], nextStep: 'Сопоставить открытый справочник по ИНН, загрузить адреса или подтвердить место вручную.' });
  for (const signal of signals.filter(s => s.organizationInn === row.inn && row.inn && s.visibility === 'public' && safeSourceUrl(s.sourceUrl)).slice(0, 3)) actions.push({ rule: 'signal', title: 'Проверить публичный повод', signalId: signal.id, facts: [signal.title, `Совпал ИНН, а не название или близость на карте. Публикация: ${signal.publishedAt.slice(0, 10)}.`], nextStep: signal.nextStep || 'Уточнить участие клиента и текущую стадию; потребность в продукте не подтверждена.' });
  if (snapshot === 'current' && row.offers && !actions.some(a => a.rule === 'stalled' || a.rule === 'contact')) actions.push({ rule: 'offers', title: 'Обсудить предложения из среза', facts: [`${row.offers} предложений. Продукты: ${row.products.slice(0, 5).join(', ') || 'не указаны'}.`, sourceLabel], nextStep: 'Уточнить действующий статус и ответственного; сумма предложений не является одобренным лимитом.' });
  return actions;
}

export function loadClientPortfolio(snapshot = 'current', territories: readonly Territory[] = getTerritories(), asOf = new Date().toISOString()): PortfolioData {
  // A single SQLite snapshot keeps offers, versions and relationship counters coherent.
  return db().transaction(() => {
    if (!hasTable('organizations')) return { rows: [], available: false, offersAvailable: false, sourceLabel: 'Клиентский портфель не загружен', notes: [], summary: summarizePortfolio([]) };
    const orgs = all<Org>('SELECT id,inn,name,gosb FROM organizations ORDER BY id').map(o => ({ ...o, inn: text(o.inn), name: text(o.name) || 'Название не указано', gosb: text(o.gosb) }));
    const tracked = hasTable('imports'), selection = offerSourceSelection(snapshot), hasOffers = hasTable('offers');
    const offersAvailable = hasOffers && (!tracked || !!selection.sourceId);
    const offers = offersAvailable ? all<Offer>(`SELECT * FROM offers WHERE snapshot=?${selection.tracked ? ' AND source_id=?' : ''}`, snapshot, ...(selection.tracked ? [selection.sourceId] : [])) : [];
    const source = selection.sourceId ? all<{file_name: string; period: string}>('SELECT file_name,period FROM imports WHERE id=?', selection.sourceId)[0] : null;
    const period = safeJson<{ snapshot_date?: string; date_inferred?: boolean }>(source?.period, {});
    const sourceLabel = source ? `${canonicalSourceName(source.file_name)}${period.snapshot_date ? ` · ${period.snapshot_date}${period.date_inferred ? ' (дата предполагается)' : ''}` : ' · дата среза не установлена'}` : offersAvailable ? 'Локальный срез без версии источника' : 'Завершённый источник предложений не загружен';
    const byOrg = new Map<string, Offer[]>();
    // Global duplicate identity also detects an offer attributed to two organizations.
    const duplicateIds = new Map<string, Set<string>>();
    for (const o of offers) { const rows = byOrg.get(o.org_id) || []; rows.push(o); byOrg.set(o.org_id, rows); if (text(o.offer_id)) { const owners = duplicateIds.get(text(o.offer_id)) || new Set<string>(); owners.add(o.org_id); duplicateIds.set(text(o.offer_id), owners); } }
    const saved = hasTable('organization_locations') ? new Map(all<{org_id: string; data_json: string}>('SELECT org_id,data_json FROM organization_locations').map(r => [r.org_id, safeJson<OrganizationLocation | null>(r.data_json, null)])) : new Map<string, OrganizationLocation | null>();
    const index = publicOrganizationIndex(), byInn = new Map<string, typeof index>();
    for (const item of index) { if (!item.inn) continue; const g = byInn.get(item.inn) || []; g.push(item); byInn.set(item.inn, g); }
    const payroll = hasTable('payroll') ? new Map(all<Record<string, unknown>>('SELECT * FROM payroll').map(r => [String(r.org_id), r])) : new Map<string, Record<string, unknown>>();
    const meetings = hasTable('meetings') ? new Map(all<Record<string, unknown>>('SELECT * FROM meetings').map(r => [String(r.org_id), r])) : new Map<string, Record<string, unknown>>();
    const paySource = tracked ? currentSourceId('payroll') : null, meetingSource = tracked ? currentSourceId('meetings') : null;
    const safeLatest = (kind: string) => !tracked || all<{status: string}>('SELECT status FROM imports WHERE kind=? ORDER BY imported_at DESC,rowid DESC LIMIT 1', kind)[0]?.status === 'complete';
    const payReady = safeLatest('payroll'), meetingReady = safeLatest('meetings');
    const plans = new Map<string, number>();
    if (hasTable('meeting_plans')) for (const entry of all<{content_json: string}>("SELECT content_json FROM meeting_plans WHERE mode='work'")) {
      const p = safeJson<MeetingPlan | null>(entry.content_json, null);
      if (p && Array.isArray(p.stops) && Date.parse(p.endsAt) >= Date.parse(asOf)) for (const id of new Set(p.stops.map(s => s.orgId))) plans.set(id, (plans.get(id) || 0) + 1);
    }
    const geography = territoryIndex(territories), pointCache = new Map<string, string[]>();
    const rows: PortfolioRow[] = orgs.map(org => {
      const raw = byOrg.get(org.id) || [], safe = raw.filter(o => (duplicateIds.get(text(o.offer_id))?.size || 0) <= 1), dedup = deduplicateOffers(safe);
      const selected = dedup.rows, metadata = selected.map(o => safeJson<Record<string, unknown>>(o.data_json, {}));
      const income = selected.map(o => finite(o.expected_income)), amounts = selected.map(o => finite(o.amount));
      const sum = (values: (number | null)[]) => values.some(v => v !== null) ? values.reduce<number>((a, b) => a + (b || 0), 0) : null;
      const location = saved.get(org.id) || sourceOrganizationLocation(org, byInn.get(org.inn) || []), resolved = locationForClient(org, location);
      const key = JSON.stringify(resolved.point?.coordinates);
      if (resolved.point && !pointCache.has(key)) pointCache.set(key, geography.point(resolved.point.coordinates));
      const p = payroll.get(org.id), m = meetings.get(org.id);
      const payRefs = safeJson<Record<string, {source_id?: string}> & {conflicts?: unknown[]}>(p?.source_json as string, {});
      const pay = (field: string) => !payReady || payRefs.conflicts?.length || tracked && (!paySource || payRefs[field]?.source_id !== paySource) ? null : finite(p?.[field]);
      const meetingRef = safeJson<{source?: {source_id?: string}}>(m?.data_json as string, {});
      const meetingValid = meetingReady && m && finite(m.conflict) === 0 && (!tracked || !!meetingSource && meetingRef.source?.source_id === meetingSource);
      const row: PortfolioRow = { ...org, offers: selected.length, income: sum(income), missingIncome: income.filter(v => v === null).length, amount: sum(amounts), missingAmount: amounts.filter(v => v === null).length,
        duplicateOffers: dedup.duplicates, ambiguousOffers: dedup.ambiguous + raw.length - safe.length,
        products: unique(selected.map(o => text(o.product))), stages: unique(selected.map(o => text(o.stage))), managers: unique(metadata.map(o => text(o.manager))),
        point: resolved.point, locationReason: resolved.reason, scopes: resolved.point ? pointCache.get(key)! : [],
        payroll: { march: pay('fot_march'), july: pay('fot_july') }, meetings: ['q1', 'q2', 'q3'].map(k => meetingValid && (finite(m?.[k]) ?? -1) >= 0 ? finite(m?.[k]) : null), plans: plans.get(org.id) || 0,
        stalled: selected.filter((o, i) => !/закрыт|отказ|заверш|активирован/i.test(o.stage || '') && finite(metadata[i].days_in_stage) !== null && Number(metadata[i].days_in_stage) >= 30).length, actions: [] };
      row.actions = portfolioActions(row, sourceLabel, snapshot); return row;
    });
    return { rows, available: true, offersAvailable, sourceLabel, summary: summarizePortfolio(rows), notes: [
      'Суммы — только известные значения выбранного завершённого источника. ОД — ожидаемый, не полученный доход.',
      'Повторы одного ID предложения считаются один раз; пустые и конфликтующие ID исключены и показаны отдельно.',
      'Клиенты учитываются по ИНН + ГОСБ. География определяется адресом, не ГОСБ; юридический адрес не доказывает место деятельности.',
      'ФОТ сравнивается только по одной и той же группе клиентов с двумя известными значениями. Неизвестные встречи не равны нулю.'
    ] };
  })();
}
