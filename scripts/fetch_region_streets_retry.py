"""Resume missing public geography cells with smaller, bounded OSM queries."""
import datetime,json,ssl,time,urllib.parse,urllib.request
from pathlib import Path
import certifi
ROOT=Path(__file__).resolve().parents[1]
folder=ROOT/'data/public/region-street-cells'
xs=[47.2,49,51,53,54.5];ys=[53.8,55.3,56.7]
master=ROOT/'data/public/tatarstan-streets-osm.json'
existing=json.loads(master.read_text()) if master.exists() else {}
if existing.get('retryAfter') and datetime.datetime.fromisoformat(existing['retryAfter'])>datetime.datetime.now(datetime.timezone.utc):
 raise SystemExit('Public geography server cooldown remains active until '+existing['retryAfter'])
elements={};complete=0
tls=ssl.create_default_context(cafile=certifi.where())
for x in range(4):
 for y in range(2):
  parent=folder/f'{x}-{y}.json'
  if parent.exists():
   for e in json.loads(parent.read_text())['elements']:elements[e['id']]=e
   complete+=1
   continue
  xmid=(xs[x]+xs[x+1])/2;ymid=(ys[y]+ys[y+1])/2
  ax=[xs[x],xmid,xs[x+1]];ay=[ys[y],ymid,ys[y+1]];parts=[]
  for i in range(2):
   for j in range(2):
    target=folder/f'{x}-{y}-{i}-{j}.json'
    try:
     if target.exists():raw=json.loads(target.read_text())
     else:
      box=','.join(map(str,[ay[j],ax[i],ay[j+1],ax[i+1]]))
      q='[out:json][timeout:25];way["highway"]["name"]('+box+');out body geom;'
      request=urllib.request.Request('https://overpass-api.de/api/interpreter',data=urllib.parse.urlencode({'data':q}).encode(),headers={'User-Agent':'SberAtlas-public-geography/1.0'})
      with urllib.request.urlopen(request,timeout=40,context=tls) as response:raw=json.load(response)
      if raw.get('remark'):raise ValueError(raw['remark'])
      target.write_text(json.dumps(raw))
      time.sleep(2)
     parts.append(raw)
     for e in raw['elements']:elements[e['id']]=e
     print(target.name,len(raw['elements']),flush=True)
    except Exception as exc:
     print(target.name,str(exc)[:180],flush=True)
     if getattr(exc,'code',None)==429:
      for e in existing.get('elements',[]):elements.setdefault(e['id'],e)
      existing.update(elements=list(elements.values()),partial=True,fetchStatus='rate_limited',retryAfter=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=30)).isoformat())
      temp=master.with_suffix('.tmp');temp.write_text(json.dumps(existing));temp.replace(master)
      raise SystemExit('Stopped after rate limit; cached geography retained.')
  if len(parts)==4:
   parent.write_text(json.dumps({'elements':[e for raw in parts for e in raw['elements']]}));complete+=1
out=ROOT/'data/public/tatarstan-streets-osm.json'
previous=json.loads(out.read_text()) if out.exists() else {}
for e in previous.get('elements',[]):elements.setdefault(e['id'],e)
previous.update(elements=list(elements.values()),atlasFetchedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),coverageCells=complete,expectedCells=8,partial=complete<8)
temp=out.with_suffix('.tmp');temp.write_text(json.dumps(previous));temp.replace(out)
print('Saved',len(elements),'roads;',complete,'/8 complete',flush=True)
