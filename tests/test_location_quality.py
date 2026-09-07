import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
from article_enrichment import parse_article_body,pending_article,ARTICLE_VERSION
from location_quality import location_text,constrain_precision
from location_resolution import validate_clues
from region_config import locality_forms,matching_district
from source_section_geocoding import source_section
from worker import open_database,sync_registry,store_document
from analysis import AnyModelAnalyzer
from connectors import FeedDocument

class LocationQualityTests(unittest.TestCase):
    def test_void_and_unmatched_tags_do_not_truncate_lists(self):
        html='<div class="single__content"><p>График<br />Улица Первая<br/>Улица Вторая</p><p>Дом 3<img src="a"/>Дом 4</p></oops><p>Дом 5</p></div><footer>Редакция</footer>'
        self.assertEqual(parse_article_body(html.encode()),'График\nУлица Первая\nУлица Вторая\nДом 3Дом 4\nДом 5')

    def test_contact_address_rejected_even_when_quote_omits_phone_prefix(self):
        text='В городе Казани возможно отключение воды.\nПодробности по телефону: 123. Адрес: Казань, ул. Ленина, 10.'
        quote='Адрес: Казань, ул. Ленина, 10.'
        clue={'status':'located','locations':[{'locality':'Казань','address':'ул. Ленина, 10','quote':quote}]}
        self.assertEqual(validate_clues(clue,text)['status'],'no_location')
        self.assertNotIn('Ленина',location_text(text))
        event='В Казани горит приёмная по адресу ул. Ленина, 10.\nПодробности по телефону: 123.'
        self.assertIn('Ленина',location_text(event))

    def test_courtyard_is_not_building_polygon(self):
        building={'status':'matched','precision':'building','geometry':{'type':'Polygon'},'bbox':[1,2,3,4]}
        yard=constrain_precision(building,'Праздник прошёл во дворе на Школьной, 9.')
        self.assertEqual(yard['precision'],'site');self.assertIsNone(yard['geometry'])
        self.assertEqual(constrain_precision(building,'В доме на Школьной, 9 пожар.')['precision'],'building')

    def test_city_cases_and_district_cross_scope_stay_unambiguous(self):
        self.assertIn('нурлате',locality_forms('Нурлат'))
        self.assertEqual(matching_district('Елабужском районе','RU-TA')['id'],'mo-92626000')
        self.assertIsNone(matching_district('Елабужском и Тукаевском районах','RU-TA'))
        self.assertIsNone(matching_district('Елабужский завод','RU-TA'))

    def test_section_boundaries_in_next_sentence(self):
        main={'geometry':{'type':'LineString','coordinates':[[0,0],[.002,0]]}}
        def resolve(name):
            x=.0005 if 'Первой' in name else .0015
            return {'status':'matched','streetId':name,'geometry':{'type':'LineString','coordinates':[[x,-.001],[x,.001]]}}
        text='Ремонт улицы Лесной. Начиная от улицы Первой до улицы Второй.'
        result=source_section(main,'улицы Лесной',text,resolve)
        self.assertEqual(result['status'],'matched');self.assertIn(result['sourceQuote'],text)
        self.assertIsNone(source_section(main,'улицы Лесной','Ремонт улицы Лесной. Другой проект. От улицы Первой до улицы Второй.',resolve))

    def test_old_negative_checkpoint_does_not_mark_feed_complete(self):
        with tempfile.TemporaryDirectory() as folder:
            db=open_database(Path(folder)/'live.sqlite');self.addCleanup(db.close)
            sync_registry(db,[{'id':'one','name':'One','url':'https://example.org/rss','adapter':'rss','source_kind':'official','status':'active','territory_id':'mo-92701000','fetch_allowed':True,'ai_allowed':False,'display_allowed':True,'coverage':[],'provenance_url':'https://example.org'}])
            source=db.execute('select * from sources').fetchone()
            store_document(db,source,FeedDocument('1','https://example.org/news/1','Ремонт водопровода','2026-09-04','На улице Лесной ремонтируют водопровод.'),AnyModelAnalyzer())
            event=db.execute('select id from events').fetchone()[0];doc=db.execute('select * from documents').fetchone()
            self.assertEqual(pending_article(db,event),doc['id'])
            db.execute("INSERT INTO checkpoints VALUES('__articles__',?,?,?)",(doc['id'],json.dumps({'enriched':False,'feedHash':doc['content_hash']}),'2026-09-04'))
            self.assertEqual(pending_article(db,event),doc['id'])
            db.execute('UPDATE checkpoints SET value=? WHERE key=?',(json.dumps({'version':ARTICLE_VERSION,'complete':True,'enrichedHash':doc['content_hash']}),doc['id']))
            self.assertIsNone(pending_article(db,event))

    def test_geocoder_waits_for_full_rss_before_model_or_mapping(self):
        from test_live_geocoding import LiveGeocodingTests
        from geocoding import consume_geocode_jobs
        helper=LiveGeocodingTests()
        with tempfile.TemporaryDirectory() as folder:
            db=helper.db(folder);self.addCleanup(db.close)
            event=helper.store(db,helper.source(db),'ул. Кремлёвская, д. 10')
            with patch('location_resolution.prewarm_location_batch'),patch('location_resolution.resolve_unmatched') as model:
                result=consume_geocode_jobs(db,limit=1)
                model.assert_not_called()
            job=db.execute("select status,error from jobs where kind='geocode'").fetchone()
            self.assertEqual(job['status'],'queued')
            self.assertIn('Full source article pending',job['error'])
            data=json.loads(db.execute('select data_json from events where id=?',(event['id'],)).fetchone()[0])
            self.assertEqual(data['locationSourceQuality']['status'],'awaiting_full_article')

    def test_semantic_article_and_structured_body_fallback(self):
        self.assertEqual(parse_article_body(b'<article><p>Event</p><aside>Ad</aside></article><footer>Office</footer>'),'Event')
        html='<script type="application/ld+json">'+json.dumps({'@type':'NewsArticle','articleBody':'Full source address'})+'</script><footer>Office address</footer>'
        self.assertEqual(parse_article_body(html.encode()),'Full source address')

    def test_unicode_source_urls_are_encoded_without_double_encoding(self):
        from connectors import BoundedFetcher
        class Stop(Exception):pass
        with patch('connectors.urllib.request.urlopen',side_effect=Stop) as request:
            with self.assertRaises(Stop):BoundedFetcher().get('https://example.org/news/яшәеш?q=%D0%B0&name=Казань')
        url=request.call_args.args[0].full_url
        self.assertTrue(url.isascii());self.assertIn('q=%D0%B0&',url);self.assertNotIn('%25D0',url)

    def test_repeated_recovery_keeps_one_pending_job_per_event(self):
        from test_live_geocoding import LiveGeocodingTests
        from geocoding import enqueue_geocode_job,coalesce_geocode_jobs
        helper=LiveGeocodingTests()
        with tempfile.TemporaryDirectory() as folder:
            db=helper.db(folder);self.addCleanup(db.close)
            event=helper.store(db,helper.source(db),'ул. Кремлёвская, д. 10')
            enqueue_geocode_job(db,event['id'],None,[],'another-version')
            self.assertEqual(coalesce_geocode_jobs(db),1)
            self.assertEqual(db.execute("select count(*) from jobs where status='queued'").fetchone()[0],1)
            self.assertEqual(coalesce_geocode_jobs(db),0)
