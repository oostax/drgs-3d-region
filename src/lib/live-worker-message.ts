/** Translate machine checkpoints into short operational facts for the source panel. */
export function liveWorkerMessage(raw:string):string {
 let value:Record<string,any>;
 try{value=JSON.parse(raw);}catch{return raw;}
 const parts:string[]=[];
 if(value.successful)parts.push(`Проверено лент: ${value.successful}.`);
 if(value.documents)parts.push(`Новых или изменённых материалов: ${value.documents}.`);
 if(value.failed)parts.push(`Не ответили источники: ${value.failed}. Сохранённые материалы доступны.`);
 const telegram=value.telegram;
 if(telegram){
  const states:Record<string,string>={listening:'Telegram подключён.',catching_up:'Telegram: загружается история и проверяются правки.',connecting:'Telegram: устанавливается соединение.',disconnected:'Telegram: соединение прервано, повторное подключение запланировано.',rate_limited:'Telegram ограничил частоту запросов. Ожидаем разрешённого времени.',authorization_required:'Telegram требует локальной авторизации.',not_configured:'Telegram ещё не настроен.',no_approved_sources:'Для Telegram ещё не выбраны доступные каналы.'};
  parts.push(states[telegram.state]||'Проверяем состояние Telegram.');
  if(telegram.received)parts.push(`Обработано сообщений: ${telegram.received}.`);
 }
 if(value.analysis?.failed||value.analysis?.providerUnavailable)parts.push('ИИ временно недоступен; базовая обработка по правилам продолжается.');
 return parts.join(' ')||'Новых материалов нет. Следующая проверка запланирована.';
}
