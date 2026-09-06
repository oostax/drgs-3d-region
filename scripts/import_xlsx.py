#!/usr/bin/env python3
"""Private, streaming XLSX -> SQLite import. No network or Excel dependency.

Run with the bundled Python interpreter, --directory /path/to/Downloads and
--db private-data/atlas.sqlite. Large XML and shared strings are streamed;
shared strings use an unlinked temporary file and a compact offset index.
"""
from __future__ import annotations

import argparse
from array import array
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import sqlite3
import struct
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
SCHEMA_VERSION = 1
PILOT_GOSB = "8610"
SOURCE_NAMES = {
    "clients_detail_2026-08-21 14_08.xlsx": "client_cards",
    "for_model.xlsx": "model_details",
    "итоги за июль (1).xlsx": "july_results",
    "Настроение_КМ_2026-08-31-114752 (1).csv": "mood_survey",
    "Получатели ФОТ (март, июль).xlsx": "recipients",
    "Объем ФОТ (март, июль).xlsx": "payroll",
    "встречи 1,2,3 квартал.xlsx": "meetings",
    "лиды и сделки в работе 3 квартал.xlsx": "offers_current",
    "1 квартал.xlsx": "offers_q1",
    "2 квартал.xlsx": "offers_q2",
    "3 квартал на 23-08-2026.xlsx": "offers_q3",
    "Сбер_июль_2026.xlsx": "incidents",
    "штат.xlsx": "staff",
    "штатка.xlsx": "staff",
    "кластеризация ГОСБ_2025-2026.xlsx": "clusters",
    "обращения 2025-2026_свод.xlsx": "complaint_summaries",
}
ORDER = {k: i for i, k in enumerate(("recipients", "payroll", "meetings", "offers_current", "offers_q1", "offers_q2", "offers_q3", "incidents", "staff", "clusters", "complaint_summaries", "client_cards", "model_details", "july_results", "mood_survey"))}


