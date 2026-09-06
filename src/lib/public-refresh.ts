import { appPath, appRoot, dataPath } from './runtime-paths';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';

export type PublicRefreshStatus = {
  status:'idle'|'running'|'complete'|'error'; startedAt:string|null; completedAt:string|null;
  lastSuccessAt:string|null; message:string; added:number; total:number;
  successfulSources:number; failedSources:number; nextRefreshAt:string|null;
};
type StoredStatus = PublicRefreshStatus & {workerPid?:number; workerIdentity?:string|null};
type DiscoveryReport = {startedAt?:string; completedAt?:string; lastSuccessAt?:string|null; added?:number; total?:number;
  sources?:{status?:string; lastSuccessAt?:string; lastAttemptAt?:string}[]};
type Runtime = {active:boolean; timer:ReturnType<typeof setInterval>|null; nextRefreshAt:string|null};
const globalRuntime=globalThis as unknown as {atlasPublicRefresh?:Runtime};
const runtime=globalRuntime.atlasPublicRefresh??={active:false,timer:null,nextRefreshAt:null};
const folder=dataPath('data','public');
const statusFile=path.join(folder,'public-refresh-status.json');
const reportFile=path.join(folder,'news-discovery.json');
const intervalMs=60*60*1000;

function read<T>(file:string,fallback:T):T {
  try{return JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file,'utf8')) as T;}catch{return fallback;}
}
function write(value:StoredStatus) {
  fs.mkdirSync(folder,{recursive:true});
  const temporary=`${statusFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(value));
  fs.renameSync(temporary,statusFile);
}
function identity(pid:number|undefined):string|null {
  if(!pid||!Number.isSafeInteger(pid))return null;
  try{
    process.kill(pid,0);
    return execFileSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:1000}).trim()||null;
  }catch{return null;}
}
function initial():StoredStatus {
  const report=read<DiscoveryReport>(reportFile,{});
  return {status:'idle',startedAt:null,completedAt:report.completedAt??null,lastSuccessAt:report.lastSuccessAt??null,
    message:'Официальные ленты можно проверить сейчас. Сохранённые материалы доступны на карте.',
    added:0,total:report.total??0,successfulSources:0,failedSources:0,nextRefreshAt:runtime.nextRefreshAt};
}
function settle(previous:StoredStatus,processSucceeded:boolean):StoredStatus {
  const report=read<DiscoveryReport>(reportFile,{});
  const fresh=Boolean(report.completedAt&&previous.startedAt&&report.completedAt>=previous.startedAt);
  const successful=fresh?(report.sources??[]).filter(source=>source.status==='ok').length:0;
  const failed=fresh?(report.sources??[]).filter(source=>['unavailable','stale'].includes(source.status??'')).length:0;
  const success=processSucceeded&&fresh&&successful>0;
  const result:StoredStatus={status:success?'complete':'error',startedAt:previous.startedAt,completedAt:new Date().toISOString(),
    lastSuccessAt:report.lastSuccessAt??previous.lastSuccessAt,
    message:success?(failed?'Новые публикации проверены. Часть лент временно недоступна; их сохранённые материалы остались на карте.':'Официальные ленты проверены. Доступные новые публикации добавлены.'):
      'Не удалось обновить официальные ленты. Сохранённые материалы остались на карте; повторите проверку позже.',
    added:fresh?report.added??0:0,total:report.total??previous.total,successfulSources:successful,failedSources:failed,
    nextRefreshAt:runtime.nextRefreshAt};
  write(result);return result;
}
function current():StoredStatus {
  const stored=read<StoredStatus>(statusFile,initial());
  if(stored.status==='running'&&!runtime.active){
    const observed=identity(stored.workerPid);
    if(!observed||(stored.workerIdentity&&observed!==stored.workerIdentity))return settle(stored,true);
  }
  return stored;
}
function schedule() {
  // Only runs in the local server process after this feature is used. No OS or
  // cloud scheduler, no credentials and no user-supplied upstream addresses.
  if(runtime.timer)return;
  runtime.nextRefreshAt=new Date(Date.now()+intervalMs).toISOString();
  runtime.timer=setInterval(()=>{
    runtime.nextRefreshAt=new Date(Date.now()+intervalMs).toISOString();
    launchPublicRefresh();
  },intervalMs);
  runtime.timer.unref?.();
}
function publicStatus(value:StoredStatus):PublicRefreshStatus {
  // Keep process paths, IDs and diagnostic output out of the public response.
  return {status:value.status,startedAt:value.startedAt,completedAt:value.completedAt,lastSuccessAt:value.lastSuccessAt,
    message:value.message,added:value.added,total:value.total,successfulSources:value.successfulSources,
    failedSources:value.failedSources,nextRefreshAt:runtime.nextRefreshAt};
}
export function getPublicRefreshStatus():PublicRefreshStatus {
  schedule();return publicStatus(current());
}
export const publicRefreshStatus=getPublicRefreshStatus;

export function launchPublicRefresh():PublicRefreshStatus {
  schedule();
  const previous=current();
  if(previous.status==='running')return publicStatus(previous);
  // A repeated click does not launch overlapping downloads.
  if(previous.completedAt&&previous.status!=='idle'&&Date.now()-Date.parse(previous.completedAt)<30_000)return publicStatus(previous);
  const script=appPath('scripts','fetch_public_data.py');
  const python=path.join(folder,'.venv','bin','python');
  if(!fs.existsSync(/* turbopackIgnore: true */ script)||!fs.existsSync(/* turbopackIgnore: true */ python)){
    const unavailable:StoredStatus={...previous,status:'error',startedAt:null,completedAt:new Date().toISOString(),
      message:'Локальный модуль обновления ещё не подготовлен. Сохранённые материалы доступны.'};
    write(unavailable);return publicStatus(unavailable);
  }
  const started:StoredStatus={...previous,status:'running',startedAt:new Date().toISOString(),completedAt:null,added:0,
    successfulSources:0,failedSources:0,message:'Проверяем официальные ленты и сохраняем новые публикации.'};
  runtime.active=true;write(started);
  // This command only reads the public registry/feeds and writes public caches.
  // It never accepts a URL, a file upload or private workbook content.
  const child=spawn(python,[script,'--news','--refresh'],{cwd:appRoot,stdio:'ignore'});
  let finished=false;
  const finish=(success:boolean)=>{if(finished)return;finished=true;runtime.active=false;settle(started,success);};
  child.once('spawn',()=>{
    started.workerPid=child.pid;started.workerIdentity=identity(child.pid);write(started);
  });
  child.once('error',()=>finish(false));
  child.once('close',code=>finish(code===0));
  return publicStatus(started);
}
