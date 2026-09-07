"""Search-assisted location recovery with independent OSM verification.

Search snippets are untrusted hints. They may supply an address candidate, but
coordinates are accepted only from a unique Nominatim/OSM result in the named
settlement and configured municipal scope.
"""
from __future__ import annotations

import json
import os
import re
import ssl
import time
import hashlib
import fcntl
import math
from pathlib import Path
import urllib.parse
import urllib.request
import urllib.error
from typing import Any

from region_config import fold, mentioned_locality, contextual_locality
from runtime_paths import DATA_ROOT

_calls = 0
_cache: dict[str, dict[str, Any]] = {}
_key_cooldowns: dict[str, float] = {}

class SearchDeferred(Exception):
    """Budget is temporary, not an unsuccessful geocoding result."""

def reset_search_budget():
    global _calls
    _calls = 0
NUMBERED_FACILITY = re.compile(
    r"\b((?:гимнази|школ|лице|детск(?:ий|ого)\s+сад|больниц|поликлиник)\w*"
    r"\s*(?:№|N)\s*\d+[А-Яа-яA-Za-z]?)\b", re.I,
)
QUOTED_FACILITY = re.compile(
    r"\b((?:гимнази|школ|лице|детск(?:ий|ого)\s+сад|больниц|поликлиник|"
    r"дом\s+культур|спорт(?:ивн\w*)?\s+(?:комплекс|центр)|стадион)\w*"
    r"\s*[«\"]([^»\"]{2,80})[»\"])", re.I,
)
ADDRESS = re.compile(
    r"((?:ул(?:ица)?\.?|проспект|пр-т|переулок|пер\.?|шоссе|тракт)\s+"
    r"[А-ЯЁа-яёA-Za-z0-9 .'-]{2,70}?,?\s+(?:д(?:ом)?\.?\s*)?\d+[А-Яа-яA-Za-z]?(?:[/\-]\d+)?)",
    re.I,
)


def named_facility(text: str) -> str | None:
    values = {}
    for pattern in (NUMBERED_FACILITY, QUOTED_FACILITY):
        for match in pattern.finditer(text):
            value = " ".join(match.group(1).split()).strip(" ,.;:-")
            kind = next((k for k in ('гимнази','школ','лице','сад','больниц','поликлиник','стадион','комплекс','центр','культур') if k in fold(value)), '')
            number = re.search(r'(?:№|n)\s*(\d+[а-яa-z]?)', value, re.I)
            quoted = re.search(r'[«"]([^»"]+)[»"]', value)
            identity = (kind, number.group(1) if number else fold(quoted.group(1)) if quoted else fold(value))
            values[identity] = value
    return next(iter(values.values())) if len(values) == 1 else None

def facility_matches(text: str, facility: str) -> bool:
    """Kind AND identifying number/name must agree, never a generic word."""
    value = fold(text)
    kind = next((k for k in ('гимнази','школ','лице','сад','больниц','поликлиник','стадион','комплекс','центр','культур') if k in fold(facility)), None)
    if not kind:
        quoted=re.search(r'[«"]([^»"]+)[»"]',facility)
        if quoted:return ' '+fold(quoted.group(1))+' ' in ' '+value+' '
        return len(fold(facility).split())>=2 and ' '+fold(facility)+' ' in ' '+value+' '
    if not any(token.startswith(kind) for token in value.split()):
        return False
    number = re.search(r'(?:№|n)\s*(\d+[а-яa-z]?)', facility, re.I)
    if number:
        # Require an institution number, not the same number in a street address.
        return bool(re.search(r'(?:№|\bn)\s*'+re.escape(number.group(1))+r'(?![\w])', text, re.I))
    quoted = re.search(r'[«"]([^»"]+)[»"]', facility)
    return bool(quoted and ' '+fold(quoted.group(1))+' ' in ' '+value+' ')