def canonical_source_name(name):
    candidate = re.sub(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-", "", name, flags=re.I)
    return candidate if candidate in SOURCE_NAMES else name


PAYROLL_FIELDS = {
    "recipients": {"L": "recipients_march", "M": "recipients_july"},
    "payroll": {"L": "fot_march", "M": "fot_july", "N": "cumulative_april", "O": "cumulative_august"},
}
PERIODS = {
    "recipients": {"months": [3, 7], "year": 2026, "year_inferred_from_companion": True},
    "payroll": {"year": 2026, "months": [3, 7], "cumulative_dates": ["2026-04-01", "2026-08-01"], "currency": "RUB", "unit_confirmed_by_user": True},
    "meetings": {"quarters": [1, 2, 3], "year": 2026, "year_inferred": True},
    "offers_current": {"snapshot": "current", "snapshot_date": "2026-08-31", "date_inferred": True},
    "offers_q1": {"snapshot": "q1", "snapshot_date": "2026-03-31", "date_inferred": True},
    "offers_q2": {"snapshot": "q2", "snapshot_date": "2026-06-29", "date_inferred": True},
    "offers_q3": {"snapshot": "q3", "snapshot_date": "2026-08-21", "date_inferred": True},
    "staff": {"start": "2026-01-01", "end": "2026-06-30", "exported_at": "2026-06-02T00:12:12", "versions_are_not_additive": True},
    "clusters": {"years": [2025, 2026]},
    "complaint_summaries": {"months": list(range(1, 9)), "year": None, "sheets_are_filter_views": True},
    "incidents": {"period_from_rows": True},
}

DDL = """
CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imports(
 id TEXT PRIMARY KEY, file_name TEXT NOT NULL, file_hash TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL, status TEXT NOT NULL, rows_read INTEGER NOT NULL DEFAULT 0,
 rows_kept INTEGER NOT NULL DEFAULT 0, imported_at TEXT, period TEXT,
 report_json TEXT NOT NULL DEFAULT '{}', error TEXT);
CREATE TABLE IF NOT EXISTS organizations(
 id TEXT PRIMARY KEY, inn TEXT, gosb TEXT, name TEXT, data_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS organizations_inn ON organizations(inn);
CREATE TABLE IF NOT EXISTS payroll(
 org_id TEXT PRIMARY KEY REFERENCES organizations(id), fot_march REAL, fot_july REAL,
 recipients_march INTEGER, recipients_july INTEGER, cumulative_april REAL,
 cumulative_august REAL, source_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS meetings(
 org_id TEXT PRIMARY KEY REFERENCES organizations(id), q1 INTEGER, q2 INTEGER,
 q3 INTEGER, conflict INTEGER NOT NULL DEFAULT 0, data_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS offers(
 id TEXT PRIMARY KEY, offer_id TEXT, inn TEXT, org_id TEXT REFERENCES organizations(id),
 snapshot TEXT NOT NULL, product TEXT, amount REAL, expected_income REAL, stage TEXT,
 stage_date TEXT, data_json TEXT NOT NULL DEFAULT '{}', source_id TEXT REFERENCES imports(id));
CREATE INDEX IF NOT EXISTS offers_snapshot ON offers(snapshot);
CREATE INDEX IF NOT EXISTS offers_inn ON offers(inn);
CREATE INDEX IF NOT EXISTS offers_org ON offers(org_id);
CREATE TABLE IF NOT EXISTS incidents(
 id TEXT PRIMARY KEY, region TEXT, municipality TEXT, settlement TEXT, street TEXT,
 object TEXT, topic_group TEXT, topic TEXT, created_at TEXT, closed_at TEXT,
 status TEXT, data_json TEXT NOT NULL DEFAULT '{}', source_id TEXT REFERENCES imports(id));
CREATE INDEX IF NOT EXISTS incidents_municipality ON incidents(municipality);
CREATE INDEX IF NOT EXISTS incidents_topic ON incidents(topic_group,topic);
CREATE TABLE IF NOT EXISTS staff(
 id TEXT PRIMARY KEY, source_version TEXT NOT NULL, employee_id TEXT,
 data_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS staff_employee ON staff(employee_id);
CREATE TABLE IF NOT EXISTS bank_clusters(gosb TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS complaint_summaries(id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}');
"""


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def digest(value, length=24):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def identifier(value):
    """Preserve significant leading zeroes; expand numeric Excel notation."""
    s = str(value or "").strip().replace("\u00a0", "")
    if re.fullmatch(r"\d+", s):
        return s
    try:
        n = Decimal(s)
        if n.is_finite() and n >= 0 and n == n.to_integral_value():
            return format(n.quantize(Decimal(1)), "f")
    except (InvalidOperation, ValueError):
        pass
    return s


def gosb_identifier(value):
    """Accept source IDs and the textual branch labels used by CRM exports."""
    s = identifier(value)
    if s.isdigit():
        return s
    # The supplied branch reference maps this exact regional institution to
    # 8610; this is a branch mapping, not inference of a client's geography.
    if "татарстан" in s.casefold():
        return PILOT_GOSB
    numbers = re.findall(r"(?<!\d)(\d{3,6})(?!\d)", s)
    return numbers[-1] if len(numbers) == 1 else s


def inn_checksum(s):
    if not s.isdigit() or len(s) not in (10, 12) or set(s) == {"0"}:
        return False
    n = [int(x) for x in s]
    if len(s) == 10:
        return sum(a * b for a, b in zip(n[:9], (2, 4, 10, 3, 5, 9, 4, 6, 8))) % 11 % 10 == n[9]
    return (sum(a * b for a, b in zip(n[:10], (7, 2, 4, 10, 3, 5, 9, 4, 6, 8))) % 11 % 10 == n[10]
            and sum(a * b for a, b in zip(n[:11], (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8))) % 11 % 10 == n[11])


def normalize_inn(value):
    raw = identifier(value)
    if inn_checksum(raw):
        return raw, None
    if raw.isdigit() and len(raw) in (9, 11) and inn_checksum("0" + raw):
        return "0" + raw, "leading_zero_restored"
    return raw or None, "missing_inn" if not raw else "invalid_inn_checksum_or_length"


def org_key(gosb, raw_inn, fallback=""):
    inn, issue = normalize_inn(raw_inn)
    if issue in (None, "leading_zero_restored"):
        return f"{gosb}:{inn}", inn, issue
    # Invalid values remain addressable, including missing identifiers. Sources
    # with the same invalid lexical INN still join, without claiming validity.
    token = identifier(raw_inn) or fallback
    return f"{gosb}:invalid:{digest(token, 20)}", inn, issue


def number(value, integer=False):
    if value is None or str(value).strip() == "":
        return None
    s = str(value).strip().replace("\u00a0", "").replace(" ", "").replace(",", ".")
    n = Decimal(s)
    if not n.is_finite():
        raise ValueError("Non-finite numeric cell")
    if integer and n != n.to_integral_value():
        raise ValueError("Non-integral count")
    return int(n) if integer else float(n)


def date_value(value, date1904=False):
    s = str(value or "").strip()
    if not s:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", s):
        n = float(s)
        if 1 <= n <= 100000:
            origin = datetime(1904, 1, 1) if date1904 else datetime(1899, 12, 30)
            return (origin + timedelta(days=n)).isoformat(timespec="seconds")
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).isoformat(timespec="seconds")
    except ValueError:
        pass
    for fmt in ("%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M", "%d.%m.%Y", "%Y-%m-%d", "%d/%m/%Y", "%d.%m.%y"):
        try:
            return datetime.strptime(s, fmt).isoformat(timespec="seconds")
        except ValueError:
            pass
    return None


