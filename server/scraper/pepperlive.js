/**
 * PepperLive Scraper
 * Fetches channel JSON from pepperlive.info, extracts MPD URLs and ClearKey
 * credentials, and generates an M3U playlist with KODIPROP entries.
 * Pure HTTP — no Puppeteer needed.
 */

const fetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fs = require('fs');
const path = require('path');
const url = require('url');

// SOCKS5 proxy agent (e.g. Cloudflare Warp)
const PROXY_URL = process.env.SOCKS_PROXY_URL || null;
const proxyAgent = PROXY_URL ? new SocksProxyAgent(PROXY_URL, { tls: { rejectUnauthorized: false } }) : null;
if (PROXY_URL) console.log(`[*] Using SOCKS5 proxy: ${PROXY_URL}`);

const DATA_DIR = path.join(__dirname, '../../data/scraper');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PLAYLIST_FILE = path.join(DATA_DIR, 'pepperlive.m3u');
const HISTORY_FILE = path.join(DATA_DIR, 'pepperlive_history.json');

const RUN_TYPE = process.env.SCRAPER_RUN_TYPE || 'manual';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 12000;

// ── Configuration ────────────────────────────────────────────

const BASE_URLS = [
    'https://pepperlive.info',
    'https://www.pepperlive.info',
];

const POSSIBILI_NOMI = [
    'links.json', 'mpd.json', 'canali.json', 'channels.json',
    'mpd_links.json', 'streams.json', 'data.json', 'config.json',
    'api/links.json', 'api/channels.json', 'api/mpd.json',
    'assets/links.json', 'json/links.json', 'player/links.json',
    'live/links.json', 'update/links.json', 'cdn/links.json',
    'links_v2.json', 'links_new.json', 'canali_mpd.json',
];

const VARIANTI_PATH = ['', 'api/', 'data/', 'assets/', 'json/', 'cdn/', 'update/', 'player/', 'live/'];

const CANALI_RINOMINA = {
    'SPORTUNO':    'Sky Sport Uno',
    'SPORTCALCIO': 'Sky Sport Calcio',
    'SPORTF1':     'Sky Sport F1',
    'SPORTTENNIS': 'Sky Sport Tennis',
    'SPORT251':    'Sky Sport 251',
    'Sport_DAZN':  'DAZN Eventi',
    'Dazn1_WARP':  'DAZN Warp',
    'Canale5':     'Canale 5',
    'Italia1':     'Italia 1',
    'SportTV1':    'Sport TV 1 PT',
    'SportTV2':    'Sport TV 2 PT',
    'SportTV3':    'Sport TV 3 PT',
    'SportTV4':    'Sport TV 4 PT',
    'SportTV5':    'Sport TV 5 PT',
    'Dazn1_PT':    'DAZN 1 PT',
    'Dazn2_PT':    'DAZN 2 PT',
    'Dazn3_PT':    'DAZN 3 PT',
    'Dazn4_PT':    'DAZN 4 PT',
    'TNTSP1':      'TNT Sports 1',
    'TNTSP2':      'TNT Sports 2',
    'NovaSP1':     'Nova Sports 1',
    'NovaSP2':     'Nova Sports 2',
    'BBC1':        'BBC One',
    'ELEVEN1':     'Eleven Sports 1',
    'ELEVEN2':     'Eleven Sports 2',
    'ELEVEN3':     'Eleven Sports 3',
    'ELEVEN4':     'Eleven Sports 4',
    'PRIME':       'Prime Video Sport',
    'LAB1':        'LAB1',
};

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Extract KID and KEY from the base64-encoded ck= parameter.
 * Supports both "kid:key" and JSON {"kid":"...","key":"..."} formats.
 */
function extractKidKey(ckValue) {
    if (!ckValue) return { kid: null, key: null };

    ckValue = ckValue.trim();

    // Try decoding with various padding
    let decoded = null;
    for (const extra of ['', '=', '==', '===']) {
        try {
            decoded = Buffer.from(ckValue + extra, 'base64').toString('utf8');
            break;
        } catch {
            // try next padding
        }
    }

    if (!decoded) return { kid: null, key: null };

    decoded = decoded.trim();
    let kid, key;

    try {
        // Case 1: simple "kid:key" format
        if (decoded.includes(':') && !decoded.startsWith('{')) {
            const parts = decoded.split(':', 2);
            kid = parts[0].trim().toLowerCase();
            key = parts[1].trim().toLowerCase();
        } else {
            // Case 2: JSON format
            const data = JSON.parse(decoded);
            if (typeof data !== 'object' || data === null) return { kid: null, key: null };

            if (data.kid && data.key) {
                kid = data.kid.toLowerCase().replace(/[-_]/g, '');
                key = data.key.toLowerCase().replace(/[-_]/g, '');
            } else {
                // Singleton dict — first pair
                const entries = Object.entries(data);
                if (entries.length === 0) return { kid: null, key: null };
                kid = entries[0][0].toLowerCase().replace(/[-_]/g, '');
                key = entries[0][1].toLowerCase().replace(/[-_]/g, '');
            }
        }
    } catch {
        return { kid: null, key: null };
    }

    // Clean: only hex chars, must be 32 chars
    kid = (kid || '').replace(/[^0-9a-f]/g, '');
    key = (key || '').replace(/[^0-9a-f]/g, '');

    if (kid.length === 32 && key.length === 32) {
        return { kid, key };
    }
    return { kid: null, key: null };
}

