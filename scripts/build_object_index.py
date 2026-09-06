"""Build a municipality-scoped local address index from retained OSM data."""
import argparse,json,datetime
from pathlib import Path
from shapely.geometry import shape,Point,Polygon

def build(candidates,boundaries,territory):
    boundary=shape(next(f['geometry'] for f in boundaries['features'] if f['properties'].get('territoryId')==territory))
    objects=[]
    for item in candidates['elements']:
        tags=item.get('tags',{});coords=item.get('geometry') or []
        if item['type']!='way' or not (tags.get('building') or tags.get('leisure')):continue
        polygon=Polygon([(p['lon'],p['lat']) for p in coords]) if len(coords)>=4 and coords[0]==coords[-1] else None
        if polygon is not None and (not polygon.is_valid or polygon.is_empty):continue
        center=polygon.representative_point() if polygon is not None else Point(item['center']['lon'],item['center']['lat']) if item.get('center') else None
        if center is None or not boundary.covers(center):continue
        street,house=tags.get('addr:street'),tags.get('addr:housenumber')
        name=tags.get('name','');address=f'{street}, {house}' if street and house else name
        if not address:continue
        # Only distinctive complete names are automatic aliases; a generic
        # "hospital" or a short popular name must never locate a publication.
        aliases=[name] if len(name)>10 and any(k in tags for k in ['amenity','leisure','tourism']) else []
        objects.append({'id':f"osm-way-{item['id']}",'osmId':item['id'],'territoryId':territory,'name':name or address,
            'address':address,'street':street,'house':house,'aliases':aliases,'precision':'building' if tags.get('building') else 'site',
            'coordinates':[center.x,center.y],'geometry':polygon.__geo_interface__ if polygon is not None else None,
            'bbox':list(polygon.bounds) if polygon is not None else None,'sourceUrl':f"https://www.openstreetmap.org/way/{item['id']}"})
    return {'schemaVersion':1,'territoryId':territory,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'sourceUrl':'https://www.openstreetmap.org/copyright','objects':objects}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input',action='append',required=True);p.add_argument('--output',required=True);p.add_argument('--territory',default='mo-92701000');p.add_argument('--boundaries',default='public/data/tatarstan-boundaries.geojson');a=p.parse_args()
    elements={}
    for file in a.input:
        for item in json.loads(Path(file).read_text())['elements']:elements[(item['type'],item['id'])]=item
    result=build({'elements':list(elements.values())},json.loads(Path(a.boundaries).read_text()),a.territory)
    Path(a.output).write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n');print('Indexed objects:',len(result['objects']))
