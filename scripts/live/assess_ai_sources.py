#!/usr/bin/env python3
"""Assess whether each active source benefits from local, conditional, or permanent AI."""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from analysis import event_date_candidates, extract_addresses, is_relevant, rule_based
from connectors import FeedDocument
from worker import DEFAULT_DB, open_database

TATAR = re.compile(r"[ӘәӨөҮүҖҗҢңҺһ]")
STRUCTURED_ADAPTERS = {"vodokanal-incidents"}


def ratio(value: int, total: int) -> float:
    return round(value / total, 3) if total else 0.0


def recommendation(metrics: dict[str, int | float | str]) -> tuple[str, str]:
    docs = int(metrics["documents"])
    relevant = int(metrics["relevantDocuments"])
    if metrics["adapter"] in STRUCTURED_ADAPTERS:
        return "local_only", "Структурированный шаблон: локальный парсер точнее и дешевле модели."
    if not docs or not relevant:
        return "local_only", "За окно нет локально значимых публикаций для модельного разбора."
    tatar_rate = ratio(int(metrics["tatarRelevant"]), relevant)
    complex_rate = ratio(int(metrics["complexRelevant"]), relevant)
    useful_rate = ratio(int(metrics["usefulDocuments"]), docs)
    if relevant >= 3 and tatar_rate >= 0.6:
        return "permanent_ai", "Большинство релевантных публикаций на татарском: нужны перевод и семантическое разделение событий."
    if relevant >= 4 and complex_rate >= 0.5 and useful_rate >= 0.08:
        return "permanent_ai", "Поток преимущественно многособытийный или содержит несколько дат и адресов."
    if int(metrics["complexRelevant"]) or int(metrics["tatarRelevant"]):
        return "conditional_ai", "Модель нужна только для татарского текста, нескольких событий, дат, адресов или длинного материала."
    return "local_only", "Короткие русскоязычные публикации устойчиво разбираются локальными правилами."


def assess(connection: sqlite3.Connection, days: int) -> list[dict[str, object]]:
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).isoformat()
    sources = connection.execute(
        "SELECT * FROM sources WHERE fetch_allowed=1 AND display_allowed=1 ORDER BY name"
    ).fetchall()
    result: list[dict[str, object]] = []
    for source in sources:
        documents = connection.execute(
            "SELECT d.*,u.data_json usefulness_json FROM documents d "
            "LEFT JOIN document_usefulness u ON u.document_id=d.id "
            "WHERE d.source_id=? AND d.status='active' AND d.deleted_at IS NULL "
            "AND d.published_at>=? ORDER BY d.published_at DESC",
            (source["id"], cutoff),
        ).fetchall()
        counts = Counter()
        for row in documents:
            document = FeedDocument(row["external_id"], row["canonical_url"], row["title"], row["published_at"], row["body"] or "")
            relevant = is_relevant(document, source)
            events = rule_based(document) if relevant else []
            text = f"{document.title}\n{document.body}"
            tatar = bool(TATAR.search(text))
            multiple_dates = len(event_date_candidates(text, document.published_at)) > 1
            multiple_addresses = len(extract_addresses(text)) > 1
            multiple_events = len(events) > 1
            long_document = len(text) > 2600
            if relevant:
                counts["relevant"] += 1
                counts["tatar"] += int(tatar)
                counts["multiDate"] += int(multiple_dates)
                counts["multiAddress"] += int(multiple_addresses)
                counts["multiEvent"] += int(multiple_events)
                counts["long"] += int(long_document)
                counts["complex"] += int(tatar or multiple_dates or multiple_addresses or multiple_events or long_document)
            usefulness = json.loads(row["usefulness_json"] or "{}")
            counts["useful"] += int(usefulness.get("showOnMap") is True)
            counts["complete"] += int(row["analysis_status"] == "complete")
            counts["failed"] += int(row["analysis_status"] == "failed")
        event_count = connection.execute(
            "SELECT COUNT(DISTINCT e.id) FROM events e JOIN event_documents ed ON ed.event_id=e.id "
            "JOIN documents d ON d.id=ed.document_id WHERE d.source_id=? AND e.deleted=0 AND d.published_at>=?",
            (source["id"], cutoff),
        ).fetchone()[0]
        metrics: dict[str, object] = {
            "sourceId": source["id"], "name": source["name"], "adapter": source["adapter"],
            "sourceKind": source["source_kind"], "currentAiAllowed": bool(source["ai_allowed"]),
            "documents": len(documents), "relevantDocuments": counts["relevant"],
            "usefulDocuments": counts["useful"], "activeEvents": event_count,
            "tatarRelevant": counts["tatar"], "multiDateRelevant": counts["multiDate"],
            "multiAddressRelevant": counts["multiAddress"], "multiEventRelevant": counts["multiEvent"],
            "longRelevant": counts["long"], "complexRelevant": counts["complex"],
            "aiCompleted": counts["complete"], "aiFailed": counts["failed"],
        }
        policy, reason = recommendation(metrics)
        metrics.update({"recommendedPolicy": policy, "reason": reason})
        result.append(metrics)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/source-ai-assessment")
    args = parser.parse_args()
    connection = open_database(args.db)
    rows = assess(connection, args.days)
    summary = Counter(str(row["recommendedPolicy"]) for row in rows)
    payload = {"generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "days": args.days,
               "sources": len(rows), "policies": dict(summary), "items": rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix(".json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    with args.output.with_suffix(".csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]) if rows else [])
        writer.writeheader(); writer.writerows(rows)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
