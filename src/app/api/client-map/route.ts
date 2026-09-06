import {clientMap} from '@/lib/client-map';
export const runtime='nodejs';
export async function GET(request:Request){
  if(new URL(request.url).searchParams.get('mode')!=='work')return Response.json({error:'Клиентский портфель доступен в рабочем режиме.'},{status:403});
  try{return Response.json(clientMap(),{headers:{'Cache-Control':'private, no-store'}});}catch{return Response.json({error:'Не удалось прочитать адреса клиентского портфеля.'},{status:503});}
}
