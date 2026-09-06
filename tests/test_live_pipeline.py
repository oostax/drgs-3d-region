import json
import sqlite3
import sys
import tempfile
import urllib.error
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIVE = ROOT / "scripts/live"
sys.path.insert(0, str(LIVE))

from analysis import AnyModelAnalyzer, analysis_source_text, event_date_candidates, infer_state, is_relevant, normalize_signal_title, summarize_signal_text, validate_events
from connectors import FeedDocument, parse_feed, parse_vodokanal_incidents
from worker import enqueue_manual_refresh, load_local_env, load_registry, migrate_legacy, open_database, process_analysis_queue, store_document, sync_registry


class StubAnalyzer:
    enabled = False


class QueueAnalyzer:
    enabled = True

    def __init__(self, *, fail=False, invalid=False):
        self.fail = fail
        self.invalid = invalid
        self.calls = []

    def analyze(self, document):
        self.calls.append(document)
        if self.fail:
            raise RuntimeError("temporary model outage")
        source_text = analysis_source_text(document)
        quote = document.title
        return [{
            "title": "Подтверждено перекрытие участка",
            "summary": "Движение ограничено по сообщению источника",
            "topic": "roads",
            "state": "reported",
            "severity": "medium",
            "event_time": document.published_at,
            "status_observed_at": document.published_at,
            "address_candidates": [],
            "locality_candidates": [],
            "verification": "source_reported",
            "animation_eligible": False,
            "evidence": [{"quote": quote, "start": 0, "end": len(quote)}],
            "coordinates": [49.1, 55.7] if self.invalid else None,
            "client_profitability": "must never be persisted",
        }]


class ProviderUnavailableAnalyzer:
    enabled = True

    def analyze(self, document):
        raise urllib.error.HTTPError(document.url, 503, "unavailable", {}, None)