def facility_located_in(text: str, title: str, locality: dict[str, Any]) -> bool:
    facility = named_facility(text)
    if not facility:
        return False
    for sentence in [title, *re.split(r'\n|(?<=[.!?])\s+',text)]:
        if not facility_matches(sentence,facility):
            continue
        if re.search(r'возили|возят|уехал|переехал|посет.{0,50}(?:Лисичан|Рубежн)',sentence,re.I):
            continue
        if mentioned_locality(' '+fold(sentence)+' ',locality['name'],[]):
            return True
    # Publication scope alone is not evidence that the school is in that city.
    return False


def _request(url: str, *, payload: dict[str, Any] | None = None, api_key: str | None = None) -> Any:
    # Cache across daemon restarts; lock also limits concurrent local processes.
    directory = DATA_ROOT / 'data/live/location-http-cache'
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256((url + json.dumps(payload, sort_keys=True)).encode()).hexdigest()
    cached = directory / (digest + '.json')
    with (directory / 'requests.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if cached.exists() and time.time() - cached.stat().st_mtime < 7 * 86400:
            return json.loads(cached.read_text())
        if urllib.parse.urlparse(url).hostname == 'nominatim.openstreetmap.org':
            stamp = directory / 'nominatim-last-request'
            delay = 15.1 - (time.time() - float(stamp.read_text())) if stamp.exists() else 0
            if delay > 0:
                time.sleep(delay)
            stamp.write_text(str(time.time()))
        elif urllib.parse.urlparse(url).hostname == 'api.openstreetmap.org':
            stamp = directory / 'osm-data-last-request'
            delay = 2.0 - (time.time() - float(stamp.read_text())) if stamp.exists() else 0
            if delay > 0: time.sleep(delay)
            stamp.write_text(str(time.time()))
        elif payload is not None:
            stamp = directory / 'langsearch-last-request'
            delay = 1.1 - (time.time() - float(stamp.read_text())) if stamp.exists() else 0
            if delay > 0:
                time.sleep(delay)
            stamp.write_text(str(time.time()))
        try:
            result = _uncached_request(url, payload=payload, api_key=api_key)
        except urllib.error.HTTPError as error:
            # Nominatim rejects malformed/unsupported structured queries with
            # 400. That is a no-match for this provider, not a broken job:
            # callers can continue with the bounded map fallback and retry
            # through LangSearch on the next pass.
            if payload is None and error.code == 400 and urllib.parse.urlparse(url).hostname == 'nominatim.openstreetmap.org':
                return []
            if payload is None and error.code in {429,502,503,504}:
                raise SearchDeferred('Geocoding provider temporarily unavailable') from None
            raise
        except (urllib.error.URLError, TimeoutError):
            raise SearchDeferred('Location provider network unavailable') from None
        if payload is None or (isinstance(result, dict) and result.get('code') == 200):
            temporary = cached.with_suffix('.tmp')
            temporary.write_text(json.dumps(result, ensure_ascii=False))
            temporary.replace(cached)
        return result

def _uncached_request(url: str, *, payload: dict[str, Any] | None = None, api_key: str | None = None) -> Any:
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    headers = {"Accept": "application/json", "User-Agent": "SberAtlas/1.0"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    try:
        import certifi
        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=20, context=context) as response:
        return json.load(response)


def _address_candidates(results: list[dict[str, Any]], facility: str, locality: str) -> list[dict[str, str]]:
    locality_folded = fold(locality)
    found: list[dict[str, str]] = []
    for item in results:
        haystack = " ".join(str(item.get(key) or "") for key in ("name", "snippet", "summary"))
        haystack = re.sub(r"\b(ул|пер|просп|д)\s+\.", r"\1.", haystack, flags=re.I)
        folded = fold(haystack)
        if ' '+locality_folded+' ' not in ' '+folded+' ' or not facility_matches(haystack, facility):
            continue
        for match in ADDRESS.finditer(haystack):
            candidate = " ".join(match.group(1).split()).strip(" ,.;:-")
            candidate = re.sub(r"\s*,\s*", ", ", candidate)
            record = {"address": candidate, "url": str(item.get("url") or "")}
            if record not in found:
                found.append(record)
    return found[:5]


def _osm_match(address: str, locality: str, expected_scope: str, facility: str = "") -> dict[str, Any] | None:
    endpoint = os.getenv('ATLAS_NOMINATIM_URL', 'https://nominatim.openstreetmap.org').rstrip('/')
    from object_geocoding import split_address, house_key
    address_parts = split_address(address) if address else None
    if address:
        # Most regional addresses are already in the local OSM extract.
        from region_config import localities, region_config
        from object_geocoding import load_object_index, match_objects
        places = [p for p in localities('RU-TA') if fold(p['name']) == fold(locality)]
        object_file = DATA_ROOT / region_config('RU-TA')['objectIndex']
        if len(places) == 1 and object_file.exists():
            local = match_objects([address], '', places[0]['territoryId'],
                load_object_index(str(object_file), object_file.stat().st_mtime_ns))
            if local['status'] == 'matched':
                return {'coordinates':local['representativeCoordinate'],'geometry':local['geometry'],
                    'osmUrl':local['sourceUrl'],'displayName':local['streetName'],
                    'verifiedAddress':local['streetName'],'precision':local['precision'],'osmId':local['objectId'], 'aliasEvidence':local.get('addressAliasEvidence')}
    if address_parts and not facility:
        from corner_addresses import verify_corner_address
        corner = verify_corner_address(address, locality, _search)
        if corner:
            return corner
    direct_facility_search = False
    requested_house = re.search(r"\b(\d+[А-Яа-яA-Za-z]?(?:[/\-]\d+)?)\s*$", address)
    def exact_house(rows: Any) -> list[dict[str, Any]]:
        if not requested_house or not isinstance(rows,list):
            return rows if isinstance(rows,list) else []
        wanted=address_parts[2] if address_parts else house_key(requested_house.group(1))
        return [row for row in rows if house_key(str((row.get('address') or {}).get('house_number') or ''))==wanted]
    rows = []
    if address:
        params = urllib.parse.urlencode({
            "q": f"{address}, {locality}, Татарстан, Россия", "format": "jsonv2",
            "limit": 5, "addressdetails": 1, "polygon_geojson": 1, "countrycodes": "ru",
        })
        rows = exact_house(_request(endpoint + "/search?" + params))
    if not rows:
        house = requested_house
        street = address[:house.start()].strip(" ,") if house else ""
        if house and street:
            structured = urllib.parse.urlencode({
                "street": f"{house.group(1)} {street}", "city": locality, "state": "Татарстан",
                "format": "jsonv2", "limit": 5, "addressdetails": 1,
                "polygon_geojson": 1, "countrycodes": "ru",
            })
            rows = exact_house(_request(endpoint + "/search?" + structured))
    if not rows and facility:
        direct_facility_search = True
        facility_query = urllib.parse.urlencode({
            "q": f"{facility}, {locality}, Татарстан, Россия", "format": "jsonv2",
            "limit": 5, "addressdetails": 1, "polygon_geojson": 1, "countrycodes": "ru",
        })
        rows = _request(endpoint + "/search?" + facility_query)
    locality_folded, scope_folded = fold(locality), fold(expected_scope)
    valid = []
    for row in rows if isinstance(rows, list) else []:
        details = row.get("address") or {}
        scope_text = fold(" ".join(str(v) for v in details.values()))
        if ' '+locality_folded+' ' not in ' '+scope_text+' ':
            continue
        if requested_house and not direct_facility_search:
            from geocoding import normalize_street
            from object_geocoding import split_address
            parts = split_address(address)
            wanted_street = parts[0] if parts else normalize_street(address[:requested_house.start()].strip(' ,'))[0]
            actual_street = normalize_street(str(details.get('road') or details.get('pedestrian') or ''))[0]
            if wanted_street != actual_street:
                continue
        # Settlement territory labels differ between registries, e.g.
        # «городское поселение город Лаишево» vs «городское поселение Лаишево».
        # The explicitly named settlement already supplies the strict scope in
        # that case; require the extra municipal token only for a different scope.
        if scope_folded and locality_folded not in scope_folded and scope_folded not in scope_text:
            continue
        if direct_facility_search:
            result_name = str(row.get('name') or '')+' '+str(details.get('amenity') or '')
            if not facility_matches(result_name, facility):
                continue
        if row.get('addresstype') in {'country','state','county','city','town','village','road','suburb'}:
            continue
        try:
            coordinates = [float(row["lon"]), float(row["lat"])]
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(v) for v in coordinates) or abs(coordinates[0])>180 or abs(coordinates[1])>85:
            continue
        valid.append((row, coordinates))
    identities = {(row.get("osm_type"), row.get("osm_id")) for row, _ in valid}
    if len(identities) != 1:
        if address_parts and not facility and not identities:
            from osm_address_fallback import source_house_from_osm_map
            return source_house_from_osm_map(address,locality,_request)
        return None
    row, coordinates = valid[0]
    details = row.get("address") or {}
    road = details.get("road") or details.get("pedestrian") or details.get("square")
    house = details.get("house_number")
    verified_address = ", ".join(str(value) for value in (road, house) if value) or details.get("amenity") or row.get("display_name")
    osm_type = {"node": "node", "way": "way", "relation": "relation"}.get(row.get("osm_type"))
    if not osm_type:
        return None
    geometry = row.get("geojson")
    precision = "building" if row.get('category') == 'building' and geometry and geometry.get("type") in {"Polygon","MultiPolygon"} else "site"
    if precision == 'building':
        from object_geocoding import polygon_anchor
        polygon = geometry['coordinates'] if geometry['type']=='Polygon' else max(geometry['coordinates'],key=lambda p:len(p[0]))
        coordinates = polygon_anchor(polygon[0],polygon[1:])
    return {
        "coordinates": coordinates, "geometry": geometry,
        "osmUrl": f"https://www.openstreetmap.org/{osm_type}/{row['osm_id']}",
        "displayName": row.get("display_name"), "verifiedAddress": verified_address, "precision": precision,
        "osmId": f"{osm_type}/{row['osm_id']}",
    }

