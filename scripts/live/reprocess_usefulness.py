"""Rescore retained public material without changing source facts or event dates."""
from __future__ import annotations
import argparse,collections,datetime,json,sqlite3
from pathlib import Path
from connectors import FeedDocument,iso_now
from usefulness import classify_usefulness
from analysis import summarize_signal_text
from worker import open_database,DEFAULT_DB,export_data

def refresh(connection):
    now=iso_now();counts=collections.Counter();changed=0;summaries=0
    sources={r['id']:r for r in connection.execute('SELECT * FROM sources')}
    documents={r['id']:r for r in connection.execute('SELECT * FROM documents WHERE deleted_at IS NULL')}
    converted={i:FeedDocument(d['external_id'],d['canonical_url'],d['title'],d['published_at'],d['body'] or '') for i,d in documents.items()}
    # Retain reasons even for acquired publications that have no map event.
    for document_id,doc in converted.items():
        score=classify_usefulness(doc,source=sources[documents[document_id]['source_id']])
        connection.execute('INSERT INTO document_usefulness(document_id,data_json,assessed_at) VALUES(?,?,?) ON CONFLICT(document_id) DO UPDATE SET data_json=excluded.data_json,assessed_at=excluded.assessed_at',(document_id,json.dumps(score,ensure_ascii=False),now))
    connection.commit()
    for row in connection.execute('SELECT * FROM events WHERE deleted=0').fetchall():
        data=json.loads(row['data_json'] or '{}');scores=[]
        linked=[]
        for link in connection.execute('SELECT document_id FROM event_documents WHERE event_id=?',(row['id'],)):
            doc=converted.get(link['document_id'])
            if doc:
                linked.append(doc)
                source=sources[documents[link['document_id']]['source_id']]
                scores.append(classify_usefulness(doc,data,source))
        if not scores:
            # Legacy records keep their source, dates and review; score their
            # retained factual text, never synthesize source certainty.
            doc=FeedDocument(row['id'],data.get('sourceUrl',''),row['title'],row['published_at'],row['summary'])
            scores=[classify_usefulness(doc,data)]
        score=max(scores,key=lambda v:(v['showOnMap'],v['score']))
        counts[score['level']]+=1
        summary=row['summary']
        if data.get('analysis_status')=='rule_based' and linked:
            document=max(linked,key=lambda item:len(item.body or ''))
            summary=summarize_signal_text(row['title'],document.body)
        metadata_changed=data.get('signalUsefulness')!=score
        summary_changed=summary!=row['summary']
        if not metadata_changed and not summary_changed:continue
        data['signalUsefulness']=score
        revision=connection.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,'upsert',0,?)",(row['id'],now)).lastrowid
        # These columns deliberately exclude published/event/evidence/activity
        # timestamps and geography. A filter refresh is not new evidence.
        connection.execute('UPDATE events SET summary=?,data_json=?,revision=?,notify_eligible=0 WHERE id=?',(summary,json.dumps(data,ensure_ascii=False),revision,row['id']))
        changed+=1
        summaries+=int(summary_changed)
    connection.commit()
    return {'documents':len(documents),'eventsUpdated':changed,'summariesUpdated':summaries,'levels':dict(counts)}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--db',type=Path,default=DEFAULT_DB);args=parser.parse_args()
    backup=args.db.parent.parent/'backups'/('live-before-usefulness-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite');backup.parent.mkdir(parents=True,exist_ok=True)
    with sqlite3.connect(args.db) as source,sqlite3.connect(backup) as target:source.backup(target)
    c=open_database(args.db)
    print(json.dumps({'backup':str(backup)},ensure_ascii=False),flush=True)
    result=refresh(c);result['export']=export_data(c,args.db.parent/'export');result['integrity']=c.execute('PRAGMA quick_check').fetchone()[0]
    print(json.dumps(result,ensure_ascii=False),flush=True)