class SharedStrings:
    """Random-access UTF-8 strings with O(string-count) compact RAM usage."""
    def __init__(self, archive, temp_dir=None):
        self.offsets = array("Q")
        self.file = tempfile.TemporaryFile(dir=temp_dir)
        if "xl/sharedStrings.xml" not in archive.namelist():
            return
        with archive.open("xl/sharedStrings.xml") as stream:
            context = ET.iterparse(stream, events=("start", "end"))
            _, root = next(context)
            for event, element in context:
                if event == "end" and element.tag == NS + "si":
                    data = "".join(t.text or "" for t in element.iter(NS + "t")).encode("utf-8")
                    self.offsets.append(self.file.tell())
                    self.file.write(struct.pack("<I", len(data)))
                    self.file.write(data)
                    element.clear()
                    root.clear()
        self.file.flush()

    @lru_cache(maxsize=8192)
    def get(self, index):
        self.file.seek(self.offsets[index])
        length = struct.unpack("<I", self.file.read(4))[0]
        return self.file.read(length).decode("utf-8")

    def close(self):
        self.get.cache_clear()
        self.file.close()


class Workbook:
    def __init__(self, path, temp_dir=None):
        self.archive = zipfile.ZipFile(path)
        self.strings = None
        try:
            workbook = ET.fromstring(self.archive.read("xl/workbook.xml"))
            relations = ET.fromstring(self.archive.read("xl/_rels/workbook.xml.rels"))
            targets = {r.get("Id"): r.get("Target") for r in relations if r.get("TargetMode") != "External"}
            self.sheets = []
            for s in workbook.iter(NS + "sheet"):
                target = targets[s.get(REL + "id")]
                path = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
                if path not in self.archive.namelist():
                    raise ValueError("Worksheet relationship is missing")
                self.sheets.append({"name": s.get("name"), "path": path, "state": s.get("state", "visible")})
            props = workbook.find(NS + "workbookPr")
            self.date1904 = props is not None and props.get("date1904") in ("1", "true")
            self.strings = SharedStrings(self.archive, temp_dir)
        except Exception:
            self.archive.close()
            raise

    def rows(self, sheet):
        with self.archive.open(sheet["path"]) as stream:
            context = ET.iterparse(stream, events=("start", "end"))
            _, root = next(context)
            sheet_data = None
            for event, element in context:
                if event == "start" and element.tag == NS + "sheetData":
                    sheet_data = element
                if event != "end" or element.tag != NS + "row":
                    continue
                values = {}
                for c in element.findall(NS + "c"):
                    col = re.sub(r"\d", "", c.get("r", ""))
                    v = c.find(NS + "v")
                    text = v.text if v is not None else None
                    if c.get("t") == "s" and text is not None:
                        text = self.strings.get(int(text))
                    elif c.get("t") == "inlineStr":
                        text = "".join(t.text or "" for t in c.iter(NS + "t"))
                    values[col] = text
                row_number = int(element.get("r", "0"))
                yield row_number, values
                element.clear()
                if sheet_data is not None:
                    sheet_data.clear()

    def close(self):
        if self.strings:
            self.strings.close()
        self.archive.close()


