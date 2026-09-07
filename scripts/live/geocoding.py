from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import re
import sqlite3
import unicodedata
from itertools import product
from functools import lru_cache
from pathlib import Path
from typing import Any

from connectors import iso_now


ROOT = Path(__file__).resolve().parents[2]
from runtime_paths import DATA_ROOT
from region_config import region_config
DEFAULT_STREET_INDEX = DATA_ROOT / "data/public/kazan-street-index.json"
GEOCODER_VERSION = "regional-source-context-v25-fast-local-ingestion"

STREET_KINDS = {
    "тракта":"tract", "трактом":"tract", "проспектом":"avenue", "проспекту":"avenue", "проезде":"drive", "проезда":"drive", "бульваре":"boulevard", "бульвара":"boulevard", "аллее":"alley", "аллеи":"alley",
    "улице": "street", "улицы": "street", "улицу": "street", "проспекте": "avenue", "проспекта": "avenue", "переулке": "lane", "переулка": "lane", "набережной": "embankment", "тракте": "tract", "улица": "street", "ул": "street", "проспект": "avenue", "просп": "avenue", "пр-т": "avenue", "пр-кт": "avenue",
    "пркт": "avenue", "переулок": "lane", "пер": "lane", "проезд": "drive", "бульвар": "boulevard",
    "б-р": "boulevard", "бул": "boulevard", "шоссе": "highway", "набережная": "embankment",
    "наб": "embankment", "площадь": "square", "пл": "square", "тракт": "tract", "аллея": "alley",
    "урамы":"street", "проспекты":"avenue", "мәйданы":"square",
}
def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _stable_id(prefix: str, value: str, size: int = 24) -> str:
    return prefix + hashlib.sha256(value.encode()).hexdigest()[:size]


