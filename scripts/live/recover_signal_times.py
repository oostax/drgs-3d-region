"""Restore source-stated event clocks without reanalysing or relocating events."""
from __future__ import annotations
import argparse
import datetime as dt
import json
import sqlite3
from pathlib import Path
from analysis import event_timestamp_candidates


def candidates(connection):
    connection.row_factory = sqlite3.Row
    changes = []
    for event in connection.execute("SELECT id,event_time FROM events WHERE deleted=0 AND event_time IS NOT NULL"):
        stamps = set()
        for doc in connection.execute("SELECT ee.quote,d.title,d.body,d.excerpt,d.published_at FROM event_evidence ee JOIN documents d ON d.id=ee.document_id WHERE ee.event_id=?", (event['id'],)):
            quote=doc['quote'] or ''
            source=doc['title']+'\n'+(doc['body'] or doc['excerpt'])
            if quote and quote in source:
                stamps.update(stamp for stamp in event_timestamp_candidates(quote,doc['published_at']) if stamp[:10]==event['event_time'][:10])
        value=event['event_time']
        after=next(iter(stamps)) if len(stamps)==1 else None
        if len(value)>10:
            # Legacy model output frequently represented a bare date as 00:00.
            # Retain a real midnight only with the same direct source evidence.
            parsed=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
            if parsed.hour!=0 or parsed.minute!=0 or parsed.second!=0: continue
            after=after or value[:10]
        if after and after!=value:
            changes.append({'id':event['id'],'before':value,'after':after})
    return changes


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',default='data/live/atlas-live.sqlite')
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    path=Path(args.db).resolve()
    connection=sqlite3.connect(f'file:{path}?mode={"rw" if args.apply else "ro"}',uri=True,timeout=30)
    changes=candidates(connection)
    backup=None
    if args.apply and changes:
        backup=path.parent.parent/'backups'/f'live-before-time-recovery-{dt.datetime.now().strftime("%Y%m%d-%H%M%S")}.sqlite'
        backup.parent.mkdir(parents=True,exist_ok=True)
        with sqlite3.connect(backup) as target: connection.backup(target)
        stamp=dt.datetime.now(dt.timezone.utc).isoformat()
        with connection:
            for change in changes:
                updated=connection.execute('UPDATE events SET event_time=?,updated_at=? WHERE id=? AND event_time=?',(change['after'],stamp,change['id'],change['before']))
                if updated.rowcount:
                    revision=connection.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,'upsert',0,?)",(change['id'],stamp)).lastrowid
                    connection.execute('UPDATE events SET revision=? WHERE id=?',(revision,change['id']))
    print(json.dumps({'applied':args.apply,'backup':str(backup) if backup else None,'changes':changes},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
