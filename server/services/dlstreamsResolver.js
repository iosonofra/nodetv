/**
 * DLStreams URL Resolver
 * Shared module for extracting fresh stream URLs from DLStreams watch pages.
 * Used by both the scraper (bulk) and the on-demand resolver (single channel).
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const BASE_URL = "https://dlstreams.top";

// Optional custom Chromium path (useful for Linux/Docker)
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";

// In-memory cache for resolved URLs (channelId -> { streamUrl, ckParam, timestamp })
const urlCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Get Puppeteer launch options
 */
function getLaunchOptions() {
    const opts = {
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };

    if (fs.existsSync(CHROMIUM_PATH)) {
        opts.executablePath = CHROMIUM_PATH;
    }

    return opts;
}

/**
 * Visit a player page and intercept stream URL (m3u8/mpd)
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 * @param {string} channelId - DLStreams channel ID
 * @returns {{ streamUrl: string|null, ckParam: string|null }}
 */
async function extractStreamUrl(page, channelId) {
    const playerUrl = `${BASE_URL}/watch.php?id=${channelId}`;
    let streamUrl = null;
    let ckParam = null;

    // Monitor script for fetch/XHR interception
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
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function() {
            const url = arguments[1];
            if (typeof url === 'string' && !url.includes('s3.dualstack') && (url.includes('.mpd') || url.includes('.m3u8') || url.includes('mono.css') || url.includes('mono.csv'))) {
                console.log('INTERCEPT_URL:' + url);
            }
            return originalOpen.apply(this, arguments);
        };
    })();
    `;

    // Passive listeners
    const requestHandler = request => {
        const url = request.url();
        if (!url.includes('s3.dualstack') && (url.includes('.mpd') || url.includes('.m3u8') || url.includes('mono.css') || url.includes('mono.csv')) && !url.toLowerCase().includes('ad')) {
            if (!streamUrl) {
                console.log(`  [+] Intercepted from request: ${url}`);
                streamUrl = url;

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
            if (!streamUrl) {
                console.log(`  [+] Intercepted from console: ${url}`);
                streamUrl = url;

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
        await page.evaluateOnNewDocument(MONITOR_SCRIPT);
        await page.goto(playerUrl, { waitUntil: 'load', timeout: 45000 });
        await new Promise(r => setTimeout(r, 10000)); // Wait for video to load

        // Check all frames for manifests
        const checkFrames = async () => {
            for (const frame of page.frames()) {
                try {
                    const src = frame.url();
                    if (src && !src.includes('s3.dualstack') && (src.includes('.mpd') || src.includes('.m3u8') || src.includes('mono.css') || src.includes('mono.csv')) && !streamUrl) {
                        console.log(`  [+] Found manifest in frame URL: ${src}`);
                        streamUrl = src;
                        break;
                    }
                } catch (e) { }
            }

            if (!streamUrl) {
                try {
                    const iframeSrcs = await page.evaluate(() => {
                        return Array.from(document.querySelectorAll('iframe'))
                            .map(f => f.getAttribute('src'))
                            .filter(s => s);
                    });

                    for (let src of iframeSrcs) {
                        if (src.startsWith("//")) src = "https:" + src;
                        if (!src.includes('s3.dualstack') && (src.includes('.mpd') || src.includes('.m3u8') || src.includes('mono.css') || src.includes('mono.csv')) && !streamUrl) {
                            console.log(`  [+] Found manifest in iframe DOM src: ${src}`);
                            streamUrl = src;
                            break;
                        }
                    }
                } catch (e) { }
            }
        };

        await checkFrames();

        // Click in center to trigger playback if needed
        if (!streamUrl) {
            await page.mouse.click(640, 360);
            await new Promise(r => setTimeout(r, 3000));
            await checkFrames();
        }

        if (!streamUrl) {
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

    return { streamUrl, ckParam };
}

/**
 * Resolve a single channel URL on-demand with caching
 * Launches its own browser, resolves the URL, closes the browser.
 * @param {string} channelId - DLStreams channel ID (numeric string)
 * @returns {{ streamUrl: string|null, ckParam: string|null, cached: boolean }}
 */
async function resolveChannelUrl(channelId) {
    // Check cache first
    const cached = urlCache.get(channelId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        console.log(`[DLStreams Resolver] Cache hit for channel ${channelId}`);
        return { streamUrl: cached.streamUrl, ckParam: cached.ckParam, cached: true };
    }

    console.log(`[DLStreams Resolver] Resolving fresh URL for channel ${channelId}...`);

    let browser;
    try {
        browser = await puppeteer.launch(getLaunchOptions());
        const page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
        );

        const result = await extractStreamUrl(page, channelId);

        // Handle chrome-extension wrapper
        if (result.streamUrl && result.streamUrl.startsWith("chrome-extension://")) {
            if (result.streamUrl.includes("#")) {
                result.streamUrl = result.streamUrl.split("#")[1];
            }
        }

        // Cache the result
        if (result.streamUrl) {
            urlCache.set(channelId, {
                streamUrl: result.streamUrl,
                ckParam: result.ckParam,
                timestamp: Date.now()
            });
        }

        console.log(`[DLStreams Resolver] Channel ${channelId}: ${result.streamUrl ? 'OK' : 'No URL found'}`);
        return { ...result, cached: false };

    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Decode ClearKey parameter to key string
 * @param {string} ckParam - base64 encoded ClearKey parameter
 * @returns {string} key string in KID:KEY format
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
            } else {
                return Object.entries(ckJson).filter(([k, v]) => k.length > 10).map(([k, v]) => `${k}:${v}`).join(",");
            }
        } catch (e) {
            if (decoded.includes(":")) return decoded;
        }
    } catch (e) {
        console.error(`[DLStreams Resolver] Error decoding ClearKey: ${e.message}`);
    }

    return '';
}

/**
 * Fetch available categories from DLStreams homepage
 * Scrapes the navigation/filter bar for category links
 * @returns {Array<{name: string, slug: string}>}
 */
async function fetchCategories() {
    console.log('[DLStreams Resolver] Fetching categories from homepage...');
    let browser;
    try {
        browser = await puppeteer.launch(getLaunchOptions());
        const page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
        );

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
                    // Skip duplicates and "All" type entries
                    if (!seen.has(slug) && slug !== 'All' && slug !== 'Upcoming Events' && slug !== 'TV Shows') {
                        seen.add(slug);
                        results.push({
                            name: link.textContent.trim(),
                            slug: slug
                        });
                    }
                }
            }
            return results;
        });

        console.log(`[DLStreams Resolver] Found ${categories.length} categories.`);
        return categories;
    } finally {
        if (browser) await browser.close();
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
