"""Re-run local extraction after a rule correction; retain sources and reviewed events."""
from __future__ import annotations
import argparse,json,datetime,sqlite3
from pathlib import Path
from analysis import is_relevant,needs_ai_review,rule_based
from connectors import FeedDocument
from worker import DEFAULT_DB,open_database,_replace_document_analysis
from geocoding import consume_geocode_jobs

def reprocess(connection,source_ids,*,geocode_limit=1000):
    sources={row['id']:row for row in connection.execute('SELECT * FROM sources WHERE fetch_allowed=1 AND display_allowed=1') if row['id'] in source_ids}
    totals={'documents':0,'eventsUpserted':0,'eventsDeleted':0}
    for source_id,source in sources.items():
        documents=connection.execute("SELECT * FROM documents WHERE source_id=? AND deleted_at IS NULL AND published_at>=datetime('now','-60 days')",(source_id,)).fetchall()
        for row in documents:
            doc=FeedDocument(row['external_id'],row['canonical_url'],row['title'],row['published_at'],row['body'] or '')
            relevant=is_relevant(doc,source)
            events=rule_based(doc) if relevant else []
            result=_replace_document_analysis(connection,row,source,doc,events,correcting_rules=True)
            connection.execute('UPDATE documents SET analysis_status=? WHERE id=?',('rule_based_queued' if needs_ai_review(doc,events,source) else 'rule_based' if relevant else 'irrelevant',row['id']))
            connection.commit()
            totals['documents']+=1
            for key in result:totals[key]+=result[key]
    totals['geocoding']=consume_geocode_jobs(connection,limit=geocode_limit)
    return totals

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',action='append')
    parser.add_argument('--all-approved',action='store_true')
    parser.add_argument('--without-ai',action='store_true',help='Reprocess only sources that are not approved for model analysis')
    parser.add_argument('--db',type=Path,default=DEFAULT_DB)
    parser.add_argument('--geocode-limit',type=int,default=5000)
    args=parser.parse_args()
    if not args.source and not args.all_approved:parser.error('choose --source or --all-approved')
    connection=open_database(args.db)
    backup=args.db.parent.parent/'backups'/('live-before-source-context-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite')
    backup.parent.mkdir(parents=True,exist_ok=True)
    with sqlite3.connect(backup) as target:connection.backup(target)
    source_ids=args.source or [r[0] for r in connection.execute('SELECT id FROM sources WHERE fetch_allowed=1 AND display_allowed=1 AND (?=0 OR ai_allowed=0)',(int(args.without_ai),))]
    print(json.dumps({'backup':str(backup)},ensure_ascii=False),flush=True)
    print(json.dumps(reprocess(connection,source_ids,geocode_limit=args.geocode_limit),ensure_ascii=False),flush=True)
