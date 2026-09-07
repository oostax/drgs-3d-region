import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
from location_resolution import validate_clues,enqueue_location_sweep,resolve_unmatched
from test_live_geocoding import LiveGeocodingTests

class AdaptiveLocationTests(unittest.TestCase):
    def test_hallucinated_address_and_locality_are_rejected(self):
        text='В Казани открыли парк «Дубрава».'
        good={'status':'located','locations':[{'locality':'Казани','object':'парк «Дубрава»','address':'','quote':text}]}
        self.assertEqual(validate_clues(good,text)['locations'][0]['object'],'парк «Дубрава»')
        for field,value in [('address','улица Ленина, 1'),('locality','Челны'),('quote','В Казани открыли другой парк.')]:
            bad=json.loads(json.dumps(good));bad['locations'][0][field]=value
            with self.assertRaises(ValueError):validate_clues(bad,text)

    def test_multiple_places_never_reduced_to_one_location(self):
        text='В Казани открыли парк. В Челнах закрыли парк.'
        result=validate_clues({'status':'multiple','locations':[
            {'locality':'Казани','object':'парк','quote':'В Казани открыли парк.'},
            {'locality':'Челнах','object':'парк','quote':'В Челнах закрыли парк.'}]},text)
        self.assertEqual(len(result['locations']),2)

    def test_sweep_deduplicates_pending_and_skips_resolved_objects(self):
        h=LiveGeocodingTests()
        with tempfile.TemporaryDirectory() as folder:
            db=h.db(folder)
            try:
                e=h.store(db,h.source(db),'ул. Кремлёвская, д. 10')
                d=json.loads(e['data_json']);d['signalUsefulness']={'showOnMap':True}
                db.execute('update events set data_json=?',(json.dumps(d),))
                self.assertEqual(enqueue_location_sweep(db),0)
                db.execute("update jobs set status='complete'")
                self.assertEqual(enqueue_location_sweep(db),1)
                self.assertEqual(enqueue_location_sweep(db),0)
                db.execute("update jobs set status='complete'")
                db.execute("update events set precision='building'")
                self.assertEqual(enqueue_location_sweep(db),0)
            finally:db.close()

    def test_source_policy_blocks_model_call(self):
        h=LiveGeocodingTests()
        with tempfile.TemporaryDirectory() as folder:
            db=h.db(folder)
            try:
                e=h.store(db,h.source(db),'ул. Кремлёвская, д. 10')
                db.execute('update sources set ai_allowed=0')
                data={}
                with patch('location_resolution.interpret_location') as model:
                    self.assertEqual(resolve_unmatched(db,e,data,{}),(None,None))
                    model.assert_not_called()
                self.assertEqual(data['locationResolution']['status'],'source_policy_local_only')
            finally:db.close()

class AddressAliasTests(unittest.TestCase):
    def test_alternate_house_alias_is_scoped_and_ambiguous_alias_is_rejected(self):
        from object_geocoding import match_objects
        from region_config import fold
        one={'id':'1','territoryId':'city','name':'Адрес','address':'проспект, 11','precision':'building',
            'coordinates':[52,55],'geometry':{'type':'Polygon','coordinates':[]},'bbox':[52,55,52,55],'sourceUrl':'https://www.openstreetmap.org/way/1'}
        index={'objects':[one],'_addressAliases':{fold('дом 65/18'):[one]},'_named':[]}
        self.assertEqual(match_objects(['дом 65/18'],'','other',index)['status'],'unmatched')
        self.assertEqual(match_objects(['дом 65/18'],'','city',index)['objectId'],'1')
        index['_addressAliases'][fold('дом 65/18')].append({**one,'id':'2'})
        self.assertEqual(match_objects(['дом 65/18'],'','city',index)['status'],'ambiguous')

    def test_search_uses_distinctive_quoted_name_but_verifies_address(self):
        import location_resolution as resolver
        import langsearch_location as search
        search.reset_search_budget()
        raw={'data':{'webPages':{'value':[{'name':'Приют Камские зори, Менделеевск',
            'snippet':'улица Бурмистрова, 7Б','url':'https://example.test/evidence'}]}}}
        verified={'osmId':'way/1','verifiedAddress':'улица Бурмистрова, 7Б','coordinates':[52,55]}
        with patch.object(resolver,'_search',return_value=raw),patch.object(resolver,'_osm_match',return_value=verified) as osm:
            result=resolver.search_location({'object':'социального приюта «Камские зори»'},'Менделеевск','')
        self.assertEqual(result['url'],'https://example.test/evidence')
        self.assertEqual(result['osmId'],'way/1')
        osm.assert_called()

    def test_missing_source_name_in_search_cannot_supply_coordinates(self):
        import location_resolution as resolver
        import langsearch_location as search
        search.reset_search_budget()
        raw={'data':{'webPages':{'value':[{'name':'Другой приют, Менделеевск',
            'snippet':'улица Бурмистрова, 7Б','url':'https://example.test/wrong'}]}}}
        with patch.object(resolver,'_search',return_value=raw),patch.object(resolver,'_osm_match') as osm:
            self.assertIsNone(resolver.search_location({'object':'приют «Камские зори»'},'Менделеевск',''))
        osm.assert_not_called()
