import type { BankOffice, Coordinates, Signal, Territory } from './types';

export type TerritoryPriority = {
  id: string;
  title: string;
  level: 'develop' | 'attention' | 'presence' | 'insufficient';
  score: number | null;
  confidence: 'low' | 'medium';
  facts: string[];
  nextStep: string;
  numbers: {
    verifiedLocations: number;
    verifiedSberLocations: number | null;
    verifiedCompetitorLocations: number | null;
    competitorBanks: number;
    unlocatedBankRecords: number;
    staleBankRecords: number;
    duplicatesRemoved: number;
    recentOpportunitySignals: number;
    historicalOpportunitySignals: number;
    undatedOpportunitySignals: number;
    currentStatusVerifiedSignals: number;
    completedProjectSignals: number;
    globalUnassignedBankRecords: number;
  };
  sources: { label: string; url: string; asOf: string | null }[];
  note: string;
};

export type TerritoryPriorityOptions = {
  /** An explicit date keeps scoring deterministic; this is a review date, not a source date. */
  asOf: string;
  maxSignalAgeDays?: number;
  maxOfficeAgeDays?: number;
};

const DAY = 86_400_000;
const PROJECT_CATEGORIES = new Set(['construction', 'investment', 'infrastructure', 'planning']);
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim();
export const bankKey = (bank: string) => {
  const value = normalize(bank).replace(/[«»"']/g, '').replace(/\s+/g, ' ');
  if (/^(?:пао\s+)?(?:сбер(?:банк)?(?:\s+россии)?|sber(?:bank)?)$/.test(value)) return 'sber';
  if (/^(?:банк\s+)?(?:втб|vtb)(?:\s+пао)?$/.test(value)) return 'vtb';
  return value;
};
const addressKey = (address: string) => {
  const value = normalize(address).replace(/\b\d{6}\b/g, '');
  // Shared placeholder text is not an address; without a house identifier use coordinates only.
  if (!/\d/.test(value) || /не указан|неизвест|нет адрес|уточня|unknown|not specified/.test(value)) return '';
  return value.replace(/\b(?:https?):\/\/\S+/g, '')
    .replace(/(^|[\s,.])(город|улица|дом|корпус)(?=[\s,.])/g, (_, prefix: string, word: string) => `${prefix}${({ город: 'г', улица: 'ул', дом: 'д', корпус: 'к' } as Record<string, string>)[word]}`)
    .replace(/[^\p{L}\p{N}]/gu, '');
};
const validUrl = (value: string | null | undefined) => {
  if (!value) return false;
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password; }
  catch { return false; }
};
const dateValue = (value: string | null | undefined) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const calendarDay = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendarDay) || new Date(calendarDay).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};
const validPoint = (point: Coordinates | null | undefined): point is Coordinates => !!point && point.length === 2
  && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
const daysOld = (value: string | null | undefined, now: number) => {
  const time = dateValue(value);
  return time === null || time > now + DAY - 1 ? null : Math.max(0, (now - time) / DAY);
};
const metresApart = (a: Coordinates, b: Coordinates) => {
  const lat = (a[1] + b[1]) * Math.PI / 360;
  return Math.hypot((a[0] - b[0]) * Math.cos(lat), a[1] - b[1]) * 111_195;
};

