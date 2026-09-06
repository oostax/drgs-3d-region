import test from 'node:test';
import assert from 'node:assert/strict';
import {countNotifiableChanges,mergeSignalChanges} from '../src/components/use-live-signals';
import type {Signal} from '../src/lib/types';

const signal=(id:string,publishedAt:string,title=id)=>({id,title,publishedAt,summary:'',category:'roads',territoryId:'RU-TA',coordinates:null,precision:'territory',sourceUrl:'https://example.test/'+id,checkedAt:publishedAt,facts:[],hypothesis:'',nextStep:'',visibility:'public'} satisfies Signal);

test('live deltas replace revisions, remove items that left scope, and stay deterministic',()=>{
  const current=[signal('old','2026-09-01'),signal('changed','2026-09-02','before')];
  const result=mergeSignalChanges(current,[signal('new','2026-09-04'),signal('changed','2026-09-03','after')],['old']);
  assert.deepEqual(result.map(item=>item.id),['new','changed']);
  assert.equal(result[1].title,'after');
  assert.equal(current[1].title,'before');
});

test('replaying a delta is idempotent',()=>{
  const delta=[signal('event','2026-09-04','revision 2')];
  const once=mergeSignalChanges([signal('event','2026-09-03','revision 1')],delta,[]);
  assert.deepEqual(mergeSignalChanges(once,delta,[]),once);
});

test('only explicitly eligible delta upserts create a notification count',()=>{
  const ordinary=signal('ordinary','2026-09-04');
  const eligible={...signal('eligible','2026-09-04'),live:{notifyEligible:true} as Signal['live']};
  const suppressed={...signal('suppressed','2026-09-04'),live:{notifyEligible:false} as Signal['live']};
  assert.equal(countNotifiableChanges([ordinary,eligible,suppressed]),1);
});
