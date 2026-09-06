import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {GET,POST} from '../src/app/api/[...path]/route';

const context=(...path:string[])=>({params:Promise.resolve({path})});
test('live signal endpoint uses the versioned envelope in public mode',async()=>{
  const response=await GET(new NextRequest('http://atlas.example/api/signals?mode=public&days=45'),context('signals'));
  assert.equal(response.status,200);assert.match(response.headers.get('etag')||'',/^W\/"live-/);
  const body=await response.json();assert.ok(Array.isArray(body.signals));assert.equal(typeof body.cursor,'string');assert.ok(['idle','running','offline','error'].includes(body.worker.state));
});
test('private relevance and refresh cannot be exposed by forcing public mode',async()=>{
  const relevance=await GET(new NextRequest('http://atlas.example/api/work/signal-relevance?mode=public&signalId=x'),context('work','signal-relevance'));
  assert.equal(relevance.status,403);
  const refresh=await POST(new NextRequest('http://atlas.example/api/sources/refresh?mode=public',{method:'POST'}),context('sources','refresh'));
  assert.equal(refresh.status,403);
});
