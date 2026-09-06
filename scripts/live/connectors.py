from __future__ import annotations

import datetime as dt
import email.utils
import hashlib
import html
import json
import re
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any


UTC = dt.timezone.utc
SOURCE_LOCAL_TIME = dt.timezone(dt.timedelta(hours=3))
MAX_RESPONSE_BYTES = 3_000_000


def iso_now() -> str:
    return dt.datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_date(value: str | None) -> str | None:
    if not value:
        return None
    value = " ".join(value.split())
    # Date precision is part of the evidence; do not turn a date into midnight.
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try: return dt.date.fromisoformat(value).isoformat()
        except ValueError: return None
    numeric = re.fullmatch(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})(?:\s+(?:в\s*)?(\d{1,2})[:.](\d{2})(?::(\d{2}))?)?", value)
    if numeric:
        day, month, year = map(int, numeric.groups()[:3])
        try:
            if numeric.group(4) is None: return dt.date(year, month, day).isoformat()
            parsed = dt.datetime(year, month, day, int(numeric.group(4)), int(numeric.group(5)), int(numeric.group(6) or 0), tzinfo=SOURCE_LOCAL_TIME)
            return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
        except ValueError: return None
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        parsed = None
    if parsed is None:
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            match = re.search(r"(?<!\d)(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})(?!\d)", value)
            if not match:
                return None
            day, month, year = map(int, match.groups())
            try:
                return dt.date(year, month, day).isoformat()
            except ValueError:
                return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SOURCE_LOCAL_TIME)
    return parsed.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def compact_text(value: str, limit: int = 12_000) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", value or "")).split())[:limit]


@dataclass(frozen=True)
class FetchResult:
    url: str
    final_url: str
    status: int
    content_type: str
    body: bytes
    etag: str | None
    last_modified: str | None
    fetched_at: str
    not_modified: bool = False


@dataclass(frozen=True)
class FeedDocument:
    external_id: str
    url: str
    title: str
    published_at: str | None
    body: str
    author: str | None = None
    category: str | None = None
    source_updated_at: str | None = None
    deleted: bool = False


class BoundedFetcher:
    """HTTP client with global/per-host bounds and conditional requests."""

    def __init__(self, global_limit: int = 4, per_host_limit: int = 1, timeout: float = 15, max_bytes: int = MAX_RESPONSE_BYTES):
        self.timeout = timeout
        self.max_bytes = max_bytes
        self._global = threading.BoundedSemaphore(global_limit)
        self._per_host_limit = per_host_limit
        self._hosts: dict[str, threading.BoundedSemaphore] = {}
        self._lock = threading.Lock()
        try:
            import certifi
            self._ssl_context = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            self._ssl_context = ssl.create_default_context()

    def _host_lock(self, url: str) -> threading.BoundedSemaphore:
        host = urllib.parse.urlsplit(url).hostname or ""
        with self._lock:
            return self._hosts.setdefault(host, threading.BoundedSemaphore(self._per_host_limit))

    def get(self, url: str, *, etag: str | None = None, last_modified: str | None = None) -> FetchResult:
        headers = {"User-Agent": "SberAtlasPublicSignals/1.0 (+local-pilot)", "Accept-Encoding": "identity"}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        request = urllib.request.Request(url, headers=headers)
        host_lock = self._host_lock(url)
        with self._global, host_lock:
            try:
                response = urllib.request.urlopen(request, timeout=self.timeout, context=self._ssl_context)
            except urllib.error.HTTPError as exc:
                if exc.code == 304:
                    return FetchResult(url, exc.url, 304, exc.headers.get_content_type(), b"", exc.headers.get("ETag"), exc.headers.get("Last-Modified"), iso_now(), True)
                raise
            except urllib.error.URLError as exc:
                # Some regional servers present a chain accepted by the macOS
                # trust store used by system curl but absent from Python/certifi.
                # Curl still verifies TLS; this is not an insecure retry.
                if "CERTIFICATE_VERIFY_FAILED" in str(exc):
                    return self._curl_get(url, etag=etag, last_modified=last_modified)
                raise
            with response:
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > self.max_bytes:
                    raise ValueError(f"response too large: {declared} bytes")
                body = response.read(self.max_bytes + 1)
                if len(body) > self.max_bytes:
                    raise ValueError(f"response exceeds {self.max_bytes} bytes")
                return FetchResult(url, response.url, response.status, response.headers.get_content_type(), body,
                    response.headers.get("ETag"), response.headers.get("Last-Modified"), iso_now())

    def _curl_get(self, url: str, *, etag: str | None, last_modified: str | None) -> FetchResult:
        marker = b"\nATLAS_CURL_META:"
        command = ["/usr/bin/curl", "-sS", "-L", "--compressed", "--max-time", str(int(self.timeout)),
            "--max-filesize", str(self.max_bytes), "--connect-timeout", str(min(8, int(self.timeout))),
            "-A", "SberAtlasPublicSignals/1.0 (+local-pilot)"]
        if etag:
            command += ["-H", "If-None-Match: " + etag]
        if last_modified:
            command += ["-H", "If-Modified-Since: " + last_modified]
        command += ["-w", "\nATLAS_CURL_META:%{http_code}\t%{content_type}\t%{url_effective}\t%header{etag}\t%header{last-modified}", url]
        completed = subprocess.run(command, capture_output=True, timeout=self.timeout + 2)
        body, separator, raw_meta = completed.stdout.rpartition(marker)
        if completed.returncode or not separator:
            error = completed.stderr.decode("utf-8", "replace")[:500]
            raise urllib.error.URLError(error or f"curl exited {completed.returncode}")
        status_text, content_type, final_url, response_etag, response_modified = (raw_meta.decode("utf-8", "replace").split("\t") + [""] * 5)[:5]
        status = int(status_text)
        if status >= 400:
            raise urllib.error.HTTPError(url, status, "curl HTTP error", {}, None)
        if len(body) > self.max_bytes:
            raise ValueError(f"response exceeds {self.max_bytes} bytes")
        return FetchResult(url, final_url, status, content_type.split(";", 1)[0], body,
            response_etag or None, response_modified or None, iso_now(), status == 304)


