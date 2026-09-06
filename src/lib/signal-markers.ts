import type { Signal } from './types';
import type { SignalIcon } from './signal-icon-nodes';
import type { LiveActivityKind, LiveEventState, LiveSourceKind } from './live-types';
import { normalizeSceneLifecycle } from './scene-lifecycle';

export const SIGNAL_GROUPS = {
  utilities: { label: 'ЖКХ и инженерные сети', color: '#3485a6', icon: 'house-plug' },
  roads: { label: 'Дороги', color: '#b96546', icon: 'route' },
  transport: { label: 'Транспорт', color: '#b96546', icon: 'bus-front' },
  landscape: { label: 'Благоустройство', color: '#36835d', icon: 'trees' },
  ecology: { label: 'Экология', color: '#36835d', icon: 'sprout' },
  education: { label: 'Образование', color: '#538898', icon: 'school' },
  health: { label: 'Здравоохранение', color: '#538898', icon: 'heart-pulse' },
  social: { label: 'Социальная поддержка', color: '#538898', icon: 'hand-heart' },
  construction: { label: 'Строительство', color: '#c28632', icon: 'hard-hat' },
  business: { label: 'Экономика и работа', color: '#7274a7', icon: 'briefcase-business' },
  culture: { label: 'Культура и отдых', color: '#b47f58', icon: 'drama' },
  safety: { label: 'Безопасность и закон', color: '#a2686b', icon: 'shield' },
  government: { label: 'Услуги и управление', color: '#6b7d95', icon: 'landmark' },
  communication: { label: 'Связь', color: '#7274a7', icon: 'antenna' },
  other: { label: 'Другие темы', color: '#7b817e', icon: 'notebook-tabs' },
} as const satisfies Record<string,{label:string;color:string;icon:SignalIcon}>;
export type SignalGroup = keyof typeof SIGNAL_GROUPS;
const normalized = (text:string) => text.toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const BRIDGE_OBJECT=/(?:^|[^а-я])(?:мост(?:ы|а|у|ом|е|ов|овой|овые|ового)?|мостостро\w*|переправ\w*)(?=$|[^а-я])/;

export const SIGNAL_STATE_LABELS: Record<LiveEventState,string> = {
  reported:'Сообщено',planned:'Запланировано',in_progress:'В работе',paused:'Приостановлено',
  resolved:'Решено',cancelled:'Отменено',unknown:'Статус не определён',
};

const ACTIVITY_ICONS: Partial<Record<LiveActivityKind,SignalIcon>> = {
  road_defect:'traffic-cone',road_repair:'construction',construction:'hard-hat',
  utility_fault:'house-plug',utility_repair:'wrench',waste:'trash-2',cleanup:'recycle',flood:'waves',snow_ice:'snowflake',
  emergency:'ambulance',fire:'flame',place_event:'calendar-days',
};

export function signalGroup(category:string):SignalGroup {
  const text=normalized(category).trim();
  if (Object.hasOwn(SIGNAL_GROUPS,text)) return text as SignalGroup;
  const aliases:Record<string,SignalGroup>={waste:'landscape',landscaping:'landscape',fire:'safety',flood:'safety',weather:'safety',banking:'business',technology:'communication',place_event:'culture',sports:'culture',healthcare:'health'};
  if(aliases[text]) return aliases[text];
  if (/жкх|энергет|housing|infrastructure|инфраструкт/.test(text)) return 'utilities';
  if (/общественный транспорт|транспорт/.test(text)) return 'transport';
  if (/дорог/.test(text)) return 'roads';
  if (/благоустр/.test(text)) return 'landscape';
  if (/эколог|животн|сельское хозяй/.test(text)) return 'ecology';
  if (/образован|education/.test(text)) return 'education';
  if (/здравоохран|медицин|health/.test(text)) return 'health';
  if (/социал|военная служба|семь/.test(text)) return 'social';
  if (/строитель|архитектур|construction/.test(text)) return 'construction';
  if (/economy|investment|эконом|инвест|труд|занятост/.test(text)) return 'business';
  if (/культур|спорт|туризм|tourism/.test(text)) return 'culture';
  if (/связь|телевид/.test(text)) return 'communication';
  if (/безопас|правопоряд|чрезвычай|закон/.test(text)) return 'safety';
  if (/власти|политик|цур|planning|управлен/.test(text)) return 'government';
  return 'other';
}

