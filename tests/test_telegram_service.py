import asyncio,datetime as dt,sys,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
from telegram_connector import _document,validate_source,TelegramDisabled
from telegram_service import TelegramService
class Tests(unittest.TestCase):
 def test_deletion_and_empty_media_have_no_fake_publication_date(self):
  s={'telegram_peer':'channel'};d=_document(s,5,True);self.assertTrue(d.deleted);self.assertIsNone(d.published_at)
  m=SimpleNamespace(id=5,message='',date=dt.datetime.now(dt.timezone.utc),edit_date=None)
  self.assertEqual(_document(s,m).title,'Сообщение Telegram')
 def test_read_permission_is_independent_of_ai(self):
  s={'adapter':'telegram','enabled':True,'telegram_peer':'channel','fetch_allowed':True,'ai_allowed':False}
  validate_source(s)
  with self.assertRaises(TelegramDisabled):validate_source({**s,'fetch_allowed':False})
 def test_queue_is_bounded_and_messages_keep_notify_semantics(self):
  svc=TelegramService([]);self.assertEqual(svc.queue.maxsize,512)
  asyncio.run(svc.emit({'id':'a'},_document({'telegram_peer':'a'},1,True),False))
  sid,doc,notify=svc.queue.get_nowait();self.assertEqual(sid,'a');self.assertFalse(notify);self.assertTrue(doc.deleted)
 def test_one_unavailable_channel_does_not_stop_other_channels(self):
  sources=[{'id':name,'telegram_peer':name,'adapter':'telegram','enabled':True,'fetch_allowed':True} for name in ['removed','working']]
  class Client:
   async def get_entity(self,peer):
    if peer=='removed':raise ValueError('removed channel')
    return 42
  svc=TelegramService(sources);channels=asyncio.run(svc.resolve_sources(Client(),lambda e:e))
  self.assertEqual(channels[42]['id'],'working');self.assertEqual(svc.health['removed']['error'],'ValueError')
 def test_floodwait_stops_resolution_for_the_whole_account(self):
  class Wait(Exception):seconds=120
  class Client:
   async def get_entity(self,peer):raise Wait()
  svc=TelegramService([{'id':'a','telegram_peer':'a','adapter':'telegram','enabled':True,'fetch_allowed':True}])
  with self.assertRaises(Wait):asyncio.run(svc.resolve_sources(Client(),lambda e:e))
if __name__=='__main__':unittest.main()
