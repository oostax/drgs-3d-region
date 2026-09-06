#!/usr/bin/env python3
"""Small generated XML fixtures for private importer behavior, no real data."""
from pathlib import Path
import json
import sqlite3
import tempfile
import unittest
from xml.sax.saxutils import escape
import zipfile

from import_xlsx import Importer, Workbook, canonical_source_name, gosb_identifier, inn_checksum, normalize_inn, open_database


def make_inn(prefix="160000001"):
    weights = (2, 4, 10, 3, 5, 9, 4, 6, 8)
    return prefix + str(sum(int(x) * w for x, w in zip(prefix, weights)) % 11 % 10)


def fixture(path, rows, sheet="Test", wrong_dimension=False):
    strings = []
    indices = {}
    xml_rows = []
    for rn, values in rows:
        cells = []
        for col, value in values.items():
            if value is None:
                cells.append(f'<c r="{col}{rn}"/>')
            elif isinstance(value, (int, float)):
                cells.append(f'<c r="{col}{rn}"><v>{value}</v></c>')
            else:
                text = str(value)
                if text not in indices:
                    indices[text] = len(strings)
                    strings.append(text)
                cells.append(f'<c r="{col}{rn}" t="s"><v>{indices[text]}</v></c>')
        xml_rows.append(f'<row r="{rn}">' + "".join(cells) + '</row>')
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/workbook.xml", f'<workbook xmlns="{main}" xmlns:r="{rel}"><sheets><sheet name="{sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", f'<sst xmlns="{main}">' + "".join(f'<si><t>{escape(s)}</t></si>' for s in strings) + '</sst>')
        dim = '<dimension ref="A1"/>' if wrong_dimension else ''
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{main}">{dim}<sheetData>' + "".join(xml_rows) + '</sheetData></worksheet>')
    return path


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.conn = open_database(self.folder / "test.sqlite")
        self.importer = Importer(self.conn, temp_dir=self.folder, quiet=True, progress_every=1)
        self.inn = make_inn()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def source(self, filename, kind, rows, **kwargs):
        path = fixture(self.folder / filename, rows, **kwargs)
        result = self.importer.import_file(path, kind)
        self.assertEqual(result["status"], "complete", result)
        return path, result

    def seed_org(self):
        return self.source("recipients.xlsx", "recipients", [(1, {"A": "tb", "B": "gosb", "D": "inn"}), (2, {"B": 8610, "D": self.inn, "E": "Synthetic organization", "L": 0, "M": None})])

    def test_null_zero_source_fields_and_hash_idempotence(self):
        path, _ = self.seed_org()
        self.source("volume.xlsx", "payroll", [(1, {"L": "ФОТ за март"}), (2, {"B": 8610, "D": self.inn, "L": 100.5, "M": None, "N": 200, "O": 400})])
        row = self.conn.execute("SELECT * FROM payroll").fetchone()
        self.assertEqual(row["recipients_march"], 0)
        self.assertIsNone(row["recipients_july"])
        self.assertEqual(row["fot_march"], 100.5)
        self.assertIsNone(row["fot_july"])
        self.assertEqual(self.importer.import_file(path, "recipients")["status"], "skipped")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM imports").fetchone()[0], 2)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM organizations").fetchone()[0], 1)
        self.assertEqual(self.conn.execute("PRAGMA user_version").fetchone()[0], 1)

    def test_duplicate_meetings_equality_and_conflict(self):
        base = {"B": 8610, "C": self.inn, "D": "Synthetic organization", "K": 1, "L": 2, "M": 0}
        _, result = self.source("meetings.xlsx", "meetings", [(1, {"C": "INN"}), (2, base), (3, {**base, "H": "manager2"}), (4, {**base, "L": 4})])
        row = self.conn.execute("SELECT * FROM meetings").fetchone()
        self.assertEqual((row["q1"], row["q2"], row["q3"]), (1, 2, 0))
        self.assertEqual(row["conflict"], 1)
        self.assertEqual(result["report"]["counters"]["equal_duplicate_rows"], 1)
        self.assertEqual(result["report"]["quality"]["meeting_conflicts"], 1)
        self.assertEqual(result["rows_kept"], 1)

    def test_inn_restoration_and_invalid_retention(self):
        valid = make_inn("012345678")
        self.assertTrue(inn_checksum(valid))
        self.assertEqual(normalize_inn(int(valid)), (valid, "leading_zero_restored"))
        _, result = self.source("invalid.xlsx", "recipients", [(1, {"D": "INN"}), (2, {"B": 8610, "D": "bad-ID", "L": 1}), (3, {"B": 8610, "D": int(valid), "L": 2})])
        ids = [r[0] for r in self.conn.execute("SELECT id FROM organizations ORDER BY id")]
        self.assertEqual(len(ids), 2)
        self.assertTrue(any(":invalid:" in x for x in ids))
        self.assertIn("8610:" + valid, ids)
        self.assertEqual(result["report"]["quality"]["invalid_inn_checksum_or_length"], 1)

    def test_two_snapshots_keep_distinct_amounts_and_filter_union(self):
        self.seed_org()
        for quarter, amount in (("q1", 100), ("q2", 250)):
            self.source(quarter + ".xlsx", "offers_" + quarter,
                        [(1, {"A": "INN"}), (2, {"A": self.inn, "C": "same-offer", "E": "Test product", "F": amount, "G": 10, "K": "Open", "L": 46000}),
                         (3, {"A": make_inn("770000002"), "C": "other-offer", "F": 999})])
        rows = self.conn.execute("SELECT snapshot,amount FROM offers ORDER BY snapshot").fetchall()
        self.assertEqual([tuple(r) for r in rows], [("q1", 100.0), ("q2", 250.0)])
        self.assertTrue(all(r[0] for r in self.conn.execute("SELECT org_id FROM offers")))

    def test_corrupt_zip_records_error_and_can_retry(self):
        path = self.folder / "broken.xlsx"
        path.write_bytes(b"not a zip")
        result = self.importer.import_file(path, "payroll")
        self.assertEqual(result["status"], "error")
        entry = self.conn.execute("SELECT status,error FROM imports").fetchone()
        self.assertEqual(entry["status"], "error")
        self.assertIn("BadZipFile", entry["error"])
        self.assertEqual(self.importer.import_file(path, "payroll")["status"], "error")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM imports").fetchone()[0], 1)

    def test_dimension_lie_does_not_truncate_incidents(self):
        _, result = self.source("incidents.xlsx", "incidents", [(1, {"A": "Регион"}),
                    (2, {"A": "Республика Татарстан", "B": "Housing", "C": "Water", "F": "01.07.2026", "P": "Synthetic municipality"}),
                    (3, {"A": "Other region", "F": "01.07.2026"}),
                    (4, {"A": "Республика Татарстан", "G": "02.07.2026"})], wrong_dimension=True)
        self.assertEqual(result["rows_read"], 3)
        self.assertEqual(result["rows_kept"], 2)
        rows = self.conn.execute("SELECT status FROM incidents ORDER BY id").fetchall()
        self.assertEqual({r[0] for r in rows}, {"open", "closed"})

    def test_staff_versions_not_combined(self):
        for name, role in (("staff.xlsx", "one"), ("staff-other.xlsx", "two")):
            self.source(name, "staff", [(6, {"K": "employee"}), (7, {"K": "employee-1", "M": role})])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM staff").fetchone()[0], 2)
        self.assertEqual(self.conn.execute("SELECT COUNT(DISTINCT source_version) FROM staff").fetchone()[0], 2)

    def test_text_gosb_and_current_offer_expands_pilot_union(self):
        self.assertEqual(gosb_identifier("Банк Татарстан отделение №8610"), "8610")
        self.assertEqual(gosb_identifier("8610"), "8610")
        self.source("current.xlsx", "offers_current", [(1, {"B": "ГОСБ", "C": "ИНН"}),
                    (2, {"B": "Банк Татарстан отделение №8610", "C": self.inn, "D": "Synthetic", "E": "offer", "F": "Product", "G": 100, "H": 5})])
        self.source("history.xlsx", "offers_q1", [(1, {"A": "ИНН"}),
                    (2, {"A": self.inn, "C": "offer", "E": "Product", "F": 50})])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM offers").fetchone()[0], 2)

    def test_normalization_collision_is_not_silently_merged(self):
        valid = make_inn("012345678")
        path, result = self.source("collision.xlsx", "recipients", [(1, {"D": "INN"}),
                    (2, {"B": 8610, "D": int(valid), "L": 1}),
                    (3, {"B": 8610, "D": valid, "L": 2})])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM organizations").fetchone()[0], 2)
        self.assertEqual(result["report"]["quality"]["normalization_collision"], 1)
        self.source("ambiguous-offer.xlsx", "offers_q1", [(1, {"A": "INN"}),
                    (2, {"A": valid, "C": "offer", "F": 100})])
        self.assertIsNone(self.conn.execute("SELECT org_id FROM offers").fetchone()[0])
        self.assertEqual(self.importer.import_file(path, "recipients", reprocess=True)["status"], "complete")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM payroll").fetchone()[0], 2)

    def test_uuid_prefixed_upload_uses_original_source_name(self):
        original = "Получатели ФОТ (март, июль).xlsx"
        uploaded = "12345678-abcd-4321-abcd-123456789012-" + original
        self.assertEqual(canonical_source_name(uploaded), original)
        path = fixture(self.folder / uploaded, [(1, {"D": "INN"}), (2, {"B": 8610, "D": self.inn, "L": 1})])
        result = self.importer.import_file(path)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(self.conn.execute("SELECT file_name FROM imports").fetchone()[0], original)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM payroll").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
