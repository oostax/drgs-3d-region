import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveRuntimeRoots} from '../src/lib/runtime-paths';

test('standalone and checkout share mutable data, explicit paths win', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-paths-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'scripts'));fs.writeFileSync(path.join(root,'scripts/import_xlsx.py'),'');
  assert.equal(resolveRuntimeRoots(path.join(root,'.next/standalone'),{}).dataRoot,root);
  assert.deepEqual(resolveRuntimeRoots('/deployment',{ATLAS_DATA_ROOT:root,ATLAS_APP_ROOT:'/application'}),{dataRoot:root,appRoot:'/application'});
  assert.throws(()=>resolveRuntimeRoots(root,{ATLAS_DATA_ROOT:'relative'}),/абсолютным/);
});

test('reading an absent private database never creates it', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-missing-db-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  process.env.ATLAS_DB=path.join(root,'missing.sqlite');
  const {db,LocalDataUnavailable}=await import('../src/lib/db');
  assert.throws(()=>db(),LocalDataUnavailable);
  assert.equal(fs.existsSync(process.env.ATLAS_DB),false);
  const created=db({create:true});assert.ok(fs.existsSync(process.env.ATLAS_DB));created.close();
});
