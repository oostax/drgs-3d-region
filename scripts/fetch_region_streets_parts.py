"""Bounded public OSM requests, resumed from local cells after server timeouts."""
import json,ssl,urllib.request,urllib.parse,datetime,time
from pathlib import Path
try:
 import certifi
 TLS=ssl.create_default_context(cafile=certifi.where())
except ImportError:
 TLS=ssl.create_default_context()
ROOT=Path(__file__).resolve().parents[1];folder=ROOT/'data/public/region-street-cells';folder.mkdir(exist_ok=True)
xs=[47.2,49,51,53,54.5];ys=[53.8,55.3,56.7];complete=0;elements={};sources=[]
for x in range(4):
 for y in range(2):
  p=folder/f'{x}-{y}.json';bbox=','.join(map(str,[ys[y],xs[x],ys[y+1],xs[x+1]]))
  query='[out:json][timeout:40];way["highway"]["name"]('+bbox+');out body geom;'
  url='https://overpass-api.de/api/interpreter'
  try:
   if p.exists():raw=json.loads(p.read_text())
   else:
    req=urllib.request.Request(url,data=urllib.parse.urlencode({'data':query}).encode(),headers={'User-Agent':'SberAtlas-public-geography/1.0'})
    with urllib.request.urlopen(req,timeout=55,context=TLS) as r:raw=json.load(r)
    if raw.get('remark') or not raw.get('elements'):raise ValueError('incomplete extract')
    p.write_text(json.dumps(raw,ensure_ascii=False))
   for item in raw['elements']:elements[item['id']]=item
   complete+=1;sources.append(url+'?data='+urllib.parse.quote(query));print('Cell',x,y,'roads',len(raw['elements']),flush=True)
  except Exception as exc:print('Cell',x,y,type(exc).__name__,flush=True)
  time.sleep(1)
if elements:
 out={'elements':list(elements.values()),'atlasFetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'atlasSourceUrl':sources[0],'atlasSourceUrls':sources,'coverageCells':complete,'expectedCells':8,'partial':complete<8}
 (ROOT/'data/public/tatarstan-streets-osm.json').write_text(json.dumps(out,ensure_ascii=False));print('Regional extract',len(elements),complete,'/8 cells',flush=True)
