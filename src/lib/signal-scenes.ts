import {signalSceneRecipe} from './scene-catalog';
import type { Signal, Territory } from './types';
import type { EventScene, SceneDisplay, SceneKind } from './map-signal-scenes';
import { signalMarker } from './signal-markers';
import { normalizeSceneLifecycle } from './scene-lifecycle';

export const SCENE_LABELS: Record<SceneKind, string> = {
  road_defect: 'Дефект дороги', road_repair: 'Ремонт дороги', construction: 'Строительство',
  paused: 'Работы приостановлены', completed: 'Работы завершены',
  utility_fault: 'Авария инженерных сетей', utility_repair: 'Ремонт инженерных сетей',
  waste: 'Скопление отходов', cleanup: 'Уборка', flood: 'Подтопление', snow_ice: 'Снег и наледь',
  emergency: 'Чрезвычайная ситуация', fire: 'Пожар', place_event: 'Событие по адресу', generic: 'Сигнал по адресу',
  roads: 'Дорожные работы', utilities: 'Инженерные сети', landscaping: 'Благоустройство',
  social: 'Социальные объекты', investment: 'Развитие и технологии', culture: 'Городская жизнь',
};

type KindSignal = Pick<Signal, 'category' | 'title' | 'lifecycle' | 'categoryBreakdown' | 'live'>;

/** Live activity/state is authoritative; the category mapper remains for old fixtures and stored signals. */
export function sceneKind(signal: KindSignal): SceneKind | null {
  if (signal.live) {
    if (signal.live.state === 'paused') return 'paused';
    if (signal.live.state === 'cancelled') return 'generic';
    if (signal.live.state === 'resolved') return 'completed';
    return signal.live.activityKind;
  }
  const group = signalMarker(signal).group;
  if (group === 'transport') return null;
  const groups: Partial<Record<typeof group, SceneKind>> = {
    utilities: 'utilities', roads: 'roads', landscape: 'landscaping', ecology: 'landscaping',
    education: 'social', health: 'social', social: 'social', business: 'investment',
    culture: 'culture', communication: 'utilities',
  };
  if (groups[group]) return groups[group]!;
  const text = `${signal.category} ${signal.title}`.toLocaleLowerCase('ru-RU');
  const completed = signal.lifecycle?.status === 'completed';
  if (/благоустрой|озелен|сквер|парк|экологи|отход/.test(text)) return 'landscaping';
  if (/канализац|водоснаб|водопровод|теплоснаб|жкх|энергет|инженерн/.test(text)) return 'utilities';
  if (/дорог|транспорт|мост|асфальт/.test(text)) return 'roads';
  if (!completed && /construction|строитель|капремонт|реконструкц/.test(text)) return 'construction';
  if (/образован|школ|гимнази|детск|здравоохран|социальн|больниц/.test(text)) return 'social';
  if (/tourism|культур|туризм|праздник|фестивал|спорт/.test(text)) return 'culture';
  if (/investment|economy|planning|инвест|эконом|технолог|развити|иннополис/.test(text)) return 'investment';
  if (/infrastructure|инфраструкт/.test(text)) return 'utilities';
  return null;
}

const valid = (point: Signal['coordinates']): point is [number, number] => Boolean(
  point && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85,
);
const validSource = (source: string | null | undefined) => {
  try { return ['http:', 'https:'].includes(new URL(source ?? '').protocol); } catch { return false; }
};
const timestamp = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function liveDisplay(signal: Signal, now: number): SceneDisplay | null {
  const live = signal.live;
  if (!live) return null;
  const meaningfulAt = timestamp(live.lastMeaningfulAt);
  if (meaningfulAt === null || meaningfulAt > now) return null;
  if (live.state === 'cancelled') return 'static';
  if (live.state === 'resolved') {
    return now - meaningfulAt <= 14 * 86_400_000 ? 'completed' : null;
  }
  if (live.state === 'paused') return 'paused';
  return normalizeSceneLifecycle(signal, now).activeActivity ? 'active' : 'static';
}

