import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

try:
    import cloudscraper
except Exception:
    cloudscraper = None


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
REQUEST_TIMEOUT = int(os.getenv("HATTRICKEVENTI_TIMEOUT", "15") or "15")
REQUEST_DELAY = float(os.getenv("HATTRICKEVENTI_DELAY", "1.5") or "1.5")
GROUP_TITLE = os.getenv("HATTRICKEVENTI_GROUP", "Eventi IPTV")


def build_scraper():
    if cloudscraper is not None:
        try:
            session = cloudscraper.create_scraper(
                browser={
                    "browser": "chrome",
                    "platform": "windows",
                    "mobile": False,
                }
            )
            print("[INFO] HTTP client: cloudscraper")
        except Exception as exc:
            print(f"[WARN] cloudscraper unavailable ({exc}), falling back to requests")
            session = requests.Session()
    else:
        print("[WARN] cloudscraper not installed, falling back to requests")
        session = requests.Session()

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


def _is_cloudflare_challenge(response):
    """Return True if the response looks like a Cloudflare JS/IUAM challenge page."""
    ct = response.headers.get("Content-Type", "")
    if "text/html" not in ct:
        return False
    body = response.text
    return (
        "cf-browser-verification" in body
        or "challenge-form" in body
        or "<title>Just a moment" in body
        or "cf_clearance" in body
        or (response.headers.get("cf-ray") and len(body) < 10_000 and "iframe" not in body.lower())
    )


def _unescape_url(url: str) -> str:
    """Unescape JS-encoded slashes like \\/ → /"""
    return url.replace("\\/", "/")


def _extract_stream_from_source(raw_html):
    """Regex-based last-resort scan for streaming URLs embedded in the page source."""
    # Pattern: iframe src containing a stream URL as fragment, e.g. src="player.php#https://..."
    m = re.search(
        r'<iframe[^>]+src=["\']([^"\']*#https?://[^"\']+)["\']',
        raw_html,
        re.IGNORECASE,
    )
    if m:
        fragment = m.group(1).split("#", 1)[1].strip()
        if fragment.startswith(("http://", "https://")):
            return fragment, None

    # Pattern: JS player config with file/source/url key pointing to stream
    # Handles both normal slashes and JS-escaped \/ slashes
    m = re.search(
        r'(?:file|source|src|url|streamUrl|hlsUrl)\s*[=:]\s*["\']'
        r'(https?:(?:\\/|/)[^"\']+\.(?:m3u8|mpd|ts)(?:[^"\']*)?)["\']',
        raw_html,
        re.IGNORECASE,
    )
    if m:
        return _unescape_url(m.group(1)), None

    # Pattern: bare https streaming URL in source (m3u8/mpd only, to avoid false positives)
    m = re.search(
        r'"(https?://[^"]+\.(?:m3u8|mpd)(?:\?[^"]*)?)"',
        raw_html,
        re.IGNORECASE,
    )
    if m:
        return m.group(1), None

    return None, None


def _follow_iframe_src(session, iframe_url: str, referer: str = None, depth: int = 0):
    """Follow an iframe src URL up to 3 levels deep to find a stream URL."""
    if depth > 3:
        return None, "Max iframe chain depth exceeded"
    try:
        headers = {}
        if referer:
            headers["Referer"] = referer
        resp = session.get(iframe_url, timeout=REQUEST_TIMEOUT, headers=headers)
        resp.raise_for_status()
    except Exception as exc:
        return None, f"Failed to fetch iframe URL: {exc}"

    # Try regex scan on this page
    stream_url, _ = _extract_stream_from_source(resp.text)
    if stream_url:
        return stream_url, None

    # Try nested iframe
    inner_soup = BeautifulSoup(resp.text, "html.parser")
    inner_iframe = inner_soup.find("iframe")
    if inner_iframe and inner_iframe.get("src"):
        inner_src = inner_iframe["src"].strip()
        if inner_src.startswith(("http://", "https://")):
            return _follow_iframe_src(session, inner_src, referer=iframe_url, depth=depth + 1)

    return None, f"No stream found following iframe chain from {iframe_url[:80]}"


