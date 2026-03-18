/**
 * DLStreams URL Resolver
 * Shared module for extracting fresh stream URLs from DLStreams watch pages.
 * Used by both the scraper (bulk) and the on-demand resolver (single channel).
 */

let puppeteer;
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const fetch = require('node-fetch');

// Stealth can be unstable on some Linux/CDP setups. Keep it optional.
const isLinux = process.platform === 'linux';
const useStealthPlugin = process.env.DISABLE_STEALTH_PLUGIN === '1'
    ? false
    : (process.env.ENABLE_STEALTH_PLUGIN === '1' ? true : !isLinux);

if (useStealthPlugin) {
    try {
        puppeteer = require('puppeteer-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        puppeteer.use(StealthPlugin());
        console.log('[DLStreams Resolver] Stealth plugin enabled.');
    } catch (err) {
        console.log(`[DLStreams Resolver] Stealth init failed, falling back to plain puppeteer-extra: ${err.message}`);
        puppeteer = require('puppeteer-extra');
    }
} else {
    puppeteer = require('puppeteer-extra');
    console.log('[DLStreams Resolver] Stealth plugin disabled.');
}

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

// User-Agent rotation pool for better evasion
const UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
];

function getRandomUA() {
    return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

// In-memory cache for resolved URLs (channelId -> { streamUrl, ckParam, timestamp, validated })
let urlCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes - longer TTL for validated URLs
const CACHE_UNVALIDATED_TTL_MS = 20 * 60 * 1000; // 20 min for unvalidated

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
    'xadsmart.com',
    // Cloudflare challenge endpoints (specific)
    'challenge-platform',
    'challenges.cloudflare',
    'cdn-cgi',
    // Ad networks & trackers
    'rubiconproject',
    'openx.net',
    'criteo',
    'pagead',
    'oas.com',
    'scorecardresearch',
    'matomo',
    'mixpanel',
    // Video/streaming ads
    'pubads',
    'admeasures',
    'ads.vimeo',
    'bitmovin'
];

function shouldAbortNoisyRequest(url, resourceType) {
    if (!url) return false;

    const lowerUrl = String(url).toLowerCase();
    const isSameSite = /https?:\/\/([^\/]+\.)?dlstreams\.top/i.test(lowerUrl);

    if (!isValidStreamUrl(url) && NOISY_RESOURCE_TYPES.has(resourceType)) {
        return true;
    }

    if (!NOISY_URL_PATTERNS.some(pattern => lowerUrl.includes(pattern))) {
        return false;
    }

    // Never block same-site script/xhr/fetch resources by URL-pattern only.
    // They can be required to build the final iframe or stream URL.
    if (isSameSite && !NOISY_RESOURCE_TYPES.has(resourceType)) {
        return false;
    }

    return true;
}

/**
 * Detect whether the page is a real block/challenge page.
 * IMPORTANT: must NOT produce false positives on normal DLStreams watch pages.
 *
 * Normal DLStreams watch pages contain:
 *  - "They're FREE & Will Bypass the Block!" (VPN advice - NOT a real block)
 *  - "Schedule", "24/7 Channels" navigation
 *  - An <iframe> for the player
 *
 * @param {string} bodyText  - document.body.innerText
 * @param {string} htmlContent - document.documentElement.outerHTML
 * @param {number} statusCode
 */