/** A supply outage or pipe replacement alone does not establish an open trench. */
export function sourceDescribesExcavation(text: string): boolean {
  return text.split(/[.!?;\n]+/).some(sentence =>
    /раскоп(?:к|оч)|разрыт|открыт\S*\s+транше|транше(?:я|ю|и|й)|котлован|землян\S*\s+работ/i.test(sentence)
    && !/бестраншей|без\s+(?:\S+\s+){0,2}(?:раскоп|транше|землян)|не\s+(?:провод|ведут|предусмотр|требуют|нуж)|планир|запланир|предстоит|будут\s+/i.test(sentence),
  );
}

function sourceCoverage(signal: Pick<Signal, 'title' | 'summary' | 'precision' | 'locationVerificationMethod'>) {
  const text = signal.title + ' ' + (signal.summary ?? '');
  const entireStreet = /(?:на вс[её]м протяжении|по всей (?:улице|дороге)|всю улицу|вся улица)/i.test(text);
  const entireBuilding = /(?:по всему (?:зданию|периметру)|вс[её] здание|всех фасад)/i.test(text);
  const confirmedSection = signal.locationVerificationMethod === 'source-section-intersections';
  const describedSection = /(?:на\s+участке|участ[а-яё]*\s+(?:улиц|дорог)|от\s+[^.!?]{2,180}?\s+до\s+)/i.test(text);
  return { entireStreet, describedSection, confirmedSection, confirmed: signal.precision === 'street' ? entireStreet || confirmedSection : signal.precision === 'building' ? entireBuilding : true };
}

export function hasConfirmedSceneCoverage(signal: Pick<Signal, 'title' | 'summary' | 'precision' | 'locationVerificationMethod'>): boolean {
  return sourceCoverage(signal).confirmed;
}

export function shouldSuppressStreetScene(signal: Pick<Signal, 'title' | 'summary' | 'precision' | 'locationVerificationMethod' | 'live'>): boolean {
  if (signal.precision !== 'street' || hasConfirmedSceneCoverage(signal)) return false;
  // A future schedule has no current scene. Once its start time has passed,
  // a source-linked street may show a static thematic scene; animation still
  // requires explicit current-work evidence in normalizeSceneLifecycle.
  return signal.live?.state === 'planned';
}

export function sceneCoverageDescription(signal: Signal): string | null {
  if (!valid(signal.coordinates) || !validSource(signal.coordinateSourceUrl) || !(['roads', 'utilities', 'construction'].includes(signalMarker(signal).group) || ['traffic', 'bridge'].includes(signalSceneRecipe(signal)?.family ?? ''))) return null;
  const { confirmed, describedSection, confirmedSection } = sourceCoverage(signal);
  if (signal.precision === 'street' && ['LineString', 'MultiLineString'].includes(signal.siteGeometry?.type ?? '')) {
    if (confirmedSection) return 'Сцена ограничена участком между ориентирами, указанными в источнике.';
    if (!confirmed && describedSection) return 'Иллюстрация по связанной улице. Границы указанного в источнике участка пока не сопоставлены с картой.';
    return confirmed ? 'Сцена охватывает всю улицу, как указано в источнике.' : 'Иллюстрация по всей связанной улице. Точный участок работ в источнике не указан.';
  }
  if (signal.precision === 'building') return confirmed ? 'Сцена охватывает периметр здания, как указано в источнике.' : 'Иллюстрация по периметру здания. Точная зона работ в источнике не указана.';
  if (signal.precision === 'site' && ['Polygon', 'MultiPolygon'].includes(signal.siteGeometry?.type ?? '')) return 'Сцена размещена в границах связанной площадки.';
  return null;
}

