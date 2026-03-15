/**
 * DLStreams URL Resolver
 * Shared module for extracting fresh stream URLs from DLStreams watch pages.
 * Used by both the scraper (bulk) and the on-demand resolver (single channel).
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const BASE_URL = "https://dlstreams.top";

// Optional custom Chromium path (useful for Linux/Docker)
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";

// Paths for persistent cache - use absolute path from project root
const ROOT_DIR = path.resolve(__dirname, "../../");
const DATA_DIR = path.join(ROOT_DIR, "data", "scraper");
const URL_CACHE_FILE = path.join(DATA_DIR, "url_cache.json");

// In-memory cache for resolved URLs (channelId -> { streamUrl, ckParam, timestamp })
let urlCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Cache for failures (channelId -> { timestamp, error })
const failureCache = new Map();
const FAILURE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Load cache from file
 */
function loadUrlCache() {
    console.log(`[DLStreams Resolver] Checking for cache at: ${URL_CACHE_FILE}`);
    if (fs.existsSync(URL_CACHE_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(URL_CACHE_FILE, 'utf8'));
            urlCache = new Map(Object.entries(data));
            console.log(`[DLStreams Resolver] Loaded ${urlCache.size} entries from persistent cache.`);
        } catch (e) {
            console.error(`[DLStreams Resolver] Error loading URL cache: ${e.message}`);
            urlCache = new Map();
        }
    } else {
        console.log(`[DLStreams Resolver] No persistent cache found.`);
    }
}

/**
 * Save cache to file
 */
function saveUrlCache() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const data = Object.fromEntries(urlCache);
        fs.writeFileSync(URL_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error(`[DLStreams Resolver] Error saving URL cache: ${e.message}`);
    }
}

// Initial load
loadUrlCache();

// Shared browser instance for reuse
let sharedBrowser = null;
let browserClosingTimer = null;
const BROWSER_IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Get or launch shared browser
 */
async function getSharedBrowser() {
    if (browserClosingTimer) {
        clearTimeout(browserClosingTimer);
        browserClosingTimer = null;
    }

    if (!sharedBrowser) {
        console.log('[DLStreams Resolver] Launching shared browser instance...');
        sharedBrowser = await puppeteer.launch(getLaunchOptions());
        sharedBrowser.on('disconnected', () => {
            console.log('[DLStreams Resolver] Shared browser disconnected.');
            sharedBrowser = null;
        });
    }

    browserClosingTimer = setTimeout(async () => {
        if (sharedBrowser) {
            console.log('[DLStreams Resolver] Shared browser idle timeout reached. Closing...');
            const b = sharedBrowser;
            sharedBrowser = null;
            await b.close().catch(() => {});
        }
    }, BROWSER_IDLE_TIMEOUT_MS);

    return sharedBrowser;
}

/**
 * Get Puppeteer launch options
 */
function getLaunchOptions() {
    const opts = {
        headless: "new",
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-renderer-backgrounding',
            '--disable-features=CalculateNativeWinOcclusion,PauseBackgroundTabs',
            '--disable-gpu',
            '--hide-scrollbars',
            '--mute-audio'
        ]
    };
    if (fs.existsSync(CHROMIUM_PATH)) {
        opts.executablePath = CHROMIUM_PATH;
    }
    return opts;
}

/**
 * Visit a player page and intercept stream URL (m3u8/mpd)
 */
