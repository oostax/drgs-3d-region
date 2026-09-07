"""Assign retained public OSM address objects to their actual municipal polygons."""
import argparse,datetime,json
from pathlib import Path
from shapely.geometry import Point,Polygon,shape
from shapely.strtree import STRtree

def build(raw,places):
    owners=[p for p in places if p.get('geometry') and p['kind']!='region']
    polygons=[shape(p['geometry']) for p in owners]
    tree=STRtree(polygons);by_id={p['id']:p for p in places};objects=[]
    for item in raw.get('elements',[]):
        tags=item.get('tags',{})
        if item['type']!='way' or not (tags.get('building') or tags.get('leisure')):continue
        ring=[[p['lon'],p['lat']] for p in item.get('geometry',[])]
        polygon=Polygon(ring) if len(ring)>=4 and ring[0]==ring[-1] else None
        if polygon is not None and (not polygon.is_valid or polygon.is_empty):continue
        center=polygon.representative_point() if polygon is not None else Point(item['center']['lon'],item['center']['lat']) if item.get('center') else None
        if center is None:continue
        candidates=[int(i) for i in tree.query(center) if polygons[int(i)].covers(center)]
        if not candidates:continue
        candidates.sort(key=lambda i:(owners[i]['kind']!='settlement',polygons[i].area))
        owner=owners[candidates[0]];scope=[];current=owner
        while current and current['id'] not in scope:
            scope.append(current['id']);current=by_id.get(current.get('parentId'))
        street,house,name=tags.get('addr:street'),tags.get('addr:housenumber'),tags.get('name','')
        address_aliases=[]
        if house and '/' in house and tags.get('addr:place'):
            address_aliases.append('дом '+house)
        if tags.get('addr2:street') and tags.get('addr2:housenumber'):
            if street and house:address_aliases.append(street+', '+house)
            street,house=tags['addr2:street'],tags['addr2:housenumber']
        address=f'{street}, {house}' if street and house else name
        if not address:continue
        aliases=[name] if len(name)>10 and any(k in tags for k in ['amenity','leisure','tourism']) else []
        objects.append(dict(id=f"osm-way-{item['id']}",osmId=item['id'],territoryId=owner['id'],scopeIds=scope,name=name or address,address=address,street=street,house=house,aliases=aliases,addressAliases=address_aliases,precision='building' if tags.get('building') else 'site',coordinates=[center.x,center.y],geometry=polygon.__geo_interface__ if polygon is not None else None,bbox=list(polygon.bounds) if polygon is not None else None,sourceUrl=f"https://www.openstreetmap.org/way/{item['id']}"))
    return dict(schemaVersion=1,regionId=next(p['id'] for p in places if p['kind']=='region'),partial=True,checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),sourceUrl='https://www.openstreetmap.org/copyright',objects=objects)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--input',action='append',required=True);parser.add_argument('--output',required=True);parser.add_argument('--preserve');parser.add_argument('--territories',default='public/data/territories.json');args=parser.parse_args()
    elements={}
    for file in args.input:
        for item in json.loads(Path(file).read_text())['elements']:elements[(item['type'],item['id'])]=item
    result=build({'elements':list(elements.values())},json.loads(Path(args.territories).read_text()))
    if args.preserve:
        known={o['id'] for o in result['objects']}
        result['objects'].extend(o for o in json.loads(Path(args.preserve).read_text())['objects'] if o['id'] not in known)
    if not result['objects']:raise SystemExit('Empty result: existing index preserved')
    output=Path(args.output);tmp=output.with_suffix('.tmp');tmp.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')));tmp.replace(output)
    print(json.dumps({'objects':len(result['objects']),'territories':len(set(x['territoryId'] for x in result['objects'])),'partial':True}))
