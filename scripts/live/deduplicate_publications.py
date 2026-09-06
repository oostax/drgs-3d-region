"""Conservatively consolidate republications, retaining every document and quote."""
from __future__ import annotations
import argparse,collections,datetime,json,re,sqlite3,unicodedata
from pathlib import Path
from connectors import iso_now
from worker import DEFAULT_DB,open_database,export_data

STOP={'это','этот','сегодня','вчера','также','который','которые','республика','республики','татарстан','татарстана','татарстане','казани','казань','сообщает','сообщили','стало','известно','году','года','более','около','почти','всего','новый','новая','новое'}
STAGES={'milling':r'фрезеров','asphalt':r'уклад.{0,15}асфальт|асфальтирован','curb':r'бордюр|бортов.{0,12}кам','foundation':r'фундамент|котлован','frame':r'каркас|перекрыти','opening':r'\bоткрыли\b|введ.{0,20}эксплуатац'}

def tokens(text):
    words=re.findall(r'[а-яёәөүҗңһ]{4,}|\d+(?:[.,]\d+)?',unicodedata.normalize('NFKC',text).casefold())
    out=set()
    for word in words:
        if word in STOP:continue
        word=re.sub(r'(?:иями|ями|ами|ией|ого|ему|ому|ыми|ими|ов|ев|ах|ях|ом|ам|ям|ой|ий|ый|ая|ое|ые|ии|ы|а|е|у)$','',word) if len(word)>5 else word
        word={'педагог':'учител','учител':'учител','показал':'транслиров','запустил':'транслиров','трансляци':'транслиров','демонстраци':'транслиров','видеоролик':'ролик'}.get(word,word)
        out.add(word)
    return out

def overlap(a,b):return len(a&b)/max(1,min(len(a),len(b)))
def physical_phase(row):
    return 'observation' if row['state'] in {'unknown','reported'} else row['state']

def location_key(row,data):
    location=data.get('locationEvidence',{})
    if location.get('objectId') or location.get('streetId'):return location.get('objectId') or location.get('streetId')
    addresses=data.get('addressCandidates') or []
    if addresses:return (row['territory_id'] or row['region_id'])+'|'+json.dumps([sorted(tokens(a)) for a in addresses],ensure_ascii=False)
    return row['territory_id'] or row['region_id']

def duplicate_pair(a,b):
    """No cross-day/stage/address merge. Publicity may lack map-worthy geometry."""
    ar,ad,at,ab=a;br,bd,bt,bb=b
    if ar['region_id']!=br['region_id'] or ar['published_at'][:10]!=br['published_at'][:10] or physical_phase(ar)!=physical_phase(br):return False
    if not ab or not bb:return False
    if ad.get('site_group_key') and ad.get('site_group_key')==bd.get('site_group_key') and ad.get('location_context')!=bd.get('location_context'):return False
    anoise=ad.get('signalUsefulness',{}).get('level')=='noise';bnoise=bd.get('signalUsefulness',{}).get('level')=='noise'
    # A different precision for the same publicity item is not two physical
    # sites. For operational events, independently matched location must agree.
    if not (anoise and bnoise) and location_key(ar,ad)!=location_key(br,bd):return False
    astages={k for k,p in STAGES.items() if re.search(p,ar['summary'],re.I)}
    bstages={k for k,p in STAGES.items() if re.search(p,br['summary'],re.I)}
    if not (anoise and bnoise) and astages!=bstages:return False
    aprogress=set(re.findall(r'\b\d+(?:[.,]\d+)?\s*%',ar['summary']))
    bprogress=set(re.findall(r'\b\d+(?:[.,]\d+)?\s*%',br['summary']))
    if aprogress!=bprogress:return False
    # Full content equality or strong shared title + source body. The minimum
    # prevents generic one-line notices from collapsing unrelated objects.
    if ab==bb and len(ab)>=10:return True
    if len(at&bt)>=5 and overlap(at,bt)>=.82 and len(ab&bb)>=10 and overlap(ab,bb)>=.76:return True
    # Syndicated ceremonial news is often paraphrased. Require shared quoted
    # named entity and many specific content tokens in both original articles.
    if anoise and bnoise:
        common=ab&bb
        anchors_a={re.sub(r'[^а-яёa-z0-9]','',q.casefold())[:14] for q in re.findall(r'[«"]([^»"]{5,60})[»"]',ar['summary'])}
        anchors_b={re.sub(r'[^а-яёa-z0-9]','',q.casefold())[:14] for q in re.findall(r'[«"]([^»"]{5,60})[»"]',br['summary'])}
        if anchors_a&anchors_b and len(common)>=12 and overlap(ab,bb)>=.7:return True
    return False

