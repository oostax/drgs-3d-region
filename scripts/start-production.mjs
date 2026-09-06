import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(fs.existsSync(path.join(root,'.env.local')))process.loadEnvFile(path.join(root,'.env.local'));
const server=path.join(root,'.next','standalone','server.js');
if(!fs.existsSync(server))throw new Error('Сначала выполните npm run build');
// These links are public build assets only. Mutable/private data stays outside the bundle.
for(const [name,target] of [['public',path.join(root,'public')],['.next/static',path.join(root,'.next/static')]]) {
  const destination=path.join(path.dirname(server),name);
  const stat=fs.lstatSync(destination,{throwIfNoEntry:false});
  if(stat&&!stat.isSymbolicLink()){
    const backup=path.join(root,'private-data','backups','standalone-assets-'+Date.now(),name);
    fs.mkdirSync(path.dirname(backup),{recursive:true});fs.renameSync(destination,backup);
  } else if(stat?.isSymbolicLink()&&fs.readlinkSync(destination)!==target)fs.unlinkSync(destination);
  if(!fs.existsSync(destination)) {fs.mkdirSync(path.dirname(destination),{recursive:true});fs.symlinkSync(target,destination,'dir');}
}
const child=spawn(process.execPath,[server],{cwd:root,stdio:'inherit',env:{...process.env,ATLAS_APP_ROOT:process.env.ATLAS_APP_ROOT||root,ATLAS_DATA_ROOT:process.env.ATLAS_DATA_ROOT||root,PORT:process.env.PORT||'3200',HOSTNAME:'127.0.0.1'}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.once('exit',code=>process.exit(code??1));
