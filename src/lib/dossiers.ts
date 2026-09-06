import { randomUUID } from 'node:crypto';
import { db, all, one, safeJson } from './db';
import { atlasPayload, organizationDetail, getTerritories } from './atlas-data';
import { money, number } from './format';
import type { Mode, Dossier, Signal, Organization } from './types';
import {liveSignalById} from './live-store';

export function listDossiers(mode:Mode):Dossier[]{return all<{content_json:string}>('SELECT content_json FROM saved_dossiers WHERE mode=? ORDER BY updated_at DESC',mode).map(r=>safeJson<Dossier>(r.content_json,{} as Dossier));}
export function getDossier(id:string,mode:Mode):Dossier|null {const r=one<{content_json:string}>('SELECT content_json FROM saved_dossiers WHERE id=? AND mode=?',id,mode);return r?safeJson<Dossier|null>(r.content_json,null):null;}
export function saveDossier(dossier:Dossier){db().prepare('INSERT INTO saved_dossiers(id,mode,title,territory_id,content_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content_json=excluded.content_json,updated_at=excluded.updated_at').run(dossier.id,dossier.mode,dossier.title,dossier.territoryId,JSON.stringify(dossier),dossier.updatedAt);return dossier;}
export function resolveDossierSignals(ids:string[],available:Signal[],lookup:(id:string)=>Signal|null=liveSignalById){return ids.map(id=>available.find(signal=>signal.id===id)??lookup(id)).filter((signal):signal is Signal=>signal!==null&&signal!==undefined);}
type DossierInput={mode:Mode;territoryId:string;signalIds:string[];organizationIds:string[];snapshot:string};
const unique=(values:string[])=>[...new Set(values.map(value=>value.trim()).filter(Boolean))];
/** The agenda is grounded only in the explicit selection. Nothing is inferred from map proximity. */
export function dossierContent(signals:Signal[],orgs:Organization[]) {
  const facts=signals.flatMap(signal=>[`${signal.title}${signal.address?` · ${signal.address}`:''}`, ...signal.facts.map(fact=>`${signal.title}: ${fact}`)]);
  const sources:Dossier['sources']=signals.flatMap(signal=>[
    {label:`${signal.sourceName||signal.title}${signal.publishedAt?` · ${signal.publishedAt.slice(0,10)}`:''}`,url:signal.sourceUrl||undefined},
    ...(signal.relatedSources??[]),
  ]);
  const questions:string[]=[],actions:string[]=[];
  for(const org of orgs){
    const label=`${org.name} · ИНН ${org.inn}`;
    facts.push(`${label}. ${number(org.offerCount)} предложений в выбранном срезе${org.offerSource?.label?` (${org.offerSource.label})`:''}.`);
    if(org.expectedIncome!==null)facts.push(`${org.name}: ожидаемый доход по предложениям с указанным показателем — ${money(org.expectedIncome)}; это плановый показатель из выгрузки.`);
    const location=org.location;
    for(const [kind,point] of [['Место встречи',location?.meeting],['Офис',location?.office],['Юридический адрес',location?.legalAddress]] as const){
      if(!point?.address)continue;
      facts.push(`${org.name}: ${kind.toLowerCase()} — ${point.address}${point.requiresMeetingConfirmation?' (требует подтверждения перед визитом)':''}.`);
      if(point.sourceUrl)sources.push({label:`${org.name} · ${kind.toLowerCase()}`,url:point.sourceUrl});
    }
    const products=unique((org.offers??[]).map(offer=>offer.product));
    questions.push(`${label}: ${org.offerCount?`уточнить потребность и статус ${number(org.offerCount)} предложений${products.length?` (${products.join(', ')})`:''}`:'уточнить задачи клиента; в выбранной выгрузке предложения не найдены'}.`);
    questions.push(`${org.name}: кто со стороны клиента принимает решение и какой следующий контакт удобен?`);
    if(!location?.meeting)questions.push(`${org.name}: подтвердить место встречи и участников.`);
    actions.push(`${org.name}: записать решение по обсуждённым предложениям, ответственного и согласованную дату следующего шага.`);
    if(org.payroll){
      const values=[org.payroll.fot_march===null?null:`за март — ${money(org.payroll.fot_march)}`,org.payroll.fot_july===null?null:`за июль — ${money(org.payroll.fot_july)}`].filter(Boolean);
      if(values.length)facts.push(`${org.name}: ФОТ ${values.join(', ')}. Территориальное распределение ФОТ не подтверждено.`);
    }
    if(org.meetings&&!org.meetings.conflict)facts.push(`${org.name}: встречи по отчёту — ${number(org.meetings.q1)} / ${number(org.meetings.q2)} / ${number(org.meetings.q3)} за I / II / III кварталы.`);
    sources.push({label:`${org.name} · ${org.offerSource?.fileName||'Локальная выгрузка предложений'}${org.offerSource?.label?` · ${org.offerSource.label}`:''}`});
    if(org.payroll)sources.push({label:`${org.name} · предоставленная выгрузка ФОТ`});
    if(org.meetings)sources.push({label:`${org.name} · предоставленный отчёт о встречах`});
  }
  for(const signal of signals){
    questions.push(`${signal.title}: уточнить текущее состояние${signal.address?` по адресу ${signal.address}`:''} и ответственного за следующий шаг.`);
    if(signal.nextStep)actions.push(`${signal.title}: ${signal.nextStep}`);
  }
  const goal=orgs.length?`Обсудить задачи ${orgs.map(org=>org.name).join(', ')}${signals.length?' в контексте выбранных сигналов':''} и определить следующий шаг.`:`Уточнить состояние выбранных событий: ${signals.map(signal=>signal.title).join('; ')}.`;
  const participants=orgs.length?orgs.map(org=>`${org.name} (ИНН ${org.inn}) — представитель: уточнить`).join('\n'):'Ответственный за выбранные события — уточнить';
  return {facts:unique(facts),hypotheses:unique(signals.map(signal=>signal.hypothesis)),questions:questions.join('\n'),actions:unique(actions).join('\n'),notes:`Цель встречи:\n${goal}\n\nУчастники:\n${participants}\n\nЗаметки:\n`,sources:[...new Map(sources.map(source=>[`${source.url??''}|${source.label}`,source])).values()]};
}
export function createDossier(input:DossierInput):Dossier {
  const signalIds=unique(input.signalIds),organizationIds=input.mode==='work'?unique(input.organizationIds):[];
  if(!signalIds.length&&!organizationIds.length)throw new Error('Выберите клиента или сигнал, чтобы подготовить встречу.');
  const territory=getTerritories().find(t=>t.id===input.territoryId);
  const payload=atlasPayload(input.mode,input.territoryId,input.snapshot);
  const signals=resolveDossierSignals(signalIds,payload.signals).filter(signal=>input.mode==='work'||signal.visibility==='public');
  const orgs=organizationIds.map(id=>organizationDetail('work',id,input.snapshot)).filter((org):org is Organization=>org!==null);
  if(signals.length!==signalIds.length||orgs.length!==organizationIds.length)throw new Error('Часть выбранных клиентов или сигналов недоступна. Обновите выбор и повторите.');
  const name=territory?.name||'Татарстан';
  const subject=orgs.length?orgs.map(org=>org.name).join(', '):signals[0].title;
  return saveDossier({id:randomUUID(),mode:input.mode,title:`Встреча · ${subject}`.slice(0,200),territoryId:input.territoryId,territoryName:name,updatedAt:new Date().toISOString(),signalIds:signals.map(signal=>signal.id),organizationIds:orgs.map(org=>org.id),...dossierContent(signals,orgs)});
}
