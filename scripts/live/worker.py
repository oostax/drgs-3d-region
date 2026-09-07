#!/usr/bin/env python3
from __future__ import annotations

import argparse
import queue
from region_config import event_territory,registry as region_registry
import concurrent.futures
import contextlib
import csv
import datetime as dt
import fcntl
import hashlib
import json
import os
import random
import re
import signal
import sqlite3
import sys
import time
import unicodedata
import urllib.error
from dataclasses import asdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from runtime_paths import DATA_ROOT, public_path
from analysis import AnyModelAnalyzer, analysis_source_text, is_relevant, needs_ai_review, rule_based, validate_events
from connectors import BoundedFetcher, FeedDocument, hash_document, iso_now, parse_source
from geocoding import consume_geocode_jobs, enqueue_geocode_job, preserve_location_metadata, merge_duplicate_source_site
from usefulness import classify_usefulness


DEFAULT_DB = DATA_ROOT / "data/live/atlas-live.sqlite"
SCHEMA = HERE / "schema.sql"
REGISTRY = DATA_ROOT / "data/live/sources.json"
LEGACY_SIGNALS = public_path("signals.json")
LOCK = DATA_ROOT / "data/live/worker.lock"
ACTIVE_ADAPTERS = {"rss", "vodokanal-incidents"}
STOP = False
ENV_KEY = re.compile(r"^ATLAS_[A-Z0-9_]+$")
ANALYSIS_BATCH_DEFAULT = 4
ANALYSIS_BATCH_MAX = 20
ANALYSIS_MAX_ATTEMPTS = 3


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_after(seconds: int, jitter: float = 0.08) -> str:
    adjusted = seconds * (1 + random.uniform(-jitter, jitter))
    return (utc_now() + dt.timedelta(seconds=max(1, adjusted))).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def stable_id(prefix: str, value: str, size: int = 24) -> str:
    return prefix + hashlib.sha256(value.encode()).hexdigest()[:size]


def load_local_env(path: Path = ROOT / ".env.local") -> int:
    """Load literal ATLAS_* KEY=VALUE pairs without expansion or evaluation."""
    if not path.exists():
        return 0
    loaded = 0
    for raw_line in path.read_text(errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not ENV_KEY.fullmatch(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key not in os.environ:
            os.environ[key] = value
            loaded += 1
    return loaded


def open_database(path: Path = DEFAULT_DB) -> sqlite3.Connection:
    if not SCHEMA.exists():
        raise RuntimeError(f"shared schema is missing: {SCHEMA}")
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.executescript(SCHEMA.read_text())
    # v1 databases can exist from an earlier local run. SQLite's additive
    # migration is deliberately repeated safely before code reads the column.
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(events)")}
    if "notify_eligible" not in columns:
        connection.execute("ALTER TABLE events ADD COLUMN notify_eligible INTEGER NOT NULL DEFAULT 0")
    if "reviewed" not in columns:
        connection.execute("ALTER TABLE events ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0")
    connection.execute("UPDATE events SET reviewed=1 WHERE legacy_id IS NOT NULL")
    history_columns = {row["name"] for row in connection.execute("PRAGMA table_info(event_history)")}
    for column in ("source_published_at", "data_json"):
        if column not in history_columns:
            connection.execute(f"ALTER TABLE event_history ADD COLUMN {column} TEXT")
    document_columns = {row["name"] for row in connection.execute("PRAGMA table_info(documents)")}
    if "analysis_attempts" not in document_columns:
        connection.execute("ALTER TABLE documents ADD COLUMN analysis_attempts INTEGER NOT NULL DEFAULT 0")
    if "analysis_next_attempt_at" not in document_columns:
        connection.execute("ALTER TABLE documents ADD COLUMN analysis_next_attempt_at TEXT")
    # A singleton worker can safely reclaim attempts interrupted between the
    # durable running marker and the model response.
    connection.execute("UPDATE documents SET analysis_status='rule_based_queued' WHERE analysis_status='running'")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_documents_analysis_queue "
        "ON documents(analysis_status,analysis_next_attempt_at,published_at DESC)")
    revision_columns = {row["name"] for row in connection.execute("PRAGMA table_info(revisions)")}
    if "notify_eligible" not in revision_columns:
        connection.execute("ALTER TABLE revisions ADD COLUMN notify_eligible INTEGER NOT NULL DEFAULT 0")
    connection.execute("INSERT INTO schema_meta(key,value) VALUES('schema_version','4') "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    return connection


@contextlib.contextmanager
def transaction(connection: sqlite3.Connection):
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield
    except Exception:
        connection.rollback()
        raise
    else:
        connection.commit()


@contextlib.contextmanager
def singleton_lock(path: Path = LOCK):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+")
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another live worker owns the process lock") from exc
        handle.seek(0)
        handle.truncate()
        handle.write(json_text({"pid": os.getpid(), "startedAt": iso_now()}))
        handle.flush()
        yield
    finally:
        try:
            fcntl.flock(handle, fcntl.LOCK_UN)
        finally:
            handle.close()


def heartbeat(connection: sqlite3.Connection, state: str, message: str = "", success: bool = False) -> None:
    now = iso_now()
    connection.execute(
        "INSERT INTO worker_state(id,state,heartbeat_at,last_success_at,message,pid,started_at) VALUES(1,?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET state=excluded.state,heartbeat_at=excluded.heartbeat_at,"
        "last_success_at=CASE WHEN ? THEN excluded.heartbeat_at ELSE worker_state.last_success_at END,"
        "message=excluded.message,pid=excluded.pid,started_at=COALESCE(worker_state.started_at,excluded.started_at)",
        (state, now, now if success else None, message[:1000], os.getpid(), now, int(success)),
    )


def load_registry(path: Path = REGISTRY) -> list[dict[str, Any]]:
    raw = json.loads(path.read_text())
    sources = raw.get("sources") if isinstance(raw, dict) else raw
    if not isinstance(sources, list):
        raise ValueError("sources.json must contain a sources list")
    ids, urls = set(), set()
    for source in sources:
        if not isinstance(source, dict) or not source.get("id") or not source.get("url"):
            raise ValueError("every source needs id and url")
        if source["id"] in ids or source["url"] in urls:
            raise ValueError(f"duplicate source id or URL: {source['id']}")
        ids.add(source["id"]); urls.add(source["url"])
    return sources


def sync_registry(connection: sqlite3.Connection, sources: list[dict[str, Any]]) -> None:
    now = iso_now()
    with transaction(connection):
        for source in sources:
            coverage = source.get("coverage", [])
            connection.execute(
                "INSERT INTO sources(id,name,region_id,territory_id,url,adapter,source_kind,status,interval_seconds,languages_json,topics_json,coverage_json,"
                "fetch_allowed,ai_allowed,display_allowed,rights_note,provenance_url,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,region_id=excluded.region_id,"
                "territory_id=excluded.territory_id,url=excluded.url,adapter=excluded.adapter,source_kind=excluded.source_kind,"
                "status=CASE WHEN sources.status IN ('error','unavailable') AND excluded.status='active' THEN sources.status ELSE excluded.status END,"
                "interval_seconds=excluded.interval_seconds,languages_json=excluded.languages_json,topics_json=excluded.topics_json,"
                "coverage_json=excluded.coverage_json,fetch_allowed=excluded.fetch_allowed,ai_allowed=excluded.ai_allowed,"
                "display_allowed=excluded.display_allowed,rights_note=excluded.rights_note,provenance_url=excluded.provenance_url,updated_at=excluded.updated_at",
                (source["id"], source["name"], source.get("region_id", region_registry()["defaultRegion"]), source.get("territory_id"), source["url"],
                 source.get("adapter", "html"), source.get("source_kind", "media"), source.get("status", "discovered"),
                 int(source.get("interval_seconds", 3600)), json_text(source.get("languages", [])), json_text(source.get("topics", [])),
                 json_text(coverage), int(bool(source.get("fetch_allowed"))), int(bool(source.get("ai_allowed"))),
                 int(bool(source.get("display_allowed"))), source.get("rights_note", ""), source.get("provenance_url", source["url"]), now, now),
            )
            connection.execute("DELETE FROM source_coverage WHERE source_id=?", (source["id"],))
            for item in coverage:
                if isinstance(item, str):
                    territory_id, level = item, "direct"
                else:
                    territory_id, level = item["territory_id"], item.get("coverage_level", "direct")
                connection.execute("INSERT INTO source_coverage(territory_id,source_id,coverage_level) VALUES(?,?,?)",
                    (territory_id, source["id"], level))


def _legacy_state(signal_value: dict[str, Any]) -> str:
    lifecycle = signal_value.get("lifecycle") or {}
    value = lifecycle.get("status") or signal_value.get("status") or "unknown"
    return {"completed": "resolved", "under_construction": "in_progress", "not_applicable": "unknown"}.get(value, value if value in {"reported","planned","in_progress","paused","resolved","cancelled","unknown"} else "unknown")


def migrate_legacy(connection: sqlite3.Connection, path: Path = LEGACY_SIGNALS) -> int:
    if not path.exists():
        return 0
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    checkpoint = connection.execute("SELECT value FROM checkpoints WHERE source_id='__system__' AND key='legacy_signals_hash'").fetchone()
    if checkpoint and checkpoint["value"] == digest:
        return 0
    values = json.loads(raw)
    imported = 0
    now = iso_now()
    with transaction(connection):
        for item in values:
            legacy_id = str(item.get("id") or "")
            published = item.get("publishedAt") or item.get("checkedAt")
            if not legacy_id or not published:
                continue
            published = published if "T" in published else published + "T00:00:00Z"
            event_id = stable_id("evt_legacy_", legacy_id)
            coords = item.get("coordinates")
            longitude = coords[0] if isinstance(coords, list) and len(coords) == 2 else None
            latitude = coords[1] if isinstance(coords, list) and len(coords) == 2 else None
            lifecycle = item.get("lifecycle") or {}
            state = _legacy_state(item)
            last_evidence = item.get("checkedAt") or published
            precision = item.get("precision") or "territory"
            if precision not in {"territory","settlement","street","building","site"}:
                precision = "territory"
            explicit_activity = int(bool(lifecycle.get("animationEligible") and lifecycle.get("currentStatusVerified")))
            row = connection.execute("SELECT id FROM events WHERE legacy_id=?", (legacy_id,)).fetchone()
            connection.execute(
                "INSERT INTO events(id,legacy_id,region_id,territory_id,canonical_key,title,summary,category,topic,state,severity,confidence,source_kind,"
                "event_time,published_at,last_evidence_at,last_meaningful_at,closed_at,address,longitude,latitude,precision,location_confidence,"
                "activity_kind,explicit_activity,data_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at",
                (event_id, legacy_id, "RU-TA", item.get("territoryId"), "legacy:" + legacy_id, item.get("title", "Сигнал"),
                 item.get("summary", ""), item.get("category", "other"), item.get("category", "other"), state, "medium", "high",
                 "official" if "official" in str(item.get("verificationMethod", "")) else "media", published, published, last_evidence,
                 lifecycle.get("asOf") or last_evidence, item.get("closedAt"), item.get("address"), longitude, latitude, precision,
                 precision if longitude is not None else "unknown", "construction" if explicit_activity else "generic", explicit_activity,
                 json_text(item), now),
            )
            connection.execute("UPDATE events SET reviewed=1 WHERE id=?", (event_id,))
            connection.execute("INSERT INTO event_aliases(alias,event_id) VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET event_id=excluded.event_id", (legacy_id, event_id))
            if not row:
                revision = connection.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,?,0,?)", (event_id, "upsert", now)).lastrowid
                connection.execute("UPDATE events SET revision=? WHERE id=?", (revision, event_id))
                imported += 1
            source_url = item.get("sourceUrl")
            if source_url:
                evidence_id = stable_id("evd_legacy_", legacy_id + "|" + source_url)
                connection.execute("INSERT OR IGNORE INTO event_evidence(id,event_id,label,url,published_at,observed_at,event_time,quote,source_kind,supports) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (evidence_id, event_id, item.get("sourceName") or "Исходный материал", source_url, published, last_evidence, lifecycle.get("asOf"),
                     (item.get("facts") or [None])[0], "official" if "official" in str(item.get("verificationMethod", "")) else "media", "report"))
        connection.execute("INSERT INTO checkpoints(source_id,key,value,updated_at) VALUES('__system__','legacy_signals_hash',?,?) "
            "ON CONFLICT(source_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", (digest, now))
    return imported


