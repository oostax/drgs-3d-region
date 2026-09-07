import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
import langsearch_location as search
from region_config import contextual_locality
from junction_geocoding import source_junction
from test_live_geocoding import LiveGeocodingTests
from geocoding import consume_geocode_jobs, enqueue_geocode_job, match_address_candidates
from recover_signal_locations import enqueue_recovery


class LocationRecoveryTests(unittest.TestCase):
    def test_source_facility_must_be_in_the_named_city_not_publisher_scope(self):
        city={'name':'Чистополь'}
        self.assertFalse(search.facility_located_in('В Лисичанске открыли школу №27.','Открытие школы №27',city))
        self.assertTrue(search.facility_located_in('В Чистополе открыли школу №27.','Открытие школы №27',city))

    def test_osm_never_drops_house_corpus(self):
        row={'osm_type':'way','osm_id':1,'lon':'49','lat':'55','category':'building',
             'address':{'city':'Test City','road':'улица Мира','house_number':'2'},'geojson':None}
        with patch('region_config.localities',return_value=[]),patch.object(search,'_request',return_value=[row]):
            self.assertIsNone(search._osm_match('улица Мира, 10 корпус 2','Test City',''))

    def test_city_extract_and_wrong_nearest_village_do_not_hide_city_street(self):
        city={'id':'city','territoryId':'city','name':'Город','placeKind':'city'}
        village={'id':'village','territoryId':'elsewhere','name':'Село','placeKind':'village'}
        street={'id':'street','territoryId':'city','name':'улица Мира','kind':'street','coordinates':[49,55]}
        index={'territoryId':'region','localities':[city,village],'streets':[street]}
        self.assertEqual(match_address_candidates(['улица Мира'],'city',index,locality_id='city')['status'],'matched')
        street['localityIds']=['village']
        self.assertEqual(match_address_candidates(['улица Мира'],'city',index,locality_id='city')['status'],'matched')
        village['territoryId']='city'
        self.assertEqual(match_address_candidates(['улица Мира'],'city',index,locality_id='city')['status'],'unmatched')

    def test_list_heading_overrides_publisher_and_street_person_names(self):
        places=[{'id':'k','name':'Казань','territoryId':'k','scopeIds':['k']},
                {'id':'c','name':'Набережные Челны','territoryId':'c','scopeIds':['c']},
                {'id':'g','name':'Кул Гали','territoryId':'g','scopeIds':['g']}]
        row='улица Кул Гали – улица Яркая,'
        body='В Казани обновили светофоры.\nРаботы провели на перекрестках:\n'+row+'\nВ Набережных Челнах обновили ещё шесть.\nТрубный проезд – Хлебный проезд'
        self.assertEqual(contextual_locality(body,row,'publisher',places)['id'],'k')
        self.assertEqual(contextual_locality(body,'Трубный проезд – Хлебный проезд','publisher',places)['id'],'c')
        repeated='В Казани ремонт.\n'+row+'\nВ Набережных Челнах ремонт.\n'+row
        self.assertIsNone(contextual_locality(repeated,row,'publisher',places))

    def test_facility_requires_number_or_name_not_generic_school_token(self):
        self.assertEqual(search.named_facility('Открыли детский сад «Карлыгач».'),'детский сад «Карлыгач»')
        self.assertIsNone(search.named_facility('Школа №1 и школа №2 открылись.'))
        self.assertFalse(search.facility_matches('Гимназия №12, улица Ленина, 1','Гимназия №1'))
        self.assertFalse(search.facility_matches('Гимназия на улице Ленина, 1','Гимназия №1'))
        self.assertTrue(search.facility_matches('Гимназия №1 города Лаишево','Гимназии №1'))
        self.assertFalse(search.facility_matches('Детский сад «Солнышко»','детский сад «Карлыгач»'))

    def test_budget_is_deferred_and_reset_per_batch(self):
        with patch.dict(os.environ,{'ATLAS_LANGSEARCH_API_KEY':'test','ATLAS_LANGSEARCH_MAX_PER_RUN':'1'}), patch.object(search,'_search',return_value={'code':200,'data':{}}), patch.object(search,'_osm_match',return_value=None):
            search._cache.clear();search.reset_search_budget()
            self.assertIsNone(search.search_verified_object('Школа №1','','Город А',''))
            with self.assertRaises(search.SearchDeferred):
                search.search_verified_object('Школа №2','','Город А','')
            search.reset_search_budget()
            self.assertIsNone(search.search_verified_object('Школа №2','','Город А',''))
        search._cache.clear();search.reset_search_budget()

    def test_key_failover_and_all_limited_remains_retryable(self):
        search._key_cooldowns.clear()
        with patch.dict(os.environ,{'ATLAS_LANGSEARCH_API_KEY':'a','ATLAS_LANGSEARCH_API_KEYS':'b,c'}), patch.object(search,'_request',side_effect=[{'code':429},{'code':200}]) as request:
            self.assertEqual(search._search('q')['code'],200)
            self.assertEqual([c.kwargs['api_key'] for c in request.call_args_list],['a','b'])
        search._key_cooldowns.clear()
        with patch.dict(os.environ,{'ATLAS_LANGSEARCH_API_KEY':'a','ATLAS_LANGSEARCH_API_KEYS':''}), patch.object(search,'_request',return_value={'code':429}):
            with self.assertRaises(search.SearchDeferred):search._search('q')
        search._key_cooldowns.clear()

    def test_intersection_uses_shared_vertex_and_rejects_grade_crossing(self):
        row='улица А – улица Б'
        def street(i,coords):return {'status':'matched','streetId':i,'streetName':i,'geometry':{'type':'LineString','coordinates':coords},'sourceUrls':[i]}
        streets={'улица А':street('a',[[49,55],[49.001,55],[49.002,55]]),
                 'улица Б':street('b',[[49.001,54.999],[49.001,55],[49.001,55.001]])}
        resolved=source_junction(row,'Светофоры на перекрестках:\n'+row,streets.get)
        self.assertEqual(resolved['representativeCoordinate'],[49.001,55])
        self.assertEqual(resolved['precision'],'site')
        streets['улица Б']['geometry']['coordinates']=[[49.001,54.999],[49.001,55.001]]
        self.assertIsNone(source_junction(row,'Светофоры:\n'+row,streets.get))