/**
 * Remove the ck= query parameter from an MPD URL.
 */
function cleanMpdUrl(fullUrl) {
    const parsed = new URL(fullUrl);
    parsed.searchParams.delete('ck');
    return parsed.toString();
}

/**
 * Fetch JSON from a URL, returning null on failure.
 */
async function fetchJson(targetUrl) {
    try {
        const fetchOpts = {
            headers: {
                'User-Agent': UA,
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
            },
            timeout: TIMEOUT,
        };
        if (proxyAgent) fetchOpts.agent = proxyAgent;
        const res = await fetch(targetUrl, fetchOpts);
        const contentType = res.headers.get('content-type') || '';
        if (res.ok && contentType.toLowerCase().includes('json')) {
            return await res.json();
        }
        return null;
    } catch {
        return null;
    }
}

// ── Main Scraper ────────────────────────────────────────────

async function scrape() {
    const startTime = Date.now();
    console.log(`[*] Starting PepperLive scraper (${RUN_TYPE})...`);

    let jsonData = null;
    let foundUrl = '';
    const ts = Math.floor(Date.now() / 1000);

    // Try all URL combinations to find the channels JSON
    for (const base of BASE_URLS) {
        if (jsonData) break;
        console.log(`[*] Testing base: ${base}`);

        for (const nome of POSSIBILI_NOMI) {
            if (jsonData) break;

            for (const pref of VARIANTI_PATH) {
                if (jsonData) break;
                const pathStr = pref + nome;

                const cacheBusters = ['', `?v=${ts}`, `?_=${ts}`, `?nocache=${ts}`];
                for (const q of cacheBusters) {
                    const tryUrl = `${base.replace(/\/+$/, '')}/${pathStr}${q}`;
                    console.log(`  → ${tryUrl}`);

                    const data = await fetchJson(tryUrl);
                    if (data && typeof data === 'object' && Object.keys(data).length > 0) {
                        console.log(`  ✓ FOUND!`);
                        jsonData = data;
                        foundUrl = tryUrl;
                        break;
                    }
                }
            }
        }
    }

    if (!jsonData) {
        console.error('[FATAL] No channel JSON found on pepperlive.info');
        saveHistory(startTime, false, 0, 'No channel JSON found');
        process.exit(1);
    }

    const channelCount = Object.keys(jsonData).length;
    console.log(`[*] JSON found! ${channelCount} channels from: ${foundUrl}`);

    // Build M3U playlist
    const lines = ['#EXTM3U'];
    let countWithKey = 0;

    for (const [origName, fullUrl] of Object.entries(jsonData)) {
        if (typeof fullUrl !== 'string') continue;

        const displayName = CANALI_RINOMINA[origName] || origName;

        // Clean MPD URL (remove ck= param)
        let cleanUrl;
        try {
            cleanUrl = cleanMpdUrl(fullUrl);
        } catch {
            cleanUrl = fullUrl;
        }

        // Extract ClearKey from ck= parameter
        let kid = null, key = null;
        try {
            const parsed = new URL(fullUrl);
            const ck = parsed.searchParams.get('ck');
            if (ck) {
                ({ kid, key } = extractKidKey(ck));
            }
        } catch {
            // URL parsing failed, use as-is
        }

        lines.push(`#EXTINF:-1 tvg-id="${origName}" tvg-name="${displayName}" group-title="PepperLive",${displayName}`);

        if (kid && key) {
            lines.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
            lines.push(`#KODIPROP:inputstream.adaptive.license_key=${kid}:${key}`);
            countWithKey++;
        }

        lines.push(`#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=${UA}`);
        lines.push(cleanUrl);
    }

    // Write playlist
    fs.writeFileSync(PLAYLIST_FILE, lines.join('\n'), 'utf8');
    console.log(`[✓] Playlist saved: ${PLAYLIST_FILE}`);
    console.log(`[✓] Total channels: ${channelCount}`);
    console.log(`[✓] With ClearKey: ${countWithKey}`);

    // Save history
    saveHistory(startTime, true, channelCount, `Generated ${channelCount} channels (${countWithKey} with ClearKey)`);
}

function saveHistory(startTime, success, channelsCount, message) {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch { /* ignore */ }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    history.unshift({
        timestamp: new Date().toISOString(),
        success,
        type: RUN_TYPE,
        duration,
        channelsCount,
        message,
    });

    // Keep last 20 entries
    if (history.length > 20) history = history.slice(0, 20);

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

// Run
scrape().then(() => {
    console.log('[*] PepperLive scraper finished.');
    process.exit(0);
}).catch(err => {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
});