def _canonical_url(value: str) -> str:
    return re.sub(r"[?&](?:utm_[^=&]+|yclid|from)=[^&#]*", "", value).rstrip("?&")


def _event_scope(event: dict[str, Any], territory_id: str | None) -> str:
    candidates = event.get("address_candidates") or event.get("addressCandidates") or event.get("locality_candidates") or event.get("localityCandidates") or []
    explicit = " ".join(str(value) for value in candidates[:2]) if isinstance(candidates, list) else ""
    scope=" ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", explicit).casefold())) or territory_id or "RU-TA"
    if event.get('site_group_key') and event.get('location_context'):
        # Two Central streets in different villages in the same municipality
        # are distinct places even when one article lists them on the same date.
        scope+='|'+hashlib.sha256(event['location_context'].casefold().encode()).hexdigest()[:16]
    return scope


def _canonical_key(event: dict[str, Any], territory_id: str | None, region_id: str | None = None) -> str:
    title = unicodedata.normalize("NFKC", event["title"]).casefold()
    title = re.sub(r"\b(сообщил[аи]?|стало известно|татарстан|район)\b", " ", title)
    title = " ".join(re.findall(r"[^\W_]+", title))
    day = (event.get("event_time") or "")[:10]
    prefix = "" if not region_id or region_id == region_registry()["defaultRegion"] else region_id + "|"
    return hashlib.sha256((prefix + event.get("topic", "other") + "|" + day + "|" + _event_scope(event, territory_id) + "|" + title).encode()).hexdigest()


def _existing_event(connection: sqlite3.Connection, event: dict[str, Any], territory_id: str | None, region_id: str | None = None) -> sqlite3.Row | None:
    region_id = region_id or region_registry()["defaultRegion"]
    key = _canonical_key(event, territory_id, region_id)
    exact = connection.execute("SELECT * FROM events WHERE canonical_key=? AND region_id=? AND deleted=0", (key,region_id)).fetchone()
    if exact:
        return exact
    day = (event.get("event_time") or "")[:10]
    if not day:
        return None
    candidates = connection.execute("SELECT * FROM events WHERE region_id=? AND topic=? AND substr(COALESCE(event_time,published_at),1,10)=? AND territory_id IS ? AND deleted=0 LIMIT 50",
        (region_id,event.get("topic", "other"), day, territory_id)).fetchall()
    normalized = event["title"].casefold()
    scope = _event_scope(event, territory_id)
    return next((row for row in candidates if _event_scope(json.loads(row['data_json'] or '{}'), territory_id) == scope
        and SequenceMatcher(None, normalized, row["title"].casefold()).ratio() >= .88), None)


