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

// Stealth is disabled by default due to instability in this environment.
// To enable stealth explicitly, set ENABLE_STEALTH_PLUGIN=1.
const useStealthPlugin = process.env.ENABLE_STEALTH_PLUGIN === '1';

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

function extractHeadersFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const u = new URL(url);
        const encoded = u.searchParams.get('headers');
        if (!encoded) return null;
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        return sanitizeProxyHeaders(parsed);
    } catch (_) {
        return null;
    }
}

function looksLikePoisonedHlsManifest(manifestText, strictMono = false) {
    if (!manifestText || typeof manifestText !== 'string') return false;

    const lines = manifestText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return false;

    const hasExtinf = lines.some(l => l.startsWith('#EXTINF'));
    const uriLines = lines.filter(l => !l.startsWith('#'));
    if (uriLines.length === 0) return false;

    const decodeLoose = (value) => {
        if (!value) return '';
        try {
            return decodeURIComponent(value);
        } catch {
            return String(value);
        }
    };

    const uriMeta = uriLines.map((line) => {
        const raw = String(line);
        const decoded = decodeLoose(raw);
        return { raw, decoded };
    });

    const imageUriCount = uriMeta.filter(({ raw, decoded }) => {
        const s = `${raw} ${decoded}`;
        return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$|&|"|')/i.test(s) ||
            /response-content-type=image\/(png|jpe?g|gif|webp|bmp|svg\+xml)/i.test(s) ||
            /(?:filename|filename\*)[^&\n]*\.(png|jpe?g|gif|webp|bmp|svg)/i.test(s);
    }).length;

    const mediaUriCount = uriMeta.filter(({ raw, decoded }) => {
        const s = `${raw} ${decoded}`;
        return /\.(ts|m2ts|m4s|m4v|m4a|cmfa|cmfv|mp4|aac|ac3|ec3|mp3|webm)(\?|$|&)/i.test(s) ||
            /response-content-type=(video|audio)\//i.test(s);
    }).length;

    const knownPoisonSegments = uriMeta.filter(({ raw, decoded }) => {
        const s = `${raw} ${decoded}`;
        return /seg_[a-z0-9_\-]+\.(png|jpe?g|gif|webp|bmp|svg)(\?|$|&|"|')/i.test(s);
    }).length;

    if (strictMono) {
        // DLStreams mono manifests can include occasional image placeholders.
        // Treat as poisoned only when media is absent or image segments dominate.
        if (imageUriCount > 0 && mediaUriCount === 0) return true;
        if (knownPoisonSegments >= 2 && mediaUriCount <= 1) return true;
        if (imageUriCount >= 3 && imageUriCount > mediaUriCount) return true;
    }

    return hasExtinf && imageUriCount > 0 && mediaUriCount === 0;
}

async function validateStreamUrlFast(url, timeoutMs = CACHE_VALIDATE_TIMEOUT_MS) {
    if (!isValidStreamUrl(url)) return false;
    const cleanUrl = url.split('#')[0];
    const isMonoMasquerade = /\/mono\.(css|csv)(\?|$)/i.test(cleanUrl);
    const embeddedHeaders = extractHeadersFromUrl(cleanUrl) || {};

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
                    ...profile,
                    ...embeddedHeaders
                },
                agent: cleanUrl.startsWith('https://') ? globalHttpsAgent : globalHttpAgent,
                timeout: timeoutMs
            });

            if (!response.ok) {
                continue;
            }

            const body = await response.text();
            const trimmed = body.trimStart();
            if (trimmed.startsWith('#EXTM3U')) {
                if (looksLikePoisonedHlsManifest(body, isMonoMasquerade)) {
                    continue;
                }
                return true;
            }
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
const PREMIUMTV_WRAPPER_REGEX = /\/premiumtv\/daddyhd\.php\?id=\d+/i;
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