def find_groups(connection):
    rows=connection.execute('SELECT * FROM events WHERE deleted=0 AND reviewed=0 AND legacy_id IS NULL ORDER BY published_at,id').fetchall()
    entries=[]
    for row in rows:
        data=json.loads(row['data_json'] or '{}')
        docs=connection.execute('SELECT d.title,d.body FROM documents d JOIN event_documents ed ON ed.document_id=d.id WHERE ed.event_id=? ORDER BY length(d.body) DESC LIMIT 1',(row['id'],)).fetchall()
        body=(docs[0]['body'] or '') if docs else row['summary']
        # Footer subscriptions differ by publisher and do not define an event.
        body=re.split(r'подписывайтесь|наш канал|читайте также|телеграм.канал',body,flags=re.I)[0]
        entries.append((row,data,tokens(row['title']),tokens(body[:1600])))
    buckets=collections.defaultdict(list);groups=[]
    for entry in entries:
        key=(entry[0]['region_id'],entry[0]['published_at'][:10],physical_phase(entry[0]))
        matched=False
        for group in buckets[key]:
            if duplicate_pair(entry,group[0]):group.append(entry);matched=True;break
        if not matched:
            group=[entry];buckets[key].append(group);groups.append(group)
    return [g for g in groups if len(g)>1]

def merge_groups(connection,groups):
    now=iso_now();merged=[]
    for group in groups:
        keeper=min(group,key=lambda e:(0 if e[0]['source_kind']=='official' else 1,0 if e[0]['precision'] in {'building','site','street'} else 1,e[0]['published_at'],e[0]['id']))[0]
        for row,_,_,_ in group:
            if row['id']==keeper['id']:continue
            connection.execute("INSERT OR IGNORE INTO event_documents(event_id,document_id,relation,similarity) SELECT ?,document_id,'republication',1 FROM event_documents WHERE event_id=?",(keeper['id'],row['id']))
            # Copy each quote with its original evidence/source timestamps. The
            # tombstoned event and old quotes remain available for audit.
            for evidence in connection.execute('SELECT * FROM event_evidence WHERE event_id=?',(row['id'],)).fetchall():
                values=dict(evidence);values['id']='merged_'+keeper['id']+'_'+evidence['id'];values['event_id']=keeper['id']
                columns=','.join(values);connection.execute(f"INSERT OR IGNORE INTO event_evidence({columns}) VALUES({','.join('?' for _ in values)})",tuple(values.values()))
            connection.execute('INSERT INTO event_aliases(alias,event_id) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET event_id=excluded.event_id',(row['id'],keeper['id']))
            connection.execute('UPDATE event_aliases SET event_id=? WHERE event_id=?',(keeper['id'],row['id']))
            rev=connection.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,'delete',0,?)",(row['id'],now)).lastrowid
            connection.execute('UPDATE events SET deleted=1,notify_eligible=0,revision=? WHERE id=?',(rev,row['id']))
            merged.append({'removedId':row['id'],'canonicalId':keeper['id'],'title':row['title']})
        revision=connection.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,'upsert',0,?)",(keeper['id'],now)).lastrowid
        connection.execute('UPDATE events SET revision=?,notify_eligible=0 WHERE id=?',(revision,keeper['id']))
    connection.commit();return merged

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--db',type=Path,default=DEFAULT_DB);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    c=open_database(args.db);groups=find_groups(c)
    if not args.apply:
        print(json.dumps([{'events':[{'id':e[0]['id'],'title':e[0]['title'],'state':e[0]['state'],'precision':e[0]['precision']} for e in group]} for group in groups],ensure_ascii=False,indent=2));raise SystemExit()
    backup=args.db.parent.parent/'backups'/('live-before-publication-dedup-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite')
    with sqlite3.connect(backup) as target:c.backup(target)
    merged=merge_groups(c,groups);result={'backup':str(backup),'groups':len(groups),'merged':len(merged),'items':merged,'export':export_data(c,args.db.parent/'export')}
    Path('data/live/publication-dedup-2026-09-05.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='items'},ensure_ascii=False))
