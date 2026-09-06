import type {SignalUsefulness} from './types';

/** Metadata affects default display only; it cannot certify a source or location. */
export function parseSignalUsefulness(value:unknown):SignalUsefulness|undefined{
  if(!value||typeof value!=='object')return undefined;
  const raw=value as Record<string,unknown>,dimensions=raw.dimensions as Record<string,unknown>|undefined;
  if(raw.version!=='useful-v1'||!['useful','context','noise'].includes(String(raw.level))||typeof raw.score!=='number'||!Number.isFinite(raw.score)||raw.score<0||raw.score>100)return undefined;
  if(typeof raw.showOnMap!=='boolean'||raw.showOnMap!==(raw.level==='useful'))return undefined;
  if(!dimensions||!['specificity','actionability','significance'].every(key=>typeof dimensions[key]==='number'&&Number.isInteger(dimensions[key])&&Number(dimensions[key])>=0&&Number(dimensions[key])<=3))return undefined;
  const list=(items:unknown,limit:number,length:number)=>Array.isArray(items)?items.filter((s):s is string=>typeof s==='string').slice(0,limit).map(s=>s.slice(0,length)):[];
  return {version:'useful-v1',score:raw.score,level:raw.level as SignalUsefulness['level'],showOnMap:raw.showOnMap,
    reasons:list(raw.reasons,12,100),supportedFacts:list(raw.supportedFacts,3,600),
    dimensions:{specificity:Number(dimensions.specificity),actionability:Number(dimensions.actionability),significance:Number(dimensions.significance)}};
}
