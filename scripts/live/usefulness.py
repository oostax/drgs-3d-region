"""Source-grounded display relevance, independent of source trust and freshness."""
from __future__ import annotations
import re
from typing import Any
from connectors import FeedDocument

VERSION = 'useful-v2-local-incidents'
# Exclusions describe the purpose of the publication, not an isolated word that
# can also occur in a real incident. Russian and Tatar feeds are both supported.
NOISE_PATTERNS = {
    'advertising': r'(?:^|\s)#?реклама(?:\W|$)|рекламодатель|\berid\b|на заказ.{0,35}(?:новосибирск|москв)',
    'horoscope_or_folklore': r'гороскоп|астролог|народные приметы|приметы дня|сынамы[шш]|йолдызнам[әа]|зодиак',
    'recruitment_advertising': r'(?:подпишет|подписать|заключить).{0,45}контракт.{0,80}(?:миноборон|миллион|млн)|набор в элитное подразделение|выплачивать до 20 млн|списать все долги',
}
EDITORIAL_PATTERNS = {
    'greeting_or_award': r'поздрав|юбиле[йяе]|чествован|наградили|награжден|награждён|поч[её]тн.{0,15}гражданин|доск[аиуы].{0,20}поч[её]та|котлыйбыз|тәбриклибез',
    'biography_or_history': r'лет назад|история.{0,15}(?:жизни|семьи|любви)|строит планы на мирную жизнь|в конце 90.х|в начале 2000.х|свадебный элемент|день за днем.{0,20}эвакогоспитал',
    'advice_without_local_change': r'^(?:.{0,8})?(?:как\s|почему\s|зачем\s|\d+\s+(?:совет|способ))|врач назвал|эксперт (?:объяснил|оценил|рассказал)|противопоказания|рекомендуют употреблять',
    'routine_statistics_or_roundup': r'итоги (?:дня|недели)|главн.{0,15}(?:за день|за неделю)|дайджест|за (?:сутки|минувш.{0,10}сутки|неделю).{0,80}(?:вызов|пожар|дтп|произошло|зарегистр)|узган атнада.{0,100}чакыру|оперативная сводка|с начала года.{0,70}(?:зафиксирован|авари|происшеств)',
    'training_or_awareness': r'учебн.{0,18}эвакуац|урок.{0,50}безопасност|формировани.{0,30}культур.{0,25}безопасност|свеч[аи] памят|день солидарности',
    'sports_results': r'(?:футбол|хокке|команда).{0,80}(?:побед|проигра|счет|счёт|җиңде)|командасын.{0,60}җиңде',
    'protocol_or_participation': r'(?:россия|республика|делегац|организатор).{0,90}открыт[аоы]?\s+для\s+(?:участия|сотрудничества)|(?:участие|участвовать).{0,70}(?:соревнован|форум|конференц)|заинтересованн.{0,30}стран',
    'profile_without_local_change': r'мы отправились.{0,100}(?:показать труд|поговорить)|труд этих самоотверженных|история удивительна',
    'routine_weather': r'прогноз погоды|погода на \d|ожидаются грозы.{0,50}градус|көне.{0,30}һава торышы',
}
CHANGE = re.compile(
    r'ремонтиру|вед[её]тся монтаж|ведутся работ|идут работ|работы (?:начаты|начались|прошли)|'
    r'начал[аи] (?:работ|ремонт|строительств)|приступили|строитс[яь]|возводят|возводится|'
    r'отремонтирова|реконструирова|модернизирова|установили|заменили|восстановили|'
    r'\bоткры(?:ли|т[аоы]?|лся|лась|лись)\b|\bввели\b|запустили|расширили|'
    r'отключат|отключен|отключён|приостановят|перекроют|введут огранич|ограничат|'
    r'возгорание (?:произошло|возникло)|загорел(?:ись|ся|ась|ось)|прорвало|произош.{0,15}авари|произош.{0,15}пожар|горит\b|затопило|без воды|без свет|'
    r'выросл[аио].{0,45}\d|снизил[аио].{0,45}\d|подписали.{0,25}(?:соглашен|контракт)|'
    r'объявлен.{0,25}(?:конкурс|тендер)|начат.{0,15}при[её]м заяв|выделили.{0,40}(?:млн|милли|руб)|'
    r'төзелә|төзелде|төзелеп|ремонтлана|яңартыл|ачылды|ачылачак|ачыла|сүндерелә|сүнәчәк|өзелде', re.I)
PLANNED_CHANGE = re.compile(
    r'планиру(?!йте|й\b).{0,50}(?:стро|откры|ремонт|инвест)|предстоит.{0,30}(?:ремонт|откры|стро)|'
    r'начнут|построят|откроют|завершат|проект.{0,30}(?:нов|строительств)|'
    r'строительств|капремонт|реконструкц|монтаж|отключение|отключения|'
    r'при[её]м заявок|тендер|закупк|инвестиц.{0,50}(?:проект|млн|миллиард)|'
    r'закупочн.{0,25}цен.{0,25}(?:вырос|измен|сниз)|барлыкка киләчәк|төзелеш', re.I)