// Rules describe the actual subcategory. Colour is resolved separately from its group.
// More specific intents precede broad nouns (e.g. snow on a roof is not a new house).
const RULES: readonly [RegExp,SignalIcon][] = [
  [/снег|налед|гололед/, 'snowflake'],
  [/скорая помощь|скорой помощи/, 'ambulance'],
  [/вакцинац/, 'syringe'], [/лекарств|аптек/, 'pill'],
  [/инвалид|овз|доступн.*сред|маломобиль/, 'accessibility'],
  [/отоплен|теплоснаб|отопитель/, 'heater'],
  [/электрич|электроснаб|электросет|подстанци|лэп/, 'zap'],
  [/газоснаб|газифик|газов.*компан|топлив/, 'flame'],
  [/освещен|фонар/, 'lamp-desk'],
  [/водоотвед|канализац|ливнев|подтоплен|затоплен/, 'waves'],
  [/водоснаб|водопровод|качество воды|температура воды|давление|горячей воды|холодной.*воды|колодц|колонк/, 'droplets'],
  [/лифт/, 'arrow-up-down'], [/прибор.*учет|счетчик/, 'gauge'],
  [/протеч|кровл|фасад/, 'house'],
  [/аварийн.*жил|ветх.*жил|переселен|заброшенн.*здани/, 'house-crack'],
  [/капитальн.*ремонт|капремонт|ремонт.*подъезд/, 'paint-roller'],
  [/управляющ|ресурсоснабжающ/, 'house-plug'],
  [/уборк.*мусор|мусор|отход|свалк/, 'trash-2'],
  [/уборк|санитарн.*обработ|дезинфек/, 'recycle'],
  // Match the road object, not the character sequence inside words such as
  // «необходимости» (…мости…). Cyrillic is not covered by JavaScript's \b.
  [/светофор/, 'traffic-light'], [BRIDGE_OBJECT, 'bridge'],
  [/пешеход.*переход|тротуар|пешеходн/, 'footprints'],
  [/дорожн.*знак/, 'signpost'], [/разметк/, 'route'],
  [/лежач|неровност|ямы|выбоин|покрыти.*дорог/, 'traffic-cone'],
  [/ремонт.*дорог|реконструкц.*дорог|перекрыти/, 'construction'],
  [/парковк|паркинг/, 'parking-circle'], [/велосипед|самокат/, 'bike'],
  [/такси/, 'car-taxi-front'], [/водный транспорт/, 'ship'],
  [/трамва|железнодорож|ж\/д/, 'train-front'],
  [/расписан|срок.*ожидан|очеред/, 'clock-3'],
  [/маршрут/, 'route'], [/останов|автобус|автовокзал|подвижн.*состав|водительск/, 'bus-front'],
  [/вырубк|опиловк|спил|упавш.*дерев/, 'trees'],
  [/зелен|газон|борщевик|инвазивн|насаждени/, 'sprout'],
  [/детск.*площадк|игров.*площадк/, 'swings'],
  [/огражден|шлагбаум/, 'fence'], [/лавоч|скамей|маф/, 'armchair'],
  [/клещ|комар|насеком/, 'bug'], [/выгул|собак/, 'dog'],
  [/животн|птиц|рыб|ветерин/, 'paw-print'],
  [/фонтан|водных объект|водоохран/, 'waves'],
  [/воздух|атмосфер|выброс/, 'wind'], [/почв/, 'sprout'],
  [/детски.*сад|детского сада|доу|нехватка мест.*дошкол/, 'baby'],
  [/питани|молочн.*кухн/, 'utensils'],
  [/вуз|университет|ссуз|студент|общежити/, 'graduation-cap'],
  [/егэ|огэ|аттестаци/, 'notebook-pen'], [/программ.*образован|образовательн.*программ/, 'book-open'],
  [/школ|сош|гимнази|образовательн.*организац/, 'school'],
  [/больниц|поликлиник|медицинск.*учрежден/, 'hospital'],
  [/медпомощ|медицинск.*помощ|диспансер|медработник|врачебн|донор/, 'heart-pulse'],
  [/справк|документ|лицензи|больничн.*лист/, 'file-check-2'],
  [/пособи|выплат|зарплат|заработн.*плат|пенси|субсиди|материнск.*капитал/, 'wallet'],
  [/льгот.*проезд|проездн|транспортн.*карт|оплат.*проезд/, 'ticket'],
  [/плат.*услуг|жку|плат.*жил|тариф|(?:^|\s)цен(?:а|ы|у|ам|ами|ах)?(?:\s|$)/, 'receipt'],
  [/ипотек|дольщик|найм.*жил/, 'key-round'],
  [/трудоустр|ваканси|стажиров|работодател|социальн.*контракт/, 'briefcase-business'],
  [/гуманитар|поддержк|сирот|помощ.*граждан|защит.*сем/, 'hand-heart'],
  [/интернет/, 'wifi'], [/телевещ|телевид/, 'tv'], [/почтов|почт/, 'mail'],
  [/связи|связь/, 'antenna'],
  [/банкомат|банковск|безналич/, 'credit-card'],
  [/торгов|магазин|киоск|павильон/, 'store'],
  [/промышлен|производств|завод|технопарк/, 'factory'],
  [/фестивал|праздник|мероприяти|концерт/, 'calendar-days'],
  [/спортивн.*секци|трениров|физическ/, 'dumbbell'], [/спорт|регби|стадион/, 'trophy'],
  [/театр|культур|музе/, 'drama'], [/туризм|турист|отдых/, 'tent-tree'],
  [/слушани|обсужден|средства массовой|обращени.*власт/, 'megaphone'],
  [/госуслуг|государственн.*услуг|муниципальн.*услуг/, 'file-check-2'],
  [/избиратель|голосован/, 'list-checks'], [/преступ|полици|правопоряд/, 'shield'],
  [/строитель|стройк/, 'hard-hat'], [/ремонт|содержани.*здани/, 'wrench'],
];

