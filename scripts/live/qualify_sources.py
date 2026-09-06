"""Connect advertised RSS feeds; register publisher-linked Telegram sources separately."""
import concurrent.futures,hashlib,json
from urllib.parse import urlsplit
from runtime_paths import DATA_ROOT
from connectors import BoundedFetcher,parse_source

def main():
    p=DATA_ROOT/'data/live/sources.json';raw=json.loads(p.read_text());sources=raw['sources'] if isinstance(raw,dict) else raw
    by_id={s['id']:s for s in sources};discovery=json.loads((DATA_ROOT/'data/live/source-discovery.json').read_text())
    by_url={s['url']:s for s in sources};channels={};feeds=[]
    for row in discovery['publishers']:
        parent=by_id[row['source_id']]
        for channel in row['channels']:channels.setdefault(channel.lower(),{'peer':channel,'parents':[]})['parents'].append(parent)
        candidates=[u for u in row['feeds'] if urlsplit(u).path.rstrip('/') in ('/rss','/welcome/feed')]
        if candidates:feeds.append((parent,candidates[0]))
    def check(item):
        parent,url=item
        try:
            result=BoundedFetcher().get(url);docs=parse_source(result,{**parent,'adapter':'rss','url':url})
            return parent,url,len(docs),max((d.published_at for d in docs if d.published_at),default=None)
        except Exception:return parent,url,0,None
    verified=0
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for parent,url,count,latest in pool.map(check,feeds):
            if not count:continue
            key='rss-'+hashlib.sha256(url.encode()).hexdigest()[:16]
            source=by_url.get(url)
            if source is None:
                source={**parent,'id':key,'url':url,'adapter':'rss','provenance_url':parent['url']};sources.append(source);by_url[url]=source
            source.update(status='active',fetch_allowed=True,display_allowed=True,ai_allowed=parent.get('ai_allowed',False),interval_seconds=1800,rights_note='RSS опубликован самим издателем. Карта показывает краткий пересказ и ссылку; ИИ — только при отдельном разрешении.',latest_publication_at=latest)
            verified+=1
    for key,value in channels.items():
        url='https://t.me/'+value['peer']
        if any(s['url'].lower()==url.lower() for s in sources):continue
        parents=value['parents'];parent=parents[0];coverage={}
        for owner in parents:
            for entry in owner.get('coverage',[]):
                if isinstance(entry,str):entry={'territory_id':entry,'coverage_level':'direct'}
                coverage[entry['territory_id']]=entry
        sources.append({'id':'tg-'+hashlib.sha256(key.encode()).hexdigest()[:16],'name':parent['name']+' · Telegram','region_id':parent.get('region_id','RU-TA'),'territory_id':parent.get('territory_id') if len(parents)==1 else None,'url':url,'telegram_peer':value['peer'],'adapter':'telegram','source_kind':parent.get('source_kind','media'),'status':'rights_review','enabled':False,'fetch_allowed':False,'display_allowed':False,'ai_allowed':False,'consent_status':'pending','interval_seconds':300,'languages':parent.get('languages',['ru','tt']),'topics':parent.get('topics',[]),'coverage':list(coverage.values()),'provenance_url':parent['url'],'rights_note':'Ссылка найдена на сайте издателя. MTProto подготовлен; получение, показ и согласие на ИИ подтверждаются отдельно.'})
    if isinstance(raw,dict):raw['sources']=sources
    else:raw=sources
    p.write_text(json.dumps(raw,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'rss_verified':verified,'telegram_registered':len(channels),'sources':len(sources)}))
if __name__=='__main__':main()
