import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LIVE = ROOT / "scripts/live"
sys.path.insert(0, str(LIVE))

from connectors import FeedDocument
from geocoding import consume_geocode_jobs, enqueue_geocode_job, match_address_candidates, match_street_objects, normalize_street
from worker import open_database, store_document, sync_registry
from region_config import matching_locality
from langsearch_location import _address_candidates, named_facility


class AddressAnalyzer:
    enabled = True

    def __init__(self, candidate: str):
        self.candidate = candidate

    def analyze(self, document):
        return [{
            "event_key": "street-event", "title": document.title, "summary": document.body,
            "topic": "roads", "state": "reported", "severity": "medium",
            "event_time": document.published_at, "address_candidates": [self.candidate],
            "locality_candidates": ["Казань"], "geometry": None, "geo_precision": "unknown",
            "verification": "source_reported", "animation_eligible": False,
            "evidence": [{"quote": document.title, "start": 0, "end": len(document.title)}],
            "analysis_status": "anymodel",
        }]


class LiveGeocodingTests(unittest.TestCase):
    def test_person_name_does_not_become_remote_settlement(self):
        places=[
            {'id':'person-name','name':'Ильдус','aliases':['Ильдус'],'territoryId':'remote','scopeIds':['remote','region']},
            {'id':'local-town','name':'Лаишево','aliases':['Лаишево'],'territoryId':'town','scopeIds':['town','district','region']},
        ]
        self.assertIsNone(matching_locality('Глава района Ильдус Зарипов открыл объект','district',places))
        self.assertEqual(matching_locality('В селе Ильдус открыли объект','district',places)['id'],'person-name')
        self.assertEqual(matching_locality('В Лаишево открыли объект','district',places)['id'],'local-town')

    def test_named_facility_address_hint_is_source_scoped(self):
        text='В Лаишево открыли полосу препятствий на территории Гимназии №1.'
        self.assertEqual(named_facility(text),'Гимназии №1')
        results=[
            {'name':'Гимназия №1 г. Лаишево','snippet':'улица Маяковского, 16, Лаишево','url':'https://example.test/right'},
            {'name':'Гимназия №1 в Казани','snippet':'улица Маяковского, 16, Казань','url':'https://example.test/wrong'},
        ]
        self.assertEqual(_address_candidates(results,'Гимназия №1','Лаишево'),[
            {'address':'улица Маяковского, 16','url':'https://example.test/right'}])

    def test_embankment_named_street_retains_its_name_and_street_kind(self):
        self.assertEqual(normalize_street('Набережная улица'),('набережная','street'))
        self.assertEqual(normalize_street('улица Набережная'),('набережная','street'))
        self.assertEqual(normalize_street('Кремлёвская набережная'),('кремлевская','embankment'))
        self.assertEqual(normalize_street('Набережная'),('набережная',None))

    def test_source_locality_separates_same_street_names_in_one_municipality(self):
        index={'territoryId':'r','streets':[{'id':p,'name':'Центральная улица','kind':'street','territoryId':'d','scopeIds':['d','r'],
            'localityIds':[p],'coordinates':[49 if p=='a' else 50,55]} for p in ['a','b']]}
        self.assertEqual(match_address_candidates(['Центральная'],'d',index)['status'],'ambiguous')
        self.assertEqual(match_address_candidates(['Центральная'],'d',index,locality_id='a')['streetId'],'a')

    def db(self, directory):
        connection = open_database(Path(directory) / "live.sqlite")
        self.addCleanup(connection.close)
        return connection

    def index(self, directory):
        path = Path(directory) / "kazan-street-index.json"
        path.write_text(json.dumps({
            "schemaVersion": 1, "territoryId": "mo-92701000", "checkedAt": "2026-09-04T12:30:24Z",
            "sourceUrl": "https://www.openstreetmap.org/relation/367666", "sourceKind": "osm-full-ways",
            "streets": [
                {"id": "street-1", "name": "Кремлёвская улица", "kind": "street", "aliases": ["улица Кремлёвская"],
                 "territoryId": "mo-92701000", "coordinates": [49.106, 55.796],
                 "geometry": {"type": "LineString", "coordinates": [[49.105, 55.795], [49.107, 55.797]]},
                 "bbox": [49.105, 55.795, 49.107, 55.797], "sourceUrl": "https://www.openstreetmap.org/way/1",
                 "sourceUrls": ["https://www.openstreetmap.org/way/1"]},
                {"id": "street-2", "name": "Кремлёвская набережная", "kind": "embankment", "aliases": [],
                 "territoryId": "mo-92701000", "coordinates": [49.10, 55.80],
                 "geometry": {"type": "LineString", "coordinates": [[49.09, 55.79], [49.11, 55.81]]},
                 "bbox": [49.09, 55.79, 49.11, 55.81], "sourceUrl": "https://www.openstreetmap.org/way/2",
                 "sourceUrls": ["https://www.openstreetmap.org/way/2"]},
            ], "limitations": [],
        }, ensure_ascii=False))
        return path

    def source(self, connection, territory_id="mo-92701000"):
        sync_registry(connection, [{
            "id": "one", "name": "One", "url": "https://one.test/rss", "adapter": "rss", "source_kind": "official",
            "status": "active", "territory_id": territory_id, "interval_seconds": 300,
            "fetch_allowed": True, "ai_allowed": True, "display_allowed": True,
            "coverage": [], "provenance_url": "https://one.test/about",
        }])
        return connection.execute("SELECT * FROM sources WHERE id='one'").fetchone()

    def store(self, connection, source, candidate, body=None):
        generated_body = body is None
        body = body or f"{candidate}. Начался ремонт дороги сегодня."
        document = FeedDocument("1", "https://one.test/news/1", "Начался ремонт дороги", "2026-09-04T09:00:00Z", body)
        store_document(connection, source, document, AddressAnalyzer(candidate))
        event = connection.execute("SELECT * FROM events").fetchone()
        if generated_body:
            self.assertGreater(connection.execute("SELECT count(*) FROM jobs WHERE kind='geocode'").fetchone()[0], 0)
        # Isolate the candidate under test from the conservative rule parser;
        # production AnyModel uses the same normalized job payload contract.
        data = json.loads(event["data_json"])
        data["addressCandidates"] = [candidate]
        connection.execute("UPDATE events SET data_json=? WHERE id=?", (json.dumps(data, ensure_ascii=False), event["id"]))
        connection.execute("DELETE FROM jobs WHERE kind='geocode'")
        enqueue_geocode_job(connection, event["id"], source["id"], [candidate], "unit-fixture")
        return connection.execute("SELECT * FROM events WHERE id=?", (event["id"],)).fetchone()

    def test_unique_supported_kazan_street_is_queued_and_matched_without_building_precision(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self.db(directory)
            event = self.store(db, self.source(db), "ул. Кремлёвская, д. 10")
            job = db.execute("SELECT * FROM jobs WHERE kind='geocode'").fetchone()
            self.assertEqual(job["status"], "queued")

            result = consume_geocode_jobs(db, index_path=self.index(directory))
            self.assertEqual(result, {"processed": 1, "matched": 1, "ambiguous": 0, "unmatched": 0, "preserved": 0, "failed": 0})
            located = db.execute("SELECT * FROM events WHERE id=?", (event["id"],)).fetchone()
            self.assertEqual((located["precision"], located["location_confidence"]), ("street", "street"))
            self.assertEqual((located["longitude"], located["latitude"]), (49.106, 55.796))
            self.assertEqual(located["address"], "Кремлёвская улица")
            self.assertNotEqual(located["precision"], "building")
            data = json.loads(located["data_json"])
            self.assertEqual(data["coordinateSourceUrl"], "https://www.openstreetmap.org/way/1")
            self.assertEqual(data["addressSourceUrl"], "https://one.test/news/1")
            self.assertEqual(data["locationVerificationMethod"], "exact-normalized-street-name-and-territory")
            self.assertIn("не подтверждённый дом", data["geographyNote"])
            self.assertEqual(data["streetGeometryRef"]["streetId"], "street-1")
            self.assertEqual(db.execute("SELECT notify_eligible FROM revisions ORDER BY revision DESC LIMIT 1").fetchone()[0], 0)

    def test_rule_based_address_candidate_flows_through_worker_job(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self.db(directory)
            source = self.source(db)
            document = FeedDocument("1", "https://one.test/news/1", "Начался ремонт дороги", "2026-09-04T09:00:00Z",
                "Кремлёвская улица, 10. Начался ремонт дороги сегодня.")
            store_document(db, source, document, AddressAnalyzer("ignored"))
            self.assertEqual(db.execute("SELECT status FROM jobs WHERE kind='geocode'").fetchone()[0], "queued")
            result = consume_geocode_jobs(db, index_path=self.index(directory))
            row = db.execute("SELECT precision,address,longitude,latitude FROM events").fetchone()
            self.assertEqual(result["matched"], 1)
            self.assertEqual(tuple(row), ("street", "Кремлёвская улица", 49.106, 55.796))

    def test_ambiguous_street_and_uncovered_territory_keep_territory_location(self):
        with tempfile.TemporaryDirectory() as directory:
            index_path = self.index(directory)
            db = self.db(directory)
            event = self.store(db, self.source(db), "Кремлёвская, д. 10")
            consume_geocode_jobs(db, index_path=index_path)
            row = db.execute("SELECT * FROM events WHERE id=?", (event["id"],)).fetchone()
            self.assertEqual(row["precision"], "territory")
            self.assertIsNone(row["longitude"])
            self.assertEqual(json.loads(row["data_json"])["locationEvidence"]["status"], "ambiguous")

        with tempfile.TemporaryDirectory() as directory:
            db = self.db(directory)
            event = self.store(db, self.source(db, "mo-92612000"), "ул. Кремлёвская, д. 10")
            consume_geocode_jobs(db, index_path=self.index(directory))
            row = db.execute("SELECT * FROM events WHERE id=?", (event["id"],)).fetchone()
            self.assertEqual(row["precision"], "territory")
            self.assertIsNone(row["longitude"])
            self.assertEqual(json.loads(row["data_json"])["locationVerificationMethod"], "territory-not-covered-by-local-street-index")

    def test_no_location_in_source_is_distinguished_from_unsupported_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self.db(directory)
            source = self.source(db)
            event = self.store(db, source, "placeholder", "Публичное объявление без локального адреса.")
            data = json.loads(event["data_json"])
            data["addressCandidates"] = []
            data["localityCandidates"] = []
            db.execute("UPDATE events SET data_json=? WHERE id=?", (json.dumps(data, ensure_ascii=False), event["id"]))
            db.execute("DELETE FROM jobs WHERE kind='geocode'")
            enqueue_geocode_job(db, event["id"], source["id"], [], "unit-no-location")
            consume_geocode_jobs(db, index_path=self.index(directory))
            located = db.execute("SELECT * FROM events WHERE id=?", (event["id"],)).fetchone()
            result = json.loads(located["data_json"])
            self.assertEqual(located["precision"], "territory")
            self.assertEqual(result["locationVerificationMethod"], "no-location-in-source")
            self.assertEqual(result["locationEvidence"]["method"], "no-location-in-source")

    def test_candidate_missing_from_source_text_is_not_geocoded(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self.db(directory)
            event = self.store(db, self.source(db), "ул. Кремлёвская, д. 10", "Ремонт дороги начался сегодня без указания адреса.")
            consume_geocode_jobs(db, index_path=self.index(directory))
            row = db.execute("SELECT * FROM events WHERE id=?", (event["id"],)).fetchone()
            data = json.loads(row["data_json"])
            self.assertEqual(row["precision"], "territory")
            self.assertIsNone(row["longitude"])
            self.assertEqual(data["locationVerificationMethod"], "address-candidate-not-supported-by-source")
            self.assertEqual(data["locationEvidence"]["unsupportedCandidates"], ["ул. Кремлёвская, д. 10"])

    def test_existing_reviewed_building_location_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self.db(directory)
            event = self.store(db, self.source(db), "ул. Кремлёвская, д. 10")
            db.execute("UPDATE events SET longitude=49.1,latitude=55.7,precision='building',location_confidence='building' WHERE id=?", (event["id"],))
            result = consume_geocode_jobs(db, index_path=self.index(directory))
            row = db.execute("SELECT longitude,latitude,precision,location_confidence FROM events WHERE id=?", (event["id"],)).fetchone()
            self.assertEqual(result["preserved"], 1)
            self.assertEqual(tuple(row), (49.1, 55.7, "building", "building"))

    def test_reviewed_decision_to_keep_only_territory_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self.db(directory)
            event = self.store(db, self.source(db), "ул. Кремлёвская, д. 10")
            db.execute("UPDATE events SET reviewed=1 WHERE id=?", (event["id"],))
            result = consume_geocode_jobs(db, index_path=self.index(directory))
            row = db.execute("SELECT longitude,latitude,precision FROM events WHERE id=?", (event["id"],)).fetchone()
            self.assertEqual(result["preserved"], 1)
            self.assertEqual(tuple(row), (None, None, "territory"))

    def test_matcher_requires_exact_kind_when_homonymous_roads_exist(self):
        with tempfile.TemporaryDirectory() as directory:
            index = json.loads(self.index(directory).read_text())
            matched = match_address_candidates(["ул. Кремлёвская, д. 10"], "mo-92701000", index)
            ambiguous = match_address_candidates(["Кремлёвская, д. 10"], "mo-92701000", index)
            self.assertEqual((matched["status"], matched["precision"]), ("matched", "street"))
            self.assertEqual((ambiguous["status"], ambiguous["precision"]), ("ambiguous", "territory"))

    def test_several_source_named_streets_are_a_compound_street_object(self):
        with tempfile.TemporaryDirectory() as directory:
            index = json.loads(self.index(directory).read_text())
            for item, name, coordinates in [
                ('street-3', 'Пушкина улица', [[49.10,55.79],[49.11,55.79]]),
                ('street-4', 'Театральная улица', [[49.12,55.79],[49.13,55.79]]),
            ]:
                index['streets'].append({'id':item,'name':name,'kind':'street','aliases':[],
                    'territoryId':'mo-92701000','coordinates':coordinates[0],
                    'geometry':{'type':'LineString','coordinates':coordinates},
                    'bbox':[coordinates[0][0],coordinates[0][1],coordinates[-1][0],coordinates[-1][1]],
                    'sourceUrl':f'https://www.openstreetmap.org/way/{item}','sourceUrls':[f'https://www.openstreetmap.org/way/{item}']})
            result = match_street_objects(['улице Пушкина','улицу Театральную'], 'mo-92701000', index)
            self.assertEqual((result['status'], result['precision'], result['candidateCount']), ('matched','street',2))
            self.assertEqual([item['streetId'] for item in result['streetObjects']], ['street-3','street-4'])
            self.assertEqual(result['geometry']['type'], 'MultiLineString')
            self.assertIn('не означает место события', result['note'])


if __name__ == "__main__":
    unittest.main()
