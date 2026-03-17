/**
 * DLStreams URL Resolver
 * Shared module for extracting fresh stream URLs from DLStreams watch pages.
 * Used by both the scraper (bulk) and the on-demand resolver (single channel).
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const fetch = require('node-fetch');

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const BASE_URL = "https://dlstreams.top";

// Optional custom Chromium path (useful for Linux/Docker)
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";

// Paths for persistent cache - use absolute path from project root
const ROOT_DIR = path.resolve(__dirname, "../../");
const DATA_DIR = path.join(ROOT_DIR, "data", "scraper");
const URL_CACHE_FILE = path.join(DATA_DIR, "url_cache.json");
const CACHE_VALIDATE_TIMEOUT_MS = 10000;
const globalHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const globalHttpAgent = new http.Agent();

// In-memory cache for resolved URLs (channelId -> { streamUrl, ckParam, timestamp })
let urlCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Returns true only for genuine stream URLs.
 * Strips URL fragments (#...) first to avoid false positives like
 * https://ad-tracker.com/script.js#.m3u8 matching as a stream.
 * Only accepts .m3u8/.mpd directly; .css/.csv only when path ends in mono.css/mono.csv.
 */
function isValidStreamUrl(url) {
    if (!url) return false;
    const clean = url.split('#')[0]; // strip fragment
    return /\.(m3u8|mpd)(\?|$)/i.test(clean) ||
           /\/mono\.(css|csv)(\?|$)/i.test(clean);
}

function sanitizeProxyHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null;
    const allowed = new Set([
        'user-agent',
        'origin',
        'referer',
        'cookie',
        'accept',
        'accept-language'
    ]);
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!k || !allowed.has(String(k).toLowerCase())) continue;
        if (v == null) continue;
        const sv = String(v).trim();
        if (!sv) continue;
        out[k] = sv;
    }
    return Object.keys(out).length > 0 ? out : null;
}

async function validateStreamUrlFast(url) {
    if (!isValidStreamUrl(url)) return false;
    const cleanUrl = url.split('#')[0];

    const profiles = [
        {},
        { Origin: BASE_URL, Referer: `${BASE_URL}/` }
    ];

    for (const profile of profiles) {
        try {
            const response = await fetch(cleanUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    ...profile
                },
                agent: cleanUrl.startsWith('https://') ? globalHttpsAgent : globalHttpAgent,
                timeout: CACHE_VALIDATE_TIMEOUT_MS
            });

            if (!response.ok) {
                continue;
            }

            const body = await response.text();
            const trimmed = body.trimStart();
            if (trimmed.startsWith('#EXTM3U')) return true;
            if (trimmed.startsWith('<?xml') || trimmed.startsWith('<MPD')) return true;
        } catch (_) {
            // try next profile
        }
    }

    return false;
}

// Wrapper/player endpoints used by DLStreams pages before the final media URL appears.
// Supports legacy forms like /stream-123.php and newer forms like /stream/stream-123.php.
const STREAM_WRAPPER_REGEX = /\/(?:stream|cast|watch|plus|casting|player)\/stream-\d+\.php|\/stream(?:-|\.)\d*\.php|\/stream\.php|\/watch\.php\?id=/i;
const NOISY_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'websocket', 'eventsource', 'manifest', 'texttrack']);
const NOISY_URL_PATTERNS = [
    'google-analytics',
    'googletagmanager',
    'googlesyndication',
    'doubleclick',
    'adsbygoogle',
    'adsco.re',
    'popads',
    'onclickads',
    'trafficjunky',
    'histats',
    'yandex.ru',
    'adsystem',
    'chatango',
    'disqus',
    'font-awesome',
    'fonts.googleapis',
    'fonts.gstatic',
    'gstatic.com/recaptcha',
    'xadsmart.com'
];

function shouldAbortNoisyRequest(url, resourceType) {
    if (!url) return false;
    if (!isValidStreamUrl(url) && NOISY_RESOURCE_TYPES.has(resourceType)) {
        return true;
    }
    return NOISY_URL_PATTERNS.some(pattern => url.includes(pattern));
}

function findStreamUrlInText(text) {
    if (!text) return null;
    // Prefer direct .m3u8 / .mpd links
    const mediaMaybe = text.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\.(?:m3u8|mpd)(?:\?[\w\-.:@%?&=\/\+~]*)?/i);
    if (mediaMaybe) return mediaMaybe[0];
    // Fallback: DLStreams-specific mono.css / mono.csv disguised streams
    const monoMaybe = text.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\/mono\.(?:css|csv)(?:\?[\w\-.:@%?&=\/\+~]*)?/i);
    if (monoMaybe) return monoMaybe[0];
    return null;
}

