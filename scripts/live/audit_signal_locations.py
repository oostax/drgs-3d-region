#!/usr/bin/env python3
"""Audit map-worthy events without inventing a location for them."""

from __future__ import annotations

import argparse
import json
import os
import math
import sqlite3
from collections import Counter
from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = DATA_ROOT / "data/live/atlas-live.sqlite"
EXACT_PRECISIONS = {"building", "site", "street"}


def classify(row: sqlite3.Row, data: dict) -> str:
    if (row["address"] and all(isinstance(row[k],(int,float)) and math.isfinite(row[k]) for k in ('longitude','latitude'))
            and abs(row['longitude'])<=180 and abs(row['latitude'])<=90 and row["precision"] in EXACT_PRECISIONS):
        return "verified_map_location"
    localities = set(data.get("localityCandidates") or [])
    candidates = data.get("addressCandidates") or []
    evidence = data.get("locationEvidence") or {}
    if len(localities) > 1:
        return "exclude_multi_site_until_split"
    if candidates and evidence.get("status") in {"ambiguous", "unmatched"}:
        return "review_address_candidate"
    if candidates:
        return "queue_address_candidate"
    if localities:
        return "exclude_locality_only"
    return "exclude_no_address_clue"


def audit(path: Path) -> dict:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    counts: Counter[str] = Counter()
    precisions: Counter[str] = Counter()
    mapped_precisions: Counter[str] = Counter()
    exceptions: list[dict] = []
    rows = connection.execute(
        "SELECT id,title,address,longitude,latitude,precision,data_json FROM events WHERE deleted=0 ORDER BY published_at DESC"
    )
    for row in rows:
        data = json.loads(row["data_json"] or "{}")
        if (data.get("signalUsefulness") or {}).get("showOnMap") is not True:
            continue
        decision = classify(row, data)
        counts[decision] += 1
        precisions[row['precision']] += 1
        if decision == 'verified_map_location':
            mapped_precisions[row['precision']] += 1
        if decision != "verified_map_location":
            exceptions.append({"id": row["id"], "title": row["title"], "decision": decision})
    jobs = dict(connection.execute("SELECT status,count(*) FROM jobs WHERE kind='geocode' GROUP BY status").fetchall())
    connection.close()
    return {"database": str(path), "counts": dict(counts), 'mapEligiblePrecision':dict(precisions),
        'mappedPrecision':dict(mapped_precisions),
        'geocodeJobs':jobs, "exceptions": exceptions}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path(os.getenv("ATLAS_LIVE_DB", DEFAULT_DB)))
    parser.add_argument("--exceptions", action="store_true", help="include every excluded event")
    args = parser.parse_args()
    result = audit(args.db)
    if not args.exceptions:
        result.pop("exceptions")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
