"""Bounded full-article enrichment for already approved public RSS sources."""
from __future__ import annotations

import concurrent.futures
import dataclasses
import datetime as dt
import json
import re
from html.parser import HTMLParser

from connectors import BoundedFetcher, FeedDocument, _same_public_host, iso_now


ARTICLE_VERSION = 'article-body-v2-void-tags'
BODY_CLASSES = {'single__content','article__body','article-content','article-body','news-detail__text','news-text','article-text','entry-content','post-content','page-main__text','news_story'}
VOID_TAGS = {'img','br','hr','meta','link','input','source','wbr','area','base','embed','param','track','col'}


class ArticleBodyParser(HTMLParser):
    """Read the article body, never navigation, publisher address or related news."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack=[]
        self.parts=[]
        self.body_seen=False
        self.jsonld=[]
        self.in_jsonld=False

    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs);classes=set((attrs.get('class') or '').split())
        if tag=='script' and attrs.get('type')=='application/ld+json':self.in_jsonld=True;self.jsonld.append('')
        parent=self.stack[-1][1:] if self.stack else (False,False)
        capture=parent[0] or tag=='article' or attrs.get('itemprop')=='articleBody' or bool(classes & (BODY_CLASSES|{'single__lead'}))
        blocked=parent[1] or tag in {'script','style','aside','nav','footer','form'} or any(
            re.search(r'widget|advert|related|social|single__tm',value) or value in {'share','share-buttons'} for value in classes)
        if capture and not blocked and (tag=='article' or attrs.get('itemprop')=='articleBody' or classes & BODY_CLASSES):self.body_seen=True
        if capture and not blocked and tag in {'p','li','br','tr','h2','h3'}:self.parts.append('\n')
        if tag not in VOID_TAGS:
            self.stack.append((tag,capture,blocked))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag,attrs)
        if tag not in VOID_TAGS:self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag=='script':self.in_jsonld=False
        if tag in VOID_TAGS:return
        # A self-closing <br/> must not pop the paragraph/article scope.
        # Ignore unmatched closing tags instead of consuming another element.
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i][0]==tag:
                _,capture,blocked=self.stack[i]
                del self.stack[i:]
                if capture and not blocked and tag in {'p','li','tr','h2','h3'}:self.parts.append('\n')
                break

    def handle_data(self, data):
        if self.in_jsonld:self.jsonld[-1]+=data
        if self.stack and self.stack[-1][1] and not self.stack[-1][2]:self.parts.append(data)

    def text(self):
        if not self.body_seen:
            bodies=set()
            def visit(value):
                if isinstance(value,list):
                    for item in value:visit(item)
                elif isinstance(value,dict):
                    kinds=value.get('@type',[])
                    if isinstance(kinds,str):kinds=[kinds]
                    if any(k in {'Article','NewsArticle','ReportageNewsArticle'} for k in kinds) and isinstance(value.get('articleBody'),str):bodies.add(value['articleBody'])
                    if '@graph' in value:visit(value['@graph'])
            for raw in self.jsonld:
                try:visit(json.loads(raw))
                except (ValueError,TypeError):continue
            if len(bodies)==1:
                self.body_seen=True
                return next(iter(bodies))[:14000]
        return '\n'.join(line for part in ''.join(self.parts).splitlines() if (line:=' '.join(part.split())))[:14_000]


def parse_article_body(body: bytes) -> str:
    parser=ArticleBodyParser();parser.feed(body.decode('utf-8','replace'))
    return parser.text()


def preserve_enriched_body(connection, previous, document):
    if previous is None:return document
    row=connection.execute("SELECT value FROM checkpoints WHERE source_id='__articles__' AND key=?",(previous['id'],)).fetchone()
    if not row:return document
    from worker import hash_document
    stored=json.loads(row['value'])
    if stored.get('enriched') and stored.get('feedHash')==hash_document(document):
        return dataclasses.replace(document,body=previous['body'])
    return document


def enrich_articles(connection, *, limit: int = 4, timeout: int = 10, source_ids=None, retry_failed: bool = False):
    """At most `limit` requests. One request per host; no discovery/cross-host fetch."""
    from analysis import AnyModelAnalyzer, is_relevant, rule_based
    from worker import hash_document, store_document, _replace_document_analysis
    if limit<=0:return {'selected':0,'enriched':0,'unchanged':0,'failed':0,'newAddressCandidates':0}
    rows=connection.execute(
        "SELECT DISTINCT d.* FROM documents d JOIN sources s ON s.id=d.source_id "
        "JOIN event_documents ed ON ed.document_id=d.id JOIN events e ON e.id=ed.event_id "
        "WHERE d.deleted_at IS NULL AND e.deleted=0 AND e.reviewed=0 "
        "AND s.adapter='rss' AND s.fetch_allowed=1 AND s.display_allowed=1 "
        "ORDER BY CASE WHEN json_extract(e.data_json,'$.signalUsefulness.showOnMap')=1 THEN 0 ELSE 1 END,d.published_at DESC"
    ).fetchall()
    selected=[]
    for row in rows:
        if source_ids and row['source_id'] not in source_ids:continue
        checkpoint=connection.execute("SELECT value FROM checkpoints WHERE source_id='__articles__' AND key=?",(row['id'],)).fetchone()
        if checkpoint:
            checked=json.loads(checkpoint['value'])
            if checked.get('version')!=ARTICLE_VERSION or (retry_failed and checked.get('error')):checked={}
            if checked.get('complete') and checked.get('enrichedHash')==row['content_hash'] and checked.get('retryAfter','')>iso_now():continue
            if row['content_hash'] in {checked.get('feedHash'),checked.get('enrichedHash')} and checked.get('retryAfter','')>iso_now():continue
        source=connection.execute('SELECT * FROM sources WHERE id=?',(row['source_id'],)).fetchone()
        if not _same_public_host(source['url'],row['canonical_url']):continue
        selected.append((row,source))
        if len(selected)>=max(0,limit):break
    totals={'selected':len(selected),'enriched':0,'unchanged':0,'failed':0,'newAddressCandidates':0}
    if not selected or limit<=0:return totals
    fetcher=BoundedFetcher(global_limit=4,per_host_limit=1,timeout=timeout,max_bytes=1_500_000)
    def fetch(item):
        row,source=item
        try:
            result=fetcher.get(row['canonical_url'])
            if not _same_public_host(source['url'],result.final_url):raise ValueError('Article redirected outside approved source host')
            if result.content_type not in {'text/html','application/xhtml+xml'}:raise ValueError('Article is not HTML')
            parser=ArticleBodyParser();parser.feed(result.body.decode('utf-8','replace'))
            body=parser.text()
            if not parser.body_seen or not body:raise ValueError('Article body missing; cannot establish source completeness')
            return row,source,body,None
        except Exception as exc:return row,source,'',f'{type(exc).__name__}: {exc}'[:300]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for row,source,body,error in pool.map(fetch,selected):
            enriched=not error and body!=(row['body'] or '').strip()
            record={'version':ARTICLE_VERSION,'feedHash':row['content_hash'],'checkedAt':iso_now(),'enriched':enriched,'complete':not error,'error':error,'enrichedHash':row['content_hash']}
            previous_checkpoint=connection.execute("SELECT value FROM checkpoints WHERE source_id='__articles__' AND key=?",(row['id'],)).fetchone()
            previous_record=json.loads(previous_checkpoint['value']) if previous_checkpoint else {}
            if previous_record.get('enrichedHash')==row['content_hash'] and previous_record.get('enriched'):
                record['feedHash']=previous_record['feedHash']
                record['enriched']=True
            record['retryAfter']=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=1 if error else 168)).isoformat().replace('+00:00','Z')
            if enriched:
                document=FeedDocument(row['external_id'],row['canonical_url'],row['title'],row['published_at'],body)
                store_document(connection,source,document,AnyModelAnalyzer(),notify_new=False)
                updated=connection.execute('SELECT * FROM documents WHERE id=?',(row['id'],)).fetchone()
                record['enrichedHash']=updated['content_hash']
                events=rule_based(document) if is_relevant(document,source) else []
                _replace_document_analysis(connection,updated,source,document,events,correcting_rules=True)
                totals['enriched']+=1
                totals['newAddressCandidates']+=len({a for event in events for a in event['address_candidates']})
            else:totals['failed' if error else 'unchanged']+=1
            connection.execute("INSERT INTO checkpoints(source_id,key,value,updated_at) VALUES('__articles__',?,?,?) "
                "ON CONFLICT(source_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                (row['id'],json.dumps(record,ensure_ascii=False),iso_now()))
            connection.commit()
            if not error:
                from geocoding import geocode_fresh_events
                geocode_fresh_events(connection,document_id=row["id"],source_ready=True)
    return totals


def pending_article(connection, event_id):
    """RSS snippets cannot support a terminal negative geolocation decision."""
    rows=connection.execute("SELECT d.id,d.content_hash FROM documents d JOIN event_documents ed ON ed.document_id=d.id JOIN sources s ON s.id=d.source_id WHERE ed.event_id=? AND d.deleted_at IS NULL AND s.adapter='rss' AND s.fetch_allowed=1 AND s.display_allowed=1",(event_id,)).fetchall()
    for row in rows:
        checkpoint=connection.execute("SELECT value FROM checkpoints WHERE source_id='__articles__' AND key=?",(row['id'],)).fetchone()
        record=json.loads(checkpoint['value']) if checkpoint else {}
        if record.get('version')!=ARTICLE_VERSION or not record.get('complete') or record.get('enrichedHash')!=row['content_hash']:
            return row['id']
    return None
