#!/usr/bin/env python3
"""Build the tracked candidate-source registry and deterministic coverage exports.

The script uses only the checked-in official territory catalogue plus reviewed
directory mappings below. A generated row is a discovery lead until a connector,
rights and content have all been qualified independently.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
from runtime_paths import DATA_ROOT, public_path
OUT = DATA_ROOT / "data/live"
TERRITORIES = public_path("territories.json")
TATMEDIA_DIRECTORY = "https://tatmedia.ru/smitatmedia/"
MUNICIPAL_DIRECTORY = "https://gosalcogol.tatarstan.ru/sayti-munitsipalnih-rayonov-i-gorodskih-okrugov.htm"


# Values were reviewed against the publisher's territorial directory. Some
# districts have several language or TV/newspaper sites, so domains are sources,
# not administrative identifiers.
TATMEDIA = {
    "Агрызский":"agryz-rt.ru","Азнакаевский":"aznakaevo-rt.ru","Аксубаевский":"aksubayevo.ru",
    "Актанышский":"aktanysh-rt.ru","Алексеевский":"alekseyevsk.ru","Алькеевский":"alki-rt.ru",
    "Альметьевский":"almetievsk-ru.ru almet-rt.ru","Апастовский":"apastovo.ru","Арский":"arskmedia.ru",
    "Атнинский":"atnya-rt.ru","Бавлинский":"bavly-tat.ru","Балтасинский":"baltaci.ru",
    "Бугульминский":"bugulma-tat.ru bugulma-tatarstan.ru","Буинский":"buinsk-tat.ru","Верхнеуслонский":"vuslon.ru",
    "Высокогорский":"biektaw.ru","Дрожжановский":"chuprale-online.ru","Елабужский":"elabuga-rt.ru alabuganury.ru",
    "Заинский":"zainsk-rt.ru novyi-zai.ru zainsk-inform.ru","Зеленодольский":"zpravda.ru yashel-uzan.ru",
    "Кайбицкий":"kaibicy.ru","Камско-Устьинский":"kamskoe-ustie.ru","Кукморский":"kukmor-rt.ru",
    "Лаишевский":"laishevskyi.ru","Лениногорский":"zamansulyshy.ru leninogorsk-rt.ru","Мамадышский":"mamadysh-rt.ru",
    "Менделеевский":"mendeleevskyi.ru","Мензелинский":"menzela.ru","Муслюмовский":"muslumirc.ru",
    "Нижнекамский":"ntr-24.ru nkpravda.ru nkamsk-rt.ru nizhnekamsk-rt.ru","Новошешминский":"novoshishminsk.ru",
    "Нурлатский":"nurlat-tat.ru","Пестречинский":"pestrecy-rt.ru","Рыбно-Слободский":"rsloboda-rt.ru",
    "Сабинский":"saby-rt.ru saba-rt.ru","Сармановский":"sarman-rt.ru","Спасский":"spas-rt.ru",
    "Тетюшский":"tetyushy.ru","Тукаевский":"tukai-rt.ru","Тюлячинский":"tulachi.ru",
    "Черемшанский":"nashcheremshan.ru","Чистопольский":"chistopol-rt.ru","Ютазинский":"yutazy.ru",
    "город Набережные Челны":"chelny-izvest.ru shahrichalli.ru tvchelny.ru chelny-rt.ru maydan.tatar kunelradio.ru",
}


# The URLs originate in the official municipal-sites directory. They remain
# disabled candidates until a bounded check confirms the current endpoint and
# an adapter/rights review. HTTP is retained where the directory publishes it;
# qualification may later record an HTTPS redirect without silently rewriting provenance.
MUNICIPAL = {
    "Агрызский":"http://agryz.tatarstan.ru","Азнакаевский":"http://aznakayevo.tatarstan.ru",
    "Аксубаевский":"http://aksubayevo.tatarstan.ru","Актанышский":"http://aktanysh.tatarstan.ru",
    "Алексеевский":"http://alekseevskiy.tatarstan.ru","Алькеевский":"http://alkeevskiy.tatarstan.ru",
    "Альметьевский":"http://almetyevsk.tatar.ru","Апастовский":"http://apastovo.tatarstan.ru",
    "Арский":"http://arsk.tatarstan.ru","Атнинский":"http://atnya.tatarstan.ru","Бавлинский":"http://bavly.tatarstan.ru",
    "Балтасинский":"http://baltasi.tatarstan.ru","Бугульминский":"http://bugulma.tatarstan.ru",
    "Буинский":"http://buinsk.tatarstan.ru","Верхнеуслонский":"http://verhniy-uslon.tatarstan.ru",
    "Высокогорский":"http://vysokaya-gora.tatarstan.ru","Дрожжановский":"http://drogganoye.tatarstan.ru",
    "Елабужский":"http://elabuga.tatarstan.ru","Заинский":"http://zainsk.tatarstan.ru",
    "Зеленодольский":"http://zelenodolsk.tatarstan.ru","Кайбицкий":"http://kaybici.tatarstan.ru",
    "Камско-Устьинский":"http://kamskoye-ustye.tatarstan.ru","Кукморский":"http://kukmor.tatarstan.ru",
    "Лаишевский":"http://laishevo.tatarstan.ru","Лениногорский":"http://leninogorsk.tatarstan.ru",
    "Мамадышский":"http://mamadysh.tatarstan.ru","Менделеевский":"http://mendeleevsk.tatarstan.ru",
    "Мензелинский":"http://menzelinsk.tatarstan.ru","Муслюмовский":"http://muslumovo.tatarstan.ru",
    "Нижнекамский":"http://nizhnekamsk.tatarstan.ru","Новошешминский":"http://novosheshminsk.tatarstan.ru",
    "Нурлатский":"http://nurlat.tatarstan.ru","Пестречинский":"http://pestreci.tatarstan.ru",
    "Рыбно-Слободский":"http://ribnaya-sloboda.tatarstan.ru","Сабинский":"http://saby.tatarstan.ru",
    "Сармановский":"http://sarmanovo.tatarstan.ru","Спасский":"http://spasskiy.tatarstan.ru",
    "Тетюшский":"http://tetyushi.tatarstan.ru","Тукаевский":"http://tukay.tatarstan.ru",
    "Тюлячинский":"http://tulachi.tatarstan.ru","Черемшанский":"http://cheremshan.tatarstan.ru",
    "Чистопольский":"http://chistopol.tatarstan.ru","Ютазинский":"http://yutaza.tatarstan.ru",
    "город Казань":"https://kzn.ru","город Набережные Челны":"https://nabchelny.ru",
}


ACTIVE = [
    dict(id="mchs-news",name="ГУ МЧС России по Республике Татарстан",url="https://16.mchs.gov.ru/deyatelnost/press-centr/novosti/rss",adapter="rss",source_kind="official",interval_seconds=300,topics=["emergency","fire","water-safety"],provenance_url="https://16.mchs.gov.ru/deyatelnost/press-centr/novosti",territory_id="RU-TA"),
    dict(id="mchs-weather",name="МЧС Татарстана — штормовые предупреждения",url="https://16.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/shtormovye-i-ekstrennye-preduprezhdeniya/rss",adapter="rss",source_kind="official",interval_seconds=300,topics=["weather","emergency"],provenance_url="https://16.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/shtormovye-i-ekstrennye-preduprezhdeniya",territory_id="RU-TA"),
    dict(id="rosstat-news",name="Татарстанстат",url="https://16.rosstat.gov.ru/news/rss",adapter="rss",source_kind="official",interval_seconds=3600,topics=["economy","statistics"],provenance_url="https://16.rosstat.gov.ru/news",territory_id="RU-TA"),
    dict(id="chelny-official-news",name="Набережные Челны — официальные новости",url="https://nabchelny.ru/welcome/feed/",adapter="rss",source_kind="official",interval_seconds=900,topics=["municipality"],provenance_url="https://nabchelny.ru",territory_key="город Набережные Челны"),
    dict(id="kazan-vodokanal-accidents",name="Казанский Водоканал — аварийные отключения",url="https://www.kznvodokanal.ru/accident",adapter="vodokanal-incidents",source_kind="utility",interval_seconds=300,topics=["utilities","water"],provenance_url="https://www.kznvodokanal.ru/accident",territory_key="город Казань"),
    dict(id="kfu-news",name="Казанский федеральный университет",url="https://media.kpfu.ru/news-rss",adapter="rss",source_kind="media",interval_seconds=3600,topics=["education","science"],provenance_url="https://media.kpfu.ru",territory_key="город Казань"),
    dict(id="innopolis-university-news",name="Университет Иннополис",url="https://innopolis.university/news/",adapter="html",source_kind="media",interval_seconds=3600,topics=["education","technology"],provenance_url="https://innopolis.university/news/",territory_id="RU-TA",fetch_allowed=False,ai_allowed=False,display_allowed=False,status="needs-adapter",rights_note="HTML was previously readable; a stable dated-card adapter and allowed-use review are still required."),
]


def slug(value: str) -> str:
    normalized=unicodedata.normalize("NFKD",value).encode("ascii","ignore").decode().lower()
    normalized=re.sub(r"[^a-z0-9]+","-",normalized).strip("-")
    return normalized or hashlib.sha256(value.encode()).hexdigest()[:12]


def territory_lookup(territories):
    return {item["name"]:item for item in territories}


def find_territory(territories, key):
    exact=next((item for item in territories if item["name"]==key),None)
    if exact:return exact
    return next((item for item in territories if item["name"].startswith(key+" ")),None)


def build_sources(territories):
    sources=[]
    for template in ACTIVE:
        source=dict(template)
        key=source.pop("territory_key",None)
        if key: source["territory_id"]=find_territory(territories,key)["id"]
        source.setdefault("status","active");source.setdefault("fetch_allowed",source["adapter"] in {"rss","vodokanal-incidents"})
        source.setdefault("ai_allowed",source["fetch_allowed"]);source.setdefault("display_allowed",source["fetch_allowed"])
        source.setdefault("rights_note","Public operational or official publication; show an attributed factual summary and source link, not copied media assets.")
        source["region_id"]="RU-TA";source["languages"]=["ru"]
        source["coverage"]=[{"territory_id":source["territory_id"],"coverage_level":"direct"}]
        sources.append(source)
    for key,domains in TATMEDIA.items():
        territory=find_territory(territories,key)
        if not territory: raise ValueError(f"Tatmedia territory is unknown: {key}")
        for domain in domains.split():
            sources.append({"id":"tatmedia-"+slug(domain),"name":f"Татмедиа: {domain}","region_id":"RU-TA","territory_id":territory["id"],
                "url":"https://"+domain+"/","adapter":"rss-discovery","source_kind":"media","status":"rights-review","interval_seconds":900,
                "languages":["ru","tt"],"topics":["municipality"],"coverage":[{"territory_id":territory["id"],"coverage_level":"direct"}],
                "fetch_allowed":False,"ai_allowed":False,"display_allowed":False,
                "rights_note":"Publisher footer states that reproduction and distribution require written editorial consent; endpoint discovery does not grant AI or display permission.",
                "provenance_url":TATMEDIA_DIRECTORY})
    for key,url in MUNICIPAL.items():
        territory=find_territory(territories,key)
        if not territory: raise ValueError(f"municipal territory is unknown: {key}")
        sources.append({"id":"municipal-"+territory["id"],"name":territory["name"]+" — официальный сайт","region_id":"RU-TA","territory_id":territory["id"],
            "url":url+"/index.htm/news/","adapter":"tatarstan-html","source_kind":"official","status":"unavailable","interval_seconds":3600,
            "languages":["ru","tt"],"topics":["municipality"],"coverage":[{"territory_id":territory["id"],"coverage_level":"direct"}],
            "fetch_allowed":False,"ai_allowed":False,"display_allowed":False,
            "rights_note":"Official directory candidate. Activate only after the endpoint, dated article extraction and all allowed-use fields are verified.",
            "provenance_url":MUNICIPAL_DIRECTORY})
    if not 110 <= len(sources) <= 130: raise ValueError(f"registry outside target range: {len(sources)}")
    urls=[source["url"] for source in sources]
    if len(urls)!=len(set(urls)): raise ValueError("source URLs must be unique")
    return sources


def write_outputs():
    OUT.mkdir(parents=True,exist_ok=True)
    territories=json.loads(TERRITORIES.read_text())
    sources=build_sources(territories)
    payload={"schemaVersion":1,"regionId":"RU-TA","generatedFrom":{"territories":"public/data/territories.json",
        "tatmediaDirectory":TATMEDIA_DIRECTORY,"municipalDirectory":MUNICIPAL_DIRECTORY},"sources":sources}
    (OUT/"sources.json").write_text(json.dumps(payload,ensure_ascii=False,indent=2)+"\n")
    direct_by_territory={source["territory_id"]:source["id"] for source in sources if source["id"].startswith("municipal-")}
    rows=[]
    for territory in territories:
        if territory["kind"] not in {"district","urban_district","settlement"}: continue
        if territory["id"] in direct_by_territory:
            level="direct";source_id=direct_by_territory[territory["id"]]
        elif territory["kind"]=="settlement" and territory.get("parentId") in direct_by_territory:
            level="inherited-district";source_id=direct_by_territory[territory["parentId"]]
        else: level="missing";source_id=""
        rows.append({"territory_id":territory["id"],"territory_name":territory["name"],"kind":territory["kind"],
            "parent_id":territory.get("parentId") or "","coverage_level":level,"source_id":source_id,
            "last_success_at":"","latest_publication_at":""})
    with (OUT/"source-coverage.csv").open("w",newline="",encoding="utf-8-sig") as handle:
        writer=csv.DictWriter(handle,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    sources_by_territory={}
    for source in sources:
        sources_by_territory.setdefault(source["territory_id"],[]).append(source["id"])
    coverage_json=[]
    for row in rows:
        lookup=row["territory_id"] if row["coverage_level"]=="direct" else row["parent_id"] if row["coverage_level"]=="inherited-district" else None
        coverage_json.append({"territoryId":row["territory_id"],"territoryName":row["territory_name"],"parentId":row["parent_id"] or None,
            "level":row["coverage_level"].replace("-","_"),"sourceIds":sorted(sources_by_territory.get(lookup,[])) if lookup else [],
            "lastSuccessAt":None,"latestPublicationAt":None})
    (OUT/"coverage.json").write_text(json.dumps(coverage_json,ensure_ascii=False,indent=2)+"\n")
    locality_rows=[]
    for territory in territories:
        if territory["kind"] != "settlement": continue
        center=territory.get("center") or [None,None]
        locality_rows.append({"territory_id":territory["id"],"municipality_name":territory["name"],
            "administrative_center_name":territory.get("administrativeCenterName") or "","parent_id":territory.get("parentId") or "",
            "longitude":center[0],"latitude":center[1],"source_url":territory.get("sourceUrl") or "","as_of":territory.get("asOf") or "",
            "precision":"municipal-label-point"})
    with (OUT/"localities.csv").open("w",newline="",encoding="utf-8-sig") as handle:
        writer=csv.DictWriter(handle,fieldnames=list(locality_rows[0]));writer.writeheader();writer.writerows(locality_rows)
    return {"sources":len(sources),"coverage":len(rows),"localities":len(locality_rows),
        "active":sum(source["status"]=="active" for source in sources)}


if __name__=="__main__":
    print(json.dumps(write_outputs(),ensure_ascii=False))
