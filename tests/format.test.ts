import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationDateTime,shortDateTime} from '../src/lib/format';

test('signal timestamps show Moscow time and never invent midnight for date-only data',()=>{
  assert.match(shortDateTime('2026-09-05T08:48:00Z'),/11:48 МСК$/);
  assert.match(shortDateTime('2026-07-05 14:32:00'),/14:32 МСК$/);
  assert.match(shortDateTime('2026-09-05'),/время не указано$/);
  assert.match(shortDateTime('2026-09-04T21:00:00+03:00'),/21:00 МСК$/);
  assert.match(shortDateTime('2026-09-05T00:00:00+03:00'),/00:00 МСК$/);
});

test('publication timestamps use complete Russian labels without inventing a time',()=>{
  assert.equal(publicationDateTime('2026-09-05T08:48:00Z'),'5 сентября 2026 г. · 11:48 МСК');
  assert.equal(publicationDateTime('2026-09-05'),'5 сентября 2026 г. · время не указано');
});
