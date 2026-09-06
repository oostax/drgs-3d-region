#!/usr/bin/env python3
"""Reproducible public-only atlas data pipeline. Never reads private workbooks.

Setup: uv venv data/public/.venv
       uv pip install --python data/public/.venv/bin/python beautifulsoup4 shapely overturemaps
Run:   data/public/.venv/bin/python scripts/fetch_public_data.py --all
The curated news seed is kept in data/public/news-seeds.json for editorial review.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote, urlencode, urljoin, urlsplit, urlunsplit
from xml.etree import ElementTree

from bs4 import BeautifulSoup
from shapely import from_wkb, make_valid, to_geojson
from shapely.geometry import LineString, Point, mapping, shape
from shapely.ops import polygonize, unary_union

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "data/public"
CACHE = WORK / "cache"
OUT = ROOT / "public/data"
REGISTRY_INDEX = "https://rosstat.gov.ru/opendata/7708234640-oktmo"
REGISTRY_URL = REGISTRY_INDEX + "/data-20260901T1609-structure-20260210T1102.csv"
OVERPASS = "https://overpass-api.de/api/interpreter"
BOUNDARY_QUERY = '[out:json][timeout:180];area(3600079374)->.a;relation(area.a)["boundary"="administrative"]["admin_level"~"^(4|6|8)$"];out geom;'
BANK_QUERY = '[out:json][timeout:120];area(3600079374)->.a;nwr(area.a)["amenity"="bank"];out center tags;'
RUSSIA_URL = "https://raw.githubusercontent.com/timurkanaz/Russia_geojson_OSM/master/" + quote("GeoJson's/Countries/Russia_regions.geojson")
BANKS = {
    "sber": ("Сбер", "1027700132195", "1315037838265"),
    "vtb": ("ВТБ", "1027739609391", "1315037838269"),
    "akbars": ("Ак Барс Банк", "1021600000124", "1315037840620"),
    "psb": ("ПСБ", "1027739019142", "1315037839212"),
    "gazprombank": ("Газпромбанк", "1027700167110", "1315037839064"),
}
STATES: dict[str, dict] = {}
NEWS_FEEDS = [
    {"id": "news-feed-rosstat", "name": "Татарстанстат", "url": "https://16.rosstat.gov.ru/news/rss", "format": "rss"},
    {"id": "news-feed-tatarstan", "name": "Официальный Татарстан", "url": "https://tatarstan.ru/index.htm/news/tape/", "format": "html"},
    {"id": "news-feed-minstroy", "name": "Минстрой Татарстана", "url": "https://minstroy.tatarstan.ru/index.htm/news/", "format": "html"},
    {"id": "news-feed-kazan", "name": "Официальный портал Казани", "url": "https://kzn.ru/meriya/press-tsentr/novosti/", "format": "html"},
    {"id": "news-feed-innopolis", "name": "Университет Иннополис", "url": "https://innopolis.university/news/", "format": "html",
     "itemSelector": "a.news-page__all-news__news-bottom", "titleSelector": "h3", "dateSelector": ".news-page__all-news__news-bottom-date",
     "descriptionSelector": ".news-page__all-news__news-bottom-text", "publisherTerritoryId": "mo-92620109"},
    {"id": "news-feed-kfu", "name": "Казанский федеральный университет", "url": "https://media.kpfu.ru/news-rss", "format": "rss"},
    {"id": "news-feed-mchs", "name": "ГУ МЧС России по Татарстану", "url": "https://16.mchs.gov.ru/deyatelnost/press-centr/novosti/rss", "format": "rss"},
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    temp.replace(path)


def load_json(path: Path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def fetch(source_id: str, url: str, filename: str, refresh=False, timeout=60, max_bytes=160_000_000, validator=None) -> Path | None:
    """Curl uses the host trust store; never disables certificate verification.

    Files are published atomically. Errors preserve previous successful snapshots.
    No credentials, proxy bypass, browser challenges or private inputs are used.
    """
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / filename
    previous = STATES.get(source_id, {})
    valid_cache = path.exists() and (validator is None or validator(path))
    if valid_cache and not refresh:
        STATES[source_id] = {**previous, "id": source_id, "url": url, "status": "cached",
            "lastSuccessAt": previous.get("lastSuccessAt") or datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
            "bytes": path.stat().st_size, "error": None}
        return path
    attempt = now()
    temp = path.with_name(path.name + ".download")
    result = subprocess.run(["curl", "-L", "--fail", "--connect-timeout", "12", "--max-time", str(timeout),
        "--max-filesize", str(max_bytes), "-sS", "-o", str(temp), "-w", "%{http_code}", "--", url],
        text=True, capture_output=True)
    downloaded = result.returncode == 0 and temp.exists() and temp.stat().st_size
    valid_download = downloaded and (validator is None or validator(temp))
    if valid_download:
        temp.replace(path)
        STATES[source_id] = {"id": source_id, "url": url, "status": "ok", "lastAttemptAt": attempt,
            "lastSuccessAt": now(), "httpStatus": result.stdout, "bytes": path.stat().st_size, "error": None}
        return path
    temp.unlink(missing_ok=True)
    STATES[source_id] = {**previous, "id": source_id, "url": url, "status": "stale" if valid_cache else "unavailable",
        "lastAttemptAt": attempt, "httpStatus": result.stdout,
        "error": "Public data format could not be verified" if downloaded else result.stderr.strip()[:400] or "Empty response"}
    if not valid_cache:
        STATES[source_id].pop("lastSuccessAt", None)
    return path if valid_cache else None


def normalize_name(name: str) -> str:
    s = name.lower().replace("ё", "е")
    s = re.sub(r"\bим\.?\s", "имени ", s)
    for text in ("муниципальный район", "городской округ", "городское поселение", "сельское поселение",
                 "поселок городского типа", "посёлок городского типа", "муниципальное образование", "район", "город", "поселок"):
        s = s.replace(text, " ")
    return re.sub(r"[^а-яa-z0-9]", "", s)


def relation_geometry(element):
    groups = {"outer": [], "inner": []}
    for member in element.get("members", []):
        if member.get("type") != "way" or member.get("role", "outer") not in ("", "outer", "inner"):
            continue
        coordinates = [(p["lon"], p["lat"]) for p in member.get("geometry", []) if p is not None]
        if len(coordinates) > 1:
            groups[member.get("role") or "outer"].append(LineString(coordinates))
    shells = list(polygonize(unary_union(groups["outer"]))) if groups["outer"] else []
    if not shells:
        return None
    result = unary_union(shells)
    if groups["inner"]:
        result = result.difference(unary_union(list(polygonize(unary_union(groups["inner"])))))
    result = make_valid(result)
    if result.geom_type == "GeometryCollection":
        result = unary_union([x for x in result.geoms if x.geom_type in ("Polygon", "MultiPolygon")])
    return result if result.geom_type in ("Polygon", "MultiPolygon") and not result.is_empty else None


def registry(refresh=False):
    index = fetch("rosstat-oktmo-index", REGISTRY_INDEX, "rosstat-oktmo.html", refresh)
    source = REGISTRY_URL
    if index:
        links = [urljoin(REGISTRY_INDEX, a["href"]) for a in BeautifulSoup(index.read_text(), "html.parser").select("a[href]")
                 if re.search(r"/data-\d+T\d+-structure-.*\.csv$", a["href"])]
        if links:
            source = max(set(links))
    as_of_match = re.search(r"data-(\d{4})(\d{2})(\d{2})T", source)
    as_of = "-".join(as_of_match.groups()) if as_of_match else None
    filename = "oktmo-" + (as_of or "latest").replace("-", "") + ".csv"
    path = fetch("rosstat-oktmo", source, filename, refresh, timeout=120)
    if path is None:
        raise RuntimeError("The official OKTMO registry is unavailable; no invented replacement is generated.")
    records = []
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f, delimiter=";"):
            if len(row) < 13 or row[0] != "92" or row[5] != "1" or row[3] != "000":
                continue
            code = "".join(row[:3])
            kind = None
            parent = "RU-TA"
            name = row[6].strip()
            if code == "92000000":
                kind, parent, name = "region", None, "Республика Татарстан"
            elif row[1].startswith("6") and row[1] != "600" and row[2] == "000":
                kind = "district"
            elif row[1].startswith("7") and row[1] != "700" and row[2] == "000":
                kind = "urban_district"
            elif row[1].startswith("6") and row[2][0] in "14" and row[2][-2:] != "00":
                kind, parent = "settlement", "mo-" + code[:5] + "000"
                name = ("Городское поселение " + name) if row[2][0] == "1" else (name + " сельское поселение")
            if not kind:
                continue
            records.append({"id": "RU-TA" if kind == "region" else "mo-" + code, "oktmo": code,
                "name": name, "kind": kind, "parentId": parent, "center": None, "bbox": None,
                "geometry": None, "geometryStatus": "missing", "sourceUrl": source, "asOf": as_of,
                "administrativeCenterName": row[7] or None, "geometrySourceUrl": None})
    by_id = {r["id"]: r for r in records}
    assert len(by_id) == len(records), "Duplicate official municipality identifier"
    assert all(r["parentId"] is None or r["parentId"] in by_id for r in records), "Unresolved official parent"
    return records


def attach_geometries(records, refresh=False):
    url = OVERPASS + "?data=" + quote(BOUNDARY_QUERY)
    path = fetch("osm-tatarstan-boundaries", url, "tatarstan-overpass.json", refresh, timeout=230)
    if not path:
        return
    data = load_json(path)
    if data.get("remark"):
        raise RuntimeError("Incomplete Overpass result: " + data["remark"])
    timestamp = data.get("osm3s", {}).get("timestamp_osm_base")
    shapes = []
    for element in data["elements"]:
        geom = relation_geometry(element)
        if geom is not None:
            shapes.append((element, geom))
    by_id = {r["id"]: r for r in records}
    level6 = {}
    unmatched = []

    def attach(record, element, geom, method):
        simplified = geom.simplify(0.000035 if record["kind"] == "settlement" else 0.00009, preserve_topology=True)
        # This is a reproducible interior label point, never an address/incident pin.
        center = geom.representative_point()
        record.update({"geometry": mapping(simplified), "bbox": list(geom.bounds),
            "center": [round(center.x, 7), round(center.y, 7)], "centerMethod": "interior-label-point",
            "geometryStatus": "verified", "geometrySourceUrl": f"https://www.openstreetmap.org/relation/{element['id']}",
            "geometryAsOf": timestamp, "osmRelationId": element["id"], "geometryMatchMethod": method})
        if record["kind"] in ("district", "urban_district"):
            level6[record["id"]] = geom
        if record["kind"] == "region":
            write_json(WORK / "tatarstan-boundary-full.geojson", {"type": "Feature", "properties": {}, "geometry": mapping(geom)})

    for element, geom in shapes:
        tags = element.get("tags", {})
        level = tags.get("admin_level")
        if level == "4" and element["id"] == 79374:
            attach(by_id["RU-TA"], element, geom, "OSM relation + ISO3166-2 RU-TA")
        if level != "6":
            continue
        names = {normalize_name(tags[k]) for k in ("name", "name:ru", "official_name") if k in tags}
        matches = [r for r in records if r["kind"] in ("district", "urban_district") and normalize_name(r["name"]) in names]
        if len(matches) == 1:
            attach(matches[0], element, geom, "exact normalized name + region")
        else:
            unmatched.append({"osmId": element["id"], "name": tags.get("name"), "reason": "district-name"})
    for element, geom in shapes:
        tags = element.get("tags", {})
        if tags.get("admin_level") != "8":
            continue
        center = geom.representative_point()
        parents = [rid for rid, district in level6.items() if district.covers(center)]
        names = {normalize_name(tags[k]) for k in ("name", "name:ru", "official_name") if k in tags}
        matches = [r for r in records if r["kind"] == "settlement" and r["parentId"] in parents and normalize_name(r["name"]) in names]
        if len(matches) == 1:
            attach(matches[0], element, geom, "exact normalized name + spatially verified parent")
        else:
            unmatched.append({"osmId": element["id"], "name": tags.get("name"), "parentIds": parents, "reason": "settlement-name-or-parent"})
    write_json(WORK / "geometry-unmatched.json", unmatched)
    write_json(OUT / "tatarstan-boundaries.geojson", {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": r["id"], "properties": {"territoryId": r["id"], "name": r["name"], "kind": r["kind"],
            "parentId": r["parentId"], "oktmo": r["oktmo"], "sourceUrl": r["geometrySourceUrl"]}, "geometry": r["geometry"]}
        for r in records if r["geometry"] is not None]})


def territories(refresh=False):
    records = registry(refresh)
    attach_geometries(records, refresh)
    write_json(OUT / "territories.json", records)
    print(json.dumps({"territories": len(records), "kinds": dict(Counter(r["kind"] for r in records)),
        "withGeometry": sum(r["geometry"] is not None for r in records)}, ensure_ascii=False), flush=True)
    return records


def national_regions(refresh=False):
    path = fetch("osm-russia-regions-snapshot", RUSSIA_URL, "russia-regions.raw.geojson", refresh, timeout=120)
    if not path:
        return
    data = load_json(path)
    tags_query = '[out:json][timeout:60];relation["ISO3166-2"~"^RU-"]["admin_level"="4"];out tags center;'
    tags_path = fetch("osm-russia-region-identifiers", OVERPASS + "?data=" + quote(tags_query), "russia-regions-tags.json", refresh, timeout=90)
    identifiers = load_json(tags_path, {}).get("elements", []) if tags_path else []
    def region_key(name):
        name = re.sub(r"\([^)]*\)", "", name.lower().replace("ё", "е"))
        name = re.split(r"\s[-–—]\s", name)[0]
        name = name.replace("город федерального значения", "").replace("г. ", "")
        name = name.replace("обл.", "область").replace(" ао", " автономный округ")
        name = name.replace("республика", "").replace("автономная область", "автономный округ")
        return re.sub(r"[^а-яa-z0-9]", "", name)
    iso_by_name = {}
    for element in identifiers:
        tags = element.get("tags", {})
        for field in ("name", "name:ru", "official_name", "alt_name"):
            for value in tags.get(field, "").split(";"):
                if value:
                    iso_by_name[region_key(value)] = tags["ISO3166-2"]
    pilot = next((r for r in load_json(OUT / "territories.json", []) if r["id"] == "RU-TA"), None)
    features = []
    for feature in data.get("features", []):
        if not feature.get("geometry"):
            continue
        geom = make_valid(shape(feature["geometry"]))
        props = feature.get("properties", {})
        name = props.get("name:ru") or props.get("name") or props.get("region")
        if not name:
            raise RuntimeError("Unnamed national overview feature; refusing to publish anonymous polygons")
        iso = props.get("ISO3166-2") or props.get("iso3166-2") or props.get("ref") or iso_by_name.get(region_key(name))
        if "татарстан" in name.lower() and pilot:
            iso, geom = "RU-TA", shape(pilot["geometry"])
        center = geom.representative_point()
        feature_id = iso or "overview-" + region_key(name)
        features.append({"type": "Feature", "id": feature_id, "properties": {
            "id": feature_id, "name": name,
            "iso": iso, "center": [center.x, center.y], "sourceUrl": RUSSIA_URL,
            "dataStatus": "current-osm-pilot" if iso == "RU-TA" else "historical-osm-derived-overview",
            "asOf": pilot.get("geometryAsOf") if iso == "RU-TA" and pilot else None},
            "geometry": mapping(geom.simplify(0.012, preserve_topology=True))})
    write_json(OUT / "russia-regions.geojson", {"type": "FeatureCollection", "features": features})
    print(json.dumps({"nationalOverviewRegions": len(features)}), flush=True)


def news_date(value):
    """Never infer a publication year from the current clock or article topic."""
    value = str(value or "").strip()
    for parser in (lambda text: datetime.fromisoformat(text.replace("Z", "+00:00")), parsedate_to_datetime):
        try:
            result = parser(value)
            if result:
                return result.date().isoformat()
        except (ValueError, TypeError, OverflowError):
            pass
    match = re.search(r"\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b", value)
    if match:
        try:
            return datetime(int(match[3]), int(match[2]), int(match[1])).date().isoformat()
        except ValueError:
            return None
    months = "января февраля марта апреля мая июня июля августа сентября октября ноября декабря".split()
    match = re.search(r"\b(\d{1,2})\s+(" + "|".join(months) + r")\s+(20\d{2})\b", value.lower())
    if match:
        try:
            return datetime(int(match[3]), months.index(match[2]) + 1, int(match[1])).date().isoformat()
        except ValueError:
            pass
    return None


def clean_excerpt(value, limit=420):
    soup = BeautifulSoup(str(value or ""), "html.parser")
    for element in soup(["script", "style", "iframe", "form"]):
        element.decompose()
    text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True)).strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def official_article_url(value, source):
    value = urljoin(source["url"], str(value or "").strip())
    parts = urlsplit(value)
    if parts.scheme not in ("https", "http") or parts.hostname != urlsplit(source["url"]).hostname or parts.username or parts.password:
        return None
    if not re.search(r"/news/|/novosti/", parts.path) or parts.path.rstrip("/") == urlsplit(source["url"]).path.rstrip("/"):
        return None
    return urlunsplit(("https", parts.netloc, parts.path, parts.query, ""))


def parse_news_feed(path, source):
    """Extract only explicit headline/date/URL/excerpt; no remote article execution."""
    result = []
    try:
        raw = path.read_text(errors="replace")
        if source["format"] == "rss":
            # ElementTree does not fetch external entities. Reject DTDs outright.
            if "<!DOCTYPE" in raw.upper() or "<!ENTITY" in raw.upper():
                return []
            root = ElementTree.fromstring(raw)
            items = root.findall(".//item") or root.findall("{http://www.w3.org/2005/Atom}entry")
            for item in items[:60]:
                values = {child.tag.rsplit("}", 1)[-1]: child.text or child.attrib.get("href", "") for child in item}
                title = clean_excerpt(values.get("title"), 300)
                url = official_article_url(values.get("link"), source)
                # Atom updated is not a publication date: never rejuvenate old news.
                date = news_date(values.get("pubDate") or values.get("published") or values.get("date"))
                if title and url and date:
                    result.append({"title": title, "sourceUrl": url, "publishedAt": date,
                        "excerpt": clean_excerpt(values.get("description") or values.get("summary"))})
        else:
            soup = BeautifulSoup(raw, "html.parser")
            seen = set()
            if source.get("itemSelector"):
                for card in soup.select(source["itemSelector"])[:60]:
                    link = card if card.name == "a" else card.select_one("a[href]")
                    title_node = card.select_one(source.get("titleSelector", "h2,h3"))
                    date_node = card.select_one(source.get("dateSelector", "time"))
                    desc = card.select_one(source.get("descriptionSelector", ".description"))
                    url = official_article_url(link.get("href"), source) if link else None
                    title = clean_excerpt(title_node.get_text(" ", strip=True), 300) if title_node else ""
                    date = news_date(date_node.get("datetime") or date_node.get_text(" ", strip=True)) if date_node else None
                    if title and url and date and url not in seen:
                        seen.add(url)
                        result.append({"title": title, "sourceUrl": url, "publishedAt": date,
                            "excerpt": clean_excerpt(desc.get_text(" ", strip=True)) if desc else ""})
                return result
            for link in soup.find_all("a", href=True):
                url = official_article_url(link["href"], source)
                title = clean_excerpt(link.get_text(" ", strip=True), 300)
                if not url or url in seen or len(title) < 20:
                    continue
                # A card must contain one unique article, not the whole news page.
                node = link
                date, excerpt = None, ""
                for _ in range(5):
                    if not node.parent:
                        break
                    node = node.parent
                    text = node.get_text(" ", strip=True)
                    if len(text) > 2400:
                        break
                    article_links = {official_article_url(a.get("href"), source) for a in node.find_all("a", href=True)} - {None}
                    if len(article_links) > 1:
                        break
                    dates = node.select("time, [itemprop=datePublished], .news-date, .news_date, .date, .news-card__data")
                    explicit = [d.get("datetime") or d.get("content") or d.get_text(" ", strip=True) for d in dates]
                    if not explicit:
                        # Date may be a plain node, but strip the title so dates
                        # in a headline are not mistaken for publication dates.
                        explicit = [text.replace(title, "")]
                    date = next((news_date(value) for value in explicit if news_date(value)), None)
                    if date:
                        desc = node.select_one(".news-card__desc, .news-preview, .news_preview, .preview, .description, p")
                        excerpt = clean_excerpt(desc.get_text(" ", strip=True)) if desc else ""
                        break
                if date:
                    seen.add(url)
                    result.append({"title": title, "sourceUrl": url, "publishedAt": date, "excerpt": excerpt})
    except (OSError, ValueError, ElementTree.ParseError):
        return []
    return result


def discovered_news_signal(item, source, checked_at, records):
    text = (item["title"] + " " + item["excerpt"]).lower().replace("ё", "е")
    aliases = {
        "mo-92701000": r"\bказан(?:ь|и|ью)\b", "mo-92730000": r"\bнабережн(?:ые|ых) челн(?:ы|ах|ов)\b",
        "mo-92620109": r"\bиннополис(?:е|а|ом)?\b", "mo-92632101": r"\bболгар(?:е|а|ом)?\b",
        "mo-92608101": r"\bальметьевск(?:е|а|ом)?\b", "mo-92644101": r"\bнижнекамск(?:е|а|ом)?\b",
    }
    known_ids = {r["id"] for r in records}
    matched = [tid for tid, pattern in aliases.items() if tid in known_ids and re.search(pattern, text)]
    for record in records:
        if record["kind"] != "district":
            continue
        adjective = record["name"].split()[0].lower().replace("ё", "е")
        stem = re.escape(adjective[:-2]) if adjective.endswith("ий") else re.escape(adjective)
        if re.search(r"\b" + stem + r"(?:ий|ого|ом|ому|им)\s+(?:муниципальн\w+\s+)?район", text):
            matched.append(record["id"])
    # A publisher's office is not evidence of the place described by an article.
    territory_id = matched[0] if len(set(matched)) == 1 else "RU-TA"
    rules = [
        ("construction", r"строительств|капремонт|капитальн\w+ ремонт|реконструкц", "Уточнить у заказчика стадию проекта и порядок закупок; затем проверить применимость расчётных сервисов и сопровождения подрядчиков."),
        ("infrastructure", r"водоснабж|канализац|теплоснабж|дорог|коммунальн", "Уточнить у профильного ведомства статус работ, оператора и подтверждённые потребности в расчётах или финансировании."),
        ("investment", r"инвестиц|инвестор|промышленн\w+ парк|государственно-частн", "Уточнить у инициатора проекта стадию реализации и участников; при подтверждённой потребности обсудить финансовое сопровождение."),
        ("tourism", r"туризм|турист|музе|культурн", "Уточнить у муниципалитета или оператора объекта сезонные задачи, поток посетителей и потребности в приёме платежей."),
        ("technology", r"робот|цифров|искусственн\w+ интеллект|автоматизац|технолог", "Уточнить владельца инициативы и стадию внедрения; обсудить подтверждённые потребности в цифровых сервисах, расчётах и сопровождении проекта."),
        ("education", r"университет|образова|студент|школ", "Уточнить у учреждения планы развития и закупок; подготовить вопросы о расчётах, оплате услуг и цифровой инфраструктуре."),
    ]
    category, step = "economy", "Использовать публикацию как контекст встречи. Уточнить у клиента, влияет ли показатель на его бюджет, платежи и планы закупок."
    for value, pattern, recommendation in rules:
        if re.search(pattern, text):
            category, step = value, recommendation
            break
    excerpt = item["excerpt"]
    facts = ["В официальной ленте «" + source["name"] + "» опубликован материал с указанными заголовком и датой."]
    if excerpt:
        facts.append("Описание в источнике: " + excerpt)
    return {"id": "public-" + hashlib.sha256(item["sourceUrl"].encode()).hexdigest()[:16], "title": item["title"],
        "summary": excerpt or "Материал обнаружен в официальной ленте. Содержание и показатели следует уточнить в первоисточнике.",
        "category": category, "territoryId": territory_id, "coordinates": None, "precision": "territory",
        "sourceUrl": item["sourceUrl"], "publishedAt": item["publishedAt"], "checkedAt": checked_at, "facts": facts,
        "hypothesis": "Гипотеза для подготовки встречи: тема публикации может влиять на задачи организаций территории. Коммерческая потребность не подтверждена.",
        "nextStep": step, "visibility": "public", "verificationMethod": "official-feed-extraction",
        "sourceName": source["name"], "discoverySourceId": source["id"], "extractionLevel": "feed-headline-and-description",
        "geographyMethod": "unambiguous-name-in-publication" if matched and territory_id != "RU-TA" else "regional-source-scope",
        "lifecycle": {"status": "not_applicable", "asOf": item["publishedAt"], "sourceUrl": item["sourceUrl"],
                      "currentStatusVerified": False, "animationEligible": False,
                      "note": "Обнаружена датированная публикация. Её свежесть не подтверждает незавершённое происшествие или текущую стадию работ."}}


def article_body_text(soup):
    """Read the article container only: sidebars and publisher footers are not facts."""
    for selector in ('#block-inno-content article', '.public__text article', '.news-detailed__news-item', 'main article', 'article'):
        nodes = soup.select(selector)
        if len(nodes) == 1:
            return nodes[0].get_text(" ", strip=True)
    return ""


def parse_news_article(path, expected_title):
    """Confirm article identity and explicit publication metadata, not crawl time."""
    try:
        soup = BeautifulSoup(path.read_text(errors="replace"), "html.parser")
        headings = [n.get_text(" ", strip=True) for n in soup.select("h1")]
        headings.extend(n.get("content", "") for n in soup.select('meta[property="og:title"]'))
        title = next((clean_excerpt(value, 300) for value in headings if normalize_name(value) == normalize_name(expected_title)), "")
        if not title:
            return None
        # Article-specific selectors precede generic time nodes. In KFU pages,
        # .newsItem-date belongs to a latest-news sidebar, NOT this article.
        date = None
        for selector in ('meta[property="article:published_time"],meta[itemprop="datePublished"]',
                         '.newsCart-date,.news-date,.news-detail__date,.news-detail-date,.news-page__news-date,.articles-detail__date',
                         'main time[datetime],article time[datetime]'):
            values = {news_date(n.get("content") or n.get("datetime") or n.get_text(" ", strip=True)) for n in soup.select(selector)} - {None}
            if len(values) == 1:
                date = values.pop()
                break
        # Schema.org JSON-LD has an explicit datePublished; dateModified is ignored.
        if not date:
            for node in soup.select('script[type="application/ld+json"]'):
                try:
                    data = json.loads(node.string or node.get_text())
                    candidates = data if isinstance(data, list) else [data]
                    for candidate in candidates:
                        if isinstance(candidate, dict) and isinstance(candidate.get("@graph"), list):
                            candidates.extend(candidate["@graph"])
                        types = candidate.get("@type", []) if isinstance(candidate, dict) else []
                        types = [types] if isinstance(types, str) else types
                        if isinstance(candidate, dict) and any(t in ("Article", "NewsArticle", "BlogPosting") for t in types) and candidate.get("datePublished"):
                            date = news_date(candidate["datePublished"])
                            if date:
                                break
                except (ValueError, TypeError):
                    pass
                if date:
                    break
        return {"title": title, "publishedAt": date, "identityVerified": True,
                "bodyText": article_body_text(soup)}
    except (OSError, ValueError):
        return None


def discover_news(refresh=False):
    records = load_json(OUT / "territories.json", [])
    previous = load_json(WORK / "news-discovery.json", {})
    started = now()
    def read_source(source):
        sid = source["id"]
        path = fetch(sid, source["url"], sid + ".xml" if source["format"] == "rss" else sid + ".html",
            refresh, timeout=16, max_bytes=3_000_000, validator=lambda p: bool(parse_news_feed(p, source)))
        items = parse_news_feed(path, source) if path else []
        state = STATES[sid]
        state["name"], state["items"] = source["name"], len(items)
        signals = [discovered_news_signal(item, source, state.get("lastSuccessAt"), records) for item in items]
        for signal in signals:
            signal["sourceStatus"] = state["status"]
            signal["lastAttemptAt"] = state.get("lastAttemptAt")
            signal["publicationDateSource"] = "feed-published-date" if source["format"] == "rss" else "dated-news-card"
        # Bounded verification of the three newest article pages for each source.
        checked = 0
        for signal in sorted(signals, key=lambda s: s["publishedAt"], reverse=True)[:3]:
            article_id = "article-" + signal["id"]
            article_path = fetch(article_id, signal["sourceUrl"], article_id + ".html", refresh,
                timeout=10, max_bytes=3_000_000, validator=lambda p, title=signal["title"]: bool(parse_news_article(p, title)))
            article_state = STATES[article_id]
            signal["articleStatus"] = article_state["status"]
            signal["articleCheckedAt"] = article_state.get("lastSuccessAt")
            parsed = parse_news_article(article_path, signal["title"]) if article_path else None
            if parsed:
                checked += 1
                signal["extractionLevel"] = "official-article-identity-and-feed-description"
                if parsed["publishedAt"]:
                    signal["publishedAt"] = parsed["publishedAt"]
                    signal["publicationDateSource"] = "article-explicit-published-date"
        state["articlesVerified"] = checked
        state["latestPublishedAt"] = max((s["publishedAt"] for s in signals), default=None)
        return signals
    with ThreadPoolExecutor(max_workers=3) as pool:
        signals = [signal for group in pool.map(read_source, NEWS_FEEDS) for signal in group]
    successful = [STATES[s["id"]].get("lastSuccessAt") for s in NEWS_FEEDS if STATES[s["id"]].get("lastSuccessAt")]
    report = {"startedAt": started, "completedAt": now(), "lastSuccessAt": max(successful) if successful else previous.get("lastSuccessAt"),
        "discovered": len(signals), "sources": [STATES[s["id"]] for s in NEWS_FEEDS]}
    return signals, report


def refresh_news(refresh=False):
    seeds = load_json(WORK / "news-seeds.json", [])
    enrichment = load_json(ROOT / "scripts/public_pilot_evidence.json", {}).get("signals", {})
    for seed in seeds:
        seed.update(enrichment.get(seed["id"], {}))
    previous = {s["id"]: s for s in load_json(OUT / "signals.json", [])}
    def check(seed):
        sid = "news-" + seed["id"]
        def verified_title(path):
            soup = BeautifulSoup(path.read_text(errors="replace"), "html.parser")
            title = soup.find("h1")
            return bool(title and normalize_name(title.get_text(" ", strip=True)) == normalize_name(seed.get("sourceTitle", seed["title"])))
        path = fetch(sid, seed["sourceUrl"], sid + ".html", refresh, timeout=12, max_bytes=3_000_000, validator=verified_title)
        signal = dict(seed)
        signal["checkedAt"] = seed.get("checkedAt") or previous.get(seed["id"], {}).get("checkedAt")
        signal["sourceStatus"] = STATES[sid]["status"]
        signal["lastAttemptAt"] = STATES[sid].get("lastAttemptAt")
        # The headline must actually be present; an HTTP 200 challenge is not a successful refresh.
        if path:
            soup = BeautifulSoup(path.read_text(errors="replace"), "html.parser")
            title = soup.find("h1")
            if title and normalize_name(title.get_text(" ", strip=True)) == normalize_name(seed.get("sourceTitle", seed["title"])):
                signal["checkedAt"] = STATES[sid].get("lastSuccessAt")
            else:
                signal["sourceStatus"] = "editorially-verified-indexed-publication"
        elif signal.get("checkedAt"):
            signal["sourceStatus"] = "editorially-verified-indexed-publication"
        return signal
    with ThreadPoolExecutor(max_workers=4) as pool:
        signals = list(pool.map(check, seeds))
    discovered, report = discover_news(refresh)
    # Editorial seeds take precedence. Failed sources never erase saved signals.
    merged = {signal["sourceUrl"]: signal for signal in previous.values()}
    existing_urls = set(merged)
    for signal in discovered:
        old = merged.get(signal["sourceUrl"], {})
        enriched = {**old, **signal}
        # A feed refresh must not discard an editor's confirmed address/geometry.
        if old.get("coordinates") and not signal.get("coordinates"):
            for key in ("coordinates", "precision", "territoryId", "address", "addressSourceUrl", "coordinateSourceUrl",
                        "coordinateAsOf", "siteGeometry", "siteBbox", "siteZoom", "locationVerificationMethod", "geographyNote"):
                if key in old:
                    enriched[key] = old[key]
        if old.get("lifecycle", {}).get("status") not in (None, "not_applicable"):
            enriched["lifecycle"] = old["lifecycle"]
        merged[signal["sourceUrl"]] = enriched
    for signal in signals:
        merged[signal["sourceUrl"]] = signal
    # Reviewed event locations survive future feed refreshes. The offline overlay
    # matches both ID and original URL, never a publisher address or nearest POI.
    from fresh_signal_geography import apply_evidence
    evidence = load_json(ROOT / "scripts/fresh_signal_evidence.json", {})
    reviewed, geography_report = apply_evidence(list(merged.values()), evidence)
    merged = {signal["sourceUrl"]: signal for signal in reviewed}
    report["geography"] = geography_report
    report["added"] = len(set(merged) - existing_urls)
    report["total"] = len(merged)
    write_json(OUT / "signals.json", sorted(merged.values(), key=lambda s: (s.get("publishedAt") or "", s["id"]), reverse=True))
    write_json(WORK / "news-discovery.json", report)
    print(json.dumps({"signals": len(merged), "discovered": len(discovered), "added": report["added"]}), flush=True)


def build_regional_tiles():
    """Stream official Overture Parquet; retain only real footprints in the region.

    Heights are copied only when present. Floor counts are separate attributes.
    No randomized extrusion or invented rooftops. Detail tiles retain features;
    separate low zooms may omit smallest footprints to stay within tile budgets.
    """
    import pyarrow.parquet as pq
    from shapely import intersects, prepare
    boundary_path = WORK / "tatarstan-boundary-full.geojson"
    if not boundary_path.exists():
        territories()
    boundary = shape(load_json(boundary_path)["geometry"])
    prepare(boundary)
    bounds = ",".join(str(v) for v in boundary.bounds)
    tippecanoe = WORK / "tools/tippecanoe/tippecanoe"
    if not tippecanoe.exists():
        raise RuntimeError("Build tippecanoe in data/public/tools/tippecanoe before --buildings; see docs/data-sources.md")
    totals = {}
    tile_inputs = []
    for feature_type, filename in (("building", "tatarstan-buildings.parquet"), ("building_part", "tatarstan-building-parts.parquet")):
        parquet_path = WORK / filename
        if not parquet_path.exists():
            executable = Path(sys.executable).parent / "overturemaps"
            subprocess.run([str(executable), "download", "--bbox=" + bounds, "-f", "geoparquet", "--type=" + feature_type,
                "-o", str(parquet_path), "--connect_timeout", "10", "--request_timeout", "60"], check=True)
        state = load_json(parquet_path.with_name(parquet_path.name + ".state"), {})
        output = WORK / (feature_type + ".geojsonseq")
        parquet = pq.ParquetFile(parquet_path)
        available = parquet.schema_arrow.names
        columns = [c for c in ("id", "geometry", "height", "min_height", "num_floors", "min_floor", "names", "sources",
            "roof_shape", "roof_height", "roof_color", "roof_material", "roof_direction", "roof_orientation",
            "facade_color", "facade_material", "has_parts", "building_id", "class", "subtype") if c in available]
        count = 0
        with_height = 0
        with_floors = 0
        datasets = Counter()
        licenses = Counter()
        with output.open("w") as f:
            for batch in parquet.iter_batches(batch_size=16_384, columns=columns):
                geometries = from_wkb(batch.column(batch.schema.get_field_index("geometry")).to_pylist())
                keep = intersects(boundary, geometries)
                if not keep.any():
                    continue
                rows = batch.filter(keep).to_pylist()
                selected = geometries[keep]
                for row, geom in zip(rows, selected):
                    if geom.geom_type not in ("Polygon", "MultiPolygon") or geom.is_empty:
                        continue
                    props = {k: row[k] for k in columns if k not in ("geometry", "names", "sources") and row[k] is not None}
                    props["feature_type"] = feature_type
                    props["height_source"] = "source" if row.get("height") is not None else "unknown"
                    if row.get("names", None) and row["names"].get("primary"):
                        props["name"] = row["names"]["primary"]
                    sources = row.get("sources") or []
                    source_names = sorted({s.get("dataset", "") for s in sources if s.get("dataset")})
                    source_licenses = sorted({s.get("license", "") for s in sources if s.get("license")})
                    props["source_datasets"] = "; ".join(source_names)
                    props["source_licenses"] = "; ".join(source_licenses)
                    datasets.update(source_names)
                    licenses.update(source_licenses)
                    count += 1
                    with_height += row.get("height") is not None
                    with_floors += row.get("num_floors") is not None
                    f.write('{"type":"Feature","properties":' + json.dumps(props, ensure_ascii=False, separators=(",", ":")) + ',"geometry":' + to_geojson(geom) + '}\n')
        totals[feature_type] = {"count": count, "withKnownHeight": with_height, "withoutKnownHeight": count - with_height,
            "withKnownFloorCount": with_floors,
            "bboxCandidates": parquet.metadata.num_rows, "release": state.get("last_release"),
            "datasets": dict(datasets), "licenses": dict(licenses), "selection": "intersects verified OSM Tatarstan polygon"}
        tile_inputs += ["-L", feature_type + ":" + str(output)]
        print(json.dumps({feature_type: totals[feature_type]}, ensure_ascii=False), flush=True)
    target = OUT / "tatarstan-buildings.pmtiles"
    # Preserve the detailed pyramid; bounded distance levels are added separately below.
    command = [str(tippecanoe), "--force", "--quiet", "-o", str(target), "-Z13", "-z15", "-r1",
        "--no-feature-limit", "--no-tile-size-limit", "--no-tiny-polygon-reduction",
        "--name", "Татарстан — доступные здания Overture", "--attribution", "© OpenStreetMap contributors; Overture Maps Foundation; Microsoft",
        *tile_inputs]
    subprocess.run(command, check=True)
    totals.update({"pmtilesPath": "/data/tatarstan-buildings.pmtiles", "bytes": target.stat().st_size,
        "minZoom": 13, "maxZoom": 15, "layers": ["building", "building_part"], "builtAt": now(),
        "heightPolicy": "Render source height, otherwise estimate floors × 3 m, otherwise render an 8 m schematic volume. Display estimates never overwrite source height.",
        "renderingHeightPolicy": {"priority": ["source-height", "source-floors-times-3", "schematic-8m"],
            "metresPerFloor": 3, "fallbackMetres": 8, "isFallbackMeasured": False,
            "label": "Высота из источника; иначе оценка 3 м на этаж; без этажности — условный объём 8 м."}})
    write_json(WORK / "building-coverage.json", totals)
    # Pitched MapLibre views need z10–12; retain detail bytes and enforce a far-tile budget.
    subprocess.run([sys.executable, str(ROOT / "scripts/extend_building_lod.py"), "--archive", str(target)], check=True)
    print(json.dumps({"pmtiles": str(target), "bytes": target.stat().st_size}), flush=True)


def bank_offices(refresh=False):
    records = load_json(OUT / "territories.json", [])
    local_shapes = [(r, shape(r["geometry"])) for r in records if r.get("geometry") and r["kind"] != "region"]
    local_shapes.sort(key=lambda pair: pair[1].area)

    def territory_for_point(coordinates):
        point = Point(coordinates)
        return next((r["id"] for r, geom in local_shapes if geom.covers(point)), "RU-TA")

    def territory_for_address(address):
        normalized = normalize_name(address)
        for r in records:
            if r["kind"] == "urban_district" and normalize_name(r["name"]) in normalized:
                return r["id"]
        districts = [r for r in records if r["kind"] == "district" and normalize_name(r["name"]) in normalized]
        district_id = districts[0]["id"] if len(districts) == 1 else None
        cities = [r for r in records if r["kind"] == "settlement" and r["oktmo"][5] == "1"
                  and normalize_name(r["name"]) in normalized and (district_id is None or r["parentId"] == district_id)]
        return cities[0]["id"] if len(cities) == 1 else district_id or "RU-TA"

    def get_bank(item):
        bank_id, (brand, ogrn, internal_id) = item
        url = "https://www.cbr.ru/finorg/foinfo/branches/?" + urlencode({"UniDbQuery.id": internal_id,
            "UniDbQuery.term": "Татарстан", "UniDbQuery.Posted": "True"})
        path = fetch("cbr-" + bank_id, url, "cbr-" + bank_id + "-tatarstan.html", refresh, timeout=45)
        offices = []
        if path:
            soup = BeautifulSoup(path.read_text(), "html.parser")
            for tr in soup.select("tr"):
                cells = [" ".join(td.stripped_strings) for td in tr.find_all(["td", "th"])]
                if len(cells) < 5 or not re.match(r"^\d", cells[0]):
                    continue
                number, name, kind, address, opening = cells[:5]
                # Filter was applied by the registry; locally retain only populated address records.
                if not address:
                    continue
                offices.append({"id": "cbr-" + bank_id + "-" + number.replace("/", "-"), "bank": bank_id,
                    "bankName": brand, "name": name if not re.fullmatch(r"[\d/]+", name) else brand + " · офис " + name,
                    "registryName": name, "registryNumber": number, "registryType": kind, "address": address,
                    "territoryId": territory_for_address(address), "coordinates": None, "precision": None,
                    "sourceUrl": url, "checkedAt": STATES["cbr-" + bank_id].get("lastSuccessAt"),
                    "coordinateSourceUrl": None, "registryMatch": "registry-address", "openingDate": opening,
                    "institutionSourceUrl": "https://www.cbr.ru/finorg/foinfo/?ogrn=" + ogrn})
        return offices

    with ThreadPoolExecutor(max_workers=5) as pool:
        offices = [office for rows in pool.map(get_bank, BANKS.items()) for office in rows]
    osm_path = fetch("osm-bank-locations", OVERPASS + "?data=" + quote(BANK_QUERY), "osm-banks.json", refresh, timeout=150)
    if osm_path:
        osm = load_json(osm_path)
        seen_coordinates = set()
        for e in osm.get("elements", []):
            tags = e.get("tags", {})
            label = " ".join(tags.get(k, "") for k in ("name", "brand", "operator")).lower()
            bank_id = ("sber" if "сбер" in label else "vtb" if "втб" in label else "akbars" if "ак барс" in label
                else "gazprombank" if "газпромбанк" in label else "psb" if "промсвязь" in label or "псб" in label else None)
            if not bank_id:
                continue
            coord = [e["lon"], e["lat"]] if e.get("lon") is not None else ([e["center"]["lon"], e["center"]["lat"]] if e.get("center") else None)
            if not coord:
                continue
            key = (bank_id, round(coord[0], 6), round(coord[1], 6))
            if key in seen_coordinates:
                continue
            seen_coordinates.add(key)
            url = f"https://www.openstreetmap.org/{e['type']}/{e['id']}"
            territory_id = territory_for_point(coord)
            possible = [o for o in offices if o["bank"] == bank_id]
            ref = tags.get("ref", "").strip()
            match = [o for o in possible if ref and (o.get("registryName") == ref or o.get("registryNumber") == ref)]
            method = "registry-reference-and-OSM-location"
            # Never match by proximity alone. A street+house match also requires the same municipality.
            if not match and tags.get("addr:street") and tags.get("addr:housenumber"):
                street = normalize_name(tags["addr:street"].replace("улица", "").replace("проспект", ""))
                house = re.escape(tags["addr:housenumber"].lower())
                match = [o for o in possible if o["id"].startswith("cbr-") and o["territoryId"] == territory_id and street in normalize_name(o["address"])
                    and re.search(r"(?<!\d)" + house + r"(?!\d)", o["address"].lower())]
                method = "registry-address-and-OSM-location"
            if len(match) == 1 and match[0]["coordinates"] is None:
                match[0].update({"coordinates": coord, "precision": "building", "territoryId": territory_id,
                    "coordinateSourceUrl": url, "registryMatch": method, "osmCheckDate": tags.get("check_date"),
                    "coordinateAsOf": osm.get("osm3s", {}).get("timestamp_osm_base")})
            elif not match:
                brand, ogrn, _ = BANKS[bank_id]
                address_parts = [tags[k] for k in ("addr:city", "addr:street", "addr:housenumber") if tags.get(k)]
                offices.append({"id": "osm-" + e["type"] + "-" + str(e["id"]), "bank": bank_id, "bankName": brand,
                    "name": tags.get("official_name") or tags.get("name") or brand,
                    "address": ", ".join(address_parts) or "Адрес не указан в OSM; положение отмечено участниками карты",
                    "territoryId": territory_id, "coordinates": coord, "precision": "building",
                    "sourceUrl": url, "checkedAt": STATES["osm-bank-locations"].get("lastSuccessAt"),
                    "coordinateSourceUrl": url, "registryMatch": "not-matched-to-registry-office",
                    "institutionSourceUrl": "https://www.cbr.ru/finorg/foinfo/?ogrn=" + ogrn,
                    "osmCheckDate": tags.get("check_date"), "coordinateAsOf": osm.get("osm3s", {}).get("timestamp_osm_base")})
    write_json(OUT / "bank-offices.json", offices)
    print(json.dumps({"bankRecords": len(offices), "byBank": dict(Counter(o["bank"] for o in offices)),
        "located": sum(o["coordinates"] is not None for o in offices),
        "registryMatchedLocations": sum(o["coordinates"] is not None and o["id"].startswith("cbr-") for o in offices)}, ensure_ascii=False), flush=True)


def manifest():
    records = load_json(OUT / "territories.json", [])
    signals = load_json(OUT / "signals.json", [])
    banks = load_json(OUT / "bank-offices.json", [])
    buildings = load_json(WORK / "building-coverage.json", {})
    previous = load_json(OUT / "manifest.json", {})
    old_sources = {s["id"]: s for s in previous.get("sources", [])}
    old_sources.update(STATES)
    if buildings.get("builtAt"):
        old_sources["overture-buildings"] = {"id": "overture-buildings", "url": "https://docs.overturemaps.org/guides/buildings/",
            "status": "cached", "lastSuccessAt": buildings["builtAt"], "error": None,
            "release": buildings.get("building", {}).get("release")}
    value = {"schemaVersion": 1, "generatedAt": now(), "sources": list(old_sources.values()),
        "coverage": {"municipalities": sum(r["kind"] != "region" for r in records), "territoriesIncludingRegion": len(records),
            "byKind": dict(Counter(r["kind"] for r in records)), "withGeometry": sum(r["geometryStatus"] == "verified" for r in records),
            "missingGeometry": sum(r["geometryStatus"] == "missing" for r in records),
            "officialRegistryAsOf": records[0].get("asOf") if records else None,
            "publicSignals": len(signals), "bankOffices": len(banks), "bankOfficesWithCoordinates": sum(bool(b.get("coordinates")) for b in banks),
            "bankRecords": len(banks), "uniqueOfficeCount": None,
            "bankRegistryRecords": sum(b["id"].startswith("cbr-") for b in banks),
            "bankOsmOnlyRecords": sum(b["id"].startswith("osm-") for b in banks),
            "bankRegistryRecordsWithCoordinates": sum(b["id"].startswith("cbr-") and bool(b.get("coordinates")) for b in banks),
            "newsDiscovery": load_json(WORK / "news-discovery.json", {}),
            "buildings": buildings},
        "limitations": ["Границы OSM сопоставлены со справочником ОКТМО; это картографические данные, не юридическая кадастровая выписка.",
            "Обзор регионов России использует историческую выгрузку OSM с неизвестной датой; контуры отображаются в трактовке этого источника.",
            "Дата публикации новости отделена от даты её проверки. Публичные сигналы не подтверждают сделку или коммерческую потребность.",
            "Новые материалы извлекаются из фиксированных официальных лент. При недоступности ленты сохраняется последний успешный набор; полный текст и текущая стадия проекта автоматически не подтверждаются.",
            "Координаты отсутствуют, если точное местоположение не подтверждено. Центры территорий являются точками подписи, не адресами событий.",
            "Карта банковских офисов не заявляет полное покрытие банковской сети или актуальность графиков работы.",
            "Число банковских записей не равно числу уникальных действующих офисов: несопоставленные записи ЦБ и OSM могут пересекаться.",
            "Отсутствующая высота здания не заменяется вымышленной измеренной высотой."]}
    write_json(OUT / "manifest.json", value)
    write_json(WORK / "source-state.json", old_sources)


def main():
    import fcntl
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("all", "territories", "regions", "news", "banks", "buildings", "refresh"):
        parser.add_argument("--" + flag, action="store_true")
    parser.add_argument("--watch", type=int, default=0, metavar="SECONDS", help="Refresh public news while this process is running (minimum 900 seconds)")
    args = parser.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    # One public-data writer, also across local server restarts and CLI runs.
    # flock is released by the OS if a process exits; a stale file is harmless.
    lock_file = (WORK / "pipeline.lock").open("a+")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"status": "already-running"}), flush=True)
        return
    STATES.update(load_json(WORK / "source-state.json", {}))
    try:
        if args.all or args.territories:
            territories(args.refresh)
        if args.all or args.regions:
            national_regions(args.refresh)
        if args.all or args.news or args.watch:
            refresh_news(args.refresh)
        if args.all or args.banks:
            bank_offices(args.refresh)
        if args.buildings:
            build_regional_tiles()
    finally:
        manifest()
    while args.watch:
        time.sleep(max(900, args.watch))
        try:
            refresh_news(True)
        finally:
            manifest()


if __name__ == "__main__":
    main()
