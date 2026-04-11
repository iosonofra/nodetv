/**
 * hattrick_intercept.js
 * Called by hattrickeventi.py as a subprocess.
 * Usage: node hattrick_intercept.js <url>
 * Outputs JSON to stdout: { "stream": "https://..." } or { "error": "reason" }
 */
'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
const USER_AGENT = process.env.HATTRICKEVENTI_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const REFERRER = process.env.HATTRICKEVENTI_REFERRER || 'https://mediahosting.space/';
const TIMEOUT_MS = (parseInt(process.env.HATTRICKEVENTI_TIMEOUT || '15', 10) + 10) * 1000;

const STREAM_EXTS = ['.m3u8', '.mpd', '.ts'];
const STREAM_PATHS = ['/hls/', '/dash/', '/manifest', '/stream', '/live/'];

function isStreamUrl(url) {
    const lower = url.toLowerCase();
    return STREAM_EXTS.some(e => lower.includes(e)) ||
           STREAM_PATHS.some(p => lower.includes(p));
}

async function intercept(targetUrl) {
    const launchOptions = {
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
               '--disable-blink-features=AutomationControlled'],
    };
    if (fs.existsSync(CHROMIUM_PATH)) {
        launchOptions.executablePath = CHROMIUM_PATH;
    }

    const browser = await puppeteer.launch(launchOptions);
    try {
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setExtraHTTPHeaders({ Referer: REFERRER });

        let streamUrl = null;

        // Returns true if this URL is "better" than the current candidate.
        // Manifests (.m3u8/.mpd) beat raw segments (.ts); never overwrite a manifest.
        function isBetterStream(url) {
            if (!isStreamUrl(url)) return false;
            if (!streamUrl) return true;
            const lower = url.toLowerCase();
            const currentLower = streamUrl.toLowerCase();
            const isManifest = lower.includes('.m3u8') || lower.includes('.mpd');
            const currentIsManifest = currentLower.includes('.m3u8') || currentLower.includes('.mpd');
            // Upgrade .ts → manifest; never downgrade manifest → .ts
            return isManifest && !currentIsManifest;
        }

        // Intercept all requests before they fire
        await page.setRequestInterception(true);
        page.on('request', req => {
            if (isBetterStream(req.url())) {
                streamUrl = req.url();
            }
            req.continue();
        });

        // Also catch responses (covers fetch/XHR that request interception may miss)
        page.on('response', res => {
            if (isBetterStream(res.url())) {
                streamUrl = res.url();
            }
        });

        try {
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: TIMEOUT_MS });
        } catch (_) {
            // timeout acceptable — we may have already captured what we need
        }

        if (!streamUrl) {
            // Give async scripts a moment to fire
            await new Promise(r => setTimeout(r, 4000));
        }

        if (!streamUrl) {
            // Last resort: scan the rendered DOM for stream URLs
            const content = await page.content();
            const m = content.match(
                /["'](https?:\/\/[^"']+\.(?:m3u8|mpd)(?:\?[^"']*)?)['"]/i
            );
            if (m) streamUrl = m[1];
        }

        if (streamUrl) {
            process.stdout.write(JSON.stringify({ stream: streamUrl }) + '\n');
        } else {
            process.stdout.write(JSON.stringify({ error: 'No stream request intercepted' }) + '\n');
        }
    } finally {
        await browser.close();
    }
}

const url = process.argv[2];
if (!url) {
    process.stdout.write(JSON.stringify({ error: 'No URL argument provided' }) + '\n');
    process.exit(1);
}

intercept(url).catch(err => {
    process.stdout.write(JSON.stringify({ error: String(err.message || err) }) + '\n');
    process.exit(1);
});