def _fold(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")
    return " ".join(re.findall(r"[^\W_]+", value))


def normalize_street(value: str) -> tuple[str, str | None]:
    folded = unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")
    folded = re.sub(r"([а-я])\.(?=[а-я])", r"\1 ", folded)
    words = re.sub(r"[^\w\s-]|_", " ", folded).split()
    kind: str | None = None
    retained: list[str] = []
    ambiguous_kinds={'набережная','набережной','набережную','площадь'}
    positions=[i for i,word in enumerate(words) if word in STREET_KINDS]
    strong=[i for i in positions if words[i] not in ambiguous_kinds]
    kind_position=strong[0] if strong else positions[0] if positions and len(words)>1 else None
    for i,word in enumerate(words):
        if i==kind_position:
            kind = STREET_KINDS[word]
        elif word not in {"им", "имени"}:
            retained.append(word)
    name = " ".join(retained)
    name = re.sub(r"(\d+)[- ]?(?:я|й|ая|ый)(?=\s|$)", r"\1", name)
    return " ".join(name.split()), kind


def _street_part(address: str) -> str:
    value = unicodedata.normalize("NFKC", address).strip()
    value = re.sub(r"^(?:(?:г(?:ород)?\.?\s*)?казан[ьи])\s*[,;:-]?\s*", "", value, flags=re.IGNORECASE)
    # A comma or an explicit house marker is required before a house number.
    # This avoids turning a numbered street name into a fabricated house match.
    value = re.sub(
        r"(?:\s*,\s*(?:(?:д(?:ом)?\.?)\s*)?\d+[а-яa-z]?(?:\s*(?:к|корп(?:ус)?|стр(?:оение)?)\.?\s*\d+[а-яa-z]?)?.*"
        r"|\s+(?:д(?:ом)?\.?)\s*\d+[а-яa-z]?(?:\s*(?:к|корп(?:ус)?|стр(?:оение)?)\.?\s*\d+[а-яa-z]?)?.*)$",
        "", value, flags=re.IGNORECASE,
    )
    return value.strip(" ,;:-")


def _street_variants(address: str) -> list[str]:
    primary = _street_part(address)
    variants = [primary] if primary else []
    # Rule extraction may retain a final house number but omit the comma. The
    # full value is always tried first, so a real numbered street still wins.
    without_bare_house = re.sub(
        r"\s+\d+[а-яa-z]?(?:\s*(?:к|корп(?:ус)?|стр(?:оение)?)\.?\s*\d+[а-яa-z]?)?$",
        "", primary, flags=re.IGNORECASE,
    ).strip()
    if without_bare_house and without_bare_house != primary:
        variants.append(without_bare_house)
    # A quoted resident's capitalized name can follow the street without punctuation.
    if normalize_street(primary)[1] and len(primary.split()) >= 4:
        words=primary.split()
        variants.extend(' '.join(words[:n]) for n in range(len(words)-1,1,-1))
    return variants


def canonical_house_candidate(candidate: str, street_result: dict[str, Any]) -> str:
    """Use an already unambiguous street match; keep the source house/corpus intact."""
    from object_geocoding import split_address
    parts = split_address(candidate)
    if (parts and street_result.get('status') == 'matched'
            and street_result.get('precision') == 'street'
            and street_result.get('candidateCount') == 1
            and street_result.get('streetName')):
        return street_result['streetName'] + ', ' + parts[2]
    return candidate


def _supported_candidates(connection: sqlite3.Connection, event_id: str, candidates: list[str]) -> tuple[list[str], list[str]]:
    documents = connection.execute(
        "SELECT d.title,d.body FROM documents d JOIN event_documents ed ON ed.document_id=d.id "
        "WHERE ed.event_id=? AND d.deleted_at IS NULL", (event_id,),
    ).fetchall()
    from location_quality import location_text
    source_texts=[location_text(row['title']+'\n'+(row['body'] or '')) for row in documents]
    texts=[_fold(text) for text in source_texts]
    from analysis import extract_address_mentions
    composed = {_fold(m['address']) for text in source_texts for m in extract_address_mentions(text)}
    supported, unsupported = [], []
    for candidate in candidates:
        folded = _fold(candidate)
        if folded and (folded in composed or any(folded in text for text in texts)):
            supported.append(candidate)
        else:
            unsupported.append(candidate)
    return supported, unsupported


def load_street_index(path: Path = DEFAULT_STREET_INDEX) -> dict[str, Any]:
    return _cached_street_index(str(path.resolve()),path.stat().st_mtime_ns)


@lru_cache(maxsize=2)
def _cached_street_index(path: str, modified: int):
    raw = json.loads(Path(path).read_text())
    if raw.get("schemaVersion") != 1 or not raw.get("territoryId") or not isinstance(raw.get("streets"), list):
        raise ValueError("unsupported street index")
    return raw


def preserve_location_metadata(data: dict[str, Any], previous_json: str | None) -> dict[str, Any]:
    if not previous_json:
        return data
    try:
        previous = json.loads(previous_json)
    except (TypeError, ValueError):
        return data
    for key in ("addressSourceUrl", "coordinateSourceUrl", "locationVerificationMethod", "geographyNote",
                "streetGeometryRef", "locationEvidence", "siteGeometry", "siteBbox", "siteZoom"):
        if key in previous:
            data[key] = previous[key]
    return data


def _connected_street_parts(matches: list[dict[str, Any]], *, same_locality: bool = False) -> list[dict[str, Any]]:
    """Merge parallel/nearby segments of the same named street, not distant homonyms."""
    if len(matches) < 2:
        return matches
    if len({(normalize_street(s.get('name',''))[0],s.get('kind')) for s in matches}) != 1:
        return matches
    def close(a,b):
        aa,bb=a.get('bbox'),b.get('bbox')
        if not aa or not bb:return False
        dx=max(0,aa[0]-bb[2],bb[0]-aa[2])*111320*math.cos(math.radians((aa[1]+aa[3])/2))
        dy=max(0,aa[1]-bb[3],bb[1]-aa[3])*111320
        return math.hypot(dx,dy)<=80
    connected=[matches[0]];remaining=matches[1:]
    while remaining:
        adjacent=[s for s in remaining if any(close(s,k) for k in connected)]
        if not adjacent:
            if not same_locality:return matches
            connected.extend(remaining);break
        connected.extend(adjacent);remaining=[s for s in remaining if s not in adjacent]
    lines=[]
    for street in connected:
        geometry=street.get('geometry') or {}
        if geometry.get('type')=='LineString':lines.append(geometry['coordinates'])
        elif geometry.get('type')=='MultiLineString':lines.extend(geometry['coordinates'])
    if not lines:return matches
    connected = [s for s in connected if s.get('bbox') and len(s.get('bbox')) == 4]
    if not connected:
        return matches
    return [{**matches[0], 'id':'+'.join(sorted(s['id'] for s in connected)),
        'geometry':{'type':'MultiLineString','coordinates':lines},
        'bbox':[min(s['bbox'][0] for s in connected),min(s['bbox'][1] for s in connected),max(s['bbox'][2] for s in connected),max(s['bbox'][3] for s in connected)],
        'sourceUrls':list(dict.fromkeys(url for s in connected for url in s.get('sourceUrls',[])))}]


def match_address_candidates(candidates: list[str], territory_id: str | None, index: dict[str, Any], *, locality_id: str | None = None) -> dict[str, Any]:
    locality = next((p for p in index.get('localities',[]) if p['id']==locality_id), None) if locality_id else None
    places_by_id = index.get('_localitiesById')
    if places_by_id is None:
        places_by_id = {p['id']:p for p in index.get('localities',[])}
        index['_localitiesById'] = places_by_id
    def in_locality(street):
        if not locality_id:
            return True
        if 'localityIds' in street:
            if locality_id in street['localityIds']:
                return True
            assigned = [places_by_id[p] for p in street['localityIds'] if p in places_by_id]
            # Old nearest-point assignments sometimes crossed municipal borders.
            # Discard only that inconsistent hint; retain valid village scoping.
            if not assigned or any(p.get('territoryId') == street.get('territoryId') for p in assigned):
                return False
        # The older Kazan extract predates localityIds. Its exact city scope
        # is sufficient; a municipality with several villages is not.
        return bool(locality and locality.get('placeKind') in {'city','town'}
            and street.get('territoryId') == locality.get('territoryId') == territory_id)
    empty = {
        "status": "unmatched", "precision": "territory", "candidateCount": 0, "addressCandidate": None,
        "streetId": None, "streetName": None, "representativeCoordinate": None, "bbox": None,
        "sourceUrl": index.get("sourceUrl"), "sourceUrls": [], "checkedAt": index.get("checkedAt"),
        "method": "no-exact-local-street-match",
        "note": "Точное место события не установлено. Сохранена территория; случайная улица или дом не назначаются.",
    }
    if territory_id != index.get("territoryId") and not any(territory_id in s.get('scopeIds',[s.get('territoryId')]) for s in index['streets']):
        return {**empty, "method": "territory-not-covered-by-local-street-index",
            "note": "Для этой территории ещё нет локальной геометрии улиц. Событие сохранено на уровне исходной территории."}

    lookup = index.get("_atlasLookup")
    if not isinstance(lookup, dict):
        lookup = {}
        for street in index["streets"]:
            for alias in [street.get("name", ""), *(street.get("aliases") or [])]:
                name, _ = normalize_street(alias)
                if name and all(existing.get("id") != street.get("id") for existing in lookup.setdefault(name, [])):
                    lookup[name].append(street)
        index["_atlasLookup"] = lookup

    exact: list[tuple[str, dict[str, Any]]] = []
    ambiguous_count = 0
    for candidate in candidates:
        matches: list[dict[str, Any]] = []
        for street_part in _street_variants(candidate):
            name, kind = normalize_street(street_part)
            if not name:
                continue
            names=[name]
            if name.endswith('ой'):names.append(name[:-2]+'ая')
            if name.endswith('ую'):names.append(name[:-2]+'ая')
            if name.endswith('скую'):names.append(name[:-4]+'ская')
            if name.endswith(('ого','ому')):names.extend([name[:-3]+'ый',name[:-3]+'ий'])
            if name.endswith('ом'):names.extend([name[:-2]+'ый',name[:-2]+'ий'])
            # Source bounds inflect every adjective: «Большой Красной» must
            # resolve the two-word OSM name «Большая Красная».
            words=name.split()
            if 1<len(words)<=4:
                variants=[[word,word[:-2]+'ая'] if word.endswith(('ой','ую')) else [word] for word in words]
                names.extend(' '.join(parts) for parts in product(*variants))
            possible={street['id']:street for alias in names for street in lookup.get(alias,[]) if territory_id in street.get('scopeIds',[street.get('territoryId')]) and in_locality(street) and (not kind or not street.get('kind') or street['kind']==kind)}
            if not possible and kind:
                # An omitted first name is accepted only when the surname has a
                # unique street/corridor in this territory and matching road kind.
                for alias,streets in lookup.items():
                    if alias.endswith(' '+name):
                        possible.update({street['id']:street for street in streets})
            matches = _connected_street_parts([street for street in possible.values() if territory_id in street.get('scopeIds',[street.get('territoryId')]) and (not kind or not street.get("kind") or street.get("kind") == kind) and in_locality(street)], same_locality=bool(locality_id) and all(locality_id in street.get("localityIds",[]) for street in possible.values()))
            if matches:
                break
        if len(matches) == 1:
            exact.append((candidate, matches[0]))
        elif len(matches) > 1:
            ambiguous_count += len(matches)

    distinct = {street.get("id"): (candidate, street) for candidate, street in exact}
    if ambiguous_count or len(distinct) > 1:
        return {**empty, "status": "ambiguous", "candidateCount": ambiguous_count + len(distinct),
            "method": "ambiguous-local-street-name",
            "note": "Адресные фрагменты соответствуют нескольким улицам или несвязанным участкам. Нужна ручная проверка; координата не назначена."}
    if not distinct:
        return empty

    candidate, street = next(iter(distinct.values()))
    coordinate = street.get("coordinates")
    if not (isinstance(coordinate, list) and len(coordinate) == 2 and all(isinstance(value, (int, float)) for value in coordinate)):
        return empty
    source_urls = [value for value in street.get("sourceUrls", []) if isinstance(value, str)]
    source_url = street.get("sourceUrl") if isinstance(street.get("sourceUrl"), str) else index.get("sourceUrl")
    return {
        "status": "matched", "precision": "street", "candidateCount": 1, "addressCandidate": candidate,
        "streetId": street.get("id"), "streetName": street.get("name"), "representativeCoordinate": coordinate,
        "bbox": street.get("bbox"), "geometry": street.get("geometry"), "sourceUrl": source_url, "sourceUrls": source_urls,
        "checkedAt": index.get("checkedAt"), "method": "exact-normalized-street-name-and-territory",
        "note": "Название улицы однозначно сопоставлено с локальной геометрией OSM. Координата — опорная точка самой улицы, а не место события и не подтверждённый дом; точность building не назначается.",
    }


def match_street_objects(candidates: list[str], territory_id: str | None, index: dict[str, Any], *, locality_id: str | None = None) -> dict[str, Any]:
    """Resolve every independently unambiguous street named by one source.

    A source can describe one event that affects several streets. That is not
    an ambiguous address: each named street is a real, separately evidenced
    map object. We keep ``street`` precision and never infer a house or a
    single point of impact.
    """
    resolved: list[dict[str, Any]] = []
    unresolved=[]
    seen: set[str] = set()
    for candidate in candidates:
        result = match_address_candidates([candidate], territory_id, index, locality_id=locality_id)
        street_id = result.get("streetId")
        if result.get("status") != "matched" or result.get("precision") != "street" or not street_id:
            unresolved.append(candidate)
            continue
        if street_id in seen:continue
        geometry = result.get("geometry") or {}
        if geometry.get("type") not in {"LineString", "MultiLineString"}:
            continue
        seen.add(street_id)
        resolved.append(result)
    if not resolved:
        return {"status": "unmatched"}

    lines: list[list[list[float]]] = []
    for result in resolved:
        geometry = result["geometry"]
        if geometry["type"] == "LineString":
            lines.append(geometry["coordinates"])
        else:
            lines.extend(geometry["coordinates"])
    points = [point for line in lines for point in line]
    first = resolved[0]
    street_objects = [{
        "streetId": item["streetId"], "streetName": item["streetName"],
        "addressCandidate": item["addressCandidate"], "bbox": item.get("bbox"),
        "sourceUrl": item["sourceUrl"], "sourceUrls": item.get("sourceUrls", []),
    } for item in resolved]
    names = [str(item["streetName"]) for item in resolved]
    urls = list(dict.fromkeys(url for item in resolved for url in item.get("sourceUrls", [])))
    return {
        "status": "matched", "precision": "street", "candidateCount": len(resolved),
        "streetId": first["streetId"], "streetName": " · ".join(names),
        "addressCandidate": first["addressCandidate"],
        "representativeCoordinate": first["representativeCoordinate"],
        "geometry": {"type": "LineString", "coordinates": lines[0]} if len(lines) == 1 else {"type": "MultiLineString", "coordinates": lines},
        "bbox": [min(point[0] for point in points), min(point[1] for point in points), max(point[0] for point in points), max(point[1] for point in points)],
        "sourceUrl": first["sourceUrl"], "sourceUrls": urls, "checkedAt": first.get("checkedAt"),
        "method": "source-named-street-objects",
        "streetObjects": street_objects, "unresolvedCandidates": unresolved, "coverage": "partial" if unresolved else "all_named_streets",
        "note": "Источник называет несколько улиц. На карте показаны сами подтверждённые улицы; опорная точка нужна только для открытия карточки и не означает место события или дом." + (" Часть перечисленных адресов ещё не сопоставлена." if unresolved else ""),
    }


def enqueue_geocode_job(connection: sqlite3.Connection, event_id: str, source_id: str | None, candidates: list[Any], basis: str = "", *, priority: int = 20) -> bool:
    clean = list(dict.fromkeys(value.strip() for value in candidates if isinstance(value, str) and value.strip()))[:10]
    digest = hashlib.sha256((_json(clean) + "|" + basis).encode()).hexdigest()[:16]
    dedupe_key = f"geocode:{GEOCODER_VERSION}:{event_id}:{digest}"
    job_id = _stable_id("job_geo_", dedupe_key)
    connection.execute(
        "INSERT INTO jobs(id,kind,source_id,dedupe_key,status,priority,run_after,payload_json) VALUES(?,?,?,?,?,?,?,?) "
        "ON CONFLICT(dedupe_key) DO NOTHING",
        (job_id, "geocode", source_id, dedupe_key, "queued", priority, iso_now(), _json({"eventId": event_id, "addressCandidates": clean})),
    )
    return bool(connection.execute("SELECT changes()").fetchone()[0])


def _finish_job(connection: sqlite3.Connection, job: sqlite3.Row, result: dict[str, Any]) -> None:
    payload = json.loads(job["payload_json"] or "{}")
    payload["result"] = result
    connection.execute("UPDATE jobs SET status='complete',finished_at=?,error=NULL,payload_json=? WHERE id=?",
        (iso_now(), _json(payload), job["id"]))


def _retry_job(connection: sqlite3.Connection, job: sqlite3.Row, error: Exception) -> None:
    attempts = int(job["attempts"] or 0)
    if attempts >= 3:
        connection.execute("UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=?",
            (iso_now(), f"{type(error).__name__}: {error}"[:1000], job["id"]))
        return
    run_after = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=30 * (2 ** max(0, attempts - 1)))).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    connection.execute("UPDATE jobs SET status='queued',run_after=?,started_at=NULL,error=? WHERE id=?",
        (run_after, f"{type(error).__name__}: {error}"[:1000], job["id"]))


