import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts/live'))
from corner_addresses import corner_candidates, directory_pair, next_to_street

class CornerAddressesTests(unittest.TestCase):
    def setUp(self):
        self.obj = {'id':'building', 'house':'30/23', 'street':'улица Клары Цеткин', 'scopeIds':['kazan'], 'precision':'building'}
        self.item = {'url':'https://2gis.ru/kazan/geo/2956122910655952', 'name':'Клары Цеткин, 30 / Адмиралтейская улица, 23 в Казани — 2ГИС', 'snippet':'Кировский район, Казань 420030'}
        self.address='улица Клары Цеткин, 30'

    def test_independent_double_address_confirms_both_numbers(self):
        self.assertIsNotNone(directory_pair(self.item, self.address, '30/23', 'Казань'))
        for house in ['30/24','30к1','30а']:
            self.assertIsNone(directory_pair(self.item, self.address, house, 'Казань'))
        self.assertEqual(len(corner_candidates(self.address, 'kazan', {'objects':[self.obj]})),1)

    def test_wrong_city_street_and_non_building_pages_rejected(self):
        self.assertIsNone(directory_pair(self.item,self.address,'30/23','Самара'))
        self.assertIsNone(directory_pair(self.item,'улица Ленина, 30','30/23','Казань'))
        self.assertIsNone(directory_pair({**self.item,'url':'https://2gis.ru/kazan/firm/123'},self.address,'30/23','Казань'))
        self.assertIsNone(directory_pair({**self.item,'url':'https://2gis.ru.evil.test/kazan/geo/123'},self.address,'30/23','Казань'))
        self.assertEqual(corner_candidates(self.address,'samara',{'objects':[self.obj]}),[])

    def test_compound_complex_and_unconfirmed_short_number_not_aliases(self):
        self.assertEqual(corner_candidates('улица Клары Цеткин, 30/23','kazan',{'objects':[self.obj]}),[])
        self.assertIsNone(directory_pair({**self.item,'name':'Клары Цеткин, 30/23 в Казани'},self.address,'30/23','Казань'))
        self.assertIsNone(directory_pair({**self.item,'name':'Клары Цеткин, 30 / Клары Цеткин, 23 в Казани'},self.address,'30/23','Казань'))
        self.assertEqual(corner_candidates(self.address,'kazan',{'objects':[{**self.obj,'house':'30к1'}]}),[])

    def test_multiple_candidates_remain_ambiguous(self):
        self.assertEqual(len(corner_candidates(self.address,'kazan',{'objects':[self.obj,{**self.obj,'id':'other','house':'30/24'}]})),2)

    def test_second_street_must_be_next_to_building(self):
        line={'type':'LineString','coordinates':[[49.,55.],[49.,55.01]]}
        self.assertTrue(next_to_street([49.0002,55.005],line))
        self.assertFalse(next_to_street([49.01,55.005],line))
        self.assertFalse(next_to_street([49.,55.02],line))
        self.assertFalse(next_to_street([49.,55.],{}))

if __name__=='__main__':unittest.main()