class LivePipelineTests(unittest.TestCase):
    def db(self, directory):
        connection=open_database(Path(directory) / "live.sqlite")
        self.addCleanup(connection.close)
        return connection

    def test_rss_rejects_dtd_external_links_and_missing_dates(self):
        with self.assertRaises(ValueError):
            parse_feed(b'<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', "https://example.test/rss")
        xml = b'''<rss><channel>
          <item><guid>1</guid><title>Accepted</title><link>https://example.test/news/1</link><pubDate>Fri, 04 Sep 2026 09:00:00 +0300</pubDate><description>Fact</description></item>
          <item><guid>2</guid><title>External</title><link>https://other.test/news/2</link><pubDate>Fri, 04 Sep 2026 09:00:00 +0300</pubDate></item>
          <item><guid>3</guid><title>Undated</title><link>https://example.test/news/3</link></item>
        </channel></rss>'''
        result = parse_feed(xml, "https://example.test/rss")
        self.assertEqual([item.external_id for item in result], ["1"])
        self.assertEqual(result[0].published_at, "2026-09-04T06:00:00Z")

    def test_rule_summary_keeps_only_compact_source_sentences(self):
        title = "В Казани начался ремонт улицы"
        body = (title + ". Служебная вводная без фактов. На улице Пушкина начались работы по замене покрытия. "
                "Ограничение движения действует до 12 сентября. " + "Общий справочный текст. " * 80)
        summary = summarize_signal_text(title, body)
        self.assertLessEqual(len(summary), 521)
        self.assertNotIn(title + ".", summary)
        self.assertIn("улице Пушкина", summary)
        self.assertIn("12 сентября", summary)

    def test_headline_keeps_the_concrete_source_fact_and_deadline_means_in_progress(self):
        source_title="У озера на бульваре «Ярдэм» по ул.Серова высадят 4 тысячи растений 🌿"
        body="Здесь появятся 170 деревьев. Работы планируют завершить к концу августа."
        self.assertEqual(normalize_signal_title("Работы планируют завершить к концу августа.", source_title, body, "construction"), "У озера на бульваре «Ярдэм» по ул.Серова высадят 4 тысячи растений")
        self.assertEqual(infer_state(body, "construction"), "in_progress")

    def test_vodokanal_rows_are_dated_and_never_geocoded(self):
        source = "https://water.test/accident"
        body = '<table><tr><td>Приволжский, КРЫМСКАЯ (П.КУЮКИ), 2, начало работ - 04.09.2026</td></tr></table>'.encode()
        result = parse_vodokanal_incidents(body, source)
        self.assertEqual(len(result), 1)
        self.assertIn("КРЫМСКАЯ", result[0].title)
        self.assertEqual(result[0].published_at, "2026-09-04")
        self.assertFalse(hasattr(result[0], "coordinates"))

    def test_irrelevant_material_is_stopped_before_ai_and_creates_no_event(self):
        lifestyle=FeedDocument("l","https://one.test/l","Миколог рассказал про осенние грибы","2026-09-04T09:00:00Z","Советы любителям леса")
        repair=FeedDocument("r","https://one.test/r","Начался ремонт дороги","2026-09-04T09:00:00Z","Движение ограничено")
        self.assertFalse(is_relevant(lifestyle,{"adapter":"rss"}))
        self.assertTrue(is_relevant(repair,{"adapter":"rss"}))
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"media","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":True,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            result=store_document(db,source,lifestyle,StubAnalyzer())
            self.assertEqual(result["events"],0)
            self.assertEqual(db.execute("SELECT analysis_status FROM documents").fetchone()[0],"irrelevant")

    def test_context_document_is_retained_but_hidden_until_enriched(self):
        document=FeedDocument("context","https://one.test/context","В Татарстане построят новые школы","2026-09-04T09:00:00Z","В республике обсудили планы строительства образовательных учреждений без перечня объектов и сроков.")
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"media","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":False,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            result=store_document(db,source,document,StubAnalyzer())
            self.assertEqual(result["documents"],1)
            self.assertEqual(result["events"],1)
            event=json.loads(db.execute("SELECT data_json FROM events").fetchone()[0])
            self.assertFalse(event["signalUsefulness"]["showOnMap"])
            self.assertEqual(db.execute("SELECT analysis_status FROM documents").fetchone()[0],"rule_based")

    def test_database_wal_registry_and_rights_are_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self.db(directory)
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            sources = [{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"official",
                "status":"active","interval_seconds":300,"fetch_allowed":True,"ai_allowed":False,"display_allowed":True,
                "provenance_url":"https://directory.test","coverage":[{"territory_id":"RU-TA","coverage_level":"direct"}]}]
            sync_registry(db, sources)
            row = db.execute("SELECT * FROM sources WHERE id='one'").fetchone()
            self.assertEqual((row["fetch_allowed"],row["ai_allowed"],row["display_allowed"]),(1,0,1))
            self.assertEqual(db.execute("SELECT coverage_level FROM source_coverage").fetchone()[0], "direct")

    def test_existing_v1_database_gets_queue_and_revision_columns_with_safe_defaults(self):
        import sqlite3
        from worker import SCHEMA
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"v1.sqlite"
            old_schema=(SCHEMA.read_text()
                .replace(",analysis_attempts INTEGER NOT NULL DEFAULT 0,\n  analysis_next_attempt_at TEXT","")
                .replace(",reviewed INTEGER NOT NULL DEFAULT 0","")
                .replace("  notify_eligible INTEGER NOT NULL DEFAULT 0,","")
                .replace(",notify_eligible INTEGER NOT NULL DEFAULT 0",""))
            connection=sqlite3.connect(path);connection.executescript(old_schema);connection.close()
            upgraded=open_database(path)
            columns={row["name"] for row in upgraded.execute("PRAGMA table_info(events)")}
            self.assertIn("notify_eligible",columns)
            self.assertIn("reviewed",columns)
            self.assertIn("notify_eligible",{row["name"] for row in upgraded.execute("PRAGMA table_info(revisions)")})
            document_columns={row["name"] for row in upgraded.execute("PRAGMA table_info(documents)")}
            self.assertTrue({"analysis_attempts","analysis_next_attempt_at"} <= document_columns)
            self.assertEqual(upgraded.execute("SELECT value FROM schema_meta WHERE key='schema_version'").fetchone()[0],"4")
            upgraded.close()

    def test_document_edits_version_and_duplicate_without_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self.db(directory)
            sync_registry(db, [{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"media","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":False,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source = db.execute("SELECT * FROM sources").fetchone()
            first = FeedDocument("1","https://one.test/news/1","На улице отключили воду","2026-09-04T09:00:00Z","Начало работ 04.09.2026")
            self.assertEqual(store_document(db,source,first,StubAnalyzer())["documents"],1)
            self.assertEqual(store_document(db,source,first,StubAnalyzer())["documents"],0)
            edited = FeedDocument("1","https://one.test/news/1","На улице отключили воду","2026-09-04T09:00:00Z","Работы завершены 04.09.2026")
            store_document(db,source,edited,StubAnalyzer())
            self.assertEqual(db.execute("SELECT count(*) FROM document_versions").fetchone()[0],2)
            stages=db.execute("SELECT * FROM event_history ORDER BY id").fetchall()
            self.assertEqual(len(stages),2)
            self.assertTrue(all(row["source_published_at"]==first.published_at for row in stages))
            self.assertTrue(all(json.loads(row["data_json"])["sourceUrl"]==first.url for row in stages))
            event = db.execute("SELECT * FROM events").fetchone()
            self.assertIsNone(event["longitude"])
            self.assertIsNone(event["latitude"])
            self.assertEqual(event["precision"],"territory")
            payload=json.loads(event["data_json"])
            self.assertEqual(payload["sourceUrl"],"https://one.test/news/1")
            self.assertEqual(payload["sourceName"],"One")
            self.assertTrue(payload["facts"])
            self.assertGreaterEqual(db.execute("SELECT count(*) FROM revisions").fetchone()[0],2)
            self.assertEqual(db.execute("SELECT notify_eligible FROM events").fetchone()[0],0)

    def test_telegram_style_delete_is_tombstone_not_resolution_or_notification(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"channel","name":"Consented channel","url":"https://t.me/channel","adapter":"telegram","source_kind":"community","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":True,"display_allowed":True,"coverage":[],"provenance_url":"https://t.me/channel"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            original=FeedDocument("10","https://t.me/channel/10","На улице пожар","2026-09-04T09:00:00Z","Пожар локализован")
            store_document(db,source,original,StubAnalyzer())
            deleted=FeedDocument("10","https://t.me/channel/10","Сообщение Telegram",None,"",deleted=True)
            stored=store_document(db,source,deleted,StubAnalyzer())
            self.assertEqual(stored["documents"],1)
            self.assertEqual(db.execute("SELECT status FROM documents").fetchone()[0],"deleted")
            event=db.execute("SELECT state,deleted,notify_eligible FROM events").fetchone()
            self.assertEqual(event["deleted"],0)
            self.assertEqual(event["notify_eligible"],0)
            self.assertNotEqual(event["state"],"resolved")
            self.assertEqual(db.execute("SELECT count(*) FROM event_evidence WHERE supports='dispute'").fetchone()[0],1)
            store_document(db,source,original,StubAnalyzer())
            self.assertEqual(db.execute("SELECT status FROM documents").fetchone()[0],"active")
            self.assertIsNone(db.execute("SELECT deleted_at FROM documents").fetchone()[0])

    def test_backfill_style_store_never_notifies_and_manual_queue_deduplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"media","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":False,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            old=FeedDocument("old","https://one.test/old","Старое сообщение о пожаре","2026-08-01T09:00:00Z","Пожар был локализован")
            store_document(db,source,old,StubAnalyzer(),notify_new=False)
            self.assertEqual(db.execute("SELECT notify_eligible FROM events").fetchone()[0],0)
            first=enqueue_manual_refresh(db);second=enqueue_manual_refresh(db)
            self.assertEqual(first["jobId"],second["jobId"])
            self.assertFalse(first["deduplicated"]);self.assertTrue(second["deduplicated"])

    def test_dedup_respects_territory_reprints_do_not_refresh_activity_and_revision_owns_notification(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            base={"adapter":"rss","source_kind":"media","status":"active","interval_seconds":300,"fetch_allowed":True,
                "ai_allowed":False,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}
            sync_registry(db,[
                dict(base,id="one",name="One",url="https://one.test/rss",territory_id="t1"),
                dict(base,id="two",name="Two",url="https://two.test/rss",territory_id="t1"),
                dict(base,id="three",name="Three",url="https://three.test/rss",territory_id="t2"),
            ])
            article=lambda host: FeedDocument("1",f"https://{host}.test/1","Начался ремонт дороги","2026-09-04T09:00:00Z","Движение ограничено")
            one=db.execute("SELECT * FROM sources WHERE id='one'").fetchone()
            store_document(db,one,article("one"),StubAnalyzer(),notify_new=True)
            first=db.execute("SELECT id FROM events").fetchone()[0]
            db.execute("UPDATE events SET last_meaningful_at='2026-09-04T09:00:00Z' WHERE id=?",(first,))
            two=db.execute("SELECT * FROM sources WHERE id='two'").fetchone()
            store_document(db,two,article("two"),StubAnalyzer(),notify_new=True)
            self.assertEqual(db.execute("SELECT count(*) FROM events").fetchone()[0],1)
            self.assertEqual(db.execute("SELECT last_meaningful_at FROM events").fetchone()[0],"2026-09-04T09:00:00Z")
            self.assertEqual([row[0] for row in db.execute("SELECT notify_eligible FROM revisions ORDER BY revision")],[1,0])
            self.assertEqual(db.execute("SELECT notify_eligible FROM events").fetchone()[0],0)
            three=db.execute("SELECT * FROM sources WHERE id='three'").fetchone()
            store_document(db,three,article("three"),StubAnalyzer(),notify_new=True)
            self.assertEqual(db.execute("SELECT count(*) FROM events").fetchone()[0],2)

    def test_ai_schema_rejects_fabricated_geometry_and_bad_evidence(self):
        document=FeedDocument("1","https://one.test/1","Пожар локализован","2026-09-04T09:00:00Z","Дом цел")
        source_text="Пожар локализован\nДом цел"
        base={"title":"Пожар","summary":"","topic":"fire","state":"resolved","severity":"high","event_time":None,
            "address_candidates":[],"locality_candidates":[],"verification":"source_reported","animation_eligible":False,
            "evidence":[{"quote":"Пожар локализован","start":0,"end":len("Пожар локализован")}]}
        self.assertEqual(validate_events([base],source_text,document)[0]["geometry"],None)
        bad=dict(base,coordinates=[49.1,55.7])
        with self.assertRaises(ValueError): validate_events([bad],source_text,document)
        bad=dict(base,evidence=[{"quote":"invented","start":0,"end":8}])
        with self.assertRaises(ValueError): validate_events([bad],source_text,document)
        shifted=dict(base,evidence=[{"quote":"Дом цел","start":0,"end":7}],event_time="6 сентября")
        repaired=validate_events([shifted],source_text,document)[0]
        self.assertEqual(repaired["evidence"],[{"quote":"Дом цел","start":18,"end":25}])
        self.assertIsNone(repaired["event_time"])
        fabricated=dict(base,address_candidates=["улица Выдуманная, 7"],locality_candidates=["Казань"]*7)
        grounded=validate_events([fabricated],source_text,document)[0]
        self.assertEqual(grounded["address_candidates"],[])
        self.assertEqual(grounded["locality_candidates"],[])

    def test_event_date_must_be_grounded_in_source_text(self):
        document=FeedDocument("1","https://one.test/1","Ремонт завершат 12 сентября","2026-09-04T09:00:00Z","Работы начались вчера.")
        source_text=analysis_source_text(document)
        self.assertEqual(event_date_candidates(source_text,document.published_at),["2026-09-12","2026-09-03"])
        base={"title":"Ремонт","summary":"Работы идут","topic":"roads","state":"in_progress","severity":"medium",
            "status_observed_at":document.published_at,"address_candidates":[],"locality_candidates":[],"verification":"source_reported",
            "animation_eligible":False,"evidence":[{"quote":document.title,"start":0,"end":len(document.title)}]}
        self.assertEqual(validate_events([dict(base,event_time="2026-09-12")],source_text,document)[0]["event_time"],"2026-09-12")
        self.assertIsNone(validate_events([dict(base,event_time="2026-10-01")],source_text,document)[0]["event_time"])

    def test_anymodel_request_has_cloudflare_safe_user_agent(self):
        analyzer=AnyModelAnalyzer()
        analyzer.base_url="https://anymodel.test/v1";analyzer.api_key="secret";analyzer.model="model"
        document=FeedDocument("1","https://one.test/1","Тест","2026-09-04T09:00:00Z","Текст")

        class Response:
            def __enter__(self): return self
            def __exit__(self,*args): return False
            def read(self,*args): return b'{"choices":[{"message":{"content":"{\\"events\\":[]}"}}]}'

        with patch("analysis.urllib.request.urlopen",return_value=Response()) as urlopen:
            self.assertEqual(analyzer.analyze(document),[])
        request=urlopen.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"),"SberAtlas/1.0")

    def test_provider_503_keeps_document_queued_without_spending_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"media","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":True,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            document=FeedDocument("1","https://one.test/1","Яма на дороге","2026-09-04T09:00:00Z","Движение ограничено")
            store_document(db,source,document,StubAnalyzer())
            db.execute("UPDATE documents SET analysis_status='rule_based_queued'")
            result=process_analysis_queue(db,ProviderUnavailableAnalyzer(),batch_size=1)
            row=db.execute("SELECT analysis_status,analysis_attempts,analysis_error FROM documents").fetchone()
            self.assertEqual((result["providerUnavailable"],result["failed"]),(1,1))
            self.assertEqual((row["analysis_status"],row["analysis_attempts"]),("rule_based_queued",0))
            self.assertIn("Provider HTTP 503",row["analysis_error"])

    def test_model_queue_never_processes_a_source_without_ai_permission(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"media","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":False,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            document=FeedDocument("1","https://one.test/1","Татарстанда юл ремонтлана","2026-09-04T09:00:00Z","Әлеге юлда эшләр дәвам итә")
            store_document(db,source,document,StubAnalyzer())
            db.execute("UPDATE documents SET analysis_status='rule_based_queued'")
            analyzer=QueueAnalyzer()
            result=process_analysis_queue(db,analyzer,batch_size=1)
            self.assertEqual(result["selected"],0)
            self.assertEqual(analyzer.calls,[])

    def test_analysis_queue_is_newest_first_bounded_and_replaces_only_automatic_event(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"media","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":True,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            older=FeedDocument("old","https://one.test/old","Старое сообщение: яма на дороге","2026-09-03T09:00:00Z","Движение ограничено")
            newer=FeedDocument("new","https://one.test/new","Новое сообщение: яма на дороге","2026-09-04T09:00:00Z","Движение ограничено")
            store_document(db,source,older,StubAnalyzer());store_document(db,source,newer,StubAnalyzer())
            db.execute("UPDATE documents SET analysis_status='rule_based_queued'")
            old_rule_event=db.execute("SELECT e.id FROM events e JOIN event_documents ed ON ed.event_id=e.id JOIN documents d ON d.id=ed.document_id WHERE d.external_id='new'").fetchone()[0]
            analyzer=QueueAnalyzer()
            result=process_analysis_queue(db,analyzer,batch_size=1)
            self.assertEqual((result["selected"],result["completed"]),(1,1))
            self.assertEqual(analyzer.calls[0].external_id,"new")
            statuses=dict(db.execute("SELECT external_id,analysis_status FROM documents"))
            self.assertEqual(statuses,{"old":"rule_based_queued","new":"complete"})
            self.assertEqual(db.execute("SELECT deleted FROM events WHERE id=?",(old_rule_event,)).fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM revisions WHERE event_id=? AND operation='delete'",(old_rule_event,)).fetchone()[0],1)
            current=db.execute("SELECT data_json FROM events WHERE deleted=0 AND id<>?",(old_rule_event,)).fetchone()[0]
            self.assertNotIn("client_profitability",json.loads(current))

    def test_analysis_queue_preserves_reviewed_event_and_uses_only_document_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"official","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":True,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            document=FeedDocument("1","https://one.test/1","На дороге появилась яма","2026-09-04T09:00:00Z","Движение ограничено")
            store_document(db,source,document,StubAnalyzer())
            reviewed=db.execute("SELECT id,title FROM events").fetchone()
            db.execute("UPDATE events SET reviewed=1,longitude=49.1,latitude=55.7,precision='building' WHERE id=?",(reviewed["id"],))
            db.execute("UPDATE documents SET analysis_status='rule_based_queued'")
            analyzer=QueueAnalyzer();process_analysis_queue(db,analyzer,batch_size=1)
            retained=db.execute("SELECT title,deleted,longitude,latitude,precision,reviewed FROM events WHERE id=?",(reviewed["id"],)).fetchone()
            self.assertEqual(tuple(retained),(reviewed["title"],0,49.1,55.7,"building",1))
            self.assertEqual(set(vars(analyzer.calls[0])),{"external_id","url","title","published_at","body","author","category","source_updated_at","deleted"})
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE deleted=0").fetchone()[0],2)

    def test_analysis_queue_validates_schema_and_bounds_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"media","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":True,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            document=FeedDocument("1","https://one.test/1","На дороге появилась яма","2026-09-04T09:00:00Z","Движение ограничено")
            store_document(db,source,document,StubAnalyzer())
            db.execute("UPDATE documents SET analysis_status='rule_based_queued'")
            invalid=QueueAnalyzer(invalid=True)
            first=process_analysis_queue(db,invalid,batch_size=1)
            self.assertEqual((first["failed"],first["retrying"]),(1,1))
            row=db.execute("SELECT analysis_status,analysis_attempts,analysis_error FROM documents").fetchone()
            self.assertEqual((row["analysis_status"],row["analysis_attempts"]),("rule_based_queued",1))
            self.assertIn("geometry",row["analysis_error"])
            failing=QueueAnalyzer(fail=True)
            for expected_attempt in (2,3):
                db.execute("UPDATE documents SET analysis_next_attempt_at=NULL")
                process_analysis_queue(db,failing,batch_size=1)
                self.assertEqual(db.execute("SELECT analysis_attempts FROM documents").fetchone()[0],expected_attempt)
            terminal=db.execute("SELECT analysis_status,analysis_error FROM documents").fetchone()
            self.assertEqual(terminal["analysis_status"],"failed")
            self.assertIn("temporary model outage",terminal["analysis_error"])
            self.assertEqual(process_analysis_queue(db,failing,batch_size=1)["selected"],0)

    def test_legacy_migration_retains_id_and_reviewed_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory); path=Path(directory)/"signals.json"
            path.write_text(json.dumps([{"id":"manual-1","title":"Reviewed","summary":"Fact","category":"roads","territoryId":"mo-1",
                "coordinates":[49.1,55.7],"precision":"building","publishedAt":"2026-09-01","checkedAt":"2026-09-02",
                "sourceUrl":"https://official.test/1","facts":["Fact"],"lifecycle":{"status":"under_construction","asOf":"2026-09-02",
                "currentStatusVerified":True,"animationEligible":True}}]))
            self.assertEqual(migrate_legacy(db,path),1)
            event=db.execute("SELECT * FROM events WHERE legacy_id='manual-1'").fetchone()
            self.assertEqual((event["longitude"],event["latitude"],event["precision"]),(49.1,55.7,"building"))
            self.assertEqual(db.execute("SELECT event_id FROM event_aliases WHERE alias='manual-1'").fetchone()[0],event["id"])
            self.assertEqual(migrate_legacy(db,path),0)
            self.assertEqual(event["notify_eligible"],0)

    def test_database_values_follow_live_types_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory)
            sync_registry(db,[{"id":"one","name":"One","url":"https://one.test/rss","adapter":"rss","source_kind":"media","status":"active",
                "interval_seconds":300,"fetch_allowed":True,"ai_allowed":False,"display_allowed":True,"coverage":[],"provenance_url":"https://directory.test"}])
            source=db.execute("SELECT * FROM sources").fetchone()
            store_document(db,source,FeedDocument("1","https://one.test/1","На улице пожар","2026-09-04T09:00:00Z","Пожар локализован"),StubAnalyzer())
            event=db.execute("SELECT * FROM events").fetchone()
            self.assertIn(event["severity"],{"low","medium","high","critical"})
            self.assertIn(event["confidence"],{"low","medium","high"})
            self.assertIn(event["location_confidence"],{"territory","settlement","street","building","site","unknown"})
            self.assertIn(event["activity_kind"],{"road_defect","road_repair","construction","utility_fault","utility_repair","waste","cleanup","flood","snow_ice","emergency","fire","place_event","generic"})
            for evidence in db.execute("SELECT supports FROM event_evidence"):
                self.assertIn(evidence["supports"],{"report","status","location","resolution","dispute"})

    def test_checked_registry_and_coverage_outputs(self):
        registry=load_registry()
        self.assertGreaterEqual(len(registry),110)
        self.assertTrue(any(source.get("adapter")=="telegram" for source in registry))
        self.assertEqual(len({source["id"] for source in registry}),len(registry))
        for source in registry:
            self.assertFalse(source.get("ai_allowed") and not source.get("fetch_allowed"))
        with (ROOT/"data/live/source-coverage.csv").open(encoding="utf-8-sig") as handle:
            coverage=list(__import__("csv").DictReader(handle))
        territories=json.loads((ROOT/"public/data/territories.json").read_text())
        expected={row["id"] for row in territories if row["kind"] in {"district","urban_district","settlement"}}
        self.assertEqual({row["territory_id"] for row in coverage},expected)
        rendered=json.loads((ROOT/"data/live/coverage.json").read_text())
        self.assertEqual(len(rendered),956)
        self.assertEqual({row["level"] for row in rendered},{"direct","inherited_district"})
        self.assertTrue(all(set(row)=={"territoryId","territoryName","parentId","level","sourceIds","lastSuccessAt","latestPublicationAt"} for row in rendered))

    def test_launch_agent_installer_has_system_python_fallback_and_does_not_activate(self):
        text=(ROOT/"scripts/live/install_launch_agent.sh").read_text()
        self.assertIn("command -v python3",text)
        self.assertNotIn("launchctl bootstrap\n",text)

    def test_local_env_is_literal_atlas_only_and_exported_value_wins(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/".env.local"
            path.write_text("ATLAS_ANYMODEL_MODEL=file-model\nOTHER_SECRET=ignored\nATLAS_LITERAL=$(touch /tmp/nope)\n")
            old_model=os.environ.get("ATLAS_ANYMODEL_MODEL");old_literal=os.environ.pop("ATLAS_LITERAL",None)
            os.environ["ATLAS_ANYMODEL_MODEL"]="exported-model"
            try:
                self.assertEqual(load_local_env(path),1)
                self.assertEqual(os.environ["ATLAS_ANYMODEL_MODEL"],"exported-model")
                self.assertEqual(os.environ["ATLAS_LITERAL"],"$(touch /tmp/nope)")
                self.assertNotIn("OTHER_SECRET",os.environ)
            finally:
                if old_model is None: os.environ.pop("ATLAS_ANYMODEL_MODEL",None)
                else: os.environ["ATLAS_ANYMODEL_MODEL"]=old_model
                if old_literal is None: os.environ.pop("ATLAS_LITERAL",None)
                else: os.environ["ATLAS_LITERAL"]=old_literal


if __name__ == "__main__":
    unittest.main()