def merge_duplicate_source_site(connection, event, data, result):
    """One resolved object/road per source post, regardless of spelling or case."""
    group=data.get('site_group_key');identity=result.get('objectId') or result.get('streetId')
    if not group or result.get('status')!='matched' or not identity:return None
    candidates=connection.execute(
        "SELECT id,data_json FROM events WHERE id<>? AND deleted=0 AND region_id=? "
        "AND json_extract(data_json,'$.site_group_key')=? ORDER BY id",(event['id'],event['region_id'],group)).fetchall()
    survivor=None
    for candidate in candidates:
        evidence=json.loads(candidate['data_json']).get('locationEvidence',{})
        section=result.get('sourceSection');other_section=evidence.get('sourceSection')
        if bool(section)!=bool(other_section):continue
        if section and sorted([section['from']['streetId'],section['to']['streetId']])!=sorted([other_section['from']['streetId'],other_section['to']['streetId']]):continue
        if (evidence.get('objectId') or evidence.get('streetId'))==identity:
            survivor=candidate['id'];break
    if survivor is None:return None
    # Retain original documents/evidence for audit. The alias also preserves a
    # previously copied signal URL while the tombstone removes its extra pin.
    now=iso_now()
    owns_transaction=not connection.in_transaction
    if owns_transaction:connection.execute('BEGIN IMMEDIATE')
    try:
        connection.execute("INSERT INTO event_aliases(alias,event_id) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET event_id=excluded.event_id",(event['id'],survivor))
        revision=connection.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,'delete',0,?)",(event['id'],now)).lastrowid
        connection.execute('UPDATE events SET deleted=1,notify_eligible=0,revision=?,updated_at=? WHERE id=?',(revision,now,event['id']))
        if owns_transaction:connection.commit()
    except Exception:
        if owns_transaction:connection.rollback()
        raise
    return survivor


