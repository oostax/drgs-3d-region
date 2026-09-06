import type {Signal} from './types';
import {operationalSignalNeedsReview} from './signal-usefulness';
import {classifySignalRecency, type SignalRecencyWindow} from './signal-recency';

export type SignalPeriod = 'current'|'resolved'|'archive';
export type SignalFlow = 'all'|'complaints'|'work'|'results';
export function signalMatchesFlow(signal:Signal,flow:SignalFlow) {
  if(flow==='all')return true;
  if(isResidentReport(signal)&&signal.residentReport){
    if(flow==='work')return signal.residentReport.inProgressCount>0;
    if(flow==='results')return signal.residentReport.closedCount>0;
    return signal.residentReport.openCount>0;
  }
  const text=`${signal.title} ${signal.summary}`.toLocaleLowerCase('ru-RU');
  const result=signal.live?.outcome==='improvement'||flowState(signal)==='resolved'||/\b(?:завершил[иа]?|завершен[аоы]?|открыли|открыт[аоы]?|ввели в эксплуатацию|восстановили|отремонтировали|обустроили|модернизировали|запустили)\b/.test(text);
  if(flow==='results')return result;
  if(flow==='work')return ['planned','in_progress','paused'].includes(flowState(signal));
  return isResidentReport(signal)||!result&&['reported','unknown'].includes(flowState(signal));
}

function flowState(signal:Signal) {
  if(signal.live?.state)return signal.live.state;
  if(signal.closedAt||signal.lifecycle?.status==='completed')return 'resolved';
  if(signal.lifecycle?.status==='planned')return 'planned';
  if(signal.lifecycle?.status==='under_construction')return 'in_progress';
  return 'reported';
}
export function periodForSignalState(period:SignalPeriod,state:string):SignalPeriod {
  // Archive is an explicit time scope: inspecting its statuses must retain it.
  if(period==='archive')return period;
  return state==='resolved'?'resolved':'current';
}
export function stateForSignalPeriod(period:SignalPeriod):string {
  // Changing time scopes must not retain an incompatible, hidden status filter.
  return period==='resolved'?'resolved':'all';
}

export const isResidentReport = (signal: Signal) => signal.visibility === 'private' && signal.id.startsWith('incident:');
export function signalVisibleInView(signal:Signal, asOf:string, options:{period:'current'|'resolved'|'archive';days:SignalRecencyWindow;residentReports:boolean;usefulOnly?:boolean}) {
  // The supplied July snapshot is an independently labelled historical layer.
  // Showing it never changes lifecycle/animation eligibility or public access.
  if (isResidentReport(signal)) return options.residentReports;
  if(options.usefulOnly&&operationalSignalNeedsReview(signal,asOf))return options.period==='archive';
  const recency=classifySignalRecency(signal,asOf,{newsDays:options.days});
  return options.period==='archive' ? !recency.visibleByDefault : options.period==='resolved' ? recency.bucket==='recent-resolved' : recency.visibleByDefault;
}