class RecoveryDatabaseTests(LiveGeocodingTests):
    def test_deferred_job_is_not_completed_or_counted_as_failed_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory);event=self.store(db,self.source(db),'ул. Кремлёвская, д. 10')
            with patch('geocoding.match_address_candidates',side_effect=search.SearchDeferred('quota')):
                result=consume_geocode_jobs(db,index_path=self.index(directory))
            job=db.execute("SELECT status,attempts,error FROM jobs WHERE kind='geocode'").fetchone()
            self.assertEqual(tuple(job),('queued',0,'quota'))
            self.assertEqual(result['failed'],0)

    def test_object_not_erased_by_unmatched_reprocessing(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory);event=self.store(db,self.source(db),'ул. Кремлёвская, д. 10')
            data=json.loads(event['data_json']);data['locationVerificationMethod']='langsearch-address-osm-verified-object'
            db.execute("UPDATE events SET precision='building',address='Дом 10',longitude=49.1,latitude=55.7,data_json=? WHERE id=?",(json.dumps(data),event['id']))
            result=consume_geocode_jobs(db,index_path=self.index(directory))
            self.assertEqual(result['preserved'],1)
            self.assertEqual(tuple(db.execute('SELECT address,precision,longitude FROM events').fetchone()),('Дом 10','building',49.1))

    def test_recovery_is_idempotent_and_keeps_event_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            db=self.db(directory);event=self.store(db,self.source(db),'ул. Кремлёвская, д. 10')
            self.assertEqual(enqueue_recovery(db),1)
            self.assertEqual(enqueue_recovery(db),0)
            self.assertEqual(db.execute('SELECT id FROM events').fetchone()[0],event['id'])

if __name__=='__main__':unittest.main()

class SourceLocationRegressionTests(unittest.TestCase):
    def test_house_before_street_and_complex_number_are_extracted(self):
        from analysis import extract_addresses
        self.assertEqual(extract_addresses('Пожар в доме № 11 на проспекте Абсалямова.'), ['проспекте Абсалямова, 11'])
        self.assertEqual(extract_addresses('Пожар в доме 65/18.'), ['дом 65/18'])
        self.assertEqual(extract_addresses('Площадь пожара 65/18 метров.'), [])

    def test_inflected_two_word_village(self):
        from region_config import matching_locality
        village={'id':'v','name':'Большая Шильна','territoryId':'v','scopeIds':['v','district']}
        self.assertEqual(matching_locality('В Большой Шильне остановили ремонт','district',[village]),village)

    def test_other_city_exact_name_does_not_block_local_short_name(self):
        index={'territoryId':'region','streets':[
            {'id':'other','name':'проспект Абсалямова','kind':'avenue','territoryId':'other','coordinates':[49,55]},
            {'id':'local','name':'проспект Абдурахмана Абсалямова','kind':'avenue','territoryId':'city','coordinates':[52,55]}]}
        result=match_address_candidates(['проспекте Абсалямова'],'city',index)
        self.assertEqual(result['streetId'],'local')

    def test_recovery_extracts_address_omitted_by_analyzer(self):
        helper=LiveGeocodingTests()
        with tempfile.TemporaryDirectory() as directory:
            db=helper.db(directory)
            try:
                event=helper.store(db,helper.source(db),'ул. Кремлёвская, д. 10')
                db.execute("UPDATE jobs SET payload_json=json_set(payload_json,'$.addressCandidates',json('[]'))")
                result=consume_geocode_jobs(db,index_path=helper.index(directory))
                self.assertEqual(result['matched'],1)
                located=db.execute('SELECT precision,data_json FROM events').fetchone()
                self.assertEqual(located['precision'],'street')
                self.assertTrue(json.loads(located['data_json'])['addressCandidates'])
            finally:db.close()