async function extractStreamUrl(page, channelId) {
    // 1. Check cache first
    const cached = urlCache.get(channelId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        console.log(`  [*] Cache hit for channel ${channelId}`);
        return { streamUrl: cached.streamUrl, ckParam: cached.ckParam, cached: true };
    }

    // 2. Check failure cache
    const failure = failureCache.get(channelId);
    if (failure && (Date.now() - failure.timestamp) < FAILURE_TTL_MS) {
        console.log(`  [*] Skipping channel ${channelId} due to recent failure.`);
        return { streamUrl: null, ckParam: null, cached: false };
    }

    const playerUrl = channelId.startsWith('http') ? channelId : `${BASE_URL}/watch.php?id=${channelId}`;
    let streamUrl = null;
    let ckParam = null;

    try {
        // Intercept network requests
        await page.setRequestInterception(true);
        const requestHandler = req => {
            const url = req.url();
            const type = req.resourceType();

            if (!streamUrl && !url.includes('s3.dualstack') && (url.includes('.mpd') || url.includes('.m3u8') || url.includes('mono.css') || url.includes('mono.csv'))) {
                console.log(`  [+] Intercepted: ${url}`);
                streamUrl = url;
                if (url.includes('ck=')) {
                    try {
                        const parts = url.split('ck=');
                        if (parts.length > 1) ckParam = parts[1].split('&')[0];
                    } catch (e) { }
                }
            }

            if (url.includes('google-analytics') || url.includes('doubleclick') || url.includes('adsbygoogle') ||
                url.includes('popads') || url.includes('onclickads') || url.includes('trafficjunky') || 
                url.includes('histats') || url.includes('yandex.ru') || url.includes('adsystem') || 
                url.includes('chatango') || url.includes('disqus') || 
                ['image', 'font', 'stylesheet'].includes(type)) {
                return req.abort().catch(() => {});
            }
            req.continue().catch(() => {});
        };
        page.on('request', requestHandler);

        // Monitor console for script interception
        const consoleHandler = msg => {
            const text = msg.text();
            if (text.startsWith('INTERCEPT_URL:')) {
                const url = text.replace('INTERCEPT_URL:', '');
                if (!streamUrl) {
                    console.log(`  [+] Intercepted from console: ${url}`);
                    streamUrl = url;
                }
            }
        };
        page.on('console', consoleHandler);

        const MONITOR_SCRIPT = `
        (function() {
            const originalFetch = window.fetch;
            window.fetch = function() {
                const url = arguments[0];
                if (typeof url === 'string' && !url.includes('s3.dualstack') && (url.includes('.mpd') || url.includes('.m3u8') || url.includes('mono.css') || url.includes('mono.csv'))) {
                    console.log('INTERCEPT_URL:' + url);
                }
                return originalFetch.apply(this, arguments);
            };
        })();
        `;
        await page.evaluateOnNewDocument(MONITOR_SCRIPT);

        console.log(`  [*] Resolving ${playerUrl}...`);
        const navPromise = page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
            console.log(`  [!] Nav error (${channelId}): ${e.message}`);
        });

        const checkFrames = async () => {
            if (streamUrl) return;
            const frames = page.frames();
            for (const frame of frames) {
                try {
                    const src = frame.url();
                    if (src && !src.includes('about:blank') && !src.includes('s3.dualstack') && 
                        (src.includes('.mpd') || src.includes('.m3u8') || src.includes('mono.css'))) {
                        streamUrl = src;
                        break;
                    }
                } catch (e) {}
            }
        };

        // 1. Wait for navigation
        try {
            await page.goto(targetUrl, { 
                waitUntil: 'networkidle2', // More robust for slower environments
                timeout: 40000 
            });
        } catch (err) {
            if (!streamUrl) console.log(`  [!] Navigation warning: ${err.message}`);
        }

        // 2. Polling loop with enhanced detection
        let poll = 0;
        let rateLimitWait = false;
        
        while (!streamUrl && poll < 40) { // Increased poll count
            // Check for 429 or 404
            const pageState = await page.evaluate(() => {
                const text = document.body.innerText;
                if (text.includes('429 Too Many Requests')) return '429';
                if (text.includes('404 Page Not Found')) return '404';
                return 'ok';
            }).catch(() => 'error');

            if (pageState === '429' && !rateLimitWait) {
                console.log('  [!] Rate limited (429). Waiting 15s...');
                rateLimitWait = true;
                await new Promise(r => setTimeout(r, 15000));
                await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
                continue;
            }

            if (pageState === '404') {
                console.log('  [!] Channel not found (404)');
                break;
            }

            // Check if player iframe is present and try to get source
            const frameSrc = await page.evaluate(() => {
                const ifr = document.querySelector('iframe[src*="stream-"]');
                return ifr ? ifr.src : null;
            }).catch(() => null);

            if (frameSrc && !streamUrl) {
                // If we found the stream iframe but no URL yet, maybe it's in a script inside that frame
                // We'll let the interceptor catch it, but we can also try to look for it
            }

            await checkFrames();
            if (streamUrl) break;

            await new Promise(r => setTimeout(r, 1000));
            poll++;

            // Click interaction to trigger potential hidden loads
            if (poll === 10) {
                try {
                    const dimensions = await page.evaluate(() => ({
                        width: window.innerWidth,
                        height: window.innerHeight
                    }));
                    await page.mouse.click(dimensions.width / 2, dimensions.height / 2).catch(() => {});
                } catch(e) {}
            }
        }
        // 3. Diagnostic dump on failure
        if (!streamUrl) {
            const diagPath = path.join(DATA_DIR, `fail_${channelId}.html`);
            try {
                const html = await page.content();
                fs.writeFileSync(diagPath, html, 'utf8');
                console.log(`  [!] Diagnostic HTML dumped to ${diagPath}`);
            } catch (diagErr) { }
        }

        // 4. Cache result or failure
        page.off('request', requestHandler);
        page.off('console', consoleHandler);

        // 3. Cache result or failure
        if (streamUrl) {
            urlCache.set(channelId, { streamUrl, ckParam, timestamp: Date.now() });
            saveUrlCache();
        } else {
            failureCache.set(channelId, { timestamp: Date.now(), error: "Timeout" });
        }

    } catch (err) {
        console.error(` [!] Error: ${err.message}`);
        failureCache.set(channelId, { timestamp: Date.now(), error: err.message });
    }

    return { streamUrl, ckParam };
}

