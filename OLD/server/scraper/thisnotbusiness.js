/**
 * thisnot.business event scraper
 * Ported from v1.0.0 to v2.1.1
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const BASE_URL = "https://thisnot.business";
const EVENT_API = `${BASE_URL}/api/eventi.json`;
const PASSWORD = "2025";

// Paths for output - adjust for v2.1.1 (executed from server/scraper/)
const DATA_DIR = path.join(__dirname, "../../data/scraper");
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PLAYLIST_FILE = path.join(DATA_DIR, "thisnotbusiness.m3u");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

// Optional custom Chromium path (useful for Linux/Docker)
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";

async function scrape() {
    const startTime = Date.now();
    const runType = process.env.SCRAPER_RUN_TYPE || 'manual';
    console.log(`[*] Starting thisnot.business Scraper (${runType})...`);

    let browser;
    try {
        const launchOptions = {
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        };

        if (fs.existsSync(CHROMIUM_PATH)) {
            launchOptions.executablePath = CHROMIUM_PATH;
            console.log(`[*] Using Chromium at: ${CHROMIUM_PATH}`);
        } else if (CHROMIUM_PATH === "/usr/bin/chromium-browser") {
            console.warn(`[!] Typical Alpine Chromium path (${CHROMIUM_PATH}) not found.`);
            console.warn(`    If you are on Alpine, please install chromium: 'apk add chromium'`);
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        // Use a realistic user agent
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");

        console.log(`[*] Logging in to ${BASE_URL}...`);
        await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

        const passwordInput = await page.$('input[name="password"]');
        if (passwordInput) {
            await page.type('input[name="password"]', PASSWORD);
            await Promise.all([
                page.click('button[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle2' })
            ]);
            console.log("[+] Login successful.");
        } else {
            console.log("[!] Login form not found (maybe already logged in?).");
        }

        console.log("[*] Fetching event list...");
        await page.goto(EVENT_API, { waitUntil: 'networkidle2' });

        const jsonText = await page.evaluate(() => document.body.innerText);
        let data;
        try {
            data = JSON.parse(jsonText);
        } catch (e) {
            console.error(`[!] Error parsing events JSON: ${e.message}`);
            // Save debug info
            fs.writeFileSync(path.join(DATA_DIR, "debug_json_error.html"), jsonText);
            await browser.close();
            process.exit(1);
        }

        const events = data.eventi || [];
        console.log(`[*] Found ${events.length} events.`);

        const m3uLines = ["#EXTM3U"];

        // Monitor script to catch URLs from JS (fetch/XHR)
        const MONITOR_SCRIPT = `
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
        `;

        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            if (!event.link) continue;

            let playerUrl = event.link;
            if (playerUrl.startsWith('/')) {
                playerUrl = BASE_URL + playerUrl;
            }

            const eventName = event.evento || 'Unknown';
            console.log(`[${i + 1}/${events.length}] Processing ${eventName} (${event.canale})...`);

            let mpdUrl = null;
            let ckParam = null;

            // Passive listeners
            const requestHandler = request => {
                const url = request.url();
                if ((url.includes('.mpd') || url.includes('.m3u8')) && !url.toLowerCase().includes('ad')) {
                    if (!mpdUrl) {
                        console.log(`  [+] Intercepted from request: ${url}`);
                        mpdUrl = url;

                        try {
                            const parsedUrl = new URL(url);
                            const ck = parsedUrl.searchParams.get('ck');
                            if (ck) ckParam = ck;
                        } catch (err) { }
                    }
                }
            };

            const consoleHandler = msg => {
                const text = msg.text();
                if (text.startsWith('INTERCEPT_URL:')) {
                    const url = text.replace('INTERCEPT_URL:', '');
                    if (!mpdUrl) {
                        console.log(`  [+] Intercepted from console: ${url}`);
                        mpdUrl = url;

                        try {
                            const parsedUrl = new URL(url);
                            const ck = parsedUrl.searchParams.get('ck');
                            if (ck) ckParam = ck;
                        } catch (err) { }
                    }
                }
            };

            page.on('request', requestHandler);
            page.on('console', consoleHandler);

            try {
                // Apply monitor script before navigation
                await page.evaluateOnNewDocument(MONITOR_SCRIPT);

                await page.goto(playerUrl, { waitUntil: 'load', timeout: 45000 });
                await new Promise(r => setTimeout(r, 10000)); // 10s wait for video to load

                // Check all frames
                const checkFrames = async () => {
                    for (const frame of page.frames()) {
                        try {
                            const src = frame.url();
                            if (src && (src.includes('.mpd') || src.includes('.m3u8')) && !mpdUrl) {
                                console.log(`  [+] Found manifest in frame URL: ${src}`);
                                mpdUrl = src;
                                break;
                            }
                        } catch (e) { }
                    }

                    if (!mpdUrl) {
                        try {
                            const iframeSrcs = await page.evaluate(() => {
                                return Array.from(document.querySelectorAll('iframe'))
                                    .map(f => f.getAttribute('src'))
                                    .filter(s => s);
                            });

                            for (let src of iframeSrcs) {
                                if (src.startsWith("//")) src = "https:" + src;
                                if ((src.includes('.mpd') || src.includes('.m3u8')) && !mpdUrl) {
                                    console.log(`  [+] Found manifest in iframe DOM src: ${src}`);
                                    mpdUrl = src;
                                    break;
                                }
                            }
                        } catch (e) { }
                    }
                };

                await checkFrames();

                // Interactive bypass (clicking in middle of player)
                if (!mpdUrl) {
                    await page.mouse.click(640, 360);
                    await new Promise(r => setTimeout(r, 3000));
                    await checkFrames();
                }

                if (!mpdUrl) {
                    await page.mouse.click(640, 400);
                    await new Promise(r => setTimeout(r, 5000));
                    await checkFrames();
                }

            } catch (err) {
                console.error(` [!] Error on ${playerUrl}: ${err.message}`);
            } finally {
                page.off('request', requestHandler);
                page.off('console', consoleHandler);
            }

            if (mpdUrl) {
                // If extension wrapper
                if (mpdUrl.startsWith("chrome-extension://")) {
                    if (mpdUrl.includes("#")) {
                        mpdUrl = mpdUrl.split("#")[1];
                    }
                }

                // Decode keys
                let keysStr = "";
                if (!ckParam && mpdUrl.includes("ck=")) {
                    try {
                        const parts = mpdUrl.split("ck=");
                        if (parts.length > 1) ckParam = parts[1].split("&")[0];
                    } catch (err) { }
                }

                if (ckParam) {
                    try {
                        let cleanCk = ckParam;
                        while (cleanCk.length % 4 !== 0) cleanCk += '=';

                        let decoded = Buffer.from(cleanCk, 'base64').toString('utf-8');
                        try {
                            const ckJson = JSON.parse(decoded);
                            if (ckJson.keys) {
                                keysStr = ckJson.keys.filter(k => k.kid && k.k).map(k => `${k.kid}:${k.k}`).join(",");
                            } else {
                                keysStr = Object.entries(ckJson).filter(([k, v]) => k.length > 10).map(([k, v]) => `${k}:${v}`).join(",");
                            }
                        } catch (e) {
                            if (decoded.includes(":")) keysStr = decoded;
                        }
                    } catch (e) {
                        console.error(`  [!] Error decoding keys: ${e.message}`);
                    }
                }

                const logo = event.logo || "";
                const group = event.competizione || "Events";
                const name = `${event.emoji || ''} ${event.competizione}: ${event.evento} (${event.orario}) - ${event.canale}`;

                m3uLines.push(`#EXTINF:-1 tvg-logo="${logo}" group-title="${group}" category-id="${group}", ${name}`);
                if (keysStr) {
                    m3uLines.push(`#KODIPROP:inputstream.adaptive.license_type=clearkey`);
                    m3uLines.push(`#KODIPROP:inputstream.adaptive.license_key=${keysStr}`);
                }
                m3uLines.push(mpdUrl);
                console.log(`  [v] Successfully added channel.`);
            } else {
                console.log(`  [-] No MPD link found for ${playerUrl}`);
            }
        }

        // Save Playlist (Always write file, even if empty, to trigger sync purge)
        fs.writeFileSync(PLAYLIST_FILE, m3uLines.join("\n"), 'utf8');
        if (m3uLines.length > 1) {
            console.log(`[*] Successfully saved playlist with ${m3uLines.length - 1} entries to: ${PLAYLIST_FILE}`);
        } else {
            console.log(`[*] Saved empty playlist to: ${PLAYLIST_FILE}`);
        }

        // Save History
        const duration = Math.floor((Date.now() - startTime) / 1000);
        let count = 0;
        for (const line of m3uLines) if (line.startsWith('#EXTINF')) count++;

        const runData = {
            timestamp: new Date().toISOString(),
            success: true,
            type: runType,
            duration: duration,
            channelsCount: count,
            message: `Generated ${count} channels.`
        };

        updateHistory(runData);

    } catch (err) {
        console.error(`[!] Critical Error: ${err.message}`);
        const duration = Math.floor((Date.now() - startTime) / 1000);
        updateHistory({
            timestamp: new Date().toISOString(),
            success: false,
            type: runType,
            duration: duration,
            channelsCount: 0,
            error: err.message
        });
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

function updateHistory(runData) {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch (e) { }
    }
    history.unshift(runData);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 20), null, 4), 'utf8');
}

scrape();
