import { appPath, appRoot, dataPath } from './runtime-paths';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {liveSources} from './live-store';
import type {LiveWorkerStatus} from './live-types';

export type LiveRefreshLaunch={accepted:boolean;mode:'queued'|'once'|'unavailable';message:string};
const runtime=globalThis as unknown as {atlasLiveRefreshStarting?:boolean};
function command(){
  const script=appPath('scripts','live','worker.py');
  if(!fs.existsSync(/* turbopackIgnore: true */ script))return null;
  const configured=process.env.ATLAS_LIVE_PYTHON;
  const bundled=dataPath('data','public','.venv','bin','python');
  return {python:configured||(fs.existsSync(/* turbopackIgnore: true */ bundled)?bundled:'python3'),script};
}
export function liveWorkerProcessActive(status:LiveWorkerStatus,lockPath=dataPath('data','live','worker.lock')){
  if(!['idle','running','starting'].includes(status.state)||!status.heartbeatAt)return false;
  const heartbeat=Date.parse(status.heartbeatAt);if(!Number.isFinite(heartbeat)||Date.now()-heartbeat>180_000)return false;
  try{const pid=Number(JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ lockPath,'utf8')).pid);if(!Number.isInteger(pid)||pid<=0)return false;process.kill(pid,0);return true;}catch{return false;}
}
/** The fixed local command accepts no URL or content from the request. */
export function launchLiveRefresh():LiveRefreshLaunch{
  const executable=command();if(!executable)return {accepted:false,mode:'unavailable',message:'Сборщик источников ещё не установлен.'};
  const active=liveWorkerProcessActive(liveSources().worker),mode=active?'queued':'once';
  if(runtime.atlasLiveRefreshStarting)return {accepted:true,mode,message:'Запуск уже поставлен в очередь.'};
  runtime.atlasLiveRefreshStarting=true;
  const child=spawn(executable.python,[executable.script,active?'--enqueue':'--once'],{cwd:appRoot,stdio:'ignore',env:process.env});
  child.once('error',()=>{runtime.atlasLiveRefreshStarting=false;});
  child.once('close',()=>{runtime.atlasLiveRefreshStarting=false;});
  child.unref();
  return {accepted:true,mode,message:active?'Проверка источников добавлена в очередь.':'Запущена проверка доступных источников.'};
}
