import { all, hasTable, safeJson } from './db';
import { offerSourceSelection } from './source-status';
import { liveSignalById } from './live-store';
import type { SignalRelevanceItem, SignalRelevanceResponse } from './live-types';

const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[«»"']/g,'').replace(/[^а-яa-z0-9]+/g,' ').trim();
const words=(value:string)=>new Set(normalize(value).split(' ').filter(word=>word.length>2));
const addressMatch=(a:string,b:string)=>{const aa=words(a),bb=words(b),shared=[...aa].filter(word=>bb.has(word));return shared.length>=2&&[...aa].some(word=>/\d/.test(word)&&bb.has(word));};
type Org={id:string;inn:string;gosb:string;name:string};
type Offer={id:string;offer_id:string|null};
function offers(orgId:string,snapshot:string):string[]{
  if(!hasTable('offers'))return [];
  const source=offerSourceSelection(snapshot),rows=all<Offer>(`SELECT id,offer_id FROM offers WHERE org_id=? AND snapshot=?${source.tracked?' AND source_id=?':''} ORDER BY stage_date DESC LIMIT 25`,orgId,snapshot,...(source.tracked?[source.sourceId]:[]));
  return rows.map(row=>row.offer_id||row.id);
}
function item(reason:SignalRelevanceItem['reason'],label:string,explanation:string,confidence:SignalRelevanceItem['confidence'],org:Org|null,snapshot:string,relationship:SignalRelevanceItem['relationship'],urls:string[]):SignalRelevanceItem{
  return {reason,label,explanation,confidence,organizationId:org?.id||null,organizationName:org?.name||null,inn:org?.inn||null,gosb:org?.gosb||null,offerIds:org?offers(org.id,snapshot):[],sourceUrls:urls,relationship};
}
export function signalRelevance(signalId:string,snapshot:string):SignalRelevanceResponse{
  const signal=liveSignalById(signalId),items:SignalRelevanceItem[]=[];
  const limitations=['Совпадение названия и адреса остаётся кандидатом до подтверждения ИНН.','Близость на карте не доказывает связь с клиентом.','Ожидаемый доход не является фактически полученным доходом.'];
  if(!signal||!hasTable('organizations'))return {signalId,snapshot,items,limitations};
  const urls=[signal.sourceUrl,...(signal.relatedSources||[]).map(source=>source.url)].filter(Boolean);
  const text=normalize(`${signal.title} ${signal.summary} ${signal.address||''}`),category=normalize(`${signal.category} ${signal.live.topic}`);
  const exact=signal.organizationInn?all<Org>('SELECT id,inn,gosb,name FROM organizations WHERE inn=? ORDER BY gosb,id',signal.organizationInn):[];
  for(const org of exact.slice(0,10)){
    const disruption=/авари|жалоб|пожар|отключ|жкх|дорог|инфраструкт/.test(`${text} ${category}`),project=/строит|инвест|проект|капремонт|реконструк/.test(`${text} ${category}`);
    items.push(item(disruption?'client_disruption':project?'client_project':'public_event_match',disruption?'Событие может влиять на клиента':project?'Публичный проект клиента':'Публичное событие связано по ИНН',`Источник содержит ИНН ${org.inn}; связь с организацией точная, влияние и потребность требуют проверки.`,'high',org,snapshot,'exact_inn',urls));
  }
  if(!exact.length&&signal.address&&hasTable('organization_locations')){
    const candidates=all<{org_id:string;data_json:string}>('SELECT org_id,data_json FROM organization_locations');
    for(const candidate of candidates){
      const org=all<Org>('SELECT id,inn,gosb,name FROM organizations WHERE id=?',candidate.org_id)[0];if(!org||!text.includes(normalize(org.name)))continue;
      const location=safeJson<any>(candidate.data_json,{}),addresses=[location.legalAddress?.address,location.office?.address].filter((value):value is string=>typeof value==='string');
      if(addresses.some(address=>addressMatch(address,signal.address!)))items.push(item('public_event_match','Возможное совпадение клиента',`Совпали название и элементы адреса. Подтвердите ИНН и конкретный объект до использования в работе.`,'low',org,snapshot,'name_address_candidate',urls));
    }
  }
  const competitor=/(?:^|\s)(втб|ак барс|псб|газпромбанк|альфа банк|совкомбанк)(?=\s|$)/.exec(text);
  if(competitor)items.push(item('competitor_change','Изменение у конкурента',`В публикации упомянут ${competitor[1]}. Проверьте открытие, закрытие, формат офиса или участие в проекте по первоисточнику.`,'medium',null,snapshot,'competitor',urls));
  if(/(?:^|\s)(сбер|сбербанк)(?=\s|$)/.test(text)&&/офис|отделени|банкомат|режим работ|обслуживан|закрыт|открыт|переехал/.test(text))items.push(item('branch_service_issue','Сигнал о сети Сбера','Публикация касается офиса, банкомата или обслуживания. Точка сети изменяется только после проверки адреса и статуса.','medium',null,snapshot,'none',urls));
  return {signalId,snapshot,items:items.slice(0,20),limitations};
}