// Boundary points are retained, while polygon holes are excluded.
function inRing(point: Coordinates, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const cross = (point[1] - a[1]) * (b[0] - a[0]) - (point[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(cross) < 1e-12 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0])
      && point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function contains(territory: Territory, point: Coordinates) {
  const b = territory.bbox;
  if (b && (point[0] < b[0] || point[1] < b[1] || point[0] > b[2] || point[1] > b[3])) return false;
  const geometry = territory.geometry;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(polygon => polygon.length > 0 && inRing(point, polygon[0]) && !polygon.slice(1).some(hole => inRing(point, hole)));
}

type LocatedOffice = { office: BankOffice; bank: string; address: string; scopes: string[]; source: boolean; geocoded: boolean; fresh: boolean };
type Accumulator = { banks: LocatedOffice[]; missing: number; stale: number; duplicates: number; recent: Signal[]; historical: Signal[]; undated: Signal[]; completed: Signal[]; current: number };

/** Public evidence only. No database, network, address geocoder or portfolio geography inference. */
export function territoryPriorities(signals: readonly Signal[], offices: readonly BankOffice[], territories: readonly Territory[], options: TerritoryPriorityOptions): TerritoryPriority[] {
  const now = dateValue(options.asOf);
  if (now === null) throw new Error('Для приоритетов нужна дата проверки в ISO-формате.');
  const signalDays = options.maxSignalAgeDays ?? 180;
  const officeDays = options.maxOfficeAgeDays ?? 365;
  if (![signalDays, officeDays].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Сроки актуальности должны быть неотрицательными.');
  const byId = new Map(territories.map(territory => [territory.id, territory]));
  const chainCache = new Map<string, string[]>();
  const chain = (id: string) => {
    if (chainCache.has(id)) return chainCache.get(id)!;
    const result: string[] = [], seen = new Set<string>();
    let node = byId.get(id);
    while (node && !seen.has(node.id)) { result.push(node.id); seen.add(node.id); node = node.parentId ? byId.get(node.parentId) : undefined; }
    chainCache.set(id, result);
    return result;
  };
  const scopesFor = (id: string | null, coordinates: Coordinates | null): string[] => {
    // The source's explicit territorial scope is not spread down to every child municipality.
    if (id && byId.has(id)) return chain(id);
    if (!validPoint(coordinates)) return [];
    const matches = territories.filter(territory => contains(territory, coordinates));
    if (!matches.length) return [];
    const depth = Math.max(...matches.map(territory => chain(territory.id).length));
    const deepest = matches.filter(territory => chain(territory.id).length === depth);
    if (deepest.length === 1) return chain(deepest[0].id);
    // Ambiguous borders fall back only to a shared parent, never to a nearest centre.
    return chain(deepest[0].id).filter(candidate => deepest.every(territory => chain(territory.id).includes(candidate)));
  };
  const accumulators = new Map<string, Accumulator>(territories.map(territory => [territory.id,
    { banks: [], missing: 0, stale: 0, duplicates: 0, recent: [], historical: [], undated: [], completed: [], current: 0 }]));
  const rows: LocatedOffice[] = offices.map(office => {
    const source = validUrl(office.sourceUrl);
    const geocoded = source && validUrl(office.coordinateSourceUrl || office.sourceUrl) && validPoint(office.coordinates)
      && (office.precision === 'building' || office.precision === 'site');
    const age = daysOld(office.checkedAt, now);
    return { office, bank: bankKey(office.bank), address: addressKey(office.address), source, geocoded,
      fresh: geocoded && age !== null && age <= officeDays,
      scopes: scopesFor(office.territoryId, geocoded ? office.coordinates : null) };
  });

  // Merge evidence for a bank location, not all offices of one brand or all banks in one building.
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    if (!a.bank || a.bank !== b.bank) continue;
    const distance = a.geocoded && b.geocoded ? metresApart(a.office.coordinates!, b.office.coordinates!) : Infinity;
    const sameSourceId = !!a.office.id && a.office.id === b.office.id;
    const sameAddress = !!a.address && a.address === b.address && (distance <= 150
      || !Number.isFinite(distance) && a.scopes[0] && a.scopes[0] === b.scopes[0]);
    if (sameSourceId || distance <= 15 || sameAddress) parent[find(j)] = find(i);
  }
  const grouped = new Map<number, LocatedOffice[]>();
  rows.forEach((row, i) => { const key = find(i); const group = grouped.get(key) || []; group.push(row); grouped.set(key, group); });
  let unassigned = 0;
  for (const group of grouped.values()) {
    const quality = (row: LocatedOffice) => Number(row.fresh) * 1e15 + Number(row.geocoded) * 1e14 + Number(row.source) * 1e13 + (dateValue(row.office.checkedAt) ?? 0);
    const best = [...group].sort((a, b) => quality(b) - quality(a))[0];
    const scopes = best.scopes.length ? best.scopes : group.find(row => row.scopes.length)?.scopes ?? [];
    if (!scopes.length) { unassigned++; continue; }
    for (const id of scopes) {
      const accumulator = accumulators.get(id)!;
      accumulator.duplicates += group.length - 1;
      if (best.fresh && best.bank) accumulator.banks.push(best);
      else if (best.geocoded && best.bank) accumulator.stale++;
      else accumulator.missing++;
    }
  }

  const seenSignals = new Set<string>();
  const orderedSignals = [...signals].sort((a, b) => (dateValue(b.publishedAt) ?? 0) - (dateValue(a.publishedAt) ?? 0));
  for (const signal of orderedSignals) {
    if (signal.visibility !== 'public' || !validUrl(signal.sourceUrl) || !PROJECT_CATEGORIES.has(normalize(signal.category))) continue;
    const scopes = scopesFor(signal.territoryId, signal.precision === 'territory' ? null : signal.coordinates);
    if (!scopes.length) continue;
    const source = new URL(signal.sourceUrl); source.hash = '';
    const key = `${scopes[0]}:${source.toString()}`;
    if (seenSignals.has(key)) continue;
    seenSignals.add(key);
    const publicationAge = daysOld(signal.publishedAt, now);
    const life = signal.lifecycle;
    const statusAge = life ? daysOld(life.asOf, now) : null;
    const current = !!life?.currentStatusVerified && validUrl(life.sourceUrl) && statusAge !== null && statusAge <= signalDays
      && (life.status === 'planned' || life.status === 'under_construction');
    for (const id of scopes) {
      const accumulator = accumulators.get(id)!;
      if (life?.status === 'completed') accumulator.completed.push(signal);
      else if (current || publicationAge !== null && publicationAge <= signalDays) { accumulator.recent.push(signal); if (current) accumulator.current++; }
      else if (publicationAge !== null) accumulator.historical.push(signal);
      else accumulator.undated.push(signal);
    }
  }

  return territories.map(territory => {
    const data = accumulators.get(territory.id)!;
    const total = data.banks.length;
    const sber = data.banks.filter(row => row.bank === 'sber').length;
    const competitors = total - sber;
    const level: TerritoryPriority['level'] = total === 0 ? 'insufficient' : data.recent.length ? (sber >= 2 ? 'develop' : 'attention') : 'presence';
    // Fixed review points: 2 per recent themed publication (cap 3), +2 for a development/review action.
    const score = level === 'insufficient' ? null : level === 'presence' ? 1 : Math.min(data.recent.length, 3) * 2 + 2;
    const confidence = !total || data.missing || data.stale || unassigned || data.current < data.recent.length ? 'low' : 'medium';
    const facts = [total
      ? `В доступном наборе подтверждена география ${total} банковских мест: Сбер — ${sber}, другие банки — ${competitors}. Это не число всех действующих офисов.`
      : 'Нет банковских точек с достаточной географией, источником и датой проверки. Это не означает отсутствие банков на территории.'];
    if (data.missing) facts.push(`Записей без достаточных координат/точности/источника: ${data.missing}; они не превращены в нулевое присутствие.`);
    if (data.stale) facts.push(`Координатных записей с устаревшей, неизвестной или будущей датой проверки: ${data.stale}; в текущие числа они не включены.`);
    if (data.duplicates) facts.push(`Объединено повторов источников по банку и месту: ${data.duplicates}.`);
    if (data.recent.length) facts.push(`Поводов проверить проекты за последние ${signalDays} дней: ${data.recent.length}; актуальная стадия отдельно подтверждена у ${data.current}.`);
    const evidence = [...data.recent, ...data.historical, ...data.completed, ...data.undated].slice(0, 3);
    for (const signal of evidence) {
      const published = dateValue(signal.publishedAt) === null ? 'дата неизвестна' : signal.publishedAt.slice(0, 10);
      const life = signal.lifecycle;
      const stage = life?.status === 'completed' ? 'источник описывает завершённый результат'
        : life?.currentStatusVerified && (life.status === 'planned' || life.status === 'under_construction')
          && validUrl(life.sourceUrl) && (daysOld(life.asOf, now) ?? Infinity) <= signalDays
          ? `стадия подтверждена на ${life.asOf.slice(0, 10)}` : 'текущая стадия не подтверждена';
      facts.push(`Публикация ${published}: «${signal.title}»; ${stage}.`);
    }
    if (data.historical.length) facts.push(`Исторических тематических публикаций старше ${signalDays} дней: ${data.historical.length}; баллы текущего приоритета за них не начислены.`);
    if (data.undated.length) facts.push(`Публикаций с неизвестной или будущей датой: ${data.undated.length}; в текущий приоритет не включены.`);
    const nextStep = level === 'develop'
      ? 'Развивать диалог через подтверждённые точки Сбера: уточнить текущую стадию публичных проектов, участников и подходящий следующий контакт. Потребность в продукте ещё не подтверждена.'
      : level === 'attention'
        ? competitors > 0 && sber <= 1
          ? 'Проверить потенциал: уточнить проекты и полноту сети Сбера на фоне известных точек других банков. Назначить ответственного за проверку, не делать вывод о доле рынка.'
          : 'Проверить участников и стадию публичных проектов, а затем подготовить предметный разговор через известную точку Сбера. Коммерческий спрос не подтверждён.'
        : level === 'presence'
          ? 'Проверить актуальность известных банковских мест и найти свежие публичные проекты. По этим данным нельзя оценить клиентскую долю или лидерство.'
          : 'Сначала подтвердить банковские адреса, координаты и даты по открытым источникам. Затем сопоставить с проектами; финансовый портфель по ГОСБ сюда не распределять.';
    const sources: TerritoryPriority['sources'] = [];
    const seenUrls = new Set<string>();
    const addSource = (label: string, url: string, asOf: string | null) => { if (validUrl(url) && !seenUrls.has(url)) { sources.push({ label, url, asOf }); seenUrls.add(url); } };
    for (const signal of evidence) {
      addSource(signal.title, signal.sourceUrl, dateValue(signal.publishedAt) === null ? null : signal.publishedAt.slice(0, 10));
      if (signal.lifecycle?.currentStatusVerified) addSource('Проверка стадии проекта', signal.lifecycle.sourceUrl, signal.lifecycle.asOf);
    }
    for (const row of data.banks.slice(0, 4)) {
      addSource(`Банковская запись: ${row.office.bank}`, row.office.sourceUrl, row.office.checkedAt.slice(0, 10));
      if (row.office.coordinateSourceUrl) addSource('Источник координат', row.office.coordinateSourceUrl, row.office.checkedAt.slice(0, 10));
    }
    return {
      id: territory.id, title: territory.name, level, score, confidence, facts, nextStep,
      numbers: { verifiedLocations: total, verifiedSberLocations: total ? sber : null, verifiedCompetitorLocations: total ? competitors : null,
        competitorBanks: new Set(data.banks.filter(row => row.bank !== 'sber').map(row => row.bank)).size,
        unlocatedBankRecords: data.missing, staleBankRecords: data.stale, duplicatesRemoved: data.duplicates,
        recentOpportunitySignals: data.recent.length, historicalOpportunitySignals: data.historical.length,
        undatedOpportunitySignals: data.undated.length, currentStatusVerifiedSignals: data.current,
        completedProjectSignals: data.completed.length, globalUnassignedBankRecords: unassigned },
      sources,
      note: `Приоритет проверки на ${options.asOf.slice(0, 10)}. Баллы: 2 за тематическую публикацию (до трёх) + 2 за повод действия; только присутствие — 1, недостаток географии — без балла. Это не проценты, доля рынка, выручка или рейтинг силы банка. Сроки ${signalDays}/${officeDays} дней — правила просмотра публикаций/банковских записей. География не подтверждает работу офиса; полнота сети неизвестна. Непривязанных банковских записей во всём входном наборе: ${unassigned}.`,
    };
  });
}
