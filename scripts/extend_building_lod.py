#!/usr/bin/env python3
"""Add a local low-zoom pyramid while retaining every original high-zoom tile.

Run with data/public/.venv/bin/python. No network or private data is used.
The live archive is replaced atomically only after complete byte validation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile

from pmtiles.reader import MmapSource, Reader, all_tiles
from pmtiles.tile import Compression, zxy_to_tileid
from pmtiles.writer import Writer

ROOT = Path(__file__).resolve().parents[1]
DETAIL_MIN_ZOOM = 13
FAR_MIN_ZOOM = 10
MAX_LOW_TILE_BYTES = 524_288
MAX_LOW_TILE_FEATURES = 12_000
ANCHORS = {
    "kazan": (49.122, 55.795),
    "innopolis": (48.744, 55.752),
    "chelny": (52.40, 55.74),
    "almetyevsk": (52.315, 54.90),
    "bolgar": (49.05, 54.99),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tile_xy(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    n = 2 ** zoom
    lat_radians = math.radians(lat)
    return (int((lon + 180) / 360 * n),
            int((1 - math.asinh(math.tan(lat_radians)) / math.pi) / 2 * n))


def archive_info(path: Path) -> tuple[dict, dict]:
    with path.open("rb") as stream:
        reader = Reader(MmapSource(stream))
        return reader.header(), reader.metadata()


def merge_archives(base: Path, low: Path, output: Path, detail_min_zoom: int = DETAIL_MIN_ZOOM) -> dict:
    """Copy compressed MVT payloads without decoding/re-encoding the detail tiles."""
    header, metadata = archive_info(base)
    low_header, low_metadata = archive_info(low)
    if low_header["max_zoom"] >= detail_min_zoom:
        raise ValueError("Low-zoom archive overlaps the retained detail pyramid")
    for key in ("tile_type", "tile_compression"):
        if header[key] != low_header[key]:
            raise ValueError(f"Incompatible {key}")
    metadata = dict(metadata)
    metadata["minzoom"] = str(low_header["min_zoom"])
    metadata["maxzoom"] = str(header["max_zoom"])
    metadata["generator"] = "tippecanoe + local byte-preserving PMTiles LOD merge"
    metadata.pop("generator_options", None)
    low_layers = {layer["id"]: layer for layer in low_metadata.get("vector_layers", [])}
    metadata["vector_layers"] = [
        {**layer, "minzoom": low_layers.get(layer["id"], {}).get("minzoom", layer.get("minzoom"))}
        for layer in metadata.get("vector_layers", [])
    ]
    metadata["atlas_lod"] = {
        "minZoom": low_header["min_zoom"], "detailMinZoom": detail_min_zoom,
        "maxZoom": header["max_zoom"], "detailTilesPreserved": True,
        "lowZoomPolicy": "Source polygons simplified/quantized for distance. Smallest polygons may be omitted only at z10–12 to fit 512 KiB / 12000 feature budgets; no synthetic squares. Detailed z13–15 tiles are unchanged. Not new survey data.",
        "maxLowTileBytes": MAX_LOW_TILE_BYTES, "maxLowTileFeatures": MAX_LOW_TILE_FEATURES,
    }
    with output.open("wb") as destination:
        writer = Writer(destination)
        for path, is_low in ((low, True), (base, False)):
            with path.open("rb") as stream:
                for (z, x, y), data in all_tiles(MmapSource(stream)):
                    if is_low or z >= detail_min_zoom:
                        writer.write_tile(zxy_to_tileid(z, x, y), data)
        writer.finalize(dict(header), metadata)
    return metadata["atlas_lod"]


def verify_archive(candidate: Path, original: Path, detail_min_zoom: int = DETAIL_MIN_ZOOM,
                   anchors: dict | None = None) -> dict:
    """Verify every detail payload and inspect populated adjacent z12/z13 cells."""
    header, metadata = archive_info(candidate)
    original_header, _ = archive_info(original)
    if header["max_zoom"] != original_header["max_zoom"] or header["min_zoom"] >= detail_min_zoom:
        raise ValueError("Unexpected archive zoom range")
    retained = 0
    with candidate.open("rb") as new_file, original.open("rb") as old_file:
        new_tiles = (item for item in all_tiles(MmapSource(new_file)) if item[0][0] >= detail_min_zoom)
        old_tiles = (item for item in all_tiles(MmapSource(old_file)) if item[0][0] >= detail_min_zoom)
        sentinel = object()
        from itertools import zip_longest
        for old, new in zip_longest(old_tiles, new_tiles, fillvalue=sentinel):
            if old is sentinel or new is sentinel or old != new:
                raise ValueError("A retained detail tile is missing, added, or changed")
            retained += 1
    sizes: dict[int, list[int]] = {}
    low_feature_counts: dict[int, list[int]] = {}
    from mapbox_vector_tile.Mapbox import vector_tile_pb2
    with candidate.open("rb") as stream:
        for (z, _x, _y), data in all_tiles(MmapSource(stream)):
            sizes.setdefault(z, []).append(len(data))
            if z < detail_min_zoom:
                raw = gzip.decompress(data) if header["tile_compression"] == Compression.GZIP else data
                tile = vector_tile_pb2.tile()
                tile.ParseFromString(raw)
                count = sum(len(layer.features) for layer in tile.layers)
                if count > MAX_LOW_TILE_FEATURES:
                    raise ValueError(f"Low-zoom tile exceeds feature budget at z{z}")
                low_feature_counts.setdefault(z, []).append(count)
    zooms = {}
    for z, values in sizes.items():
        values.sort()
        if z < detail_min_zoom and max(values) > MAX_LOW_TILE_BYTES:
            raise ValueError(f"Low-zoom tile exceeds byte budget at z{z}")
        zooms[str(z)] = {"tiles": len(values), "bytes": sum(values), "maxTileBytes": max(values),
                         "p95TileBytes": values[math.ceil(len(values) * .95) - 1]}
        if z in low_feature_counts:
            zooms[str(z)]["maxTileFeatures"] = max(low_feature_counts[z])
    import mapbox_vector_tile
    samples = []
    with candidate.open("rb") as stream:
        reader = Reader(MmapSource(stream))
        for name, (lon, lat) in (ANCHORS if anchors is None else anchors).items():
            for z in (12, 13):
                if z > header["max_zoom"]:
                    continue
                x, y = tile_xy(lon, lat, z)
                offsets = (-1, 0, 1) if name == "kazan" else (0,)
                for dx in offsets:
                    for dy in offsets:
                        tile = reader.get(z, x + dx, y + dy)
                        counts = {}
                        if tile:
                            raw = gzip.decompress(tile) if header["tile_compression"] == Compression.GZIP else tile
                            counts = {k: len(v["features"]) for k, v in mapbox_vector_tile.decode(raw).items()}
                        samples.append({"area": name, "z": z, "x": x + dx, "y": y + dy,
                                        "bytes": len(tile or b""), "features": counts})
                        if dx == dy == 0 and not counts.get("building"):
                            raise ValueError(f"Missing building coverage at {name} zoom {z}")
    return {"minZoom": header["min_zoom"], "maxZoom": header["max_zoom"],
            "retainedDetailTilesVerified": retained, "allDetailBytesEqual": True,
            "zooms": zooms, "samples": samples, "layers": [v["id"] for v in metadata["vector_layers"]]}


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=ROOT / "public/data/tatarstan-buildings.pmtiles")
    parser.add_argument("--minzoom", type=int, default=FAR_MIN_ZOOM)
    parser.add_argument("--detail-minzoom", type=int, default=DETAIL_MIN_ZOOM)
    parser.add_argument("--refresh", action="store_true", help="Rebuild only the low-zoom pyramid")
    args = parser.parse_args()
    if not 0 <= args.minzoom < args.detail_minzoom:
        parser.error("minzoom must be below detail-minzoom")
    header, _ = archive_info(args.archive)
    if header["min_zoom"] <= args.minzoom and not args.refresh:
        print(json.dumps({"status": "already-covered", "minZoom": header["min_zoom"],
                          "archive": str(args.archive)}), flush=True)
        return
    if header["max_zoom"] < args.detail_minzoom:
        raise ValueError("Archive lacks detail tiles")
    work = ROOT / "data/public"
    inputs = [work / "building.geojsonseq", work / "building_part.geojsonseq"]
    executable = work / "tools/tippecanoe/tippecanoe"
    for path in [executable, *inputs]:
        if not path.exists():
            raise FileNotFoundError(f"Local prerequisite missing: {path}; no automatic download")
    source_hash = sha256(args.archive)
    cache = work / "cache/building-lod"
    cache.mkdir(parents=True, exist_ok=True)
    backup = cache / f"original-{source_hash[:16]}.pmtiles"
    if not backup.exists():
        shutil.copy2(args.archive, backup)
    if sha256(backup) != source_hash:
        raise ValueError("Backup verification failed")
    print(json.dumps({"status": "backup-verified", "sha256": source_hash,
                      "bytes": backup.stat().st_size, "backup": str(backup)}), flush=True)
    with tempfile.TemporaryDirectory(prefix="lod-", dir=cache) as temp:
        low = Path(temp) / "low.pmtiles"
        candidate = Path(temp) / "candidate.pmtiles"
        command = [str(executable), "--quiet", "--read-parallel", "-o", str(low),
                   f"-Z{args.minzoom}", f"-z{args.detail_minzoom - 1}", "-r1",
                   "--drop-smallest-as-needed", f"--maximum-tile-bytes={MAX_LOW_TILE_BYTES}",
                   f"--maximum-tile-features={MAX_LOW_TILE_FEATURES}", "--no-tiny-polygon-reduction",
                   "--name", "Татарстан — дальняя застройка из исходных контуров",
                   "--attribution", "© OpenStreetMap contributors; Overture Maps Foundation; Microsoft",
                   "-L", "building:" + str(inputs[0]), "-L", "building_part:" + str(inputs[1])]
        print(json.dumps({"status": "building-local-low-zooms", "minZoom": args.minzoom,
                          "maxZoom": args.detail_minzoom - 1}), flush=True)
        subprocess.run(command, check=True)
        policy = merge_archives(backup, low, candidate, args.detail_minzoom)
        report = verify_archive(candidate, backup, args.detail_minzoom)
        report.update({"checkedAt": datetime.now(timezone.utc).isoformat(), "sourceArchiveSha256": source_hash,
                       "archiveSha256": sha256(candidate), "archiveBytes": candidate.stat().st_size,
                       "backup": str(backup.relative_to(ROOT)), "sourceGeoJSONBytes": sum(p.stat().st_size for p in inputs),
                       "networkRequests": 0, "policy": policy, "browserVerified": False})
        if sha256(args.archive) != source_hash:
            raise ValueError("Live archive changed during packaging; refusing overwrite")
        # Same filesystem; readers with an existing file descriptor can finish safely.
        candidate.replace(args.archive)
        write_json(work / "building-lod-verification.json", report)
        coverage_path = work / "building-coverage.json"
        if coverage_path.exists():
            coverage = json.loads(coverage_path.read_text())
            coverage.update({"minZoom": args.minzoom, "maxZoom": header["max_zoom"],
                             "bytes": args.archive.stat().st_size, "lod": policy,
                             "lodBuiltAt": report["checkedAt"], "archiveSha256": report["archiveSha256"]})
            write_json(coverage_path, coverage)
        print(json.dumps({"status": "verified-and-replaced", "bytes": report["archiveBytes"],
                          "retainedDetailTilesVerified": report["retainedDetailTilesVerified"],
                          "zooms": report["zooms"]}), flush=True)


if __name__ == "__main__":
    main()