def activity_kind(event: dict[str, Any], explicit: bool) -> str:
    # Semantic kind is useful even for a static, unverified observation. Actual
    # equipment animation is gated separately by explicit_activity and its TTL.
    topic = event.get("topic", "other")
    state = event.get("state", "unknown")
    text=(event.get('title','')+' '+event.get('summary','')).casefold()
    if topic == "roads":
        # A restriction describes access to the road, not damage or a repair
        # crew. Retain its own semantic kind even when the closure is planned.
        if re.search(r'ограничени[яейю].{0,40}(?:движени|проезд)|(?:движени|проезд).{0,40}огранич|перекроют|закроют.{0,30}(?:проезд|движени)',text):
            return "place_event"
        return "road_repair" if re.search(r'ремонт|асфальт|покрыти|бордюр|реконструкц',text) else "road_defect"
    if topic == "utilities": return "utility_repair" if state == "in_progress" else "utility_fault"
    if topic == "waste": return "cleanup" if state == "in_progress" else "waste"
    return {"construction":"construction","fire":"fire","flood":"flood","weather":"emergency","culture":"place_event","education":"place_event","health":"place_event","landscape":"place_event","business":"place_event"}.get(topic,"generic")


def normalize_due_event_states(connection: sqlite3.Connection, now: dt.datetime | None = None) -> int:
    """Advance scheduled events once their explicitly stated start has passed.

    The transition is deliberately one-way and conservative: a past schedule
    can mean work has started, but it never proves completion. Completion still
    requires source evidence such as «завершено» or an explicit status update.
    """
    now = now or utc_now()
    moscow = dt.timezone(dt.timedelta(hours=3))
    month_numbers = {'январ':1,'феврал':2,'март':3,'апрел':4,'ма':5,'июн':6,'июл':7,'август':8,'сентябр':9,'октябр':10,'ноябр':11,'декабр':12}
    changed = 0
    rows = connection.execute("SELECT * FROM events WHERE deleted=0 AND state='planned' AND event_time IS NOT NULL").fetchall()
    for row in rows:
        raw = str(row['event_time'] or '').strip()
        try:
            start = dt.datetime.fromisoformat(raw.replace('Z', '+00:00'))
            if start.tzinfo is None: start = start.replace(tzinfo=dt.timezone(dt.timedelta(hours=3)))
        except ValueError:
            continue
        data = json.loads(row['data_json'] or '{}')
        if row['topic'] not in {'utilities', 'roads', 'construction', 'waste', 'landscape'}:
            continue
        text = ' '.join(str(data.get(key) or '') for key in ('title', 'summary', 'facts'))
        if not re.search(r'отключ|ремонт|работ[аы]|ограничен|перекры|график|планов', text, re.I):
            continue
        effective_start = start
        range_match = re.search(r'с\s+(\d{1,2})\s+по\s+\d{1,2}\s+([а-яё]+)(?:\s+(20\d{2}))?', text, re.I)
        if range_match:
            month = next((n for key, n in month_numbers.items() if range_match.group(2).casefold().startswith(key)), None)
            year = int(range_match.group(3)) if range_match.group(3) else start.year
            if month: effective_start = dt.datetime(year, month, int(range_match.group(1)), tzinfo=moscow)
        if effective_start > now: continue
        if re.search(r'отмен[её]н|заверш[её]н|выполнен|работы окончены|ликвидир', text, re.I):
            continue
        data['state'] = 'in_progress'
        data['statusTransition'] = {'kind': 'schedule-started', 'at': now.isoformat(), 'sourceTime': raw,
                                    'note': 'Плановый срок наступил; завершение работ источником не подтверждено.'}
        revision = connection.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,?,0,?)",
                                      (row['id'], 'upsert', now.isoformat())).lastrowid
        connection.execute("UPDATE events SET state='in_progress',activity_kind=?,last_meaningful_at=?,data_json=?,revision=?,updated_at=? WHERE id=?",
                           ('utility_repair' if row['topic']=='utilities' else activity_kind({'topic':row['topic'],'state':'in_progress','title':row['title'],'summary':row['summary']}, False),
                            now.isoformat(), json_text(data), revision, now.isoformat(), row['id']))
        connection.execute("INSERT INTO event_history(event_id,state,at,label,data_json) VALUES(?,?,?,?,?)",
                           (row['id'], 'in_progress', now.isoformat(), 'Плановый срок наступил; статус обновлён автоматически', json_text(data)))
        changed += 1
    if changed: connection.commit()
    return changed


