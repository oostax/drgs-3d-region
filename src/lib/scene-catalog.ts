import catalog from '../data/scene-catalog.json';
import type { SceneKind } from './map-signal-scenes';
import type { Signal } from './types';
import {signalMarker} from './signal-markers';
export const sceneCatalog = catalog;
export type SceneRecipe = (typeof catalog.recipes)[number];
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/\s+/g,' ').trim();
const byTopic = new Map(catalog.recipes.map(recipe => [normalize(recipe.group)+'|'+normalize(recipe.topic),recipe]));
export function sceneRecipe(group: string, topic: string): SceneRecipe | null {
  return byTopic.get(normalize(group)+'|'+normalize(topic)) ?? null;
}

/** One resolver for gallery, cards and map. A headline need not repeat a catalog label. */
export function signalSceneRecipe(signal: Pick<Signal,'category'|'title'|'summary'|'categoryBreakdown'|'live'>): SceneRecipe | null {
  const exact=sceneRecipe(signal.category,signal.categoryBreakdown?.length===1?signal.categoryBreakdown[0].name:signal.title);
  if(exact)return exact;
  const text=normalize(signal.title+' '+(signal.summary??'')), group=signalMarker(signal).group;
  if (group === 'roads' && /перекро(?:ют|ется|й)|ограничени[яй].{0,30}движени|движени[ея].{0,20}огранич|закрыти[ея].{0,16}проезда|проезд.{0,16}закро/.test(text)) {
    return catalog.recipes.find(recipe => recipe.source === 'news' && recipe.topic === 'Закрытие проезда') ?? null;
  }
  const variants:[RegExp,string][]=[
    [/фрезер/,'Фрезерование покрытия'],[/бордюр|бортов.{0,8}кам/,'Ремонт бордюров'],[/разметк/,'Нанесение разметки'],
    [/укладк.{0,20}асфальт|асфальтирован/,'Укладка асфальта'],[/каркас/,'Возведение каркаса'],[/котлован/,'Котлован'],
    [/фундамент/,'Фундамент'],[/ремонт.{0,20}кровл/,'Ремонт кровли'],[/ремонт.{0,20}фасад/,'Ремонт фасада'],
    [/отключени.{0,15}вод|отсутств.{0,20}вод/,'Отсутствие холодной и/или горячей воды'],[/откачк/,'Откачка воды'],[/ливнев/,'Ремонт ливневой канализации'],
  ];
  const variant=variants.find(([pattern])=>pattern.test(text));
  if(variant){const found=catalog.recipes.find(r=>r.topic===variant[1]);if(found)return found;}
  // A facility name identifies the subject, not an opening or construction stage.
  if(/(?:открыл|открыт|открыва|введен|ввели в эксплуатацию)/.test(text)&&/центр регби|спортивн.{0,12}(центр|объект)|стадион/.test(text)){
    return catalog.recipes.find(r=>r.source==='news'&&r.topic==='Открытие спортивного объекта')??null;
  }
  const family = group==='construction'?'construction':group==='utilities'? /газ/.test(text)?'gas':/тепл|отоплен/.test(text)?'heating':/электр|свет/.test(text)?'electricity':'water'
    :group==='roads'?/ям[аыу]|выбоин|дефект/.test(text)?'road_defect':'roads'
    :group==='landscape'?/мусор|свалк|отход/.test(text)?'waste':/дерев|озелен/.test(text)?'trees':'landscape'
    :group==='health'?'health':group==='education'?'education':group==='culture'?'culture':group==='transport'?'transit'
    :group==='communication'?'communication':group==='business'?'economy':group==='social'?'social':group==='ecology'?'ecology'
    :group==='safety'?/подтоп|наводнен/.test(text)?'flood':/пожар|возгоран/.test(text)?'fire':'weather':null;
  // The generic family recipe must not invent a specific construction stage.
  // Never select the first member of a family: its subject may be unrelated
  // (e.g. bicycle lanes for a future road closure). A neutral recipe is explicit.
  const neutral: Record<string,string> = {
    construction:'Строительство и архитектура прочее', roads:'Дороги прочее',
    waste:'Обращение с отходами прочее', landscape:'Благоустройство прочее',
    ecology:'Экология прочее', housing:'ЖКХ прочее', safety:'Безопасность и правопорядок прочее',
    health:'Здравоохранение прочее', education:'Образование прочее', culture:'Культура прочее',
    sport:'Физическая культура и спорт прочее', tourism:'Туризм прочее', transit:'Общественный транспорт прочее',
    communication:'Связь и телевидение прочее', economy:'Экономика и бизнес прочее',
    employment:'Труд и занятость прочее', social:'Социальное обслуживание и защита прочее',
    services:'Органы власти и подведомственные учреждения прочее',
  };
  return family && neutral[family] ? catalog.recipes.find(recipe => recipe.family === family && recipe.topic === neutral[family]) ?? null : null;
}
export function recipePresentation(recipe: SceneRecipe | null, state: string, precision: string, confirmed: boolean) {
  if (!recipe) return { kind:'generic' as SceneKind, mode:'review', animate:false };
  const precise = recipe.geometry.includes(precision);
  const mode = !precise ? 'territory_summary' : state==='cancelled' || state==='unknown' || !confirmed ? 'thematic_sign' : 'scene';
  return {kind:(state==='cancelled'?'generic':recipe.sceneKind) as SceneKind,mode,animate:mode==='scene'&&state==='in_progress'};
}