/**
 * Resolve a single channel URL on-demand (delegates to extractStreamUrl)
 */
async function resolveChannelUrl(channelId) {
    console.log(`[DLStreams Resolver] Resolving channel ${channelId}...`);
    let browser;
    try {
        browser = await getSharedBrowser();
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
        
        const result = await extractStreamUrl(page, channelId);

        if (result.streamUrl && result.streamUrl.startsWith("chrome-extension://")) {
            if (result.streamUrl.includes("#")) result.streamUrl = result.streamUrl.split("#")[1];
        }

        console.log(`[DLStreams Resolver] Channel ${channelId}: ${result.streamUrl ? 'OK' : 'FAIL'} ${result.cached ? '[CACHED]' : ''}`);
        await page.close().catch(() => {});
        return result;
    } catch (err) {
        console.error(`[DLStreams Resolver] Error: ${err.message}`);
        return { streamUrl: null, ckParam: null, cached: false, error: err.message };
    }
}

/**
 * Decode ClearKey parameter
 */
function decodeClearKey(ckParam) {
    if (!ckParam) return '';
    try {
        let cleanCk = ckParam;
        while (cleanCk.length % 4 !== 0) cleanCk += '=';
        let decoded = Buffer.from(cleanCk, 'base64').toString('utf-8');
        try {
            const ckJson = JSON.parse(decoded);
            if (ckJson.keys) {
                return ckJson.keys.filter(k => k.kid && k.k).map(k => `${k.kid}:${k.k}`).join(",");
            }
            return Object.entries(ckJson).filter(([k]) => k.length > 10).map(([k, v]) => `${k}:${v}`).join(",");
        } catch (e) {
            if (decoded.includes(":")) return decoded;
        }
    } catch (e) {
        console.error(`[DLStreams Resolver] Error decoding: ${e.message}`);
    }
    return '';
}

/**
 * Fetch categories
 */
async function fetchCategories() {
    console.log('[DLStreams Resolver] Fetching categories...');
    let browser;
    try {
        browser = await getSharedBrowser();
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
        await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        const categories = await page.evaluate(() => {
            const results = [];
            const links = document.querySelectorAll('a[href*="index.php?cat="]');
            const seen = new Set();
            for (const link of links) {
                const href = link.getAttribute('href');
                const match = href.match(/[?&]cat=([^&]+)/);
                if (match) {
                    const slug = decodeURIComponent(match[1].replace(/\+/g, ' '));
                    if (!seen.has(slug) && slug !== 'All' && slug !== 'Upcoming Events') {
                        seen.add(slug);
                        results.push({ name: link.textContent.trim(), slug });
                    }
                }
            }
            return results;
        });

        console.log(`[DLStreams Resolver] Found ${categories.length} categories.`);
        await page.close().catch(() => {});
        return categories;
    } catch (err) {
        console.error(`[DLStreams Resolver] Error: ${err.message}`);
        return [];
    }
}

module.exports = {
    extractStreamUrl,
    resolveChannelUrl,
    decodeClearKey,
    fetchCategories,
    getLaunchOptions,
    BASE_URL,
    CHROMIUM_PATH
};
