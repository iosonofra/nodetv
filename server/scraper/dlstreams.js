/**
 * DLStreams Event Scraper
 * Fetches daily schedule from dlstreams.top and extracts stream URLs
 * Completely separate from the thisnotbusiness scraper
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const BASE_URL = "https://dlstreams.top";
const SCHEDULE_URL = `${BASE_URL}/`;

// Output paths
const DATA_DIR = path.join(__dirname, "../../data/scraper");
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PLAYLIST_FILE = path.join(DATA_DIR, "dlstreams.m3u");
const HISTORY_FILE = path.join(DATA_DIR, "dlstreams_history.json");

// Optional custom Chromium path (useful for Linux/Docker)
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";

/**
 * Parse schedule page and extract events with channel info
 * Returns: [{ category, title, time, channels: [{ name, id, url }] }]
 */
async function parseSchedule(page) {
    console.log(`[*] Fetching schedule from ${SCHEDULE_URL}...`);
    await page.goto(SCHEDULE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Extract events from the schedule HTML
    const events = await page.evaluate((baseUrl) => {
        const results = [];
        // The schedule is organized with category headers and event rows
        // Each event has a time, title, and channel links
        const rows = document.querySelectorAll('tr');
        let currentCategory = 'Events';

        for (const row of rows) {
            // Check for category header
            const categoryHeader = row.querySelector('td.competition-cell, td[colspan]');
            if (categoryHeader) {
                const catText = categoryHeader.textContent.trim();
                if (catText && !catText.includes('Time') && catText.length > 1 && catText.length < 100) {
                    currentCategory = catText;
                    continue;
                }
            }

            // Extract event data from table rows
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) continue;

            // Try to find time, event name, and channel links
            let time = '';
            let eventTitle = '';
            const channels = [];

            for (const cell of cells) {
                const text = cell.textContent.trim();

                // Time detection (HH:MM format)
                if (/^\d{1,2}:\d{2}/.test(text) && !time) {
                    time = text.match(/\d{1,2}:\d{2}/)[0];
                    continue;
                }

                // Channel links
                const links = cell.querySelectorAll('a[href*="watch.php"]');
                if (links.length > 0) {
                    links.forEach(link => {
                        const href = link.getAttribute('href');
                        const idMatch = href.match(/id=(\d+)/);
                        if (idMatch) {
                            channels.push({
                                name: link.textContent.trim(),
                                id: idMatch[1],
                                url: href.startsWith('http') ? href : baseUrl + '/' + href.replace(/^\//, '')
                            });
                        }
                    });
                    continue;
                }

                // Event title (non-time, non-channel text)
                if (text && text.length > 2 && !time && channels.length === 0) {
                    eventTitle = text;
                }
            }

            // If no event title found from dedicated cell, try the row text
            if (!eventTitle && cells.length >= 2) {
                eventTitle = cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim() || '';
                // Clean up - remove channel names from event title
                channels.forEach(ch => {
                    eventTitle = eventTitle.replace(ch.name, '').trim();
                });
            }

            if (channels.length > 0) {
                results.push({
                    category: currentCategory,
                    title: eventTitle || 'Unknown Event',
                    time: time || '',
                    channels
                });
            }
        }

        // Fallback: if table parsing didn't work, try extracting all watch.php links
        if (results.length === 0) {
            const allLinks = document.querySelectorAll('a[href*="watch.php"]');
            const seenIds = new Set();

            allLinks.forEach(link => {
                const href = link.getAttribute('href');
                const idMatch = href.match(/id=(\d+)/);
                if (idMatch && !seenIds.has(idMatch[1])) {
                    seenIds.add(idMatch[1]);
                    results.push({
                        category: 'Events',
                        title: link.textContent.trim(),
                        time: '',
                        channels: [{
                            name: link.textContent.trim(),
                            id: idMatch[1],
                            url: href.startsWith('http') ? href : baseUrl + '/' + href.replace(/^\//, '')
                        }]
                    });
                }
            });
        }

        return results;
    }, BASE_URL);

    console.log(`[*] Found ${events.length} events with channels.`);
    return events;
}

/**
 * Visit a player page and intercept stream URL (m3u8/mpd)
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

    // Passive listeners
    const requestHandler = request => {
        const url = request.url();
        if ((url.includes('.mpd') || url.includes('.m3u8')) && !url.toLowerCase().includes('ad')) {
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
                    if (src && (src.includes('.mpd') || src.includes('.m3u8')) && !streamUrl) {
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
                        if ((src.includes('.mpd') || src.includes('.m3u8')) && !streamUrl) {
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

async function scrape() {
    const startTime = Date.now();
    const runType = process.env.SCRAPER_RUN_TYPE || 'manual';
    console.log(`[*] Starting DLStreams Scraper (${runType})...`);

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

        // Step 1: Parse schedule
        const events = await parseSchedule(page);

        if (events.length === 0) {
            console.log("[!] No events found in schedule.");
        }

        const m3uLines = ["#EXTM3U"];
        const processedChannels = new Set(); // Avoid duplicate channel visits

        // Step 2: For each event, visit channel player pages
        let eventIdx = 0;
        for (const event of events) {
            eventIdx++;

            for (const channel of event.channels) {
                // Skip if we already processed this channel ID
                if (processedChannels.has(channel.id)) {
                    // Still add to M3U with cached data if available
                    continue;
                }

                console.log(`[${eventIdx}/${events.length}] Processing: ${event.title} - ${channel.name} (ID: ${channel.id})...`);

                const { streamUrl, ckParam } = await extractStreamUrl(page, channel.id);
                processedChannels.add(channel.id);

                if (streamUrl) {
                    let finalUrl = streamUrl;

                    // Handle chrome-extension wrapper
                    if (finalUrl.startsWith("chrome-extension://")) {
                        if (finalUrl.includes("#")) {
                            finalUrl = finalUrl.split("#")[1];
                        }
                    }

                    // Decode DRM keys
                    let keysStr = "";
                    let extractedCk = ckParam;
                    if (!extractedCk && finalUrl.includes("ck=")) {
                        try {
                            const parts = finalUrl.split("ck=");
                            if (parts.length > 1) extractedCk = parts[1].split("&")[0];
                        } catch (err) { }
                    }

                    if (extractedCk) {
                        try {
                            let cleanCk = extractedCk;
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

                    const group = event.category || "Events";
                    const name = event.time
                        ? `${event.title} (${event.time}) - ${channel.name}`
                        : `${event.title} - ${channel.name}`;

                    m3uLines.push(`#EXTINF:-1 tvg-id="dl_${channel.id}" tvg-logo="" group-title="${group}" category-id="${group}", ${name}`);
                    if (keysStr) {
                        m3uLines.push(`#KODIPROP:inputstream.adaptive.license_type=clearkey`);
                        m3uLines.push(`#KODIPROP:inputstream.adaptive.license_key=${keysStr}`);
                    }
                    m3uLines.push(finalUrl);
                    console.log(`  [v] Successfully added channel.`);
                } else {
                    console.log(`  [-] No stream URL found for channel ${channel.name} (ID: ${channel.id})`);
                }
            }
        }

        // Save Playlist
        fs.writeFileSync(PLAYLIST_FILE, m3uLines.join("\n"), 'utf8');
        if (m3uLines.length > 1) {
            console.log(`[*] Successfully saved playlist with ${m3uLines.length - 1} entries to: ${PLAYLIST_FILE}`);
        } else {
            console.log(`[*] Saved empty playlist to: ${PLAYLIST_FILE}`);
        }

        // Save History
        const duration = Math.floor((Date.now() - startTime) / 1000);
        let count = 0;
        for (const line of m3uLines) if (line.startsWith('#EXTINF')) count++;

        const runData = {
            timestamp: new Date().toISOString(),
            success: true,
            type: runType,
            duration: duration,
            channelsCount: count,
            message: `Generated ${count} channels from ${events.length} events.`
        };

        updateHistory(runData);

    } catch (err) {
        console.error(`[!] Critical Error: ${err.message}`);
        const duration = Math.floor((Date.now() - startTime) / 1000);
        updateHistory({
            timestamp: new Date().toISOString(),
            success: false,
            type: runType,
            duration: duration,
            channelsCount: 0,
            error: err.message
        });
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

function updateHistory(runData) {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch (e) { }
    }
    history.unshift(runData);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 20), null, 4), 'utf8');
}

scrape();
