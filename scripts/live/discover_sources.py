"""Discover publisher-declared feeds and Telegram links; never crawl Telegram content."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from urllib.request import Request,urlopen
from pathlib import Path
import datetime,json,re,hashlib,ssl
import certifi
from runtime_paths import DATA_ROOT

class Links(HTMLParser):
    def __init__(self):super().__init__();self.links=[];self.feeds=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs);url=a.get('href','')
        if tag=='a' and re.match(r'https?://(?:t.me|telegram.me)/[A-Za-z0-9_]+',url):self.links.append(url)
        if tag=='link' and a.get('type') in ('application/rss+xml','application/atom+xml'):self.feeds.append(url)

def discover(source):
    url=source['url'];host=urlsplit(url).netloc
    if host in ('t.me','telegram.me'):return None
    target='https://'+host+'/'
    result={'source_id':source['id'],'territory_id':source.get('territory_id'),'url':target,'channels':[],'feeds':[]}
    try:
        with urlopen(Request(target,headers={'User-Agent':'SberAtlas-public-source-directory/1.0'}),timeout=8,context=ssl.create_default_context(cafile=certifi.where())) as r:
            if r.status!=200:raise ValueError('HTTP '+str(r.status))
            text=r.read(2000000).decode('utf-8','replace')
        parser=Links();parser.feed(text)
        result['channels']=sorted({urlsplit(u).path.strip('/').split('/')[0] for u in parser.links if not any(x in u.lower() for x in ('/share','/joinchat','bot'))})
        result['feeds']=sorted({urljoin(target,u) for u in parser.feeds})
        result['status']='checked'
    except Exception as exc:result['status']='unavailable';result['error']=type(exc).__name__
    return result

def main():
    p=DATA_ROOT/'data/live/sources.json';raw=json.loads(p.read_text());sources=raw['sources'] if isinstance(raw,dict) else raw
    hosts={urlsplit(s['url']).netloc:s for s in sources if urlsplit(s['url']).netloc not in ('t.me','telegram.me')}
    rows=[]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for f in as_completed([pool.submit(discover,s) for s in hosts.values()]):
            value=f.result()
            if value:rows.append(value)
    out=DATA_ROOT/'data/live/source-discovery.json';out.write_text(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'publishers':rows},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'publishers':len(rows),'available':sum(r['status']=='checked' for r in rows),'channels':len({c for r in rows for c in r['channels']}),'feeds':len({c for r in rows for c in r['feeds']})}))
if __name__=='__main__':main()
