from __future__ import annotations

import asyncio
import dataclasses
import os
from collections.abc import AsyncIterator
from typing import Any

from connectors import FeedDocument, parse_date


class TelegramDisabled(RuntimeError):
    pass


def configured() -> bool:
    return bool(os.getenv("ATLAS_TELEGRAM_API_ID") and os.getenv("ATLAS_TELEGRAM_API_HASH") and os.getenv("ATLAS_TELEGRAM_SESSION"))


def _client():
    if not configured():
        raise TelegramDisabled("Telegram remains disabled until local MTProto credentials are configured")
    try:
        from telethon import TelegramClient
    except ImportError as exc:
        raise TelegramDisabled("Install the optional pinned dependency telethon==1.44.0") from exc
    return TelegramClient(os.environ["ATLAS_TELEGRAM_SESSION"], int(os.environ["ATLAS_TELEGRAM_API_ID"]), os.environ["ATLAS_TELEGRAM_API_HASH"])


def validate_source(source: dict[str, Any]) -> None:
    if source.get("adapter") != "telegram" or source.get("enabled") is not True:
        raise TelegramDisabled("Telegram source is disabled")
    if source.get("fetch_allowed") is not True and (source.get("consent_status") != "explicit" or source.get("ai_use") is not True):
        raise TelegramDisabled("Telegram source requires explicit relevant-user consent for AI processing")
    if not source.get("telegram_peer"):
        raise TelegramDisabled("Telegram peer is required")


def _document(source: dict[str, Any], message: Any, deleted: bool = False) -> FeedDocument:
    external_id = str(message if isinstance(message, int) else message.id)
    text = "" if isinstance(message, int) else (message.message or "")
    date = None if isinstance(message, int) else parse_date(message.date.isoformat())
    edited = None if isinstance(message, int) or not message.edit_date else parse_date(message.edit_date.isoformat())
    peer = source["telegram_peer"].lstrip("@")
    return FeedDocument(external_id, f"https://t.me/{peer}/{external_id}", (text.splitlines()[0][:500] if text.splitlines() else "Сообщение Telegram"),
        date, text, source_updated_at=edited, deleted=deleted)


async def backfill(source: dict[str, Any], *, since, limit: int = 1000) -> list[FeedDocument]:
    validate_source(source)
    client = _client()
    result: list[FeedDocument] = []
    from telethon.errors import FloodWaitError
    async with client:
        try:
            async for message in client.iter_messages(source["telegram_peer"], limit=limit):
                if message.date < since:
                    break
                result.append(_document(source, message))
        except FloodWaitError as exc:
            await asyncio.sleep(exc.seconds + 1)
            raise
    return result


async def listen(source: dict[str, Any]) -> AsyncIterator[FeedDocument]:
    validate_source(source)
    client = _client()
    from telethon import events
    queue: asyncio.Queue[FeedDocument] = asyncio.Queue(maxsize=512)
    async def incoming(event): await queue.put(_document(source, event.message))
    async def deleted(event):
        for mid in event.deleted_ids: await queue.put(_document(source, mid, deleted=True))
    handlers=[(incoming,events.NewMessage(chats=source['telegram_peer'])),(incoming,events.MessageEdited(chats=source['telegram_peer'])),(deleted,events.MessageDeleted(chats=source['telegram_peer']))]
    try:
        for callback,event in handlers: client.add_event_handler(callback,event)
        await client.connect()
        if not await client.is_user_authorized(): raise TelegramDisabled('Local authorization required')
        while True: yield await queue.get()
    finally:
        for callback,event in handlers: client.remove_event_handler(callback,event)
        await client.disconnect()


async def reconcile(source: dict[str, Any], known_ids: set[str], *, recent: int = 200) -> list[FeedDocument]:
    validate_source(source)
    client = _client()
    candidates = sorted((int(value) for value in known_ids if value.isdigit()), reverse=True)[:recent]
    current: set[str] = set()
    async with client:
        messages = await client.get_messages(source["telegram_peer"], ids=candidates)
        current = {str(message.id) for message in messages if message is not None}
    checked = {str(value) for value in candidates}
    return [_document(source, int(message_id), deleted=True) for message_id in checked - current]
