import {dataPath} from './runtime-paths';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
type Asset={bytes:Buffer;type:string};
const root=dataPath('data','public','cache','basemap');
const inFlight=new Map<string,Promise<Asset>>();
async function read(file:string):Promise<Asset|null>{try{const [meta,bytes]=await Promise.all([fs.readFile(/* turbopackIgnore: true */ file+'.json','utf8'),fs.readFile(/* turbopackIgnore: true */ file)]);return {bytes,type:JSON.parse(meta).type};}catch{return null;}}
async function load(url:string,file:string):Promise<Asset>{
 const prior=inFlight.get(url);if(prior)return prior;
 const pending=(async()=>{const response=await fetch(url,{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'SberAtlas-local-pilot/0.1'}});if(!response.ok)throw new Error('upstream-map-unavailable');
 const type=response.headers.get('content-type')||'application/octet-stream';let bytes=Buffer.from(await response.arrayBuffer());
 if(type.includes('json'))bytes=Buffer.from(bytes.toString('utf8').replaceAll('https://tiles.openfreemap.org/','/api/basemap/'));
 await fs.mkdir(root,{recursive:true});const temp=file+'.'+randomUUID();
 try{await fs.writeFile(temp,bytes);await fs.rename(temp,file);await fs.writeFile(file+'.json',JSON.stringify({type,cachedAt:new Date().toISOString()}));}finally{await fs.rm(temp,{force:true});}
 return {bytes,type};})();inFlight.set(url,pending);try{return await pending;}finally{inFlight.delete(url);}
}
async function assetResponse(url:string,origin=''){
 const file=path.join(root,createHash('sha256').update(url).digest('hex'));
 const cached=await read(file);
 try{const asset=cached??await load(url,file);return new Response(asset.type.includes('json')?asset.bytes.toString('utf8').replaceAll('/api/basemap/',origin+'/api/basemap/'):new Uint8Array(asset.bytes),{headers:{'Content-Type':asset.type,'Cache-Control':'public, max-age=86400','X-Atlas-Cache':cached?'hit':'miss'}});}catch(error){return new Response('Public map source unavailable',{status:error instanceof Error&&error.message==='upstream-map-unavailable'?502:503,headers:{'Cache-Control':'no-store'}});}
}
export async function basemapResponse(parts:string[],origin:string){
 const asset=parts.join('/');if(!asset||asset.includes('..')||asset.length>500||!/^(planet(?:\/|$)|fonts\/|sprites\/|natural_earth\/)/.test(asset))return new Response('Not found',{status:404});
 return assetResponse(`https://tiles.openfreemap.org/${parts.map(encodeURIComponent).join('/')}`,origin);
}
export async function terrainResponse(parts:string[]){
 if(parts.length!==3||!/^\d+\.png$/.test(parts[2]))return new Response('Not found',{status:404});
 const [z,x,y]=[Number(parts[0]),Number(parts[1]),Number(parts[2].slice(0,-4))];
 if(![z,x,y].every(Number.isInteger)||z<0||z>12||x<0||y<0||x>=2**z||y>=2**z)return new Response('Not found',{status:404});
 return assetResponse(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
}
