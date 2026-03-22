/**
 * SportsOnline.st Scraper
 * Fetches prog.txt schedule and 247.txt channel list,
 * resolves stream URLs from embed pages, and generates M3U playlist.
 * Completely standalone — no Puppeteer needed (plain HTTP).
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const PROG_URL = 'https://sportsonline.st/prog.txt';
const CHANNELS_247_URL = 'https://w2.sportzsonline.click//247.txt';

const DATA_DIR = path.join(__dirname, '../../data/scraper');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PLAYLIST_FILE = path.join(DATA_DIR, 'sportsonline.m3u');
const HISTORY_FILE = path.join(DATA_DIR, 'sportsonline_history.json');

const CONCURRENCY = parseInt(process.env.SCRAPER_CONCURRENCY) || 4;
const RUN_TYPE = process.env.SCRAPER_RUN_TYPE || 'manual';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchText(url, retries = 2, referer = null) {
    for (let i = 0; i <= retries; i++) {
        try {
            const headers = { 'User-Agent': UA };
            if (referer) headers['Referer'] = referer;
            const res = await fetch(url, {
                headers,
                timeout: 15000
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (err) {
            if (i === retries) throw err;
            await sleep(1000 * (i + 1));
        }
    }
}

// ── Parse prog.txt ──────────────────────────────────────────

function parseProgTxt(text) {
    const lines = text.split('\n');
    const channels = new Map(); // key = php URL → { name, category, events: [] }
    let currentDay = '';

    for (const raw of lines) {
        const line = raw.trim();

        // Day header: SUNDAY, MONDAY, etc.
        if (/^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)$/i.test(line)) {
            currentDay = line;
            continue;
        }

        // Event line: HH:MM  Event Name | https://...php
        const eventMatch = line.match(/^(\d{1,2}:\d{2})\s+(.+?)\s*\|\s*(https?:\/\/.+\.php)\s*$/);
        if (eventMatch) {
            const [, time, eventName, url] = eventMatch;
            // Normalise URL
            const normUrl = url.replace(/\s/g, '');

            // Derive channel name from URL path: /channels/hd/hd1.php → HD1
            const pathMatch = normUrl.match(/\/channels\/([^/]+)\/([^/]+)\.php/i);
            let channelName = pathMatch ? pathMatch[2].toUpperCase() : normUrl;
            let category = pathMatch ? pathMatch[1].toUpperCase() : 'OTHER';

            if (!channels.has(normUrl)) {
                channels.set(normUrl, {
                    name: channelName,
                    category,
                    url: normUrl,
                    events: []
                });
            }
            channels.get(normUrl).events.push({ day: currentDay, time, name: eventName });
            continue;
        }
    }

    return channels;
}

// ── Parse 247.txt ───────────────────────────────────────────

function parse247Txt(text) {
    const lines = text.split('\n');
    const channels = new Map();

    for (const raw of lines) {
        const line = raw.trim();
        // Format: CHANNEL NAME - https://...php
        const match = line.match(/^(.+?)\s*-\s*(https?:\/\/.+\.php)\s*$/);
        if (match) {
            const [, name, url] = match;
            const normUrl = url.replace(/\s/g, '');
            if (!channels.has(normUrl)) {
                channels.set(normUrl, {
                    name: name.trim(),
                    category: '24/7',
                    url: normUrl,
                    events: [{ day: '24/7', time: '24/7', name: name.trim() }]
                });
            }
        }
    }

    return channels;
}

// ── Extract stream URL from a channel PHP page ──────────────

async function resolveStreamFromPhp(phpUrl) {
    // Step 1: Fetch PHP page → extract iframe src (dynamicsnake.net embed)
    const phpHtml = await fetchText(phpUrl);
    const iframeMatch = phpHtml.match(/iframe[^>]+src=["']([^"']*dynamicsnake\.net[^"']*)/i)
        || phpHtml.match(/iframe[^>]+src=["'](https?:\/\/[^"']+\/embed\/[^"']+)/i);

    if (!iframeMatch) {
        // Some pages may use a different embed pattern
        const srcMatch = phpHtml.match(/(?:var\s+)?src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
        if (srcMatch) return { streamUrl: srcMatch[1], embedUrl: phpUrl };
        throw new Error('No iframe/embed found');
    }

    let embedUrl = iframeMatch[1];
    // Some iframes have protocol-relative URLs
    if (embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl;

    // Step 2: Fetch embed page → extract var src = "..."
    const embedHtml = await fetchText(embedUrl, 2, phpUrl);
    const srcMatch = embedHtml.match(/var\s+src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
    if (!srcMatch) {
        throw new Error('No stream src found in embed page');
    }

    return { streamUrl: srcMatch[1], embedUrl };
}

// ── Concurrency-limited batch resolver ──────────────────────

async function resolveAll(channelEntries, concurrency) {
    const results = new Map();
    const queue = [...channelEntries];
    let resolved = 0;
    let failed = 0;

    async function worker() {
        while (queue.length > 0) {
            const [url, info] = queue.shift();
            try {
                const result = await resolveStreamFromPhp(url);
                results.set(url, { ...info, streamUrl: result.streamUrl, embedUrl: result.embedUrl });
                resolved++;
                console.log(`[+] (${resolved}/${resolved + failed + queue.length}) ${info.name}: OK`);
            } catch (err) {
                failed++;
                console.log(`[-] (${resolved + failed}/${resolved + failed + queue.length}) ${info.name}: ${err.message}`);
                results.set(url, { ...info, streamUrl: null, error: err.message });
            }
            // Small delay between requests to be respectful
            await sleep(300);
        }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    return { results, resolved, failed };
}

// ── Build M3U ───────────────────────────────────────────────

function buildM3U(resolvedChannels) {
    const lines = ['#EXTM3U'];

    // Sort by category, then name
    const sorted = [...resolvedChannels.values()]
        .filter(ch => ch.streamUrl)
        .sort((a, b) => {
            if (a.category !== b.category) return a.category.localeCompare(b.category);
            return a.name.localeCompare(b.name);
        });

    for (const ch of sorted) {
        // Pick the most relevant event description
        const eventDesc = ch.events.length > 0
            ? ch.events.map(e => `${e.time} ${e.name}`).join(' | ')
            : ch.name;

        // Truncate long descriptions
        const desc = eventDesc.length > 200 ? eventDesc.substring(0, 197) + '...' : eventDesc;

        lines.push(`#EXTINF:-1 tvg-name="${ch.name}" group-title="${ch.category}",${ch.name} - ${desc}`);

        // Store the PHP page URL (not the resolved CDN URL) because CDN tokens
        // are IP-bound and expire. The proxy resolves fresh URLs on-demand.
        lines.push(ch.url);
    }

    return lines.join('\n');
}

// ── Main scraper entry point ────────────────────────────────

async function scrape() {
    const startTime = Date.now();
    console.log(`[*] Starting SportsOnline scraper (${RUN_TYPE})...`);
    console.log(`[*] Concurrency: ${CONCURRENCY}`);

    // 1. Fetch prog.txt
    console.log(`[*] Fetching prog.txt from ${PROG_URL}...`);
    let progText;
    try {
        progText = await fetchText(PROG_URL);
    } catch (err) {
        console.error(`[FATAL] Could not fetch prog.txt: ${err.message}`);
        process.exit(1);
    }

    const progChannels = parseProgTxt(progText);
    console.log(`[*] Parsed ${progChannels.size} unique channels from prog.txt`);

    // 2. Fetch 247.txt
    console.log(`[*] Fetching 247.txt from ${CHANNELS_247_URL}...`);
    let channels247 = new Map();
    try {
        const text247 = await fetchText(CHANNELS_247_URL);
        channels247 = parse247Txt(text247);
        console.log(`[*] Parsed ${channels247.size} channels from 247.txt`);
    } catch (err) {
        console.warn(`[!] Could not fetch 247.txt: ${err.message} — continuing with prog.txt only`);
    }

    // 3. Merge, de-duplicate by URL
    const allChannels = new Map([...progChannels]);
    for (const [url, info] of channels247) {
        if (!allChannels.has(url)) {
            allChannels.set(url, info);
        }
    }
    console.log(`[*] Total unique channels to resolve: ${allChannels.size}`);

    // 4. Resolve stream URLs
    console.log(`[*] Resolving stream URLs (concurrency: ${CONCURRENCY})...`);
    const { results, resolved, failed } = await resolveAll(allChannels, CONCURRENCY);

    // 5. Build M3U
    const m3u = buildM3U(results);
    fs.writeFileSync(PLAYLIST_FILE, m3u, 'utf8');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[*] Playlist written to ${PLAYLIST_FILE}`);
    console.log(`[*] Results: ${resolved} resolved, ${failed} failed`);
    console.log(`[*] Completed in ${elapsed}s`);

    // 6. Save run history
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { }
    }
    history.unshift({
        timestamp: new Date().toISOString(),
        runType: RUN_TYPE,
        totalChannels: allChannels.size,
        resolved,
        failed,
        elapsedSeconds: parseFloat(elapsed)
    });
    // Keep last 20 runs
    if (history.length > 20) history = history.slice(0, 20);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

scrape().then(() => {
    process.exit(0);
}).catch(err => {
    console.error(`[FATAL] Scraper failed: ${err.message}`);
    process.exit(1);
});
