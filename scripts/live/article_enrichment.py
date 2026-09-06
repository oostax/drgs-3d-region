"""Bounded full-article enrichment for already approved public RSS sources."""
from __future__ import annotations

import concurrent.futures
import dataclasses
import datetime as dt
import json
import re
from html.parser import HTMLParser

from connectors import BoundedFetcher, FeedDocument, _same_public_host, iso_now


class ArticleBodyParser(HTMLParser):
    """Read the article body, never navigation, publisher address or related news."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack=[]
        self.parts=[]

    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs);classes=set((attrs.get('class') or '').split())
        parent=self.stack[-1] if self.stack else (False,False)
        capture=parent[0] or attrs.get('itemprop')=='articleBody' or bool(classes & {
            'single__lead','single__content','article__body','article-content','news-detail__text','news-text','article-text'})
        blocked=parent[1] or tag in {'script','style','aside','nav','footer','form'} or any(
            re.search(r'widget|advert|related|social|single__tm',value) or value in {'share','share-buttons'} for value in classes)
        if capture and not blocked and tag in {'p','li','br','tr','h2','h3'}:self.parts.append('\n')
        if tag not in {'img','br','hr','meta','link','input','source','wbr','area','base','embed'}:
            self.stack.append((capture,blocked))

    def handle_endtag(self, tag):
        if self.stack:
            capture,blocked=self.stack.pop()
            if capture and not blocked and tag in {'p','li','tr','h2','h3'}:self.parts.append('\n')

    def handle_data(self, data):
        if self.stack and self.stack[-1][0] and not self.stack[-1][1]:self.parts.append(data)

    def text(self):
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


def enrich_articles(connection, *, limit: int = 4, timeout: int = 10, source_ids=None):
    """At most `limit` requests. One request per host; no discovery/cross-host fetch."""
    from analysis import AnyModelAnalyzer, is_relevant, rule_based
    from worker import hash_document, store_document, _replace_document_analysis
    if limit<=0:return {'selected':0,'enriched':0,'unchanged':0,'failed':0,'newAddressCandidates':0}
    rows=connection.execute(
        "SELECT DISTINCT d.* FROM documents d JOIN sources s ON s.id=d.source_id "
        "JOIN event_documents ed ON ed.document_id=d.id JOIN events e ON e.id=ed.event_id "
        "WHERE d.deleted_at IS NULL AND e.deleted=0 AND e.precision='territory' "
        "AND s.adapter='rss' AND s.fetch_allowed=1 AND s.display_allowed=1 "
        "AND d.published_at>=datetime('now','-60 days') AND length(d.body)<650 "
        "AND e.topic IN ('roads','utilities','construction','waste','fire','flood','landscape','education','health') "
        "ORDER BY CASE WHEN e.territory_id='mo-92701000' THEN 1 ELSE 0 END,d.published_at DESC"
    ).fetchall()
    selected=[]
    for row in rows:
        if source_ids and row['source_id'] not in source_ids:continue
        checkpoint=connection.execute("SELECT value FROM checkpoints WHERE source_id='__articles__' AND key=?",(row['id'],)).fetchone()
        if checkpoint:
            checked=json.loads(checkpoint['value'])
            if checked.get('enrichedHash')==row['content_hash']:continue
            if checked.get('feedHash')==row['content_hash'] and checked.get('retryAfter','9999')>iso_now():continue
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
            return row,source,parse_article_body(result.body),None
        except Exception as exc:return row,source,'',f'{type(exc).__name__}: {exc}'[:300]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for row,source,body,error in pool.map(fetch,selected):
            enriched=len(body)>len(row['body'] or '')+80
            record={'feedHash':row['content_hash'],'checkedAt':iso_now(),'enriched':enriched,'error':error}
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
    return totals
