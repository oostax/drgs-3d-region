"""Focused archive tests. Run with data/public/.venv/bin/python."""
import gzip
from pathlib import Path
import tempfile
import unittest

import mapbox_vector_tile
from pmtiles.reader import Reader, MmapSource
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

from extend_building_lod import merge_archives, verify_archive, tile_xy


def payload(name):
    return gzip.compress(mapbox_vector_tile.encode({"name": "building", "features": [{
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]]]},
        "properties": {"id": name, "class": "shed"},
    }]}), mtime=0)


def archive(path, tiles):
    with path.open("wb") as stream:
        writer = Writer(stream)
        for z, data in sorted(tiles.items()):
            writer.write_tile(zxy_to_tileid(z, 0, 0), data)
        writer.finalize({"tile_type": TileType.MVT, "tile_compression": Compression.GZIP,
                         "min_lon_e7": -1800000000, "max_lon_e7": 1800000000,
                         "min_lat_e7": -850000000, "max_lat_e7": 850000000,
                         "center_zoom": 13, "center_lon_e7": 0, "center_lat_e7": 0},
                        {"vector_layers": [{"id": "building", "minzoom": min(tiles), "maxzoom": max(tiles)}]})


class BuildingLODTests(unittest.TestCase):
    def test_merge_keeps_small_building_detail_payload_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            base, low, out = [Path(directory) / name for name in ["base", "low", "out"]]
            archive(base, {13: payload("small-shed"), 15: payload("house")})
            archive(low, {10: payload("far"), 12: payload("near-far")})
            merge_archives(base, low, out)
            result = verify_archive(out, base, anchors={})
            self.assertEqual(result["retainedDetailTilesVerified"], 2)
            self.assertEqual(result["minZoom"], 10)
            with out.open("rb") as stream:
                reader = Reader(MmapSource(stream))
                self.assertEqual(reader.get(13, 0, 0), payload("small-shed"))
                self.assertEqual(reader.metadata()["vector_layers"][0]["minzoom"], 10)

    def test_overlapping_pyramid_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base, low, out = [Path(directory) / name for name in ["base", "low", "out"]]
            archive(base, {13: payload("original")})
            archive(low, {13: payload("replacement")})
            with self.assertRaisesRegex(ValueError, "overlaps"):
                merge_archives(base, low, out)

    def test_changed_detail_tile_fails_before_live_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            base, candidate = [Path(directory) / name for name in ["base", "candidate"]]
            archive(base, {13: payload("original")})
            archive(candidate, {10: payload("far"), 13: payload("changed")})
            with self.assertRaisesRegex(ValueError, "changed"):
                verify_archive(candidate, base, anchors={})

    def test_missing_detail_tile_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            base, candidate = [Path(directory) / name for name in ["base", "candidate"]]
            archive(base, {13: payload("original"), 15: payload("last")})
            archive(candidate, {10: payload("far"), 15: payload("last")})
            with self.assertRaisesRegex(ValueError, "missing"):
                verify_archive(candidate, base, anchors={})

    def test_kazan_neighbor_tiles_have_correct_parent(self):
        x, y = tile_xy(49.122, 55.795, 13)
        self.assertEqual((x // 2, y // 2), tile_xy(49.122, 55.795, 12))


if __name__ == "__main__":
    unittest.main()