def _reject_unsafe_xml(body: bytes) -> None:
    header = body[:4096].lower()
    if b"<!doctype" in header or b"<!entity" in header:
        raise ValueError("DTD/entities are not accepted")


def parse_feed(body: bytes, source_url: str) -> list[FeedDocument]:
    _reject_unsafe_xml(body)
    root = ET.fromstring(body)
    documents: list[FeedDocument] = []
    if root.tag.rsplit("}", 1)[-1].lower() == "rss" or root.findall(".//item"):
        for item in root.findall(".//item"):
            title = compact_text(item.findtext("title") or "", 500)
            link = (item.findtext("link") or "").strip()
            guid = (item.findtext("guid") or link).strip()
            published = parse_date(item.findtext("pubDate") or item.findtext("date"))
            if not title or not link or not published or not _same_public_host(source_url, link):
                continue
            full_content=item.findtext('{http://purl.org/rss/1.0/modules/content/}encoded') or ''
            description=item.findtext('description') or ''
            documents.append(FeedDocument(guid or link, link, title, published,
                compact_text(full_content if len(full_content)>len(description) else description), compact_text(item.findtext("author") or "", 300) or None,
                compact_text(item.findtext("category") or "", 300) or None))
        return documents
    namespace = root.tag.partition("}")[0].lstrip("{")
    ns = {"a": namespace} if namespace else {}
    entries = root.findall("a:entry", ns) if namespace else root.findall("entry")
    prefix = "a:" if namespace else ""
    for entry in entries:
        title = compact_text(entry.findtext(prefix + "title", default="", namespaces=ns), 500)
        published = parse_date(entry.findtext(prefix + "published", default="", namespaces=ns))
        link_node = next((node for node in entry.findall(prefix + "link", ns) if node.get("rel", "alternate") == "alternate"), None)
        link = link_node.get("href", "") if link_node is not None else ""
        external_id = (entry.findtext(prefix + "id", default="", namespaces=ns) or link).strip()
        summary = max((entry.findtext(prefix + "summary", default="", namespaces=ns),entry.findtext(prefix + "content", default="", namespaces=ns)),key=len)
        if title and link and published and _same_public_host(source_url, link):
            documents.append(FeedDocument(external_id, link, title, published, compact_text(summary)))
    return documents


def _same_public_host(source_url: str, article_url: str) -> bool:
    try:
        source = (urllib.parse.urlsplit(source_url).hostname or "").removeprefix("www.")
        article = (urllib.parse.urlsplit(article_url).hostname or "").removeprefix("www.")
        return bool(source and article and (source == article or article.endswith("." + source)))
    except ValueError:
        return False


class _RowsParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.depth = 0
        self.current: list[str] = []
        self.rows: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        classes = dict(attrs).get("class") or ""
        if tag in ("tr", "article", "li") or (tag == "button" and "accordion-button" in classes):
            if self.depth == 0:
                self.current = []
            self.depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in ("tr", "article", "li", "button") and self.depth:
            self.depth -= 1
            if self.depth == 0:
                value = compact_text(" ".join(self.current), 4000)
                if value:
                    self.rows.append(value)

    def handle_data(self, data: str) -> None:
        if self.depth:
            self.current.append(data)


WATER_ROW = re.compile(
    r"(?P<district>[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z\- ]{2,40}),\s*(?P<address>.+?),\s*начало\s+работ\s*[-–:]\s*(?P<date>\d{1,2}[.]\d{1,2}[.]20\d{2})",
    re.IGNORECASE,
)


def parse_vodokanal_incidents(body: bytes, source_url: str) -> list[FeedDocument]:
    parser = _RowsParser()
    parser.feed(body.decode("utf-8", "replace"))
    result: list[FeedDocument] = []
    for row in parser.rows:
        match = WATER_ROW.search(row)
        if not match:
            continue
        published = parse_date(match.group("date"))
        district, address = match.group("district").strip(), match.group("address").strip()
        normalized = compact_text(f"{district}, {address}", 500)
        external_id = "water-" + hashlib.sha256((normalized.casefold() + "|" + (published or "")).encode()).hexdigest()[:24]
        result.append(FeedDocument(external_id, source_url + "#" + external_id,
            f"Отключение водоснабжения: {normalized}", published,
            f"Источник сообщает о работах по адресу: {normalized}. Начало работ: {match.group('date')}.", category="utilities"))
    return result


def parse_source(result: FetchResult, source: dict[str, Any]) -> list[FeedDocument]:
    adapter = source.get("adapter")
    if adapter == "rss":
        return parse_feed(result.body, source["url"])
    if adapter == "vodokanal-incidents":
        return parse_vodokanal_incidents(result.body, source["url"])
    raise ValueError(f"source adapter is not ingestible: {adapter}")


def hash_document(document: FeedDocument) -> str:
    normalized = json.dumps({"title": document.title, "body": document.body, "published_at": document.published_at,
        "url": document.url, "deleted": document.deleted}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(normalized.encode()).hexdigest()
