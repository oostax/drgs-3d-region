"""Assign public OSM settlement names to actual municipal polygons and streets."""
import argparse,json,math
from pathlib import Path
from shapely.geometry import Point,shape
from shapely.strtree import STRtree


def build(raw,territories,streets):
    owners=[p for p in territories if p.get('geometry') and p['kind']!='region']
    polygons=[shape(p['geometry']) for p in owners];tree=STRtree(polygons)
    by_id={p['id']:p for p in territories};localities=[]
    for item in raw['elements']:
        tags=item.get('tags',{});name=tags.get('name:ru') or tags.get('name')
        if item.get('type')!='node' or not name or tags.get('place')=='suburb':continue
        point=Point(item['lon'],item['lat'])
        hits=[int(i) for i in tree.query(point) if polygons[int(i)].covers(point)]
        if not hits:continue
        hits.sort(key=lambda i:(owners[i]['kind']!='settlement',polygons[i].area))
        owner=owners[hits[0]];scope=[];current=owner
        while current and current['id'] not in scope:
            scope.append(current['id']);current=by_id.get(current.get('parentId'))
        aliases=list(dict.fromkeys(v for k in ['name','name:ru','name:tt','official_name','alt_name'] for v in tags.get(k,'').split(';') if v))
        localities.append({'id':f"osm-place-{item['id']}",'name':name,'aliases':aliases,'placeKind':tags['place'],
            'territoryId':owner['id'],'scopeIds':scope,'coordinates':[point.x,point.y],
            'sourceUrl':f"https://www.openstreetmap.org/node/{item['id']}"})
    # This is a street-name disambiguation aid. It never gives an event a house
    # coordinate: matched events retain street precision and the real street line.
    points=[Point(p['coordinates'][0]*math.cos(math.radians(55.5)),p['coordinates'][1]) for p in localities]
    # Euclidean proximity must never attach a city street to a village across
    # its municipal boundary. Search only places with the same polygon owner.
    groups={}
    for i,place in enumerate(localities):groups.setdefault(place['territoryId'],[]).append(i)
    trees={owner:(ids,STRtree([points[i] for i in ids])) for owner,ids in groups.items()}
    assigned=0
    for street in streets['streets']:
        street.pop('localityIds',None)
        group=trees.get(street.get('territoryId'))
        if not group:continue
        xy=street['coordinates'];point=Point(xy[0]*math.cos(math.radians(55.5)),xy[1])
        ids,place_tree=group;i=ids[int(place_tree.nearest(point))];place=localities[i];distance=point.distance(points[i])*111320
        if distance<=(10000 if place['placeKind'] in {'city','town'} else 3500):
            street['localityIds']=[place['id']];assigned+=1
    streets['localities']=localities
    streets['localityIndexCheckedAt']=raw['atlasFetchedAt']
    return {'schemaVersion':1,'checkedAt':raw['atlasFetchedAt'],'sourceUrl':raw['atlasSourceUrl'],'localities':localities},assigned


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',default='data/public/tatarstan-places-osm.json')
    parser.add_argument('--territories',default='public/data/territories.json')
    parser.add_argument('--streets',default='data/public/tatarstan-street-index.json')
    parser.add_argument('--output',default='data/public/tatarstan-locality-index.json')
    args=parser.parse_args();street_file=Path(args.streets);streets=json.loads(street_file.read_text())
    result,count=build(json.loads(Path(args.input).read_text()),json.loads(Path(args.territories).read_text()),streets)
    if not result['localities']:raise SystemExit('No places: preserved previous indexes')
    for file,data in [(Path(args.output),result),(street_file,streets)]:
        tmp=file.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')));tmp.replace(file)
    print(json.dumps({'localities':len(result['localities']),'streetsWithLocalityContext':count}))
