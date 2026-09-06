import {DEFAULT_REGION_ID} from './regions';
import type {Signal} from './types';

export type LiveScope = {regionId?:string;territoryIds?:string[];archive?:boolean;days?:30|45|60;ongoing?:boolean;category?:string;bbox?:[number,number,number,number]};
export function matchesLiveScope(signal:Signal, query:LiveScope, now=Date.now()) {
  if ((signal.live?.regionId || DEFAULT_REGION_ID) !== (query.regionId || DEFAULT_REGION_ID)) return false;
  if (query.territoryIds?.length && (!signal.territoryId || !query.territoryIds.includes(signal.territoryId))) return false;
  if (query.category && signal.category !== query.category) return false;
  const published=Date.parse(signal.publishedAt),meaningful=Date.parse(signal.live?.lastMeaningfulAt || '');
  if (!Number.isFinite(published) || published > now) return false;
  const active=query.ongoing && ['planned','in_progress','paused'].includes(signal.live?.state || '') && meaningful<=now && meaningful>=now-30*86400000;
  const planned = signal.live?.state === 'planned' || (!signal.live && signal.lifecycle?.status === 'planned' && !signal.closedAt);
  if (!query.archive && published<now-(query.days || 45)*86400000 && !active && !planned) return false;
  if (query.bbox) {
    const p=signal.coordinates,b=query.bbox;
    if (!p || p[0]<b[0] || p[0]>b[2] || p[1]<b[1] || p[1]>b[3]) return false;
  }
  return true;
}
