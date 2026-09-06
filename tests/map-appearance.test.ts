import test from 'node:test';
import assert from 'node:assert/strict';
import type { Map as LibreMap } from 'maplibre-gl';
import { applyMapLighting } from '../src/lib/map-appearance';
import { getSceneTime } from '../src/lib/solar';

test('queued lighting update ignores a removed map before touching its renderer or the DOM', () => {
  const removedMap = new Proxy({}, {
    get(_target, key) {
      if (key === 'getStyle') return () => undefined;
      throw new Error(`Removed map must not receive ${String(key)}`);
    },
  }) as LibreMap;
  const state = getSceneTime({timeMode: 'manual', hour: 18, life: true});
  assert.doesNotThrow(() => applyMapLighting(removedMap, state));
});