function findWrapperUrlInText(text) {
    if (!text) return null;
    const wrapperMaybe = text.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\/(?:stream|cast|watch|plus|casting|player)\/stream-\d+\.php(?:\?[\w\-.:@%?&=\/\+~]*)?/i);
    if (wrapperMaybe) return wrapperMaybe[0];
    const watchMaybe = text.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\/watch\.php\?id=\d+(?:[\w\-.:@%?&=\/\+~]*)?/i);
    if (watchMaybe) return watchMaybe[0];
    return null;
}

function buildWrapperCandidates(wrapperUrl) {
    if (!wrapperUrl || !STREAM_WRAPPER_REGEX.test(wrapperUrl)) return [];
    const variants = ['stream', 'cast', 'watch', 'plus', 'casting', 'player'];
    const set = new Set([wrapperUrl]);

    const m = wrapperUrl.match(/\/(stream|cast|watch|plus|casting|player)\/(stream-\d+\.php(?:\?[\w\-.:@%?&=\/\+~]*)?)/i);
    if (m) {
        for (const v of variants) {
            set.add(wrapperUrl.replace(/\/(stream|cast|watch|plus|casting|player)\/(stream-\d+\.php(?:\?[\w\-.:@%?&=\/\+~]*)?)/i, `/${v}/${m[2]}`));
        }
    }

    return Array.from(set);
}

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

async function resolveRedirectedStreamUrl(page, candidateUrl, visited = new Set()) {
    if (!candidateUrl || visited.has(candidateUrl) || visited.size > 6) {
        return null;
    }
    visited.add(candidateUrl);

    if (isValidStreamUrl(candidateUrl)) {
        return candidateUrl;
    }

    if (!STREAM_WRAPPER_REGEX.test(candidateUrl)) {
        return null;
    }

    let resultUrl = null;
    const fallbackUrl = candidateUrl;

    await page.setRequestInterception(true);
    const requestHandler = req => {
        const url = req.url();
        const type = req.resourceType();

        if (!resultUrl && !url.includes('s3.dualstack') && isValidStreamUrl(url)) {
            resultUrl = url;
        }

        if (shouldAbortNoisyRequest(url, type)) {
            return req.abort().catch(() => {});
        }
        req.continue().catch(() => {});
    };

    const consoleHandler = msg => {
        const text = msg.text();
        if (!resultUrl && text.startsWith('INTERCEPT_URL:')) {
            resultUrl = text.replace('INTERCEPT_URL:', '');
        }
    };

    page.on('request', requestHandler);
    page.on('console', consoleHandler);
    try {
        await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

        if (!resultUrl) {
            try {
                const content = await page.content();
                resultUrl = findStreamUrlInText(content);
            } catch (e) {}
        }

        if (resultUrl && STREAM_WRAPPER_REGEX.test(resultUrl)) {
            const nested = await resolveRedirectedStreamUrl(page, resultUrl, visited);
            if (nested) resultUrl = nested;
        }
    } catch (_) {
        // ignore
    } finally {
        page.off('request', requestHandler);
        page.off('console', consoleHandler);
        await page.setRequestInterception(false).catch(() => {});
    }

    return resultUrl;
}

/**
 * Visit a player page and intercept stream URL (m3u8/mpd)
 */