def store_document(connection: sqlite3.Connection, source: sqlite3.Row, document: FeedDocument, analyzer: AnyModelAnalyzer,
        *, notify_new: bool = True, geocode_immediately: bool = False) -> dict[str, int]:
    content_hash = hash_document(document)
    document_id = stable_id("doc_", source["id"] + "|" + document.external_id)
    now = iso_now()
    previous = connection.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
    if previous is not None and not document.deleted:
        from article_enrichment import preserve_enriched_body
        document=preserve_enriched_body(connection,previous,document)
        content_hash=hash_document(document)
    if document.deleted:
        if previous is not None and previous["deleted_at"] is not None:
            return {"documents":0,"versions":0,"events":0}
        if previous is None:
            # Reconcile can observe an already-old deletion whose original was
            # never ingested. It cannot support a factual event without text.
            return {"documents": 0, "versions": 0, "events": 0}
        with transaction(connection):
            connection.execute("UPDATE documents SET deleted_at=?,last_seen_at=?,fetched_at=?,status='deleted',analysis_status='complete' WHERE id=?",
                (now,now,now,document_id))
            connection.execute("INSERT OR IGNORE INTO document_versions(document_id,content_hash,title,excerpt,body,observed_at,meaningful) VALUES(?,?,?,?,?,?,1)",
                (document_id,content_hash,previous["title"],previous["excerpt"],previous["body"],now))
            version_added = connection.execute("SELECT changes()").fetchone()[0]
            linked=connection.execute("SELECT e.* FROM events e JOIN event_documents d ON d.event_id=e.id WHERE d.document_id=?",(document_id,)).fetchall()
            for event in linked:
                evidence_id=stable_id("evd_deleted_",event["id"]+"|"+document_id+"|"+now)
                connection.execute("INSERT INTO event_evidence(id,event_id,document_id,source_id,label,url,published_at,observed_at,event_time,source_kind,supports) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (evidence_id,event["id"],document_id,source["id"],source["name"]+" — материал удалён",previous["canonical_url"],previous["published_at"],now,None,source["source_kind"],"dispute"))
                connection.execute("INSERT INTO event_history(event_id,state,at,label,source_url) VALUES(?,?,?,?,?)",
                    (event["id"],event["state"],now,"Материал исчез из источника; состояние события автоматически не изменено",previous["canonical_url"]))
                revision=connection.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,?,0,?)",(event["id"],"upsert",now)).lastrowid
                connection.execute("UPDATE events SET notify_eligible=0,revision=?,updated_at=? WHERE id=?",(revision,now,event["id"]))
        return {"documents": 1, "versions": int(bool(version_added)), "events": len(linked)}
    meaningful = previous is None or previous["content_hash"] != content_hash or previous["deleted_at"] is not None
    if not meaningful:
        connection.execute("UPDATE documents SET last_seen_at=?,fetched_at=? WHERE id=?", (now, now, document_id))
        return {"documents": 0, "versions": 0, "events": 0}
    if not document.published_at:
        raise ValueError("documents without an explicit source publication date are rejected")
    if not is_relevant(document, source):
        events = []
        analysis_status = "irrelevant"
    else:
        # Acquisition remains deterministic and cheap. AnyModel runs later in
        # a newest-first bounded queue, so a feed spike cannot create an
        # unbounded model bill or block collection.
        events = rule_based(document)
        needs_review = analyzer.enabled and needs_ai_review(document,events,source)
        analysis_status = "rule_based_queued" if needs_review else "rule_based"
    with transaction(connection):
        connection.execute(
            "INSERT INTO documents(id,source_id,external_id,canonical_url,title,excerpt,body,content_hash,published_at,edited_at,deleted_at,last_seen_at,fetched_at,status,analysis_status) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,excerpt=excluded.excerpt,body=excluded.body,"
            "content_hash=excluded.content_hash,edited_at=excluded.edited_at,deleted_at=excluded.deleted_at,last_seen_at=excluded.last_seen_at,"
            "fetched_at=excluded.fetched_at,status=excluded.status,analysis_status=excluded.analysis_status,analysis_error=NULL,"
            "analysis_attempts=0,analysis_next_attempt_at=NULL",
            (document_id, source["id"], document.external_id, _canonical_url(document.url), document.title, document.body[:700], document.body,
             content_hash, document.published_at, document.source_updated_at, now if document.deleted else None, now, now,
             "deleted" if document.deleted else "active", analysis_status),
        )
        connection.execute("INSERT OR IGNORE INTO document_versions(document_id,content_hash,title,excerpt,body,observed_at,meaningful) VALUES(?,?,?,?,?,?,1)",
            (document_id, content_hash, document.title, document.body[:700], document.body, now))
        version_added = connection.execute("SELECT changes()").fetchone()[0]
        connection.execute("INSERT INTO document_usefulness(document_id,data_json,assessed_at) VALUES(?,?,?) "
            "ON CONFLICT(document_id) DO UPDATE SET data_json=excluded.data_json,assessed_at=excluded.assessed_at",
            (document_id,json_text(classify_usefulness(document,source=source)),now))
        event_count = 0
        for event in events:
            territory_id = event_territory(event,document,source)
            existing = _existing_event(connection, event, territory_id, source["region_id"])
            event_id = existing["id"] if existing else stable_id("evt_", event["event_key"] + "|" + source["id"])
            alias = connection.execute('SELECT e.* FROM event_aliases a JOIN events e ON e.id=a.event_id WHERE a.alias=? AND e.deleted=0',(event_id,)).fetchone()
            if alias:
                existing=alias;event_id=alias['id']
            canonical_key = existing["canonical_key"] if existing else _canonical_key(event, territory_id, source["region_id"])
            same_document = bool(existing and connection.execute("SELECT 1 FROM event_documents WHERE event_id=? AND document_id=?",(event_id,document_id)).fetchone())
            previous_state = existing["state"] if existing else None
            substantive = not existing or same_document or previous_state != event.get("state")
            meaningful_at = (event.get("status_observed_at") or event.get("event_time") or document.published_at) if substantive else existing["last_meaningful_at"]
            notify_eligible = int(bool(notify_new and existing is None and previous is None))
            # Existing editor-reviewed location and explicit activity remain authoritative.
            longitude, latitude, precision, location_confidence = (existing["longitude"], existing["latitude"], existing["precision"], existing["location_confidence"]) if existing else (None, None, "territory", "unknown")
            # Only an explicit source quote of current work enables animation.
            # Rendering still requires independently matched geometry and a fresh status.
            explicit_activity = existing["explicit_activity"] if existing and existing["reviewed"] else int(bool(event.get("physical_activity_evidence")))
            data = dict(event)
            data['signalUsefulness'] = classify_usefulness(document,event,source)
            data["addressCandidates"] = data.pop("address_candidates", [])
            data["localityCandidates"] = data.pop("locality_candidates", [])
            data.update({"sourceUrl": document.url, "sourceName": source["name"], "publishedAt": document.published_at,
                "checkedAt": now, "facts": [span.get("quote", "") for span in event.get("evidence", []) if span.get("quote")][:3],
                "hypothesis": "Сопоставление с задачами территории требует проверки сотрудником.",
                "nextStep": "Открыть источник и уточнить текущее состояние и точное место события."})
            data = preserve_location_metadata(data, existing["data_json"] if existing else None)
            event_published = document.published_at
            connection.execute(
                "INSERT INTO events(id,region_id,territory_id,canonical_key,title,summary,category,topic,state,severity,confidence,source_kind,event_time,"
                "published_at,last_evidence_at,last_meaningful_at,address,longitude,latitude,precision,location_confidence,activity_kind,explicit_activity,notify_eligible,data_json,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,summary=excluded.summary,"
                "state=CASE WHEN events.state IN ('resolved','cancelled') AND excluded.state NOT IN ('resolved','cancelled') THEN events.state ELSE excluded.state END,"
                "severity=excluded.severity,category=excluded.category,topic=excluded.topic,activity_kind=excluded.activity_kind,explicit_activity=excluded.explicit_activity,last_evidence_at=excluded.last_evidence_at,last_meaningful_at=excluded.last_meaningful_at,"
                "notify_eligible=excluded.notify_eligible,data_json=excluded.data_json,updated_at=excluded.updated_at",
                (event_id, source["region_id"], territory_id, canonical_key, event["title"], event.get("summary", ""), event.get("topic", "other"),
                 event.get("topic", "other"), event.get("state", "unknown"), event.get("severity", "info"),
                 "medium" if event.get("analysis_status") == "anymodel" else "low", source["source_kind"], event.get("event_time"),
                 event_published, now, meaningful_at, None, longitude, latitude, precision, location_confidence,
                 activity_kind(event,bool(explicit_activity)), explicit_activity, notify_eligible, json_text(data), now),
            )
            connection.execute("INSERT INTO event_documents(event_id,document_id,relation,similarity) VALUES(?,?,?,?) "
                "ON CONFLICT(event_id,document_id) DO NOTHING", (event_id, document_id, "primary" if not existing else "republication", 1.0 if not existing else .88))
            enqueue_geocode_job(connection, event_id, source["id"], data["addressCandidates"], content_hash,priority=100)
            for index, evidence in enumerate(event.get("evidence", [])):
                evidence_id = stable_id("evd_", f"{event_id}|{document_id}|{index}|{evidence.get('quote','')}")
                connection.execute("INSERT OR IGNORE INTO event_evidence(id,event_id,document_id,source_id,label,url,published_at,observed_at,event_time,quote,source_kind,supports) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (evidence_id,event_id,document_id,source["id"],source["name"],document.url,document.published_at,now,
                    event.get("event_time"),evidence.get("quote"),source["source_kind"],"report"))
            # Keep every meaningful source version, including deadline changes within
            # the same stage. Source time and collection time are different facts.
            connection.execute("INSERT INTO event_history(event_id,state,at,label,source_url,source_published_at,data_json) VALUES(?,?,?,?,?,?,?)",
                (event_id,event.get("state","unknown"),now,"Изменение стадии в источнике" if previous_state != event.get("state") else "Обновление источника",
                 document.url,document.published_at,json_text(data)))
            revision = connection.execute("INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,?,?,?)", (event_id, "upsert", notify_eligible, now)).lastrowid
            connection.execute("UPDATE events SET revision=? WHERE id=?", (revision,event_id))
            event_count += 1
    if geocode_immediately:
        from geocoding import geocode_fresh_events
        geocode_fresh_events(connection,document_id=document_id)
    return {"documents": 1, "versions": int(bool(version_added)), "events": event_count}


