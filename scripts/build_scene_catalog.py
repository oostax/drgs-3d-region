"""Compile stable topic identities and data-driven scene recipes from local taxonomy."""
import hashlib,json,re,sqlite3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
# Every source group remains intact. Nonphysical services deliberately use thematic signs.
GROUPS={
'Безопасность и правопорядок':('safety','shield'),'Благоустройство':('landscape','trees'),
'Внутренняя политика':('services','landmark'),'Военная служба':('social','hand-heart'),
'Дороги':('roads','traffic-cone'),'ЖКХ':('housing','building-2'),'Здравоохранение':('health','heart-pulse'),
'Имущественные и земельные отношения':('services','landmark'),'Культура':('culture','drama'),
'Межнациональные отношения':('social','hand-heart'),'Молодежная политика':('social','hand-heart'),
'Образование':('education','graduation-cap'),'Обращение с отходами':('waste','trash-2'),
'Общественный транспорт':('transit','bus-front'),'Органы власти и подведомственные учреждения':('services','landmark'),
'Связь и телевидение':('communication','wifi'),'Сельское хозяйство и охота':('agriculture','wheat'),
'Социальное обслуживание и защита':('social','hand-heart'),'Строительство и архитектура':('construction','construction'),
'Труд и занятость':('employment','briefcase-business'),'Туризм':('tourism','map-pinned'),
'Физическая культура и спорт':('sport','dumbbell'),'ЦУР':('services','landmark'),
'Экология':('ecology','sprout'),'Экономика и бизнес':('economy','store'),'Энергетика':('electricity','zap')}
RULES=[
(r'ипотек|дольщик|льгот|выплат|субсиди|пособи|очеред|сертификат|плата за|тариф|перерасч','services','landmark'),
(r'снег|налед','snow','snowflake'),(r'подтоп|затоп|павод','flood','waves'),
(r'ямы|выбоин|некачественное покрытие','road_defect','traffic-cone'),
(r'перекрыти|объезд|ограничение движения','traffic','signpost'),
(r'\bмост','bridge','construction'),(r'освещени','lighting','lamp-desk'),
(r'фасад|кровл|капитальный ремонт домов|ремонт мест общего','renovation','paint-roller'),
(r'лифт','housing','building-2'),(r'газоснаб|газификац','gas','flame'),
(r'отоплен','heating','heater'),(r'водоснаб|водоотвед|\bводы\b|водоразбор|канализац','water','droplets'),
(r'упавшие деревья|спил дерев|вырубк|насажден','trees','trees'),
(r'банкомат|офис банка','banking','landmark'),
(r'строительство школ|строительство спортивных','construction','construction')]
FAMILIES={
'construction':('Строительство','construction',['building','site'],30*24),
'renovation':('Ремонт здания','construction',['building'],7*24),
'road_defect':('Дефекты покрытия','road_defect',['street'],7*24),
'roads':('Дороги и тротуары','road_repair',['street'],7*24),
'bridge':('Мосты','road_repair',['street'],7*24),
 'traffic':('Ограничения движения','place_event',['street'],24),
'water':('Вода и канализация','utility_repair',['building','site','street'],6),
'heating':('Теплоснабжение','utility_repair',['building','site','street'],6),
'gas':('Газоснабжение','utility_repair',['building','site','street'],6),
'electricity':('Электроснабжение','utility_repair',['building','site','street'],6),
'lighting':('Освещение','utility_repair',['street','site'],7*24),
'waste':('Отходы','waste',['site'],7*24),
'landscape':('Благоустройство','landscaping',['site','street'],7*24),
 'trees':('Деревья и озеленение','landscaping',['site','street'],7*24),
'ecology':('Экология','generic',['site'],6),
'snow':('Снег и наледь','snow_ice',['site','street'],6),
'flood':('Подтопление','flood',['site'],6),
'fire':('Пожар','fire',['building','site'],6),
'weather':('Погода','emergency',['site'],6),
'housing':('Жильё','social',['building'],7*24),
'safety':('Безопасность','generic',['building','site','street'],6),
 'health':('Медицина','social',['building'],7*24),
'education':('Образование','social',['building'],7*24),
'culture':('Культура','culture',['building','site'],24),
'sport':('Спорт','culture',['building','site'],24),
 'tourism':('Туризм','culture',['building','site','street'],24),
 'transit':('Общественный транспорт','place_event',['building','street','site'],24),
'communication':('Связь','utilities',['building','site'],6),
 'agriculture':('Сельское хозяйство','investment',['site'],7*24),
'economy':('Экономика','investment',['building','site'],30*24),
'employment':('Занятость','social',['building'],30*24),
'social':('Социальная поддержка','social',['building'],30*24),
'services':('Муниципальные услуги','generic',['building'],30*24),
'banking':('Банки и обслуживание','place_event',['building','site'],7*24)}
NEWS={
'construction':['Подготовка площадки','Котлован','Фундамент','Возведение каркаса','Монтаж перекрытий','Доставка материалов','Отделка','Ввод объекта'],
'renovation':['Ремонт фасада','Ремонт кровли','Ремонт входной группы','Временное закрытие здания'],
'roads':['Фрезерование покрытия','Укладка асфальта','Уплотнение катком','Нанесение разметки','Ремонт бордюров','Ремонт ливневой канализации'],
'bridge':['Ремонт пролёта','Восстановление движения по мосту'],'traffic':['Закрытие проезда','Подтверждённый объезд'],
'water':['Прорыв сети','Откачка воды','Восстановление водоснабжения'],'heating':['Ремонт теплового пункта'],
'electricity':['Ремонт подстанции'],'gas':['Восстановление подачи газа'],'waste':['Вывоз отходов','Установка контейнеров'],
'landscape':['Открытие парка','Ремонт детской площадки'],'trees':['Посадка деревьев','Расчистка упавших деревьев'],
'ecology':['Очистка водоёма','Загрязнение воздуха'],'fire':['Возгорание объекта'],'flood':['Подтопление территории'],
'weather':['Последствия сильного ветра'],'transit':['Изменение маршрута','Ремонт остановки'],
'health':['Открытие медицинского учреждения'],'education':['Открытие школы'],
'culture':['Открытие культурного центра','Мероприятие'],'sport':['Открытие спортивного объекта'],
'economy':['Инвестиционный проект','Расширение производства'],'agriculture':['Сезонные сельскохозяйственные работы'],
'communication':['Подключение учреждения к связи'],'banking':['Открытие офиса','Перенос банкомата','Ограничение обслуживания']}

