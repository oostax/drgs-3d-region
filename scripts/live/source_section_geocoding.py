"""Clip only source-named street sections to unambiguous OSM junctions."""
from __future__ import annotations
import collections,math,re
from typing import Any,Callable

NAME=r'[А-ЯЁӘӨҮҖҢҺA-Z0-9][А-ЯЁа-яёӘәӨөҮүҖҗҢңҺһA-Za-z0-9.\-]*'
KIND=r'(?i:улиц[аеуы]|ул\.?|проспект[аеу]?|просп\.?|переул(?:ок|ка|ке)|проезд[аеу]?|тракт[аеу]?|шоссе|бульвар[аеу]?)'
STREET=r'(?:'+KIND+r'\s*)?'+NAME+r'(?:\s+'+NAME+r'){0,3}'
BOUNDS=re.compile(r'\bот\s+(?P<start>'+STREET+r')\s+до\s+(?P<end>'+STREET+r')')

def lines(geometry):
    if geometry.get('type')=='LineString':return [geometry['coordinates']]
    if geometry.get('type')=='MultiLineString':return geometry['coordinates']
    return []

def meters(a,b):return math.hypot((a[0]-b[0])*111320*math.cos(math.radians((a[1]+b[1])/2)),(a[1]-b[1])*111320)
def key(p):return (round(p[0],7),round(p[1],7))
def length(line):return sum(meters(a,b) for a,b in zip(line,line[1:]))
def midpoint(line):
    remaining=length(line)/2
    for a,b in zip(line,line[1:]):
        size=meters(a,b)
        if remaining<=size:return [a[0]+(b[0]-a[0])*remaining/max(size,1e-9),a[1]+(b[1]-a[1])*remaining/max(size,1e-9)]
        remaining-=size
    return list(line[-1])

def intersections(a,b,c,d):
    """Point intersections only; coincident streets are not unique boundaries."""
    rx,ry=b[0]-a[0],b[1]-a[1];sx,sy=d[0]-c[0],d[1]-c[1]
    denominator=rx*sy-ry*sx
    if abs(denominator)<1e-18:
        common={key(p) for p in (a,b)}&{key(p) for p in (c,d)}
        return [list(p) for p in common]
    t=((c[0]-a[0])*sy-(c[1]-a[1])*sx)/denominator
    u=((c[0]-a[0])*ry-(c[1]-a[1])*rx)/denominator
    return [[a[0]+t*rx,a[1]+t*ry]] if -1e-8<=t<=1+1e-8 and -1e-8<=u<=1+1e-8 else []

def lateral_distance(p,line):
    best=math.inf;scale=math.cos(math.radians(p[1]))
    for a,b in zip(line,line[1:]):
        dx=(b[0]-a[0])*scale;dy=b[1]-a[1]
        t=max(0,min(1,((p[0]-a[0])*scale*dx+(p[1]-a[1])*dy)/max(dx*dx+dy*dy,1e-20)))
        best=min(best,meters(p,[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]))
    return best

