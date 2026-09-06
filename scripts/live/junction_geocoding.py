"""Resolve source-listed junctions using shared OSM road vertices, not centroids."""
import re
from source_section_geocoding import lines, key, meters


def source_junction(context, text, resolve):
    if not context or context not in text or not re.search(r'перекрест|перекрёст|светофор', text, re.I):
        return None
    parts = re.split(r'\s+[–—]\s+', context.strip().rstrip(',.;'))
    if len(parts) != 2:
        return None
    left, right = [resolve(part) for part in parts]
    if any(p.get('status') != 'matched' for p in (left, right)) or left['streetId'] == right['streetId']:
        return None
    vertices = [{key(p) for line in lines(s.get('geometry') or {}) for p in line} for s in (left, right)]
    shared = sorted(vertices[0] & vertices[1])
    if not shared or any(meters(a,b)>40 for a in shared for b in shared):
        return None
    # Keep the anchor on a real shared vertex, even for divided carriageways.
    point = list(shared[0])
    identity = 'junction:'+'|'.join(sorted((left['streetId'],right['streetId'])))
    return {'status':'matched','precision':'site','method':'source-named-junction',
        'objectId':identity,'streetId':None,'streetName':left['streetName']+' / '+right['streetName'],
        'representativeCoordinate':point,'geometry':{'type':'Point','coordinates':point},
        'bbox':[min(p[0] for p in shared),min(p[1] for p in shared),max(p[0] for p in shared),max(p[1] for p in shared)],
        'sourceUrls':list(dict.fromkeys(left.get('sourceUrls',[])+right.get('sourceUrls',[]))),
        'sourceQuote':context,'note':'Перекрёсток назван в публикации. Координата — общий узел двух улиц OSM; положение отдельного светофора не установлено.'}
