export type LandmarkModelKind =
  | 'QolSharif' | 'SuyumbikeTower' | 'SpasskayaTower' | 'FarmersPalace'
  | 'KazanFamilyCenter' | 'InnopolisUniversity' | 'PopovTechnopark' | 'WhiteMosqueBolgar';

export interface Landmark {
  id: string;
  name: string;
  subtitle: string;
  territoryId: string;
  /** WGS84 [longitude, latitude]; checked against the OSM feature on 2026-09-04. */
  coordinates: [number, number];
  /** Radians counterclockwise around local Z. Orientation is illustrative. */
  rotation: number;
  /** Approximate model height in metres, for camera framing; not a survey value. */
  height: number;
  sourceUrl: string;
  referenceUrl: string;
  description: string;
  modelKind: LandmarkModelKind;
}

/**
 * Coordinates are bounding-box centres of the actual OSM building outlines,
 * retrieved with api.openstreetmap.org/api/0.6/{way|relation}/{id}/full.
 * In particular, Innopolis uses the university BUILDING (308285819), not the
 * larger campus polygon; Popov uses building relation 3399852, not a bus stop.
 * Coordinate attribution: © OpenStreetMap contributors, ODbL 1.0.
 * Models are original procedural interpretations based on public references.
 * Decorative proportions and orientations are approximate, not surveyed BIM.
 */
export const LANDMARKS: Landmark[] = [
  {
    id: 'qol-sharif', name: 'Кул Шариф', subtitle: 'Казанский Кремль',
    territoryId: 'mo-92701000', coordinates: [49.1051597, 55.79834865],
    rotation: 0, height: 56, modelKind: 'QolSharif',
    sourceUrl: 'https://www.openstreetmap.org/way/230132591',
    referenceUrl: 'https://kazan-kremlin.ru/en/architectural-objects/mechet-kul-sharif',
    description: 'Белый мрамор, бирюзовый купол и четыре главных минарета. Архитектурная доминанта Казанского Кремля.',
  },
  {
    id: 'suyumbike', name: 'Башня Сююмбике', subtitle: 'Семь ярусов истории',
    territoryId: 'mo-92701000', coordinates: [49.10518105, 55.80047585],
    rotation: 0.235, height: 59, modelKind: 'SuyumbikeTower',
    sourceUrl: 'https://www.openstreetmap.org/way/228963085',
    referenceUrl: 'https://kazan-kremlin.ru/',
    description: 'Ступенчатая кирпичная башня с арочным проездом, восьмигранными ярусами и высоким шатром.',
  },
  {
    id: 'spasskaya', name: 'Спасская башня', subtitle: 'Главные ворота Кремля',
    territoryId: 'mo-92701000', coordinates: [49.10807935, 55.79653445],
    rotation: 0, height: 49, modelKind: 'SpasskayaTower',
    sourceUrl: 'https://www.openstreetmap.org/relation/15958803',
    referenceUrl: 'https://kazan-kremlin.ru/en/museums/muzej-spasskoj-bashni',
    description: 'Белокаменная надвратная башня с часами, открытыми арками звонницы и золотой звездой.',
  },
  {
    id: 'farmers-palace', name: 'Дворец земледельцев', subtitle: 'Министерство сельского хозяйства',
    territoryId: 'mo-92701000', coordinates: [49.1119517, 55.800457],
    rotation: -Math.PI * 0.75, height: 50, modelKind: 'FarmersPalace',
    sourceUrl: 'https://www.openstreetmap.org/way/90251771',
    referenceUrl: 'https://go.kzn.ru/places/dvorec-zemledelcev',
    description: 'Симметричные крылья, колоннады и зелёный купол. Бронзовое дерево в центральном портале стало символом дворца.',
  },
  {
    id: 'kazan-family-center', name: 'Центр семьи «Казан»', subtitle: 'Чаша на берегу Казанки',
    territoryId: 'mo-92701000', coordinates: [49.10824125, 55.8128093],
    rotation: 0, height: 32, modelKind: 'KazanFamilyCenter',
    sourceUrl: 'https://www.openstreetmap.org/way/222787130',
    referenceUrl: 'https://centerkazan.ru/',
    description: 'Монументальная чаша с бронзовыми рёбрами, поднятая над стеклянным основанием. На кровле расположена смотровая площадка.',
  },
  {
    id: 'innopolis-university', name: 'Университет Иннополис', subtitle: 'Образование и робототехника',
    territoryId: 'mo-92620109', coordinates: [48.74362155, 55.7536903],
    rotation: 0, height: 22, modelKind: 'InnopolisUniversity',
    sourceUrl: 'https://www.openstreetmap.org/way/308285819',
    referenceUrl: 'https://kazanforum.ru/promekskursii/',
    description: 'Современный учебный корпус с ломаным планом, стеклянными фасадами, белыми рамами и тёплыми ламелями.',
  },
  {
    id: 'popov-technopark', name: 'Технопарк имени Попова', subtitle: 'Технологический центр Иннополиса',
    territoryId: 'mo-92620109', coordinates: [48.75229995, 55.7519036],
    rotation: 0, height: 31, modelKind: 'PopovTechnopark',
    sourceUrl: 'https://www.openstreetmap.org/relation/3399852',
    referenceUrl: 'https://innopolis.com/',
    description: 'Кольцевой стеклянный корпус с семью этажами и внутренним двором — узнаваемый центр технологического города.',
  },
  {
    id: 'white-mosque-bolgar', name: 'Белая мечеть', subtitle: 'Болгар · Спасский район',
    territoryId: 'mo-92632101', coordinates: [49.0612657, 54.96613015],
    rotation: Math.PI - 0.18, height: 47, modelKind: 'WhiteMosqueBolgar',
    sourceUrl: 'https://www.openstreetmap.org/way/265653923',
    referenceUrl: 'https://vbolgar.ru/',
    description: 'Беломраморный ансамбль с двумя минаретами, тремя куполами, открытыми аркадами и водоёмом во дворе.',
  },
];

export const LANDMARK_COORDINATES_VERIFIED_AT = '2026-09-04';
export const LANDMARK_MODEL_ATTRIBUTION = 'Авторские процедурные модели по публичным архитектурным источникам; пропорции приблизительны. Координаты: © OpenStreetMap contributors, ODbL.';
