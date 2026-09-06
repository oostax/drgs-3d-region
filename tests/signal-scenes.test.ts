import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventScenes, sceneKind, sceneCoverageDescription, sourceDescribesExcavation } from '../src/lib/signal-scenes';
import type { Signal, Territory } from '../src/lib/types';
import type { LiveEventMeta } from '../src/lib/live-types';
import { isCurrentSceneActivity } from '../src/lib/signal-activity';
import {signalSceneRecipe,sceneCatalog} from '../src/lib/scene-catalog';

const territory = {id: 'city', name: 'Город', center: [49.2, 55.7]} as Territory;
const now = Date.parse('2026-09-04T12:00:00Z');
const lifecycle: NonNullable<Signal['lifecycle']> = { status: 'under_construction', asOf: '2026-09-01', sourceUrl: 'https://example.org/current-work', currentStatusVerified: true, animationEligible: true, note: 'Confirmed test fixture' };
const geometry: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[49.09,55.79],[49.11,55.79],[49.11,55.81],[49.09,55.81],[49.09,55.79]]] };
const signal = (id: string, changes: Partial<Signal> = {}) => ({id, title: 'Новая школа', category: 'construction', coordinates: null, precision: 'territory', territoryId: 'city', lifecycle, siteGeometry: geometry, coordinateSourceUrl: 'https://www.openstreetmap.org/way/1', ...changes}) as Signal;
const live = (changes: Partial<LiveEventMeta> = {}): LiveEventMeta => ({
  regionId:'RU-TA',topic:'Дороги',state:'reported',severity:'medium',confidence:'low',sourceKind:'community',
  eventTime:'2026-09-04T10:00:00Z',lastEvidenceAt:'2026-09-04T11:00:00Z',lastMeaningfulAt:'2026-09-04T10:00:00Z',
  ongoing:true,locationConfidence:'street',evidenceCount:1,duplicateCount:0,revision:1,activityKind:'road_defect',
  explicitActivity:false,notifyEligible:false,...changes,
});
const street: GeoJSON.LineString={type:'LineString',coordinates:[[49.09,55.8],[49.11,55.8]]};
const liveSignal=(id:string,liveChanges:Partial<LiveEventMeta>={},changes:Partial<Signal>={})=>signal(id,{
  title:'Яма на дороге',category:'Дороги',coordinates:[49.1,55.8],precision:'street',siteGeometry:street,
  publishedAt:'2026-09-04T10:00:00Z',live:live(liveChanges),...changes,
});

test('selected July complaint gets an archive illustration, never working equipment',()=>{
  const history=signal('july',{visibility:'private',category:'Дороги',title:'Архив',categoryBreakdown:[{name:'Содержание грунтовых дорог (в т.ч. грейдирование)',count:1}],precision:'street',coordinates:[49.1,55.8],siteGeometry:street,lifecycle:undefined});
  assert.equal(makeEventScenes([history],[],now).length,0);
  const selected=makeEventScenes([history],[],now,'july')[0];
  assert.equal(selected.display,'archive');assert.ok(selected.recipe);assert.equal(selected.selected,true);
  assert.equal(isCurrentSceneActivity(selected,now),false);
});

test('news wording resolves a catalog scene without requiring an exact title',()=>{
  const repair=liveSignal('repair',{}, {title:'Здесь капитально ремонтируют участок улицы',summary:'Ведётся монтаж бортового камня будущего тротуара.'});
  assert.equal(signalSceneRecipe(repair)?.topic,'Ремонт бордюров');
  const water=liveSignal('water',{}, {category:'utilities',title:'Отключение водоснабжения',summary:'Работы по адресу.'});
  assert.equal(signalSceneRecipe(water)?.family,'water');
});

test('a stadium mention does not turn repairs into an opening scene',()=>{
  const repair=liveSignal('stadium-repair',{}, {category:'culture',title:'Ремонт стадиона',summary:'На стадионе ремонтируют кровлю.'});
  assert.notEqual(signalSceneRecipe(repair)?.topic,'Открытие спортивного объекта');
  const opening=liveSignal('stadium-opening',{}, {category:'culture',title:'Открылся центр регби',summary:'Новый спортивный объект принимает посетителей.'});
  assert.equal(signalSceneRecipe(opening)?.topic,'Открытие спортивного объекта');
});

test('utility scenes do not infer an open trench from an outage or a pipe replacement', () => {
  for (const text of ['Отключение водоснабжения', 'Ведётся замена водопровода', 'Ремонт выполняют без раскопок', 'Прокладка бестраншейным способом', 'Земляные работы не требуются', 'Планируются земляные работы']) assert.equal(sourceDescribesExcavation(text), false, text);
  for (const text of ['На месте ведут земляные работы', 'Рабочие открыли траншею', 'Подрядчик ведёт раскопку', 'На стройплощадке готовят котлован']) assert.equal(sourceDescribesExcavation(text), true, text);
  const water = signal('water-work', { title: 'Ремонт водопровода', summary: 'Рабочие открыли траншею у дома.', category: 'utilities', coordinates: [49.1, 55.8], precision: 'building' });
  assert.equal(makeEventScenes([water], [], now)[0].excavationConfirmed, true);
});

