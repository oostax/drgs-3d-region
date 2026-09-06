import type {LiveSignalsResponse} from './live-types';

/** Page boundaries are transport limits, not map coverage limits. A reset uses
 * the same full snapshot so reconnecting cannot silently drop later pages.
 */
export async function completeLiveSnapshot(first:LiveSignalsResponse, fetchPage:(offset:number)=>Promise<LiveSignalsResponse>, signal:AbortSignal) {
  const items=new Map(first.signals.map(item=>[item.id,item]));
  let page=first,offset=first.signals.length;
  while(page.hasMore&&offset<10_000){
    signal.throwIfAborted();
    page=await fetchPage(offset);signal.throwIfAborted();
    if(!page.signals.length)break;
    for(const item of page.signals)items.set(item.id,item);
    offset+=page.signals.length;
  }
  // Keep the FIRST cursor: the next delta also catches updates during paging.
  return {...first,signals:[...items.values()],total:page.total,hasMore:page.hasMore};
}
