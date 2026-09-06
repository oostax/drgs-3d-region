import test from 'node:test';
import assert from 'node:assert/strict';
import {activeSignalHighlightIds} from '../src/lib/map-signal-selection';

test('closing the signal context clears selected and hover highlight ids', () => {
  assert.deepEqual(activeSignalHighlightIds(true, 'selected', 'hovered'), ['selected', 'hovered']);
  assert.deepEqual(activeSignalHighlightIds(false, 'selected', 'hovered'), []);
  assert.deepEqual(activeSignalHighlightIds(false, null, 'hovered'), []);
});
