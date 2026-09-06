import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cameraTerritory, geometryContains, territoryScopeIds } from '../src/lib/map-camera-scope';
import type { FeatureCollection } from 'geojson';
import type { Territory } from '../src/lib/types';

const boundaries = JSON.parse(fs.readFileSync('public/data/tatarstan-boundaries.geojson', 'utf8')) as FeatureCollection;
const territories = boundaries.features.map(f => ({id:f.properties!.territoryId, kind:f.properties!.kind, parentId:f.properties!.parentId})) as Territory[];
test('camera follows Kazan and Upper Uslon using municipal polygons, independently of clicks', () => {
  assert.equal(cameraTerritory([49.12,55.79], 12, territories, boundaries), 'mo-92701000');
  const uslon = cameraTerritory([48.982,55.767], 12, territories, boundaries);
  assert.equal(territories.find(t => t.id === uslon)?.kind, 'district');
  assert.notEqual(uslon, 'mo-92701000');
  assert.equal(cameraTerritory([49.12,55.79], 6, territories, boundaries, uslon!), 'RU-TA');
  assert.equal(cameraTerritory([37.62,55.75], 12, territories, boundaries), null);
});
test('zoom hysteresis and polygon holes do not invent geographic membership', () => {
  assert.equal(cameraTerritory([49.12,55.79], 7.5, territories, boundaries), 'RU-TA');
  assert.equal(cameraTerritory([49.12,55.79], 7.5, territories, boundaries, 'mo-92701000'), 'mo-92701000');
  assert.equal(geometryContains({type:'Polygon',coordinates:[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[3,1],[3,3],[1,3],[1,1]]]}, [2,2]), false);
  assert.equal(territoryScopeIds(territories, 'RU-TA').size, territories.length);
});
