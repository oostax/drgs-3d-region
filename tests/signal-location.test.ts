import assert from 'node:assert/strict';
import test from 'node:test';
import { signalHasVerifiedMapLocation } from '../src/lib/signal-location';

const location = (changes: Record<string, unknown> = {}) => ({
  address: 'Казань, улица Баумана, 1',
  coordinates: [49.1064, 55.7963] as [number, number],
  precision: 'building' as const,
  ...changes,
});

test('allows an evidenced building, site, or street location', () => {
  for (const precision of ['building', 'site', 'street'] as const) {
    assert.equal(signalHasVerifiedMapLocation(location({ precision })), true);
  }
});

test('rejects municipality and settlement centroids even when they have labels', () => {
  for (const precision of ['territory', 'settlement'] as const) {
    assert.equal(signalHasVerifiedMapLocation(location({ precision })), false);
  }
});

test('rejects coordinates without an address and addresses without coordinates', () => {
  assert.equal(signalHasVerifiedMapLocation(location({ address: '  ' })), false);
  assert.equal(signalHasVerifiedMapLocation(location({ coordinates: null })), false);
  assert.equal(signalHasVerifiedMapLocation(location({ coordinates: [999, 55] })), false);
});
