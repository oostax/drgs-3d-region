import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchIncidentStreet,normalizeStreet} from '../src/lib/street-geocoding';
import {groupIncidentGeography} from '../src/lib/incident-geography';
import type {StreetIndex,StreetRecord} from '../src/lib/street-geocoding';

const street=(id:string,name:string,kind:string|null='street'):StreetRecord=>({id,name,kind,aliases:[],territoryId:'mo-92701000',coordinates:[49.1,55.8],bbox:[49.1,55.8,49.2,55.9],geometry:{type:'LineString',coordinates:[[49.1,55.8],[49.15,55.81],[49.2,55.9]]},sourceUrl:`https://www.openstreetmap.org/way/${id}`,sourceUrls:[`https://www.openstreetmap.org/way/${id}`]});
const index=(streets:StreetRecord[]):StreetIndex=>({schemaVersion:1,territoryId:'mo-92701000',checkedAt:'2026-09-04T12:00:00Z',sourceUrl:'https://www.openstreetmap.org/relation/367666',sourceKind:'osm-full-ways',streets,limitations:[]});
const known=index([street('1','Тестовая улица'),street('2','проспект Первого Мая','avenue')]);

test('exact normalization supports Cyrillic, ё, abbreviated road types and ordinal forms without fuzzy guesses',()=>{
  assert.deepEqual(normalizeStreet('ул. 1-я ЗЕЛЁНАЯ'),normalizeStreet('1-я Зелёная улица'));
  assert.equal(matchIncidentStreet('ул.ТЕСТОВАЯ','Казань г.о.',known).status,'matched');
  assert.equal(matchIncidentStreet('пр-т Первого Мая','Казань',known).streetId,'2');
  assert.equal(matchIncidentStreet('Теставоя','Казань г.о.',known).status,'unmatched');
  assert.equal(matchIncidentStreet('переулок Тестовая','Казань г.о.',known).status,'unmatched');
});

test('disconnected homonymous streets and a bare ambiguous type require review and get no invented point',()=>{
  const duplicate=index([street('1','Тестовая улица'),street('3','Тестовая улица')]);
  const match=matchIncidentStreet('Тестовая','Казань г.о.',duplicate);
  assert.equal(match.status,'ambiguous');assert.equal(match.candidateCount,2);assert.equal(match.coordinates,null);assert.equal(match.geometry,null);
  const types=index([street('1','Тестовая улица'),street('4','Тестовая площадь','square')]);
  assert.equal(matchIncidentStreet('Тестовая','Казань г.о.',types).status,'ambiguous');
  assert.equal(matchIncidentStreet('улица Тестовая','Казань г.о.',types).streetId,'1');
});

test('a Kazan street index cannot geocode another municipality, a blank address or a house number alone',()=>{
  for(const address of [null,'','дом 7'])assert.equal(matchIncidentStreet(address,'Казань г.о.',known).status,'unmatched');
  assert.equal(matchIncidentStreet('Тестовая','Набережные Челны г.о.',known).status,'unmatched');
  assert.equal(matchIncidentStreet('Тестовая','Казань г.о.',null).status,'unmatched');
});

test('street matches preserve full public geometry and provenance without claiming a building or event position',()=>{
  const record=street('1','Тестовая улица');record.geometry={type:'MultiLineString',coordinates:[[[49.1,55.8],[49.2,55.9]],[[49.2,55.9],[49.3,55.91]]]};
  const match=matchIncidentStreet('Тестовая','Казань г.о.',index([record]));
  assert.equal(match.precision,'street');assert.equal(match.confidence,'medium');assert.deepEqual(match.geometry,record.geometry);
  assert.equal(match.checkedAt,'2026-09-04T12:00:00Z');assert.equal(match.sourceUrl,record.sourceUrl);
  assert.ok(match.note.includes('дом и корпус не подтверждены'));assert.ok(match.note.includes('не точный адрес происшествия'));
});

