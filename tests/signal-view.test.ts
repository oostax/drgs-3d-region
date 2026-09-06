import test from 'node:test';
import assert from 'node:assert/strict';
import {signalMatchesFlow,signalVisibleInView,periodForSignalState,stateForSignalPeriod} from '../src/lib/signal-view';
import {completeLiveSnapshot} from '../src/lib/live-pagination';
import type {Signal} from '../src/lib/types';
import type {LiveSignalsResponse} from '../src/lib/live-types';

test('status and time navigation do not trap the user in contradictory filters',()=>{
  assert.equal(stateForSignalPeriod('resolved'),'resolved');
  assert.equal(stateForSignalPeriod('archive'),'all');
  assert.equal(stateForSignalPeriod('current'),'all');
  for(const state of ['in_progress','planned','paused','resolved','cancelled','all'])
    assert.equal(periodForSignalState('archive',state),'archive');
  assert.equal(periodForSignalState('current','resolved'),'resolved');
  assert.equal(periodForSignalState('resolved','in_progress'),'current');
  assert.equal(periodForSignalState('resolved','all'),'current');
});

test('the selected 30/45/60 day window is actually used by the map',()=>{
  const signal={id:'news',publishedAt:'2026-07-31',visibility:'public'} as Signal;
  for(const [days,visible] of [[30,false],[45,true],[60,true]] as const)
    assert.equal(signalVisibleInView(signal,'2026-09-05',{period:'current',days,residentReports:false}),visible);
});
test('July resident reports are a separate historical layer with unchanged lifecycle',()=>{
  const signal={id:'incident:x',publishedAt:'2026-07-01',closedAt:'2026-07-08',visibility:'private',count:941} as Signal;
  assert.equal(signalVisibleInView(signal,'2026-09-05',{period:'current',days:45,residentReports:true}),true);
  assert.equal(signalVisibleInView(signal,'2026-09-05',{period:'current',days:45,residentReports:false}),false);
  assert.equal(signal.closedAt,'2026-07-08');
  assert.equal(signal.live,undefined);
});
test('initial snapshots include events beyond the first transport page and catch paging revisions',async()=>{
  const controller=new AbortController(),offsets:number[]=[];
  const first={signals:[{id:'one'},{id:'two'}],cursor:'10',total:4,hasMore:true} as LiveSignalsResponse;
  const full=await completeLiveSnapshot(first,async offset=>{offsets.push(offset);return {signals:[{id:'three'},{id:'kazan-road'}],cursor:'11',total:4,hasMore:false} as LiveSignalsResponse},controller.signal);
  assert.deepEqual(full.signals.map(s=>s.id),['one','two','three','kazan-road']);
  assert.equal(full.cursor,'10');assert.equal(full.hasMore,false);assert.deepEqual(offsets,[2]);
  controller.abort();
  await assert.rejects(()=>completeLiveSnapshot(first,async()=>{throw new Error('stale scope must not fetch')},controller.signal),{name:'AbortError'});
});

 test('resident open and accepted complaints participate in the matching flows',()=>{
  const signal={id:'incident:x',visibility:'private',residentReport:{openCount:4,inProgressCount:1,closedCount:2,firstAt:null,lastAt:null}} as Signal;
  for(const flow of ['all','complaints','work','results'] as const)assert.equal(signalMatchesFlow(signal,flow),true);
  assert.equal(signalMatchesFlow({...signal,residentReport:{...signal.residentReport!,inProgressCount:0}},'work'),false);
});
