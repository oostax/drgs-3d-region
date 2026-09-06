import sys
from pathlib import Path
import tempfile
import unittest

from fetch_public_data import NEWS_FEEDS, parse_news_feed, parse_news_article, discovered_news_signal, news_date

RSS = {"id": "fixture", "url": "https://example.gov/news/rss", "format": "rss", "name": "Официальный источник"}


def with_file(text, callback):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "fixture.xml"
        path.write_text(text)
        return callback(path)


class NewsTests(unittest.TestCase):
    def test_rss_has_explicit_date_and_rejects_external_article(self):
        xml = '<rss><channel><item><title>Открыт новый центр</title><link>https://example.gov/news/1</link><pubDate>Fri, 04 Sep 2026 09:00:00 +0300</pubDate></item><item><title>Чужой адрес</title><link>https://other.example/news/2</link><pubDate>2026-09-04</pubDate></item></channel></rss>'
        items = with_file(xml, lambda p: parse_news_feed(p, RSS))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["publishedAt"], "2026-09-04")

    def test_atom_updated_never_substitutes_for_published(self):
        xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Старый проект</title><link href="https://example.gov/news/1"/><updated>2026-09-04T00:00:00Z</updated></entry></feed>'
        self.assertEqual(with_file(xml, lambda p: parse_news_feed(p, RSS)), [])

    def test_dtd_rejected(self):
        self.assertEqual(with_file('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', lambda p: parse_news_feed(p, RSS)), [])

    def test_innopolis_title_does_not_include_date_and_whole_description(self):
        source = next(s for s in NEWS_FEEDS if s["id"] == "news-feed-innopolis")
        html = '<div><a class="news-page__all-news__news-bottom" href="/news/test/"><p class="news-page__all-news__news-bottom-date">04.09.2026</p><h3>Премия по роботизации</h3><p class="news-page__all-news__news-bottom-text">Программа до 2027 года.</p></a><a href="/news/other/">Другая публикация</a></div>'
        items = with_file(html, lambda p: parse_news_feed(p, source))
        self.assertEqual(items[0]["title"], "Премия по роботизации")
        self.assertEqual(items[0]["publishedAt"], "2026-09-04")

    def test_article_modified_date_and_web_site_date_ignored(self):
        html = '<h1>Материал</h1><meta property="article:modified_time" content="2026-09-04"><script type="application/ld+json">{"@type":"WebSite","datePublished":"2026-09-04"}</script>'
        result = with_file(html, lambda p: parse_news_article(p, "Материал"))
        self.assertTrue(result["identityVerified"])
        self.assertIsNone(result["publishedAt"])

    def test_article_date_published_and_identity(self):
        html = '<h1>Материал</h1><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-09-01"}</script>'
        self.assertEqual(with_file(html, lambda p: parse_news_article(p, "Материал"))["publishedAt"], "2026-09-01")
        self.assertIsNone(with_file(html, lambda p: parse_news_article(p, "Иной заголовок")))

    def test_article_identity_via_open_graph_and_date_ignores_latest_news_sidebar(self):
        html = '<meta property="og:title" content="Соглашение с университетом"><div class="newsItem-date">04.09.2026</div><div class="newsCart-date">Дата публикации: 03.09.2026</div>'
        result = with_file(html, lambda p: parse_news_article(p, "Соглашение с университетом"))
        self.assertEqual(result["publishedAt"], "2026-09-03")

    def test_school_news_is_not_inferred_to_be_building_construction(self):
        item = {"title": "Университет подготовил школьников к олимпиадам", "excerpt": "", "sourceUrl": "https://example.gov/news/1", "publishedAt": "2026-09-01"}
        signal = discovered_news_signal(item, RSS, "2026-09-04", [])
        self.assertEqual(signal["category"], "education")
        self.assertFalse(signal["lifecycle"]["currentStatusVerified"])
        self.assertIsNone(signal["coordinates"])

    def test_invalid_date_or_title_year_cannot_be_a_publication_date(self):
        self.assertIsNone(news_date("31.02.2026"))
        self.assertIsNone(news_date("Планы на 2026 год"))


if __name__ == "__main__":
    unittest.main()
