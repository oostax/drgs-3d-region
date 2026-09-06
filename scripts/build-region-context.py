"""Precompute a calm overview around the active region; no per-frame polygon clipping.

Run: uv run --with shapely==2.1.2 python scripts/build-region-context.py
"""
import json
from pathlib import Path
from shapely.geometry import shape, mapping
from shapely import make_valid

root = Path(__file__).resolve().parents[1] / 'public' / 'data'
boundaries = json.loads((root / 'tatarstan-boundaries.geojson').read_text())
active = make_valid(shape(next(f['geometry'] for f in boundaries['features'] if f['properties']['territoryId'] == 'RU-TA')))
regions = json.loads((root / 'russia-regions.geojson').read_text())
features = []
for feature in regions['features']:
    if feature['properties']['id'] == 'RU-TA':
        continue
    geometry = make_valid(shape(feature['geometry'])).difference(active).simplify(.006, preserve_topology=True)
    if not geometry.is_empty:
        features.append({**feature, 'geometry': mapping(geometry)})
(root / 'region-context.geojson').write_text(json.dumps({'type':'FeatureCollection', 'features':features}, ensure_ascii=False, separators=(',',':')))
print(f'Regional context: {len(features)} overview regions; active region excluded.')