def coalesce_geocode_jobs(connection):
    """One pending source refresh per event, even across resolver upgrades."""
    rows=connection.execute("SELECT id,payload_json FROM jobs WHERE kind='geocode' AND status='queued' ORDER BY priority DESC,rowid DESC").fetchall()
    seen={};count=0
    for row in rows:
        event_id=json.loads(row['payload_json'] or '{}').get('eventId')
        if not event_id:continue
        if event_id not in seen:seen[event_id]=row['id'];continue
        payload=json.loads(row['payload_json']);payload['result']={'status':'superseded','method':'newer-event-refresh-pending','supersededBy':seen[event_id]}
        connection.execute("UPDATE jobs SET status='complete',payload_json=?,finished_at=?,error=NULL WHERE id=? AND status='queued'",(_json(payload),iso_now(),row['id']))
        count+=1
    return count


def consume_geocode_jobs(connection: sqlite3.Connection, *, index_path: Path | None = None, limit: int = 20, allow_network: bool = True, event_ids: list[str] | None = None, local_first: bool = False) -> dict[str, int]:
    if event_ids is not None and not event_ids:return {"processed":0,"matched":0,"ambiguous":0,"unmatched":0,"preserved":0,"failed":0}
    coalesce_geocode_jobs(connection)
    completed_local=[]
    from langsearch_location import reset_search_budget, SearchDeferred
    reset_search_budget()
    from location_resolution import reset_budget,resolve_unmatched,prewarm_location_batch
    reset_budget()
    if allow_network and index_path is None and event_ids is None:prewarm_location_batch(connection)
    totals = {"processed": 0, "matched": 0, "ambiguous": 0, "unmatched": 0, "preserved": 0, "failed": 0}
    indexes={}
    selected=" AND json_extract(payload_json,'$.eventId') IN ("+",".join("?" for _ in event_ids)+")" if event_ids is not None else ""
    for _ in range(max(0, limit)):
        connection.execute("BEGIN IMMEDIATE")
        try:
            job = connection.execute(
                "SELECT * FROM jobs WHERE kind='geocode' AND status='queued' AND run_after<=? "
                +selected+" ORDER BY priority DESC,run_after,id LIMIT 1", (iso_now(),*(event_ids or [])),
            ).fetchone()
            if not job:
                connection.commit()
                break
            connection.execute("UPDATE jobs SET status='running',attempts=attempts+1,started_at=?,error=NULL WHERE id=?", (iso_now(), job["id"]))
            connection.commit()
            job = connection.execute("SELECT * FROM jobs WHERE id=?", (job["id"],)).fetchone()
        except Exception:
            connection.rollback()
            raise

        try:
            payload = json.loads(job["payload_json"] or "{}")
            if local_first:
                payload["localPassAt"]=iso_now()
                connection.execute("UPDATE jobs SET payload_json=? WHERE id=?",(_json(payload),job["id"]))
                job=connection.execute("SELECT * FROM jobs WHERE id=?",(job["id"],)).fetchone()
                completed_local.append(job["id"])
            event = connection.execute("SELECT * FROM events WHERE id=? AND deleted=0", (payload.get("eventId"),)).fetchone()
            if event is None:
                _finish_job(connection, job, {"status": "unmatched", "method": "event-no-longer-available"})
                totals["processed"] += 1; totals["unmatched"] += 1
                continue
            data = json.loads(event['data_json'] or '{}')
            automatic_location=event['precision'] in {'building','site','street','settlement'} and data.get('locationVerificationMethod') in {'exact-normalized-street-name-and-territory','exact-normalized-street-name-and-kazan-territory','unique-short-street-name-and-territory','source-named-settlement-and-municipal-scope','source-named-street-objects','source-section-intersections','source-named-junction','langsearch-address-osm-verified-object','source-address-osm-verified-object','exact-address-or-unique-named-object'}
            grounded_location = bool(data.get('coordinateSourceUrl') and
                                    (data.get('siteGeometry') or data.get('streetGeometryRef')))
            untrusted_reset = bool(data.get('untrustedLocationReset'))
            preserve_existing = (not untrusted_reset and not automatic_location and
                                 (event['precision'] != 'territory' or event['longitude'] is not None or
                                  event['latitude'] is not None))
            if bool(event["reviewed"]) or preserve_existing or (not automatic_location and grounded_location):
                _finish_job(connection, job, {"status": "preserved", "method": "existing-reviewed-location-preserved",
                    "precision": event["precision"]})
                totals["processed"] += 1; totals["preserved"] += 1
                continue

            if index_path is None:
                from article_enrichment import pending_article
                pending=pending_article(connection,event['id'])
                if pending:
                    data['locationSourceQuality']={'status':'awaiting_full_article','documentId':pending,'checkedAt':iso_now()}
                    connection.execute('UPDATE events SET data_json=? WHERE id=?',(_json(data),event['id']))
                    raise SearchDeferred('Full source article pending before location analysis')
            data['locationSourceQuality']={'status':'source_ready','checkedAt':iso_now()}
            candidates = [value for value in payload.get("addressCandidates", []) if isinstance(value, str)]
            # Do not let a generic preposition fragment (from older parser
            # versions) trigger location reasoning or provider lookups.
            candidates = [value for value in candidates
                          if not re.fullmatch(r"(?i)(?:на|по)\s+улиц(?:а|е|ы|у|ой|ами|ах)?", value.strip())]
            # Re-read evidence for old and new jobs: model output may omit an address.
            # Split site events retain their own context, never borrow sibling addresses.
            from analysis import extract_addresses
            from object_geocoding import split_address
            source_rows=connection.execute('SELECT d.title,d.body FROM documents d JOIN event_documents ed ON ed.document_id=d.id WHERE ed.event_id=? AND d.deleted_at IS NULL',(event['id'],)).fetchall()
            source_text='\n'.join(row['title']+'\n'+(row['body'] or '') for row in source_rows)
            extraction_text=data.get('location_context','') if data.get('site_group_key') else source_text
            house_range=re.search(r',\s*\d+\s*[-–]\s*\d+\b',extraction_text or '')
            extracted=extract_addresses(extraction_text) if extraction_text and extraction_text in source_text else []
            # Prefer a source-composed house over the same street without its house.
            candidates=list(dict.fromkeys([*candidates,*extracted]))
            candidates=[c for c in candidates if not any(other.startswith(c+', ') for other in candidates if other!=c)]
            supported, unsupported = _supported_candidates(connection, event["id"], candidates)
            from location_quality import location_text,constrain_precision
            role_candidates=extract_addresses(location_text(extraction_text))
            contact_rejected=[c for c in candidates if c in extracted and c not in role_candidates]
            supported=[c for c in supported if c not in contact_rejected]
            data['rejectedContactAddresses']=contact_rejected
            data['addressCandidates']=supported
            file=index_path
            if file is None:
                config=region_config(event['region_id']);file=DATA_ROOT/config['streetIndex']
                if not file.exists() and config.get('fallbackStreetIndex'):file=DATA_ROOT/config['fallbackStreetIndex']
            if file not in indexes:indexes[file]=load_street_index(file)
            index=indexes[file]
            texts=connection.execute('SELECT d.id,d.source_id,d.canonical_url,d.published_at,d.title,d.body FROM documents d JOIN event_documents ed ON ed.document_id=d.id WHERE ed.event_id=? AND d.deleted_at IS NULL',(event['id'],)).fetchall()
            text=location_text('\n'.join(row['title']+'\n'+(row['body'] or '') for row in texts))
            from region_config import matching_locality,source_locates_in_place,contextual_locality
            context=data.get('location_context','')
            context=context if context and context in text else '\n'.join(row['title'] for row in texts)
            heading_place = contextual_locality(text,context,event['territory_id'],index.get('localities',[]))
            scope_id = heading_place['territoryId'] if heading_place else event['territory_id']
            locality=(heading_place or matching_locality(context,scope_id,index.get('localities',[]))
                or matching_locality(text,event['territory_id'],index.get('localities',[])))
            territory_place=None
            if not locality:
                from region_config import territories
                territory_place=next((p for p in territories(event['region_id']) if p.get('id')==event['territory_id']),None)
                scoped=[p for p in index.get('localities',[]) if p.get('territoryId')==event['territory_id']]
                if len(scoped)==1:
                    locality=scoped[0]
                elif territory_place:
                    center=re.sub(r'^(?:г|с|д|п|пгт)\s+','',territory_place.get('administrativeCenterName') or '',flags=re.I)
                    root=next((word[:6] for word in center.casefold().split() if len(word)>=5),'')
                    centered=[p for p in index.get('localities',[]) if event['territory_id'] in p.get('scopeIds',[]) and root and root in p.get('name','').casefold()]
                    if len(centered)==1 and root in text.casefold():
                        locality=centered[0]
            result = match_address_candidates(supported, scope_id, index,locality_id=locality['id'] if locality else None)
            # Several source-named streets are several map objects, not an
            # address collision. Homonyms still remain unlocated because every
            # street below must pass the strict one-candidate matcher.
            if result['status'] == 'ambiguous' and len(supported) > 1:
                street_objects = match_street_objects(supported, scope_id, index, locality_id=locality['id'] if locality else None)
                if street_objects.get('status') == 'matched':
                    result = street_objects
            if locality and result['status']=='matched':
                result['localityName']=locality['name'];result['localitySourceUrl']=locality['sourceUrl']
            result["unsupportedCandidates"] = unsupported
            if not supported:
                result.update({"status": "unmatched", "method": "address-candidate-not-supported-by-source",
                    "note": "Адресный фрагмент не найден в связанной публикации, поэтому он не используется для координат."})

            if index_path is None:
                object_candidates = [canonical_house_candidate(value, result) for value in supported]
                object_file=DATA_ROOT/config.get('objectIndex','data/public/objects-missing.json')
                if object_file.exists():
                    from object_geocoding import load_object_index,match_objects
                    object_result=match_objects(object_candidates,(context if data.get("site_group_key") else text),scope_id,load_object_index(str(object_file),object_file.stat().st_mtime_ns))
                    if object_result['status']=='matched' and not house_range:result=object_result
                from object_geocoding import split_address
                if (allow_network and not house_range and len(supported)==1 and split_address(supported[0]) and locality
                        and result.get('precision') not in {'building','site'}):
                    from langsearch_location import verify_source_address
                    verified=verify_source_address(object_candidates[0],locality['name'],'')
                    if verified:
                        result={'status':'matched','precision':verified['precision'],'candidateCount':1,
                            'objectId':verified['osmId'],'streetId':None,'streetName':verified['verifiedAddress'],
                            'representativeCoordinate':verified['coordinates'],'geometry':verified.get('geometry'),'bbox':None,
                            'sourceUrl':verified['osmUrl'],'sourceUrls':[verified['osmUrl']],
                            'checkedAt':iso_now(),'method':'source-address-osm-verified-object',
                            'note':'Адрес с номером дома присутствует в публикации и сопоставлен с единственным объектом OSM в указанном населённом пункте.'}
                        if verified.get('aliasEvidence'):
                            result['addressAliasEvidence']=verified['aliasEvidence']
                            result['sourceUrls'].append(verified['aliasEvidence']['url'])
                            result['method']='verified-corner-address-alias'
                            result['note']='Сокращённый номер из публикации подтверждён карточкой здания с двумя адресами и геометрией соседней улицы. Маркер находится внутри контура дома OSM.'
                from langsearch_location import facility_located_in
                if allow_network and result['status']!='matched' and not supported and locality and facility_located_in(text,event['title'],locality):
                    from langsearch_location import search_verified_object
                    from region_config import territories
                    territory=territory_place or next((p for p in territories(event['region_id']) if p.get('id')==event['territory_id']),None)
                    scope_name=re.sub(r'\b(?:муниципальный\s+)?район\b.*$','',
                        (territory or {}).get('name',''),flags=re.I).strip()
                    verified=search_verified_object(text,event['title'],locality['name'],scope_name)
                    if verified:
                        result={"status":"matched","precision":verified.get('precision','site'),"candidateCount":1,
                            "objectId":verified['osmId'],"streetId":None,"streetName":verified['address'],
                            "representativeCoordinate":verified['coordinates'],"geometry":verified.get('geometry'),"bbox":None,
                            "sourceUrl":verified['osmUrl'],"sourceUrls":[verified['osmUrl'],verified['url']],
                            "checkedAt":iso_now(),"method":"langsearch-address-osm-verified-object",
                            "searchSourceUrl":verified['url'],"searchQuery":verified['query'],
                            "note":"Название объекта взято из публикации, адрес найден через веб-поиск и независимо подтверждён единственным объектом OSM в названном населённом пункте."}
            if allow_network and index_path is None and result['status']!='matched' and (data.get('signalUsefulness') or {}).get('showOnMap') is True:
                adaptive,adaptive_scope=resolve_unmatched(connection,event,data,index)
                if adaptive:
                    result=adaptive;scope_id=adaptive_scope
            if result['status']=='matched' and result['precision']=='street':
                from junction_geocoding import source_junction
                junction = source_junction(context, text, lambda name: match_address_candidates(
                    [name], scope_id, index, locality_id=locality['id'] if locality else None))
                if junction:
                    result = {**result, **junction}
            if result['status']=='matched' and result['precision']=='street' and result.get('bbox'):
                from source_section_geocoding import source_section
                bbox=result['bbox']
                local_index={k:v for k,v in index.items() if k not in {'streets','_atlasLookup'}}
                local_index['streets']=[s for s in index['streets'] if (b:=s.get('bbox')) and b[0]<=bbox[2] and b[2]>=bbox[0] and b[1]<=bbox[3] and b[3]>=bbox[1]]
                section=source_section(result,result.get('addressCandidate') or result['streetName'],(context if data.get('site_group_key') else text),
                    lambda name:match_address_candidates([name],scope_id,local_index))
                if section and section['status']=='matched':
                    parking=bool(re.search(r'парковк',section['sourceQuote'],re.I))
                    result.update({k:section[k] for k in ('geometry','representativeCoordinate','bbox')})
                    result['sourceSection']={k:v for k,v in section.items() if k not in {'geometry','representativeCoordinate','bbox'}}
                    result['sourceSection']['scopeKind']='parking-frontage' if parking else 'street-section'
                    result['sourceUrls']=list(dict.fromkeys(result['sourceUrls']+section['from']['sourceUrls']+section['to']['sourceUrls']))
                    result['method']='source-section-intersections'
                    result['note']='Показан участок между названными в публикации пересечениями улиц по геометрии OSM. '+('Полигон парковки и её сторона дороги не установлены; точность остаётся street.' if parking else 'Опорная точка находится в середине подтверждённого источником уличного коридора; отдельный дом не назначается.')
                elif section:
                    result['sectionAttempt']=section
                    result['note']+=' Границы указанного в источнике участка не удалось однозначно сопоставить; вся улица не считается подтверждённым охватом события.'
            result=constrain_precision(result,context if data.get('site_group_key') else text)
            merged_into=merge_duplicate_source_site(connection,event,data,result)
            if merged_into:
                _finish_job(connection,job,{**result,'mergedIntoEventId':merged_into})
                totals['processed']+=1;totals['matched']+=1
                continue
            if result['status']!='matched' and locality and not supported and source_locates_in_place(context,locality):
                result={**result,'status':'matched','precision':'settlement','candidateCount':1,'streetId':None,
                    'streetName':locality['name'],'representativeCoordinate':locality['coordinates'],'bbox':None,'geometry':None,
                    'sourceUrl':locality['sourceUrl'],'sourceUrls':[locality['sourceUrl']],'checkedAt':index.get('localityIndexCheckedAt'),
                    'method':'source-named-settlement-and-municipal-scope','note':'В публикации прямо назван населённый пункт. Показана его опорная точка OSM; конкретная улица, здание и место работ не установлены.'}
            # Re-enrichment cannot erase a source-supported exact object merely
            # because a provider/index temporarily returns less precise data.
            rank = {'territory': 0, 'settlement': 1, 'street': 2, 'site': 3, 'building': 3}
            if event['precision']=='building' and rank.get(result.get('precision'),0)<3 and not contact_rejected:
                previous=data.get('locationEvidence') or {}
                if previous.get('sourceQuote') and previous['sourceQuote'] in text:
                    constrained=constrain_precision(previous,context if data.get('site_group_key') else text)
                    if constrained.get('precision')=='site':result=constrained
            if (scope_id == event['territory_id'] and event['address'] and event['longitude'] is not None
                    and not contact_rejected and not house_range and not ((data.get('locationEvidence') or {}).get('sourceQuote') and (data['locationEvidence']['sourceQuote'] not in text))
                    and rank.get(event['precision'], 0) >= 3
                    and rank.get(result.get('precision'), 0) < rank[event['precision']]):
                _finish_job(connection, job, {'status':'preserved','method':'verified-object-retained','attempt':result})
                totals['processed'] += 1; totals['preserved'] += 1
                continue
            if heading_place:
                result['localityName'] = heading_place['name']
                result['scopeMethod'] = 'nearest-explicit-source-heading'
                result['previousTerritoryId'] = event['territory_id']
            result=constrain_precision(result,context if data.get('site_group_key') else text)
            if (data.get('locationResolution') or {}).get('status')=='verified' and result.get('status')=='matched':
                data['locationResolution']['precision']=result['precision']
            if house_range:
                result['houseRange']=house_range.group().lstrip(', ')
                result['note']+=' Источник указывает диапазон домов; отдельный дом не назначается вместо всего диапазона.'
            if supported and not house_range and any(split_address(c) for c in supported) and result.get('precision') not in {'building','site'}:
                data['locationRefinement']={'status':'unverified' if allow_network else 'pending','requestedAddresses':supported,'checkedAt':iso_now(),'version':GEOCODER_VERSION}
            else:data.pop('locationRefinement',None)
            data["locationEvidence"] = result
            data["locationVerificationMethod"] = result["method"]
            data["geographyNote"] = result["note"]
            if result.get('sourceSection'):
                quote=result['sourceSection']['sourceQuote']
                data['facts']=list(dict.fromkeys([*(data.get('facts') or []),quote]))[:4]
            address, longitude, latitude, precision, confidence = event["address"], None, None, "territory", "unknown"
            if result['status']!='matched':
                address=None
                for key in ('coordinateSourceUrl','siteGeometry','siteBbox','siteZoom','streetGeometryRef'):data.pop(key,None)
            if result["status"] == "matched":
                longitude, latitude = result["representativeCoordinate"]
                precision = confidence = result['precision']
                address = result["streetName"]
                data["coordinateSourceUrl"] = result["sourceUrl"]
                data["addressSourceUrl"] = result.get('searchSourceUrl') or data.get("sourceUrl")
                data["siteGeometry"] = result.get("geometry")
                data["siteBbox"] = result.get("bbox")
                data["siteZoom"] = 17.5 if precision=='building' else 15
                data["streetGeometryRef"] = {"streetId": result.get("streetId"), "bbox": result.get("bbox"),
                    "sourceUrls": result["sourceUrls"], "indexCheckedAt": result["checkedAt"]}
                if result.get("streetObjects"):
                    data["streetGeometryRefs"] = result["streetObjects"]

            now = iso_now()
            connection.execute("BEGIN IMMEDIATE")
            try:
                if result.get('sourceSection'):
                    quote=result['sourceSection']['sourceQuote']
                    document=next((d for d in texts if quote in (d['title']+'\n'+(d['body'] or ''))),None)
                    if document:
                        evidence_id=_stable_id('evd_section_',event['id']+'|'+document['id']+'|'+quote)
                        connection.execute('INSERT OR IGNORE INTO event_evidence(id,event_id,document_id,source_id,label,url,published_at,observed_at,event_time,quote,source_kind,supports) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                            (evidence_id,event['id'],document['id'],document['source_id'],data.get('sourceName','Границы участка из публикации'),document['canonical_url'],document['published_at'],now,event['event_time'],quote,event['source_kind'],'location'))
                revision = connection.execute("INSERT INTO revisions(event_id,operation,created_at,notify_eligible) VALUES(?,?,?,?)",
                    (event["id"], "upsert", now, event["notify_eligible"] if local_first else 0)).lastrowid
                connection.execute(
                    "UPDATE events SET territory_id=?,address=?,longitude=?,latitude=?,precision=?,location_confidence=?,data_json=?,notify_eligible=?,revision=?,updated_at=? WHERE id=?",
                    (scope_id, address, longitude, latitude, precision, confidence, _json(data), event["notify_eligible"] if local_first else 0, revision, now, event["id"]),
                )
                _finish_job(connection, job, result)
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            totals["processed"] += 1
            totals[result["status"] if result["status"] in {"matched", "ambiguous", "unmatched"} else "unmatched"] += 1
        except SearchDeferred as exc:
            run_after = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).replace(microsecond=0).isoformat().replace('+00:00','Z')
            connection.execute("UPDATE jobs SET status='queued',attempts=MAX(0,attempts-1),run_after=?,started_at=NULL,error=? WHERE id=?",
                (run_after,str(exc),job['id']))
        except Exception as exc:
            _retry_job(connection, job, exc)
            totals["failed"] += 1
    if local_first:
        for job_id in completed_local:
            row=connection.execute("SELECT j.*,e.precision,e.data_json,e.deleted FROM jobs j JOIN events e ON e.id=json_extract(j.payload_json,'$.eventId') WHERE j.id=?",(job_id,)).fetchone()
            if row and row['status']=='complete' and not row['deleted']:
                payload=json.loads(row['payload_json']);result=payload.get('result') or {}
                useful=(json.loads(row['data_json']).get('signalUsefulness') or {}).get('showOnMap') is True
                if useful and row['precision'] not in {'building','site'} and result.get('status') not in {'preserved','superseded'}:
                    connection.execute("UPDATE jobs SET status='queued',priority=50,run_after=?,finished_at=NULL,started_at=NULL,attempts=0 WHERE id=?",(iso_now(),job_id))
    return totals


