import test from 'node:test';
import assert from 'node:assert/strict';
import {categoryIcon,markerStatusIcon,signalGroup,signalMarker,signalMarkerState,SIGNAL_STATUS_LEGEND} from '../src/lib/signal-markers';
import {SIGNAL_ICON_NODES} from '../src/lib/signal-icon-nodes';
import {groupIncidentGeography} from '../src/lib/incident-geography';
import type {LiveEventMeta} from '../src/lib/live-types';

const live=(changes:Partial<LiveEventMeta>={}):LiveEventMeta=>({regionId:'RU-TA',topic:'Дороги',state:'reported',severity:'medium',confidence:'low',sourceKind:'community',eventTime:'2026-09-04T10:00:00Z',lastEvidenceAt:'2026-09-04T11:00:00Z',lastMeaningfulAt:'2026-09-04T10:00:00Z',ongoing:true,locationConfidence:'street',evidenceCount:1,duplicateCount:0,revision:1,activityKind:'road_defect',explicitActivity:false,notifyEligible:false,...changes});

test('utility subcategories have distinct recognizable icons, and health symbols never stand for generic ЖКХ',()=>{
  for(const [category,icon] of [['Аварии в системе водоснабжения','droplets'],['Ненадлежащее качество отопления','heater'],['Неисправность лифтов','arrow-up-down'],['Приборы учета','gauge'],['Плата за жилое помещение','receipt']] as const)assert.equal(categoryIcon(category,'utilities'),icon);
  assert.equal(signalMarker({category:'ЖКХ',title:'ЖКХ: улица Назарбаева'}).icon,'house-plug');
  assert.equal(signalMarker({category:'Здравоохранение',title:'Скорая помощь'}).icon,'ambulance');
});
test('category chooses shape while the original theme group independently chooses colour',()=>{
  const a=signalMarker({category:'ЖКХ',title:'Водоснабжение'}), b=signalMarker({category:'ЖКХ',title:'Отопление'});
  assert.notEqual(a.icon,b.icon);assert.equal(a.color,b.color);
  const c=signalMarker({category:'Благоустройство',title:'Уборка снега'}),d=signalMarker({category:'Дороги',title:'Уборка снега'});
  assert.equal(c.icon,d.icon);assert.notEqual(c.color,d.color);
});
test('a mixed aggregate preserves all source subcategories and cannot invent a single incident type',()=>{
  const grouped=groupIncidentGeography([{municipality:'Казань',topic_group:'ЖКХ',topic:'Отопление',count:2},{municipality:'Казань',topic_group:'ЖКХ',topic:'Водоснабжение',count:1},{municipality:'Казань',topic_group:'ЖКХ',topic:'Отопление',count:3}],null);
  assert.equal(grouped.count,6);assert.equal(grouped.groups.length,1);assert.deepEqual(grouped.groups[0].categoryBreakdown,[{name:'Отопление',count:5},{name:'Водоснабжение',count:1}]);
  const marker=signalMarker({category:'ЖКХ',title:'ЖКХ',categoryBreakdown:grouped.groups[0].categoryBreakdown});assert.equal(marker.icon,'layers');assert.equal(marker.mixed,true);
});
test('all selected category icons exist and vague source categories use a meaningful neutral group glyph',()=>{
  for(const category of ['ЖКХ','Дороги','Благоустройство','Социальное обслуживание и защита','Образование','Здравоохранение','Экология','Труд и занятость','Связь и телевидение','new unknown category']){const icon=categoryIcon(category,signalGroup(category));assert.ok(SIGNAL_ICON_NODES[icon]);}
  assert.equal(categoryIcon('Поддержка семей','social'),'hand-heart');assert.equal(categoryIcon('Аварийное и ветхое жилье','utilities'),'house-crack');
});

