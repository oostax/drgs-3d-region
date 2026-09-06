#!/usr/bin/env python3
"""Offline editorial geography overlay. Reads public records only; no geocoder/API."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from urllib.parse import urlsplit


def source_url(value):
    parsed = urlsplit(value or "")
    return parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password


def apply_evidence(signals, evidence):
    """Retain every ID and apply reviewed patches to exact article URLs, idempotently."""
    result = copy.deepcopy(signals)
    by_id = {s["id"]: s for s in result}
    urls = {s["sourceUrl"] for s in result}
    report = {"applied": [], "added": [], "rejected": [], "publisherLocationsRemoved": 0}
    for signal in result:
        if signal.get("geographyMethod") == "publisher-territory-scope" and not signal.get("coordinates"):
            signal.update(territoryId="RU-TA", geographyMethod="regional-source-scope")
            report["publisherLocationsRemoved"] += 1
    for item in evidence.get("records", []):
        sid, url = item.get("id"), item.get("sourceUrl")
        patch, review = item.get("patch", {}), item.get("review", {})
        # Coordinates require an explicit event-location review and a public
        # geometry source. An organisation/publisher address is insufficient.
        if not sid or not source_url(url) or not review.get("checkedAt") or not review.get("basis"):
            report["rejected"].append(sid)
            continue
        if patch.get("coordinates") is not None and (
            review.get("locationConfirmed") is not True
            or not source_url(patch.get("coordinateSourceUrl"))
            or not patch.get("locationVerificationMethod")
            or patch.get("precision") not in ("building", "site", "street")
        ):
            report["rejected"].append(sid)
            continue
        signal = by_id.get(sid)
        if signal is None:
            seed = item.get("seed")
            if not seed or url in urls or seed.get("id") != sid or seed.get("sourceUrl") != url or seed.get("visibility") != "public":
                report["rejected"].append(sid)
                continue
            signal = copy.deepcopy(seed)
            result.append(signal)
            by_id[sid] = signal
            urls.add(url)
            report["added"].append(sid)
        if signal.get("sourceUrl") != url or "id" in patch or "sourceUrl" in patch or patch.get("visibility", "public") != "public":
            report["rejected"].append(sid)
            continue
        signal.update(copy.deepcopy(patch))
        report["applied"].append(sid)
    return result, report


def main():
    root = Path(__file__).resolve().parents[1]
    path = root / "public/data/signals.json"
    evidence = json.loads((root / "scripts/fresh_signal_evidence.json").read_text())
    signals, report = apply_evidence(json.loads(path.read_text()), evidence)
    # Same public pipeline writer is atomic; old signal sites are retained.
    from fetch_public_data import write_json, now
    write_json(path, sorted(signals, key=lambda s: (s.get("publishedAt") or "", s["id"]), reverse=True))
    sites_path = root / "public/data/signal-sites.geojson"
    sites = json.loads(sites_path.read_text()) if sites_path.exists() else {"type": "FeatureCollection", "features": []}
    features = {f.get("id") or f.get("properties", {}).get("signalId"): f for f in sites["features"]}
    for s in signals:
        if s.get("siteGeometry"):
            features[s["id"]] = {"type": "Feature", "id": s["id"], "geometry": s["siteGeometry"],
                "properties": {"signalId": s["id"], "precision": s["precision"], "sourceUrl": s.get("coordinateSourceUrl"),
                               "asOf": s.get("coordinateAsOf"), "note": s.get("geographyNote")}}
    sites["features"] = list(features.values())
    write_json(sites_path, sites)
    report.update(checkedAt=now(), total=len(signals), articlesReviewed=evidence.get("articlesReviewed"),
                  locatedRecords=sum(bool(s.get("coordinates")) for s in signals if s["id"] in report["applied"]))
    write_json(root / "data/public/fresh-geography-report.json", report)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