test('coverage caption distinguishes full linked-object illustration from source-confirmed work extent', () => {
  const road = liveSignal('coverage', { activityKind: 'road_repair', explicitActivity: true, state: 'in_progress' }, { title: 'Ремонт дороги' });
  assert.equal(makeEventScenes([road], [], now)[0].coverageMode, 'linked-object-illustration');
  assert.match(sceneCoverageDescription(road)!, /по всей связанной улице/);
  const entire = { ...road, summary: 'Работы идут по всей улице.' };
  assert.equal(makeEventScenes([entire], [], now)[0].coverageMode, 'confirmed-source-scope');
  assert.match(sceneCoverageDescription(entire)!, /как указано в источнике/);
  assert.equal(sceneCoverageDescription({ ...road, precision: 'territory' }), null);
  const building = signal('water-perimeter', { category: 'utilities', title: 'Ремонт водопровода', coordinates: [49.1, 55.8], precision: 'building' });
  assert.match(sceneCoverageDescription(building)!, /по периметру здания/);
});

test('a planned street without mapped boundaries keeps the marker, not a physical scene',()=>{
  const road=liveSignal('section',{state:'planned'},{title:'Ограничение движения',summary:'На участке улицы Пушкина от Карла Маркса до Большой Красной.'});
  assert.match(sceneCoverageDescription(road)!,/Границы указанного в источнике участка пока не сопоставлены/);
  assert.equal(makeEventScenes([road],[],now).length,0);
  const clipped={...road,locationVerificationMethod:'source-section-intersections'};
  assert.match(sceneCoverageDescription(clipped)!,/ограничена участком между ориентирами/);
  assert.equal(makeEventScenes([clipped],[],now)[0].coverageMode,'confirmed-source-scope');
  assert.equal(makeEventScenes([clipped],[],now)[0].entireStreet,false);
});

test('an old explicit repair retains its historical stage without claiming current animation', () => {
  const old = liveSignal('old-repair', { activityKind: 'road_repair', explicitActivity: true, state: 'in_progress', lastMeaningfulAt: '2026-07-31T10:00:00Z', lastEvidenceAt: '2026-07-31T10:00:00Z' }, { title: 'Ремонт бордюров' });
  const scene = makeEventScenes([old], [], now, old.id)[0];
  assert.equal(scene.lastKnownWork, true);
  assert.notEqual(scene.display, 'active');
  assert.equal(isCurrentSceneActivity(scene, now), false);
});

test('every original topic reaches the map renderer when a precise archived signal is selected',()=>{
  for(const r of sceneCatalog.recipes.filter(r=>r.source==='complaints')){
    const precision=r.geometry[0] as Signal['precision'];
    const item=signal(r.id,{title:r.topic,category:r.group,categoryBreakdown:[{name:r.topic,count:1}],visibility:'private',lifecycle:undefined,precision,coordinates:[49.1,55.8],siteGeometry:precision==='street'?street:geometry});
    const scenes=makeEventScenes([item],[],now,item.id);
    assert.equal(scenes.length,1,`${r.group}: ${r.topic}`);
    assert.equal(scenes[0].recipe?.topic,r.topic);
    assert.equal(scenes[0].display,'archive');
  }
});

test('automatic scenes retain source precision, never turn a territory into a construction address', () => {
  const scenes = makeEventScenes([signal('area'), signal('site', {coordinates:[49.1,55.8], precision:'site'}), signal('unlocated', {territoryId:null})], [territory], now);
  assert.equal(scenes.length, 1);
  assert.equal(scenes.find(s=>s.id==='area'), undefined);
  assert.deepEqual(scenes.find(s=>s.id==='site')?.coordinates, [49.1,55.8]);
});

test('thematic scenes are stable under source ordering and leave area reports to map summaries', () => {
  const records = [signal('small',{count:1}),signal('large',{count:40}),signal('exact',{coordinates:[49.1,55.8], precision:'building'}),signal('park',{category:'Благоустройство',title:'Парк'})];
  const scenes = makeEventScenes(records,[territory],now);
  assert.deepEqual(makeEventScenes(records.toReversed(),[territory],now), scenes);
  assert.deepEqual(scenes.map(s=>s.id), ['exact']);
});

test('historical, unverified, planned, future and geometry-free reports never produce physical scenes', () => {
  const base = signal('verified',{coordinates:[49.1,55.8],precision:'site'});
  assert.equal(makeEventScenes([base],[],now).length,1);
  const invalid: Partial<Signal>[] = [{lifecycle:undefined},{lifecycle:{...lifecycle,currentStatusVerified:false}},{lifecycle:{...lifecycle,animationEligible:false}},{lifecycle:{...lifecycle,asOf:'2026-07-31'}},{lifecycle:{...lifecycle,asOf:'2026-09-05'}},{lifecycle:{...lifecycle,status:'planned'}},{lifecycle:{...lifecycle,status:'completed'}},{lifecycle:{...lifecycle,asOf:'invalid'}},{lifecycle:{...lifecycle,sourceUrl:''}},{siteGeometry:{type:'Point',coordinates:[49.1,55.8]}},{coordinateSourceUrl:undefined}];
  for(const patch of invalid) assert.deepEqual(makeEventScenes([{...base,...patch}],[],now),[]);
  assert.equal(isCurrentSceneActivity({...lifecycle,asOf:'2026-08-05T12:00:00Z'},now),true);
  assert.equal(isCurrentSceneActivity({...lifecycle,asOf:'2026-08-05T11:59:59Z'},now),false);
});

