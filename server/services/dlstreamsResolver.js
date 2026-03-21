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

const globalHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const globalHttpAgent = new http.Agent();

// User-Agent rotation pool
const UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
];

function getRandomUA() {
    return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

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

// ---- Stream URL validation helpers ----

/**
 * Returns true only for genuine stream URLs (.m3u8, .mpd, mono.css, mono.csv)
 */
function isValidStreamUrl(url) {
    if (!url) return false;
    const clean = url.split('#')[0];
    return /\.(m3u8|mpd)(\?|$)/i.test(clean) ||
           /\/mono\.(css|csv)(\?|$)/i.test(clean);
}

const IMAGE_SEGMENT_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|$)/i;

/**
 * Check if a segment URL looks like an image (by pathname extension or query params).
 */
function isImageSegmentUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (IMAGE_SEGMENT_RE.test(parsed.pathname)) return true;
        const rct = parsed.searchParams.get('response-content-type') || '';
        if (rct.startsWith('image/')) return true;
        const rcd = parsed.searchParams.get('response-content-disposition') || '';
        if (IMAGE_SEGMENT_RE.test(rcd)) return true;
    } catch (_) {
        if (IMAGE_SEGMENT_RE.test(rawUrl)) return true;
    }
    return false;
}

/**
 * Validate a mono.css/mono.csv manifest by fetching it and checking for poisoned
 * (image-like) segment URLs. Returns { valid: true } or { valid: false, reason }.
 */
async function validateMonoManifest(monoUrl, headers = null) {
    if (!monoUrl) return { valid: false, reason: 'empty url' };
    const isMono = monoUrl.includes('mono.css') || monoUrl.includes('mono.csv');
    if (!isMono) return { valid: true }; // only validate mono URLs
    try {
        const fetchHeaders = {
            'User-Agent': (headers && headers['user-agent']) || getRandomUA(),
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
        };
        if (headers?.referer) fetchHeaders['Referer'] = headers.referer;
        if (headers?.origin) fetchHeaders['Origin'] = headers.origin;

        const resp = await fetch(monoUrl, {
            headers: fetchHeaders,
            agent: monoUrl.startsWith('https://') ? globalHttpsAgent : globalHttpAgent,
            timeout: 10000,
        });
        if (!resp.ok) return { valid: false, reason: `HTTP ${resp.status}` };
        const body = await resp.text();
        if (!body.startsWith('#EXTM3U')) return { valid: false, reason: 'not HLS' };

        let totalSegments = 0, imageSegments = 0;
        for (const line of body.split('\n')) {
            const t = line.trim();
            if (t && !t.startsWith('#')) {
                totalSegments++;
                if (isImageSegmentUrl(t)) imageSegments++;
            }
        }
        if (totalSegments > 0 && imageSegments === totalSegments) {
            return { valid: false, reason: `all ${totalSegments} segments are image files` };
        }
        if (totalSegments > 0 && imageSegments > totalSegments / 2) {
            return { valid: false, reason: `${imageSegments}/${totalSegments} segments are image files` };
        }
        return { valid: true };
    } catch (e) {
        // Network error during validation — don't block caching, let proxy handle it
        return { valid: true };
    }
}

/**
 * Find stream URL in HTML/JS text
 */
function findStreamUrlInText(text) {
    if (!text) return null;
    const mediaMaybe = text.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\.(?:m3u8|mpd)(?:\?[\w\-.:@%?&=\/\+~]*)?/i);
    if (mediaMaybe) return mediaMaybe[0];
    const monoMaybe = text.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\/mono\.(?:css|csv)(?:\?[\w\-.:@%?&=\/\+~]*)?/i);
    if (monoMaybe) return monoMaybe[0];
    return null;
}

/**
 * Find wrapper/player URL in text
 */
function findWrapperUrlInText(text) {
    if (!text) return null;
    const wrapperMaybe = text.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\/(?:stream|cast|watch|plus|casting|player)\/stream-\d+\.php(?:\?[\w\-.:@%?&=\/\+~]*)?/i);
    if (wrapperMaybe) return wrapperMaybe[0];
    return null;
}

/**
 * Find premiumtv/daddyhd URL in text
 */