def geocode_fresh_events(connection, *, document_id=None, limit=200, source_ready=False):
    """Publish locally known geometry without waiting for any external provider."""
    if source_ready and document_id:
        connection.execute("UPDATE jobs SET run_after=?,payload_json=json_remove(payload_json,'$.localPassAt') WHERE kind='geocode' AND status='queued' AND error='Full source article pending before location analysis' AND EXISTS(SELECT 1 FROM event_documents ed WHERE ed.event_id=json_extract(jobs.payload_json,'$.eventId') AND ed.document_id=?)",(iso_now(),document_id))
    condition=" AND EXISTS(SELECT 1 FROM event_documents ed WHERE ed.event_id=json_extract(j.payload_json,'$.eventId') AND ed.document_id=?)" if document_id else ""
    rows=connection.execute("SELECT DISTINCT json_extract(j.payload_json,'$.eventId') event_id FROM jobs j WHERE j.kind='geocode' AND j.status='queued' AND j.run_after<=? AND json_extract(j.payload_json,'$.localPassAt') IS NULL"+condition+" ORDER BY j.priority DESC,j.rowid DESC LIMIT ?",(iso_now(),*([document_id] if document_id else []),limit)).fetchall()
    return consume_geocode_jobs(connection,event_ids=[row['event_id'] for row in rows],limit=len(rows),allow_network=False,local_first=True)
