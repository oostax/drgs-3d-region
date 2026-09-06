import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
from analysis import is_relevant,rule_based,extract_addresses
from connectors import FeedDocument
from geocoding import match_address_candidates

def doc(title,body):return FeedDocument('1','https://example.org/1',title,'2026-09-04T10:00:00Z',body)

class SignalRulesTests(unittest.TestCase):
    def test_opening_fire_training_facility_is_not_a_fire(self):
        event=rule_based(doc('В районе открылись учебно-тренировочный комплекс и новая пожарная часть', 'Здесь будут отрабатывать тушение пожаров, спасение при авариях и утечках.'))[0]
        self.assertEqual((event['topic'],event['state'],event['outcome']),('construction','resolved','improvement'))
        self.assertFalse(event['animation_eligible'])
        fire=rule_based(doc('На полигоне произошел пожар','Возгорание тушат спасатели.'))[0]
        self.assertEqual(fire['topic'],'fire')

    def test_calendar_and_weather_numbers_are_not_house_addresses(self):
        for text in ['Сегодня, 4 сентября, пройдет праздник.', 'Ветер юго-западный, 5 метров в секунду.', 'По прогнозу синоптиков, 5 сентября будет дождь.']:
            self.assertEqual(extract_addresses(text),[])
        self.assertEqual(extract_addresses('Работы по адресу Мира, 1'),['Мира, 1'])

    def test_award_is_not_construction_or_a_location_from_a_biography(self):
        self.assertFalse(is_relevant(doc('Сегодня звание «Почетный гражданин Казани» вручили министру строительства', 'При его участии построен стадион Ак Барс Арена.')))

    def test_only_explicit_current_work_quote_enables_physical_activity(self):
        e=rule_based(doc('Ремонт дороги','Сейчас обновляют дорожное покрытие. Работы планируют завершить через две недели.'))[0]
        self.assertTrue(e['physical_activity_evidence'])
        self.assertIsNone(rule_based(doc('Ремонт дороги','Ремонт планируется на следующий год.'))[0]['physical_activity_evidence'])
    def test_greetings_and_literary_metaphors_are_not_city_incidents(self):
        for title,body in [('Поздравление ректора КФУ','Дорогие студенты! Мир открытий и новые решения.'),
            ('Филолог КФУ объяснил, как классики заглядывают в души','Толстой открыл новые дороги мысли.'),
            ('В КФУ зажгли свечи в День солидарности','В 2004 году заложники были без воды.')]:
            self.assertFalse(is_relevant(doc(title,body)))
        self.assertNotEqual(rule_based(doc('Вручили награды','Студенты получили награды.'))[0]['topic'],'weather')

    def test_current_roadwork_is_not_changed_to_planned_by_its_future_deadline(self):
        body='Ремонт на проспекте Ямашева: от ул.Мусина до ул.Адоратского. Сейчас обновляют дорожное покрытие. Работы планируют завершить через 2 недели.'
        event=rule_based(doc('Улицы ждали именно нас',body))[0]
        self.assertEqual(event['topic'],'roads');self.assertEqual(event['state'],'in_progress')
        self.assertEqual(event['address_candidates'],['проспекте Ямашева'])
        self.assertEqual(extract_addresses('Обновили тротуар на улице Марджани. Здесь появились фонари.'),['улице Марджани'])

    def test_parallel_carriageways_merge_but_distant_homonyms_remain_ambiguous(self):
        def street(id,bbox):return {'id':id,'name':'проспект Ямашева','kind':'avenue','territoryId':'kazan','aliases':[],
            'bbox':bbox,'coordinates':bbox[:2],'geometry':{'type':'LineString','coordinates':[bbox[:2],bbox[2:]]},'sourceUrls':[]}
        first=street('a',[49.1,55.82,49.18,55.821])
        second=street('b',[49.1,55.8203,49.18,55.8213])
        result=match_address_candidates(['проспекте Ямашева'],'kazan',{'territoryId':'kazan','streets':[first,second]})
        self.assertEqual(result['status'],'matched');self.assertEqual(result['precision'],'street')
        self.assertEqual(len(result['geometry']['coordinates']),2)
        distant=street('c',[49.3,55.9,49.31,55.91])
        result=match_address_candidates(['проспект Ямашева'],'kazan',{'territoryId':'kazan','streets':[first,distant]})
        self.assertEqual(result['status'],'ambiguous')

if __name__=='__main__':unittest.main()