function detectBlockPage(bodyText, htmlContent, statusCode) {
    const text  = (bodyText    || '').toLowerCase();
    const html  = (htmlContent || '').toLowerCase();
    const combined = text + html;

    // ── EARLY EXIT: normal DLStreams watch page ──────────────────────────────
    // The real watch page always has the site navigation AND an iframe player.
    // If both are present, the page is NOT a block - even if it mentions "bypass".
    const hasDLSNavigation = text.includes('schedule') && text.includes('24/7');
    const hasPlayerFrame   = html.includes('<iframe') &&
        (html.includes('stream') || html.includes('player') || html.includes('watch'));
    if (hasDLSNavigation && hasPlayerFrame) return false;

    // ── Cloudflare "Just a Moment" challenge ─────────────────────────────────
    // These are very specific to the Cloudflare interstitial page.
    if (text.includes('just a moment') ||
        html.includes('cf-challenge-form') ||
        html.includes('cf_chl_prog') ||
        html.includes('cf_chl_opt') ||
        html.includes('chl_captcha_fr') ||
        combined.includes('enable cookies')) {
        return true;
    }

    // ── Cloudflare specific error codes ──────────────────────────────────────
    if (text.includes('error 1010') || text.includes('error 1016') ||
        text.includes('error 1015') || text.includes('error 1006')) {
        return true;
    }

    // ── CF clearance on small page (real CF challenge, not just the cookie name) ─
    if (html.includes('cf_clearance') && html.length < 20000) {
        return true;
    }

    // ── HTTP status codes ─────────────────────────────────────────────────────
    if (statusCode === 429 || statusCode === 403) return true;

    // ── Explicit generic block messages ──────────────────────────────────────
    if (text.includes('you have been blocked') ||
        text.includes('403 forbidden') ||
        text.includes('429 too many requests') ||
        text.includes('ip has been banned')) {
        return true;
    }

    // ── CAPTCHA only on small pages  ─────────────────────────────────────────
    // A normal DLStreams page is ~25KB; a real captcha gate is <2KB text.
    if ((text.includes('captcha') || html.includes('recaptcha')) && text.length < 1500) {
        return true;
    }

    return false;
}

/**
 * Log diagnostic information about a block detection
 */
function logBlockDiagnostics(channelId, html, text) {
    const h = (html || '').toLowerCase();
    const t = (text || '').toLowerCase();
    const diagnostics = {
        channelId,
        timestamp: new Date().toISOString(),
        htmlSize: html.length,
        textSize: text.length,
        // Real block signals
        hasCFChallenge: h.includes('cf-challenge-form') || h.includes('cf_chl_prog') || t.includes('just a moment'),
        hasCFError: t.includes('error 1010') || t.includes('error 1016') || t.includes('error 1015'),
        hasCaptcha: h.includes('recaptcha') || (t.includes('captcha') && t.length < 1500),
        hasExplicitBlock: t.includes('you have been blocked') || t.includes('403 forbidden'),
        // Normal content signals (should be present in valid pages)
        hasDLSNavigation: t.includes('schedule') && t.includes('24/7'),
        hasPlayerIframe: h.includes('<iframe') && (h.includes('stream') || h.includes('player')),
        statusSnippets: []
    };
    
    const lines = text.split('\n').filter(l => l.trim().length > 5).slice(0, 8);
    diagnostics.statusSnippets = lines.map(l => l.trim().substring(0, 120));
    
    console.log(`  [DIAG] Block detection: ${JSON.stringify(diagnostics).substring(0, 400)}...`);
}