def due_sources(connection: sqlite3.Connection, *, force: bool = False, source_ids: list[str] | None = None) -> list[sqlite3.Row]:
    query = "SELECT * FROM sources WHERE fetch_allowed=1 AND adapter IN ('rss','vodokanal-incidents')"
    params: tuple[Any, ...] = ()
    if source_ids:
        query += " AND id IN (" + ",".join("?" for _ in source_ids) + ")"
        params = tuple(source_ids)
    if not force:
        query += " AND status IN ('active','error','stale') AND (next_attempt_at IS NULL OR next_attempt_at<=?)"
        params += (iso_now(),)
    return connection.execute(query + " ORDER BY interval_seconds,id", params).fetchall()


def _fetch_one(fetcher: BoundedFetcher, source: sqlite3.Row):
    try:
        result = fetcher.get(source["url"], etag=source["etag"], last_modified=source["last_modified"])
        documents = [] if result.not_modified else parse_source(result, dict(source))
        if not result.not_modified and not documents:
            raise ValueError("response contained no accepted dated items")
        return source, result, documents, None
    except Exception as exc:
        return source, None, [], f"{type(exc).__name__}: {exc}"


def process_due(connection: sqlite3.Connection, *, force: bool = False, source_ids: list[str] | None = None,
        since: str | None = None, notify_new: bool = True) -> dict[str, int]:
    sources = due_sources(connection, force=force, source_ids=source_ids)
    if not sources:
        return {"sources": 0, "successful": 0, "failed": 0, "documents": 0, "versions": 0, "events": 0}
    fetcher = BoundedFetcher(global_limit=4, per_host_limit=1)
    analyzer = AnyModelAnalyzer()
    totals = {"sources": len(sources), "successful": 0, "failed": 0, "documents": 0, "versions": 0, "events": 0}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(_fetch_one, fetcher, source) for source in sources]
        # As completed keeps a slow host from delaying new sources behind it.
        for future in concurrent.futures.as_completed(futures):
            source, result, documents, error = future.result()
            now = iso_now()
            if error:
                failures = source["consecutive_failures"] + 1
                retry = min(source["interval_seconds"] * (2 ** min(failures, 6)), 86400)
                connection.execute("UPDATE sources SET status='error',last_attempt_at=?,error=?,consecutive_failures=?,next_attempt_at=?,updated_at=? WHERE id=?",
                    (now,error[:1000],failures,iso_after(retry),now,source["id"]))
                totals["failed"] += 1
                continue
            latest = max((document.published_at for document in documents), default=source["latest_publication_at"])
            for document in documents:
                if since and document.published_at and document.published_at < since:
                    continue
                try:
                    stored = store_document(connection, source, document, analyzer,
                        notify_new=bool(notify_new and source["last_success_at"]),geocode_immediately=True)
                except Exception as exc:
                    connection.execute("UPDATE documents SET analysis_status='error',analysis_error=? WHERE source_id=? AND external_id=?",
                        (f"{type(exc).__name__}: {exc}"[:1000],source["id"],document.external_id))
                    continue
                for key in ("documents","versions","events"):
                    totals[key] += stored[key]
            connection.execute("UPDATE sources SET status='active',last_attempt_at=?,last_success_at=?,latest_publication_at=?,error=NULL,etag=?,"
                "last_modified=?,consecutive_failures=0,next_attempt_at=?,updated_at=? WHERE id=?",
                (now,now,latest,result.etag,result.last_modified,iso_after(source["interval_seconds"]),now,source["id"]))
            connection.execute("UPDATE source_coverage SET last_success_at=?,latest_publication_at=? WHERE source_id=?",(now,latest,source["id"]))
            totals["successful"] += 1
    return totals


def _analysis_document(row: sqlite3.Row) -> FeedDocument:
    """Build the narrow public-text payload passed to AnyModel.

    Event metadata and the separate private banking database are deliberately
    outside this object and therefore cannot enter the model request.
    """
    return FeedDocument(
        external_id=row["external_id"] or row["id"],
        url=row["canonical_url"],
        title=row["title"],
        published_at=row["published_at"],
        body=row["body"] or "",
        source_updated_at=row["edited_at"],
    )


def _append_event_revision(connection: sqlite3.Connection, event_id: str, operation: str, now: str) -> None:
    revision = connection.execute(
        "INSERT INTO revisions(event_id,operation,notify_eligible,created_at) VALUES(?,?,0,?)",
        (event_id, operation, now),
    ).lastrowid
    connection.execute(
        "UPDATE events SET revision=?,notify_eligible=0,updated_at=? WHERE id=?",
        (revision, now, event_id),
    )


def _insert_analysis_evidence(connection: sqlite3.Connection, event_id: str, document_id: str,
        source: sqlite3.Row, document: FeedDocument, event: dict[str, Any], now: str) -> int:
    inserted = 0
    for index, evidence in enumerate(event.get("evidence", [])):
        evidence_id = stable_id("evd_ai_", f"{event_id}|{document_id}|{index}|{evidence.get('quote','')}")
        connection.execute(
            "INSERT OR IGNORE INTO event_evidence(id,event_id,document_id,source_id,label,url,published_at,observed_at,event_time,quote,source_kind,supports) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (evidence_id, event_id, document_id, source["id"], source["name"], document.url,
             document.published_at, now, event.get("event_time"), evidence["quote"], source["source_kind"], "report"),
        )
        inserted += connection.execute("SELECT changes()").fetchone()[0]
    return inserted


