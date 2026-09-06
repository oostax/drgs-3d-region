import { createElement } from 'react';
import { SIGNAL_ICON_NODES, type SignalIcon } from '@/lib/signal-icon-nodes';

export default function SignalCategoryIcon({icon,size=20,label}:{icon:SignalIcon;size?:number;label?:string}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true}>{SIGNAL_ICON_NODES[icon].map(([tag,attributes],i)=>createElement(tag,{...attributes,key:i}))}</svg>;
}