export function makeEventScenes(signals: Signal[], _territories: Territory[], now = Date.now(), selectedId?:string|null): EventScene[] {
  const precise: EventScene[] = [];
  for (const signal of [...signals].sort((a, b) => a.id.localeCompare(b.id))) {
    const selected=signal.id===selectedId, recipe=signalSceneRecipe(signal);
    const kind = selected&&!signal.live&&recipe ? recipe.sceneKind as SceneKind : sceneKind(signal)??(selected?recipe?.sceneKind as SceneKind:null);
    if (!kind || !valid(signal.coordinates) || !['building', 'site', 'street'].includes(signal.precision)) continue;
    const marker = signalMarker(signal);
    if (marker.mixed) continue;

    const lifecycle = normalizeSceneLifecycle(signal, now);
    const historical=signal.visibility==='private'||Boolean(signal.live&&now-Date.parse(signal.live.lastMeaningfulAt)>45*86400000);
    const display = signal.live ? liveDisplay(signal, now) ?? (selected?'archive':null) : lifecycle.activeActivity ? 'active' : selected?'archive':null;
    if (!display) continue;

    // The parser's coarse confidence can lag behind a later source-backed
    // geocoding upgrade. A real linked geometry is stronger evidence than the
    // original label; only an ungrounded mismatch suppresses the scene.
    const geometryMatchesPrecision = (['building','site'].includes(signal.precision) && ['Polygon','MultiPolygon'].includes(signal.siteGeometry?.type ?? ''))
      || (signal.precision==='street' && ['LineString','MultiLineString'].includes(signal.siteGeometry?.type ?? ''));
    const locationRank:Record<string,number>={territory:0,settlement:1,street:2,site:3,building:3};
    const sourceBackedUpgrade=Boolean(signal.live&&geometryMatchesPrecision&&validSource(signal.coordinateSourceUrl)&&(locationRank[signal.precision]??-1)>(locationRank[signal.live.locationConfidence]??-1));
    if (signal.live && signal.live.locationConfidence !== signal.precision && !sourceBackedUpgrade) continue;
    const activityKind = signal.live?.activityKind;
    // A postal address in the source is enough for a marker and card, but a
    // street centreline is not the playground/site footprint. Do not lay a
    // place-event diorama across the carriageway until the site is mapped.
    if (activityKind === 'place_event' && signal.precision === 'street') continue;
    if (['road_defect', 'road_repair'].includes(activityKind ?? '') && signal.precision !== 'street') continue;
    if (kind === 'roads' && signal.precision !== 'street') continue;
    if (!validSource(signal.coordinateSourceUrl)) continue;
    const geometry = signal.siteGeometry;
    if (signal.precision === 'site' && !['Polygon', 'MultiPolygon'].includes(geometry?.type ?? '')) continue;
    if (signal.precision === 'street' && !['LineString', 'MultiLineString'].includes(geometry?.type ?? '')) continue;

    const { entireStreet, confirmed } = sourceCoverage(signal);
    // A street is an object, but a linked street alone does not identify a
    // work zone. Keep its marker and address; do not turn generic city life
    // into an invented event scene for planned or merely inferred work.
    if (shouldSuppressStreetScene(signal)) continue;
    const lastKnownWork = Boolean(signal.live?.explicitActivity && ['road_repair', 'utility_repair', 'construction'].includes(signal.live.activityKind)
      || signal.lifecycle?.animationEligible && signal.lifecycle.currentStatusVerified && validSource(signal.lifecycle.sourceUrl)
      && (timestamp(signal.lifecycle.asOf) ?? Infinity) <= now && ['roads', 'utilities', 'construction'].includes(kind));
    precise.push({
      recipe: recipe??undefined,
      entireStreet,
      coverageMode: confirmed ? 'confirmed-source-scope' : 'linked-object-illustration',
      lastKnownWork,
      excavationConfirmed: sourceDescribesExcavation(signal.title + '. ' + (signal.summary ?? '')),
      id: signal.id,
      title: signal.title,
      kind,
      activityKind,
      display: historical&&!lifecycle.activeActivity?'archive':display,
      selected,
      state:lifecycle.state,
      priority: signal.live?.severity==='critical'?4:signal.live?.severity==='high'?3:signal.live?.severity==='medium'?2:1,
      coordinates: [...signal.coordinates],
      precision: signal.precision,
      planned: signal.live?.state === 'planned' || (!signal.live && signal.lifecycle?.status === 'planned'),
      territoryId: signal.territoryId,
      geometry,
      lifecycle: signal.lifecycle,
      live: signal.live,
      activityExpiresAt: lifecycle.activityExpiresAt,
      topic: marker.group,
      icon: marker.icon,
    });
  }
  return precise;
}