def _replace_document_analysis(connection: sqlite3.Connection, document_row: sqlite3.Row,
        source: sqlite3.Row, document: FeedDocument, events: list[dict[str, Any]], *, correcting_rules: bool = False) -> dict[str, int]:
    """Atomically replace only automatic event material owned by one document."""
    now = iso_now()
    old_rows = connection.execute(
        "SELECT e.* FROM events e JOIN event_documents ed ON ed.event_id=e.id WHERE ed.document_id=?",
        (document_row["id"],),
    ).fetchall()
    old_automatic = {row["id"]: row for row in old_rows if row["legacy_id"] is None and not row["reviewed"]}
    touched: set[str] = set()
    upserted = deleted = 0
    with transaction(connection):
        connection.execute("INSERT INTO document_usefulness(document_id,data_json,assessed_at) VALUES(?,?,?) "
            "ON CONFLICT(document_id) DO UPDATE SET data_json=excluded.data_json,assessed_at=excluded.assessed_at",
            (document_row['id'],json_text(classify_usefulness(document,source=source)),now))
        for event in events:
            territory_id = event_territory(event,document,source)
            existing = _existing_event(connection, event, territory_id, source["region_id"])
            event_id = existing["id"] if existing else stable_id("evt_", event["event_key"] + "|" + source["id"])
            alias = connection.execute('SELECT e.* FROM event_aliases a JOIN events e ON e.id=a.event_id WHERE a.alias=? AND e.deleted=0',(event_id,)).fetchone()
            if alias:
                existing=alias;event_id=alias['id']
            if existing is None:
                # A previous automatic interpretation may have been tombstoned.
                existing = connection.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            protected = bool(existing and (existing["legacy_id"] is not None or existing["reviewed"]))
            link_before = connection.execute(
                "SELECT 1 FROM event_documents WHERE event_id=? AND document_id=?", (event_id, document_row["id"])
            ).fetchone()
            if protected:
                connection.execute(
                    "INSERT OR IGNORE INTO event_documents(event_id,document_id,relation,similarity) VALUES(?,?,?,?)",
                    (event_id, document_row["id"], "supporting", .9),
                )
                evidence_added = _insert_analysis_evidence(connection, event_id, document_row["id"], source, document, event, now)
                if not link_before or evidence_added:
                    _append_event_revision(connection, event_id, "upsert", now)
                touched.add(event_id)
                continue

            canonical_key = existing["canonical_key"] if existing else _canonical_key(event, territory_id, source["region_id"])
            longitude, latitude, precision, location_confidence = (
                (existing["longitude"], existing["latitude"], existing["precision"], existing["location_confidence"])
                if existing else (None, None, "territory", "unknown")
            )
            relocated = bool(existing and existing['territory_id'] != territory_id)
            if relocated:
                longitude, latitude, precision, location_confidence = None, None, 'territory', 'unknown'
            explicit_activity = int(bool(event.get("physical_activity_evidence")))
            previous_state = existing["state"] if existing else None
            desired_state = event.get("state", "unknown")
            if not correcting_rules and previous_state in {"resolved", "cancelled"} and desired_state not in {"resolved", "cancelled"}:
                desired_state = previous_state
            data = dict(event)
            data['signalUsefulness'] = classify_usefulness(document,event,source)
            data["addressCandidates"] = data.pop("address_candidates", [])
            data["localityCandidates"] = data.pop("locality_candidates", [])
            data.update({
                "sourceUrl": document.url,
                "sourceName": source["name"],
                "publishedAt": document.published_at,
                "checkedAt": now,
                "facts": [span["quote"] for span in event.get("evidence", [])][:3],
                "hypothesis": "Сопоставление с задачами территории требует проверки сотрудником.",
                "nextStep": "Открыть источник и уточнить текущее состояние и точное место события.",
            })
            data = preserve_location_metadata(data, existing["data_json"] if existing and not relocated else None)
            connection.execute(
                "INSERT INTO events(id,region_id,territory_id,canonical_key,title,summary,category,topic,state,severity,confidence,source_kind,event_time,"
                "published_at,last_evidence_at,last_meaningful_at,address,longitude,latitude,precision,location_confidence,activity_kind,explicit_activity,"
                "notify_eligible,data_json,deleted,reviewed,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?) "
                "ON CONFLICT(id) DO UPDATE SET territory_id=excluded.territory_id,canonical_key=excluded.canonical_key,title=excluded.title,summary=excluded.summary,category=excluded.category,"
                "topic=excluded.topic,state=excluded.state,severity=excluded.severity,confidence=excluded.confidence,source_kind=excluded.source_kind,"
                "address=excluded.address,longitude=excluded.longitude,latitude=excluded.latitude,precision=excluded.precision,location_confidence=excluded.location_confidence,"
                "event_time=excluded.event_time,last_evidence_at=excluded.last_evidence_at,last_meaningful_at=excluded.last_meaningful_at,"
                "activity_kind=excluded.activity_kind,explicit_activity=excluded.explicit_activity,notify_eligible=0,data_json=excluded.data_json,deleted=0,updated_at=excluded.updated_at",
                (event_id, source["region_id"], territory_id, canonical_key, event["title"], event.get("summary", ""),
                 event.get("topic", "other"), event.get("topic", "other"), desired_state, event["severity"], "low" if correcting_rules else "medium",
                 source["source_kind"], event.get("event_time"), document.published_at, now, event.get("status_observed_at") or document.published_at, existing['address'] if existing and not relocated else None, longitude, latitude,
                 precision, location_confidence, activity_kind(event, bool(explicit_activity)), explicit_activity, 0, json_text(data), now),
            )
            connection.execute(
                "INSERT INTO event_documents(event_id,document_id,relation,similarity) VALUES(?,?,?,?) "
                "ON CONFLICT(event_id,document_id) DO UPDATE SET relation=excluded.relation,similarity=excluded.similarity",
                (event_id, document_row["id"], "primary" if existing is None else "republication", 1.0 if existing is None else .9),
            )
            enqueue_geocode_job(connection, event_id, source["id"], data["addressCandidates"], document_row["content_hash"] + "|analysis")
            connection.execute("DELETE FROM event_evidence WHERE event_id=? AND document_id=?", (event_id, document_row["id"]))
            _insert_analysis_evidence(connection, event_id, document_row["id"], source, document, event, now)
            connection.execute(
                "INSERT INTO event_history(event_id,state,at,label,source_url,source_published_at,data_json) VALUES(?,?,?,?,?,?,?)",
                (event_id, event.get("state","unknown"), now, "Состояние уточнено анализом публикации", document.url,document.published_at,json_text(data)),
            )
            _append_event_revision(connection, event_id, "upsert", now)
            current=connection.execute('SELECT * FROM events WHERE id=?',(event_id,)).fetchone()
            merge_duplicate_source_site(connection,current,data,data.get('locationEvidence',{}))
            touched.add(event_id)
            upserted += 1

        for event_id in old_automatic.keys() - touched:
            connection.execute("DELETE FROM event_evidence WHERE event_id=? AND document_id=?", (event_id, document_row["id"]))
            connection.execute("DELETE FROM event_documents WHERE event_id=? AND document_id=?", (event_id, document_row["id"]))
            remaining = connection.execute("SELECT COUNT(*) FROM event_documents WHERE event_id=?", (event_id,)).fetchone()[0]
            if remaining:
                _append_event_revision(connection, event_id, "upsert", now)
            else:
                connection.execute("UPDATE events SET deleted=1,notify_eligible=0 WHERE id=?", (event_id,))
                _append_event_revision(connection, event_id, "delete", now)
                deleted += 1

        connection.execute(
            "UPDATE documents SET analysis_status='complete',analysis_error=NULL,analysis_next_attempt_at=NULL WHERE id=?",
            (document_row["id"],),
        )
    return {"eventsUpserted": upserted, "eventsDeleted": deleted}


