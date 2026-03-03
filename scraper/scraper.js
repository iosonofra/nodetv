const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

puppeteer.use(StealthPlugin());

const BASE_URL = "https://thisnot.business";
const EVENT_API = `${BASE_URL}/api/eventi.json`;
const PASSWORD = "2025";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";
const PLAYLIST_FILE = path.join(__dirname, "playlist.m3u");
const HISTORY_FILE = path.join(__dirname, "history.json");

async function scrape() {
    console.log("[*] Starting Node.js Scraper...");

    let browser;
    try {
        const launchOptions = {
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        };

        if (fs.existsSync(CHROMIUM_PATH)) {
            launchOptions.executablePath = CHROMIUM_PATH;
            console.log(`[*] Using Chromium at: ${CHROMIUM_PATH}`);
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

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
        }

        console.log("[*] Fetching event list...");
        await page.goto(EVENT_API, { waitUntil: 'networkidle2' });

        const jsonText = await page.evaluate(() => document.body.innerText);
        let data;
        try {
            data = JSON.parse(jsonText);
        } catch (e) {
            console.error(`[!] Error parsing events JSON: ${e.message}`);
            await browser.close();
            return;
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

            // Passive listeners (more robust on slow connections)
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
                // No request.continue() needed as interception is not enabled globally
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
                await new Promise(r => setTimeout(r, 10000)); // Increased to 10s

                // Check all frames again after interaction
                const checkFrames = async () => {
                    // Method 1: Check frame URLs (built-in)
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

                    // Method 2: Explicit DOM src inspection (matches Python's effectiveness)
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

                    if (mpdUrl) {
                        try {
                            const parsedUrl = new URL(mpdUrl.includes('#') ? mpdUrl.split('#')[0] : mpdUrl);
                            const ck = parsedUrl.searchParams.get('ck');
                            if (ck) ckParam = ck;

                            // If not found in main URL, check fragment (common in extension wrappers)
                            if (!ckParam && mpdUrl.includes('#')) {
                                const frag = mpdUrl.split('#')[1];
                                if (frag.includes('ck=')) {
                                    ckParam = frag.split('ck=')[1].split('&')[0];
                                }
                            }
                        } catch (err) { }
                    }
                };

                await checkFrames();

                // Interactive bypass
                await page.mouse.click(640, 360);
                await new Promise(r => setTimeout(r, 3000));
                await checkFrames();

                await page.mouse.click(640, 400);
                await new Promise(r => setTimeout(r, 5000));
                await checkFrames();

            } catch (err) {
                console.error(` [!] Error on ${playerUrl}: ${err.message}`);
            } finally {
                page.off('request', requestHandler);
                page.off('console', consoleHandler);
            }

            if (mpdUrl) {
                // Clean up chrome-extension prefix if present (matches Python version)
                if (mpdUrl.startsWith("chrome-extension://")) {
                    if (mpdUrl.includes("#")) {
                        console.log(`  [*] Cleaning extension wrapper: ${mpdUrl.split('#')[0]}`);
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
                        // Fix padding
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

                m3uLines.push(`#EXTINF:-1 tvg-logo="${logo}" group-title="${group}", ${name}`);
                if (keysStr) {
                    m3uLines.push(`#KODIPROP:inputstream.adaptive.license_type=clearkey`);
                    m3uLines.push(`#KODIPROP:inputstream.adaptive.license_key=${keysStr}`);
                }
                m3uLines.push(mpdUrl);
            } else {
                console.log(`  [-] No MPD link found for ${playerUrl}`);
            }
        }

        // Save Playlist
        if (m3uLines.length > 1) {
            fs.writeFileSync(PLAYLIST_FILE, m3uLines.join("\n"), 'utf8');
            console.log(`[*] Successfully saved playlist to: ${PLAYLIST_FILE}`);
        }

        // Save History
        const runData = {
            timestamp: new Date().toISOString().replace('T', ' ').split('.')[0],
            status: "Success",
            count: m3uLines.length > 1 ? Math.floor((m3uLines.length - 1) / 3) : 0,
            message: `Successfully generated with ${Math.floor((m3uLines.length - 1) / 3)} channels`
        };

        let history = [];
        if (fs.existsSync(HISTORY_FILE)) {
            try {
                history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            } catch (e) { }
        }
        history.unshift(runData);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 20), null, 4), 'utf8');

    } catch (err) {
        console.error(`[!] Critical Error: ${err.message}`);
        const runData = {
            timestamp: new Date().toISOString().replace('T', ' ').split('.')[0],
            status: "Error",
            count: 0,
            message: err.message
        };
        let history = [];
        if (fs.existsSync(HISTORY_FILE)) {
            try {
                history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            } catch (e) { }
        }
        history.unshift(runData);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 20), null, 4), 'utf8');
    } finally {
        if (browser) await browser.close();
    }
}

scrape();
