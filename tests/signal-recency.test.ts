import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySignalRecency } from '../src/lib/signal-recency';
import { groupIncidentGeography } from '../src/lib/incident-geography';
import type { LiveEventMeta } from '../src/lib/live-types';

const asOf = '2026-09-04';
const live = (changes: Partial<LiveEventMeta> = {}): LiveEventMeta => ({
  regionId:'RU-TA',topic:'Дороги',state:'reported',severity:'medium',confidence:'low',sourceKind:'community',
  eventTime:'2026-07-21T08:00:00Z',lastEvidenceAt:'2026-09-04T08:00:00Z',lastMeaningfulAt:'2026-07-21T08:00:00Z',
  ongoing:true,locationConfidence:'street',evidenceCount:1,duplicateCount:0,revision:2,activityKind:'road_defect',
  explicitActivity:false,notifyEligible:false,...changes,
});
test('publication window ignores a fresh download and preserves its boundary', () => {
  const old = { publishedAt: '2026-07-01', checkedAt: asOf };
  assert.equal(classifySignalRecency(old, asOf).bucket, 'archive');
  assert.equal(classifySignalRecency({ publishedAt: '2026-08-05' }, asOf).bucket, 'active');
  assert.equal(classifySignalRecency({ publishedAt: '2026-08-04' }, asOf).visibleByDefault, false);
});

test('active construction requires a fresh affirmative source verification', () => {
  const signal = { publishedAt: '2026-03-01', lifecycle: { status: 'under_construction', asOf: '2026-08-25', sourceUrl: 'https://example.gov/news/1', currentStatusVerified: true } };
  assert.equal(classifySignalRecency(signal, asOf).bucket, 'active');
  assert.equal(classifySignalRecency({ ...signal, lifecycle: { ...signal.lifecycle, currentStatusVerified: false } }, asOf).bucket, 'archive');
  assert.equal(classifySignalRecency({ ...signal, lifecycle: { ...signal.lifecycle, asOf: '2026-06-01' } }, asOf).bucket, 'archive');
  assert.equal(classifySignalRecency({ ...signal, lifecycle: { ...signal.lifecycle, sourceUrl: '' } }, asOf).bucket, 'archive');
});

test('recent resolution expires from the completion date, not later republication', () => {
  const done = { publishedAt: '2026-09-02', lifecycle: { status: 'completed', asOf: '2026-08-21' } };
  assert.equal(classifySignalRecency(done, asOf).bucket, 'recent-resolved');
  assert.equal(classifySignalRecency({ ...done, lifecycle: { ...done.lifecycle, asOf: '2026-08-20' } }, asOf).bucket, 'archive');
  assert.equal(classifySignalRecency({ publishedAt: '2026-07-01', closedAt: '2026-07-31' }, asOf).bucket, 'archive');
});

test('missing, impossible and future dates are excluded even with fresh lifecycle', () => {
  for (const publishedAt of ['', '2026-02-30', '2026-09-05', 'September 4 2026']) {
    const result = classifySignalRecency({ publishedAt, lifecycle: { status: 'under_construction', asOf, currentStatusVerified: true, sourceUrl: 'https://example.gov/' } }, asOf);
    assert.equal(result.bucket, 'undated');
    assert.equal(result.visibleByDefault, false);
  }
  assert.equal(classifySignalRecency({ publishedAt: '2026-09-01', closedAt: '2026-09-05' }, asOf).visibleByDefault, false);
});

test('observation day follows Moscow time and never mutates stored signals', () => {
  const signal = Object.freeze({ publishedAt: '2026-09-05' });
  assert.equal(classifySignalRecency(signal, '2026-09-04T22:00:00Z').bucket, 'active');
  assert.equal(signal.publishedAt, '2026-09-05');
  assert.throws(() => classifySignalRecency(signal, '2026-02-30'), RangeError);
  assert.throws(() => classifySignalRecency(signal, asOf, { newsDays: 365 }), RangeError);
});

test('mixed historical aggregate retains closed counts without claiming every record resolved', () => {
  const group = groupIncidentGeography([
    { municipality: 'Казань', topic_group: 'Дороги', count: 2, closedCount: 2, lastClosedAt: '2026-07-14' },
    { municipality: 'Казань', topic_group: 'Дороги', count: 3, closedCount: 1, lastClosedAt: '2026-07-20' },
  ], null).groups[0];
  assert.equal(group.count, 5);
  assert.equal(group.closedCount, 3);
  assert.equal(group.lastClosedAt, '2026-07-20');
  assert.notEqual(group.closedCount, group.count);
});

test('live visibility supports only 30, 45 and 60 day windows and ignores a fresh repost', () => {
  const signal={publishedAt:'2026-07-21',live:live()};
  assert.equal(classifySignalRecency(signal,asOf,{newsDays:30}).bucket,'archive');
  assert.equal(classifySignalRecency(signal,asOf,{newsDays:45}).bucket,'active');
  assert.equal(classifySignalRecency(signal,asOf,{newsDays:60}).bucket,'active');
  const repost={publishedAt:'2026-09-04',live:live({lastMeaningfulAt:'2026-07-20T08:00:00Z'})};
  assert.equal(classifySignalRecency(repost,asOf,{newsDays:30}).bucket,'archive');
  assert.throws(()=>classifySignalRecency(signal,asOf,{newsDays:31}),RangeError);
});

test('live resolutions use a fourteen day window and verification origin remains separate', () => {
  const resolved=(lastMeaningfulAt:string)=>({publishedAt:'2026-09-04',live:live({state:'resolved',lastMeaningfulAt})});
  assert.equal(classifySignalRecency(resolved('2026-08-21T08:00:00Z'),asOf).bucket,'recent-resolved');
  assert.equal(classifySignalRecency(resolved('2026-08-20T08:00:00Z'),asOf).bucket,'archive');
  const current={state:'in_progress',lastMeaningfulAt:'2026-09-04T08:00:00Z'} as const;
  assert.equal(classifySignalRecency({publishedAt:'2026-09-04',live:live({...current,ongoing:true})},asOf).bucket,'active');
  assert.equal(classifySignalRecency({publishedAt:'2026-09-04',live:live({...current,ongoing:false})},asOf).bucket,'archive');
});

test('future and old plans remain visible without pretending work is underway',()=>{
  for(const eventTime of ['2026-10-12T14:30:00+03:00','2026-07-01']){
    const result=classifySignalRecency({publishedAt:'2026-06-01',live:live({state:'planned',eventTime,lastMeaningfulAt:'2026-06-01'})},asOf);
    assert.equal(result.visibleByDefault,true);
    assert.match(result.label,/Запланировано/);
  }
});
