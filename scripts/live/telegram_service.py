"""One MTProto client, bounded queue, reconnect catch-up and edit/deletion reconciliation."""
from __future__ import annotations
import asyncio,datetime as dt,queue,threading,time
from telegram_connector import _client,_document,validate_source,configured

class TelegramService:
    def __init__(self,sources,known=None):
        self.sources=[s for s in sources if s.get('adapter')=='telegram' and s.get('enabled') and s.get('fetch_allowed')]
        self.known=known or {};self.queue=queue.Queue(maxsize=512);self.stop_event=threading.Event();self.thread=None
        self.status='not_configured';self.error=None;self.health={}
    def checked(self,source,error=None):
        self.health[source['id']]={'checked_at':dt.datetime.now(dt.timezone.utc).isoformat(),'error':error}
    async def resolve_sources(self,client,peer_id):
        channels={}
        for source in self.sources:
            if self.stop_event.is_set():break
            try:
                validate_source(source)
                entity=await asyncio.wait_for(client.get_entity(source['telegram_peer']),timeout=30)
                channels[peer_id(entity)]=source
            except Exception as exc:
                # Flood waits apply to the account: do not hammer other channels.
                if hasattr(exc,'seconds'):raise
                self.checked(source,type(exc).__name__)
        return channels
    def start(self):
        if not self.sources:self.status='no_approved_sources';return
        if not configured():return
        self.thread=threading.Thread(target=lambda:asyncio.run(self.run()),name='atlas-telegram',daemon=True);self.thread.start()
    def stop(self):self.stop_event.set()
    async def emit(self,source,document,notify):
        while not self.stop_event.is_set():
            try:self.queue.put_nowait((source['id'],document,notify));return
            except queue.Full:await asyncio.sleep(.2)
    async def history(self,client,source,notify_live=False):
        since=dt.datetime.now(dt.timezone.utc)-dt.timedelta(days=min(60,int(source.get('history_days',45))))
        known=self.known.setdefault(source['id'],set())
        # Fetch a bounded overlap after reconnect: edits to known recent messages are observed too.
        async for message in client.iter_messages(source['telegram_peer'],limit=min(1000,int(source.get('history_limit',200)))):
            if message.date<since:break
            age=(dt.datetime.now(dt.timezone.utc)-message.date).total_seconds()
            notify=notify_live and str(message.id) not in known and 0<=age<300
            if message.message:await self.emit(source,_document(source,message),notify)
            known.add(str(message.id))
        ids=sorted((int(i) for i in known if str(i).isdigit()),reverse=True)[:200]
        if ids:
            messages=await client.get_messages(source['telegram_peer'],ids=ids)
            for message_id,message in zip(ids,messages):
                if message is None:await self.emit(source,_document(source,message_id,True),False)
                elif message.message:await self.emit(source,_document(source,message),False)
        self.known[source['id']]={str(i) for i in sorted((int(i) for i in known),reverse=True)[:1000]}
    async def run(self):
        # Telethon logs expected transport reconnects at ERROR even though the
        # service catches them and retries. Keep application errors in the
        # worker heartbeat while preventing transient socket resets from
        # flooding launchd's stderr log.
        import logging
        logging.getLogger('telethon').setLevel(logging.CRITICAL)
        from telethon import events,utils
        from telethon.errors import FloodWaitError
        while not self.stop_event.is_set():
            client=_client();handlers=[];retry=10
            try:
                self.status='connecting';await asyncio.wait_for(client.connect(),timeout=30)
                if not await client.is_user_authorized():self.status='authorization_required';return
                channels=await self.resolve_sources(client,utils.get_peer_id)
                if not channels:raise ConnectionError('No accessible Telegram sources')
                async def incoming(event):
                    source=channels.get(event.chat_id)
                    if source and event.message.message:
                        self.known.setdefault(source['id'],set()).add(str(event.message.id))
                        # A post delivered after sleep is caught up silently.
                        recent=(dt.datetime.now(dt.timezone.utc)-event.message.date).total_seconds()<300
                        await self.emit(source,_document(source,event.message),recent)
                        self.checked(source)
                async def deleted(event):
                    source=channels.get(event.chat_id)
                    if source:
                        for mid in event.deleted_ids:await self.emit(source,_document(source,mid,True),False)
                for callback,kind in ((incoming,events.NewMessage),(incoming,events.MessageEdited),(deleted,events.MessageDeleted)):
                    builder=kind(chats=list(channels));client.add_event_handler(callback,builder);handlers.append((callback,builder))
                await client.catch_up();last_cycle=None
                while not self.stop_event.is_set() and client.is_connected():
                    self.status='catching_up'
                    # Unjoined public channels may not push updates. Poll them
                    # every five minutes too; reconnect/sleep catch-up stays silent.
                    notify_live=last_cycle is not None and time.monotonic()-last_cycle<600
                    last_cycle=time.monotonic()
                    for source in channels.values():
                        if self.stop_event.is_set():break
                        try:
                            await self.history(client,source,notify_live)
                            self.checked(source)
                        except FloodWaitError:raise
                        except Exception as exc:self.checked(source,type(exc).__name__)
                    self.status='listening';self.error=None
                    deadline=time.monotonic()+300
                    while time.monotonic()<deadline and client.is_connected() and not self.stop_event.is_set():await asyncio.sleep(1)
            except FloodWaitError as exc:retry=exc.seconds+1;self.status='rate_limited';self.error='Telegram FloodWait; next attempt respects server delay'
            except Exception as exc:self.status='disconnected';self.error=type(exc).__name__;retry=30
            finally:
                for callback,builder in handlers:client.remove_event_handler(callback,builder)
                await client.disconnect()
            deadline=time.monotonic()+retry
            while time.monotonic()<deadline and not self.stop_event.is_set():await asyncio.sleep(1)
