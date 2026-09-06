import type { LiveActivityKind, LiveConfidence, LiveEventMeta, LiveEventState, LiveSourceKind } from './live-types';
import type { Signal } from './types';

export const ACTIVITY_TTL_MS = {
  acute: 6 * 60 * 60 * 1000,
  repair: 7 * 24 * 60 * 60 * 1000,
  construction: 30 * 24 * 60 * 60 * 1000,
} as const;

const ACUTE = new Set<LiveActivityKind>(['road_defect', 'utility_fault', 'waste', 'flood', 'snow_ice', 'emergency', 'fire']);
const REPAIR = new Set<LiveActivityKind>(['road_repair', 'utility_repair', 'cleanup']);
const TERMINAL = new Set<LiveEventState>(['resolved', 'cancelled']);

export type NormalizedSceneLifecycle = {
  state: LiveEventState;
  sourceKind: LiveSourceKind | 'unknown';
  confidence: LiveConfidence | 'unknown';
  activityKind: LiveActivityKind;
  ongoing: boolean;
  explicitActivity: boolean;
  eventTime: string | null;
  lastEvidenceAt: string | null;
  lastMeaningfulAt: string | null;
  activityTtlMs: number | null;
  activityExpiresAt: number | null;
  activeActivity: boolean;
  terminal: boolean;
  legacy: boolean;
  reason: string;
};

type LegacyLifecycle = NonNullable<Signal['lifecycle']>;
type SignalLifecycleFields = Partial<Pick<Signal, 'live' | 'lifecycle' | 'publishedAt'>>;
type LifecycleSubject = SignalLifecycleFields | LiveEventMeta | LegacyLifecycle | null | undefined;

const timestamp = (value: string | null | undefined) => {
  if (!value || typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function activityTtl(kind: LiveActivityKind): number | null {
  if (kind === 'construction') return ACTIVITY_TTL_MS.construction;
  if (REPAIR.has(kind)) return ACTIVITY_TTL_MS.repair;
  if (ACUTE.has(kind)) return ACTIVITY_TTL_MS.acute;
  return null;
}

export function normalizeLegacyState(status: LegacyLifecycle['status'] | string | null | undefined): LiveEventState {
  if (status === 'under_construction') return 'in_progress';
  if (status === 'completed') return 'resolved';
  if (status === 'not_applicable') return 'reported';
  if (status === 'planned' || status === 'unknown') return status;
  if (['reported', 'in_progress', 'paused', 'resolved', 'cancelled'].includes(status ?? '')) return status as LiveEventState;
  return 'unknown';
}

function asSignal(subject: LifecycleSubject): SignalLifecycleFields | null {
  if (!subject || typeof subject !== 'object') return null;
  if ('live' in subject || 'lifecycle' in subject || 'publishedAt' in subject) return subject as SignalLifecycleFields;
  if ('lastMeaningfulAt' in subject && 'activityKind' in subject) return { live: subject as LiveEventMeta };
  return { lifecycle: subject as LegacyLifecycle };
}

/**
 * Normalizes the new event contract and the previous lifecycle flags without
 * treating publisher origin or model confidence as proof of current activity.
 * `lastEvidenceAt` is audit metadata; only `lastMeaningfulAt` advances an
 * activity TTL, so spelling edits and reposts cannot keep machinery alive.
 */
export function normalizeSceneLifecycle(subject: LifecycleSubject, now = Date.now()): NormalizedSceneLifecycle {
  const signal = asSignal(subject);
  const live = signal?.live;
  if (live) {
    const ttl = activityTtl(live.activityKind);
    const eventAt = timestamp(live.eventTime);
    const evidenceAt = timestamp(live.lastEvidenceAt);
    const meaningfulAt = timestamp(live.lastMeaningfulAt);
    const chronologyValid = eventAt !== null && evidenceAt !== null && meaningfulAt !== null
      && eventAt <= now && meaningfulAt <= evidenceAt && evidenceAt <= now;
    const currentState = live.state === 'in_progress' && live.ongoing;
    const activeActivity = Boolean(ttl && currentState && live.explicitActivity && chronologyValid && now - meaningfulAt! <= ttl);
    const reason = !ttl ? 'Для этого вида события активная физическая сцена не предусмотрена.'
      : !currentState ? 'Состояние не подтверждает продолжающуюся активность.'
      : !live.explicitActivity ? 'Нет явного свидетельства текущей физической активности.'
      : !chronologyValid ? 'Время события или содержательного свидетельства не подтверждено.'
      : now - meaningfulAt! > ttl ? 'Срок показа активной сцены истёк.'
      : 'Активность подтверждена содержательным свидетельством в пределах срока показа.';
    return {
      state: live.state,
      sourceKind: live.sourceKind,
      confidence: live.confidence,
      activityKind: live.activityKind,
      ongoing: live.ongoing,
      explicitActivity: live.explicitActivity,
      eventTime: live.eventTime,
      lastEvidenceAt: live.lastEvidenceAt,
      lastMeaningfulAt: live.lastMeaningfulAt,
      activityTtlMs: ttl,
      activityExpiresAt: ttl && meaningfulAt !== null ? meaningfulAt + ttl : null,
      activeActivity,
      terminal: TERMINAL.has(live.state),
      legacy: false,
      reason,
    };
  }

  const lifecycle = signal?.lifecycle;
  const state = normalizeLegacyState(lifecycle?.status);
  const meaningfulAt = timestamp(lifecycle?.asOf);
  const sourceValid = (() => { try { return ['http:', 'https:'].includes(new URL(lifecycle?.sourceUrl ?? '').protocol); } catch { return false; } })();
  const activeActivity = Boolean(lifecycle?.currentStatusVerified && lifecycle.animationEligible &&
    ['under_construction', 'not_applicable'].includes(lifecycle.status) && sourceValid && meaningfulAt !== null &&
    meaningfulAt <= now && now - meaningfulAt <= ACTIVITY_TTL_MS.construction);
  return {
    state,
    sourceKind: 'unknown',
    confidence: lifecycle?.currentStatusVerified ? 'high' : 'unknown',
    activityKind: lifecycle?.status === 'under_construction' ? 'construction' : 'generic',
    ongoing: activeActivity,
    explicitActivity: Boolean(lifecycle?.animationEligible),
    eventTime: lifecycle?.asOf ?? null,
    lastEvidenceAt: lifecycle?.asOf ?? null,
    lastMeaningfulAt: lifecycle?.asOf ?? null,
    activityTtlMs: ACTIVITY_TTL_MS.construction,
    activityExpiresAt: meaningfulAt === null ? null : meaningfulAt + ACTIVITY_TTL_MS.construction,
    activeActivity,
    terminal: TERMINAL.has(state),
    legacy: true,
    reason: activeActivity ? 'Совместимая подтверждённая активность из прежнего контракта.' : 'Прежний статус не подтверждает текущую активность.',
  };
}
