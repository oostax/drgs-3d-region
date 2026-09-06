import type { LiveEventMeta } from './live-types';
import { normalizeLegacyState } from './scene-lifecycle';

export type SignalRecencyBucket = 'active' | 'recent-resolved' | 'archive' | 'undated';
export type SignalRecencyWindow = 30 | 45 | 60;
export type SignalRecencyInput = {
  publishedAt?: string | null;
  closedAt?: string | null;
  category?: string;
  lifecycle?: { status: string; asOf?: string | null; sourceUrl?: string; currentStatusVerified?: boolean };
  live?: LiveEventMeta;
};
export type SignalRecency = {
  bucket: SignalRecencyBucket; visibleByDefault: boolean; label: string; reason: string;
  asOf: string; publishedAt: string | null; referenceDate: string | null; ageDays: number | null;
  needsStatusVerification: boolean;
};

const DAY = 86_400_000;
const WINDOWS = new Set([30, 45, 60]);
function day(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(text)) return null;
  const key = text.slice(0, 10);
  const stamp = Date.parse(`${key}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== key) return null;
  if (text.length > 10 && !Number.isFinite(Date.parse(text))) return null;
  return key;
}

function observationDay(asOf: string | Date): string {
  if (typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    const key = day(asOf);
    if (key) return key;
  } else {
    if (typeof asOf === 'string' && !day(asOf)) throw new RangeError('asOf must be a valid explicit date');
    const value = asOf instanceof Date ? asOf : new Date(asOf);
    if (Number.isFinite(value.getTime())) return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(value);
  }
  throw new RangeError('asOf must be a valid explicit date');
}

const validUrl = (value: string | null | undefined) => {
  try { return ['http:', 'https:'].includes(new URL(value ?? '').protocol); } catch { return false; }
};

/**
 * Classifies event visibility using publication or substantive event evidence.
 * Fetch time and `live.lastEvidenceAt` never extend a window: corrections and
 * reposts are audit revisions unless the worker advances `lastMeaningfulAt`.
 */
export function classifySignalRecency(signal: SignalRecencyInput, asOf: string | Date,
  options: { newsDays?: number; constructionDays?: number; resolvedDays?: number } = {}): SignalRecency {
  const now = observationDay(asOf);
  const newsDays = options.newsDays ?? 30;
  const constructionDays = options.constructionDays ?? newsDays;
  const resolvedDays = options.resolvedDays ?? 14;
  if (!WINDOWS.has(newsDays) || !WINDOWS.has(constructionDays) || !Number.isInteger(resolvedDays) || resolvedDays < 0 || resolvedDays > 14) {
    throw new RangeError('Recency windows must be 30, 45 or 60 days; resolved window cannot exceed 14 days');
  }
  const published = day(signal.publishedAt);
  const age = (value: string) => Math.round((Date.parse(now) - Date.parse(value)) / DAY);
  const make = (bucket: SignalRecencyBucket, label: string, reason: string, referenceDate: string | null = published,
    needsStatusVerification = false): SignalRecency => ({ bucket, visibleByDefault: bucket === 'active' || bucket === 'recent-resolved',
    label, reason, asOf: now, publishedAt: published, referenceDate, ageDays: referenceDate ? age(referenceDate) : null, needsStatusVerification });

  if (!published) return make('undated', 'Дата не подтверждена', 'Нет корректной даты публикации. Время загрузки не используется вместо неё.', null);
  if (age(published) < 0) return make('undated', 'Будущая дата', 'Дата публикации позже даты просмотра; материал исключён из текущего обзора.');

  if (signal.live) {
    const live = signal.live;
    const meaningful = day(live.lastMeaningfulAt);
    const event = day(live.eventTime);
    const reference = meaningful ?? event ?? published;
    if (live.state === 'planned') {
      const upcoming = event && age(event) <= 0;
      const stale = !upcoming && age(reference) > newsDays;
      return make('active', stale ? 'Запланировано · статус требует уточнения' : 'Запланировано',
        upcoming ? 'Событие запланировано на указанную будущую дату; это не выполняющиеся работы.'
          : 'План остаётся видимым до сообщения о завершении или отмене. Дата источника сохранена; текущая стадия может требовать уточнения.',
        upcoming ? event : reference, stale);
    }
    if (age(reference) < 0) return make('undated', 'Дата события не подтверждена', 'Содержательная дата события находится в будущем.', reference);
    if (live.state === 'resolved' || live.state === 'cancelled') {
      return age(reference) <= resolvedDays
        ? make('recent-resolved', live.state === 'resolved' ? 'Недавно решено' : 'Недавно отменено', `Содержательное изменение статуса произошло не более ${resolvedDays} дней назад.`, reference)
        : make('archive', live.state === 'resolved' ? 'Архив · решено' : 'Архив · отменено', `После содержательного изменения статуса прошло более ${resolvedDays} дней.`, reference);
    }
    const fresh = age(reference) <= newsDays;
    const current = live.state !== 'in_progress' || live.ongoing;
    if (!fresh || !current) return make('archive', 'Статус требует проверки',
      !fresh ? `Последнее содержательное свидетельство старше ${newsDays} дней.` : 'Событие не помечено как продолжающееся.', reference, true);
    const labels: Partial<Record<typeof live.state, string>> = {
      reported: 'Поступил сигнал', in_progress: 'В работе', paused: 'Приостановлено',
      unknown: 'Свежая публикация',
    };
    return make('active', labels[live.state] ?? 'Свежая публикация', `Последнее содержательное свидетельство находится в пределах ${newsDays} дней. Источник: ${live.sourceKind}; уверенность: ${live.confidence}.`, reference,
      live.state === 'unknown');
  }

  const lifecycle = signal.lifecycle;
  const state = normalizeLegacyState(lifecycle?.status);
  if (signal.closedAt || state === 'resolved') {
    const resolved = day(signal.closedAt || lifecycle?.asOf);
    if (!resolved || age(resolved) < 0) return make('undated', 'Дата завершения не подтверждена', 'Некорректная или будущая дата завершения; текущий статус не выводится.', resolved);
    return age(resolved) <= resolvedDays
      ? make('recent-resolved', 'Недавно завершено', `Подтверждённая дата завершения находится в пределах ${resolvedDays} дней.`, resolved)
      : make('archive', 'Архив · завершено', `После указанной даты завершения прошло более ${resolvedDays} дней.`, resolved);
  }

  if (lifecycle && state === 'planned') {
    return make('active', 'Запланировано',
      'Сохранённый план отображается до подтверждения завершения или отмены; текущие работы не предполагаются.',
      day(lifecycle.asOf) ?? published, lifecycle.currentStatusVerified !== true);
  }
  if (lifecycle && state === 'in_progress') {
    const meaningful = day(lifecycle.asOf);
    if (meaningful && age(meaningful) < 0) return make('undated', 'Будущая дата статуса', 'Проверка стадии указана будущей датой; она не подтверждает текущие работы.', meaningful, true);
    if (lifecycle.currentStatusVerified === true && validUrl(lifecycle.sourceUrl) && meaningful && age(meaningful) <= constructionDays) {
      return make('active', 'Подтверждённый ход работ',
        `Стадия подтверждена датированным источником не старше ${constructionDays} дней.`, meaningful);
    }
    return make('archive', 'Статус требует проверки', 'Историческая стадия не подтверждена достаточно свежим содержательным источником. Обновление страницы не означает продолжения работ.', meaningful ?? published, true);
  }

  return age(published) <= newsDays
    ? make('active', 'Свежая публикация', `Публикация не старше ${newsDays} дней. Это свежесть новости, а не подтверждение незавершённого события.`)
    : make('archive', 'Архивная публикация', `Дата публикации старше ${newsDays} дней; материал сохранён для истории и досье.`);
}
