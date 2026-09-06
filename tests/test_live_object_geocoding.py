import sys,unittest,tempfile,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
from object_geocoding import split_address,match_objects,load_object_index,polygon_anchor
from analysis import extract_addresses,rule_based
from connectors import FeedDocument

class ObjectGeocodingTests(unittest.TestCase):
    def test_house_and_corpus_are_preserved_and_not_confused_with_street_number(self):
        self.assertEqual(split_address('Ново-Савиновский, ЯМАШЕВА ПРОСПЕКТ, 28'),('ямашева','avenue','28'))
        self.assertEqual(split_address('ул. Кремлёвская, д. 10 корпус 2'),('кремлевская','street','10к2'))
        self.assertEqual(extract_addresses('На улице 8 Марта, 102 отключение воды.'),['улице 8 Марта, 102'])
        self.assertEqual(extract_addresses('ул. Кремлёвская, д. 10'),['ул. Кремлёвская, д. 10'])
    def test_exact_house_wins_but_other_house_corpus_territory_and_duplicates_do_not(self):
        ring=[[49,55],[49.001,55],[49.001,55.001],[49,55.001],[49,55]]
        obj={'id':'1','territoryId':'kazan','street':'проспект Хусаина Ямашева','house':'28','address':'проспект Хусаина Ямашева, 28','name':'Дом','aliases':[],
            'precision':'building','coordinates':[49.0005,55.0005],'bbox':[49,55,49.001,55.001],'geometry':{'type':'Polygon','coordinates':[ring]},'sourceUrl':'https://www.openstreetmap.org/way/1'}
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'index.json';p.write_text(json.dumps({'schemaVersion':1,'objects':[obj]}));index=load_object_index(str(p),1)
            self.assertEqual(match_objects(['ЯМАШЕВА ПРОСПЕКТ, 28'],'','kazan',index)['precision'],'building')
            for a,t in [('Ямашева, 28к2','kazan'),('Ямашева, 29','kazan'),('Ямашева, 28','other')]:self.assertEqual(match_objects([a],'',t,index)['status'],'unmatched')
            index['_houses']['28'][0]['scopeIds']=['kazan','district']
            self.assertEqual(match_objects(['Ямашева, 28'],'','district',index)['status'],'matched')
            index['_houses']['28'].append({**obj,'id':'2'})
            self.assertEqual(match_objects(['Ямашева, 28'],'','kazan',index)['status'],'ambiguous')
            index['_houses']['28'][-1]['scopeIds']=['other-village','district']
            self.assertEqual(match_objects(['Ямашева, 28'],'','district',index)['status'],'ambiguous')
    def test_anchor_is_inside_concave_building_not_its_empty_courtyard(self):
        ring=[[0,0],[4,0],[4,1],[1,1],[1,4],[0,4],[0,0]]
        x,y=polygon_anchor(ring);self.assertTrue(0<x<4 and 0<y<4 and (x<1 or y<1))
    def test_positive_sports_opening_and_utility_headline_keep_their_meaning(self):
        d=FeedDocument('1','https://example.org','🏉Мяч в игре','2026-09-02T10:00:00Z','🏉Мяч в игре\nНа ул.Рауиса Гареева открылся Центр регби. Здесь есть медкабинеты. ⚜️ VK | Одноклассники | MAКС')
        e=rule_based(d)[0];self.assertEqual((e['topic'],e['state'],e['outcome']),('culture','resolved','improvement'));self.assertNotIn('Мяч',e['title']);self.assertNotIn('Одноклассники',e['summary'])
        title='Отключение водоснабжения: Авиастроительный, ЗЕЛИНСКОГО, 102'
        e=rule_based(FeedDocument('2','https://example.org/2',title,'2026-09-04','Источник сообщает о работах по адресу: ЗЕЛИНСКОГО, 102.'))[0]
        self.assertEqual(e['title'],title)

if __name__=='__main__':unittest.main()

class CanonicalHouseTests(unittest.TestCase):
    def test_unique_street_match_canonicalizes_case_without_losing_house(self):
        from geocoding import canonical_house_candidate
        matched={'status':'matched','precision':'street','candidateCount':1,'streetName':'Оренбургский тракт'}
        self.assertEqual(canonical_house_candidate('Оренбургском тракте, 81',matched),'Оренбургский тракт, 81')
        self.assertEqual(canonical_house_candidate('Оренбургском тракте, 81 корпус 2',matched),'Оренбургский тракт, 81к2')
        self.assertEqual(canonical_house_candidate('Оренбургском тракте, 81',{**matched,'status':'ambiguous'}),'Оренбургском тракте, 81')
        self.assertEqual(canonical_house_candidate('Оренбургском тракте',matched),'Оренбургском тракте')
