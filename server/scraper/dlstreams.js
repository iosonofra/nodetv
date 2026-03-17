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
    await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const events = await extractEvents(page);
    console.log(`[*] Found ${events.length} events with channels.`);
    return events;
}

async function extractEvents(page) {
    return await page.evaluate((baseUrl) => {
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
}

/**
 * Parse a specific category page
 */
async function parseCategoryPage(page, categorySlug) {
    const catUrl = `${BASE_URL}/index.php?cat=${encodeURIComponent(categorySlug).replace(/%20/g, '+')}`;
    console.log(`[*] Fetching category: ${categorySlug} from ${catUrl}...`);
    await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const events = await extractEvents(page);
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
        const mainPage = await browser.newPage();
        await mainPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
        await mainPage.setDefaultNavigationTimeout(20000);

        // Step 0.5: rapid guardrails
        const MAX_TASKS = parseInt(process.env.SCRAPER_MAX_TASKS || '120', 10);

        // Step 1: Parse schedule — either per-category or all
        let events = [];
        if (selectedCategories.length > 0) {
            for (const cat of selectedCategories) {
                const catEvents = await parseCategoryPage(mainPage, cat);
                events.push(...catEvents);
            }
        } else {
            events = await parseSchedule(mainPage);
        }

        console.log(`[*] Total events found: ${events.length}`);

        // Step 2: Filter and flatten tasks
        const m3uLines = ["#EXTM3U"];
        const processedChannels = new Map(); // Avoid duplicate channel visits
        function isValidStreamUrl(url) {
            if (!url) return false;
            const clean = url.split('#')[0];
            return /\.(m3u8|mpd)(\?|$)/i.test(clean) ||
                   /\/mono\.(css|csv)(\?|$)/i.test(clean);
        }
        
        // Filter criteria:
        // 1. Time-based: configurable window around current UTC time
        // 2. Title-based: Exclude events that look like future dates
        const now = new Date();
        // Note: DLStreams site uses UK time (UTC/GMT).
        const HOURS_BEFORE = parseFloat(process.env.DLSTREAMS_HOURS_BEFORE) || 3;
        const HOURS_AFTER  = parseFloat(process.env.DLSTREAMS_HOURS_AFTER)  || 3;
        
        const tasks = [];
        let skippedByTime = 0;
        let skippedByDate = 0;

        events.forEach(event => {
            // Filter by date string in title (e.g. "Saturday, March 21, 2026")
            if (event.title.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/)) {
                skippedByDate++;
                return;
            }

            // Filter by time if possible
            if (event.time && event.time.includes(':')) {
                const [h, m] = event.time.split(':').map(n => parseInt(n));
                
                // Allow events that started up to 3 hours ago or start in the next 3 hours
                const nowGmt = now.getTime();
                const eventDate = new Date(now);
                eventDate.setUTCHours(h, m, 0, 0);
                // Handle midnight wrap-around: if the event time is far in the future,
                // it might be from "yesterday" UTC — check both sides.
                let eventTime = eventDate.getTime();
                let diffHours = (eventTime - nowGmt) / (1000 * 60 * 60);
                // If diff is > 12h, the event is likely "yesterday" in UTC — shift back 24h
                if (diffHours > 12) {
                    eventTime -= 24 * 60 * 60 * 1000;
                    diffHours = (eventTime - nowGmt) / (1000 * 60 * 60);
                }
                // If diff is < -12h, the event is likely "tomorrow" in UTC — shift forward 24h
                if (diffHours < -12) {
                    eventTime += 24 * 60 * 60 * 1000;
                    diffHours = (eventTime - nowGmt) / (1000 * 60 * 60);
                }
                const withinWindow = diffHours >= -HOURS_BEFORE && diffHours <= HOURS_AFTER;
                
                if (!withinWindow) {
                    skippedByTime++;
                    return;
                }
            }

            event.channels.forEach(channel => {
                tasks.push({ event, channel });
            });
        });

        if (tasks.length > MAX_TASKS) {
            console.log(`[*] Task cap: trimming ${tasks.length} tasks to ${MAX_TASKS}`);
            tasks.length = MAX_TASKS;
        }

        console.log(`[*] Filtered schedule: skipped ${skippedByDate} future dates, ${skippedByTime} out-of-window events.`);
        console.log(`[*] Flattened into ${tasks.length} active channel tasks.`);

        // Worker Pool logic
        const concurrencyLimit = parseInt(process.env.SCRAPER_CONCURRENCY || '4', 10);
        const maxRetries = parseInt(process.env.SCRAPER_RETRY_COUNT || '1', 10);
        const retryMinDelayMs = parseInt(process.env.SCRAPER_RETRY_MIN_DELAY_MS || '2000', 10);
        const retryMaxDelayMs = parseInt(process.env.SCRAPER_RETRY_MAX_DELAY_MS || '6000', 10);
        const backoffTriggerFailures = parseInt(process.env.SCRAPER_BACKOFF_TRIGGER_FAILURES || '3', 10);
        const backoffMinMs = parseInt(process.env.SCRAPER_BACKOFF_MIN_MS || '10000', 10);
        const backoffMaxMs = parseInt(process.env.SCRAPER_BACKOFF_MAX_MS || '20000', 10);

        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const randomBetween = (min, max) => {
            if (max <= min) return min;
            return Math.floor(Math.random() * (max - min + 1)) + min;
        };

        let consecutiveFailures = 0;
        let globalCooldownUntil = 0;
        let retryAttemptsUsed = 0;
        let retryRecoveredChannels = 0;
        let cooldownActivations = 0;
        let channelsFailedFinal = 0;

        console.log(`[*] Proceeding with concurrency limit: ${concurrencyLimit}`);
        console.log(`[*] Retry policy: ${maxRetries} retry, jitter ${retryMinDelayMs}-${retryMaxDelayMs}ms.`);
        console.log(`[*] Backoff policy: trigger ${backoffTriggerFailures} fails, cooldown ${backoffMinMs}-${backoffMaxMs}ms.`);
        
        let completedChannels = 0;
        let activeWorkers = 0;
        let taskIndex = 0;
        
        const workers = [];
        
        const workerFn = async (workerId) => {
            // Give each worker its own page
            const page = await browser.newPage();
            await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
            page.setDefaultNavigationTimeout(20000);
            
            while (taskIndex < tasks.length) {
                const currentTaskIndex = taskIndex++;
                const { event, channel } = tasks[currentTaskIndex];

                const cooldownLeft = globalCooldownUntil - Date.now();
                if (cooldownLeft > 0) {
                    console.log(`[Worker ${workerId}] [*] Global cooldown active (${cooldownLeft}ms), waiting...`);
                    await sleep(cooldownLeft);
                }
                
                try {
                    let streamUrl, ckParam;
                    
                    // Use cached data if we already processed this channel ID
                    if (processedChannels.has(channel.id)) {
                        console.log(`[Worker ${workerId}] [${completedChannels + 1}/${tasks.length}] Processing: ${event.title} - ${channel.name} (ID: ${channel.id}) [CACHED]`);
                        const cached = processedChannels.get(channel.id);
                        streamUrl = cached.streamUrl;
                        ckParam = cached.ckParam;
                    } else {
                        console.log(`[Worker ${workerId}] [${completedChannels + 1}/${tasks.length}] Processing: ${event.title} - ${channel.name} (ID: ${channel.id})...`);
                        let resolvedAfterRetry = false;
                        for (let attempt = 0; attempt <= maxRetries; attempt++) {
                            const result = await extractStreamUrl(page, channel.id, { forceRefresh: attempt > 0 });
                            streamUrl = result.streamUrl;
                            ckParam = result.ckParam;
                            if (streamUrl) {
                                if (attempt > 0) resolvedAfterRetry = true;
                                break;
                            }

                            if (attempt < maxRetries) {
                                const retryDelay = randomBetween(retryMinDelayMs, retryMaxDelayMs);
                                retryAttemptsUsed++;
                                console.log(`  [Worker ${workerId}] [!] Retry ${attempt + 1}/${maxRetries} for channel ${channel.id} in ${retryDelay}ms...`);
                                await sleep(retryDelay);
                            }
                        }

                        if (resolvedAfterRetry) {
                            retryRecoveredChannels++;
                        }

                        if (streamUrl) {
                            processedChannels.set(channel.id, { streamUrl, ckParam });
                        }
                    }

                    if (streamUrl) {
                        consecutiveFailures = 0;
                        let finalUrl = streamUrl;

                        // Handle chrome-extension wrapper
                        if (finalUrl.startsWith("chrome-extension://")) {
                            if (finalUrl.includes("#")) {
                                finalUrl = finalUrl.split("#")[1];
                            }
                        }

                        if (!isValidStreamUrl(finalUrl)) {
                            console.log(`  [Worker ${workerId}] [!] Skipping non-m3u/css stream URL: ${finalUrl}`);
                            continue;
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
                        console.log(`  [Worker ${workerId}] [v] Successfully added channel.`);
                    } else {
                        console.log(`  [Worker ${workerId}] [-] No stream URL found for channel ${channel.name} (ID: ${channel.id})`);
                        channelsFailedFinal++;
                        consecutiveFailures++;
                        if (consecutiveFailures >= backoffTriggerFailures) {
                            const cooldownMs = randomBetween(backoffMinMs, backoffMaxMs);
                            globalCooldownUntil = Date.now() + cooldownMs;
                            consecutiveFailures = 0;
                            cooldownActivations++;
                            console.log(`  [Worker ${workerId}] [!] High failure rate detected, applying global cooldown for ${cooldownMs}ms.`);
                        }
                    }
                } catch (e) {
                    console.error(`  [Worker ${workerId}] [!] Error extracting channel ${channel.name} (ID: ${channel.id}): ${e.message}`);
                    channelsFailedFinal++;
                    consecutiveFailures++;
                    if (consecutiveFailures >= backoffTriggerFailures) {
                        const cooldownMs = randomBetween(backoffMinMs, backoffMaxMs);
                        globalCooldownUntil = Date.now() + cooldownMs;
                        consecutiveFailures = 0;
                        cooldownActivations++;
                        console.log(`  [Worker ${workerId}] [!] Error burst detected, applying global cooldown for ${cooldownMs}ms.`);
                    }
                }
                
                completedChannels++;
            }
            
            await page.close();
        };

        const actualConcurrency = Math.min(concurrencyLimit, tasks.length);
        for (let i = 0; i < actualConcurrency; i++) {
            workers.push(workerFn(i + 1));
        }
        
        await Promise.all(workers);

        // Save Playlist
        fs.writeFileSync(PLAYLIST_FILE, m3uLines.join("\n"), 'utf8');
        if (m3uLines.length > 1) {
            console.log(`[*] Successfully saved playlist with ${m3uLines.length - 1} entries to: ${PLAYLIST_FILE}`);
        } else {
            console.log(`[*] Saved empty playlist to: ${PLAYLIST_FILE}`);
        }

        console.log(`[*] Runtime metrics: retries_used=${retryAttemptsUsed}, retry_recovered=${retryRecoveredChannels}, cooldowns=${cooldownActivations}, final_failures=${channelsFailedFinal}`);

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
            metrics: {
                retriesUsed: retryAttemptsUsed,
                retryRecoveredChannels,
                cooldownActivations,
                finalFailures: channelsFailedFinal
            },
            message: `Generated ${count} channels from ${events.length} events. retries=${retryAttemptsUsed}, cooldowns=${cooldownActivations}, finalFailures=${channelsFailedFinal}.`
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