IMPACT = re.compile(r'водоснабж|электроснабж|электроэнерг|отоплен|газоснабж|школ|детск.{0,15}сад|больниц|поликлиник|мост|күпер|проезд|движен|производств|инвест|рабочи[ех] мест|закупочн.{0,20}цен',re.I)
AMOUNT = re.compile(r'\d[\d., ]*\s*(?:млн|миллион|млрд|миллиард|рубл|рабочих мест|квартир|километр|тыс\.?\s*(?:человек|жител|рубл)|метров|учени[кк]|мест|светофор)',re.I)
LOCAL_NAME = re.compile(r'\b(?i:в|на|под|из)\s+(?:(?:селе|поселке|посёлке|деревне|городе)\s+)?([А-ЯЁӘӨҮҖҢҺ][а-яёәөүҗңһ]+(?:[- ][А-ЯЁӘӨҮҖҢҺ][а-яёәөүҗңһ]+)?(?:\s+(?:районе|округе|поселке|посёлке|селе))?)|\b[А-ЯЁӘӨҮҖҢҺ][а-яёәөүҗңһ]+\s+(?:авылында|районында)',re.U)
FACILITY = re.compile(r'(?:школ|лице[йя]|детск.{0,10}сад|поликлиник|завод|комплекс|предприяти|парк|больниц)[^.!?\n]{0,40}(?:№\s*\d|[«\"][^»\"]{2,50}[»\"])',re.I)
REGION_NAMES = {'россии','татарстане','республике татарстан','стране','республике','москве'}


def publication_noise_reasons(document: FeedDocument) -> list[str]:
    headline = document.title.casefold()
    lead = (document.title+'\n'+document.body[:220]).casefold()
    text = (document.title+'\n'+document.body[:14000]).casefold()
    reasons=[key for key,pattern in NOISE_PATTERNS.items() if re.search(pattern,text)]
    for key,pattern in EDITORIAL_PATTERNS.items():
        haystack=text if key=='profile_without_local_change' else lead if key in {'greeting_or_award','biography_or_history','training_or_awareness'} else headline
        if re.search(pattern,haystack):
            # A documented facility opening embedded in a safety lesson is a
            # separate material change. Mere "repair" in a worker's award is not.
            if key=='training_or_awareness' and re.search(r'открыли.{0,60}(?:комплекс|часть|полигон)|построен.{0,60}(?:комплекс|полигон)',text):continue
            if key=='routine_weather' and re.search(r'штормов.{0,20}предупрежден|опасн.{0,20}метеоролог|чрезвычайн.{0,15}ситуац',text):continue
            reasons.append(key)
    if re.search(r'концерт|фестивал|выставка картин|забег|соревнован|книжн.{0,15}презентац|китапны тәкъдир',headline):
        if not re.search(r'ремонт|строитс|постро|отключ|ограничен|перекро|инвест|открыли.{0,35}(?:центр|стадион|школ)',text):
            reasons.append('event_without_operational_change')
    return list(dict.fromkeys(reasons))


def classify_usefulness(document: FeedDocument, event: dict[str,Any] | None=None, source: Any | None=None) -> dict[str,Any]:
    """Score documented change; never infer bank clients, revenue, or certainty."""
    event=event or {}
    text=(document.title+'\n'+document.body[:14000]).strip()
    reasons=publication_noise_reasons(document)
    statements=[s.strip() for s in re.split(r'(?<=[.!?])\s+|\n+',text) if s.strip()]
    changes=[s for s in statements if CHANGE.search(s)]
    planned=[s for s in statements if PLANNED_CHANGE.search(s)]
    # A negated/counterfactual action cannot support an operational map signal.
    changes=[s for s in changes if not re.search(r'не\s+(?:строится|ремонтируют|начали)|если бы|мог(?:ли|ло|ла)? бы|мечтает|строит планы|открыт[аоы]?\s+для\s+(?:участия|сотрудничества)',s,re.I)]
    addresses=event.get('address_candidates') or event.get('addressCandidates') or []
    exact_address=any(
        isinstance(a,str) and len(a)>3 and a.casefold() in text.casefold()
        and re.sub(r'^(?:в|на|под|из)\s+','',a.casefold()).strip() not in REGION_NAMES
        for a in addresses
    )
    locations=[m.group(0) for m in LOCAL_NAME.finditer(text)]
    local=any(re.sub(r'^(?:в|на|под|из)\s+','',v.casefold()) not in REGION_NAMES for v in locations)
    specificity=3 if exact_address else 2 if local or FACILITY.search(text) else 0
    actionability=3 if changes else 2 if planned else 0
    significance=3 if re.search(r'штормов.{0,20}предупрежден|режим.{0,15}чрезвычайн|массов.{0,15}отключен',text,re.I) else 2 if AMOUNT.search(text) or IMPACT.search(text) else 1 if actionability else 0
    adapter=source['adapter'] if source is not None else ''
    if adapter=='vodokanal-incidents' and re.search(r'отключ|работ|водоснабж',text,re.I):
        actionability=max(actionability,3)
        specificity=max(specificity,2)
    # Score does not include source_kind, model confidence, checkedAt or recency.
    score=min(100,actionability*17+specificity*10+significance*8)
    facts=list(dict.fromkeys(changes+planned))[:3]
    if reasons:
        score=min(score,24 if any(r not in {'routine_statistics_or_roundup','routine_weather'} for r in reasons) else 44)
        level='noise' if score<=24 else 'context'
    elif actionability>=2 and specificity>=1 and score>=60:
        level='useful';reasons=['documented_local_change']
    else:
        level='context'
        if not actionability:reasons.append('no_actionable_change')
        if not specificity:reasons.append('no_specific_local_object')
        if score<60:reasons.append('insufficient_operational_detail')
    return {'version':VERSION,'score':score,'level':level,'showOnMap':level=='useful','reasons':reasons,
            'dimensions':{'specificity':specificity,'actionability':actionability,'significance':significance},
            'supportedFacts':[s[:600] for s in facts]}