async function extractStreamUrl(page, channelId, options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const validateCache = options.validateCache === true;
    // 1. Check cache first
    const cached = urlCache.get(channelId);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        if (isValidStreamUrl(cached.streamUrl)) {
            if (validateCache) {
                const isAlive = await validateStreamUrlFast(cached.streamUrl);
                if (!isAlive) {
                    console.log(`  [*] Cache URL validation failed for channel ${channelId}; forcing fresh resolve.`);
                    urlCache.delete(channelId);
                } else {
                    console.log(`  [*] Cache hit for channel ${channelId} (validated)`);
                    return { streamUrl: cached.streamUrl, ckParam: cached.ckParam, requestHeaders: cached.requestHeaders || null, cached: true };
                }
            } else {
                console.log(`  [*] Cache hit for channel ${channelId}`);
                return { streamUrl: cached.streamUrl, ckParam: cached.ckParam, requestHeaders: cached.requestHeaders || null, cached: true };
            }
        }
        console.log(`  [*] Cache entry for channel ${channelId} is not a valid stream URL; ignoring: ${cached.streamUrl}`);
        urlCache.delete(channelId);
    } else if (forceRefresh && cached) {
        console.log(`  [*] Force refresh requested for channel ${channelId}; bypassing cache.`);
    }

    // 2. Check failure cache
    const failure = failureCache.get(channelId);
    if (!forceRefresh && failure && (Date.now() - failure.timestamp) < FAILURE_TTL_MS) {
        console.log(`  [*] Skipping channel ${channelId} due to recent failure.`);
        return { streamUrl: null, ckParam: null, cached: false };
    }

    const playerUrl = channelId.startsWith('http') ? channelId : `${BASE_URL}/watch.php?id=${channelId}`;
    let streamUrl = null;
    let wrapperUrl = null;
    let ckParam = null;
    let requestHeaders = null;

    page.setDefaultNavigationTimeout(20000);

    try {
        // Intercept network requests
        await page.setRequestInterception(true);
        const requestHandler = req => {
            const url = req.url();
            const type = req.resourceType();

            if (!streamUrl && !url.includes('s3.dualstack') && isValidStreamUrl(url)) {
                console.log(`  [+] Intercepted: ${url}`);
                streamUrl = url;
                requestHeaders = sanitizeProxyHeaders(req.headers());
                if (url.includes('ck=')) {
                    try {
                        const parts = url.split('ck=');
                        if (parts.length > 1) ckParam = parts[1].split('&')[0];
                    } catch (e) { }
                }
            } else if (!wrapperUrl && STREAM_WRAPPER_REGEX.test(url)) {
                wrapperUrl = url;
            }

            if (shouldAbortNoisyRequest(url, type)) {
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
            const _matchStream = function(url) {
                return typeof url === 'string' && !url.includes('s3.dualstack') &&
                    /\.(?:mpd|m3u8|mono\.css|mono\.csv)/.test(url);
            };
            const originalFetch = window.fetch;
            window.fetch = function() {
                const url = arguments[0];
                if (_matchStream(url)) console.log('INTERCEPT_URL:' + url);
                return originalFetch.apply(this, arguments);
            };
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
                if (_matchStream(url)) console.log('INTERCEPT_URL:' + url);
                return origOpen.apply(this, arguments);
            };
        })();
        `;
        await page.evaluateOnNewDocument(MONITOR_SCRIPT);

        const checkFrames = async () => {
            if (streamUrl) return;
            const frames = page.frames();
            for (const frame of frames) {
                try {
                    const src = frame.url();
                    if (!src || src.includes('about:blank') || src.includes('s3.dualstack')) continue;

                    if (src.includes('.mpd') || src.includes('.m3u8') || src.includes('mono.css') || src.includes('mono.csv')) {
                        streamUrl = src;
                        break;
                    }
                    if (!wrapperUrl && STREAM_WRAPPER_REGEX.test(src)) {
                        wrapperUrl = src;
                    }
                } catch (e) {}
            }
        };

        // 1. Register response watcher BEFORE goto so it catches everything during page load
        const streamResponsePromise = page.waitForResponse(res => {
            const u = res.url().split('#')[0]; // strip fragment to avoid ad-URL false positives
            return isValidStreamUrl(u) && !u.includes('s3.dualstack');
        }, { timeout: 25000 }).catch(() => null);

        // 2. Navigate with domcontentloaded: doesn't wait for network idle, much faster
        try {
            await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch (err) {
            if (!streamUrl) console.log(`  [!] Navigation warning: ${err.message}`);
        }

        // 3. Collect response URL if interceptor hasn't already found it
        if (!streamUrl) {
            const fastResponse = await streamResponsePromise;
            if (fastResponse) {
                const url = fastResponse.url();
                console.log(`  [+] Quick-intercept response: ${url}`);
                streamUrl = url;
                if (url.includes('ck=')) {
                    try { ckParam = url.split('ck=')[1].split('&')[0]; } catch (e) {}
                }
            }
        }

        // 4. Polling loop with enhanced detection (fallback)
        let poll = 0;
        let rateLimitWait = false;

        while (!streamUrl && poll < 12) {
            const pageState = await page.evaluate(() => {
                const text = document.body.innerText || '';
                if (text.includes('429 Too Many Requests')) return '429';
                if (text.includes('404 Page Not Found')) return '404';
                if (text.includes('Bypass the Block') || text.includes('Will Bypass the Block')) return 'blocked';
                return 'ok';
            }).catch(() => 'error');

            if (pageState === '429' && !rateLimitWait) {
                console.log('  [!] Rate limited (429). Waiting 8s...');
                rateLimitWait = true;
                await new Promise(r => setTimeout(r, 8000));
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                continue;
            }

            if (pageState === '404') {
                console.log('  [!] Channel not found (404)');
                break;
            }

            if (pageState === 'blocked' && !rateLimitWait) {
                console.log('  [!] Block-like page detected. Waiting 10s before retry...');
                rateLimitWait = true;
                await new Promise(r => setTimeout(r, 10000));
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                continue;
            }

            const frameSrc = await page.evaluate(() => {
                const ifr = document.querySelector('iframe[src*="stream-"]');
                if (ifr && ifr.src) return ifr.src;
                const alt = document.querySelector('iframe[src*="watch.php"]');
                return alt ? alt.src : null;
            }).catch(() => null);

            if (frameSrc) {
                if (isValidStreamUrl(frameSrc)) {
                    streamUrl = frameSrc;
                } else if (!wrapperUrl) {
                    wrapperUrl = frameSrc;
                }
            }

            await checkFrames();
            if (streamUrl) break;

            await new Promise(r => setTimeout(r, 500));
            poll++;

            if (poll === 5) {
                try {
                    const dimensions = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
                    await page.mouse.click(dimensions.width / 2, dimensions.height / 2).catch(() => {});
                } catch (e) {}
            }
        }
        // 3. Diagnostic dump on failure
        if (!streamUrl && wrapperUrl) {
            for (const candidate of buildWrapperCandidates(wrapperUrl)) {
                const wrapperResolved = await resolveRedirectedStreamUrl(page, candidate).catch(() => null);
                if (wrapperResolved && isValidStreamUrl(wrapperResolved)) {
                    console.log(`  [*] Resolved wrapper URL via fallback helper: ${wrapperResolved}`);
                    streamUrl = wrapperResolved;
                    break;
                }
            }
        }

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

        if (streamUrl && !isValidStreamUrl(streamUrl)) {
            // Follow potential wrapper pages like stream-xxx.php / watch.php
            const resolved = await resolveRedirectedStreamUrl(page, streamUrl).catch(() => null);
            if (resolved && isValidStreamUrl(resolved)) {
                console.log(`  [*] Resolved wrapper URL to actual stream URL: ${resolved}`);
                streamUrl = resolved;
            } else {
                console.log(`  [*] Filtered out non-m3u/css stream URL for channel ${channelId}: ${streamUrl}`);
                streamUrl = null;
            }
        }

        if (!streamUrl) {
            // Final fallback: scan page HTML for .m3u8/.mpd/.css/.csv
            try {
                const html = await page.content();
                const fallback = findStreamUrlInText(html);
                if (fallback && isValidStreamUrl(fallback)) {
                    console.log(`  [*] Found stream URL in page HTML fallback: ${fallback}`);
                    streamUrl = fallback;
                } else {
                    const wrapperFallback = findWrapperUrlInText(html);
                    if (wrapperFallback && STREAM_WRAPPER_REGEX.test(wrapperFallback)) {
                        for (const candidate of buildWrapperCandidates(wrapperFallback)) {
                            const resolvedFromHtml = await resolveRedirectedStreamUrl(page, candidate).catch(() => null);
                            if (resolvedFromHtml && isValidStreamUrl(resolvedFromHtml)) {
                                console.log(`  [*] Resolved stream URL from HTML wrapper fallback: ${resolvedFromHtml}`);
                                streamUrl = resolvedFromHtml;
                                break;
                            }
                        }
                    }
                }
            } catch (e) { }
        }

        if (streamUrl) {
            urlCache.set(channelId, { streamUrl, ckParam, requestHeaders, timestamp: Date.now() });
            saveUrlCache();
        } else {
            failureCache.set(channelId, { timestamp: Date.now(), error: "Timeout or no m3u/css URL found" });
        }

    } catch (err) {
        console.error(` [!] Error: ${err.message}`);
        failureCache.set(channelId, { timestamp: Date.now(), error: err.message });
    }

    return { 
        streamUrl, 
        ckParam, 
        requestHeaders,
        wrapperDetectedButNoUrl: !streamUrl && wrapperUrl ? true : false
    };
}

/**
 * Resolve a single channel URL on-demand (delegates to extractStreamUrl)
 */
async function resolveChannelUrl(channelId, options = {}) {
    console.log(`[DLStreams Resolver] Resolving channel ${channelId}...`);
    let browser;
    try {
        browser = await getSharedBrowser();
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
        
        const result = await extractStreamUrl(page, channelId, options);

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
