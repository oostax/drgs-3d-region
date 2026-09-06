"""Public region extract only; never sends client or complaint identifiers."""
import json,time,urllib.request,urllib.parse,ssl
from pathlib import Path
import certifi
ROOT=Path(__file__).resolve().parents[1]
query='[out:json][timeout:100];area["ISO3166-2"="RU-TA"]["admin_level"="4"]->.region;way["highway"]["name"](area.region);out body geom;'
p=ROOT/'data/public/tatarstan-streets-osm.json'
if not p.exists():
 for endpoint in ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter']:
  try:
   request=urllib.request.Request(endpoint,data=urllib.parse.urlencode({'data':query}).encode(),headers={'User-Agent':'SberAtlas-public-geography/1.0'})
   with urllib.request.urlopen(request,timeout=120,context=ssl.create_default_context(cafile=certifi.where())) as response:raw=json.load(response)
   if raw.get('remark') or not raw.get('elements'):raise ValueError(raw.get('remark','Empty region'))
   raw['atlasFetchedAt']=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat();raw['atlasSourceUrl']=endpoint+'?data='+urllib.parse.quote(query)
   p.write_text(json.dumps(raw,ensure_ascii=False));print('Public regional roads:',len(raw['elements']));break
  except Exception as exc:print(type(exc).__name__,str(exc)[:150],flush=True)
 else:raise SystemExit(1)
else:print('Public regional extract cached')
