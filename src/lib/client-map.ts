import {all,hasTable,safeJson} from './db';
import {ensureLocationSchema,organizationLocation,publicOrganizationIndex,validCoordinates} from './organization-locations';
import type {OrganizationLocation} from './planning-types';
import type {ClientMapPayload,ClientMapPoint} from './client-map-types';

export function clientMap():ClientMapPayload{
  if(!hasTable('organizations'))return {items:[],total:0,located:0,unlocated:0,portfolioInns:[]};
  ensureLocationSchema();
  const organizations=all<{id:string;inn:string;name:string;gosb:string}>('SELECT id,inn,name,gosb FROM organizations');
  const saved=new Map(all<{org_id:string;data_json:string}>('SELECT org_id,data_json FROM organization_locations').map(row=>[row.org_id,safeJson<OrganizationLocation|null>(row.data_json,null)]));
  const index=publicOrganizationIndex(),sourceInns=new Set(index.map(row=>row.inn)),items:ClientMapPoint[]=[];
  for(const org of organizations){
    const location=saved.get(org.id)||(sourceInns.has(org.inn)?organizationLocation('work',org,index):null);
    if(!location||!['verified','source_exact'].includes(location.status))continue;
    const candidate=([['meeting',location.meeting],['office',location.office],['legal',location.legalAddress]] as const).find(([,point])=>point&&validCoordinates(point.coordinates)&&['building','site'].includes(point.precision));
    if(!candidate)continue;
    const [addressKind,point]=candidate;
    items.push({...org,addressKind,address:point!.address,coordinates:point!.coordinates!,precision:point!.precision,sourceUrl:point!.sourceUrl,confirmedByUser:point!.confirmedByUser});
  }
  return {items,total:organizations.length,located:items.length,unlocated:organizations.length-items.length,portfolioInns:[...new Set(organizations.map(org=>org.inn).filter(Boolean))]};
}