def verify_source_address(address: str, locality: str, expected_scope: str):
    """An explicit source house address can bypass web search entirely."""
    global _calls
    limit = max(0,min(20,int(os.getenv('ATLAS_LANGSEARCH_MAX_PER_RUN','3'))))
    if _calls >= limit:
        raise SearchDeferred('Location lookup batch budget exhausted')
    _calls += 1
    result = _osm_match(address,locality,expected_scope)
    if result:
        remember_verified_address(address, locality, result)
    return result


def remember_verified_address(address, locality, result):
    """Reuse geometries confirmed online for the next source ingestion."""
    if result.get('precision') != 'building' or (result.get('geometry') or {}).get('type') != 'Polygon':
        return
    match = re.fullmatch(r'https://www.openstreetmap.org/way/(\d+)', result.get('osmUrl', ''))
    from region_config import localities
    from object_geocoding import split_address
    places = [p for p in localities('RU-TA') if fold(p['name']) == fold(locality)]
    canonical = result.get('verifiedAddress') or ''
    parts = split_address(canonical)
    if not match or len(places) != 1 or not parts:
        return
    place = places[0]
    obj = {'id': 'osm-way-'+match[1], 'osmId': int(match[1]), 'territoryId': place['territoryId'],
           'scopeIds': list(dict.fromkeys([place['territoryId'], *place.get('scopeIds', []), 'RU-TA'])),
           'name': canonical, 'address': canonical, 'street': canonical.rsplit(',', 1)[0], 'house': parts[2],
           'aliases': [], 'precision': 'building', 'coordinates': result['coordinates'],
           'geometry': result['geometry'], 'sourceUrl': result['osmUrl']}
    from corner_addresses import remember_alias
    evidence = result.get('aliasEvidence') or {'url': result['osmUrl'], 'quote': canonical, 'method': 'exact-source-address-osm-verification'}
    remember_alias(obj, address, evidence)