export function categoryIcon(category:string, group:SignalGroup):SignalIcon {
  const text=normalized(category);
  // The event intent wins over place names: «улица Театральная» is still a
  // road closure, while an explicitly named bridge keeps the bridge glyph.
  if(group==='roads'&&BRIDGE_OBJECT.test(text))return 'bridge';
  if(group==='roads'&&/огранич.{0,25}движени|перекро|перекрыти|закры.{0,20}проезд/.test(text))return 'construction';
  return RULES.find(([pattern])=>pattern.test(text))?.[1] ?? SIGNAL_GROUPS[group].icon;
}

export type MarkerVisualState = 'active' | 'urgent' | 'planned' | 'paused' | 'resolved' | 'archive' | 'reported' | 'locality';
type MarkerSignal = Pick<Signal,'category'|'title'|'categoryBreakdown'|'live'> & Partial<Pick<Signal,'summary'|'publishedAt'|'lifecycle'|'closedAt'|'visibility'|'precision'>>;

/** Sprite variants separate current and archived events that share the same topic. */
export function signalMarkerState(signal: MarkerSignal, now = Date.now()): MarkerVisualState {
  // A settlement centre is a navigation hint, even when an event is current.
  if (signal.precision === 'settlement') return 'locality';
  const meaningful = Date.parse(signal.live?.lastMeaningfulAt || signal.lifecycle?.asOf || signal.publishedAt || '');
  const age = now - meaningful;
  if (signal.visibility === 'private' || (Number.isFinite(age) && (age > 45 * 86_400_000 || age < 0))) return 'archive';
  if (signal.closedAt || signal.live?.state === 'resolved' || signal.lifecycle?.status === 'completed') return 'resolved';
  if (signal.live?.state === 'cancelled') return 'archive';
  if (signal.live?.state === 'planned' || signal.lifecycle?.status === 'planned') return 'planned';
  if (signal.live?.state === 'paused') return 'paused';
  if (signal.live && ['high', 'critical'].includes(signal.live.severity)) return 'urgent';
  return normalizeSceneLifecycle(signal, now).activeActivity ? 'active' : 'reported';
}

