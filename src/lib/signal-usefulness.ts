import type { Signal } from './types';

export type SignalReview = { showOnMap: boolean; score: number; reasons: string[]; level: 'useful'|'context'|'noise' };
const clean = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/https?:\/\/\S+/g,'').replace(/[^а-яa-z0-9]+/g,' ').trim();
const publicity = /доск[аиу] почета|поздравл|с днем |юбиле[йя]|наградил|награжден|чествова|гороскоп|рецепт дня|советы врача|приглашаем подписаться|служб[ау] по контракту|контракт.{0,35}миллион/;
const roundup = /^(?:за сутки|за неделю|итоги недели|дайджест|сводка за|с начала года).{0,100}(?:обращени|звонк|поступил|зарегистрир|зафиксирован|авари|погибли|произошло)/;
const protocolNews=/принял[аи]? участие в заседании|принял[аи]? участие в совещании|обсудили вопросы сотрудничества|состоялось заседание оргкомитета/;
const disruption = /авари|отключ|перекры|огранич.{0,25}движени|закры.{0,20}(проезд|мост|дорог|офис|предприят|больниц)|обруш|пожар|подтоп|эвакуац|утечк|не работает|поврежден|разрушен/;
const development = /(?:строят|строительств|реконструкц|капремонт|ремонтир|ремонт |модерниз|инвестиц|инвестпроект|производств|завод|предприяти|новый корпус|новую школу|новая школа|новый детский сад|откры.{0,25}(школ|больниц|поликлиник|производств|офис|филиал)|ввод.{0,20}эксплуатац|введ.{0,20}эксплуатац|тендер|концесси)/;

/** Editorial usefulness is independent of source reliability, freshness and geocoding. */
export function reviewSignal(signal: Signal): SignalReview {
  if (signal.visibility === 'private') return {showOnMap:true, score:50, level:'useful', reasons:['Обращение из выбранного исторического слоя']};
  const title = clean(signal.title), text = clean(`${signal.title} ${signal.summary}`);
  // Explicit editorial exclusions also cover legacy snapshots without metadata.
  if (publicity.test(title) || roundup.test(title) || protocolNews.test(title)) return {showOnMap:false,score:5,level:'noise',reasons:['Информационная публикация без конкретного изменения объекта или услуги']};
  const stored = signal.signalUsefulness;
  if (stored?.version === 'useful-v1') return stored;
  const issue = disruption.test(text), project = development.test(text);
  const located = Boolean(signal.address || signal.organizationInn || (signal.coordinates && ['street','building','site'].includes(signal.precision)));
  const concrete = issue || project;
  const score = concrete ? (located ? 80 : 60) : 20;
  return {showOnMap:concrete,score,level:concrete?'useful':'context',reasons:[issue?'Изменение доступности или безопасности объекта':project?'Проект или изменение инфраструктуры':'Недостаточно конкретики для рабочей карты']};
}

/** Short-lived service incidents leave the current view without inventing a resolution. */
export function operationalSignalNeedsReview(signal:Signal,asOf:string):boolean {
  if(signal.visibility==='private'||['resolved','cancelled'].includes(signal.live?.state||''))return false;
  const text=clean(`${signal.title} ${signal.summary}`);
  if(signal.live?.state==='planned'&&!/не работают|аварийн.{0,20}отключ/.test(text))return false;
  const transient=/отключени.{0,20}(вод|электр|газ|тепл)|аварийн.{0,20}отключ|не работают светофор|подач[аиу].{0,20}воды.{0,20}прекра/.test(text);
  const sourceTime=Date.parse(signal.live?.lastMeaningfulAt||signal.publishedAt),now=Date.parse(asOf);
  return transient&&Number.isFinite(sourceTime)&&Number.isFinite(now)&&now-sourceTime>3*86_400_000;
}

