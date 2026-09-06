import json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
from connectors import FeedDocument
from usefulness import classify_usefulness
from analysis import rule_based,AnyModelAnalyzer
from worker import open_database,sync_registry,store_document
from deduplicate_publications import duplicate_pair,tokens
from reprocess_usefulness import refresh

class UsefulSignalTests(unittest.TestCase):
    def assess(self,title,body='',address=None,source=None):
        doc=FeedDocument('1','https://example.org/news/1',title,'2026-09-04T07:15:24Z',body)
        return classify_usefulness(doc,{'address_candidates':[address] if address else []},source)

    def test_editorial_noise_does_not_become_useful_from_money_repair_or_place(self):
        cases=[
          ('В Казани наградили лучших дорожников','Они ремонтируют дороги и строят мосты.','greeting_or_award'),
          ('Педагогов с Электронной доски почета РТ показали на медиафасаде в Казани','На Ак Барс Арене 1 сентября показали 15000 имен педагогов.','greeting_or_award'),
          ('Врач назвал противопоказания к употреблению кокосового молока','Больница в Казани принимает пациентов.','advice_without_local_change'),
          ('5 сентябрь сынамышлары','Кәче авылында күпер төзелә.','horoscope_or_folklore'),
          ('Принято решение выплачивать до 20 млн рублей в год всем, кто подпишет контракт с Минобороны РФ в Татарстане!','','recruitment_advertising'),
          ('За сутки в Татарстане зарегистрировали 19 пожаров','Спасатели выезжали в Казань.','routine_statistics_or_roundup'),
          ('Узган атнада Яшел Үзән янгын сүндерү хезмәтенә 19 чакыру килгән','','routine_statistics_or_roundup'),
          ('Фанис Сайфиев после ранения строит планы на мирную жизнь','','biography_or_history'),
          ('Выставка картин открыла в галерее новый проект','В Казани открыли выставку.','event_without_operational_change'),
          ('Россия открыта для участия всех заинтересованных стран в будущих соревнованиях','Организаторы пригласили делегации в Казань.','protocol_or_participation'),
        ]
        for title,body,reason in cases:
            with self.subTest(title=title):
                result=self.assess(title,body);self.assertFalse(result['showOnMap']);self.assertIn(reason,result['reasons'])

    def test_real_changes_are_useful_without_claiming_customer_or_current_activity(self):
        cases=[
          ('Ремонт улицы Центрально-Мариупольская','Сейчас ведется монтаж бортового камня на улице Центрально-Мариупольская.','улице Центрально-Мариупольская'),
          ('В центре Казани введут ограничения движения 27 и 28 октября','Перекроют улицу Театральная.','улицу Театральная'),
          ('В селе Кичучатово построят новый молочный комплекс','Инвестиции составят 300 млн рублей, появится 50 рабочих мест.',None),
          ('Кәче авылында яңа күпер төзелә','Күпер авылның ике өлешен тоташтырачак.',None),
          ('В Мамадышском районе закупочная цена на молоко выросла до 27 рублей за литр','Для частных хозяйств изменилась закупочная цена.',None),
        ]
        for title,body,address in cases:
            with self.subTest(title=title):
                result=self.assess(title,body,address);self.assertTrue(result['showOnMap']);self.assertTrue(result['supportedFacts'])
                self.assertNotIn('confidence',result);self.assertNotIn('checkedAt',result)

    def test_source_authority_does_not_make_generic_text_actionable(self):
        official=self.assess('В Татарстане обсудили важность развития промышленности',source={'adapter':'rss','source_kind':'official'})
        media=self.assess('В Татарстане обсудили важность развития промышленности',source={'adapter':'rss','source_kind':'media'})
        self.assertEqual(official,media);self.assertFalse(official['showOnMap'])
        self.assertEqual(official['dimensions']['actionability'],0)

    def test_outage_is_useful_but_daily_forecast_is_not_severe_warning(self):
        self.assertTrue(self.assess('Отключение водоснабжения: Ямашева, 28','Источник сообщает о работах по адресу Ямашева, 28.','Ямашева, 28',{'adapter':'vodokanal-incidents'})['showOnMap'])
        self.assertFalse(self.assess('Прогноз погоды на 5 сентября в Казани','Ожидается дождь и слабый ветер.')['showOnMap'])
        document=FeedDocument('1','https://example.org/1','Не работают светофоры','2026-08-10T00:00:00Z','В связи с аварийным отключением электроэнергии не работают светофорные объекты на улице Пушкина. Планируйте маршрут заранее.')
        self.assertEqual(rule_based(document)[0]['state'],'reported')

    def test_original_noise_document_is_preserved_and_not_sent_to_analysis(self):
        with tempfile.TemporaryDirectory() as folder:
            c=open_database(Path(folder)/'test.sqlite');self.addCleanup(c.close)
            sync_registry(c,[{'id':'one','name':'One','url':'https://example.org/rss','adapter':'rss','source_kind':'official','status':'active','territory_id':'mo-92701000','fetch_allowed':True,'ai_allowed':True,'display_allowed':True,'coverage':[],'provenance_url':'https://example.org'}])
            doc=FeedDocument('1','https://example.org/news/1','В Казани наградили дорожников','2026-09-04T00:00:00Z','Спасибо за ремонт дорог!')
            store_document(c,c.execute('select * from sources').fetchone(),doc,AnyModelAnalyzer(),notify_new=False)
            self.assertEqual(c.execute('select body,analysis_status from documents').fetchone()[:],(doc.body,'irrelevant'))
            relevance=json.loads(c.execute('select data_json from document_usefulness').fetchone()[0])
            self.assertIn('greeting_or_award',relevance['reasons']);self.assertEqual(c.execute('select count(*) from events').fetchone()[0],0)

    def test_republication_match_retains_other_places_phases_days_and_progress(self):
        def entry(**overrides):
            row={'title':'В селе Кичучатово строится школа на 100 мест','summary':'В селе Кичучатово строится школа на 100 мест. Сейчас идет монтаж каркаса нового здания. Готовность 30%.',
                 'region_id':'RU-TA','territory_id':'village-1','published_at':'2026-09-04T00:00:00Z','state':'in_progress'}
            row.update(overrides)
            return row,{'signalUsefulness':{'level':'useful'}},tokens(row['title']),tokens(row['summary'])
        original=entry()
        self.assertTrue(duplicate_pair(original,entry()))
        self.assertFalse(duplicate_pair(original,entry(territory_id='village-2')))
        self.assertFalse(duplicate_pair(original,entry(state='resolved')))
        self.assertFalse(duplicate_pair(original,entry(published_at='2026-09-05T00:00:00Z')))
        self.assertFalse(duplicate_pair(original,entry(summary=original[0]['summary'].replace('30%','60%'))))
        self.assertFalse(duplicate_pair(original,entry(summary=original[0]['summary'].replace('каркаса','фундамента'))))

    def test_metadata_refresh_keeps_original_dates_location_and_quotes(self):
        with tempfile.TemporaryDirectory() as folder:
            c=open_database(Path(folder)/'test.sqlite');self.addCleanup(c.close)
            sync_registry(c,[{'id':'one','name':'One','url':'https://example.org/rss','adapter':'rss','source_kind':'official','status':'active','territory_id':'mo-92701000','fetch_allowed':True,'ai_allowed':False,'display_allowed':True,'coverage':[],'provenance_url':'https://example.org'}])
            doc=FeedDocument('1','https://example.org/news/1','Ремонт улицы','2026-09-04T00:00:00Z','В Казани ремонтируют дорогу на улице Пушкина.')
            store_document(c,c.execute('select * from sources').fetchone(),doc,AnyModelAnalyzer(),notify_new=False)
            query='select published_at,event_time,last_meaningful_at,last_evidence_at,longitude,latitude,precision,state from events'
            before=c.execute(query).fetchall();quotes=c.execute('select * from event_evidence').fetchall()
            refresh(c)
            self.assertEqual([tuple(r) for r in before],[tuple(r) for r in c.execute(query)])
            self.assertEqual([tuple(r) for r in quotes],[tuple(r) for r in c.execute('select * from event_evidence')])
            self.assertLessEqual(len(c.execute('select summary from events').fetchone()[0]),521)

if __name__=='__main__':unittest.main()
