const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sources, users, settings } = require('../db');
const syncService = require('./syncService');
const { resolveChannelUrl, decodeClearKey } = require('./dlstreamsResolver');

class DlstreamsService {
    constructor() {
        this.isRunning = false;
        this.lastRun = null;
        this.currentProcess = null;
        this.logs = [];
        this.maxLogs = 500;
        this._autoRunTimer = null;
        this._autoRunInterval = 60 * 60 * 1000;

        this.dataDir = path.join(__dirname, '../../data/scraper');
        this.historyFile = path.join(this.dataDir, 'dlstreams_history.json');
        this.playlistFile = path.join(this.dataDir, 'dlstreams.m3u');

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
        const intervalHours = parseInt(currentSettings.dlstreamsInterval) || 1;
        const autoRunEnabled = currentSettings.dlstreamsAutoRun === true;

        let nextRun = null;
        if (autoRunEnabled && this.lastRun) {
            nextRun = new Date(this.lastRun.getTime() + (intervalHours * 3600000));
        }

        const history = this.getHistory();
        const latestRun = history[0] || null;
        const latestMetrics = latestRun?.metrics || {
            retriesUsed: 0,
            retryRecoveredChannels: 0,
            cooldownActivations: 0,
            finalFailures: 0
        };

        return {
            isRunning: this.isRunning,
            lastRun: this.lastRun,
            history,
            latestMetrics,
            fileInfo,
            dlstreamsConcurrencyLimit: currentSettings.dlstreamsConcurrencyLimit || 4,
            dlstreamsHoursBefore: currentSettings.dlstreamsHoursBefore ?? 3,
            dlstreamsHoursAfter:  currentSettings.dlstreamsHoursAfter  ?? 3,
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
            throw new Error('DLStreams scraper is already running');
        }

        this.isRunning = true;
        this.logs = [];

        const startTime = Date.now();
        if (!runType) runType = process.env.SCRAPER_RUN_TYPE || 'manual';

        this.addLog(`[*] Starting DLStreams scraper execution (${runType})...`);

        // Read selected categories from settings
        const currentSettings = await settings.get();
        const selectedCategories = currentSettings.dlstreamsSelectedCategories || [];
        if (selectedCategories.length > 0) {
            this.addLog(`[*] Categories: ${selectedCategories.join(', ')}`);
        } else {
            this.addLog('[*] No categories selected — scraping all events.');
        }

        const concurrencyLimit = currentSettings.dlstreamsConcurrencyLimit || 4;
        this.addLog(`[*] Concurrency Limit: ${concurrencyLimit}`);

        const hoursBefore = parseInt(currentSettings.dlstreamsHoursBefore) || 3;
        const hoursAfter  = parseInt(currentSettings.dlstreamsHoursAfter)  || 3;
        this.addLog(`[*] Time window: -${hoursBefore}h / +${hoursAfter}h`);

        const scriptPath = path.join(__dirname, '../scraper/dlstreams.js');

        this.currentProcess = spawn(process.execPath, [scriptPath], {
            env: {
                ...process.env,
                PORT: process.env.PORT || 3000,
                SCRAPER_RUN_TYPE: runType,
                DLSTREAMS_CATEGORIES: JSON.stringify(selectedCategories),
                SCRAPER_CONCURRENCY: concurrencyLimit.toString(),
                DLSTREAMS_HOURS_BEFORE: hoursBefore.toString(),
                DLSTREAMS_HOURS_AFTER: hoursAfter.toString()
            }
        });

        this.currentProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(line.trim());
                    console.log(`[DLStreams] ${line.trim()}`);
                }
            });
        });

        this.currentProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(`[ERROR] ${line.trim()}`);
                    console.error(`[DLStreams Error] ${line.trim()}`);
                }
            });
        });

        return new Promise((resolve, reject) => {
            const TIMEOUT_MS = 90 * 60 * 1000;
            const executionTimeout = setTimeout(() => {
                if (this.currentProcess && this.isRunning) {
                    this.addLog('[CRITICAL] DLStreams scraper timed out (90m). Killing process.');
                    this.currentProcess.kill('SIGKILL');
                    this.isRunning = false;
                    this.currentProcess = null;
                    reject(new Error('DLStreams scraper execution timeout'));
                }
            }, TIMEOUT_MS);

            this.currentProcess.on('exit', async (code) => {
                clearTimeout(executionTimeout);
                this.isRunning = false;
                this.currentProcess = null;
                this.lastRun = new Date();

                if (code === 0) {
                    this.addLog('[v] DLStreams scraper completed successfully.');

                    if (fs.existsSync(this.playlistFile)) {
                        const stats = fs.statSync(this.playlistFile);
                        if (stats.size < 100) {
                            this.addLog(`[WARNING] Playlist file is very small (${stats.size} bytes).`);
                        } else {
                            this.addLog(`[v] Playlist file verified (${stats.size} bytes).`);
                        }
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
                    this.addLog(`[!] DLStreams scraper exited with code ${code}`);
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
        const existingSource = allSources.find(s => s.name === 'DLStreams Events');

        if (existingSource) {
            const expectedUrl = 'data/scraper/dlstreams.m3u';
            const updates = {};

            if (existingSource.url !== expectedUrl) {
                updates.url = expectedUrl;
                this.addLog(`[*] Updating source URL to relative path: ${expectedUrl}`);
            }

            if (existingSource.auto_sync === true || existingSource.auto_sync === 1) {
                updates.auto_sync = false;
                this.addLog('[*] Disabled auto_sync for source.');
            }

            if (existingSource.is_public !== true) {
                updates.is_public = true;
                this.addLog('[*] Marked source as public.');
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
                name: 'DLStreams Events',
                type: 'm3u',
                url: 'data/scraper/dlstreams.m3u',
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
        const intervalHours = parseInt(currentSettings.dlstreamsInterval) || 1;
        const enabled = currentSettings.dlstreamsAutoRun === true;

        if (!enabled) {
            console.log('[DLStreams] Auto-run is disabled in settings');
            this.stopAutoRun();
            return;
        }

        const intervalMs = intervalHours * 60 * 60 * 1000;
        this._autoRunInterval = intervalMs;

        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
        }

        console.log(`[DLStreams] Starting auto-run every ${intervalHours} hours`);

        const lastHistory = this.getHistory()[0];
        if (lastHistory) {
            this.lastRun = new Date(lastHistory.timestamp);
        }

        const now = Date.now();
        const lastRunTime = this.lastRun ? this.lastRun.getTime() : 0;
        const timeSinceLastRun = now - lastRunTime;

        if (timeSinceLastRun >= intervalMs) {
            console.log('[DLStreams] Triggering immediate run on startup (interval passed)');
            this.run('auto').catch(err => {
                console.error('[DLStreams] Startup run failed:', err);
            });

            this._autoRunTimer = setInterval(() => {
                this._triggerScheduledRun();
            }, intervalMs);
        } else {
            const waitTime = intervalMs - timeSinceLastRun;
            console.log(`[DLStreams] Next run scheduled in ${Math.round(waitTime / 60000)} minutes`);

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
            console.log('[DLStreams] Triggering scheduled run...');
            this.run('auto').catch(err => {
                console.error('[DLStreams] Scheduled run failed:', err);
            });
        } else {
            console.log('[DLStreams] Scheduled run skipped (already running)');
        }
    }

    async restartAutoRun() {
        await this.startAutoRun();
    }

    stopAutoRun() {
        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
            this._autoRunTimer = null;
            console.log('[DLStreams] Auto-run disabled');
        }
    }

    /**
     * Resolve a fresh stream URL for a DLStreams channel on-demand.
     * Launches Puppeteer to visit the watch page and intercept the stream URL.
     * @param {string} channelId - DLStreams channel ID (numeric string)
     * @returns {{ streamUrl: string|null, clearKeys: string|null, cached: boolean }}
     */
    async resolveStreamUrl(channelId, options = {}) {
        console.log(`[DLStreams] Resolving stream URL for channel ${channelId}...`);
        const resolveOptions = {
            validateCache: true,
            ...options
        };
        const result = await resolveChannelUrl(channelId, resolveOptions);

        // Decode ClearKey if present
        let clearKeys = null;
        let extractedCk = result.ckParam;

        // Also check for ck= in the URL itself
        if (!extractedCk && result.streamUrl && result.streamUrl.includes('ck=')) {
            try {
                const parts = result.streamUrl.split('ck=');
                if (parts.length > 1) extractedCk = parts[1].split('&')[0];
            } catch (err) { }
        }

        if (extractedCk) {
            clearKeys = decodeClearKey(extractedCk);
        }

        return {
            streamUrl: result.streamUrl,
            clearKeys,
            proxyHeaders: result.requestHeaders || null,
            cached: result.cached
        };
    }
}

module.exports = new DlstreamsService();