function findStreamUrlInText(text) {
    if (!text) return null;
    // Prefer direct .m3u8 / .mpd links
    const mediaMaybe = text.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\.(?:m3u8|mpd)(?:\?[\w\-.:@%?&=\/\+~]*)?/i);
    if (mediaMaybe) return mediaMaybe[0];
    // Fallback: DLStreams-specific mono.css / mono.csv disguised streams
    const monoMaybe = text.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\/mono\.(?:css|csv)(?:\?[\w\-.:@%?&=\/\+~]*)?/i);
    if (monoMaybe) return monoMaybe[0];

    // Common inline-JS patterns used by players.
    const jsPatterns = [
        /(?:file|source|src)\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mpd)(?:\?[^"']*)?)["']/i,
        /hls\.loadSource\(\s*["'](https?:\/\/[^"']+\.(?:m3u8)(?:\?[^"']*)?)["']\s*\)/i,
        /dashjs\.[\w.]+\(\s*["'](https?:\/\/[^"']+\.(?:mpd)(?:\?[^"']*)?)["']\s*\)/i
    ];
    for (const rx of jsPatterns) {
        const m = text.match(rx);
        if (m && m[1]) return m[1];
    }

    // Sometimes links are escaped in inline JSON/JS.
    const unescaped = text.replace(/\\\//g, '/');
    if (unescaped !== text) {
        const escMaybe = unescaped.match(/https?:\/\/[\w\-.:@%?&=\/\+~]+?\.(?:m3u8|mpd)(?:\?[\w\-.:@%?&=\/\+~]*)?/i);
        if (escMaybe) return escMaybe[0];
    }

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
 * Exponential backoff with jitter: attempt 0->2s, 1->4s, 2->8s, etc (capped at maxMs)
 */
function getExponentialBackoffDelay(attempt, baseMs = 2000, maxMs = 30000) {
    const exponential = baseMs * Math.pow(2, Math.min(attempt, 4)); // Cap at 2^4 to avoid huge delays
    const jitter = exponential * 0.8 + Math.random() * exponential * 0.4; // ±20% variation
    return Math.min(jitter, maxMs);
}

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
 * Get Puppeteer launch options with better anti-detection settings
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
            '--mute-audio',
            '--disable-blink-features=AutomationControlled',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--disable-hang-monitor',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-sync',
            '--no-first-run'
        ],
        protocolTimeout: 180000  // 3 minutes for long operations
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
    let blockPageDetected = false;
    let blockPageHits = 0;

    page.setDefaultNavigationTimeout(20000);

    try {
        // Set realistic headers and UA
        await page.setUserAgent(getRandomUA()).catch(() => {});
        await page.setViewport({ width: 1920, height: 1080 }).catch(() => {});
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-User': '?1',
            'Sec-Fetch-Dest': 'document'
        }).catch(() => {});

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

        while (!streamUrl && poll < 24) {
            const pageState = await page.evaluate(() => {
                const text = document.body.innerText || '';
                const html = document.documentElement.outerHTML || '';
                return { text, html, statusCode: 200 };
            }).catch(() => ({ text: '', html: '', statusCode: 0 }));

            // Check with correct signature: separate text, html, statusCode
            const isBlocked = detectBlockPage(pageState.text, pageState.html, pageState.statusCode);
            
            if (isBlocked && blockPageHits < 1) {
                blockPageDetected = true;
                blockPageHits++;
                logBlockDiagnostics(channelId, pageState.html, pageState.text);
                console.log('  [!] Block-like page detected. Waiting 15s before retry...');
                rateLimitWait = true;
                await new Promise(r => setTimeout(r, 15000));
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                continue;
            }

            if (isBlocked && blockPageHits >= 1) {
                blockPageDetected = true;
                blockPageHits++;
                if (blockPageHits >= 2) {
                    console.log('  [!] Block page still present after retry, aborting this resolve early.');
                    break;
                }
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

            await new Promise(r => setTimeout(r, 700));
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
                const textContent = await page.evaluate(() => document.body.innerText).catch(() => '');
                
                // Use the real detectBlockPage to assess (not stale heuristics)
                const isLikelyBlock = detectBlockPage(textContent, html, 0);
                
                fs.writeFileSync(diagPath, html, 'utf8');
                console.log(`  [!] Diagnostic HTML dumped to ${diagPath}${isLikelyBlock ? ' (real block page)' : ' (no stream found, but not a block page)'}`);
                
                if (isLikelyBlock && textContent.length < 2000) {
                    console.log(`  [!] BLOCK PAGE CONTENT: ${textContent.substring(0, 200)}...`);
                }
            } catch (diagErr) { 
                console.log(`  [!] Could not save diagnostics: ${diagErr.message}`);
            }
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
                    // Extra fallback: scan inline scripts text content
                    const scriptInline = await page.evaluate(() => {
                        return Array.from(document.scripts || [])
                            .map(s => s && s.textContent ? s.textContent : '')
                            .join('\n');
                    }).catch(() => '');

                    const scriptFallback = findStreamUrlInText(scriptInline);
                    if (scriptFallback && isValidStreamUrl(scriptFallback)) {
                        console.log(`  [*] Found stream URL in inline scripts fallback: ${scriptFallback}`);
                        streamUrl = scriptFallback;
                    }

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
        wrapperDetectedButNoUrl: !streamUrl && wrapperUrl ? true : false,
        blockPageDetected,
        blockPageHits
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
        await page.setUserAgent(getRandomUA());
        
        // Set realistic viewport and headers
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-User': '?1',
            'Sec-Fetch-Dest': 'document'
        });
        
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
        await page.setUserAgent(getRandomUA());
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        });
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
