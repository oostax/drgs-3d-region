import test from 'node:test';
import assert from 'node:assert/strict';
import type { LiveActivityKind, LiveEventMeta, LiveEventState } from '../src/lib/live-types';
import { ACTIVITY_TTL_MS, normalizeSceneLifecycle } from '../src/lib/scene-lifecycle';

const now = Date.parse('2026-09-04T12:00:00Z');
const iso = (stamp: number) => new Date(stamp).toISOString();
const live = (changes: Partial<LiveEventMeta> = {}): LiveEventMeta => ({
  regionId: 'RU-TA', topic: 'Дороги', state: 'in_progress', severity: 'medium', confidence: 'low',
  sourceKind: 'community', eventTime: iso(now - 60_000), lastEvidenceAt: iso(now),
  lastMeaningfulAt: iso(now - 60_000), ongoing: true, locationConfidence: 'street',
  evidenceCount: 1, duplicateCount: 0, revision: 1, activityKind: 'road_repair', explicitActivity: true,
  notifyEligible: false,
  ...changes,
});

test('activity expiry uses the kind TTL and includes its exact boundary', () => {
  const cases: [LiveActivityKind, number][] = [
    ['road_defect', ACTIVITY_TTL_MS.acute],
    ['road_repair', ACTIVITY_TTL_MS.repair],
    ['construction', ACTIVITY_TTL_MS.construction],
  ];
  for (const [activityKind, ttl] of cases) {
    const lastMeaningfulAt = iso(now - ttl);
    const subject = live({ activityKind, eventTime: lastMeaningfulAt, lastMeaningfulAt });
    assert.equal(normalizeSceneLifecycle(subject, now).activeActivity, true, `${activityKind} at boundary`);
    assert.equal(normalizeSceneLifecycle(subject, now + 1).activeActivity, false, `${activityKind} after boundary`);
  }
});

test('a repost or spelling edit cannot extend activity beyond substantive evidence', () => {
  const lastMeaningfulAt = iso(now - ACTIVITY_TTL_MS.acute - 1);
  const result = normalizeSceneLifecycle(live({
    activityKind: 'fire', eventTime: lastMeaningfulAt, lastMeaningfulAt,
    lastEvidenceAt: iso(now), revision: 12,
  }), now);
  assert.equal(result.activeActivity, false);
  assert.equal(result.activityExpiresAt, Date.parse(lastMeaningfulAt) + ACTIVITY_TTL_MS.acute);
});

test('publisher origin and confidence do not decide whether explicit current work is active', () => {
  assert.equal(normalizeSceneLifecycle(live({ sourceKind: 'community', confidence: 'low' }), now).activeActivity, true);
  assert.equal(normalizeSceneLifecycle(live({ sourceKind: 'official', confidence: 'high' }), now).activeActivity, true);
});

test('only in-progress, ongoing, explicit activity can animate', () => {
  const states: LiveEventState[] = ['reported', 'planned', 'paused', 'resolved', 'cancelled', 'unknown'];
  for (const state of states) assert.equal(normalizeSceneLifecycle(live({ state }), now).activeActivity, false, state);
  assert.equal(normalizeSceneLifecycle(live({ ongoing: false }), now).activeActivity, false);
  assert.equal(normalizeSceneLifecycle(live({ explicitActivity: false }), now).activeActivity, false);
  assert.equal(normalizeSceneLifecycle(live({ eventTime: null }), now).activeActivity, false);
});
