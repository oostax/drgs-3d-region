import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {liveWorkerProcessActive} from '../src/lib/live-refresh';
import type {LiveWorkerStatus} from '../src/lib/live-types';

const status=(state:LiveWorkerStatus['state'],heartbeatAt=new Date().toISOString()):LiveWorkerStatus=>({state,heartbeatAt,lastSuccessAt:null,queueDepth:0,analysisQueueDepth:0,lagSeconds:0,message:''});

test('a fresh idle daemon receives refresh through the shared queue',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'atlas-live-refresh-')),lock=path.join(folder,'worker.lock');
  try{writeFileSync(lock,JSON.stringify({pid:process.pid}));assert.equal(liveWorkerProcessActive(status('idle'),lock),true);}
  finally{rmSync(folder,{recursive:true,force:true});}
});

test('stale heartbeat or dead worker falls back to a one-shot refresh',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'atlas-live-refresh-')),lock=path.join(folder,'worker.lock');
  try{
    writeFileSync(lock,JSON.stringify({pid:process.pid}));assert.equal(liveWorkerProcessActive(status('idle',new Date(Date.now()-181_000).toISOString()),lock),false);
    writeFileSync(lock,JSON.stringify({pid:999_999_999}));assert.equal(liveWorkerProcessActive(status('running'),lock),false);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
