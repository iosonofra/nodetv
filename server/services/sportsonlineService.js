const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { sources, users, settings } = require('../db');
const syncService = require('./syncService');

// Use the same HTTPS agent as the proxy to ensure consistent outgoing IP/TLS behavior
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

class SportsonlineService {
    constructor() {
        this.isRunning = false;
        this.lastRun = null;
        this.currentProcess = null;
        this.logs = [];
        this.maxLogs = 500;
        this._autoRunTimer = null;
        this._autoRunInterval = 60 * 60 * 1000;

        // Cache for resolved CDN URLs (keyed by PHP page URL)
        // CDN tokens are IP-bound and last ~6h, cache for 2h to be safe
        this._urlCache = new Map(); // phpUrl → { streamUrl, embedUrl, resolvedAt }
        this._cacheTTL = 2 * 60 * 60 * 1000; // 2 hours

        this.dataDir = path.join(__dirname, '../../data/scraper');
        this.historyFile = path.join(this.dataDir, 'sportsonline_history.json');
        this.playlistFile = path.join(this.dataDir, 'sportsonline.m3u');

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    async getStatus() {
        let fileInfo = null;
        if (fs.existsSync(this.playlistFile)) {
            try {
                const stats = fs.statSync(this.playlistFile);
                fileInfo = { exists: true, size: stats.size, mtime: stats.mtime };
            } catch (e) {
                fileInfo = { exists: true, error: e.message };
            }
        } else {
            fileInfo = { exists: false };
        }

        const currentSettings = await settings.get();
        const intervalHours = parseInt(currentSettings.sportsonlineInterval) || 1;
        const autoRunEnabled = currentSettings.sportsonlineAutoRun === true;

        let nextRun = null;
        if (autoRunEnabled && this.lastRun) {
            nextRun = new Date(this.lastRun.getTime() + (intervalHours * 3600000));
        }

        const history = this.getHistory();

        return {
            isRunning: this.isRunning,
            lastRun: this.lastRun,
            history,
            fileInfo,
            autoRunInfo: {
                enabled: autoRunEnabled,
                intervalHours,
                nextRunExpected: nextRun,
                isTimerActive: !!this._autoRunTimer
            }
        };
    }

    getLogs() {
        return this.logs;
    }

    getHistory() {
        if (fs.existsSync(this.historyFile)) {
            try {
                return JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
            } catch (e) {
                return [];
            }
        }
        return [];
    }

    async run(runType = null) {
        if (this.isRunning) {
            throw new Error('SportsOnline scraper is already running');
        }

        this.isRunning = true;
        this.logs = [];

        if (!runType) runType = process.env.SCRAPER_RUN_TYPE || 'manual';

        this.addLog(`[*] Starting SportsOnline scraper execution (${runType})...`);

        const currentSettings = await settings.get();
        const concurrency = parseInt(currentSettings.sportsonlineConcurrency) || 4;
        this.addLog(`[*] Concurrency: ${concurrency}`);

        const scriptPath = path.join(__dirname, '../scraper/sportsonline.js');

        this.currentProcess = spawn(process.execPath, [scriptPath], {
            env: {
                ...process.env,
                SCRAPER_RUN_TYPE: runType,
                SCRAPER_CONCURRENCY: concurrency.toString()
            }
        });

        this.currentProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(line.trim());
                    console.log(`[SportsOnline] ${line.trim()}`);
                }
            });
        });

        this.currentProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(`[ERROR] ${line.trim()}`);
                    console.error(`[SportsOnline Error] ${line.trim()}`);
                }
            });
        });

        return new Promise((resolve, reject) => {
            const TIMEOUT_MS = 30 * 60 * 1000; // 30 min (no Puppeteer, should be fast)
            const executionTimeout = setTimeout(() => {
                if (this.currentProcess && this.isRunning) {
                    this.addLog('[CRITICAL] SportsOnline scraper timed out (30m). Killing process.');
                    this.currentProcess.kill('SIGKILL');
                    this.isRunning = false;
                    this.currentProcess = null;
                    reject(new Error('SportsOnline scraper execution timeout'));
                }
            }, TIMEOUT_MS);

            this.currentProcess.on('exit', async (code) => {
                clearTimeout(executionTimeout);
                this.isRunning = false;
                this.currentProcess = null;
                this.lastRun = new Date();

                if (code === 0) {
                    this.addLog('[v] SportsOnline scraper completed successfully.');

                    if (fs.existsSync(this.playlistFile)) {
                        const stats = fs.statSync(this.playlistFile);
                        this.addLog(`[v] Playlist file: ${stats.size} bytes.`);
                    } else {
                        this.addLog('[ERROR] Playlist file not found after successful run!');
                    }

                    try {
                        await this.ensureSourceRegistered();
                    } catch (err) {
                        this.addLog(`[ERROR] Failed to register source: ${err.message}`);
                    }

                    resolve({ success: true });
                } else {
                    this.addLog(`[!] SportsOnline scraper exited with code ${code}`);
                    resolve({ success: false, code });
                }
            });

            this.currentProcess.on('error', (err) => {
                this.isRunning = false;
                this.currentProcess = null;
                this.addLog(`[CRITICAL] Process error: ${err.message}`);
                reject(err);
            });
        });
    }

    addLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        this.logs.push(`[${timestamp}] ${message}`);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
    }

    async ensureSourceRegistered() {
        if (!fs.existsSync(this.playlistFile)) {
            this.addLog('[!] Playlist file not found, skipping source registration.');
            return;
        }

        const allSources = await sources.getAll();
        const existingSource = allSources.find(s => s.name === 'SportsOnline Events');

        if (existingSource) {
            const expectedUrl = 'data/scraper/sportsonline.m3u';
            const updates = {};

            if (existingSource.url !== expectedUrl) {
                updates.url = expectedUrl;
            }
            if (existingSource.auto_sync === true || existingSource.auto_sync === 1) {
                updates.auto_sync = false;
            }
            if (existingSource.is_public !== true) {
                updates.is_public = true;
            }

            if (Object.keys(updates).length > 0) {
                await sources.update(existingSource.id, updates);
            }

            await syncService.syncSource(existingSource.id);
            this.addLog('[*] Source sync triggered.');
        } else {
            this.addLog('[*] Source not found, creating new local source...');

            const allUsers = await users.getAll();
            const admin = allUsers.find(u => u.role === 'admin') || allUsers[0];

            if (!admin) {
                this.addLog('[!] No admin user found to assign source.');
                return;
            }

            const newSource = await sources.create({
                name: 'SportsOnline Events',
                type: 'm3u',
                url: 'data/scraper/sportsonline.m3u',
                auto_sync: false,
                is_public: true
            }, admin.id);

            this.addLog(`[+] New source created (ID: ${newSource.id}).`);
            await syncService.syncSource(newSource.id);
            this.addLog('[*] Initial sync triggered.');
        }
    }

    async startAutoRun() {
        const currentSettings = await settings.get();
        const intervalHours = parseInt(currentSettings.sportsonlineInterval) || 1;
        const enabled = currentSettings.sportsonlineAutoRun === true;

        if (!enabled) {
            console.log('[SportsOnline] Auto-run is disabled in settings');
            this.stopAutoRun();
            return;
        }

        const intervalMs = intervalHours * 60 * 60 * 1000;
        this._autoRunInterval = intervalMs;

        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
        }

        console.log(`[SportsOnline] Starting auto-run every ${intervalHours} hours`);

        const lastHistory = this.getHistory()[0];
        if (lastHistory) {
            this.lastRun = new Date(lastHistory.timestamp);
        }

        const now = Date.now();
        const lastRunTime = this.lastRun ? this.lastRun.getTime() : 0;
        const timeSinceLastRun = now - lastRunTime;

        if (timeSinceLastRun >= intervalMs) {
            console.log('[SportsOnline] Triggering immediate run on startup (interval passed)');
            this.run('auto').catch(err => {
                console.error('[SportsOnline] Startup run failed:', err);
            });

            this._autoRunTimer = setInterval(() => {
                this._triggerScheduledRun();
            }, intervalMs);
        } else {
            const waitTime = intervalMs - timeSinceLastRun;
            console.log(`[SportsOnline] Next run scheduled in ${Math.round(waitTime / 60000)} minutes`);

            this._autoRunTimer = setTimeout(() => {
                this._triggerScheduledRun();
                this._autoRunTimer = setInterval(() => {
                    this._triggerScheduledRun();
                }, intervalMs);
            }, waitTime);
        }
    }

    _triggerScheduledRun() {
        if (!this.isRunning) {
            console.log('[SportsOnline] Triggering scheduled run...');
            this.run('auto').catch(err => {
                console.error('[SportsOnline] Scheduled run failed:', err);
            });
        } else {
            console.log('[SportsOnline] Scheduled run skipped (already running)');
        }
    }

    async restartAutoRun() {
        await this.startAutoRun();
    }

    stopAutoRun() {
        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
            this._autoRunTimer = null;
            console.log('[SportsOnline] Auto-run disabled');
        }
    }

    /**
     * Resolve a stream URL on-demand with caching.
     * CDN tokens are IP-bound, so the URL must be resolved from the same
     * server that will proxy the stream. Cached for 2h.
     */
    async resolveAndCache(phpUrl) {
        // Check cache first
        const cached = this._urlCache.get(phpUrl);
        if (cached && (Date.now() - cached.resolvedAt) < this._cacheTTL) {
            console.log(`[SportsOnline] Cache hit for ${phpUrl.substring(phpUrl.lastIndexOf('/') + 1)}`);
            return { streamUrl: cached.streamUrl, embedUrl: cached.embedUrl, cached: true };
        }

        // Resolve fresh
        console.log(`[SportsOnline] Resolving fresh URL for ${phpUrl.substring(phpUrl.lastIndexOf('/') + 1)}`);
        const result = await this.resolveStreamUrl(phpUrl);

        // Verify the CDN URL actually works from this server before caching
        const fetch = require('node-fetch');
        const verifyRes = await fetch(result.streamUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            agent: httpsAgent,
            timeout: 10000
        });
        const verifyBody = await verifyRes.text().catch(() => '');
        if (!verifyRes.ok) {
            console.error(`[SportsOnline] CDN verification failed: ${verifyRes.status} for ${result.streamUrl.substring(0, 80)}`);
            console.error(`[SportsOnline] CDN body: ${verifyBody.substring(0, 200)}`);
            throw new Error(`CDN returned ${verifyRes.status} after resolution`);
        }
        if (!verifyBody.includes('#EXT')) {
            console.error(`[SportsOnline] CDN returned non-HLS content (${verifyBody.length} bytes): ${verifyBody.substring(0, 100)}`);
            throw new Error('CDN returned non-HLS content');
        }
        console.log(`[SportsOnline] CDN verification OK for ${phpUrl.substring(phpUrl.lastIndexOf('/') + 1)} (${verifyBody.length} bytes, HLS)`);


        // Cache the result
        this._urlCache.set(phpUrl, {
            streamUrl: result.streamUrl,
            embedUrl: result.embedUrl || null,
            resolvedAt: Date.now()
        });

        return { streamUrl: result.streamUrl, embedUrl: result.embedUrl, cached: false };
    }

    /**
     * Invalidate a cached URL (e.g., on CDN 403)
     */
    invalidateCache(phpUrl) {
        if (this._urlCache.delete(phpUrl)) {
            console.log(`[SportsOnline] Cache invalidated for ${phpUrl.substring(phpUrl.lastIndexOf('/') + 1)}`);
        }
    }

    /**
     * Check if a URL looks like a sportsonline PHP page URL
     */
    static isSportsonlinePhpUrl(url) {
        return /sportzsonline\.click\/.*\.php/i.test(url)
            || /sportsonline\.st\/.*\.php/i.test(url)
            || /sportsonlin.*\.xyz\/.*\.php/i.test(url);
    }

    /**
     * Resolve a stream URL on-demand for a given channel PHP page URL.
     * No Puppeteer, just HTTP fetch + regex.
     */
    async resolveStreamUrl(phpUrl) {
        const fetch = require('node-fetch');
        const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

        // Step 1: Fetch PHP page → extract iframe
        const phpRes = await fetch(phpUrl, {
            headers: { 'User-Agent': UA },
            agent: httpsAgent,
            timeout: 15000
        });
        if (!phpRes.ok) throw new Error(`PHP page HTTP ${phpRes.status}`);
        const phpHtml = await phpRes.text();

        const iframeMatch = phpHtml.match(/iframe[^>]+src=["']([^"']*dynamicsnake\.net[^"']*)/i)
            || phpHtml.match(/iframe[^>]+src=["'](https?:\/\/[^"']+\/embed\/[^"']+)/i);

        if (!iframeMatch) {
            const srcMatch = phpHtml.match(/(?:var\s+)?src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
            if (srcMatch) return { streamUrl: srcMatch[1] };
            throw new Error('No iframe/embed found in PHP page');
        }

        let embedUrl = iframeMatch[1];
        if (embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl;

        // Step 2: Fetch embed → extract var src
        const embedRes = await fetch(embedUrl, {
            headers: { 'User-Agent': UA, 'Referer': phpUrl },
            agent: httpsAgent,
            timeout: 15000
        });
        if (!embedRes.ok) throw new Error(`Embed page HTTP ${embedRes.status}`);
        const embedHtml = await embedRes.text();
        console.log(`[SportsOnline] Embed page ${embedRes.status}, ${embedHtml.length} bytes`);

        const srcMatch = embedHtml.match(/var\s+src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
        if (!srcMatch) throw new Error('No stream src in embed page');

        console.log(`[SportsOnline] Resolved: ${srcMatch[1].substring(0, 100)}`);
        return { streamUrl: srcMatch[1], embedUrl };
    }
}

module.exports = new SportsonlineService();
