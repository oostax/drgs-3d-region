"""Bounded OSM data fallback when the search index misses a source-stated house."""
from pathlib import Path
from geocoding import normalize_street,load_street_index,match_address_candidates
from object_geocoding import split_address,house_key,polygon_anchor
from region_config import region_config,localities,fold
from runtime_paths import DATA_ROOT


def exact_map_house(raw,address,locality):
    parts=split_address(address)
    if not parts:return None
    name,kind,house=parts
    nodes={p['id']:[p['lon'],p['lat']] for p in raw.get('elements',[]) if p.get('type')=='node'}
    found=[]
    for way in raw.get('elements',[]):
        tags=way.get('tags',{})
        if way.get('type')!='way' or not tags.get('building'):continue
        if house_key(tags.get('addr:housenumber',''))!=house or fold(tags.get('addr:city',''))!=fold(locality):continue
        street,street_kind=normalize_street(tags.get('addr:street',''))
        if street!=name or (kind and street_kind and kind!=street_kind):continue
        try:ring=[nodes[n] for n in way['nodes']]
        except KeyError:continue
        if len(ring)<4 or ring[0]!=ring[-1]:continue
        found.append((way,ring))
    # Disconnected same-number buildings or overlapping footprints need review.
    if len(found)!=1:return None
    way,ring=found[0];tags=way['tags'];verified=tags['addr:street']+', '+tags['addr:housenumber']
    return {'coordinates':polygon_anchor(ring),'geometry':{'type':'Polygon','coordinates':[ring]},
        'osmUrl':f"https://www.openstreetmap.org/way/{way['id']}",'osmId':f"way/{way['id']}",
        'verifiedAddress':verified,'displayName':verified,'precision':'building'}


def source_house_from_osm_map(address,locality,request):
    """One cached local rectangle, only after a unique city/street match."""
    parts=split_address(address)
    if not parts:return None
    places=[p for p in localities('RU-TA') if fold(p['name'])==fold(locality)]
    if len(places)!=1:return None
    place=places[0];file=DATA_ROOT/region_config('RU-TA')['streetIndex']
    if not file.exists():return None
    index=load_street_index(Path(file))
    street=match_address_candidates([address.rsplit(',',1)[0]],place['territoryId'],index,locality_id=place['id'])
    if street['status']!='matched' or not street.get('bbox'):return None
    w,s,e,n=street['bbox'];bbox=[round(w-.002,5),round(s-.002,5),round(e+.002,5),round(n+.002,5)]
    # Never turn a missing address into a regional map download.
    if (bbox[2]-bbox[0])*(bbox[3]-bbox[1])>.01:return None
    raw=request('https://api.openstreetmap.org/api/0.6/map.json?bbox='+','.join(map(str,bbox)))
    return exact_map_house(raw,address,locality)