def extract_stream_url(session, page_url):
    response = session.get(page_url, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()

    cf_ray = response.headers.get("cf-ray", "")
    if cf_ray:
        cf_note = f" (cf-ray: {cf_ray})"
    else:
        cf_note = ""

    if _is_cloudflare_challenge(response):
        return (
            None,
            f"Cloudflare challenge page received{cf_note} — install/update cloudscraper to bypass",
        )

    raw_html = response.text
    event_soup = BeautifulSoup(raw_html, "html.parser")
    iframe = event_soup.find("iframe", id="iframe")
    if not iframe or not iframe.get("src"):
        iframe = event_soup.find(
            "iframe",
            attrs={"class": lambda value: value and "iframe" in str(value).lower()},
        )

    if iframe and iframe.get("src"):
        src = iframe["src"].strip()
        if "#" in src:
            stream_url = src.split("#", 1)[1].strip()
            if stream_url.startswith(("http://", "https://")):
                return stream_url, None
            return None, "Iframe fragment is not an HTTP URL"
        # iframe found but no fragment — try regex on its src directly
        if src.startswith(("http://", "https://")):
            if any(ext in src for ext in (".m3u8", ".mpd")):
                return src, None
            # Follow iframe chain (handles redirect-wrappers like popcdn.day/go.php)
            print(f"[INFO] Following iframe chain: {src[:80]}")
            chain_url, chain_err = _follow_iframe_src(session, src, referer=page_url)
            if chain_url:
                return chain_url, None
            print(f"[WARN] Iframe chain: {chain_err}")
        return None, f"Iframe src has no stream fragment: {src[:120]}"

    # No static iframe — try regex scan of the full source
    stream_url, _ = _extract_stream_from_source(raw_html)
    if stream_url:
        print(f"[INFO] Stream found via regex scan (JS-embedded)")
        return stream_url, None

    # Last resort: headless browser with network interception
    print(f"[INFO] Static parse failed — launching headless browser for {page_url}")
    stream_url, pw_error = _extract_via_puppeteer(page_url)
    if stream_url:
        print(f"[INFO] Stream found via headless browser")
        return stream_url, None
    print(f"[WARN] Puppeteer fallback: {pw_error}")

    page_title = ""
    title_tag = event_soup.find("title")
    if title_tag:
        page_title = f" (page title: {title_tag.get_text(strip=True)[:60]})"
    return (
        None,
        f"No iframe or stream URL found{cf_note}{page_title}",
    )


# ---------------------------------------------------------------------------
# Puppeteer headless-browser fallback (Node.js, already installed)
# ---------------------------------------------------------------------------

_HELPER_SCRIPT = Path(__file__).parent / "scraper" / "hattrick_intercept.js"


def _extract_via_puppeteer(page_url: str) -> "tuple[str | None, str | None]":
    """Spawn the Node.js Puppeteer helper and capture the intercepted stream URL."""
    if not _HELPER_SCRIPT.exists():
        return None, f"Puppeteer helper not found at {_HELPER_SCRIPT}"

    node_bin = os.getenv("NODE_BIN", "node")
    timeout = REQUEST_TIMEOUT + 15
    try:
        result = subprocess.run(
            [node_bin, str(_HELPER_SCRIPT), page_url],
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ,
                 "HATTRICKEVENTI_USER_AGENT": USER_AGENT,
                 "HATTRICKEVENTI_REFERRER": REFERRER,
                 "HATTRICKEVENTI_TIMEOUT": str(REQUEST_TIMEOUT)},
        )
    except FileNotFoundError:
        return None, "'node' not found in PATH — set NODE_BIN env var if needed"
    except subprocess.TimeoutExpired:
        return None, f"Puppeteer helper timed out after {timeout}s"
    except Exception as exc:
        return None, f"Puppeteer helper error: {exc}"

    stdout = (result.stdout or "").strip()
    if not stdout:
        stderr = (result.stderr or "").strip()[:200]
        return None, f"Puppeteer helper produced no output. stderr: {stderr}"

    try:
        # Take the last JSON line (Node may print warnings before it)
        last_line = stdout.splitlines()[-1]
        data = json.loads(last_line)
    except json.JSONDecodeError:
        return None, f"Puppeteer helper output not JSON: {stdout[:200]}"

    if "stream" in data:
        return data["stream"], None
    return None, data.get("error", "Unknown error from Puppeteer helper")


# ---------------------------------------------------------------------------

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

    if len(playlist_entries) == 0:
        if cloudscraper is None:
            print("[WARN] No streams found. cloudscraper is NOT installed — Cloudflare-protected pages")
            print("[WARN] cannot be bypassed. Run: pip install cloudscraper")
        else:
            print("[WARN] No streams found. The page structure may have changed or no events are live.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
