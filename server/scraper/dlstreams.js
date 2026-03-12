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

const SCHEDULE_URL = `${BASE_URL}/index.php`;

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
        const eventNodes = document.querySelectorAll('.schedule__event');
        
        for (const ev of eventNodes) {
            // Get category
            const catEl = ev.closest('.schedule__category')?.querySelector('.card__meta');
            const category = catEl ? catEl.textContent.trim() : 'Events';
            
            const timeEl = ev.querySelector('.schedule__time');
            const titleEl = ev.querySelector('.schedule__eventTitle');
            
            const time = timeEl ? timeEl.textContent.trim() : '';
            const title = titleEl ? titleEl.textContent.trim() : 'Unknown Event';
            
            const channelLinks = ev.querySelectorAll('.schedule__channels a[href*="watch.php"]');
            const channels = [];
            
            channelLinks.forEach(link => {
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
            
            if (channels.length > 0) {
                results.push({ category, title, time, channels });
            }
        }
        
        // Fallback for old table structure just in case
        if (results.length === 0) {
            const rows = document.querySelectorAll('tr');
            let currentCategory = 'Events';

            for (const row of rows) {
                const categoryHeader = row.querySelector('td.competition-cell, td[colspan]');
                if (categoryHeader) {
                    const catText = categoryHeader.textContent.trim();
                    if (catText && !catText.includes('Time') && catText.length > 1 && catText.length < 100) {
                        currentCategory = catText;
                        continue;
                    }
                }

                const cells = row.querySelectorAll('td');
                if (cells.length < 2) continue;

                let time = '';
                let eventTitle = '';
                const channels = [];

                for (const cell of cells) {
                    const text = cell.textContent.trim();
                    if (/^\d{1,2}:\d{2}/.test(text) && !time) {
                        time = text.match(/\d{1,2}:\d{2}/)[0];
                        continue;
                    }
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
                    if (text && text.length > 2 && !time && channels.length === 0) {
                        eventTitle = text;
                    }
                }

                if (!eventTitle && cells.length >= 2) {
                    eventTitle = cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim() || '';
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
        }
        
        return results;
    }, BASE_URL);

    console.log(`[*] Found ${events.length} events with channels.`);
    return events;
}

/**
 * Parse a specific category page
 */
async function parseCategoryPage(page, categorySlug) {
    const catUrl = `${BASE_URL}/index.php?cat=${encodeURIComponent(categorySlug).replace(/%20/g, '+')}`;
    console.log(`[*] Fetching category: ${categorySlug} from ${catUrl}...`);

    // Temporarily override the SCHEDULE_URL for parseSchedule-like logic
    await page.goto(catUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const events = await page.evaluate((baseUrl) => {
        const results = [];
        const eventNodes = document.querySelectorAll('.schedule__event');
        
        for (const ev of eventNodes) {
            const catEl = ev.closest('.schedule__category')?.querySelector('.card__meta');
            const category = catEl ? catEl.textContent.trim() : 'Events';
            
            const timeEl = ev.querySelector('.schedule__time');
            const titleEl = ev.querySelector('.schedule__eventTitle');
            
            const time = timeEl ? timeEl.textContent.trim() : '';
            const title = titleEl ? titleEl.textContent.trim() : 'Unknown Event';
            
            const channelLinks = ev.querySelectorAll('.schedule__channels a[href*="watch.php"]');
            const channels = [];
            
            channelLinks.forEach(link => {
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
            
            if (channels.length > 0) {
                results.push({ category, title, time, channels });
            }
        }

        // Fallback table parser
        if (results.length === 0) {
            const rows = document.querySelectorAll('tr');
            let currentCategory = 'Events';
            for (const row of rows) {
                const categoryHeader = row.querySelector('td.competition-cell, td[colspan]');
                if (categoryHeader) {
                    const catText = categoryHeader.textContent.trim();
                    if (catText && !catText.includes('Time') && catText.length > 1 && catText.length < 100) {
                        currentCategory = catText;
                        continue;
                    }
                }
                const cells = row.querySelectorAll('td');
                if (cells.length < 2) continue;
                let time = '';
                let eventTitle = '';
                const channels = [];
                for (const cell of cells) {
                    const text = cell.textContent.trim();
                    if (/^\d{1,2}:\d{2}/.test(text) && !time) {
                        time = text.match(/\d{1,2}:\d{2}/)[0];
                        continue;
                    }
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
                    if (text && text.length > 2 && !time && channels.length === 0) {
                        eventTitle = text;
                    }
                }
                if (!eventTitle && cells.length >= 2) {
                    eventTitle = cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim() || '';
                    channels.forEach(ch => { eventTitle = eventTitle.replace(ch.name, '').trim(); });
                }
                if (channels.length > 0) {
                    results.push({ category: currentCategory, title: eventTitle || 'Unknown Event', time: time || '', channels });
                }
            }
        }

        return results;
    }, BASE_URL);

    console.log(`[*] Found ${events.length} events for category: ${categorySlug}`);
    return events;
}


async function scrape() {
    const startTime = Date.now();
    const runType = process.env.SCRAPER_RUN_TYPE || 'manual';
    console.log(`[*] Starting DLStreams Scraper (${runType})...`);

    // Parse selected categories from environment variable
    let selectedCategories = [];
    try {
        if (process.env.DLSTREAMS_CATEGORIES) {
            selectedCategories = JSON.parse(process.env.DLSTREAMS_CATEGORIES);
        }
    } catch (e) {
        console.error('[!] Error parsing DLSTREAMS_CATEGORIES env var:', e.message);
    }

    if (selectedCategories.length > 0) {
        console.log(`[*] Selected categories (${selectedCategories.length}): ${selectedCategories.join(', ')}`);
    } else {
        console.log('[*] No categories selected — scraping ALL events.');
    }

    let browser;
    try {
        const launchOptions = getLaunchOptions();
        if (launchOptions.executablePath) {
            console.log(`[*] Using Chromium at: ${launchOptions.executablePath}`);
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");

        // Step 1: Parse schedule — either per-category or all
        let events = [];
        if (selectedCategories.length > 0) {
            for (const cat of selectedCategories) {
                const catEvents = await parseCategoryPage(page, cat);
                events.push(...catEvents);
            }
        } else {
            events = await parseSchedule(page);
        }

        console.log(`[*] Total events found: ${events.length}`);

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