function findPremiumTvUrlInText(text, baseUrl = null) {
    if (!text) return null;

    const absMatch = text.match(/https?:\/\/[^"'\s<>]+\/premiumtv\/daddyhd\.php\?id=\d+(?:[^"'\s<>]*)?/i);
    if (absMatch) return absMatch[0];

    const relMatch = text.match(/["']([^"']*\/premiumtv\/daddyhd\.php\?id=\d+[^"']*)["']/i);
    if (!relMatch || !relMatch[1]) return null;

    try {
        if (baseUrl) {
            return new URL(relMatch[1], baseUrl).href;
        }
        return relMatch[1];
    } catch (_) {
        return relMatch[1];
    }
}

function isResolvableIntermediateUrl(url) {
    if (!url) return false;
    return STREAM_WRAPPER_REGEX.test(url) || PREMIUMTV_WRAPPER_REGEX.test(url);
}

function decodeEscapedUrl(url) {
    if (!url || typeof url !== 'string') return url;
    return url
        .replace(/\\u002F/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&')
        .trim();
}

function extractChromeBlockedReloadUrl(text) {
    if (!text) return null;

    const reloadMatch = text.match(/"reloadUrl"\s*:\s*"(https?:[^"\\]+(?:\\.[^"\\]*)*)"/i);
    if (reloadMatch && reloadMatch[1]) {
        return decodeEscapedUrl(reloadMatch[1]);
    }

    const dataUrlMatch = text.match(/data-url\s*=\s*"(https?:[^"\\]+(?:\\.[^"\\]*)*)"/i);
    if (dataUrlMatch && dataUrlMatch[1]) {
        return decodeEscapedUrl(dataUrlMatch[1]);
    }

    return null;
}

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
    try {
        pageOrigin = new URL(pageUrl).origin;
    } catch (_) {}

    let serverKey = null;
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
        serverKey = lookupJson && lookupJson.server_key ? String(lookupJson.server_key).trim() : null;
    } catch (_) {
        return null;
    }

    if (!serverKey) return null;

    const monoUrl = serverKey === 'top1/cdn'
        ? `https://${m3u8Server}/proxy/top1/cdn/${channelKey}/mono.css`
        : `https://${m3u8Server}/proxy/${serverKey}/${channelKey}/mono.css`;

    if (!isValidStreamUrl(monoUrl)) return null;

    return monoUrl;
}

async function resolveViaHttpProbe(candidateUrl, visited = new Set(), refererUrl = null) {
    if (!candidateUrl || visited.has(candidateUrl) || visited.size > 8) {
        return null;
    }
    visited.add(candidateUrl);

    if (isValidStreamUrl(candidateUrl)) return candidateUrl;

    let origin = BASE_URL;
    try {
        origin = new URL(refererUrl || candidateUrl).origin;
    } catch (_) {}

    const headers = {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': refererUrl || `${BASE_URL}/`,
        'Origin': origin
    };
    const embeddedHeaders = extractHeadersFromUrl(candidateUrl);
    if (embeddedHeaders) {
        Object.assign(headers, embeddedHeaders);
    }

    let body = '';
    let finalUrl = candidateUrl;
    try {
        const response = await fetch(candidateUrl, {
            method: 'GET',
            headers,
            redirect: 'follow',
            timeout: 18000,
            agent: candidateUrl.startsWith('https://') ? globalHttpsAgent : globalHttpAgent
        });

        finalUrl = response && response.url ? response.url : candidateUrl;
        if (isValidStreamUrl(finalUrl)) return finalUrl;

        body = await response.text();
    } catch (_) {
        return null;
    }

    const mediaInBody = findStreamUrlInText(body);
    if (mediaInBody && isValidStreamUrl(mediaInBody)) {
        return mediaInBody;
    }

    const premiumResolved = await resolvePremiumLookupFlow(body, finalUrl, refererUrl || candidateUrl).catch(() => null);
    if (premiumResolved && isValidStreamUrl(premiumResolved)) {
        return premiumResolved;
    }

    const nextCandidate =
        findWrapperUrlInText(body) ||
        findPremiumTvUrlInText(body, finalUrl) ||
        extractChromeBlockedReloadUrl(body);

    if (nextCandidate && !visited.has(nextCandidate)) {
        return resolveViaHttpProbe(nextCandidate, visited, finalUrl);
    }

    return null;
}

function buildMonoUrlFromLookup(host, serverKey, channelId) {
    const h = String(host || '').trim();
    const key = String(serverKey || '').trim();
    const cid = String(channelId || '').trim();
    if (!h || !key || !cid) return null;
    // All known mono URLs use /proxy/<key>/premium<id>/mono.css
    return key === 'top1/cdn'
        ? `https://${h}/proxy/top1/cdn/premium${cid}/mono.css`
        : `https://${h}/proxy/${key}/premium${cid}/mono.css`;
}

async function resolveDirectChannelLookup(channelId, refererUrl = null) {
    const cid = String(channelId || '').trim();
    if (!/^\d+$/.test(cid)) return null;

    const hosts = new Set();
    hosts.add('ai.the-sunmoon.site');
    hosts.add('the-sunmoon.site');

    // Learn likely hosts from current cache entries.
    for (const value of urlCache.values()) {
        const candidate = value && value.streamUrl ? String(value.streamUrl) : '';
        if (!candidate) continue;
        try {
            const h = new URL(candidate.split('#')[0]).hostname;
            if (h) hosts.add(h);
        } catch (_) {}
    }

    const configuredHosts = String(process.env.DLSTREAMS_LOOKUP_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const h of configuredHosts) hosts.add(h);

    const ref = refererUrl || `${BASE_URL}/watch.php?id=${cid}`;

    for (const host of hosts) {
        try {
            const lookupUrl = `https://${host}/server_lookup?channel_id=${encodeURIComponent(cid)}`;
            const resp = await fetch(lookupUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': getRandomUA(),
                    'Accept': 'application/json,text/plain,*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': ref,
                    'Origin': BASE_URL,
                    'X-Requested-With': 'XMLHttpRequest'
                },
                agent: lookupUrl.startsWith('https://') ? globalHttpsAgent : globalHttpAgent,
                timeout: 8000
            });
            if (!resp.ok) continue;

            const data = await resp.json().catch(() => null);
            const serverKey = data && data.server_key ? String(data.server_key).trim() : '';
            if (!serverKey) continue;

            const monoUrl = buildMonoUrlFromLookup(host, serverKey, cid);
            if (!monoUrl || !isValidStreamUrl(monoUrl)) continue;

            const valid = await validateStreamUrlFast(monoUrl, 5000);
            if (!valid) continue;

            console.log(`  [*] Resolved stream via direct server_lookup fallback (${host}): ${monoUrl}`);
            return monoUrl;
        } catch (_) {
            // Try next host
        }
    }

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

async function resolveRedirectedStreamUrl(page, candidateUrl, visited = new Set(), refererUrl = null) {
    if (!candidateUrl || visited.has(candidateUrl) || visited.size > 6) {
        return null;
    }
    visited.add(candidateUrl);

    if (isValidStreamUrl(candidateUrl)) {
        return candidateUrl;
    }

    if (!isResolvableIntermediateUrl(candidateUrl)) {
        return null;
    }

    if (PREMIUMTV_WRAPPER_REGEX.test(candidateUrl)) {
        const httpResolved = await resolveViaHttpProbe(candidateUrl, new Set(visited), refererUrl || `${BASE_URL}/`).catch(() => null);
        if (httpResolved && isValidStreamUrl(httpResolved)) {
            return httpResolved;
        }
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
        if (refererUrl) {
            let origin = BASE_URL;
            try {
                origin = new URL(refererUrl).origin;
            } catch (_) {}
            await page.setExtraHTTPHeaders({
                'Referer': refererUrl,
                'Origin': origin,
                'Accept-Language': 'en-US,en;q=0.9'
            }).catch(() => {});
        }

        await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

        if (!resultUrl) {
            try {
                const content = await page.content();
                resultUrl = findStreamUrlInText(content);

                if (!resultUrl) {
                    const nestedCandidate =
                        findWrapperUrlInText(content) ||
                        findPremiumTvUrlInText(content, fallbackUrl);

                    if (nestedCandidate && !visited.has(nestedCandidate)) {
                        const nestedResolved = await resolveRedirectedStreamUrl(page, nestedCandidate, visited, fallbackUrl);
                        if (nestedResolved) {
                            resultUrl = nestedResolved;
                        }
                    }
                }
            } catch (e) {}
        }

        if (!resultUrl) {
            try {
                for (const frame of page.frames()) {
                    const frameUrl = frame.url();
                    if (!frameUrl || frameUrl.includes('about:blank')) continue;

                    if (isValidStreamUrl(frameUrl)) {
                        resultUrl = frameUrl;
                        break;
                    }

                    if (isResolvableIntermediateUrl(frameUrl) && !visited.has(frameUrl)) {
                        const nestedFromFrame = await resolveRedirectedStreamUrl(page, frameUrl, visited, fallbackUrl);
                        if (nestedFromFrame) {
                            resultUrl = nestedFromFrame;
                            break;
                        }
                    }
                }
            } catch (_) {
                // ignore frame traversal errors
            }
        }

        if (resultUrl && isResolvableIntermediateUrl(resultUrl)) {
            const nested = await resolveRedirectedStreamUrl(page, resultUrl, visited, fallbackUrl);
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
    channelId = String(channelId);
    const forceRefresh = options.forceRefresh === true;
    const validateCache = options.validateCache === true;
    const bypassFailureCache = options.bypassFailureCache === true;
    // 1. Check cache first
    const cached = urlCache.get(channelId);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        if (isValidStreamUrl(cached.streamUrl)) {
            const isCachedMono = /\/mono\.(css|csv)(\?|$)/i.test((cached.streamUrl || '').split('#')[0]);
            const shouldQuickValidateMono = isCachedMono && !validateCache;
            if (validateCache || shouldQuickValidateMono) {
                const checkTimeoutMs = validateCache ? CACHE_VALIDATE_TIMEOUT_MS : 2500;
                const isAlive = await validateStreamUrlFast(cached.streamUrl, checkTimeoutMs);
                if (!isAlive) {
                    console.log(`  [*] Cache URL validation failed for channel ${channelId}; forcing fresh resolve.`);
                    urlCache.delete(channelId);
                } else {
                    console.log(`  [*] Cache hit for channel ${channelId} (${shouldQuickValidateMono ? 'quick-validated mono' : 'validated'})`);
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
    if (!forceRefresh && !bypassFailureCache && failure && (Date.now() - failure.timestamp) < FAILURE_TTL_MS) {
        console.log(`  [*] Skipping channel ${channelId} due to recent failure.`);
        return { streamUrl: null, ckParam: null, cached: false };
    }

    const playerUrl = channelId.startsWith('http') ? channelId : `${BASE_URL}/watch.php?id=${channelId}`;
    let streamUrl = null;
    let wrapperUrl = null;
    let ckParam = null;
    let requestHeaders = null;
    let shouldCacheResolvedUrl = true;
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
            } else if (!wrapperUrl && isResolvableIntermediateUrl(url)) {
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
                    if (!wrapperUrl && isResolvableIntermediateUrl(src)) {
                        wrapperUrl = src;
                    }

                    // Deep same-origin frame scan: parse frame HTML for hidden stream/wrapper links.
                    // Many providers inject URLs inside inline scripts rather than issuing direct media requests.
                    let frameHtml = null;
                    try {
                        frameHtml = await frame.content();
                    } catch (_) {
                        frameHtml = null;
                    }

                    if (frameHtml) {
                        const frameMedia = findStreamUrlInText(frameHtml);
                        if (!streamUrl && frameMedia && isValidStreamUrl(frameMedia)) {
                            streamUrl = frameMedia;
                            break;
                        }

                        const frameWrapper = findWrapperUrlInText(frameHtml) || findPremiumTvUrlInText(frameHtml, src);
                        if (!wrapperUrl && frameWrapper && isResolvableIntermediateUrl(frameWrapper)) {
                            wrapperUrl = frameWrapper;
                        }
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
            await page.goto(playerUrl, { waitUntil: 'networkidle2', timeout: 25000 });
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
                await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
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
        // 3a. Fallback: try all player button variants by switching iframe src in-page
        if (!streamUrl) {
            try {
                const playerButtons = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('.player-btn[data-url]'))
                        .map(b => b.getAttribute('data-url'))
                        .filter(Boolean);
                }).catch(() => []);

                const candidates = Array.from(new Set([
                    ...(wrapperUrl ? buildWrapperCandidates(wrapperUrl) : []),
                    ...playerButtons
                ])).filter(u => isResolvableIntermediateUrl(u));

                for (const candidate of candidates) {
                    if (streamUrl) break;

                    // Mimic user switching player variant from the watch page.
                    await page.evaluate((u) => {
                        const ifr = document.querySelector('#playerFrame');
                        if (ifr) ifr.src = u;
                    }, candidate).catch(() => {});

                    await new Promise(r => setTimeout(r, 1800));
                    await checkFrames();
                    if (streamUrl) break;

                    const resolvedVariant = await resolveRedirectedStreamUrl(page, candidate, new Set(), playerUrl).catch(() => null);
                    if (resolvedVariant && isValidStreamUrl(resolvedVariant)) {
                        console.log(`  [*] Resolved via player variant fallback: ${resolvedVariant}`);
                        streamUrl = resolvedVariant;
                        break;
                    }
                }
            } catch (_) {
                // ignore fallback errors
            }
        }

        // 3b. Diagnostic dump on failure
        if (!streamUrl && wrapperUrl) {
            for (const candidate of buildWrapperCandidates(wrapperUrl)) {
                const wrapperResolved = await resolveRedirectedStreamUrl(page, candidate, new Set(), playerUrl).catch(() => null);
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
            const resolved = await resolveRedirectedStreamUrl(page, streamUrl, new Set(), playerUrl).catch(() => null);
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
                    const premiumTvFallback = findPremiumTvUrlInText(html, playerUrl);
                    const blockedReloadFallback = extractChromeBlockedReloadUrl(html);
                    const wrapperOrPremium = wrapperFallback || premiumTvFallback || blockedReloadFallback;
                    if (wrapperOrPremium && isResolvableIntermediateUrl(wrapperOrPremium)) {
                        const fallbackCandidates = STREAM_WRAPPER_REGEX.test(wrapperOrPremium)
                            ? buildWrapperCandidates(wrapperOrPremium)
                            : [wrapperOrPremium];

                        for (const candidate of fallbackCandidates) {
                            const resolvedFromHtml = await resolveRedirectedStreamUrl(page, candidate, new Set(), playerUrl).catch(() => null);
                            if (resolvedFromHtml && isValidStreamUrl(resolvedFromHtml)) {
                                console.log(`  [*] Resolved stream URL from HTML wrapper fallback: ${resolvedFromHtml}`);
                                streamUrl = resolvedFromHtml;
                                break;
                            }
                        }
                    }

                    if (!streamUrl && blockedReloadFallback && isResolvableIntermediateUrl(blockedReloadFallback)) {
                        const httpResolved = await resolveViaHttpProbe(blockedReloadFallback, new Set(), playerUrl).catch(() => null);
                        if (httpResolved && isValidStreamUrl(httpResolved)) {
                            console.log(`  [*] Resolved stream URL via HTTP probe fallback: ${httpResolved}`);
                            streamUrl = httpResolved;
                        }
                    }
                }
            } catch (e) { }
        }

        if (!streamUrl) {
            // Fallback A: plain HTTP fetch of the watch page — parses CHANNEL_KEY + M3U8_SERVER
            // without needing a full browser render. Works when the bot-blocker only targets
            // Puppeteer/headless UA but serves the HTML to regular HTTP requests.
            const httpWatchResolved = await resolveViaHttpProbe(playerUrl, new Set(), `${BASE_URL}/`).catch(() => null);
            if (httpWatchResolved && isValidStreamUrl(httpWatchResolved)) {
                console.log(`  [*] Resolved via HTTP watch-page probe fallback: ${httpWatchResolved}`);
                streamUrl = httpWatchResolved;
            }
        }

        if (!streamUrl) {
            // Fallback B: direct server_lookup API call on all known CDN hosts
            const directLookupStream = await resolveDirectChannelLookup(channelId, playerUrl).catch(() => null);
            if (directLookupStream) {
                streamUrl = directLookupStream;
            }
        }

        if (streamUrl) {
            const isMonoMasquerade = /\/mono\.(css|csv)(\?|$)/i.test((streamUrl || '').split('#')[0]);
            if (isMonoMasquerade) {
                const monoLooksValid = await validateStreamUrlFast(streamUrl, 6000);
                if (!monoLooksValid) {
                    // Do not hard-fail on suspicious mono here: some channels expose mixed
                    // manifests that still play. We avoid polluting cache, but return the URL
                    // and let proxy/runtime checks decide.
                    console.log(`  [!] Suspicious mono manifest for channel ${channelId}; returning URL without caching.`);
                    shouldCacheResolvedUrl = false;
                }
            }
        }

        if (streamUrl && shouldCacheResolvedUrl) {
            urlCache.set(channelId, { streamUrl, ckParam, requestHeaders, timestamp: Date.now() });
            saveUrlCache();
        } else if (!streamUrl) {
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
    channelId = String(channelId);
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