function findPremiumTvUrlInText(text, baseUrl = null) {
    if (!text) return null;
    const absMatch = text.match(/https?:\/\/[^"'\s<>]+\/premiumtv\/daddyhd\.php\?id=\d+(?:[^"'\s<>]*)?/i);
    if (absMatch) return absMatch[0];
    const relMatch = text.match(/["']([^"']*\/premiumtv\/daddyhd\.php\?id=\d+[^"']*)["']/i);
    if (!relMatch || !relMatch[1]) return null;
    try {
        return baseUrl ? new URL(relMatch[1], baseUrl).href : relMatch[1];
    } catch (_) {
        return relMatch[1];
    }
}

/**
 * Parse CHANNEL_KEY + M3U8_SERVER from page HTML and do server_lookup to build mono URL
 */
async function resolvePremiumLookupFlow(pageHtml, pageUrl, refererUrl = null) {
    if (!pageHtml || !pageUrl) return null;

    const keyMatch = pageHtml.match(/CHANNEL_KEY\s*=\s*['\"]([^'\"]+)['\"]/i);
    const serverMatch = pageHtml.match(/M3U8_SERVER\s*=\s*['\"]([^'\"]+)['\"]/i);
    if (!keyMatch || !serverMatch) return null;

    const channelKey = String(keyMatch[1] || '').trim();
    const m3u8Server = String(serverMatch[1] || '').trim();
    if (!channelKey || !m3u8Server) return null;

    const lookupUrl = `https://${m3u8Server}/server_lookup?channel_id=${encodeURIComponent(channelKey)}`;

    let pageOrigin = BASE_URL;
    try { pageOrigin = new URL(pageUrl).origin; } catch (_) {}

    try {
        const lookupResp = await fetch(lookupUrl, {
            method: 'GET',
            headers: {
                'User-Agent': getRandomUA(),
                'Accept': 'application/json,text/plain,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': refererUrl || pageUrl,
                'Origin': pageOrigin,
                'X-Requested-With': 'XMLHttpRequest'
            },
            agent: lookupUrl.startsWith('https://') ? globalHttpsAgent : globalHttpAgent,
            timeout: 18000
        });

        const lookupJson = await lookupResp.json().catch(() => null);
        const serverKey = lookupJson?.server_key ? String(lookupJson.server_key).trim() : null;
        if (!serverKey) return null;

        const monoUrl = serverKey === 'top1/cdn'
            ? `https://${m3u8Server}/proxy/top1/cdn/${channelKey}/mono.css`
            : `https://${m3u8Server}/proxy/${serverKey}/${channelKey}/mono.css`;

        return isValidStreamUrl(monoUrl) ? monoUrl : null;
    } catch (_) {
        return null;
    }
}

/**
 * Resolve a URL by following HTTP redirects and parsing page content for stream URLs
 */
async function resolveViaHttpProbe(candidateUrl, visited = new Set(), refererUrl = null) {
    if (!candidateUrl || visited.has(candidateUrl) || visited.size > 8) return null;
    visited.add(candidateUrl);

    if (isValidStreamUrl(candidateUrl)) return candidateUrl;

    let origin = BASE_URL;
    try { origin = new URL(refererUrl || candidateUrl).origin; } catch (_) {}

    let body = '';
    let finalUrl = candidateUrl;
    try {
        const response = await fetch(candidateUrl, {
            method: 'GET',
            headers: {
                'User-Agent': getRandomUA(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': refererUrl || `${BASE_URL}/`,
                'Origin': origin
            },
            redirect: 'follow',
            timeout: 18000,
            agent: candidateUrl.startsWith('https://') ? globalHttpsAgent : globalHttpAgent
        });

        finalUrl = response?.url || candidateUrl;
        if (isValidStreamUrl(finalUrl)) return finalUrl;

        body = await response.text();
    } catch (_) {
        return null;
    }

    const mediaInBody = findStreamUrlInText(body);
    if (mediaInBody && isValidStreamUrl(mediaInBody)) return mediaInBody;

    const premiumResolved = await resolvePremiumLookupFlow(body, finalUrl, refererUrl || candidateUrl).catch(() => null);
    if (premiumResolved && isValidStreamUrl(premiumResolved)) return premiumResolved;

    const nextCandidate = findWrapperUrlInText(body) || findPremiumTvUrlInText(body, finalUrl);
    if (nextCandidate && !visited.has(nextCandidate)) {
        return resolveViaHttpProbe(nextCandidate, visited, finalUrl);
    }

    return null;
}

/**
 * Try direct server_lookup on known CDN hosts
 */
async function resolveDirectChannelLookup(channelId, refererUrl = null) {
    const cid = String(channelId || '').trim();
    if (!/^\d+$/.test(cid)) return null;

    const hosts = new Set(['ai.the-sunmoon.site', 'the-sunmoon.site']);

    // Learn likely hosts from current cache entries
    for (const value of urlCache.values()) {
        const candidate = value?.streamUrl ? String(value.streamUrl) : '';
        if (!candidate) continue;
        try {
            const h = new URL(candidate.split('#')[0]).hostname;
            if (h) hosts.add(h);
        } catch (_) {}
    }

    const channelIdVariants = [`premium${cid}`, cid];
    const referer = `https://freestyleridesx.lol/premiumtv/daddyhd.php?id=${cid}`;

    for (const host of hosts) {
        for (const channelKey of channelIdVariants) {
            try {
                const lookupUrl = `https://${host}/server_lookup?channel_id=${encodeURIComponent(channelKey)}`;
                const resp = await fetch(lookupUrl, {
                    method: 'GET',
                    headers: {
                        'User-Agent': getRandomUA(),
                        'Accept': 'application/json,text/plain,*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Referer': refererUrl || referer,
                        'Origin': `https://${host}`,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    agent: globalHttpsAgent,
                    timeout: 8000
                });
                if (!resp.ok) continue;

                const data = await resp.json().catch(() => null);
                const serverKey = data?.server_key ? String(data.server_key).trim() : '';
                if (!serverKey) continue;

                const monoUrl = serverKey === 'top1/cdn'
                    ? `https://${host}/proxy/top1/cdn/premium${cid}/mono.css`
                    : `https://${host}/proxy/${serverKey}/premium${cid}/mono.css`;

                if (!isValidStreamUrl(monoUrl)) continue;

                console.log(`  [*] Resolved stream via direct server_lookup (${host}, key=${channelKey}): ${monoUrl}`);
                return monoUrl;
            } catch (_) {
                // Try next variant/host
            }
        }
    }
    return null;
}

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
async function extractStreamUrl(page, channelId, options = {}) {
    channelId = String(channelId);
    const { bypassFailureCache } = options;
    // 1. Check cache first
    const cached = urlCache.get(channelId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        // Invalidate cache for mono.css/mono.csv URLs without requestHeaders (can't proxy without them)
        const isMono = cached.streamUrl && (cached.streamUrl.includes('mono.css') || cached.streamUrl.includes('mono.csv'));
        if (isMono && !cached.requestHeaders) {
            console.log(`  [*] Cache invalidated for channel ${channelId}: mono URL without requestHeaders`);
        } else {
            console.log(`  [*] Cache hit for channel ${channelId}`);
            return { streamUrl: cached.streamUrl, ckParam: cached.ckParam, requestHeaders: cached.requestHeaders || null, cached: true };
        }
    }

    // 2. Check failure cache (skip if bypassFailureCache)
    if (!bypassFailureCache) {
        const failure = failureCache.get(channelId);
        if (failure && (Date.now() - failure.timestamp) < FAILURE_TTL_MS) {
            console.log(`  [*] Skipping channel ${channelId} due to recent failure.`);
            return { streamUrl: null, ckParam: null, cached: false };
        }
    }

    const playerUrl = channelId.startsWith('http') ? channelId : `${BASE_URL}/watch.php?id=${channelId}`;
    let streamUrl = null;
    let ckParam = null;
    let requestHeaders = null;

    try {
        // Intercept network requests
        await page.setRequestInterception(true);
        const requestHandler = req => {
            const url = req.url();
            const type = req.resourceType();

            if (!streamUrl && !url.includes('s3.dualstack') && (url.includes('.mpd') || url.includes('.m3u8') || url.includes('mono.css') || url.includes('mono.csv'))) {
                console.log(`  [+] Intercepted: ${url}`);
                streamUrl = url;
                // Capture request headers (Referer, Origin) needed by CDN
                try {
                    const hdrs = req.headers();
                    const kept = {};
                    for (const [k, v] of Object.entries(hdrs)) {
                        const lk = k.toLowerCase();
                        if (['user-agent','origin','referer','accept','accept-language'].includes(lk) && v) {
                            kept[lk] = v;
                        }
                    }
                    if (Object.keys(kept).length > 0) requestHeaders = kept;
                } catch (e) {}
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
            await page.goto(playerUrl, { 
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
        // 3. Diagnostic dump on failure + HTTP probe fallback
        if (!streamUrl) {
            const diagPath = path.join(DATA_DIR, `fail_${channelId}.html`);
            let pageHtml = '';
            try {
                pageHtml = await page.content();
                fs.writeFileSync(diagPath, pageHtml, 'utf8');
            } catch (diagErr) { }

            // Try HTTP probe fallback: parse page HTML for CHANNEL_KEY/M3U8_SERVER
            const httpFallback = await resolvePremiumLookupFlow(pageHtml, playerUrl).catch(() => null);
            if (httpFallback && isValidStreamUrl(httpFallback)) {
                console.log(`  [*] Resolved stream URL via HTTP probe fallback: ${httpFallback}`);
                streamUrl = httpFallback;
                // Set referer headers for the CDN
                requestHeaders = {
                    'user-agent': getRandomUA(),
                    'referer': 'https://freestyleridesx.lol/',
                    'origin': 'https://freestyleridesx.lol',
                    'accept': '*/*',
                    'accept-language': 'en-US,en;q=0.9'
                };
            } else {
                // Try direct server_lookup as last resort
                const directFallback = await resolveDirectChannelLookup(channelId, playerUrl).catch(() => null);
                if (directFallback && isValidStreamUrl(directFallback)) {
                    console.log(`  [*] Resolved stream URL via direct server_lookup fallback: ${directFallback}`);
                    streamUrl = directFallback;
                    requestHeaders = {
                        'user-agent': getRandomUA(),
                        'referer': 'https://freestyleridesx.lol/',
                        'origin': 'https://freestyleridesx.lol',
                        'accept': '*/*',
                        'accept-language': 'en-US,en;q=0.9'
                    };
                } else {
                    console.log(`  [!] Diagnostic HTML dumped to ${diagPath} (no stream found)`);
                }
            }
        }

        // 4. Cache result or failure
        page.off('request', requestHandler);
        page.off('console', consoleHandler);

        // 3. Cache result or failure
        if (streamUrl) {
            // Validate mono manifest before caching
            const extractValidation = await validateMonoManifest(streamUrl, requestHeaders);
            if (!extractValidation.valid) {
                console.warn(`  [!] Extracted mono manifest poisoned for channel ${channelId}: ${extractValidation.reason}`);
                // Return URL but don't cache — proxy will return 502 and trigger re-resolve
                return { streamUrl, ckParam, requestHeaders, cached: false, poisoned: true };
            }
            urlCache.set(channelId, { streamUrl, ckParam, requestHeaders, timestamp: Date.now() });
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
 * Resolve a single channel URL on-demand.
 * Fast-path: HTTP probe of watch pages + direct server_lookup (~2-5s)
 * Slow-path: Full Puppeteer browser render (~20-60s)
 */
async function resolveChannelUrl(channelId, options = {}) {
    channelId = String(channelId);
    const { bypassFailureCache, forceRefresh } = options;
    console.log(`[DLStreams Resolver] Resolving channel ${channelId}...`);

    // --- Cache check ---
    const cached = urlCache.get(channelId);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        const isMono = cached.streamUrl && (cached.streamUrl.includes('mono.css') || cached.streamUrl.includes('mono.csv'));
        if (isMono && !cached.requestHeaders) {
            console.log(`  [*] Cache invalidated for channel ${channelId}: mono URL without requestHeaders`);
        } else {
            console.log(`[DLStreams Resolver] Channel ${channelId}: OK [CACHED]`);
            return { streamUrl: cached.streamUrl, ckParam: cached.ckParam, requestHeaders: cached.requestHeaders || null, cached: true };
        }
    }

    // --- Failure cache check ---
    if (!forceRefresh && !bypassFailureCache) {
        const failure = failureCache.get(channelId);
        if (failure && (Date.now() - failure.timestamp) < FAILURE_TTL_MS) {
            console.log(`  [*] Skipping channel ${channelId} due to recent failure.`);
            return { streamUrl: null, ckParam: null, cached: false };
        }
    }

    const playerUrl = `${BASE_URL}/watch.php?id=${channelId}`;

    // --- Fast-path A: HTTP probe of watch pages ---
    const watchPageHosts = [
        playerUrl,
        `https://freestyleridesx.lol/premiumtv/daddyhd.php?id=${channelId}`,
    ];
    console.log(`  [~] Trying fast HTTP probe for channel ${channelId}...`);
    for (const watchUrl of watchPageHosts) {
        const httpProbed = await resolveViaHttpProbe(watchUrl, new Set(), `${BASE_URL}/`).catch(() => null);
        if (httpProbed && isValidStreamUrl(httpProbed)) {
            console.log(`  [+] Fast HTTP probe succeeded for channel ${channelId}: ${httpProbed.substring(0, 80)}`);
            // Try to get referer headers from the watch page host
            let probeHeaders = null;
            try {
                const watchOrigin = new URL(watchUrl).origin;
                probeHeaders = {
                    'user-agent': getRandomUA(),
                    'referer': watchOrigin + '/',
                    'origin': watchOrigin,
                    'accept': '*/*',
                    'accept-language': 'en-US,en;q=0.9'
                };
            } catch (_) {}
            // Validate mono manifest before caching
            const probeValidation = await validateMonoManifest(httpProbed, probeHeaders);
            if (!probeValidation.valid) {
                console.warn(`  [!] HTTP probe mono manifest poisoned for channel ${channelId}: ${probeValidation.reason}`);
                continue; // try next watch page host
            }
            urlCache.set(channelId, { streamUrl: httpProbed, ckParam: null, requestHeaders: probeHeaders, timestamp: Date.now() });
            saveUrlCache();
            console.log(`[DLStreams Resolver] Channel ${channelId}: OK [HTTP-PROBE]`);
            return { streamUrl: httpProbed, ckParam: null, requestHeaders: probeHeaders, cached: false };
        }
    }

    // --- Fast-path B: direct server_lookup on known CDN hosts ---
    console.log(`  [~] Trying direct server_lookup for channel ${channelId}...`);
    const directUrl = await resolveDirectChannelLookup(channelId, playerUrl).catch(() => null);
    if (directUrl && isValidStreamUrl(directUrl)) {
        console.log(`  [+] Direct server_lookup succeeded for channel ${channelId}: ${directUrl.substring(0, 80)}`);
        const lookupHeaders = {
            'user-agent': getRandomUA(),
            'referer': 'https://freestyleridesx.lol/',
            'origin': 'https://freestyleridesx.lol',
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9'
        };
        // Validate mono manifest before caching
        const lookupValidation = await validateMonoManifest(directUrl, lookupHeaders);
        if (!lookupValidation.valid) {
            console.warn(`  [!] Direct lookup mono manifest poisoned for channel ${channelId}: ${lookupValidation.reason}`);
            // Don't cache, fall through to Puppeteer
        } else {
            urlCache.set(channelId, { streamUrl: directUrl, ckParam: null, requestHeaders: lookupHeaders, timestamp: Date.now() });
            saveUrlCache();
            console.log(`[DLStreams Resolver] Channel ${channelId}: OK [DIRECT-LOOKUP]`);
            return { streamUrl: directUrl, ckParam: null, requestHeaders: lookupHeaders, cached: false };
        }
    }

    // --- Slow-path: full Puppeteer browser render ---
    console.log(`  [~] Fast paths failed for channel ${channelId}; falling back to Puppeteer...`);
    try {
        const browser = await getSharedBrowser();
        const page = await browser.newPage();
        await page.setUserAgent(getRandomUA());
        
        const result = await extractStreamUrl(page, channelId, options);

        if (result.streamUrl && result.streamUrl.startsWith("chrome-extension://")) {
            if (result.streamUrl.includes("#")) result.streamUrl = result.streamUrl.split("#")[1];
        }

        console.log(`[DLStreams Resolver] Channel ${channelId}: ${result.streamUrl ? 'OK' : 'FAIL'} ${result.cached ? '[CACHED]' : '[PUPPETEER]'}`);
        await page.close().catch(() => {});
        return result;
    } catch (err) {
        console.error(`[DLStreams Resolver] Error: ${err.message}`);
        failureCache.set(channelId, { timestamp: Date.now(), error: err.message });
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

/**
 * Get cached request headers for a channel (used by proxy to set correct Referer/Origin)
 */
function getCachedHeaders(channelId) {
    const cached = urlCache.get(String(channelId));
    return cached?.requestHeaders || null;
}

/**
 * Fallback: get ANY cached requestHeaders from any channel (same CDN expects same Referer)
 */
function getAnyDlstreamsHeaders() {
    for (const [, entry] of urlCache) {
        if (entry.requestHeaders && (entry.requestHeaders.referer || entry.requestHeaders.origin)) {
            return entry.requestHeaders;
        }
    }
    return null;
}

module.exports = {
    extractStreamUrl,
    resolveChannelUrl,
    decodeClearKey,
    fetchCategories,
    getCachedHeaders,
    getAnyDlstreamsHeaders,
    getLaunchOptions,
    BASE_URL,
    CHROMIUM_PATH
};