def clip_between_intersections(main_geometry,start_geometry,end_geometry):
    main_lines=lines(main_geometry);bounds=[lines(start_geometry),lines(end_geometry)]
    graph=collections.defaultdict(set);points={};junctions=[set(),set()]
    for line in main_lines:
        for a,b in zip(line,line[1:]):
            cuts={key(a),key(b)}
            for side,bound_lines in enumerate(bounds):
                for other in bound_lines:
                    for c,d in zip(other,other[1:]):
                        for p in intersections(a,b,c,d):
                            k=key(p);cuts.add(k);junctions[side].add(k)
            ordered=sorted(cuts,key=lambda p:meters(a,p))
            for u,v in zip(ordered,ordered[1:]):
                if u==v:continue
                graph[u].add(v);graph[v].add(u);points[u]=list(u);points[v]=list(v)
    for side in junctions:
        if not side:return {'status':'unmatched','reason':'boundary-has-no-osm-intersection'}
        if any(meters(a,b)>40 for a in side for b in side):return {'status':'ambiguous','reason':'boundary-crosses-street-in-several-places'}
    if junctions[0]&junctions[1]:return {'status':'ambiguous','reason':'section-boundaries-overlap'}
    # Remove dead ends, including kilometres of the same street beyond the
    # named section, before looking for routes between the two junctions.
    protected=junctions[0]|junctions[1];queue=collections.deque(p for p,n in graph.items() if len(n)<=1 and p not in protected)
    while queue:
        p=queue.popleft()
        if p not in graph or p in protected or len(graph[p])>1:continue
        for n in graph.pop(p):
            graph[n].discard(p)
            if len(graph[n])<=1 and n not in protected:queue.append(n)
    paths=[];explored=0
    for start in junctions[0]:
        stack=[(start,[start],0.0)]
        while stack:
            current,route,size=stack.pop();explored+=1
            if explored>20000 or len(paths)>32:return {'status':'ambiguous','reason':'section-has-too-many-routes'}
            if current in junctions[1]:paths.append(route);continue
            for following in graph.get(current,[]):
                if following in route or (following in junctions[0] and following!=start):continue
                new_size=size+meters(current,following)
                if new_size<=10000:stack.append((following,[*route,following],new_size))
    if not paths:return {'status':'unmatched','reason':'section-boundaries-are-disconnected'}
    reference=min(paths,key=length)
    if length(reference)<3:return {'status':'ambiguous','reason':'section-is-too-short'}
    if any(lateral_distance(p,reference)>45 for route in paths for p in route):return {'status':'ambiguous','reason':'section-has-distinct-alternative-corridors'}
    # Parallel carriageways belong to one named corridor; preserve each edge
    # exactly once so rendering and length calculation do not double it.
    retained=collections.defaultdict(set);unused=set()
    for route in paths:
        for a,b in zip(route,route[1:]):
            edge=tuple(sorted((a,b)));unused.add(edge);retained[a].add(b);retained[b].add(a)
    output=[]
    while unused:
        first=next((p for edge in unused for p in edge if len(retained[p])!=2),next(iter(unused))[0])
        nxt=next(n for n in retained[first] if tuple(sorted((first,n))) in unused)
        route=[first,nxt];unused.remove(tuple(sorted((first,nxt))))
        while len(retained[route[-1]])==2:
            possible=[n for n in retained[route[-1]] if tuple(sorted((route[-1],n))) in unused]
            if not possible:break
            nxt=possible[0];unused.remove(tuple(sorted((route[-1],nxt))));route.append(nxt)
        output.append([list(p) for p in route])
    coords=[p for line in output for p in line]
    geometry={'type':'LineString','coordinates':output[0]} if len(output)==1 else {'type':'MultiLineString','coordinates':output}
    return {'status':'matched','geometry':geometry,'representativeCoordinate':midpoint(reference),
            'bbox':[min(p[0] for p in coords),min(p[1] for p in coords),max(p[0] for p in coords),max(p[1] for p in coords)],
            'lengthMeters':round(sum(length(line) for line in output),1),
            'intersections':[[list(p) for p in sorted(side)] for side in junctions]}

def source_section(street:dict[str,Any],candidate:str,source_text:str,resolve:Callable[[str],dict[str,Any]]):
    matched=[]
    from geocoding import normalize_street
    name=normalize_street(candidate)[0]
    # A source often places the boundaries in the immediately following sentence.
    spans=list(re.finditer(r'.+?(?:(?<!ул)(?<!пер)\.(?=\s)|[\n!?]+|$)',source_text))
    for i,span in enumerate(spans):
        sentence=span.group();folded=' '.join(sentence.casefold().split())
        anchor=folded.find(name)
        if anchor<0:continue
        bounds=BOUNDS.search(sentence)
        if not bounds and i+1<len(spans) and re.match(r'\s*(?:[Нн]ачиная\s+)?от\s+',spans[i+1].group()):
            sentence=source_text[span.start():spans[i+1].end()]
            bounds=BOUNDS.search(sentence)
        if not bounds or anchor>=bounds.start():continue
        matched.append((sentence.strip(),bounds.group('start').strip(),bounds.group('end').rstrip('., ')))
    if not matched:return None
    if len({(a,b) for _,a,b in matched})!=1:return {'status':'ambiguous','reason':'several-source-sections'}
    quote,start_name,end_name=matched[0];start,end=resolve(start_name),resolve(end_name)
    if start.get('status')!='matched' or end.get('status')!='matched':return {'status':'ambiguous','reason':'boundary-street-not-unique','sourceQuote':quote}
    result=clip_between_intersections(street.get('geometry') or {},start.get('geometry') or {},end.get('geometry') or {})
    if result['status']!='matched':return {**result,'sourceQuote':quote}
    return {**result,'sourceQuote':quote,'from':{'name':start_name,'streetId':start['streetId'],'sourceUrls':start.get('sourceUrls',[])},
            'to':{'name':end_name,'streetId':end['streetId'],'sourceUrls':end.get('sourceUrls',[])}}
