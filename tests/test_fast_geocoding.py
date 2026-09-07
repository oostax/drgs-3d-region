import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
import test_live_geocoding as fixture
from connectors import parse_vodokanal_incidents
from worker import store_document
from geocoding import geocode_fresh_events

class FastGeocodingTests(unittest.TestCase):
    def test_source_avenue_abbreviation_keeps_house_and_corpus(self):
        from geocoding import normalize_street
        from object_geocoding import split_address
        from analysis import extract_addresses
        self.assertIn('пр-кт ПОБЕДЫ, 15 к1', extract_addresses('Работы: пр-кт ПОБЕДЫ, 15 к1.'))
        self.assertEqual(normalize_street('пр-кт ПОБЕДЫ'), normalize_street('проспект Победы'))
        self.assertEqual(split_address('пр-кт ПОБЕДЫ, 15 к1'), ('победы','avenue','15к1'))

    def test_new_structured_rows_get_geometry_before_provider_and_backlog(self):
        helper=fixture.LiveGeocodingTests()
        with tempfile.TemporaryDirectory() as folder:
            db=helper.db(folder);self.addCleanup(db.close)
            helper.source(db);db.execute("UPDATE sources SET adapter='vodokanal-incidents',source_kind='utility'")
            source=db.execute('SELECT * FROM sources').fetchone()
            for i in range(60):
                db.execute("INSERT INTO jobs(id,kind,status,priority,run_after,payload_json) VALUES(?,'geocode','queued',20,'2020-01-01',?)",(f'old-{i}',json.dumps({'eventId':f'missing-{i}'})))
            idx=json.loads(helper.index(folder).read_text());idx['streets']=idx['streets'][:1]
            body='<table><tr><td>Кировский, КРЕМЛЁВСКАЯ, 10, начало работ - 07.09.2026</td></tr><tr><td>Кировский, Кремлёвская, 11, начало работ - 07.09.2026</td></tr></table>'
            with patch('geocoding.load_street_index',return_value=idx),patch('object_geocoding.match_objects',return_value={'status':'unmatched'}),patch('langsearch_location._request',side_effect=AssertionError('Local pass must never call provider')):
                for doc in parse_vodokanal_incidents(body.encode(),source['url']):
                    store_document(db,source,doc,fixture.AddressAnalyzer(''),geocode_immediately=True)
                    event=db.execute('SELECT * FROM events ORDER BY rowid DESC LIMIT 1').fetchone()
                    self.assertEqual(event['precision'],'street', [dict(j) for j in db.execute("select * from jobs where id not like 'old-%'")])
                    self.assertIsNotNone(event['longitude'])
                    self.assertEqual(event['notify_eligible'],1)
                self.assertEqual(geocode_fresh_events(db,document_id='missing')['processed'],0)
            self.assertEqual(db.execute("SELECT count(*) FROM jobs WHERE id LIKE 'old-%' AND status='queued' AND attempts=0").fetchone()[0],60)
            pending=db.execute("SELECT payload_json,priority FROM jobs WHERE id NOT LIKE 'old-%'").fetchall()
            self.assertEqual(len(pending),2)
            self.assertTrue(all(json.loads(j['payload_json']).get('localPassAt') and j['priority']==50 for j in pending))

    def test_full_article_release_does_not_wait_for_old_cooldown(self):
        from article_enrichment import ARTICLE_VERSION
        from geocoding import consume_geocode_jobs
        helper=fixture.LiveGeocodingTests()
        with tempfile.TemporaryDirectory() as folder:
            db=helper.db(folder);self.addCleanup(db.close)
            helper.store(db,helper.source(db),'ул. Кремлёвская, д. 10')
            with patch('location_resolution.prewarm_location_batch'):
                consume_geocode_jobs(db,limit=1,allow_network=False,local_first=True)
            doc=db.execute('SELECT * FROM documents').fetchone()
            db.execute("INSERT INTO checkpoints VALUES('__articles__',?,?,?)",(doc['id'],json.dumps({'version':ARTICLE_VERSION,'complete':True,'enrichedHash':doc['content_hash']}),'2026-09-07'))
            idx=json.loads(helper.index(folder).read_text())
            with patch('geocoding.load_street_index',return_value=idx),patch('object_geocoding.match_objects',return_value={'status':'unmatched'}),patch('langsearch_location._request',side_effect=AssertionError('No network')):
                result=geocode_fresh_events(db,document_id=doc['id'],source_ready=True)
            self.assertEqual(result['matched'],1)
            self.assertEqual(db.execute('SELECT precision FROM events').fetchone()[0],'street')

    def test_house_range_never_reduced_to_first_building(self):
        helper=fixture.LiveGeocodingTests()
        with tempfile.TemporaryDirectory() as folder:
            db=helper.db(folder);self.addCleanup(db.close)
            helper.source(db);db.execute("UPDATE sources SET adapter='vodokanal-incidents',source_kind='utility'")
            source=db.execute('SELECT * FROM sources').fetchone()
            idx=json.loads(helper.index(folder).read_text());idx['streets']=idx['streets'][:1]
            doc=parse_vodokanal_incidents('<table><tr><td>Кировский, КРЕМЛЁВСКАЯ, 10-20, начало работ - 07.09.2026</td></tr></table>'.encode(),source['url'])[0]
            with patch('geocoding.load_street_index',return_value=idx),patch('object_geocoding.match_objects',return_value={'status':'matched','precision':'building'}):
                store_document(db,source,doc,fixture.AddressAnalyzer(''),geocode_immediately=True)
            event=db.execute('SELECT * FROM events').fetchone()
            self.assertEqual(event['precision'],'street')
            self.assertEqual(json.loads(event['data_json'])['locationEvidence']['houseRange'],'10-20')