test('different objects remain distinct while groups partition all counts',()=>{
  const rows=[
    {municipality:'Казань г.о.',topic_group:'Дороги',street:'Тестовая',object:'Дом 7',count:2,firstDate:'2026-07-02',lastDate:'2026-07-03'},
    {municipality:'Казань г.о.',topic_group:'Дороги',street:'ул. Тестовая',object:null,count:3,firstDate:'2026-07-01',lastDate:'2026-07-31'},
    {municipality:'Казань г.о.',topic_group:'Дороги',street:null,count:7},
    {municipality:'Казань г.о.',topic_group:'Освещение',street:'Тестовая',count:11},
    {municipality:'Другой район',topic_group:'Дороги',street:'Тестовая',count:13},
  ];
  const before=JSON.stringify(rows);const result=groupIncidentGeography(rows,known);
  assert.equal(result.count,36);assert.equal(result.groups.reduce((sum,group)=>sum+group.count,0),36);
  assert.equal(result.topics.find(topic=>topic.name==='Дороги')!.count,25);assert.equal(result.groups.length,5);
  assert.deepEqual(result.geocoding,{streetMatched:16,ambiguous:0,unmatched:20});
  const merged=result.groups.find(group=>group.geolocation.streetId==='1'&&group.topic_group==='Дороги')!;
  assert.equal(merged.count,3);assert.equal(merged.firstDate,'2026-07-01');assert.equal(merged.lastDate,'2026-07-31');
  assert.equal(result.groups.find(group=>group.object==='Дом 7')!.count,2);
  assert.equal(JSON.stringify(rows),before);
});

test('ambiguous counts remain in the territory remainder and a missing index leaves all records accessible',()=>{
  const duplicate=index([street('1','Тестовая улица'),street('3','Тестовая улица')]);
  const rows=[{municipality:'Казань г.о.',topic_group:'Дороги',street:'Тестовая',count:4},{municipality:'Казань г.о.',topic_group:'Дороги',street:null,count:6}];
  const ambiguous=groupIncidentGeography(rows,duplicate);
  assert.equal(ambiguous.groups.length,2);assert.equal(ambiguous.groups.reduce((n,g)=>n+g.count,0),10);assert.equal(ambiguous.groups[0].geolocation.coordinates,null);
  assert.deepEqual(ambiguous.geocoding,{streetMatched:0,ambiguous:4,unmatched:6});
  const absent=groupIncidentGeography(rows,null);assert.equal(absent.count,10);assert.equal(absent.geocoding.unmatched,10);
});

test('regional index respects district, settlement and Tatar aliases',()=>{
 const a={...street('a','Тукай урамы'),territoryId:'village-a',scopeIds:['village-a','district']};
 const b={...street('b','Тукай урамы'),territoryId:'village-b',scopeIds:['village-b','district']};
 const regional:StreetIndex={...index([a,b]),territoryId:'test-region',territories:[{id:'district',name:'Северный муниципальный район'},{id:'village-a',name:'Городское поселение город Альфа'},{id:'village-b',name:'село Бета'}]};
 assert.equal(matchIncidentStreet('Тукай урамы','Северный район',regional).status,'ambiguous');
 assert.equal(matchIncidentStreet('Тукай урамы','Северный район',regional,'Альфа').streetId,'a');
 assert.equal(matchIncidentStreet('Тукай урамы','Северный район',regional,'Неизвестная деревня').status,'unmatched');
});

test('municipality aliases are indexed once per street artifact and rebuild for a new artifact',()=>{
  let nameReads=0;
  const district={id:'district',get name(){nameReads++;return 'Северный муниципальный район';},aliases:['Северный']};
  const record={...street('regional','Тестовая улица'),territoryId:'district',scopeIds:['district']};
  const original:StreetIndex={...index([record]),territoryId:'region',territories:[district]};
  for(let n=0;n<100;n++)assert.equal(matchIncidentStreet('ул. Тестовая',n%2?'Северный':'Северный район',original).streetId,'regional');
  assert.equal(nameReads,1,'the territory collection is not rescanned for every incident');
  const replacement:StreetIndex={...original,streets:[{...record,id:'new-way'}],territories:[{id:'district',name:'Южный муниципальный район'}]};
  assert.equal(matchIncidentStreet('Тестовая','Южный район',replacement).streetId,'new-way');
  assert.equal(matchIncidentStreet('Тестовая','Северный район',replacement).status,'unmatched');
  assert.equal(matchIncidentStreet('Тестовая','Северный район',original).streetId,'regional');
});

test('repeated topics reuse one address result without merging unrelated topic counts',()=>{
  const result=groupIncidentGeography([
    {municipality:'Казань',topic_group:'Дороги',street:'Тестовая',count:3},
    {municipality:'Казань',topic_group:'ЖКХ',street:'Тестовая',count:5},
  ],known);
  assert.equal(result.groups.length,2);assert.equal(result.count,8);
  assert.equal(result.groups[0].geolocation,result.groups[1].geolocation);
  assert.deepEqual(result.topics,[{name:'ЖКХ',count:5},{name:'Дороги',count:3}]);
});
