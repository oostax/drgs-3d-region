import { test } from 'node:test';
import assert from 'node:assert/strict';
import { territoryPriorities } from '../src/lib/territory-priorities';
import type { BankOffice, Signal, Territory } from '../src/lib/types';

const asOf = '2026-09-04';
const polygon = (min: number, max: number): GeoJSON.Polygon => ({ type: 'Polygon', coordinates: [[[min, min], [max, min], [max, max], [min, max], [min, min]]] });
const region: Territory = { id: 'region', name: 'Регион', kind: 'region', parentId: null, center: [5, 5], geometry: polygon(0, 10), geometryStatus: 'ok', sourceUrl: 'https://example.org/region' };
const town: Territory = { ...region, id: 'town', name: 'Город', kind: 'urban_district', parentId: 'region', geometry: polygon(1, 4), center: [2, 2] };
const towns = [region, town];
const office = (id: string, bank = 'sber', overrides: Partial<BankOffice> = {}): BankOffice => ({ id, bank, name: 'Публичная точка', address: `Город, улица Тестовая, дом ${id}`, territoryId: 'town', coordinates: [2, 2], precision: 'building', sourceUrl: `https://example.org/bank/${id}`, coordinateSourceUrl: `https://example.org/point/${id}`, checkedAt: asOf, ...overrides });
const signal = (id: string, overrides: Partial<Signal> = {}): Signal => ({ id, title: 'Проект школы', summary: 'Публичная публикация', category: 'construction', territoryId: 'town', coordinates: null, precision: 'territory', sourceUrl: `https://example.org/news/${id}`, publishedAt: '2026-08-01', checkedAt: asOf, facts: [], hypothesis: '', nextStep: '', visibility: 'public', ...overrides });
const result = (signals: Signal[], offices: BankOffice[], territories = towns) => territoryPriorities(signals, offices, territories, { asOf });
const townResult = (signals: Signal[], offices: BankOffice[]) => result(signals, offices).find(item => item.id === 'town')!;

test('CBR/OSM evidence deduplicates the same bank location, but colocated competitors stay separate', () => {
  const a = office('cbr', 'sber', { address: 'Город, улица Тестовая, дом 4' });
  const b = office('osm', 'Сбербанк', { coordinates: [2.00001, 2.00001], address: 'Город, ул. Тестовая, д. 4' });
  const c = office('registry-no-point', 'sber', { coordinates: null, address: a.address });
  const other = office('vtb', 'vtb', { address: a.address });
  const p = townResult([], [a, b, c, other]);
  assert.equal(p.numbers.verifiedLocations, 2);
  assert.equal(p.numbers.verifiedSberLocations, 1);
  assert.equal(p.numbers.verifiedCompetitorLocations, 1);
  assert.equal(p.numbers.duplicatesRemoved, 2);
  assert.equal(p.numbers.unlocatedBankRecords, 0);
});

test('missing, unsourced, approximate and outside points never become bank absence or nearest-territory assignments', () => {
  const p = townResult([signal('project')], [office('missing', 'sber', { coordinates: null }), office('unsourced', 'vtb', { sourceUrl: '' }), office('street', 'vtb', { precision: 'street' }), office('outside', 'sber', { territoryId: null, coordinates: [50, 50] })]);
  assert.equal(p.level, 'insufficient');
  assert.equal(p.score, null);
  assert.equal(p.numbers.verifiedSberLocations, null);
  assert.equal(p.numbers.verifiedCompetitorLocations, null);
  assert.equal(p.numbers.unlocatedBankRecords, 3);
  assert.equal(p.numbers.globalUnassignedBankRecords, 1);
  assert.ok(p.facts[0].includes('не означает отсутствие'));
});

test('shared missing-address labels and conflicting far-apart coordinates never collapse a whole bank network', () => {
  const unknownAddress = 'Адрес не указан в OSM; положение отмечено участниками карты';
  const p = townResult([], [office('a', 'sber', { address: unknownAddress }), office('b', 'sber', { address: unknownAddress, coordinates: [2.1, 2.1] }),
    office('c', 'vtb', { address: 'Город, улица Тестовая, дом 4' }), office('d', 'vtb', { address: 'Город, улица Тестовая, дом 4', coordinates: [3, 3] })]);
  assert.equal(p.numbers.verifiedLocations, 4);
  assert.equal(p.numbers.duplicatesRemoved, 0);
});