@contextmanager
def open_workbook(path, temp_dir=None):
    workbook = Workbook(path, temp_dir)
    try:
        yield workbook
    finally:
        workbook.close()


def open_database(path):
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    if current not in (0, SCHEMA_VERSION):
        raise ValueError(f"Unsupported schema version {current}")
    conn.executescript(DDL)
    conn.execute("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
    conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    conn.commit()
    return conn


class Importer:
    def __init__(self, conn, temp_dir=None, progress_every=5000, quiet=False):
        self.conn = conn
        self.temp_dir = temp_dir
        self.progress_every = progress_every
        self.quiet = quiet
        self.source_id = None
        self.report = {}
        self.rows_read = 0
        self.rows_kept = 0
        self.quality = Counter()
        self.counters = Counter()
        self.started = 0
        self.organization_cache = {}
        self.meeting_seen = {}
        self.payroll_seen = {}
        self.normalized_origins = {}
        self.pilot_inns = {}

    def progress(self, status="running", error=None):
        self.report.update(quality=dict(self.quality), counters=dict(self.counters),
                           progress={"rows_read": self.rows_read, "rows_kept": self.rows_kept,
                                     "elapsed_seconds": round(time.monotonic() - self.started, 2)})
        self.conn.execute("UPDATE imports SET status=?,rows_read=?,rows_kept=?,report_json=?,error=?,imported_at=? WHERE id=?",
                          (status, self.rows_read, self.rows_kept, json_text(self.report), error,
                           now() if status != "running" else None, self.source_id))
        self.conn.commit()
        if not self.quiet:
            print(json_text({"source": self.report["file_name"], "kind": self.report["kind"], "status": status,
                             "rows_read": self.rows_read, "rows_kept": self.rows_kept,
                             "elapsed_seconds": self.report["progress"]["elapsed_seconds"]}), flush=True)

    def source_ref(self, sheet, row):
        return {"source_id": self.source_id, "sheet": sheet, "row": row}

    def numeric(self, value, integer=False):
        try:
            return number(value, integer)
        except (InvalidOperation, ValueError, OverflowError):
            self.quality["invalid_numeric_cells"] += 1
            return None

    def organization(self, raw_inn, name, gosb, attrs, ref):
        oid, inn, issue = org_key(gosb, raw_inn, f"{self.source_id}:{ref['sheet']}:{ref['row']}")
        if issue:
            self.quality[issue] += 1
        original = identifier(raw_inn)
        origin_key = (gosb, inn)
        previous_original = self.normalized_origins.get(origin_key)
        previous_issue = normalize_inn(previous_original)[1] if previous_original is not None else None
        if (issue == "leading_zero_restored" or previous_issue == "leading_zero_restored") and previous_original not in (None, original):
            # Never merge two distinct source lexical identifiers while repairing.
            self.quality["normalization_collision"] += 1
            oid = f"{gosb}:invalid:{digest('collision:' + original, 20)}"
            issue = "normalization_collision"
        self.normalized_origins[origin_key] = original
        data = self.organization_cache.get(oid)
        if data is None:
            old = self.conn.execute("SELECT name,data_json FROM organizations WHERE id=?", (oid,)).fetchone()
            data = json.loads(old["data_json"]) if old else {"raw_inn": original, "inn_quality": issue or "valid", "sources": {}}
            data["_name"] = old["name"] if old else None
        if name and str(name).strip():
            data["_name"] = str(name).strip()
        data.setdefault("sources", {})[self.report["kind"]] = ref
        data.setdefault("source_attributes", {})[self.report["kind"]] = attrs
        display_name = data.get("_name")
        stored = {k: v for k, v in data.items() if k != "_name"}
        self.conn.execute("INSERT INTO organizations(id,inn,gosb,name,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=COALESCE(excluded.name,organizations.name),data_json=excluded.data_json",
                          (oid, inn, gosb, display_name, json_text(stored)))
        self.organization_cache[oid] = data
        return oid, inn

    def import_file(self, path, kind=None, reprocess=False):
        path = Path(path).expanduser().resolve()
        source_name = canonical_source_name(path.name)
        kind = kind or SOURCE_NAMES.get(source_name)
        if not kind:
            raise ValueError(f"Unknown source filename: {path.name}; specify a supported --kind")
        sha = file_hash(path)
        old = self.conn.execute("SELECT * FROM imports WHERE file_hash=?", (sha,)).fetchone()
        if old and old["status"] == "complete" and not reprocess:
            result = {"file_name": path.name, "status": "skipped", "reason": "same_file_hash", "rows_kept": old["rows_kept"]}
            if not self.quiet:
                print(json_text(result), flush=True)
            return result
        self.source_id = sha
        self.rows_read = self.rows_kept = 0
        self.quality = Counter()
        self.counters = Counter()
        self.organization_cache = {}
        self.meeting_seen = {}
        self.payroll_seen = {}
        self.normalized_origins = {}
        self.started = time.monotonic()
        self.report = {"schema_version": 1, "importer_version": "1.0.1", "reprocessed": bool(old and reprocess),
                       "file_name": source_name, "source_path": str(path), "kind": kind,
                       "file_size": path.stat().st_size, "sha256": sha, "pilot_gosb": PILOT_GOSB,
                       "period": PERIODS.get(kind, {}), "sheets": [], "headers": {}}
        self.conn.execute("INSERT INTO imports(id,file_name,file_hash,kind,status,period,report_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='running',error=NULL,rows_read=0,rows_kept=0,report_json=excluded.report_json",
                          (sha, source_name, sha, kind, "running", json_text(PERIODS.get(kind, {})), json_text(self.report)))
        self.conn.commit()
        self.pilot_inns = {r["inn"]: r["id"] if r["n"] == 1 else None
                           for r in self.conn.execute("SELECT inn,MIN(id) AS id,COUNT(*) AS n FROM organizations WHERE gosb=? AND inn IS NOT NULL GROUP BY inn", (PILOT_GOSB,))}
        try:
            self.progress()
            if kind in {'client_cards','model_details','july_results','mood_survey'}:
                from supplemental_import import import_supplement
                return import_supplement(self,path,kind,open_workbook)
            with open_workbook(path, self.temp_dir) as workbook:
                self.report["sheets"] = [{k: v for k, v in s.items() if k != "path"} for s in workbook.sheets]
                self.progress()
                for sheet in workbook.sheets:
                    if sheet["state"] != "visible":
                        self.counters["technical_sheets_skipped"] += 1
                        continue
                    if kind == "complaint_summaries":
                        self.import_summary_sheet(workbook, sheet)
                        continue
                    header_row = 6 if kind == "staff" else 1
                    for row_num, values in workbook.rows(sheet):
                        if row_num == header_row:
                            self.report["headers"][sheet["name"]] = values
                            continue
                        if row_num < header_row or not any(v is not None and str(v).strip() for v in values.values()):
                            continue
                        self.rows_read += 1
                        ref = self.source_ref(sheet["name"], row_num)
                        if kind in PAYROLL_FIELDS:
                            self.import_payroll(values, ref, kind)
                        elif kind == "meetings":
                            self.import_meeting(values, ref)
                        elif kind.startswith("offers_"):
                            self.import_offer(values, ref, kind, workbook.date1904)
                        elif kind == "incidents":
                            self.import_incident(values, ref, workbook.date1904)
                        elif kind == "staff":
                            self.import_staff(values, ref)
                        elif kind == "clusters":
                            self.import_cluster(values, ref)
                        if self.rows_read % self.progress_every == 0:
                            self.progress()
                self.progress("complete")
            return {"file_name": path.name, "status": "complete", "rows_read": self.rows_read,
                    "rows_kept": self.rows_kept, "report": self.report}
        except Exception as exc:
            self.conn.rollback()
            self.progress("error", f"{type(exc).__name__}: {exc}")
            return {"file_name": path.name, "status": "error", "error": f"{type(exc).__name__}: {exc}"}

    def import_payroll(self, v, ref, kind):
        gosb = gosb_identifier(v.get("B"))
        if gosb != PILOT_GOSB:
            return
        self.counters["pilot_source_rows"] += 1
        attrs = {k: v.get(c) for c, k in zip("ACGHIJK", ("tb", "gosb_name", "position", "position_type", "employee_id", "priority", "significance"))}
        oid, _ = self.organization(v.get("D"), v.get("E"), gosb, attrs, ref)
        fields = PAYROLL_FIELDS[kind]
        values = {field: self.numeric(v.get(col), kind == "recipients") for col, field in fields.items()}
        raw_values = {field: v.get(col) for col, field in fields.items()}
        if oid in self.payroll_seen:
            if self.payroll_seen[oid] == values:
                self.counters["equal_duplicate_rows"] += 1
                return
            # An inconsistent duplicate is retained as evidence, never summed or
            # allowed to silently overwrite a financial fact.
            self.quality["payroll_conflicts"] += 1
            existing = self.conn.execute("SELECT source_json FROM payroll WHERE org_id=?", (oid,)).fetchone()
            sources = json.loads(existing[0])
            sources.setdefault("conflicts", []).append({"ref": ref, "values": values, "raw_values": raw_values})
            self.conn.execute("UPDATE payroll SET source_json=? WHERE org_id=?", (json_text(sources), oid))
            return
        self.payroll_seen[oid] = values
        existing = self.conn.execute("SELECT source_json FROM payroll WHERE org_id=?", (oid,)).fetchone()
        sources = json.loads(existing[0]) if existing else {}
        for field in fields.values():
            sources[field] = {**ref, "raw": raw_values[field], "unit": "person" if kind == "recipients" else "RUB"}
        cols = list(values)
        sql = f"INSERT INTO payroll(org_id,{','.join(cols)},source_json) VALUES({','.join('?' for _ in range(len(cols)+2))}) ON CONFLICT(org_id) DO UPDATE SET {','.join(c+'=excluded.'+c for c in cols)},source_json=excluded.source_json"
        self.conn.execute(sql, (oid, *[values[c] for c in cols], json_text(sources)))
        self.rows_kept += 1

    def import_meeting(self, v, ref):
        gosb = gosb_identifier(v.get("B"))
        if gosb != PILOT_GOSB:
            return
        self.counters["pilot_source_rows"] += 1
        attrs = {"tb": v.get("A"), "position": v.get("F"), "role": v.get("G"), "employee_id": identifier(v.get("H")), "priority": v.get("I"), "significance": v.get("J")}
        oid, _ = self.organization(v.get("C"), v.get("D"), gosb, attrs, ref)
        counts = tuple(self.numeric(v.get(c), True) for c in "KLM")
        if oid in self.meeting_seen:
            previous = self.meeting_seen[oid]
            if counts == previous:
                self.counters["equal_duplicate_rows"] += 1
                return
            self.quality["meeting_conflicts"] += 1
            row = self.conn.execute("SELECT data_json FROM meetings WHERE org_id=?", (oid,)).fetchone()
            data = json.loads(row[0])
            data.setdefault("conflicting_rows", []).append({"ref": ref, "counts": counts})
            self.conn.execute("UPDATE meetings SET conflict=1,data_json=? WHERE org_id=?", (json_text(data), oid))
            return
        self.meeting_seen[oid] = counts
        data = {"source": ref, "raw_counts": {c: v.get(c) for c in "KLM"}, "grain": "gosb_inn", "duplicate_rule": "equal_counts_count_once"}
        self.conn.execute("INSERT INTO meetings(org_id,q1,q2,q3,conflict,data_json) VALUES(?,?,?,?,0,?) ON CONFLICT(org_id) DO UPDATE SET q1=excluded.q1,q2=excluded.q2,q3=excluded.q3,conflict=0,data_json=excluded.data_json", (oid, *counts, json_text(data)))
        for i, count in enumerate(counts, 1):
            if count is not None:
                self.counters[f"q{i}_total"] += count
        self.rows_kept += 1

    def import_offer(self, v, ref, kind, date1904=False):
        current = kind == "offers_current"
        self.counters["source_offer_rows"] += 1
        raw_inn = v.get("C" if current else "A")
        if current:
            gosb = gosb_identifier(v.get("B"))
            if gosb != PILOT_GOSB:
                return
            oid, inn = self.organization(raw_inn, v.get("D"), gosb, {"tb": v.get("A")}, ref)
            if inn:
                if inn in self.pilot_inns and self.pilot_inns[inn] != oid:
                    self.pilot_inns[inn] = None
                else:
                    self.pilot_inns[inn] = oid
        else:
            inn, issue = normalize_inn(raw_inn)
            if inn not in self.pilot_inns:
                return
            oid = self.pilot_inns[inn]
            if oid is None:
                self.quality["ambiguous_org_join"] += 1
            if issue:
                self.quality[issue] += 1
        self.counters["pilot_source_rows"] += 1
        columns = {
            "offer_id": "E" if current else "C", "product": "F" if current else "E",
            "amount": "G" if current else "F", "expected_income": "H" if current else "G",
            "stage": "L" if current else "K", "stage_date": "M" if current else "L",
            "trigger": "I" if current else "H", "trigger_code": "J" if current else "I",
            "potential_description": "K" if current else "J", "days_in_stage": "N" if current else "M",
            "days_since_creation": "O" if current else "N", "deal_description": "P" if current else "O",
            "notes": "Q" if current else "P", "sales_format": "R" if current else "Q",
            "manager": "S" if current else "R", "sales_leader": "T" if current else "S",
            "tag": "U" if current else "T", "hashtag": "V" if current else "U",
        }
        data = {key: v.get(col) for key, col in columns.items()}
        data.update(source=ref, raw_inn=raw_inn, snapshot_date=PERIODS[kind]["snapshot_date"],
                    snapshot_date_inferred=True, currency="RUB", expected_income_definition="ОД", amount_unit_confirmed=True)
        if not current:
            data["deal_id"] = identifier(v.get("D"))
        offer_id = identifier(data["offer_id"])
        if not offer_id:
            self.quality["missing_offer_id"] += 1
        snapshot = PERIODS[kind]["snapshot"]
        row_id = f"{self.source_id}:{digest(ref['sheet'], 8)}:{ref['row']}"
        stage_date = date_value(data["stage_date"], date1904)
        if data["stage_date"] and not stage_date:
            self.quality["unparsed_stage_dates"] += 1
        self.conn.execute("INSERT INTO offers(id,offer_id,inn,org_id,snapshot,product,amount,expected_income,stage,stage_date,data_json,source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
                          (row_id, offer_id or None, inn, oid, snapshot, data["product"],
                           self.numeric(data["amount"]), self.numeric(data["expected_income"]),
                           data["stage"], stage_date, json_text(data), self.source_id))
        self.rows_kept += 1

    def import_incident(self, v, ref, date1904=False):
        region = str(v.get("A") or "").strip()
        if "татарстан" not in region.casefold():
            return
        created = date_value(v.get("F"), date1904)
        closed = date_value(v.get("G"), date1904)
        if v.get("F") and not created:
            self.quality["unparsed_created_dates"] += 1
        if v.get("G") and not closed:
            self.quality["unparsed_closed_dates"] += 1
        status = "closed" if closed else ("unknown" if v.get("G") else "open")
        labels = ("region", "topic_group", "topic", "department", "executor", "created_raw", "closed_raw", "type", "result", "audience", "text", "first_response", "first_pi", "second_pi", "third_pi", "municipality", "settlement", "street", "object")
        data = {label: v.get(chr(ord("A") + i)) for i, label in enumerate(labels)}
        data.update(source=ref, geocoding_status="not_geocoded", status_derivation="closed_date")
        for c, name in (("P", "municipality"), ("Q", "settlement"), ("R", "street"), ("S", "object")):
            if not v.get(c) or not str(v[c]).strip():
                self.quality[f"missing_{name}"] += 1
        row_id = f"{self.source_id}:{digest(ref['sheet'], 8)}:{ref['row']}"
        self.conn.execute("INSERT INTO incidents(id,region,municipality,settlement,street,object,topic_group,topic,created_at,closed_at,status,data_json,source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
                          (row_id, region, v.get("P"), v.get("Q"), v.get("R"), v.get("S"), v.get("B"), v.get("C"), created, closed, status, json_text(data), self.source_id))
        self.rows_kept += 1

    def import_staff(self, v, ref):
        employee_id = identifier(v.get("K"))
        version = f"{self.report['file_name']}:{self.source_id[:12]}"
        labels = ("segment", "role", "division_type_2", "division_type_3", "division_3", "division_4", "division_5", "functional_block", "position", "employee_id", "name", "assigned_role")
        data = {label: v.get(chr(ord("B") + i)) for i, label in enumerate(labels)}
        data.update(source=ref, period=PERIODS["staff"], source_version=version)
        sid = f"{version}:{employee_id or 'row' + str(ref['row'])}"
        if not employee_id:
            self.quality["missing_employee_id"] += 1
        self.conn.execute("INSERT INTO staff(id,source_version,employee_id,data_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json", (sid, version, employee_id or None, json_text(data)))
        self.rows_kept += 1

    def import_cluster(self, v, ref):
        gosb = gosb_identifier(v.get("B"))
        if not gosb:
            self.quality["missing_gosb"] += 1
            gosb = f"unresolved:{self.source_id[:12]}:{ref['row']}"
        data = {"tb": v.get("A"), "name": v.get("C"), "raw_gosb": v.get("B"), "cluster_2025": self.numeric(v.get("D"), True), "cluster_2026": self.numeric(v.get("E"), True), "source": ref}
        self.conn.execute("INSERT INTO bank_clusters(gosb,data_json) VALUES(?,?) ON CONFLICT(gosb) DO UPDATE SET data_json=excluded.data_json", (gosb, json_text(data)))
        self.rows_kept += 1

    def import_summary_sheet(self, workbook, sheet):
        filters = {}
        headers = {}
        for row_num, values in workbook.rows(sheet):
            if row_num in (1, 2):
                filters[str(values.get("A") or f"row_{row_num}")] = values.get("B")
            if row_num == 5:
                headers = values
                self.report["headers"][sheet["name"]] = values
                continue
            if row_num <= 5 or not any(v is not None and str(v).strip() for v in values.values()):
                continue
            self.rows_read += 1
            data = {"sheet": sheet["name"], "filters": filters, "row_label": values.get("A"),
                    "values": {headers.get(c, c): self.numeric(v, True) for c, v in values.items() if c != "A"},
                    "year": None, "grain": "tb_month_filter_view", "source": self.source_ref(sheet["name"], row_num)}
            sid = f"{self.source_id}:{digest(sheet['name'], 8)}:{row_num}"
            self.conn.execute("INSERT INTO complaint_summaries(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json", (sid, json_text(data)))
            self.rows_kept += 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    from live.runtime_paths import data_path
    parser.add_argument("--db", default=os.environ.get("ATLAS_DB") or str(data_path("private-data", "atlas.sqlite")))
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--file", action="append", type=Path, default=[])
    parser.add_argument("--kind", choices=sorted(set(SOURCE_NAMES.values())), help="For one explicitly selected --file")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--reprocess", action="store_true", help="Explicitly reprocess the same hash after an importer fix; deterministic rows are upserted")
    parser.add_argument("--progress-every", type=int, default=5000)
    args = parser.parse_args(argv)
    if args.kind and (len(args.file) != 1 or args.directory):
        parser.error("--kind requires exactly one --file and no --directory")
    if not args.file and not args.directory:
        parser.error("Select --file or --directory")
    if args.progress_every < 1:
        parser.error("--progress-every must be positive")
    files = list(args.file)
    if args.directory:
        files.extend(args.directory / name for name in SOURCE_NAMES if (args.directory / name).is_file())
    files = list(dict.fromkeys(p.expanduser().resolve() for p in files))
    files.sort(key=lambda p: ORDER.get(args.kind or SOURCE_NAMES.get(canonical_source_name(p.name)), 100))
    if not files:
        parser.error("No supported XLSX files found")
    conn = open_database(args.db)
    importer = Importer(conn, temp_dir=str(Path(args.db).resolve().parent), progress_every=args.progress_every, quiet=args.quiet)
    failed = False
    try:
        for path in files:
            try:
                result = importer.import_file(path, args.kind, reprocess=args.reprocess)
                failed |= result["status"] == "error"
            except (OSError, ValueError) as exc:
                failed = True
                print(json_text({"file_name": path.name, "status": "error", "error": str(exc)}), flush=True)
        counts = {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                  for table in ("imports", "organizations", "payroll", "meetings", "offers", "incidents", "staff", "bank_clusters", "complaint_summaries")}
        print(json_text({"finished": not failed, "schema_version": SCHEMA_VERSION, "counts": counts}), flush=True)
    finally:
        conn.close()
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
