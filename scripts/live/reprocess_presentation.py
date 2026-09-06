"""Refresh automatic signal titles and lifecycle labels from retained source evidence."""
from __future__ import annotations

import argparse
import datetime
import json
import sqlite3
from pathlib import Path

from analysis import infer_state, normalize_signal_title
from connectors import iso_now
from worker import DEFAULT_DB, open_database, export_data


def refresh(connection: sqlite3.Connection) -> dict[str, int]:
    now = iso_now()
    changed_titles = changed_states = skipped_reviewed = 0
    rows = connection.execute(
        """SELECT e.*, d.title AS document_title, d.body AS document_body
           FROM events e
           JOIN event_documents ed ON ed.event_id=e.id
           JOIN documents d ON d.id=ed.document_id
           WHERE e.deleted=0 AND d.deleted_at IS NULL
           ORDER BY e.id, d.published_at DESC"""
    ).fetchall()
    seen: set[str] = set()
    for row in rows:
        if row['id'] in seen:
            continue
        seen.add(row['id'])
        if row['reviewed']:
            skipped_reviewed += 1
            continue
        data = json.loads(row['data_json'] or '{}')
        title = normalize_signal_title(row['title'], row['document_title'], row['document_body'] or '', row['topic'])
        evidence = '\n'.join(item.get('quote', '') for item in data.get('evidence', []) if isinstance(item, dict))
        state = infer_state(evidence or f"{row['document_title']}\n{row['document_body'] or ''}", row['topic'])
        if title == row['title'] and state == row['state']:
            continue
        changed_titles += int(title != row['title'])
        changed_states += int(state != row['state'])
        data['title'] = title
        data['state'] = state
        revision = connection.execute(
            "INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,'upsert',0,?)",
            (row['id'], now),
        ).lastrowid
        connection.execute(
            "UPDATE events SET title=?,state=?,data_json=?,revision=?,notify_eligible=0,updated_at=? WHERE id=?",
            (title, state, json.dumps(data, ensure_ascii=False), revision, now, row['id']),
        )
    connection.commit()
    return {'eventsScanned': len(seen), 'titlesUpdated': changed_titles, 'statesUpdated': changed_states, 'reviewedSkipped': skipped_reviewed}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=DEFAULT_DB)
    args = parser.parse_args()
    backup = args.db.parent.parent / 'backups' / ('live-before-presentation-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.sqlite')
    backup.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(args.db) as source, sqlite3.connect(backup) as target:
        source.backup(target)
    connection = open_database(args.db)
    print(json.dumps({'backup': str(backup)}, ensure_ascii=False), flush=True)
    result = refresh(connection)
    result['export'] = export_data(connection, args.db.parent / 'export')
    result['integrity'] = connection.execute('PRAGMA quick_check').fetchone()[0]
    print(json.dumps(result, ensure_ascii=False), flush=True)