test('point-in-polygon respects holes, explicit territory scope and parent rollups without spreading regional news', () => {
  const holeTown: Territory = { ...town, geometry: { type: 'MultiPolygon', coordinates: [[[[1, 1], [4, 1], [4, 4], [1, 4], [1, 1]], [[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]]] } };
  const p = result([signal('regional', { territoryId: 'region' })], [office('town-point', 'sber', { territoryId: null, coordinates: [1.5, 1.5] }), office('hole-point', 'vtb', { territoryId: null, coordinates: [2.5, 2.5] })], [region, holeTown]);
  assert.equal(p.find(item => item.id === 'town')!.numbers.verifiedLocations, 1);
  assert.equal(p.find(item => item.id === 'town')!.numbers.recentOpportunitySignals, 0);
  assert.equal(p.find(item => item.id === 'region')!.numbers.verifiedLocations, 2);
  assert.equal(p.find(item => item.id === 'region')!.numbers.recentOpportunitySignals, 1);
});

test('recent projects produce review actions, with limited observed Sber geography distinguished from market share', () => {
  const attention = townResult([signal('new')], [office('other', 'vtb')]);
  assert.equal(attention.level, 'attention');
  assert.equal(attention.numbers.verifiedSberLocations, 0);
  assert.equal(attention.score, 4);
  assert.equal(attention.confidence, 'low');
  assert.ok(attention.facts.some(fact => fact.includes('текущая стадия не подтверждена')));
  assert.ok(attention.note.includes('не проценты'));
  const develop = townResult([signal('new')], [office('a'), office('b', 'sber', { coordinates: [2.1, 2.1] })]);
  assert.equal(develop.level, 'develop');
  assert.ok(develop.nextStep.includes('Потребность в продукте ещё не подтверждена'));
});

test('old publications, a fresh discovery timestamp, future dates and completed projects do not assert active construction', () => {
  const old = signal('old', { publishedAt: '2024-01-01', checkedAt: asOf });
  const completed = signal('complete', { lifecycle: { status: 'completed', asOf: '2026-08-01', sourceUrl: 'https://example.org/completed', currentStatusVerified: true, animationEligible: false, note: '' } });
  const p = townResult([old, signal('future', { publishedAt: '2027-01-01' }), completed], [office('a')]);
  assert.equal(p.level, 'presence');
  assert.equal(p.score, 1);
  assert.equal(p.numbers.recentOpportunitySignals, 0);
  assert.equal(p.numbers.historicalOpportunitySignals, 1);
  assert.equal(p.numbers.undatedOpportunitySignals, 1);
  assert.equal(p.numbers.completedProjectSignals, 1);
  assert.ok(p.facts.some(fact => fact.includes('2024-01-01')));
  assert.equal(p.numbers.currentStatusVerifiedSignals, 0);
  const stale = townResult([], [office('stale', 'sber', { checkedAt: '2020-01-01' })]);
  assert.equal(stale.level, 'insufficient');
  assert.equal(stale.numbers.staleBankRecords, 1);
});

test('only dated lifecycle evidence can refresh an old project and private/duplicate signals do not affect scores', () => {
  const verified = signal('old-current', { publishedAt: '2020-01-01', lifecycle: { status: 'under_construction', asOf: '2026-08-31', sourceUrl: 'https://example.org/current-evidence', currentStatusVerified: true, animationEligible: true, note: '' } });
  const inputs = [verified, { ...verified, id: 'duplicate' }, signal('private', { visibility: 'private', title: 'PrivateFixture' })];
  const before = JSON.stringify(inputs);
  const p = townResult(inputs, [office('a')]);
  assert.equal(p.numbers.recentOpportunitySignals, 1);
  assert.equal(p.numbers.currentStatusVerifiedSignals, 1);
  assert.equal(p.score, 4);
  assert.equal(p.confidence, 'medium');
  assert.equal(JSON.stringify(p).includes('PrivateFixture'), false);
  assert.equal(JSON.stringify(inputs), before);
  assert.throws(() => territoryPriorities([], [], [], { asOf: 'not-a-date' }));
});