export function markerFaceColor(group: SignalGroup, state?: MarkerVisualState): string {
  return state === 'locality' ? '#f0f5ed'
    : state === 'urgent' ? '#b4233c'
    : state === 'archive' ? '#62716d'
    : state === 'resolved' ? '#16724d'
    : state === 'paused' ? '#766342'
    : state === 'planned' ? '#a95a00'
    : state === 'active' ? '#007c70'
    : state === 'reported' ? '#276a99'
    : SIGNAL_GROUPS[group].color;
}

export const SIGNAL_STATUS_LEGEND = [
  {state:'urgent',label:'Требует внимания',color:'#b4233c',icon:'shield-alert'},
  {state:'active',label:'В работе',color:'#007c70',icon:'wrench'},
  {state:'planned',label:'Запланировано',color:'#a95a00',icon:'clock-3'},
  {state:'reported',label:'Новое сообщение',color:'#276a99',icon:'megaphone'},
  {state:'resolved',label:'Завершено',color:'#16724d',icon:'file-check-2'},
  {state:'paused',label:'Приостановлено',color:'#766342',icon:'clock-3'},
  {state:'archive',label:'Архив / отменено',color:'#62716d',icon:'notebook-tabs'},
] as const;

/** The second marker phase says what is happening; the first says what it concerns. */
export function markerStatusIcon(state: MarkerVisualState | undefined): SignalIcon {
  return SIGNAL_STATUS_LEGEND.find(item=>item.state===state)?.icon ?? 'circle-help';
}

export function signalStatusPresentation(signal: MarkerSignal) {
  const state=signalMarkerState(signal);
  const normalized=state==='locality'?'reported':state;
  return SIGNAL_STATUS_LEGEND.find(item=>item.state===normalized) ?? SIGNAL_STATUS_LEGEND[3];
}

export type SignalMarker = {
  icon:SignalIcon;group:SignalGroup;color:string;label:string;imageId:string;mixed:boolean;
  state?:LiveEventState|'legacy';stateLabel?:string;sourceKind?:LiveSourceKind|'unknown';
  visualState?: MarkerVisualState; faceColor?: string; approximate?: boolean; locationLabel?: string;
};
export function signalMarker(signal: MarkerSignal):SignalMarker {
  const group=signalGroup(signal.category);
  const breakdown=signal.categoryBreakdown?.filter(item=>item.count>0&&item.name.trim());
  const categories=breakdown?.length ? breakdown.map(item=>item.name) : [signal.title+' '+(signal.summary??'').slice(0,400)];
  const icons=[...new Set(categories.map(category=>categoryIcon(category,group)))];
  const mixed=icons.length>1;
  const activityIcon=signal.live ? ACTIVITY_ICONS[signal.live.activityKind] : undefined;
  // Infrastructure subtypes (water, heat, light) are more informative than a
  // generic repair tool. Road and construction equipment retain their identity.
  const specific=icons[0]!==SIGNAL_GROUPS[group].icon?icons[0]:undefined;
  const topicWinsOverGenericEvent=signal.live?.activityKind==='place_event'&&!['other','culture'].includes(group);
  const icon=mixed?'layers':(topicWinsOverGenericEvent?icons[0]:['utility_fault','utility_repair','place_event'].includes(signal.live?.activityKind??'')?specific??activityIcon:activityIcon)??icons[0]??SIGNAL_GROUPS[group].icon;
  const state=signal.live?.state??'legacy', stateLabel=signal.live?SIGNAL_STATE_LABELS[signal.live.state]:'Без live-статуса';
  const visualState = signalMarkerState(signal);
  const faceColor = markerFaceColor(group,visualState);
  return {group,icon,visualState,faceColor,approximate:visualState==='locality',locationLabel:visualState==='locality'?'Населённый пункт · точный объект не установлен':undefined,color:SIGNAL_GROUPS[group].color,label:breakdown?.length===1?breakdown[0].name:mixed?`${breakdown!.length} категорий`:SIGNAL_GROUPS[group].label,imageId:`atlas-category-${group}-${icon}--${visualState}`,mixed,state,stateLabel,sourceKind:signal.live?.sourceKind??'unknown'};
}
