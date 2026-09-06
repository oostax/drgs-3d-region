#!/usr/bin/env python3
"""Small public-only enrichment. No private workbooks/database are read.

Run with data/public/.venv/bin/python scripts/enrich_public_pilot.py --map-life.
The existing regional building PMTiles are never rebuilt by this script.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from shapely.geometry import LineString, Polygon, box, mapping
from shapely.ops import unary_union

from fetch_public_data import CACHE, OUT, ROOT, WORK, fetch, load_json, now, relation_geometry, write_json

PILOT_BOUNDS = {
    "kazan": [49.087, 55.788, 49.143, 55.819],
    "innopolis": [48.733, 55.745, 48.762, 55.762],
    "bolgar": [49.055, 54.961, 49.067, 54.971],
}


def osm_query(key, query, refresh=False):
    def valid(path):
        try:
            data = load_json(path)
            return isinstance(data.get("elements"), list) and not data.get("remark")
        except (ValueError, AttributeError):
            return False
    path = fetch(key, "https://overpass-api.de/api/interpreter?data=" + quote(query),
                 key + ".json", refresh, timeout=60, max_bytes=30_000_000, validator=valid)
    return load_json(path) if path else None


def map_life(refresh=False, offline=False):
    def fetch_area(item):
        area_id, (west, south, east, north) = item
        if offline:
            return load_json(CACHE / f"pilot-map-life-{area_id}.json")
        extent = f"({south},{west},{north},{east})"
        parts = [
            f'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service)(_link)?$"]{extent};',
            f'nwr["leisure"="park"]{extent};',
            f'nwr["natural"~"^(wood|water)$"]{extent};',
            f'nwr["landuse"~"^(forest|grass|meadow)$"]{extent};',
            f'nwr["waterway"="riverbank"]{extent};',
        ]
        return osm_query("pilot-map-life-" + area_id, '[out:json][timeout:45];(' + ''.join(parts) + ');out geom;', refresh)
    with ThreadPoolExecutor(max_workers=3) as pool:
        areas = list(pool.map(fetch_area, PILOT_BOUNDS.items()))
    missing_areas = [name for name, area in zip(PILOT_BOUNDS, areas) if area is None]
    available_areas = [area for area in areas if area is not None]
    if not available_areas:
        raise RuntimeError("Public OSM source unavailable; existing map-life data preserved.")
    data = {"elements": [element for area in available_areas for element in area["elements"]], "osm3s": available_areas[0].get("osm3s", {})}
    clip = unary_union([box(*bounds) for bounds in PILOT_BOUNDS.values()])
    features = []
    seen = set()
    for element in data["elements"]:
        oid = f"{element['type']}/{element['id']}"
        if oid in seen:
            continue
        seen.add(oid)
        tags = element.get("tags", {})
        props = {"id": oid, "sourceUrl": "https://www.openstreetmap.org/" + oid,
                 "name": tags.get("name"), "asOf": data.get("osm3s", {}).get("timestamp_osm_base")}
        points = [(p["lon"], p["lat"]) for p in element.get("geometry", []) if p]
        if tags.get("highway"):
            if len(points) < 2 or any(tags.get(key) in ("no", "private") for key in ("access", "vehicle", "motor_vehicle")):
                continue
            if tags.get("oneway") == "-1":
                points.reverse()
            geom = LineString(points)
            props.update(kind="road", roadClass=tags["highway"], oneway=tags.get("oneway") in ("yes", "1", "-1"), simulationOnly=True)
        else:
            geom = relation_geometry(element) if element["type"] == "relation" else Polygon(points) if len(points) > 3 and points[0] == points[-1] else None
            if geom is None or geom.is_empty or not geom.is_valid:
                continue
            if tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
                props.update(kind="water", waterType=tags.get("water", "water"))
            else:
                props.update(kind="green", greenType="park" if tags.get("leisure") == "park" else "wood" if tags.get("natural") == "wood" or tags.get("landuse") == "forest" else "grass")
        geom = geom.intersection(clip).simplify(0.000012, preserve_topology=True)
        if geom.is_empty or geom.geom_type not in ("LineString", "MultiLineString", "Polygon", "MultiPolygon"):
            continue
        features.append({"type": "Feature", "properties": props, "geometry": mapping(geom)})
    result = {"type": "FeatureCollection", "features": features,
              "metadata": {"generatedAt": now(), "osmAsOf": data.get("osm3s", {}).get("timestamp_osm_base"),
                           "bounds": PILOT_BOUNDS, "missingAreas": missing_areas,
                           "areaSnapshots": {name: area.get("osm3s", {}).get("timestamp_osm_base") for name, area in zip(PILOT_BOUNDS, areas) if area},
                           "attribution": "© OpenStreetMap contributors, ODbL-1.0",
                           "simulationOnly": True, "constructionPolicy": "No active construction without a dated project source; OSM edit dates do not establish activity."}}
    write_json(OUT / "map-life.geojson", result)
    print(json.dumps({"mapLife": dict(Counter(f["properties"]["kind"] for f in features)), "bytes": (OUT / "map-life.geojson").stat().st_size}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-life", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--offline", action="store_true", help="Use existing public caches only; no network requests")
    parser.add_argument("--enrichment", action="store_true", help="Publish curated public addresses and dated signal evidence; no network/private data")
    args = parser.parse_args()
    if args.map_life:
        map_life(args.refresh, args.offline)
    if args.enrichment:
        evidence = load_json(ROOT / "scripts/public_pilot_evidence.json")
        write_json(OUT / "organization-addresses.json", evidence["organizations"])
        write_json(OUT / "signal-sites.geojson", {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": signal_id, "geometry": patch["siteGeometry"],
             "properties": {"signalId": signal_id, "precision": patch.get("precision"),
                            "sourceUrl": patch.get("coordinateSourceUrl"), "asOf": patch.get("coordinateAsOf"),
                            "note": patch.get("geographyNote")}}
            for signal_id, patch in evidence["signals"].items() if patch.get("siteGeometry")
        ]})
        for path in (WORK / "news-seeds.json", OUT / "signals.json"):
            signals = load_json(path, [])
            for signal in signals:
                patch = evidence["signals"].get(signal["id"], {})
                signal.update(patch)
                # A named point supersedes an old approximate area, never its bounds.
                if (patch.get("siteGeometry") or {}).get("type") == "Point":
                    signal.pop("siteBbox", None)
            write_json(path, signals)
        print(json.dumps({"organizations": len(evidence["organizations"]), "signalsEnriched": len(evidence["signals"])}))


if __name__ == "__main__":
    main()