def _search(query: str) -> dict[str, Any]:
    keys = list(dict.fromkeys(k.strip() for k in
        (os.getenv('ATLAS_LANGSEARCH_API_KEY', '')+','+os.getenv('ATLAS_LANGSEARCH_API_KEYS', '')).split(',') if k.strip()))
    base_url = os.getenv('ATLAS_LANGSEARCH_URL', 'https://api.langsearch.com/v1').rstrip('/')
    for key in keys:
        if _key_cooldowns.get(key, 0) > time.time():
            continue
        try:
            raw = _request(base_url + '/web-search', payload={
                'query': query, 'freshness': 'noLimit', 'summary': True, 'count': 5,
            }, api_key=key)
            code = raw.get('code')
        except urllib.error.HTTPError as error:
            code = error.code
            if code not in {401, 402, 403, 429}:
                raise
        if code == 200:
            return raw
        if code in {401, 402, 403, 429}:
            _key_cooldowns[key] = time.time() + (300 if code == 429 else 3600)
            continue
        raise RuntimeError('LangSearch response code: ' + str(code))
    raise SearchDeferred('LangSearch credentials unavailable or quota limited; retry later')

def search_verified_object(text: str, title: str, locality: str, expected_scope: str) -> dict[str, Any] | None:
    """Return one OSM-verified building candidate, or None without guessing."""
    global _calls
    api_key = os.getenv("ATLAS_LANGSEARCH_API_KEY", "").strip() or os.getenv('ATLAS_LANGSEARCH_API_KEYS', '').strip()
    limit = max(0, min(20, int(os.getenv("ATLAS_LANGSEARCH_MAX_PER_RUN", "3"))))
    facility = named_facility(text)
    # A directory's existing campus cannot establish where a NEW building is.
    if re.search(r'нов(?:ый|ого|ом|ое)\s+(?:корпус|здани)|переехал|строительств.{0,35}(?:школ|сад|больниц)', text, re.I):
        return None
    if not facility or not locality:
        return None
    if not api_key or limit == 0:
        raise SearchDeferred('LangSearch disabled for this batch; candidate retained')
    query = " ".join(f"{locality} {facility} адрес".split())[:300]
    if query in _cache:
        return _cache[query] or None
    if _calls >= limit:
        raise SearchDeferred('LangSearch batch budget exhausted')
    _calls += 1
    raw = _search(query)
    results = (((raw.get("data") or {}).get("webPages") or {}).get("value") or [])
    matches = []
    candidates = _address_candidates(results, facility, locality)
    for candidate in candidates:
        osm = _osm_match(candidate["address"], locality, expected_scope, facility)
        if osm:
            matches.append({**candidate, **osm})
    if not matches:
        osm = _osm_match("", locality, expected_scope, facility)
        relevant_url = next((str(item.get('url') or '') for item in results
            if fold(locality) in fold(str(item.get('name') or '')+' '+str(item.get('snippet') or ''))
            and facility_matches(str(item.get('name') or '')+' '+str(item.get('snippet') or ''),facility)), '')
        if osm and relevant_url:
            matches.append({"address": osm.get("verifiedAddress") or facility, "url": relevant_url, **osm})
    unique = {match["osmId"]: match for match in matches}
    if len(unique) != 1:
        _cache[query] = {}
        return None
    match = next(iter(unique.values()))
    result = {**match, "facility": facility, "query": query}
    _cache[query] = result
    return result
