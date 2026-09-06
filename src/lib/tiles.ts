import { publicDataPath } from './runtime-paths';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export function parseRange(header:string|null,size:number):{start:number;end:number}|null {
  if(!header)return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match||(!match[1]&&!match[2]))throw new Error('Invalid range');
  let start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  let end=match[1]?(match[2]?Number(match[2]):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new Error('Invalid range');
  end=Math.min(end,size-1);return {start,end};
}
export function tileResponse(req:Request,head=false){
  const candidates=['tatarstan-buildings.pmtiles','buildings.pmtiles'];
  const name=candidates.find(n=>fs.existsSync(/* turbopackIgnore: true */ publicDataPath(n)));
  if(!name)return new Response('Набор зданий ещё не загружен',{status:404});
  const file=publicDataPath(name);const size=fs.statSync(/* turbopackIgnore: true */ file).size;
  const headers:Record<string,string>={'Content-Type':'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600','Content-Length':String(size)};
  try{
    const range=parseRange(req.headers.get('range'),size);
    if(range){headers['Content-Range']=`bytes ${range.start}-${range.end}/${size}`;headers['Content-Length']=String(range.end-range.start+1);}
    const body=head?null:Readable.toWeb(fs.createReadStream(/* turbopackIgnore: true */ file,range||undefined)) as ReadableStream;
    return new Response(body,{status:range?206:200,headers});
  }catch{return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});}
}