def process_analysis_queue(connection: sqlite3.Connection, analyzer: Any | None = None,
        *, batch_size: int | None = None) -> dict[str, int]:
    """Analyze a small newest-first batch of retained public documents."""
    analyzer = analyzer or AnyModelAnalyzer()
    result = {"selected": 0, "completed": 0, "failed": 0, "retrying": 0,
        "exhausted": 0, "eventsUpserted": 0, "eventsDeleted": 0}
    if not analyzer.enabled:
        return result
    blocked=connection.execute("SELECT value FROM checkpoints WHERE source_id='__system__' AND key='analysis_provider_retry_at'").fetchone()
    if blocked and blocked[0]>iso_now():
        result['providerUnavailable']=1
        return result
    connection.execute("UPDATE documents SET analysis_status='failed',analysis_error=COALESCE(analysis_error,'Retry budget exhausted before queue restart') WHERE analysis_status='rule_based_queued' AND analysis_attempts>=?",(ANALYSIS_MAX_ATTEMPTS,))
    connection.commit()
    if batch_size is None:
        try:
            batch_size = int(os.getenv("ATLAS_ANALYSIS_BATCH_SIZE", str(ANALYSIS_BATCH_DEFAULT)))
        except ValueError:
            batch_size = ANALYSIS_BATCH_DEFAULT
    batch_size = min(ANALYSIS_BATCH_MAX, max(1, batch_size))
    rows = connection.execute(
        "SELECT d.*,s.name source_name,s.source_kind,s.territory_id,s.ai_allowed,s.fetch_allowed "
        "FROM documents d JOIN sources s ON s.id=d.source_id "
        "WHERE d.analysis_status='rule_based_queued' AND d.status='active' AND d.deleted_at IS NULL "
        "AND d.analysis_attempts<? AND (d.analysis_next_attempt_at IS NULL OR d.analysis_next_attempt_at<=?) "
        "AND s.ai_allowed=1 AND s.fetch_allowed=1 AND s.display_allowed=1 ORDER BY COALESCE(d.edited_at,d.published_at) DESC,d.published_at DESC,d.id LIMIT ?",
        (ANALYSIS_MAX_ATTEMPTS, iso_now(), batch_size),
    ).fetchall()
    result["selected"] = len(rows)
    try:
        concurrency = min(4, max(1, int(os.getenv("ATLAS_ANALYSIS_CONCURRENCY", "4"))))
    except ValueError:
        concurrency = 4

    payloads = {row["id"]: _analysis_document(connection.execute("SELECT * FROM documents WHERE id=?", (row["id"],)).fetchone()) for row in rows}

    def analyze_one(row):
        document = payloads[row["id"]]
        try:
            analyzed = analyzer.analyze(document)
            return row, document, validate_events(analyzed, analysis_source_text(document), document), None
        except Exception as exc:
            return row, document, None, exc

    # Model calls are independent; keep SQLite mutations below sequential.
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = []
        for row in rows:
            with transaction(connection):
                connection.execute(
                    "UPDATE documents SET analysis_status='running',analysis_attempts=analysis_attempts+1,analysis_error=NULL WHERE id=?",
                    (row["id"],),
                )
            futures.append(pool.submit(analyze_one, row))
        analyzed_rows = [future.result() for future in futures]

    for row, document, events, error in analyzed_rows:
        current = connection.execute("SELECT * FROM documents WHERE id=?", (row["id"],)).fetchone()
        source = connection.execute("SELECT * FROM sources WHERE id=?", (row["source_id"],)).fetchone()
        try:
            if error is not None:
                raise error
            changed = _replace_document_analysis(connection, current, source, document, events)
            from geocoding import geocode_fresh_events
            geocode_fresh_events(connection,document_id=current["id"])
        except Exception as exc:
            if getattr(exc,'code',None) in (401,403,429,503):
                # 401/403/429 and transient provider outages should not consume a
                # document attempt. Keep the rule-based result and retry later.
                retry_seconds = 60 if getattr(exc,'code',None) == 503 else 1800
                retry_at=iso_after(retry_seconds,jitter=0)
                connection.execute("INSERT INTO checkpoints(source_id,key,value,updated_at) VALUES('__system__','analysis_provider_retry_at',?,?) ON CONFLICT(source_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",(retry_at,iso_now()))
                connection.execute("UPDATE documents SET analysis_status='rule_based_queued',analysis_attempts=MAX(0,analysis_attempts-1),analysis_error=?,analysis_next_attempt_at=? WHERE id=?",(f'Provider HTTP {exc.code}; retry scheduled',retry_at,row['id']))
                connection.commit();result['providerUnavailable']=1;result['failed']+=1
                break
            attempts = connection.execute("SELECT analysis_attempts FROM documents WHERE id=?", (row["id"],)).fetchone()[0]
            exhausted = attempts >= ANALYSIS_MAX_ATTEMPTS
            retry_at = None if exhausted else iso_after(60 * (2 ** max(0, attempts - 1)), jitter=0)
            connection.execute(
                "UPDATE documents SET analysis_status=?,analysis_error=?,analysis_next_attempt_at=? WHERE id=?",
                ("failed" if exhausted else "rule_based_queued", f"{type(exc).__name__}: {exc}"[:1000], retry_at, row["id"]),
            )
            result["failed"] += 1
            result["exhausted" if exhausted else "retrying"] += 1
            continue
        result["completed"] += 1
        result["eventsUpserted"] += changed["eventsUpserted"]
        result["eventsDeleted"] += changed["eventsDeleted"]
    return result


def export_data(connection: sqlite3.Connection, output: Path) -> dict[str, int]:
    output.mkdir(parents=True, exist_ok=True)
    sources = [dict(row) for row in connection.execute("SELECT * FROM sources ORDER BY name")]
    events = [dict(row) for row in connection.execute("SELECT * FROM events WHERE deleted=0 ORDER BY last_evidence_at DESC")]
    for row in sources:
        for key in ("languages_json","topics_json","coverage_json"):
            row[key.removesuffix("_json")] = json.loads(row.pop(key))
    for row in events:
        row["data"] = json.loads(row.pop("data_json"))
    (output / "sources.json").write_text(json.dumps(sources,ensure_ascii=False,indent=2)+"\n")
    (output / "events.json").write_text(json.dumps(events,ensure_ascii=False,indent=2)+"\n")
    with (output / "sources.csv").open("w",newline="",encoding="utf-8-sig") as handle:
        fields=["id","name","url","adapter","source_kind","status","territory_id","last_success_at","latest_publication_at","error"]
        writer=csv.DictWriter(handle,fieldnames=fields,extrasaction="ignore");writer.writeheader();writer.writerows(sources)
    return {"sources":len(sources),"events":len(events)}


def enqueue_backfill(connection: sqlite3.Connection, days: int) -> int:
    now=iso_now(); count=0
    with transaction(connection):
        for source in connection.execute("SELECT id FROM sources WHERE fetch_allowed=1 AND adapter IN ('rss','vodokanal-incidents','telegram')"):
            dedupe=f"backfill:{source['id']}:{days}"
            job_id=stable_id("job_",dedupe)
            connection.execute("INSERT INTO jobs(id,kind,source_id,dedupe_key,status,priority,run_after,payload_json) VALUES(?,?,?,?,?,?,?,?) "
                "ON CONFLICT(dedupe_key) DO NOTHING",(job_id,"backfill",source["id"],dedupe,"queued",-10,now,json_text({"days":days})))
            count += connection.execute("SELECT changes()").fetchone()[0]
    return count


def enqueue_manual_refresh(connection: sqlite3.Connection) -> dict[str, Any]:
    """Queue one refresh without taking the worker process lock.

    The stable job row is reset only after its preceding run finished, so repeated
    button clicks while queued/running collapse into one operation.
    """
    now = iso_now()
    with transaction(connection):
        current = connection.execute("SELECT id,status FROM jobs WHERE dedupe_key='manual-refresh'").fetchone()
        if current and current["status"] in {"queued", "running"}:
            return {"jobId": current["id"], "status": current["status"], "deduplicated": True}
        job_id = current["id"] if current else stable_id("job_", "manual-refresh")
        if current:
            connection.execute("UPDATE jobs SET status='queued',priority=100,attempts=0,run_after=?,started_at=NULL,finished_at=NULL,error=NULL,payload_json='{}' WHERE id=?", (now, job_id))
        else:
            connection.execute("INSERT INTO jobs(id,kind,dedupe_key,status,priority,run_after,payload_json) VALUES(?,?,?,?,?,?,?)",
                (job_id, "collect-due", "manual-refresh", "queued", 100, now, "{}"))
    return {"jobId": job_id, "status": "queued", "deduplicated": False}


def consume_manual_refresh(connection: sqlite3.Connection) -> dict[str, int] | None:
    with transaction(connection):
        job = connection.execute("SELECT * FROM jobs WHERE dedupe_key='manual-refresh' AND status='queued' AND run_after<=?", (iso_now(),)).fetchone()
        if not job:
            return None
        connection.execute("UPDATE jobs SET status='running',attempts=attempts+1,started_at=?,error=NULL WHERE id=?", (iso_now(), job["id"]))
    try:
        result = process_due(connection, force=True)
    except Exception as exc:
        connection.execute("UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=?", (iso_now(), f"{type(exc).__name__}: {exc}"[:1000], job["id"]))
        raise
    connection.execute("UPDATE jobs SET status='complete',finished_at=?,payload_json=? WHERE id=?", (iso_now(), json_text(result), job["id"]))
    return result