test('a road closure is not a bridge merely because the text contains необходимости',()=>{
 const closure=signalMarker({category:'roads',title:'В центре Казани введут ограничения движения',summary:'Ограничения будут действовать при необходимости. Перекроют улицу Театральную.'});
 assert.equal(closure.icon,'construction');
 assert.equal(signalMarker({category:'roads',title:'Ремонт моста через Казанку'}).icon,'bridge');
});
test('live state and verification origin stay independent from topic colour and activity icon',()=>{
  const community=signalMarker({category:'ЖКХ',title:'Яма',live:live()});
  const official=signalMarker({category:'ЖКХ',title:'Яма',live:live({sourceKind:'official',confidence:'high'})});
  assert.equal(community.icon,'traffic-cone');assert.equal(community.color,official.color);
  assert.equal(community.state,'reported');assert.equal(community.sourceKind,'community');
  assert.equal(official.stateLabel,'Сообщено');assert.equal(official.sourceKind,'official');
});

test('status legend has a distinct colour and status glyph for each lifecycle state',()=>{
  assert.equal(new Set(SIGNAL_STATUS_LEGEND.map(item=>item.color)).size,SIGNAL_STATUS_LEGEND.length);
  assert.equal(markerStatusIcon('active'),'wrench');assert.equal(markerStatusIcon('resolved'),'file-check-2');
});

test('canonical live topics never fall through to other and useful openings get a sports icon',()=>{
 for(const [topic,group] of [['roads','roads'],['utilities','utilities'],['waste','landscape'],['fire','safety'],['weather','safety'],['culture','culture'],['technology','communication'],['construction','construction']] as const)assert.equal(signalGroup(topic),group);
 const marker=signalMarker({category:'culture',title:'Центр регби открыт',live:live({activityKind:'place_event',state:'resolved'})});assert.equal(marker.group,'culture');assert.equal(marker.icon,'trophy');
});

test('a generic place event keeps its concrete domain icon',()=>{
 assert.equal(signalMarker({category:'education',title:'В школах открылись новые кружки',live:live({activityKind:'place_event'})}).icon,'school');
 assert.equal(signalMarker({category:'health',title:'Открылась медицинская консультация',live:live({activityKind:'place_event'})}).icon,'heart-pulse');
 assert.equal(signalMarker({category:'culture',title:'Городское мероприятие',live:live({activityKind:'place_event'})}).icon,'calendar-days');
});


test('shared topic sprites retain independent status faces and never animate archive as current',()=>{
  const event={category:'utilities',title:'Водопровод',publishedAt:'2026-09-04',live:live({activityKind:'utility_repair',state:'in_progress',explicitActivity:true})};
  const current=signalMarker(event),archive=signalMarker({...event,visibility:'private'});
  assert.notEqual(current.imageId,archive.imageId);assert.equal(current.color,archive.color);assert.notEqual(current.faceColor,archive.faceColor);
  assert.equal(signalMarkerState(event,Date.parse('2026-09-05T12:00:00Z')),'active');
  assert.equal(signalMarkerState({...event,live:live({severity:'critical'})},Date.parse('2026-09-05T12:00:00Z')),'urgent');
  assert.equal(signalMarkerState({...event,visibility:'private'},Date.parse('2026-09-05T12:00:00Z')),'archive');
  assert.equal(signalMarkerState({...event,live:live({state:'planned'})},Date.parse('2026-09-05T12:00:00Z')),'planned');
});

test('settlement precision has a separate calm face without overwriting the event lifecycle',()=>{
  const event={category:'utilities',title:'Ремонт водоснабжения',publishedAt:'2026-09-04',live:live({activityKind:'utility_repair',state:'in_progress',severity:'critical',explicitActivity:true})};
  const locality=signalMarker({...event,precision:'settlement'}),exact=signalMarker({...event,precision:'building'});
  assert.equal(locality.visualState,'locality');assert.equal(locality.approximate,true);assert.match(locality.imageId,/--locality$/);
  assert.equal(locality.state,'in_progress');assert.equal(locality.stateLabel,'В работе');assert.equal(locality.icon,exact.icon);assert.equal(locality.color,exact.color);
  assert.notEqual(locality.faceColor,exact.faceColor);assert.notEqual(locality.imageId,exact.imageId);assert.equal(exact.approximate,false);
  assert.equal(signalMarkerState({...event,precision:'settlement',visibility:'private'}),'locality');
  assert.match(locality.locationLabel!,/точный объект не установлен/);
});
