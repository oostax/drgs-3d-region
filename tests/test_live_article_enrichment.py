import dataclasses,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
from article_enrichment import parse_article_body,enrich_articles
from analysis import AnyModelAnalyzer,extract_addresses,rule_based,is_relevant
from connectors import FeedDocument,FetchResult,parse_feed
from region_config import resolve_locality,source_locates_in_place
from worker import open_database,sync_registry,store_document,_replace_document_analysis,activity_kind
from geocoding import merge_duplicate_source_site


class ArticleEnrichmentTests(unittest.TestCase):
    def test_body_excludes_editor_address_related_news_and_embedded_ads(self):
        body=b'''<main><section class="single__text-share"><p class="single__lead">Repair.</p>
        <div class="single__content"><p>Street A, 10</p><div class="widget-any-content">Street B, 20</div>
        <ul><li>Street C, 30</li></ul><aside>Street D, 40</aside></div></section>
        <footer>Editor Street E, 50</footer></main>'''
        self.assertEqual(parse_article_body(body),'Repair.\nStreet A, 10\nStreet C, 30')
        self.assertEqual(parse_article_body(b'<body>No dedicated article body<footer>Address</footer></body>'),'')

    def test_rss_uses_full_content_and_does_not_drop_source_street(self):
        xml='''<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><guid>1</guid><title>Ремонт</title><link>https://example.org/news/1</link><pubDate>Fri, 04 Sep 2026 10:00:00 +0300</pubDate><description>Начали ремонт.</description><content:encoded><![CDATA[<p>Начали ремонт на улице 8 Марта, 17.</p>]]></content:encoded></item></channel></rss>'''
        self.assertIn('8 Марта, 17',parse_feed(xml.encode(),'https://example.org/rss')[0].body)

    def test_numbered_streets_lists_and_local_context_keep_verbatim_evidence(self):
        self.assertEqual(extract_addresses('В доме 8 Марта, 17 обнаружены нарушения.'),['8 Марта, 17'])
        self.assertEqual(extract_addresses('Дистанции 18, 50, 70 метров; субсидия 2,5 млн рублей.'),[])
        body='Плановые отключения электроэнергии. Не исключено досрочное завершение мероприятий.\nГрафик отключений:\nсело Русское Макулово (улицы Дружбы, Садовая).\nдеревня Канаш (улицы Зелёная, Центральная).'
        doc=FeedDocument('1','https://example.org/1','Плановые отключения электричества','2026-09-04T00:00:00Z',body)
        events=rule_based(doc)
        self.assertEqual(len(events),4)
        self.assertTrue(all(e['state']=='planned' and e['location_context'] in body and e['address_candidates'][0] in body for e in events))
        self.assertEqual(events[0]['site_group_key'],events[-1]['site_group_key'])

    def test_common_word_new_never_relocates_a_city_event(self):
        places=[{'id':'r','name':'Регион','parentId':None},{'id':'k','name':'город Казань','parentId':'r'},
                {'id':'v','name':'Азьмушкинское сельское поселение','parentId':'r','administrativeCenterName':'п Новый'}]
        self.assertEqual(resolve_locality('Новый водовод в Казани',[],'k',{},places),'k')
        self.assertEqual(resolve_locality('В поселке Новый ремонтируют водовод',[],'r',{},places),'v')
        self.assertFalse(source_locates_in_place('В аэропорту Бегишево проверили кафе',{'name':'Бегишево'}))
        self.assertFalse(source_locates_in_place('Студотряд КГАСУ «Казань» победил на строительстве ВСМ',{'name':'Казань'}))
        self.assertTrue(source_locates_in_place('В Казани ремонтируют водопровод',{'name':'Казань'}))

    def test_future_traffic_closure_is_not_an_active_repair_or_road_defect(self):
        title='В центре Казани введут ограничения движения 27 и 28 октября'
        body='Ограничения будут действовать на участках улицы Пушкина и улицы Театральная. Причина — проведение мероприятия.'
        events=rule_based(FeedDocument('158535','https://t.me/tatmediaofficial/158535',title,'2026-09-04T07:15:24Z',body))
        self.assertTrue(events)
        for event in events:
            self.assertEqual((event['topic'],event['state']),('roads','planned'))
            self.assertEqual(activity_kind(event,False),'place_event')
            self.assertFalse(event['animation_eligible'])
            self.assertIsNone(event['physical_activity_evidence'])
        repair=rule_based(FeedDocument('1','https://example.org/1','Ремонт улицы','2026-09-04T00:00:00Z','Сейчас ремонтируют дорогу на улице Пушкина.'))[0]
        self.assertEqual((repair['state'],activity_kind(repair,True)),('in_progress','road_repair'))

    def test_ads_and_folk_superstitions_are_not_physical_sites(self):
        for text in ['Народные приметы: нельзя начинать строительство','Реклама. Строительство и ремонт.','Акция «Капля жизни»: дети оставались без воды.']:
            self.assertFalse(is_relevant(FeedDocument('x','https://example.org',text,'2026-09-04',text)))

    def test_enrichment_is_bounded_versioned_and_survives_unchanged_rss(self):
        with tempfile.TemporaryDirectory() as folder:
            db=open_database(Path(folder)/'live.sqlite')
            self.addCleanup(db.close)
            source={'id':'one','name':'One','url':'https://example.org/rss','adapter':'rss','source_kind':'official','status':'active','territory_id':'mo-92701000','fetch_allowed':True,'ai_allowed':False,'display_allowed':True,'coverage':[],'provenance_url':'https://example.org'}
            sync_registry(db,[source]);source=db.execute('select * from sources').fetchone()
            doc=FeedDocument('1','https://example.org/news/1','Ремонтируют водопровод','2026-09-04T10:00:00Z','Начали ремонт водопровода.')
            store_document(db,source,doc,AnyModelAnalyzer(),notify_new=False)
            full='На улице Кремлёвской, 10 ремонтируют водопровод. '+'Работы выполняет коммунальная служба. '*5
            result=FetchResult(doc.url,doc.url,200,'text/html',('<div class="single__content"><p>'+full+'</p></div>').encode(),None,None,'2026-09-05T00:00:00Z')
            with patch('article_enrichment.BoundedFetcher.get',return_value=result) as fetch:
                self.assertEqual(enrich_articles(db,limit=1)['enriched'],1)
                self.assertEqual(enrich_articles(db,limit=1)['selected'],0)
                self.assertEqual(fetch.call_count,1)
            versions=db.execute('select count(*) from document_versions').fetchone()[0]
            store_document(db,source,doc,AnyModelAnalyzer(),notify_new=False)
            self.assertIn('Кремлёвской',db.execute('select body from documents').fetchone()[0])
            self.assertEqual(db.execute('select count(*) from document_versions').fetchone()[0],versions)
            self.assertFalse(db.execute('select count(*) from events where notify_eligible=1').fetchone()[0])

    def test_reprocessing_relocates_only_automatic_geometry(self):
        with tempfile.TemporaryDirectory() as folder:
            db=open_database(Path(folder)/'live.sqlite');self.addCleanup(db.close)
            sync_registry(db,[{'id':'one','name':'One','url':'https://example.org/rss','adapter':'rss','source_kind':'official','status':'active','territory_id':'mo-92701000','fetch_allowed':True,'ai_allowed':False,'display_allowed':True,'coverage':[],'provenance_url':'https://example.org'}])
            source=db.execute('select * from sources').fetchone()
            doc=FeedDocument('1','https://example.org/news/1','Ремонт дороги','2026-09-04T10:00:00Z','Новый проезд по улице Кремлёвской.')
            with patch('worker.event_territory',return_value='wrong-village'):store_document(db,source,doc,AnyModelAnalyzer(),notify_new=False)
            db.execute("update events set precision='street',longitude=49,latitude=55");db.commit()
            row=db.execute('select * from documents').fetchone()
            with patch('worker.event_territory',return_value='mo-92701000'):_replace_document_analysis(db,row,source,doc,rule_based(doc),correcting_rules=True)
            self.assertEqual(db.execute('select territory_id,precision,longitude from events').fetchone()[:],('mo-92701000','territory',None))

    def test_resolved_road_dedup_is_per_source_post_and_keeps_distinct_geometry(self):
        with tempfile.TemporaryDirectory() as folder:
            db=open_database(Path(folder)/'live.sqlite');self.addCleanup(db.close)
            sync_registry(db,[{'id':'one','name':'One','url':'https://example.org/rss','adapter':'rss','source_kind':'official','status':'active','territory_id':'mo-92701000','fetch_allowed':True,'ai_allowed':False,'display_allowed':True,'coverage':[],'provenance_url':'https://example.org'}])
            source=db.execute('select * from sources').fetchone()
            doc=FeedDocument('1','https://example.org/news/1','Плановые отключения электроэнергии','2026-09-04T10:00:00Z','График отключений:\nулицы Кремлёвская, Пушкина.')
            store_document(db,source,doc,AnyModelAnalyzer(),notify_new=False)
            rows=db.execute('select * from events').fetchall();self.assertEqual(len(rows),2)
            kept_data={'site_group_key':'post-1','locationEvidence':{'status':'matched','streetId':'road-1'}}
            db.execute('update events set data_json=? where id=?',(json.dumps(kept_data),rows[0]['id']))
            other_data={'site_group_key':'post-2'}
            self.assertIsNone(merge_duplicate_source_site(db,rows[1],other_data,{'status':'matched','streetId':'road-1'}))
            self.assertIsNone(merge_duplicate_source_site(db,rows[1],{'site_group_key':'post-1'},{'status':'matched','streetId':'road-2'}))
            self.assertEqual(merge_duplicate_source_site(db,rows[1],{'site_group_key':'post-1'},{'status':'matched','streetId':'road-1'}),rows[0]['id'])
            self.assertEqual(db.execute('select count(*) from events where deleted=0').fetchone()[0],1)
            self.assertEqual(db.execute('select event_id from event_aliases where alias=?',(rows[1]['id'],)).fetchone()[0],rows[0]['id'])


if __name__=='__main__':unittest.main()
