"""Reviewed recovery for the five source-stated addresses in zpravda/108559."""
import sys,json,sqlite3,hashlib,datetime
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'scripts/live'))
from geocoding import load_street_index,match_address_candidates
from analysis import extract_address_mentions
path=Path('data/live/atlas-live.sqlite');c=sqlite3.connect(path,timeout=30);c.row_factory=sqlite3.Row
stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
backup=path.parent.parent/'backups'/('live-before-house-recovery-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite')
with sqlite3.connect(backup) as target:c.backup(target)
original=dict(c.execute("select * from events where id='evt_5c8907c441b42895565e0c68'").fetchone())
links=[dict(r) for r in c.execute('select * from event_documents where event_id=?',(original['id'],))]
proofs=[dict(r) for r in c.execute('select * from event_evidence where event_id=?',(original['id'],))]
doc=c.execute('select * from documents where id=?',(links[0]['document_id'],)).fetchone()
mentions=extract_address_mentions(doc['body']);assert len(mentions)==5
index=load_street_index(Path('data/public/tatarstan-street-index.json'))
street=match_address_candidates(['улица Карла Маркса'],'mo-92628000',index,locality_id='osm-place-336524051');assert street['status']=='matched'
verified=json.loads(Path('artifacts/geocoding-audit-20260905/zelenodolsk-house-verification.json').read_text())
url='https://www.novostitatarstan.online/news/v-zelenodolske-5-sentyabrya-otklyuchat-vodu-v-pyati-domah-1788516531807'
report=[]
with c:
 for i,row in enumerate(verified):
  house=row['house'];address='улица Карла Маркса, '+house;found=row.get('result')
  geometry=found['geometry'] if found else street['geometry']
  coords=found['coordinates'] if found else street['representativeCoordinate']
  precision=found['precision'] if found else 'street'
  def positions(value):
   if isinstance(value,list) and len(value)>=2 and isinstance(value[0],(int,float)):yield value
   elif isinstance(value,list):
    for child in value:yield from positions(child)
  points=list(positions(geometry['coordinates']));bbox=[min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]
  identifier=original['id'] if i==0 else 'evt_'+hashlib.sha256((original['id']+'|'+address).encode()).hexdigest()[:24]
  note='Улица и номера домов связаны по заголовку и следующему абзацу исходной публикации. Зеленодольск подтверждён отдельной публикацией об этом отключении. '+('Объект сопоставлен по полному адресу OSM.' if found else 'Номер дома указан в источнике, но здание пока не сопоставлено; показана только подтверждённая улица.')
  data=json.loads(original['data_json']);data.update(addressCandidates=[address],location_context=mentions[i]['context'],coordinateSourceUrl=found['osmUrl'] if found else street['sourceUrl'],addressSourceUrl=url,siteGeometry=geometry,siteBbox=bbox,siteZoom=18.4 if found else 16,locationVerificationMethod='reviewed-source-house-list-and-osm',geographyNote=note)
  data['locationEvidence']={'status':'matched','precision':precision,'method':data['locationVerificationMethod'],'note':note,'sourceUrl':data['coordinateSourceUrl'],'sourceUrls':[data['coordinateSourceUrl'],url],'addressCandidate':address,'localityName':'Зеленодольск','representativeCoordinate':coords,'bbox':bbox,'geometry':geometry,'checkedAt':stamp,'candidateCount':1}
  data['relatedSources']=[{'label':'Город и список домов подтверждены публикацией','url':url}]
  event={**original,'id':identifier,'legacy_id':original['legacy_id'] if i==0 else None,'canonical_key':original['canonical_key'].split('|house:')[0]+'|house:'+house,'title':'Отключение воды на улице Карла Маркса — '+address,'address':address,'longitude':coords[0],'latitude':coords[1],'precision':precision,'location_confidence':precision,'data_json':json.dumps(data,ensure_ascii=False),'reviewed':1,'notify_eligible':0,'deleted':0,'updated_at':stamp}
  columns=list(event);c.execute('INSERT INTO events('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+') ON CONFLICT(id) DO UPDATE SET '+','.join(k+'=excluded.'+k for k in columns if k!='id'),list(event.values()))
  for link in links:c.execute('INSERT OR IGNORE INTO event_documents(event_id,document_id,relation,similarity) VALUES(?,?,?,?)',(identifier,link['document_id'],link['relation'],link['similarity']))
  if i:
   for proof in proofs:
    proof={**proof,'id':proof['id']+'-'+house,'event_id':identifier};cols=list(proof);c.execute('INSERT OR IGNORE INTO event_evidence('+','.join(cols)+') VALUES('+','.join('?' for _ in cols)+')',list(proof.values()))
  revision=c.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,'upsert',0,?)",(identifier,stamp)).lastrowid
  c.execute('UPDATE events SET revision=? WHERE id=?',(revision,identifier));report.append({'id':identifier,'address':address,'precision':precision,'bbox':bbox})
Path('artifacts/geocoding-audit-20260905/house-recovery.json').write_text(json.dumps({'backup':str(backup),'events':report},ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
