#!/usr/bin/env python3
"""Turn an audit into a source-grounded fact/geo review queue.

The script never treats a reachable URL as confirmation and never promotes a
record to reviewed.  It separates context/noise from potentially material
events, then optionally requeues only the latter for the existing evidence-
quoting analyzer.  Existing editor-reviewed records are preserved.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_AUDIT = ROOT / "artifacts/signal-audit-current.json"
DEFAULT_DB = ROOT / "data/live/atlas-live.sqlite"
DEFAULT_OUTPUT = ROOT / "artifacts/signal-refinement"


def review_disposition(row: dict[str, Any], raw: dict[str, Any]) -> str:
    usefulness = raw.get("signalUsefulness") or {}
    dimensions = usefulness.get("dimensions") or {}
    if row["auditResult"] == "ready":
        return "publish_ready"
    if usefulness.get("level") == "noise":
        return "exclude_noise"
    material = any((dimensions.get(key) or 0) >= 2 for key in ("actionability", "specificity", "significance"))
    reasons = set(row.get("reasons") or [])
    if material:
        if row.get("precision") in {"territory", "settlement"}:
            return "fact_and_geo_recheck"
        if reasons & {"stale_open_status", "open_state_text_looks_finished", "resolved_text_looks_open"}:
            return "fact_and_lifecycle_recheck"
        return "fact_recheck"
    return "context_only"


def load_rows(audit: Path, connection: sqlite3.Connection) -> list[dict[str, Any]]:
    raw_by_id = {
        item["id"]: json.loads(item["data_json"] or "{}")
        for item in connection.execute("SELECT id,data_json FROM events WHERE deleted=0")
    }
    report = json.loads(audit.read_text(encoding="utf-8"))
    rows = []
    for row in report["signals"]:
        raw = raw_by_id.get(row["id"], {})
        rows.append({**row, "disposition": review_disposition(row, raw)})
    return rows


def requeue(connection: sqlite3.Connection, rows: list[dict[str, Any]]) -> dict[str, int]:
    eligible = {
        row["id"] for row in rows
        if row["disposition"].startswith("fact_") and not row["reviewed"]
    }
    if not eligible:
        return {"events": 0, "documents": 0}
    placeholders = ",".join("?" for _ in eligible)
    documents = connection.execute(
        f"""SELECT DISTINCT d.id FROM documents d
            JOIN event_documents ed ON ed.document_id=d.id
            JOIN events e ON e.id=ed.event_id
            JOIN sources s ON s.id=d.source_id
            WHERE e.id IN ({placeholders}) AND e.deleted=0 AND e.reviewed=0
              AND d.deleted_at IS NULL AND s.ai_allowed=1""",
        tuple(sorted(eligible)),
    ).fetchall()
    document_ids = [row["id"] for row in documents]
    if document_ids:
        marks = ",".join("?" for _ in document_ids)
        connection.execute(
            f"""UPDATE documents SET analysis_status='rule_based_queued',
                analysis_attempts=0,analysis_next_attempt_at=NULL,analysis_error=NULL
                WHERE id IN ({marks})""",
            tuple(document_ids),
        )
    return {"events": len(eligible), "documents": len(document_ids)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--apply", action="store_true", help="queue material, unreviewed records for source-only AI analysis")
    args = parser.parse_args()
    connection = sqlite3.connect(args.db, timeout=30, isolation_level=None)
    connection.row_factory = sqlite3.Row
    rows = load_rows(args.audit, connection)
    applied: dict[str, int] | None = None
    if args.apply:
        backup = args.db.parent.parent / "backups" / ("live-before-review-refinement-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S") + ".sqlite")
        backup.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(backup) as target:
            connection.backup(target)
        connection.execute("BEGIN IMMEDIATE")
        try:
            applied = {"backup": str(backup), **requeue(connection, rows)}  # type: ignore[dict-item]
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    connection.close()
    summary = {
        "auditedSignals": len(rows),
        "dispositions": dict(Counter(row["disposition"] for row in rows)),
        "note": "Context/noise is not promoted to the map. Requeued rows remain unreviewed until their source-quoted analysis and geolocation checks complete.",
        "applied": applied,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix(".json").write_text(json.dumps({"summary": summary, "signals": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    fields = list(dict.fromkeys(key for row in rows for key in row))
    with args.output.with_suffix(".csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({**row, "reasons": "|".join(row.get("reasons") or []), "warnings": "|".join(row.get("warnings") or [])})
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
