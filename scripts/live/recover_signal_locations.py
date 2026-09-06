"""Requeue historical location evidence without recreating or deleting signals."""
import argparse
import datetime as dt
import json
import sqlite3
from pathlib import Path
from worker import open_database, DEFAULT_DB
from geocoding import enqueue_geocode_job, consume_geocode_jobs, GEOCODER_VERSION
from audit_signal_locations import audit


def enqueue_recovery(connection):
    queued = 0
    for event in connection.execute("SELECT * FROM events WHERE deleted=0 AND reviewed=0 ORDER BY published_at DESC").fetchall():
        data = json.loads(event['data_json'] or '{}')
        document = connection.execute('SELECT d.source_id,d.content_hash FROM documents d JOIN event_documents ed ON ed.document_id=d.id WHERE ed.event_id=? AND d.deleted_at IS NULL ORDER BY d.published_at DESC LIMIT 1', (event['id'],)).fetchone()
        if document is None:
            continue
        queued += enqueue_geocode_job(connection,event['id'],document['source_id'],data.get('addressCandidates') or [],'recovery|'+document['content_hash'])
    return queued


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,default=DEFAULT_DB)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--consume',type=int,default=0,help='Only with the daemon stopped; 0 leaves jobs for the daemon')
    args = parser.parse_args()
    report = {'version':GEOCODER_VERSION,'before':audit(args.db)}
    report['before'].pop('exceptions',None)
    if args.apply:
        # Do not run worker startup migrations while its analysis is active.
        connection = sqlite3.connect(args.db,timeout=30,isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        backup = args.db.parent.parent/'backups'/('live-before-location-recovery-'+dt.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite')
        backup.parent.mkdir(parents=True,exist_ok=True)
        with sqlite3.connect(backup) as target:
            connection.backup(target)
        report['backup'] = str(backup)
        report['queued'] = enqueue_recovery(connection)
        if args.consume:
            report['processed'] = consume_geocode_jobs(connection,limit=args.consume)
        connection.close()
        report['after'] = audit(args.db)
        report['after'].pop('exceptions',None)
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
