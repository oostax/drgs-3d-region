"""Verify abbreviated corner numbers using an independent building directory.

A slash alone never establishes an alias (complexes and units also use it).
Require a unique scoped OSM candidate, a two-street building card, and the
second street next to the footprint. Coordinates always come from OSM.
"""
import json
import math
import re
import fcntl
from datetime import datetime, timezone
from urllib.parse import urlparse
from geocoding import normalize_street, load_street_index, match_address_candidates
from object_geocoding import split_address, house_key, hydrate_object, load_object_index
from region_config import region_config, localities, fold
from runtime_paths import DATA_ROOT


def corner_candidates(address, scope, index):
    parts = split_address(address)
    if not parts or not re.fullmatch(r'\d+[а-я]?', parts[2]):
        return []
    name, kind, house = parts
    return [obj for obj in index['objects']
            if scope in obj.get('scopeIds', []) and obj.get('precision') == 'building'
            and re.fullmatch(re.escape(house) + r'/\d+[а-я]?', house_key(obj.get('house', '')))
            and normalize_street(obj.get('street', ''))[0] == name
            and (not kind or normalize_street(obj.get('street', ''))[1] in (None, '', kind))]


def directory_pair(item, address, compound_house, locality):
    url = urlparse(item.get('url', ''))
    if url.scheme != 'https' or url.hostname != '2gis.ru' or not re.fullmatch(r'/[^/]+/geo/\d+/?', url.path):
        return None
    # Parse the card title, never arbitrary addresses elsewhere in the snippet.
    title = item.get('name', '')
    pair = re.match(r'^(.+?,\s*\d+[а-яa-z]?)\s*/\s*(.+?,\s*\d+[а-яa-z]?)(?=\s|$)', title, re.I)
    if not pair or ' ' + fold(locality) + ' ' not in ' ' + fold(item.get('snippet', '') + ' ' + item.get('summary', '')) + ' ':
        return None
    if re.match(r'\s*(?:к|корп(?:ус)?|стр(?:оение)?)\.?\s*\d', title[pair.end():], re.I):
        return None
    first, second = split_address(pair[1]), split_address(pair[2])
    wanted = split_address(address)
    if not first or not second or not wanted or first[0] != wanted[0] or first[2] != wanted[2]:
        return None
    if first[1] and wanted[1] and first[1] != wanted[1]:
        return None
    if second[0] == first[0] or first[2] + '/' + second[2] != house_key(compound_house):
        return None
    return pair[2], pair[0]


def next_to_street(point, geometry, maximum=60):
    lines = [geometry['coordinates']] if geometry.get('type') == 'LineString' else geometry.get('coordinates', []) if geometry.get('type') == 'MultiLineString' else []
    scale = 111320 * math.cos(math.radians(point[1]))
    for line in lines:
        for a, b in zip(line, line[1:]):
            ax, ay = (a[0]-point[0])*scale, (a[1]-point[1])*111320
            bx, by = (b[0]-point[0])*scale, (b[1]-point[1])*111320
            dx, dy = bx-ax, by-ay
            t = max(0, min(1, -(ax*dx+ay*dy)/(dx*dx+dy*dy))) if dx*dx+dy*dy else 0
            if math.hypot(ax+t*dx, ay+t*dy) <= maximum:
                return True
    return False


def remember_alias(obj, address, evidence):
    path = DATA_ROOT/'data/public/verified-address-objects.json'
    lock = DATA_ROOT/'data/live/address-aliases.lock'
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        raw = json.loads(path.read_text()) if path.exists() else {'schemaVersion': 1, 'regionId': 'RU-TA', 'partial': True, 'objects': []}
        objects = {item['id']: item for item in raw['objects']}
        previous = objects.get(obj['id'], obj)
        merged = {**previous, **obj, 'aliases': sorted(set(previous.get('aliases', []) + obj.get('aliases', []))), 'addressAliases': sorted(set(previous.get('addressAliases', []) + [address]))}
        merged['addressAliasEvidence'] = {**previous.get('addressAliasEvidence', {}), address: evidence}
        objects[obj['id']] = merged
        raw['objects'] = list(objects.values())
        raw['checkedAt'] = datetime.now(timezone.utc).isoformat()
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(raw, ensure_ascii=False, separators=(',', ':')))
        temp.replace(path)


def verify_corner_address(address, locality, search):
    places = [p for p in localities('RU-TA') if fold(p['name']) == fold(locality)]
    if len(places) != 1:
        return None
    place = places[0]
    config = region_config('RU-TA')
    path = DATA_ROOT/config['objectIndex']
    index = load_object_index(str(path), path.stat().st_mtime_ns)
    candidates = corner_candidates(address, place['territoryId'], index)
    if len(candidates) != 1:
        return None
    obj = candidates[0]
    query = f'{locality} {address} site:2gis.ru/ geo'
    raw = search(query)
    results = (((raw.get('data') or {}).get('webPages') or {}).get('value') or [])
    street_index = load_street_index(DATA_ROOT/config['streetIndex'])
    proofs = []
    for item in results:
        pair = directory_pair(item, address, obj['house'], locality)
        if not pair:
            continue
        secondary = match_address_candidates([pair[0].rsplit(',', 1)[0]], place['territoryId'], street_index, locality_id=place['id'])
        if secondary.get('status') != 'matched' or not next_to_street(obj['coordinates'], secondary.get('geometry') or {}):
            continue
        proofs.append({'url': item['url'], 'quote': pair[1], 'osmUrl': obj['sourceUrl'], 'query': query,
                       'method': 'independent-corner-address-and-adjacent-street', 'checkedAt': datetime.now(timezone.utc).isoformat()})
    if not proofs:
        return None
    obj = hydrate_object(obj)
    remember_alias(obj, address, proofs[0])
    return {'coordinates': obj['coordinates'], 'geometry': obj['geometry'], 'osmUrl': obj['sourceUrl'],
            'osmId': obj['id'], 'displayName': obj['address'], 'verifiedAddress': obj['address'],
            'precision': 'building', 'aliasEvidence': proofs[0]}
