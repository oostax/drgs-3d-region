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
    all_counts: Counter[str] = Counter()
    all_precisions: Counter[str] = Counter()
    resolution_counts: Counter[str] = Counter()
    inventory=[]
    quality_counts=Counter()
    from location_quality import VERSION as QUALITY_VERSION
    rows = connection.execute(
        "SELECT id,title,address,longitude,latitude,precision,data_json FROM events WHERE deleted=0 ORDER BY published_at DESC"
    )
    for row in rows:
        data = json.loads(row["data_json"] or "{}")
        resolution=(data.get('locationResolution') or {}).get('status','not_required_or_pending')
        resolution_counts[resolution]+=1
        evidence=data.get('locationEvidence') or {}
        quality_counts['current_rules' if evidence.get('qualityVersion')==QUALITY_VERSION else 'needs_current_rules_review']+=1
        if evidence.get('coverage')=='partial':quality_counts['partially_located_multi_address']+=1
        if evidence.get('eventGeometryConfirmed'):quality_counts['source_bounded_geometry']+=1
        if data.get('rejectedContactAddresses'):quality_counts['contact_address_rejected']+=1
        if (data.get('locationSourceQuality') or {}).get('status')=='awaiting_full_article':quality_counts['awaiting_full_article']+=1
        inventory.append({'id':row['id'],'title':row['title'],'precision':row['precision'],'address':row['address'],
            'decision':classify(row,data),'resolutionStatus':resolution,
            'addressCandidates':data.get('addressCandidates',[]),'locationEvidence':data.get('locationEvidence'),
            'locationResolution':data.get('locationResolution')})
        all_counts[classify(row,data)] += 1
        all_precisions[row["precision"]] += 1
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
    from article_enrichment import ARTICLE_VERSION
    article_counts=Counter()
    for row in connection.execute("SELECT d.content_hash,c.value FROM documents d JOIN sources s ON s.id=d.source_id LEFT JOIN checkpoints c ON c.source_id='__articles__' AND c.key=d.id WHERE d.deleted_at IS NULL AND s.adapter='rss' AND s.fetch_allowed=1 AND s.display_allowed=1 AND EXISTS(SELECT 1 FROM event_documents ed JOIN events e ON e.id=ed.event_id WHERE ed.document_id=d.id AND e.deleted=0)"):
        checkpoint=json.loads(row['value'] or '{}')
        complete=checkpoint.get('version')==ARTICLE_VERSION and checkpoint.get('complete') and checkpoint.get('enrichedHash')==row['content_hash']
        article_counts['full_article_checked' if complete else 'full_article_pending']+=1
    connection.close()
    return {"database": str(path), "totalEvents":sum(all_counts.values()), "qualityReview":dict(quality_counts), "articleCoverage":dict(article_counts), "allEventDecisions":dict(all_counts), "allEventPrecision":dict(all_precisions), "resolutionStatus":dict(resolution_counts),"inventory":inventory, "counts": dict(counts), 'mapEligiblePrecision':dict(precisions),
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
        result.pop("inventory")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