def recipe(group,topic,source='complaints',family=None):
    f,icon=GROUPS.get(group,('services','landmark'))
    if family:f=family
    else:
        for pattern,target,glyph in RULES:
            if re.search(pattern,topic.lower()):f,icon=target,glyph;break
    label,kind,geometry,ttl=FAMILIES[f]
    if family:icon={'construction':'construction','renovation':'paint-roller','roads':'traffic-cone','road_defect':'traffic-cone','bridge':'construction','traffic':'signpost','water':'droplets','heating':'heater','gas':'flame','electricity':'zap','lighting':'lamp-desk','trees':'trees','snow':'snowflake','flood':'waves','fire':'flame','weather':'cloud-lightning','banking':'landmark'}.get(family,next((glyph for fam,glyph in GROUPS.values() if fam==family),'landmark'))
    return {'id':source+':'+hashlib.sha256((group+'|'+topic).encode()).hexdigest()[:16], 'source':source,
        'group':group,'topic':topic,'family':f,'sceneKind':kind,'icon':icon,'geometry':geometry,
        'fallback':'territory_summary','near':'thematic_sign_and_confirmed_geometry',
        'detail':'physical_if_supported_else_thematic_sign','activityTtlHours':ttl,
        'animation':'confirmed_activity_only','statePolicy':'evidence-v1'}

def main():
    c=sqlite3.connect('file:'+str(ROOT/'private-data/atlas.sqlite')+'?mode=ro',uri=True)
    rows=c.execute('select distinct topic_group,topic from incidents order by topic_group,topic').fetchall()
    assert len(rows)==247 and len({g for g,t in rows})==26
    recipes=[recipe(g,t) for g,t in rows]
    recipes += [recipe(FAMILIES[f][0],t,'news',f) for f,topics in NEWS.items() for t in topics]
    data={'version':'1.0.1','sourceTaxonomy':{'groups':26,'topics':247},'families':{k:{'label':v[0],'kind':v[1]} for k,v in FAMILIES.items()},
        'states':{'reported':'Сообщают','planned':'Запланировано','in_progress':'Выполняется','paused':'Приостановлено','resolved':'Завершено','cancelled':'Отменено','unknown':'Требуется уточнение'},'recipes':recipes}
    target=ROOT/'src/data/scene-catalog.json';target.parent.mkdir(exist_ok=True);target.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    print('Catalog:',len(recipes),'recipes,',len(FAMILIES),'families')
if __name__=='__main__':main()
