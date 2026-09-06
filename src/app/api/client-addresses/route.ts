import {CLIENT_ADDRESS_MAX_BYTES,CLIENT_ADDRESS_TEMPLATE,importClientAddresses,restoreClientAddressImport} from '@/lib/client-address-import';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
function local(request:Request){
  const url=new URL(request.url),host=request.headers.get('host')||url.host,origin=request.headers.get('origin');
  try{return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)&&request.headers.get('sec-fetch-site')!=='cross-site'&&(!origin||new URL(origin).host===host);}catch{return false;}
}
export async function GET(request:Request){
  if(!local(request)||new URL(request.url).searchParams.get('mode')!=='work')return Response.json({error:'Импорт клиентов доступен только локально в рабочем режиме.'},{status:403,headers});
  return new Response('\uFEFF'+CLIENT_ADDRESS_TEMPLATE,{headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="client-addresses-template.csv"'}});
}
export async function POST(request:Request){
  if(!local(request)||new URL(request.url).searchParams.get('mode')==='public')return Response.json({error:'Импорт доступен только из локального приложения в рабочем режиме.'},{status:403,headers});
  const length=Number(request.headers.get('content-length'));if(length>CLIENT_ADDRESS_MAX_BYTES+100_000)return Response.json({error:'Файл должен быть не больше 5 МБ.'},{status:413,headers});
  try{
    // Content-Length is optional and untrusted. Bound the actual multipart body
    // before parsing so a malformed local upload cannot allocate unbounded memory.
    const reader=request.body?.getReader();if(!reader)throw new Error('Выберите CSV или XLSX.');
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>CLIENT_ADDRESS_MAX_BYTES+100_000){await reader.cancel();return Response.json({error:'Файл должен быть не больше 5 МБ.'},{status:413,headers});}chunks.push(value);}}finally{reader.releaseLock();}
    const form=await new Response(Buffer.concat(chunks),{headers:{'Content-Type':request.headers.get('Content-Type')||''}}).formData();
    if(form.get('mode')!=='work')return Response.json({error:'Адреса клиентов доступны только в рабочем режиме.'},{status:403,headers});
    const file=form.get('file');if(!(file instanceof File))return Response.json({error:'Выберите CSV или XLSX.'},{status:400,headers});
    if(file.size>CLIENT_ADDRESS_MAX_BYTES)return Response.json({error:'Файл должен быть не больше 5 МБ.'},{status:413,headers});
    const result=await importClientAddresses('work',file.name,Buffer.from(await file.arrayBuffer()),form.get('apply')==='true');
    return Response.json(result,{headers});
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Не удалось обработать файл.'},{status:400,headers});}
}

export async function PATCH(request:Request){
  if(!local(request)||new URL(request.url).searchParams.get('mode')==='public')return Response.json({error:'Импорт доступен только из локального приложения в рабочем режиме.'},{status:403,headers});
  try{
    const input=await request.json();
    if(input?.mode!=='work')return Response.json({error:'Адреса клиентов доступны только в рабочем режиме.'},{status:403,headers});
    if(typeof input.importId!=='string'||input.importId.length>100)throw new Error('Укажите импорт для отмены.');
    return Response.json(restoreClientAddressImport('work',input.importId),{headers});
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Не удалось отменить импорт.'},{status:400,headers});}
}
