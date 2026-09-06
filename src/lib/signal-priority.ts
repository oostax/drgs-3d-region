import type {Signal} from './types';
import {normalizeSceneLifecycle} from './scene-lifecycle';

export function signalPriority(signal:Signal,now=Date.now()) {
  const live=signal.live, historical=signal.visibility==='private';
  const severity=live?.severity??'low';
  const rank=({critical:4,high:3,medium:2,low:1} as const)[severity];
  const positive=live?.outcome==='improvement';
  const development=live?.outcome==='development';
  return {rank,positive,historical,
    color:historical?'#8a9690':rank>=3?'#bb3947':positive?'#258363':development?'#a46b24':rank===2?'#c67a28':'#728781',
    badge:historical?'':rank===4?'!!':rank===3?'!':positive?'✓':development?'+':'',
    label:historical?'Архив обращений':`${({critical:'Критический',high:'Высокий',medium:'Средний',low:'Низкий'} as const)[severity]} приоритет`,
    pulse:!historical&&rank>=3&&normalizeSceneLifecycle(signal,now).activeActivity,
  };
}
