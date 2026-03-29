import os
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

import cloudscraper
from bs4 import BeautifulSoup


MAIN_URL = os.getenv("HATTRICKEVENTI_MAIN_URL", "https://htsport.cc/")
OUTPUT_FILE = os.getenv("HATTRICKEVENTI_OUTPUT", "hattrickeventi.m3u8")
IMAGE_URL = os.getenv(
    "HATTRICKEVENTI_LOGO",
    "https://i.postimg.cc/Kvwg9t3F/3790038-logo-vetrina-dazn-sport-dazn-a-11563364038i3yzrattgk-removebg-preview.png",
)
USER_AGENT = os.getenv(
    "HATTRICKEVENTI_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
)
REFERRER = os.getenv("HATTRICKEVENTI_REFERRER", "https://mediahosting.space/")
ORIGIN = os.getenv("HATTRICKEVENTI_ORIGIN", "https://mediahosting.space")
REQUEST_TIMEOUT = int(os.getenv("HATTRICKEVENTI_TIMEOUT", "15"))
REQUEST_DELAY = float(os.getenv("HATTRICKEVENTI_DELAY", "1.5"))
GROUP_TITLE = os.getenv("HATTRICKEVENTI_GROUP", "Eventi IPTV")


def build_scraper():
    session = cloudscraper.create_scraper(
        browser={
            "browser": "chrome",
            "platform": "windows",
            "mobile": False,
        }
    )
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Referer": REFERRER,
            "Origin": ORIGIN,
        }
    )
    return session


def fetch_main_page(session):
    response = session.get(MAIN_URL, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    return BeautifulSoup(response.text, "html.parser")


def extract_event_pages(soup):
    rows = soup.select(".events .row")
    print(f"[INFO] Event blocks found: {len(rows)}")

    events = []
    for row in rows:
        game_name_tag = row.select_one(".details .game-name")
        if not game_name_tag:
            continue

        event_name = game_name_tag.get_text(strip=True)
        if not event_name:
            continue

        normalized = event_name.lower()
        if "canali on line" in normalized or "canale on line" in normalized:
            print(f"[SKIP] Ignored section: {event_name}")
            continue

        for link in row.select('a[href$=".htm"]'):
            href = (link.get("href") or "").strip()
            if not href:
                continue
            event_url = urljoin(MAIN_URL, href)
            events.append((event_name, event_url))

    deduped = list(dict.fromkeys(events))
    print(f"[INFO] Event pages collected: {len(deduped)}")
    return deduped


def extract_stream_url(session, page_url):
    response = session.get(page_url, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()

    event_soup = BeautifulSoup(response.text, "html.parser")
    iframe = event_soup.find("iframe", id="iframe")
    if not iframe or not iframe.get("src"):
        iframe = event_soup.find(
            "iframe",
            attrs={"class": lambda value: value and "iframe" in str(value).lower()},
        )

    if not iframe or not iframe.get("src"):
        return None, "No iframe found"

    src = iframe["src"].strip()
    if "#" not in src:
        return None, "Iframe src has no stream fragment"

    stream_url = src.split("#", 1)[1].strip()
    if not stream_url.startswith(("http://", "https://")):
        return None, "Fragment is not an HTTP URL"

    return stream_url, None


def write_playlist(entries):
    output_path = Path(OUTPUT_FILE)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    lines = ["#EXTM3U", ""]
    for event_name, stream_url in entries:
        lines.append(
            f'#EXTINF:-1 tvg-id="" tvg-logo="{IMAGE_URL}" group-title="{GROUP_TITLE}",{event_name}'
        )
        lines.append(f"#EXTVLCOPT:http-user-agent={USER_AGENT}")
        lines.append(f"#EXTVLCOPT:http-referrer={REFERRER}")
        lines.append(f"#EXTVLCOPT:http-origin={ORIGIN}")
        lines.append(f"#EXTVLCOPT:http-header=Origin: {ORIGIN}")
        lines.append(stream_url)
        lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")
    return output_path


def main():
    print(f"[INFO] Starting Hattrick Eventi scraping from {MAIN_URL}")
    session = build_scraper()

    try:
        soup = fetch_main_page(session)
    except Exception as exc:
        print(f"[ERROR] Failed to load main page: {exc}")
        return 1

    event_pages = extract_event_pages(soup)
    playlist_entries = []

    for event_name, page_url in event_pages:
        print(f"[INFO] Processing {event_name} -> {page_url}")
        try:
            stream_url, error_message = extract_stream_url(session, page_url)
            if stream_url:
                playlist_entries.append((event_name, stream_url))
                print(f"[OK] Stream found: {stream_url[:120]}")
            else:
                print(f"[WARN] {error_message}")
        except Exception as exc:
            print(f"[ERROR] Failed on {page_url}: {str(exc)[:160]}")

        if REQUEST_DELAY > 0:
            time.sleep(REQUEST_DELAY)

    output_path = write_playlist(playlist_entries)
    print(f"[INFO] Playlist created: {output_path}")
    print(f"[INFO] Streams added: {len(playlist_entries)}")
    print(f"[INFO] Logo used: {IMAGE_URL}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
