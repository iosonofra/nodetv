import asyncio
import json
import base64
import os
from playwright.async_api import async_playwright
from playwright_stealth import Stealth

BASE_URL = "https://thisnot.business"
EVENT_API = f"{BASE_URL}/api/eventi.json"
PASSWORD = "2025"
CHROMIUM_PATH = os.getenv("CHROMIUM_PATH", "/usr/bin/chromium-browser")
PLAYLIST_FILE = os.path.join(os.path.dirname(__file__), "playlist.m3u")
HISTORY_FILE = os.path.join(os.path.dirname(__file__), "history.json")

async def scrape():
    async with async_playwright() as p:
        # Launch with system chromium if it exists, otherwise default
        launch_kwargs = {"headless": True}
        if os.path.exists(CHROMIUM_PATH):
            launch_kwargs["executable_path"] = CHROMIUM_PATH
            print(f"[*] Using Chromium at: {CHROMIUM_PATH}")
        
        browser = await p.chromium.launch(**launch_kwargs)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
        )
        page = await context.new_page()
        await Stealth().apply_stealth_async(page)

        print(f"[*] Logging in to {BASE_URL}...")
        await page.goto(BASE_URL)
        
        # Check if login is needed
        if await page.query_selector('input[name="password"]'):
            await page.fill('input[name="password"]', PASSWORD)
            await page.click('button[type="submit"]')
            await page.wait_for_load_state("networkidle")
        
        print("[*] Fetching event list...")
        await page.goto(EVENT_API)
        content = await page.content()
        # The page content might be wrapped in HTML tags if viewed in browser
        json_text = await page.evaluate("() => document.body.innerText")
        try:
            data = json.loads(json_text)
        except Exception as e:
            print(f"[!] Error parsing events JSON: {e}")
            await browser.close()
            return

        events = data.get("eventi", [])
        print(f"[*] Found {len(events)} events.")

        m3u_lines = ["#EXTM3U"]
        
        # Monitor script to catch URLs from JS (fetch/XHR)
        MONITOR_SCRIPT = """
        (function() {
            const originalFetch = window.fetch;
            window.fetch = function() {
                const url = arguments[0];
                if (typeof url === 'string' && (url.includes('.mpd') || url.includes('.m3u8'))) {
                    console.log('INTERCEPT_URL:' + url);
                }
                return originalFetch.apply(this, arguments);
            };
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function() {
                const url = arguments[1];
                if (typeof url === 'string' && (url.includes('.mpd') || url.includes('.m3u8'))) {
                    console.log('INTERCEPT_URL:' + url);
                }
                return originalOpen.apply(this, arguments);
            };
        })();
        """

        for i, event in enumerate(events):
            if not event.get("link"):
                continue
                
            player_url = event["link"]
            event_name = event.get('evento', 'Unknown')
            print(f"[{i+1}/{len(events)}] Processing {event_name} ({event['canale']})...")

            mpd_url = None
            ck_param = None
            
            try:
                # Capture all requests to find the manifest
                async def on_request(request):
                    nonlocal mpd_url, ck_param
                    url = request.url
                    if (".mpd" in url or ".m3u8" in url) and "ad" not in url.lower():
                        if not mpd_url:
                            print(f"  [+] Intercepted manifest URL: {url}")
                            mpd_url = url
                            # Check for ck param
                            from urllib.parse import urlparse, parse_qs
                            parsed = urlparse(url)
                            qs = parse_qs(parsed.query)
                            if "ck" in qs:
                                ck_param = qs["ck"][0]

                page.on("request", on_request)
                
                # Navigate to player page
                await page.goto(player_url, wait_until="load", timeout=45000)
                await asyncio.sleep(8) # Wait for scripts to run
                
                # Look for iframes
                iframes = await page.query_selector_all("iframe")
                for frame in iframes:
                    src = await frame.get_attribute("src")
                    if src:
                        if src.startswith("//"): src = "https:" + src
                        if (".mpd" in src or ".m3u8" in src) and not mpd_url:
                            print(f"  [+] Found manifest in iframe src: {src}")
                            mpd_url = src
                        elif "player" in src or "shaka" in src:
                            print(f"  [*] Found potential player iframe: {src}")
                
                # Interaction: multiple clicks in the player area to trigger load/bypass overlays
                # Click center and some offsets
                await page.mouse.click(640, 360) 
                await asyncio.sleep(2)
                await page.mouse.click(640, 400)
                await asyncio.sleep(5)
                
                # If still no MPD, check console logs for hidden URLs
                # The MONITOR_SCRIPT logs to console
                
                page.remove_listener("request", on_request)
            except Exception as e:
                print(f" [!] Error on {player_url}: {e}")
                try: page.remove_listener("request", on_request)
                except: pass

            if mpd_url:
                # Clean up chrome-extension prefix if present
                if mpd_url.startswith("chrome-extension://"):
                    if "#" in mpd_url:
                        mpd_url = mpd_url.split("#")[1]
                    else:
                        # Sometimes it might be in a param or just at the end
                        print(f"  [!] Possibly invalid manifest URL: {mpd_url}")

                print(f"  [+] Found manifest: {mpd_url}")
                
                # Extract keys from 'ck' parameter if present
                keys_str = ""
                # Try from the URL directly if we found it there
                if not ck_param and "ck=" in mpd_url:
                    try:
                        ck_param = mpd_url.split("ck=")[1].split("&")[0]
                    except: pass
                
                if ck_param:
                    try:
                        # Fix padding if needed
                        ck_param_clean = ck_param
                        ck_param_clean += "=" * ((4 - len(ck_param_clean) % 4) % 4)
                        decoded = base64.b64decode(ck_param_clean).decode('utf-8')
                        
                        try:
                            ck_json = json.loads(decoded)
                            # The JSON can be {"kid": "key", ...} or {"keys": [{"kid": "...", "k": "..."}]}
                            if isinstance(ck_json, dict):
                                if "keys" in ck_json:
                                    keys_str = ",".join([f"{k.get('kid')}:{k.get('k')}" for k in ck_json["keys"] if k.get("kid") and k.get("k")])
                                else:
                                    # Normal KID:KEY dict
                                    keys_str = ",".join([f"{k}:{v}" for k, v in ck_json.items() if len(k) > 10])
                        except json.JSONDecodeError:
                            if ":" in decoded:
                                keys_str = decoded
                    except Exception as e:
                        print(f"  [!] Error decoding keys: {e}")

                # Build M3U entry
                logo = event.get("logo", "")
                group = event.get("competizione", "Events")
                name = f"{event.get('emoji', '')} {event['competizione']}: {event['evento']} ({event['orario']}) - {event['canale']}"
                
                m3u_lines.append(f'#EXTINF:-1 tvg-logo="{logo}" group-title="{group}", {name}')
                if keys_str:
                    m3u_lines.append(f'#KODIPROP:inputstream.adaptive.license_type=clearkey')
                    m3u_lines.append(f'#KODIPROP:inputstream.adaptive.license_key={keys_str}')
                m3u_lines.append(mpd_url)
            else:
                print(f"  [-] No MPD link found for {player_url}")

        # Save Playlist File
        if len(m3u_lines) > 1:
            try:
                with open(PLAYLIST_FILE, "w", encoding="utf-8") as f:
                    f.write("\n".join(m3u_lines))
                print(f"[*] Successfully saved playlist to: {PLAYLIST_FILE}")
            except Exception as e:
                print(f"[!] Error saving playlist file: {e}")

        # Save history
        history_file = HISTORY_FILE
        import datetime
        
        run_data = {
            "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "status": "Success",
            "count": len(m3u_lines) // 3 if len(m3u_lines) > 1 else 0,
            "message": f"Successfully generated with {len(m3u_lines)//3} channels"
        }
        
        history = []
        if os.path.exists(history_file):
            try:
                with open(history_file, "r") as f:
                    history = json.load(f)
            except: pass
            
        history.insert(0, run_data)
        history = history[:20]  # Keep last 20 runs
        
        with open(history_file, "w") as f:
            json.dump(history, f, indent=4)

        print(f"[*] Playlist generated: playlist.m3u ({len(m3u_lines)//3} entries)")
        await browser.close()

if __name__ == "__main__":
    try:
        asyncio.run(scrape())
    except Exception as e:
        import datetime
        run_data = {
            "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "status": "Error",
            "count": 0,
            "message": str(e)
        }
        history_file = "history.json"
        history = []
        if os.path.exists(history_file):
            try:
                with open(history_file, "r") as f:
                    history = json.load(f)
            except: pass
        history.insert(0, run_data)
        with open(history_file, "w") as f:
            json.dump(history[:20], f, indent=4)
        print(f"[!] Critical Error: {e}")
