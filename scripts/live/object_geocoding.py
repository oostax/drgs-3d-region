"""Local, source-supported address/object matching. Never choose the nearest house."""
from __future__ import annotations
import json,re,unicodedata
from pathlib import Path
from functools import lru_cache
from geocoding import normalize_street,_fold
from runtime_paths import DATA_ROOT
from connectors import BoundedFetcher

def polygon_anchor(ring, holes=()):
    # Midpoints between vertex latitudes avoid touching an ambiguous edge. The
    # widest interior interval supplies a point inside concave buildings too.
    rings=[ring,*holes]
    ys=sorted(set(p[1] for r in rings for p in r));best=None
    for lo,hi in zip(ys,ys[1:]):
        y=(lo+hi)/2;xs=sorted(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]) for r in rings for a,b in zip(r,r[1:]) if (a[1]>y)!=(b[1]>y))
        for x1,x2 in zip(xs[::2],xs[1::2]):
            if best is None or x2-x1>best[0]:best=(x2-x1,[(x1+x2)/2,y])
    if best is None:raise ValueError('No interior point in object geometry')
    return best[1]

def hydrate_object(obj):
    if obj.get('geometry'):return obj
    osm_id=int(obj['osmId']);cache=DATA_ROOT/f'data/public/object-geometries/osm-way-{osm_id}.json'
    if cache.exists():geometry=json.loads(cache.read_text())
    else:
        response=BoundedFetcher(timeout=15,max_bytes=1_000_000).get(f'https://api.openstreetmap.org/api/0.6/way/{osm_id}/full.json')
        raw=json.loads(response.body);nodes={p['id']:[p['lon'],p['lat']] for p in raw['elements'] if p['type']=='node'}
        way=next(p for p in raw['elements'] if p['type']=='way' and p['id']==osm_id)
        ring=[nodes[id] for id in way['nodes']]
        if len(ring)<4 or ring[0]!=ring[-1]:raise ValueError('Object has no closed footprint')
        geometry={'type':'Polygon','coordinates':[ring]};cache.parent.mkdir(parents=True,exist_ok=True);cache.write_text(json.dumps(geometry))
    ring=geometry['coordinates'][0]
    return {**obj,'geometry':geometry,'coordinates':polygon_anchor(ring,geometry['coordinates'][1:]),'bbox':[min(p[0] for p in ring),min(p[1] for p in ring),max(p[0] for p in ring),max(p[1] for p in ring)]}

def house_key(value):
    value=unicodedata.normalize('NFKC',value).casefold()
    value=re.sub(r'корп(?:ус)?\.?','к',value)
    value=re.sub(r'строение|стр\.?','с',value)
    return re.sub(r'\s|\.', '',value).translate(str.maketrans('abcekmhop','авсекмнор'))

def split_address(value):
    match=re.search(r'(?:,\s*(?:д(?:ом)?\.?\s*)?|\s+д(?:ом)?\.?\s+|\s+)(\d+[а-яa-z]?(?:[/\-]\d+[а-яa-z]?)?(?:\s*(?:к|корп(?:ус)?|стр(?:оение)?)\.?\s*\d+[а-яa-z]?)?)\s*[.;]?$' ,value,re.I)
    if not match:return None
    # Source district prefixes are context, not part of the street name.
    street=value[:match.start()].split(',')[-1].strip()
    street=re.sub(r'^(?:на|по)\s+','',street,flags=re.I)
    name,kind=normalize_street(street)
    return name,kind,house_key(match.group(1))

def load_object_index(path:str,revision:int):
    supplement=DATA_ROOT/'data/public/verified-address-objects.json'
    return _load_object_index(path,revision,str(supplement),supplement.stat().st_mtime_ns if supplement.exists() else 0)

@lru_cache(maxsize=4)
def _load_object_index(path:str,revision:int,supplement:str,supplement_revision:int):
    raw=json.loads(Path(path).read_text())
    if supplement_revision and raw.get('regionId')=='RU-TA':
        extra=json.loads(Path(supplement).read_text())
        if extra.get('schemaVersion')==1:
            combined={obj['id']:obj for obj in raw['objects']}
            combined.update({obj['id']:obj for obj in extra['objects']})
            raw['objects']=list(combined.values())
    if raw.get('schemaVersion')!=1:raise ValueError('Unsupported object index')
    houses={}
    for item in raw['objects']:
        if item.get('house'):houses.setdefault(house_key(item['house']),[]).append(item)
    raw['_addressAliases']={}
    for item in raw['objects']:
        for alias in item.get('addressAliases',[]):raw['_addressAliases'].setdefault(_fold(alias),[]).append(item)
    raw['_houses']=houses
    raw['_named']=[item for item in raw['objects'] if item.get('aliases')]
    return raw

def match_objects(candidates,text,territory_id,index):
    found={};ambiguous=False
    for candidate in candidates:
        parts=split_address(candidate)
        if not parts:continue
        name,kind,house=parts
        possible=[]
        for obj in index.get('_houses',{}).get(house,[]):
            if territory_id not in obj.get('scopeIds',[obj['territoryId']]):continue
            target,target_kind=normalize_street(obj.get('street',''))
            if kind and target_kind and kind!=target_kind:continue
            if target==name or (len(name)>=4 and target.endswith(' '+name)):
                possible.append(obj)
        if len(possible)>1:ambiguous=True
        elif possible:found[possible[0]['id']]=possible[0]
    # Alternate postal/complex addresses remain scoped to one municipality.
    for candidate in candidates:
        matches=[obj for obj in index.get('_addressAliases',{}).get(_fold(candidate),[]) if territory_id in obj.get('scopeIds',[obj['territoryId']])]
        if len(matches)>1:ambiguous=True
        elif matches:found[matches[0]['id']]=matches[0]
    # Named facilities are matched only by an unambiguous full name/curated alias.
    # "school", "hospital", or the publisher's address never supply a location.
    if not found and not ambiguous:
        folded=' '+_fold(text)+' '
        for obj in index.get('_named',index.get('objects',[])):
            if territory_id not in obj.get('scopeIds',[obj['territoryId']]):continue
            if any(len(_fold(alias))>=7 and ' '+_fold(alias)+' ' in folded for alias in obj.get('aliases',[])):
                found[obj['id']]=obj
    if len(found)!=1 or ambiguous:
        return {'status':'ambiguous' if found or ambiguous else 'unmatched','objects':list(found.values())}
    obj=hydrate_object(next(iter(found.values())))
    evidence=next((value for alias,value in obj.get('addressAliasEvidence',{}).items() if any(_fold(alias)==_fold(candidate) for candidate in candidates)),None)
    return {'status':'matched','precision':obj['precision'],'candidateCount':1,'objectId':obj['id'],
        'streetId':None,'streetName':obj.get('address') or obj['name'],'representativeCoordinate':obj['coordinates'],
        'geometry':obj.get('geometry'),'bbox':obj.get('bbox'),'sourceUrl':obj['sourceUrl'],'sourceUrls':[obj['sourceUrl']]+([evidence['url']] if evidence else []),'addressAliasEvidence':evidence,
        'checkedAt':index.get('checkedAt'),'method':'exact-address-or-unique-named-object',
        'note':'Адрес или название из публикации сопоставлены с конкретным объектом OSM. Маркер находится внутри его контура. Это привязка затронутого объекта, а не координата повреждения трубы или оборудования.'}