export function groupSignalPublications(signals:Signal[]):{primary:Signal;locations:Signal[]}[]{
  const groups=new Map<string,{primary:Signal;locations:Signal[]}>();
  for(const signal of signals){
    const title=signal.title.split(/\s+—\s+/)[0];
    const key=signal.visibility==='public'&&signal.sourceUrl?`${publicationUrl(signal.sourceUrl)}|${signal.publishedAt.slice(0,10)}|${clean(title)}|${signal.live?.state||''}`:signal.id;
    const group=groups.get(key);if(group)group.locations.push(signal);else groups.set(key,{primary:signal,locations:[signal]});
  }
  return [...groups.values()];
}

export function sberSignalContext(signal:Signal,clientInns:ReadonlySet<string>=new Set()):{label:string;action:string;score:number}|null {
  if (!reviewSignal(signal).showOnMap) return null;
  const text=clean(`${signal.title} ${signal.summary}`);
  if(signal.organizationInn&&clientInns.has(signal.organizationInn))return {label:'Событие клиента',action:'Проверить влияние с ответственным КМ и обновить повестку встречи.',score:100};
  if(/(?:^| )(?:сбербанк|сбер)(?: |$)/.test(text)&&/офис|банкомат|отделени|обслуживан/.test(text))return {label:'Сеть Сбера',action:'Проверить работу точки, доступность и обслуживание клиентов.',score:95};
  if(/(?:^| )(?:втб|альфа банк|газпромбанк|совкомбанк|псб)(?: |$)|банк ак барс|ак барс банк/.test(text)&&/откры|закры|переезд|новый офис|филиал/.test(text))return {label:'Изменение банковской сети',action:'Уточнить адрес и изменение формата обслуживания.',score:75};
  const capitalProject=development.test(text)&&/инвест|концесси|тендер|закупк|капремонт|капитальн|завод|производств|предприяти|нов.{0,15}(?:школ|детск|корпус)|строят|строительств|реконструкц|модерниз/.test(text);
  if(capitalProject&&!/ремонт (?:квартиры|подъезда)/.test(text))return {label:'Проект территории',action:'Уточнить заказчика, этап, сроки и участников; проверить связь с клиентским портфелем.',score:65};
  if(disruption.test(text)&&!['resolved','cancelled'].includes(signal.live?.state||''))return {label:'Риск доступности',action:'Проверить затронутые адреса клиентов и офисов. Близость сама по себе не подтверждает влияние.',score:55};
  return null;
}

function publicationUrl(value:string){try{const url=new URL(value);url.hash='';for(const key of [...url.searchParams.keys()])if(/^(utm_|fbclid|gclid)/.test(key))url.searchParams.delete(key);return url.toString().replace(/\/$/,'');}catch{return value;}}
/** Conservative presentation dedup: never combine different addresses, dates or stages. */
export function deduplicateSignalFeed(signals:Signal[]):Signal[]{
  const groups=new Map<string,Signal>();
  for(const signal of signals){
    if(signal.visibility==='private'){groups.set(`private:${signal.id}`,signal);continue;}
    const place=clean(signal.address||'')||`${signal.territoryId||''}:${signal.precision}:${signal.coordinates?.map(n=>n.toFixed(5)).join(',')||''}`;
    const title=clean(signal.title), day=signal.publishedAt.slice(0,10),state=signal.live?.state||signal.lifecycle?.status||'';
    const key=`${day}|${place}|${state}|${title.length>=28?title:publicationUrl(signal.sourceUrl)||signal.id}`;
    const previous=groups.get(key);
    if(!previous){groups.set(key,signal);continue;}
    const primary=(signal.live?.evidenceCount||0)>(previous.live?.evidenceCount||0)?signal:previous;
    const secondary=primary===signal?previous:signal;
    const sources=new Map([...primary.relatedSources||[],...secondary.relatedSources||[],{label:secondary.sourceName||'Публикация по событию',url:secondary.sourceUrl}].filter(s=>s.url&&s.url!==primary.sourceUrl).map(s=>[publicationUrl(s.url),s]));
    groups.set(key,{...primary,relatedSources:[...sources.values()]});
  }
  return [...groups.values()];
}
