"""Rebuild with: uv run --with shapely==2.1.2 python scripts/build-russia-mask.py.

The source is the project's existing overview boundary, not a new territory dataset.
The browser receives only the precomputed inverse geometry; no runtime GIS is needed.
"""

import hashlib
import json
from pathlib import Path

from shapely import make_valid
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public/data/russia-regions.geojson"
TARGET = ROOT / "public/data/russia-mask.geojson"
LABELS = ROOT / "public/data/russia-region-labels.geojson"
MERCATOR_LIMIT = 85.051129


def polygons(geometry):
    if geometry.geom_type == "Polygon":
        yield geometry
    elif hasattr(geometry, "geoms"):
        for child in geometry.geoms:
            yield from polygons(child)


source_bytes = SOURCE.read_bytes()
source = json.loads(source_bytes)
russia = unary_union([
    polygon
    for feature in source["features"]
    for polygon in polygons(make_valid(shape(feature["geometry"])))
])
features = []


def append_cell(west, south, east, north):
    cell = box(west, south, east, north)
    mask = cell.difference(russia)
    pieces = list(polygons(mask))
    # MapLibre keeps at most 500 rings per polygon. Adaptive cells preserve small
    # Arctic islands instead of allowing that renderer limit to fill them in.
    if any(len(piece.interiors) > 160 for piece in pieces):
        if east - west >= north - south:
            middle = (west + east) / 2
            append_cell(west, south, middle, north)
            append_cell(middle, south, east, north)
        else:
            middle = (south + north) / 2
            append_cell(west, south, east, middle)
            append_cell(west, middle, east, north)
        return
    for piece in pieces:
        if piece.is_empty:
            continue
        features.append({
            "type": "Feature",
            "properties": {},
            "geometry": mapping(piece),
        })


latitudes = [-MERCATOR_LIMIT, -40, 0, 40, MERCATOR_LIMIT]
for west in range(-180, 180, 60):
    for south, north in zip(latitudes, latitudes[1:]):
        append_cell(west, south, west + 60, north)

result = {
    "type": "FeatureCollection",
    "sourceFile": "russia-regions.geojson",
    "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
    "features": features,
}
TARGET.write_text(json.dumps(result, separators=(",", ":")) + "\n")
print(f"{TARGET.name}: {len(features)} polygons, {TARGET.stat().st_size:,} bytes")

# Polygon placement produces a label for every detached island of a region.
# Preserve the existing overview center, but emit exactly one label anchor.
labels = {
    "type": "FeatureCollection",
    "sourceFile": "russia-regions.geojson",
    "sourceSha256": result["sourceSha256"],
    "features": [{
        "type": "Feature",
        "properties": feature["properties"],
        "geometry": {"type": "Point", "coordinates": feature["properties"]["center"]},
    } for feature in source["features"]],
}
LABELS.write_text(json.dumps(labels, ensure_ascii=False, separators=(",", ":")) + "\n")
print(f"{LABELS.name}: {len(labels['features'])} label anchors")