test('social support keeps its topic at a street address and July incidents remain markers', () => {
  const line: GeoJSON.LineString={type:'LineString',coordinates:[[49.1,55.8],[49.11,55.8]]};
  const support=signal('support',{category:'Социальная поддержка',title:'Социальная помощь гражданам на улице Дорожной',precision:'street',coordinates:[49.1,55.8],siteGeometry:line,lifecycle:{...lifecycle,status:'not_applicable'}});
  const scenes=makeEventScenes([support],[],now);assert.equal(scenes[0].kind,'social');assert.equal(scenes[0].topic,'social');
  const history=signal('july-roads',{category:'Дороги',title:'Обращения за июль',precision:'street',coordinates:[49.1,55.8],siteGeometry:line,lifecycle:{...lifecycle,status:'unknown',asOf:'2026-07-31',currentStatusVerified:false,animationEligible:false}});
  assert.deepEqual(makeEventScenes([history],[],now),[]);
  assert.deepEqual(makeEventScenes([{...support,category:'Транспорт',title:'Изменение расписания автобуса'}],[],now),[]);
  assert.deepEqual(makeEventScenes([{...support,categoryBreakdown:[{name:'Льготы на проезд',count:1},{name:'Выплата пособий',count:1}]}],[],now),[]);
});

test('different signal themes receive different scenes and completed schools do not get active construction', () => {
  for (const [category,expected] of [['Дороги','roads'],['ЖКХ','utilities'],['Благоустройство','landscaping'],['Образование','social'],['Инвестиции','investment'],['Культура','culture']] as const) {
    assert.equal(sceneKind({category,title:category}), expected);
  }
  assert.equal(sceneKind(signal('completed',{lifecycle:{status:'completed'} as Signal['lifecycle']})), 'social');
});

test('a precise community report creates a static defect while explicit repair creates active equipment', () => {
  const reported=makeEventScenes([liveSignal('reported')],[],now)[0];
  assert.equal(reported.kind,'road_defect');assert.equal(reported.display,'static');assert.equal(reported.live?.sourceKind,'community');
  const repair=makeEventScenes([liveSignal('repair',{state:'in_progress',activityKind:'road_repair',explicitActivity:true})],[],now)[0];
  assert.equal(repair.kind,'road_repair');assert.equal(repair.display,'active');
});

test('planned, paused and recently completed live events remain lightweight static scenes', () => {
  const construction={activityKind:'construction',locationConfidence:'building',explicitActivity:false} as const;
  const records=[
    liveSignal('planned',{...construction,state:'planned'},{precision:'building',title:'План ремонта здания'}),
    liveSignal('paused',{...construction,state:'paused'},{precision:'building',title:'Работы остановлены'}),
    liveSignal('done',{...construction,state:'resolved'},{precision:'building',title:'Работы завершены'}),
  ];
  const scenes=makeEventScenes(records,[],now);
  assert.deepEqual(scenes.map(scene=>[scene.id,scene.kind,scene.display]),[
    ['done','completed','completed'],['paused','paused','paused'],['planned','construction','static'],
  ]);
  const old=liveSignal('old',{...construction,state:'resolved',lastMeaningfulAt:'2026-08-20T11:59:59Z'},{precision:'building'});
  assert.deepEqual(makeEventScenes([old],[],now),[]);
});

test('unlocated, mismatched and mixed live reports never become physical scenes', () => {
  const cases=[
    liveSignal('area',{}, {coordinates:null,precision:'territory'}),
    liveSignal('mismatch',{locationConfidence:'building'}),
    liveSignal('mixed',{}, {categoryBreakdown:[{name:'Ямы',count:1},{name:'Ремонт дорог',count:1}]}),
  ];
  assert.deepEqual(makeEventScenes(cases,[],now),[]);
  const place=liveSignal('place',{activityKind:'generic',locationConfidence:'building'},{precision:'building',category:'Общество',title:'Жалоба на здание'});
  assert.equal(makeEventScenes([place],[],now)[0].kind,'generic');
});

test('source-backed geocoding upgrades remain visible before and after selection',()=>{
  const upgraded=liveSignal('water-building',{activityKind:'utility_fault',locationConfidence:'street'},{
    category:'utilities',title:'Отключение водоснабжения',precision:'building',siteGeometry:geometry,
  });
  const ordinary=makeEventScenes([upgraded],[],now);
  const selected=makeEventScenes([upgraded],[],now,'water-building');
  assert.equal(ordinary.length,1);assert.equal(ordinary[0].display,'static');
  assert.equal(selected.length,1);assert.equal(selected[0].selected,true);
});
