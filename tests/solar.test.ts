import test from 'node:test';
import assert from 'node:assert/strict';
import {getLightingState,getSceneTime} from '../src/lib/solar';
const september=new Date('2026-09-04T09:00:00Z');
test('Kazan civil time produces dawn, day, sunset and night on the same date',()=>{
  assert.equal(getLightingState(0,september).phase,'night');
  assert.equal(getLightingState(6,september).phase,'dawn');
  assert.equal(getLightingState(12,september).phase,'day');
  assert.equal(getLightingState(18,september).phase,'sunset');
  assert.ok(getLightingState(12,september).sunElevation>35);
  assert.ok(getLightingState(0,september).sunElevation<0);
});
test('automatic clock uses Moscow time and sunlight follows the season',()=>{
  assert.equal(getSceneTime({timeMode:'auto',hour:0,life:true},{date:september}).localHour,12);
  assert.equal(getSceneTime({timeMode:'manual',hour:18.25,life:true},{date:september}).localHour,18.25);
  assert.ok(getLightingState(6,new Date('2026-06-21T09:00:00Z')).sunElevation>0);
  assert.ok(getLightingState(6,new Date('2026-12-21T09:00:00Z')).sunElevation<0);
});
test('lighting is continuous across adjacent minutes and normalized after midnight',()=>{
  const a=getLightingState(18,september),b=getLightingState(18+1/60,september);
  assert.ok(Math.abs(a.brightness-b.brightness)<.02);
  assert.ok(Math.abs(a.nightAmount-b.nightAmount)<.04);
  assert.equal(getLightingState(24,september).localHour,0);
});
