import unittest
from scripts.live.connectors import parse_date
from scripts.live.analysis import _iso_event_time, event_timestamp_candidates

class SignalTimeTests(unittest.TestCase):
    def test_publication_precision(self):
        self.assertEqual(parse_date('2026-09-05'),'2026-09-05')
        self.assertEqual(parse_date('05.09.2026'),'2026-09-05')
        self.assertEqual(parse_date('05.09.2026 14:32'),'2026-09-05T11:32:00Z')
        self.assertEqual(parse_date('2026-09-05T00:00:00+03:00'),'2026-09-04T21:00:00Z')
    def test_event_clock_requires_attached_evidence(self):
        self.assertEqual(_iso_event_time('Открытие 12 сентября 2026 года в 14:30','2026-09-05'),'2026-09-12T14:30:00+03:00')
        self.assertEqual(_iso_event_time('Открытие 12.09.2026 в 14:30','2026-09-05'),'2026-09-12T14:30:00+03:00')
        self.assertEqual(_iso_event_time('Завтра в 09:00 отключат воду','2026-09-05'),'2026-09-06T09:00:00+03:00')
        self.assertEqual(_iso_event_time('Открытие 12 сентября','2026-09-05'),'2026-09-12')
        self.assertEqual(event_timestamp_candidates('12 сентября. Дежурный отвечает в 14:30','2026-09-05'),[])
        self.assertEqual(event_timestamp_candidates('12.09.2026 в 25:90','2026-09-05'),[])

class HouseListTests(unittest.TestCase):
    def test_separate_house_paragraph_inherits_only_one_street(self):
        from scripts.live.analysis import extract_addresses
        text='На улице Карла Маркса проведут подключение.\n\nОтключение 5 сентября с 8.00 до 20.00 в следующих домах: N 2, 3, 10, 12, 37а.'
        self.assertEqual(extract_addresses(text),['улице Карла Маркса, '+n for n in ['2','3','10','12','37а']])
        self.assertEqual(len(extract_addresses('На улице Ленина и улице Мира. Отключение в домах: № 2, 3.')),2)

class OsmDataFallbackTests(unittest.TestCase):
    def test_house_requires_full_matching_tags_and_one_footprint(self):
        from scripts.live.osm_address_fallback import exact_map_house
        raw={'elements':[{'type':'node','id':i+1,'lon':x,'lat':y} for i,(x,y) in enumerate([(49,55),(49.001,55),(49.001,55.001),(49,55.001)])]+[{'type':'way','id':10,'nodes':[1,2,3,4,1],'tags':{'building':'apartments','addr:city':'Зеленодольск','addr:street':'улица Карла Маркса','addr:housenumber':'37А'}}]}
        result=exact_map_house(raw,'улица Карла Маркса, 37а','Зеленодольск')
        self.assertEqual(result['precision'],'building')
        self.assertIsNone(exact_map_house(raw,'улица Карла Маркса, 37','Зеленодольск'))
        self.assertIsNone(exact_map_house(raw,'улица Карла Маркса, 37а','Казань'))
        raw['elements'].append({**raw['elements'][-1],'id':11})
        self.assertIsNone(exact_map_house(raw,'улица Карла Маркса, 37а','Зеленодольск'))

    def test_ai_cannot_collapse_an_inherited_house_list(self):
        from scripts.live.analysis import validate_events
        from scripts.live.connectors import FeedDocument
        body='На улице Карла Маркса проведут подключение.\nОтключение в следующих домах: N 2, 3, 10, 12, 37а.'
        doc=FeedDocument('test','https://example.test/news','Отключение воды','2026-09-04',body)
        event={'title':doc.title,'summary':'Отключение воды','topic':'utilities','state':'planned','severity':'medium','event_time':None,'address_candidates':['улице Карла Маркса'],'locality_candidates':[],'evidence':[{'quote':body,'start':len(doc.title)+1,'end':len(doc.title)+1+len(body)}]}
        events=validate_events([event],doc.title+'\n'+body,doc)
        self.assertEqual(len(events),5)
        self.assertEqual(len({e['address_candidates'][0] for e in events}),5)
