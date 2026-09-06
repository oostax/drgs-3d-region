import datetime as dt,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
from region_config import resolve_locality
from geocoding import match_address_candidates,normalize_street
from worker import open_database,sync_registry,store_document,_existing_event
from analysis import AnyModelAnalyzer,rule_based,is_relevant
from connectors import FeedDocument

class RegionTests(unittest.TestCase):
 def test_settlement_in_content_overrides_district_publisher_but_homonyms_need_scope(self):
  places=[{'id':'r','name':'Область','parentId':None},{'id':'d','name':'Северный район','parentId':'r'}, {'id':'a','name':'село Лесное','parentId':'d'},{'id':'b','name':'село Лесное','parentId':'r'}]
  self.assertEqual(resolve_locality('Северный район: в селе Лесное ремонтируют дорогу',[],'d',{},places),'a')
  self.assertEqual(resolve_locality('В селе Лесное ремонтируют дорогу',[],'r',{},places),'r')
  self.assertEqual(resolve_locality('Иная деревня', ['Лесное'],'r',{},places),'r')
 def test_tatar_road_name_and_activity_are_not_lost(self):
  self.assertEqual(normalize_street('Тукай урамы'),('тукай','street'))
  d=FeedDocument('1','https://example.org/1','Авылда юл ремонтлана','2026-09-04T10:00:00Z','Юл ремонтлана')
  self.assertTrue(is_relevant(d));self.assertEqual(rule_based(d)[0]['state'],'in_progress');self.assertEqual(rule_based(d)[0]['topic'],'roads')
 def test_regional_geocoding_does_not_take_homonymous_street_from_another_town(self):
  index={'territoryId':'test-region','streets':[{'id':x,'name':'Тукай урамы','territoryId':x,'scopeIds':[x,'test-region'],'coordinates':[49,55]} for x in ['a','b']]}
  self.assertEqual(match_address_candidates(['Тукай урамы'],'a',index)['streetId'],'a')
  self.assertEqual(match_address_candidates(['Тукай урамы'],'test-region',index)['status'],'ambiguous')
 def test_two_regions_keep_identical_news_separate(self):
  with tempfile.TemporaryDirectory() as folder:
   db=open_database(Path(folder)/'live.sqlite')
   try:
    sources=[{'id':r,'name':r,'region_id':r,'territory_id':None,'url':'https://example.org/'+r,'adapter':'rss','source_kind':'official','status':'active','fetch_allowed':True,'ai_allowed':False,'display_allowed':True,'provenance_url':'https://example.org'} for r in ['fixture-a','fixture-b']]
    sync_registry(db,sources)
    with patch('worker.event_territory',return_value=None):
     for s in sources:
      row=db.execute('select * from sources where id=?',(s['id'],)).fetchone()
      d=FeedDocument('1',s['url']+'/news','Начался ремонт школы','2026-09-04T10:00:00Z','Ремонтируют школу')
      store_document(db,row,d,AnyModelAnalyzer(),notify_new=False)
    self.assertEqual(db.execute('select count(*) from events').fetchone()[0],2)
    self.assertEqual(db.execute('select count(distinct canonical_key) from events').fetchone()[0],2)
   finally:db.close()
 def test_cancellation_is_not_a_completed_repair(self):
  d=FeedDocument('1','https://example.org/1','Ремонт отменён','2026-09-04T10:00:00Z','Ремонт не завершен; контракт отменён')
  self.assertEqual(rule_based(d)[0]['state'],'cancelled')
if __name__=='__main__':unittest.main()
