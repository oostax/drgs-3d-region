import type {Coordinates} from './types';

export type StreetRecord = {id:string;name:string;kind:string|null;aliases:string[];territoryId:string;scopeIds?:string[];geometry:GeoJSON.LineString|GeoJSON.MultiLineString;coordinates:Coordinates;bbox:[number,number,number,number];sourceUrl:string;sourceUrls:string[]};
export type StreetIndex = {schemaVersion:1;territoryId:string;regionId?:string;territories?:{id:string;name:string;aliases?:string[];parentId?:string|null}[];partial?:boolean;checkedAt:string;sourceUrl:string;sourceKind:'osm-full-ways'|'cached-mvt';osmBase?:string;streets:StreetRecord[];limitations:string[]};
export type IncidentGeolocation = {status:'matched'|'ambiguous'|'unmatched';precision:'street'|'territory';coordinates:Coordinates|null;geometry:GeoJSON.LineString|GeoJSON.MultiLineString|null;streetId:string|null;streetName:string|null;sourceUrl:string|null;sourceUrls:string[];checkedAt:string|null;method:string;confidence:'medium'|'low';note:string;candidateCount:number;bbox:[number,number,number,number]|null};

const kinds:Record<string,string>={улица:'street',ул:'street',проспект:'avenue',просп:'avenue','пр-т':'avenue',пркт:'avenue',переулок:'lane',пер:'lane',проезд:'drive',бульвар:'boulevard','б-р':'boulevard',бул:'boulevard',шоссе:'highway',набережная:'embankment',наб:'embankment',площадь:'square',пл:'square',тракт:'tract',аллея:'alley'};
kinds['урамы']='street';kinds['проспекты']='avenue';kinds['мәйданы']='square';
export function normalizePlace(value:string){return value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/(?:муниципальный|муниципальное|сельское|городское|поселение|район|город|село|деревня|г\.о\.?|\b[гсд]\.\s)/gu,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');}
export function normalizeStreet(value:string):{name:string;kind:string|null} {
  const words=value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е')
    .replace(/([а-я])\.(?=[а-я])/g,'$1 ')
    .replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').trim().split(' ');
  let kind:string|null=null;
  const ambiguousKinds=new Set(['набережная','набережной','набережную','площадь']);
  const kindPositions=words.flatMap((word,i)=>kinds[word]?[i]:[]);
  const kindPosition=kindPositions.find(i=>!ambiguousKinds.has(words[i]))??(words.length>1?kindPositions[0]:undefined);
  const retained=words.filter((word,i)=>{if(i===kindPosition){kind=kinds[word];return false;}return !['им','имени'].includes(word);});
  const name=retained.join(' ').replace(/(\d+)[- ]?(?:я|й|ая|ый)(?=\s|$)/g,'$1').replace(/\s+/g,' ').trim();
  return {name,kind};
}

const lookupCache=new WeakMap<StreetIndex,Map<string,StreetRecord[]>>();
function lookup(index:StreetIndex){
  const old=lookupCache.get(index);if(old)return old;
  const result=new Map<string,StreetRecord[]>();
  for(const street of index.streets)for(const alias of [street.name,...street.aliases]){
    const key=normalizeStreet(alias).name;if(!key)continue;
    const values=result.get(key)||[];if(!values.some(value=>value.id===street.id))values.push(street);result.set(key,values);
  }
  lookupCache.set(index,result);return result;
}

// Municipality and settlement aliases are an index, not a scan per incident row.
// A reloaded street artifact gets a new object and therefore a fresh WeakMap entry.
const placeLookupCache = new WeakMap<StreetIndex, Map<string, string[]>>();
function placeLookup(index: StreetIndex) {
  const cached = placeLookupCache.get(index); if(cached) return cached;
  const places = new Map<string, string[]>();
  for(const territory of index.territories ?? []) for(const alias of [territory.name,...territory.aliases ?? []]) {
    const name = normalizePlace(alias); if(!name) continue;
    const ids = places.get(name) ?? []; if(!ids.includes(territory.id)) ids.push(territory.id); places.set(name,ids);
  }
  placeLookupCache.set(index,places); return places;
}

export function matchIncidentStreet(street:string|null|undefined,municipality:string,index:StreetIndex|null,settlement?:string|null):IncidentGeolocation {
  const empty:IncidentGeolocation={status:'unmatched',precision:'territory',coordinates:null,geometry:null,streetId:null,streetName:null,sourceUrl:null,sourceUrls:[],checkedAt:index?.checkedAt||null,method:'no-exact-local-street-match',confidence:'low',note:'Точное место обращения не установлено. Сохранена территория; случайная улица или дом не назначаются.',candidateCount:0,bbox:null};
  if(!index||!street?.trim())return empty;
  const places = placeLookup(index);
  const scopes=index.territories ? places.get(normalizePlace(municipality)) ?? [] : (/^казань(?:\s+г\.?о\.?)?$/i.test(municipality.trim())&&index.territoryId==='mo-92701000'?['mo-92701000']:[]);
  if(!scopes.length)return empty;
  const settlements=settlement&&index.territories ? places.get(normalizePlace(settlement)) : null;
  if(settlement&&index.territories&&!settlements?.length)return empty;
  const query=normalizeStreet(street);
  if(!query.name)return empty;
  const candidates=(lookup(index).get(query.name)||[]).filter(candidate=>(candidate.scopeIds||[candidate.territoryId]).some(id=>scopes.includes(id))&&(!settlements?.length||(candidate.scopeIds||[candidate.territoryId]).some(id=>settlements.includes(id)))&&(!query.kind||!candidate.kind||candidate.kind===query.kind));
  if(candidates.length!==1)return {...empty,status:candidates.length?'ambiguous':'unmatched',candidateCount:candidates.length,method:candidates.length?'ambiguous-local-street-name':'no-exact-local-street-match',note:candidates.length?'В территории несколько несвязанных улиц/участков с таким именем. Нужна ручная проверка адреса; координата не назначена.':empty.note};
  const found=candidates[0];
  return {status:'matched',precision:'street',coordinates:found.coordinates,geometry:found.geometry,streetId:found.id,streetName:found.name,sourceUrl:found.sourceUrl,sourceUrls:found.sourceUrls,checkedAt:index.checkedAt,method:'exact-normalized-street-name-and-municipality',confidence:'medium',candidateCount:1,bbox:found.bbox,note:`Название улицы сопоставлено локально с публичной геометрией OSM. Это вся улица/связанный участок, не точный адрес происшествия; дом и корпус не подтверждены. Точка служит для навигации по улице.${index.sourceKind==='cached-mvt'?' Кэш содержит только сохранённые сегменты, полнота улицы не подтверждена.':''}`};
}
