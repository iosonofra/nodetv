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

// Import shared resolver functions
const {
    extractStreamUrl,
    decodeClearKey,
    getLaunchOptions,
    BASE_URL,
    CHROMIUM_PATH
} = require('../services/dlstreamsResolver');

const SCHEDULE_URL = `${BASE_URL}/`;

// Only scrape soccer/football events
const SOCCER_KEYWORDS = ['soccer', 'football', 'calcio', 'fútbol', 'fußball', 'serie a', 'premier league', 'la liga', 'bundesliga', 'ligue 1', 'champions league', 'europa league', 'conference league', 'copa', 'mls', 'eredivisie', 'primeira liga', 'süper lig'];

// Output paths
const DATA_DIR = path.join(__dirname, "../../data/scraper");
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PLAYLIST_FILE = path.join(DATA_DIR, "dlstreams.m3u");
const HISTORY_FILE = path.join(DATA_DIR, "dlstreams_history.json");

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


async function scrape() {
    const startTime = Date.now();
    const runType = process.env.SCRAPER_RUN_TYPE || 'manual';
    console.log(`[*] Starting DLStreams Scraper (${runType})...`);

    let browser;
    try {
        const launchOptions = getLaunchOptions();
        if (launchOptions.executablePath) {
            console.log(`[*] Using Chromium at: ${launchOptions.executablePath}`);
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");

        // Step 1: Parse schedule
        const allEvents = await parseSchedule(page);

        // Step 1.5: Filter to soccer/football only
        const events = allEvents.filter(event => {
            const cat = (event.category || '').toLowerCase();
            const title = (event.title || '').toLowerCase();
            return SOCCER_KEYWORDS.some(kw => cat.includes(kw) || title.includes(kw));
        });

        console.log(`[*] Filtered to ${events.length} soccer events (from ${allEvents.length} total).`);

        if (events.length === 0) {
            console.log("[!] No soccer events found in schedule.");
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