def consume_backfill(connection: sqlite3.Connection) -> dict[str, int] | None:
    with transaction(connection):
        job = connection.execute("SELECT * FROM jobs WHERE kind='backfill' AND status='queued' AND run_after<=? ORDER BY priority DESC,run_after,id LIMIT 1", (iso_now(),)).fetchone()
        if not job:
            return None
        connection.execute("UPDATE jobs SET status='running',attempts=attempts+1,started_at=?,error=NULL WHERE id=?", (iso_now(), job["id"]))
    payload = json.loads(job["payload_json"] or "{}")
    days = min(60, max(1, int(payload.get("days", 60))))
    since = (utc_now() - dt.timedelta(days=days)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    try:
        result = process_due(connection, force=True, source_ids=[job["source_id"]], since=since, notify_new=False)
    except Exception as exc:
        connection.execute("UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=?", (iso_now(), f"{type(exc).__name__}: {exc}"[:1000], job["id"]))
        raise
    connection.execute("UPDATE jobs SET status='complete',finished_at=?,payload_json=? WHERE id=?", (iso_now(), json_text({"days":days,"result":result}), job["id"]))
    return result


def check_sources(connection: sqlite3.Connection, include_candidates: bool = False) -> dict[str,int]:
    # Active run verifies only approved connectors. Candidate probing is explicit and never activates a source.
    if not include_candidates:
        return process_due(connection,force=True)
    sources=connection.execute("SELECT * FROM sources ORDER BY status,id").fetchall()
    fetcher=BoundedFetcher(global_limit=4,per_host_limit=1,timeout=10,max_bytes=600_000)
    result={"sources":len(sources),"readable":0,"failed":0}
    def probe(source):
        try:
            response=fetcher.get(source["url"]); return source,response,None
        except Exception as exc: return source,None,f"{type(exc).__name__}: {exc}"
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for source,response,error in pool.map(probe,sources):
            now=iso_now()
            if error:
                connection.execute("UPDATE sources SET last_attempt_at=?,error=?,updated_at=? WHERE id=?",(now,error[:1000],now,source["id"]));result["failed"]+=1
            else:
                connection.execute("UPDATE sources SET last_attempt_at=?,error=NULL,updated_at=? WHERE id=?",(now,now,source["id"]));result["readable"]+=1
    return result


def run_loop(connection: sqlite3.Connection) -> None:
    from telegram_service import TelegramService
    sources=load_registry()
    known={source['id']:{row[0] for row in connection.execute('SELECT external_id FROM documents WHERE source_id=? ORDER BY published_at DESC LIMIT 1000',(source['id'],))} for source in sources if source.get('adapter')=='telegram'}
    telegram=TelegramService(sources,known);telegram.start();telegram_checks={}
    global STOP
    while not STOP:
        heartbeat(connection,"running","Проверяем новые материалы; историческая очередь выполняется после новых источников.")
        result=consume_manual_refresh(connection) or process_due(connection)
        normalize_due_event_states(connection)
        tg_count=0
        for _ in range(512):
            try: source_id,document,notify=telegram.queue.get_nowait()
            except queue.Empty: break
            source=connection.execute('SELECT * FROM sources WHERE id=?',(source_id,)).fetchone()
            if source and source['fetch_allowed']:
                store_document(connection,source,document,AnyModelAnalyzer(),notify_new=notify,geocode_immediately=True);tg_count+=1
                connection.execute("UPDATE sources SET status='active',last_success_at=?,latest_publication_at=MAX(COALESCE(latest_publication_at,''),?),error=NULL WHERE id=?",(iso_now(),document.published_at or '',source_id));connection.commit()
        for source_id,check in list(telegram.health.items()):
            if telegram_checks.get(source_id)==check['checked_at']:continue
            telegram_checks[source_id]=check['checked_at']
            connection.execute("UPDATE sources SET last_attempt_at=?,last_success_at=CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,error=?,consecutive_failures=CASE WHEN ? IS NULL THEN 0 ELSE consecutive_failures+1 END,updated_at=? WHERE id=?",(check['checked_at'],check['error'],check['checked_at'],check['error'],check['error'],check['checked_at'],source_id))
        connection.commit()
        from geocoding import geocode_fresh_events
        geocode_fresh_events(connection)
        from article_enrichment import enrich_articles
        result={**result,"articles":enrich_articles(connection,limit=4),"analysis":process_analysis_queue(connection),"telegram":{"state":telegram.status,"received":tg_count,"checkedSources":len(telegram.health),"error":telegram.error}}
        backfill = consume_backfill(connection)
        if backfill:
            result = {**result, "backfill": backfill}
        from location_resolution import enqueue_location_sweep
        enqueue_location_sweep(connection)
        geocoding = consume_geocode_jobs(connection)
        if geocoding["processed"] or geocoding["failed"]:
            result = {**result, "geocoding": geocoding}
        heartbeat(connection,"idle",json_text(result),success=bool(result["successful"] or tg_count))
        # Five seconds bounds manual-refresh pickup latency while avoiding busy polling.
        for _ in range(5):
            if STOP: break
            time.sleep(1)

    telegram.stop()

def main(argv: list[str] | None = None) -> int:
    load_local_env()
    parser=argparse.ArgumentParser(description="Sber Atlas local public event worker")
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once",action="store_true");mode.add_argument("--run",action="store_true")
    mode.add_argument("--backfill",type=int,metavar="DAYS");mode.add_argument("--export",action="store_true")
    mode.add_argument("--check-sources",action="store_true")
    mode.add_argument("--enqueue",action="store_true")
    parser.add_argument("--include-candidates",action="store_true")
    parser.add_argument("--db",type=Path,default=Path(os.getenv("ATLAS_LIVE_DB",DEFAULT_DB)))
    parser.add_argument("--output",type=Path,default=DATA_ROOT/"data/live/export")
    args=parser.parse_args(argv)
    if args.backfill is not None and not 1 <= args.backfill <= 60:
        parser.error("--backfill DAYS must be between 1 and 60")
    if args.enqueue:
        # This intentionally does not acquire singleton_lock: the UI may enqueue
        # while the long-running daemon owns it.
        connection=open_database(args.db)
        result=enqueue_manual_refresh(connection)
        print(json.dumps(result,ensure_ascii=False))
        return 0
    with singleton_lock():
        connection=open_database(args.db)
        # Only the singleton owner may reclaim jobs interrupted by shutdown.
        connection.execute("UPDATE jobs SET status='queued',started_at=NULL,attempts=MAX(0,attempts-1) WHERE kind='geocode' AND status='running'")
        sync_registry(connection,load_registry())
        migrated=migrate_legacy(connection)
        heartbeat(connection,"starting",f"Imported {migrated} legacy signals")
        if args.run:
            def stop(*_):
                global STOP; STOP=True
            signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
            run_loop(connection);heartbeat(connection,"stopped","Worker stopped cleanly")
            return 0
        if args.once:
            result=consume_manual_refresh(connection) or process_due(connection)
            from article_enrichment import enrich_articles
            result={**result,"articles":enrich_articles(connection,limit=4),"analysis":process_analysis_queue(connection),"geocoding":consume_geocode_jobs(connection)}
        elif args.backfill is not None: result={"queued":enqueue_backfill(connection,args.backfill)}
        elif args.export: result=export_data(connection,args.output)
        else: result=check_sources(connection,args.include_candidates)
        heartbeat(connection,"idle",json_text(result),success=bool(result.get("successful",result.get("sources",0))))
        print(json.dumps(result,ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
