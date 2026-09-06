import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSignal,deduplicateSignalFeed,sberSignalContext,groupSignalPublications,operationalSignalNeedsReview} from '../src/lib/signal-usefulness';
import type {Signal} from '../src/lib/types';
const sample=(changes:Partial<Signal>={}):Signal=>({id:'one',title:'На улице Ленина отключат водоснабжение',summary:'Отключение воды на время ремонта сетей.',category:'utilities',visibility:'public',territoryId:'kazan',address:'Казань, ул. Ленина, 1',coordinates:[49.1,55.8],precision:'building',sourceUrl:'https://example.org/one',publishedAt:'2026-09-05T08:00:00Z',checkedAt:'2026-09-05',facts:[],hypothesis:'',nextStep:'',...changes});
test('honours facade announcement is excluded even with a precise place and official source',()=>{
  const signal=sample({title:'Педагогов с Электронной доски почета РТ показали на медиафасаде в Казани',summary:'Ак Барс Арена: проект объединил 15 тысяч имён.'});
  assert.equal(reviewSignal(signal).showOnMap,false);assert.equal(sberSignalContext(signal),null);
});
test('specific disruptions and projects remain useful; vague news stays in full feed',()=>{
  assert.equal(reviewSignal(sample()).showOnMap,true);
  assert.equal(reviewSignal(sample({title:'В районе строят новую школу',summary:'Строительство завершат в декабре.'})).showOnMap,true);
  assert.equal(reviewSignal(sample({title:'В Казани прошла встреча',summary:'Участники обсудили разные вопросы.',coordinates:null,address:undefined})).showOnMap,false);
});
test('same event combines publication sources, preserving different addresses, dates and stages',()=>{
  const first=sample(),copy=sample({id:'two',sourceUrl:'https://another.org/news',publishedAt:'2026-09-05T10:00:00Z'});
  const result=deduplicateSignalFeed([first,copy]);assert.equal(result.length,1);assert.equal(result[0].relatedSources?.[0].url,copy.sourceUrl);
  assert.equal(deduplicateSignalFeed([first,{...copy,address:'Казань, ул. Ленина, 2'}]).length,2);
  assert.equal(deduplicateSignalFeed([first,{...copy,publishedAt:'2026-09-06T10:00:00Z'}]).length,2);
  assert.equal(deduplicateSignalFeed([first,{...copy,title:'Водоснабжение на улице Ленина восстановлено'}]).length,2);
});
test('client relationship requires a matching portfolio INN; arena is not a competing bank',()=>{
  const signal=sample({organizationInn:'1655000000'});
  assert.notEqual(sberSignalContext(signal)?.label,'Событие клиента');
  assert.equal(sberSignalContext(signal,new Set(['1655000000']))?.label,'Событие клиента');
  assert.notEqual(sberSignalContext(sample({title:'На Ак Барс Арене ремонтируют кровлю'}))?.label,'Изменение банковской сети');
});
test('one publication has one feed card with separately accessible locations',()=>{
  const first=sample({title:'Ограничение движения — улица Первая'}),second=sample({id:'second',title:'Ограничение движения — улица Вторая',address:'Улица Вторая'});
  const group=groupSignalPublications([first,second]);assert.equal(group.length,1);assert.deepEqual(group[0].locations.map(s=>s.id),['one','second']);
});
test('old operational incidents require review without becoming resolved',()=>{
  const old=sample({publishedAt:'2026-08-10T12:00:00Z'});assert.equal(operationalSignalNeedsReview(old,'2026-09-05'),true);assert.equal(old.live,undefined);
  assert.equal(operationalSignalNeedsReview(sample(),'2026-09-05'),false);
  assert.equal(reviewSignal(sample({title:'С начала года в республике зафиксирован рост аварий с участием пешеходов'})).showOnMap,false);
});

test('Sber prioritises capital projects over routine completed street maintenance',()=>{
  assert.equal(sberSignalContext(sample({title:'Работы прошли на перекрестках',summary:'Выполнен ремонт дорожной разметки и светофорных стоек.'})),null);
  assert.equal(sberSignalContext(sample({title:'В районе строят новую школу',summary:'Школа рассчитана на 1200 мест.'}))?.label,'Проект территории');
});
