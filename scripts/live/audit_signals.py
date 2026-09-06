#!/usr/bin/env python3
"""Audit every active signal without turning inference into fact.

The audit separates editorial usefulness, evidence, lifecycle, card completeness,
and map/scene readiness. Optional URL probes only verify source reachability; they
do not claim that a later page independently confirms the event.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import datetime as dt
import json
import re
import sqlite3
import ssl
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data/live/atlas-live.sqlite"
DEFAULT_OUTPUT = ROOT / "artifacts/signal-audit"
EXACT_PRECISIONS = {"street", "building", "site"}
ACTIVE_STATES = {"reported", "planned", "in_progress", "paused"}
FINISHED = re.compile(r"\b(?:завершен|завершён|завершили|введен|введён|открыли|устранили|восстановили|готов)\w*\b", re.I)
FUTURE = re.compile(r"\b(?:планиру|предстоит|начнут|построят|откроют|завершат|ожидается)\w*\b", re.I)
WORKING = re.compile(r"\b(?:ведутся|идут|начались|приступили|строится|ремонтируют)\w*\b", re.I)
try:
    import certifi
    TLS_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    TLS_CONTEXT = ssl.create_default_context()


def parse_time(value: str | None) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat((value or "").replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError):
        return None


def probe(url: str) -> dict[str, Any]:
    parts = urllib.parse.urlsplit(url)
    normalized = urllib.parse.urlunsplit((parts.scheme, parts.netloc.encode("idna").decode("ascii"), urllib.parse.quote(urllib.parse.unquote(parts.path), safe="/%:@"), urllib.parse.quote_plus(urllib.parse.unquote_plus(parts.query), safe="=&%:@"), parts.fragment))
    request = urllib.request.Request(normalized, headers={"User-Agent": "SberAtlasSignalAudit/1.0", "Range": "bytes=0-4095"})
    try:
        with urllib.request.urlopen(request, timeout=8, context=TLS_CONTEXT) as response:
            return {"sourceReachable": True, "sourceHttpStatus": int(response.status), "sourceFinalUrl": response.geturl()}
    except urllib.error.HTTPError as error:
        return {"sourceReachable": error.code < 500, "sourceHttpStatus": error.code, "sourceFinalUrl": error.geturl()}
    except Exception as error:
        return {"sourceReachable": False, "sourceHttpStatus": None, "sourceProbeError": type(error).__name__}


def audit_row(row: sqlite3.Row, now: dt.datetime, source_probe: dict[str, Any] | None) -> dict[str, Any]:
    raw = json.loads(row["data_json"] or "{}")
    usefulness = raw.get("signalUsefulness") or {}
    text = f'{row["title"]}\n{row["summary"]}'
    reasons: list[str] = []
    warnings: list[str] = []
    evidence_ready = row["evidence_count"] > 0 and row["document_count"] > 0 and bool(raw.get("sourceUrl"))
    if not evidence_ready: reasons.append("missing_primary_evidence")
    if not str(row["title"] or "").strip(): reasons.append("missing_title")
    if len(str(row["summary"] or "").strip()) < 35: reasons.append("summary_too_short")
    if not raw.get("facts"): warnings.append("missing_supported_facts")
    if not raw.get("nextStep"): warnings.append("missing_next_step")
    if usefulness.get("level") != "useful" or usefulness.get("showOnMap") is not True:
        reasons.append("not_editorially_useful")

    state = row["state"]
    if state == "resolved" and (FUTURE.search(text) or WORKING.search(text)) and not FINISHED.search(text):
        reasons.append("resolved_text_looks_open")
    if state in {"planned", "in_progress"} and FINISHED.search(text) and not (FUTURE.search(text) or WORKING.search(text)):
        reasons.append("open_state_text_looks_finished")
    published = parse_time(row["published_at"])
    meaningful = parse_time(row["last_meaningful_at"])
    if published and published > now + dt.timedelta(hours=2): reasons.append("future_publication_time")
    if state in ACTIVE_STATES and meaningful and now - meaningful > dt.timedelta(days=45):
        reasons.append("stale_open_status")

    coordinates = row["longitude"] is not None and row["latitude"] is not None
    exact_location = coordinates and row["precision"] in EXACT_PRECISIONS and bool(str(row["address"] or "").strip())
    if coordinates and not str(row["address"] or "").strip(): reasons.append("coordinates_without_address")
    if row["precision"] in EXACT_PRECISIONS and not coordinates: reasons.append("precision_without_coordinates")
    if exact_location and not (raw.get("coordinateSourceUrl") or raw.get("addressSourceUrl") or raw.get("locationVerificationMethod")):
        warnings.append("location_provenance_missing")

    source_reachable = None if source_probe is None else source_probe.get("sourceReachable")
    if source_reachable is False: warnings.append("source_unreachable_at_audit")
    publish_ready = not reasons and evidence_ready
    scene_ready = bool(publish_ready and exact_location and row["explicit_activity"] and state == "in_progress" and meaningful and now - meaningful <= dt.timedelta(days=30))
    result = {
        "id": row["id"], "legacyId": row["legacy_id"], "title": row["title"], "state": state,
        "publishedAt": row["published_at"], "lastEvidenceAt": row["last_evidence_at"],
        "territoryId": row["territory_id"], "precision": row["precision"], "address": row["address"],
        "longitude": row["longitude"], "latitude": row["latitude"], "confidence": row["confidence"],
        "sourceKind": row["source_kind"], "sourceUrl": raw.get("sourceUrl", ""),
        "usefulnessLevel": usefulness.get("level", "unknown"), "usefulnessScore": usefulness.get("score"),
        "reviewed": bool(row["reviewed"]), "evidenceCount": row["evidence_count"], "documentCount": row["document_count"],
        "publishReady": publish_ready, "mapReady": bool(publish_ready and exact_location), "sceneReady": scene_ready,
        "auditResult": "ready" if publish_ready else "needs_review", "reasons": reasons, "warnings": warnings,
    }
    if source_probe: result.update(source_probe)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check-urls", action="store_true")
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    connection = sqlite3.connect(args.db)
    connection.row_factory = sqlite3.Row
    rows = connection.execute("""
      SELECT e.*,
        (SELECT COUNT(*) FROM event_evidence v WHERE v.event_id=e.id) evidence_count,
        (SELECT COUNT(*) FROM event_documents d WHERE d.event_id=e.id) document_count
      FROM events e WHERE e.deleted=0 ORDER BY e.published_at DESC,e.id
    """).fetchall()
    urls = sorted({json.loads(row["data_json"] or "{}").get("sourceUrl", "") for row in rows} - {""})
    probes: dict[str, dict[str, Any]] = {}
    if args.check_urls:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 12))) as pool:
            probes = dict(zip(urls, pool.map(probe, urls)))
    now = dt.datetime.now(dt.timezone.utc)
    audited = [audit_row(row, now, probes.get(json.loads(row["data_json"] or "{}").get("sourceUrl", "")) if args.check_urls else None) for row in rows]
    reason_counts = Counter(reason for item in audited for reason in item["reasons"])
    warning_counts = Counter(reason for item in audited for reason in item["warnings"])
    summary = {
        "generatedAt": now.isoformat(), "database": str(args.db), "activeSignals": len(audited),
        "reviewed": sum(item["reviewed"] for item in audited),
        "publishReady": sum(item["publishReady"] for item in audited),
        "mapReady": sum(item["mapReady"] for item in audited),
        "sceneReady": sum(item["sceneReady"] for item in audited),
        "needsReview": sum(item["auditResult"] == "needs_review" for item in audited),
        "sourceUrlsChecked": len(probes),
        "sourceUrlsReachable": sum(probe_result.get("sourceReachable") is True for probe_result in probes.values()),
        "reasons": dict(reason_counts.most_common()), "warnings": dict(warning_counts.most_common()),
        "methodNote": "Reachability checks transport only. Accuracy remains source-grounded and unresolved contradictions stay in needs_review.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix(".json").write_text(json.dumps({"summary": summary, "signals": audited}, ensure_ascii=False, indent=2), encoding="utf-8")
    with args.output.with_suffix(".csv").open("w", encoding="utf-8-sig", newline="") as handle:
        keys = sorted({key for item in audited for key in item if key not in {"reasons", "warnings"}}) + ["reasons", "warnings"] if audited else []
        writer = csv.DictWriter(handle, fieldnames=keys); writer.writeheader()
        for item in audited: writer.writerow({**item, "reasons": "|".join(item["reasons"]), "warnings": "|".join(item["warnings"])})
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
