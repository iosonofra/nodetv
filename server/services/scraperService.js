const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sources, users, settings } = require('../db');
const syncService = require('./syncService');

class ScraperService {
    constructor() {
        this.isRunning = false;
        this.lastRun = null;
        this.currentProcess = null;
        this.logs = [];
        this.maxLogs = 500;
        this._autoRunTimer = null;
        this._autoRunInterval = 60 * 60 * 1000; // Legacy default

        this.dataDir = path.join(__dirname, '../../data/scraper');
        this.historyFile = path.join(this.dataDir, 'history.json');
        this.playlistFile = path.join(this.dataDir, 'thisnotbusiness.m3u');

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    async getStatus() {
        // Check playlist file info
        let fileInfo = null;
        if (fs.existsSync(this.playlistFile)) {
            try {
                const stats = fs.statSync(this.playlistFile);
                fileInfo = {
                    exists: true,
                    size: stats.size,
                    mtime: stats.mtime
                };
            } catch (e) {
                fileInfo = { exists: true, error: e.message };
            }
        } else {
            fileInfo = { exists: false };
        }

        const currentSettings = await settings.get();
        const intervalHours = parseInt(currentSettings.scraperInterval) || 1;
        const autoRunEnabled = currentSettings.scraperAutoRun !== false;

        let nextRun = null;
        if (autoRunEnabled && this.lastRun) {
            nextRun = new Date(this.lastRun.getTime() + (intervalHours * 3600000));
        } else if (autoRunEnabled) {
            // If never run, next run will be relative to server start (or handled by startup logic)
            // For UI purposes, we'll show "Pending" or similar if we don't have a timer yet
        }

        let autoRunInfo = {
            enabled: autoRunEnabled,
            intervalHours: intervalHours,
            nextRunExpected: nextRun,
            isTimerActive: !!this._autoRunTimer
        };

        return {
            isRunning: this.isRunning,
            lastRun: this.lastRun,
            history: this.getHistory(),
            fileInfo,
            autoRunInfo
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
            throw new Error('Scraper is already running');
        }

        this.isRunning = true;
        this.logs = [];

        const startTime = Date.now();
        if (!runType) runType = process.env.SCRAPER_RUN_TYPE || 'manual';

        this.addLog(`[*] Starting scraper execution (${runType})...`);

        const scriptPath = path.join(__dirname, '../scraper/thisnotbusiness.js');

        // Use the current node executable
        this.currentProcess = spawn(process.execPath, [scriptPath], {
            env: {
                ...process.env,
                PORT: process.env.PORT || 3000,
                SCRAPER_RUN_TYPE: runType
            }
        });

        this.currentProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(line.trim());
                    console.log(`[Scraper] ${line.trim()}`);
                }
            });
        });

        this.currentProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(`[ERROR] ${line.trim()}`);
                    console.error(`[Scraper Error] ${line.trim()}`);
                }
            });
        });

        return new Promise((resolve, reject) => {
            // Add execution timeout (90 minutes) to prevent permanent lock if Puppeteer hangs
            const TIMEOUT_MS = 90 * 60 * 1000;
            const executionTimeout = setTimeout(() => {
                if (this.currentProcess && this.isRunning) {
                    this.addLog('[CRITICAL] Scraper execution timed out (90m). Killing process to prevent lock.');
                    this.currentProcess.kill('SIGKILL');
                    this.isRunning = false;
                    this.currentProcess = null;
                    reject(new Error('Scraper execution timeout'));
                }
            }, TIMEOUT_MS);

            this.currentProcess.on('exit', async (code) => {
                clearTimeout(executionTimeout);
                this.isRunning = false;
                this.currentProcess = null;
                this.lastRun = new Date();

                if (code === 0) {
                    this.addLog('[v] Scraper completed successfully.');

                    // Verify output file
                    if (fs.existsSync(this.playlistFile)) {
                        const stats = fs.statSync(this.playlistFile);
                        if (stats.size < 100) {
                            this.addLog(`[WARNING] Playlist file is very small (${stats.size} bytes). Scrape might have failed.`);
                        } else {
                            this.addLog(`[v] Playlist file verified (${stats.size} bytes).`);
                        }
                    } else {
                        this.addLog('[ERROR] Playlist file not found after successful run!');
                    }

                    // Auto-register or update source
                    try {
                        await this.ensureSourceRegistered();
                    } catch (err) {
                        this.addLog(`[ERROR] Failed to register source: ${err.message}`);
                    }

                    resolve({ success: true });
                } else {
                    this.addLog(`[!] Scraper exited with code ${code}`);
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
        // Check if playlist file exists
        if (!fs.existsSync(this.playlistFile)) {
            this.addLog('[!] Playlist file not found, skipping source registration.');
            return;
        }

        const allSources = await sources.getAll();
        const existingSource = allSources.find(s => s.name === 'thisnot.business Events');

        if (existingSource) {
            this.addLog(`[*] Updating existing source (ID: ${existingSource.id})...`);

            // Ensure auto_sync is false to prevent global sync timer from interfering
            if (existingSource.auto_sync === true || existingSource.auto_sync === 1) {
                await sources.update(existingSource.id, { auto_sync: false });
                this.addLog('[*] Disabled auto_sync for source to manage it via scraper.');
            }

            // Ensure is_public is true for scraper source
            if (existingSource.is_public !== true) {
                await sources.update(existingSource.id, { is_public: true });
                this.addLog('[*] Marked source as public.');
            }

            // Trigger sync for this source
            await syncService.syncSource(existingSource.id);
            this.addLog('[*] Source sync triggered.');
        } else {
            this.addLog('[*] Source not found, creating new local source...');

            // Need an admin user to assign the source
            const allUsers = await users.getAll();
            const admin = allUsers.find(u => u.role === 'admin') || allUsers[0];

            if (!admin) {
                this.addLog('[!] No admin user found to assign source.');
                return;
            }

            const newSource = await sources.create({
                name: 'thisnot.business Events',
                type: 'm3u',
                // Use absolute path for reliability
                url: path.resolve(this.playlistFile),
                auto_sync: false, // Managed by scraper service
                is_public: true
            }, admin.id);

            this.addLog(`[+] New source created (ID: ${newSource.id}).`);

            // Trigger initial sync
            await syncService.syncSource(newSource.id);
            this.addLog('[*] Initial sync triggered.');
        }
    }

    async startAutoRun() {
        // Get settings from DB
        const currentSettings = await settings.get();
        const intervalHours = parseInt(currentSettings.scraperInterval) || 1;
        const enabled = currentSettings.scraperAutoRun !== false;

        if (!enabled) {
            console.log('[Scraper] Auto-run is disabled in settings');
            this.stopAutoRun();
            return;
        }

        const intervalMs = intervalHours * 60 * 60 * 1000;
        this._autoRunInterval = intervalMs;

        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
        }

        console.log(`[Scraper] Starting auto-run every ${intervalHours} hours`);

        // Check if we should run immediately (if never run or last run was long ago)
        const lastHistory = this.getHistory()[0];
        if (lastHistory) {
            this.lastRun = new Date(lastHistory.timestamp);
        }

        const now = Date.now();
        const lastRunTime = this.lastRun ? this.lastRun.getTime() : 0;
        const timeSinceLastRun = now - lastRunTime;

        if (timeSinceLastRun >= intervalMs) {
            console.log('[Scraper] Triggering immediate run on startup (interval passed)');
            this.run('auto').catch(err => {
                console.error('[Scraper] Startup run failed:', err);
            });

            // Start the regular interval
            this._autoRunTimer = setInterval(() => {
                this._triggerScheduledRun();
            }, intervalMs);
        } else {
            const waitTime = intervalMs - timeSinceLastRun;
            console.log(`[Scraper] Next run scheduled in ${Math.round(waitTime / 60000)} minutes`);

            // Schedule the first run after the remaining wait time
            this._autoRunTimer = setTimeout(() => {
                this._triggerScheduledRun();
                // Then start the regular interval
                this._autoRunTimer = setInterval(() => {
                    this._triggerScheduledRun();
                }, intervalMs);
            }, waitTime);
        }
    }

    /**
     * Helper to trigger a scheduled run with logging
     * @private
     */
    _triggerScheduledRun() {
        if (!this.isRunning) {
            console.log('[Scraper] Triggering scheduled run...');
            this.run('auto').catch(err => {
                console.error('[Scraper] Scheduled run failed:', err);
            });
        } else {
            console.log('[Scraper] Scheduled run skipped (already running)');
        }
    }

    async restartAutoRun() {
        await this.startAutoRun();
    }

    stopAutoRun() {
        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
            this._autoRunTimer = null;
            console.log('[Scraper] Auto-run disabled');
        }
    }
}

// Singleton instance
module.exports = new ScraperService();
