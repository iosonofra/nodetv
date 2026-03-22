const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sources, users, settings } = require('../db');
const syncService = require('./syncService');

class PepperLiveService {
    constructor() {
        this.isRunning = false;
        this.lastRun = null;
        this.currentProcess = null;
        this.logs = [];
        this.maxLogs = 500;
        this._autoRunTimer = null;
        this._autoRunInterval = 60 * 60 * 1000;

        this.dataDir = path.join(__dirname, '../../data/scraper');
        this.historyFile = path.join(this.dataDir, 'pepperlive_history.json');
        this.playlistFile = path.join(this.dataDir, 'pepperlive.m3u');

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
        const intervalHours = parseInt(currentSettings.pepperLiveInterval) || 1;
        const autoRunEnabled = currentSettings.pepperLiveAutoRun === true;

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
            throw new Error('PepperLive scraper is already running');
        }

        this.isRunning = true;
        this.logs = [];

        if (!runType) runType = process.env.SCRAPER_RUN_TYPE || 'manual';

        this.addLog(`[*] Starting PepperLive scraper execution (${runType})...`);

        const scriptPath = path.join(__dirname, '../scraper/pepperlive.js');

        this.currentProcess = spawn(process.execPath, [scriptPath], {
            env: {
                ...process.env,
                SCRAPER_RUN_TYPE: runType,
            }
        });

        this.currentProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(line.trim());
                    console.log(`[PepperLive] ${line.trim()}`);
                }
            });
        });

        this.currentProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(`[ERROR] ${line.trim()}`);
                    console.error(`[PepperLive Error] ${line.trim()}`);
                }
            });
        });

        return new Promise((resolve, reject) => {
            const TIMEOUT_MS = 10 * 60 * 1000; // 10 min — pure HTTP, should be fast
            const executionTimeout = setTimeout(() => {
                if (this.currentProcess && this.isRunning) {
                    this.addLog('[CRITICAL] PepperLive scraper timed out (10m). Killing process.');
                    this.currentProcess.kill('SIGKILL');
                    this.isRunning = false;
                    this.currentProcess = null;
                    reject(new Error('PepperLive scraper execution timeout'));
                }
            }, TIMEOUT_MS);

            this.currentProcess.on('exit', async (code) => {
                clearTimeout(executionTimeout);
                this.isRunning = false;
                this.currentProcess = null;
                this.lastRun = new Date();

                if (code === 0) {
                    this.addLog('[✓] PepperLive scraper completed successfully.');

                    if (fs.existsSync(this.playlistFile)) {
                        const stats = fs.statSync(this.playlistFile);
                        this.addLog(`[✓] Playlist file: ${stats.size} bytes.`);
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
                    this.addLog(`[!] PepperLive scraper exited with code ${code}`);
                    resolve({ success: false, code });
                }
            });

            this.currentProcess.on('error', (err) => {
                clearTimeout(executionTimeout);
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
        const existingSource = allSources.find(s => s.name === 'PepperLive');

        if (existingSource) {
            const expectedUrl = 'data/scraper/pepperlive.m3u';
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
                name: 'PepperLive',
                type: 'm3u',
                url: 'data/scraper/pepperlive.m3u',
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
        const intervalHours = parseInt(currentSettings.pepperLiveInterval) || 1;
        const enabled = currentSettings.pepperLiveAutoRun === true;

        if (!enabled) {
            console.log('[PepperLive] Auto-run is disabled in settings');
            this.stopAutoRun();
            return;
        }

        const intervalMs = intervalHours * 60 * 60 * 1000;
        this._autoRunInterval = intervalMs;

        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
        }

        console.log(`[PepperLive] Starting auto-run every ${intervalHours} hours`);

        const lastHistory = this.getHistory()[0];
        if (lastHistory) {
            this.lastRun = new Date(lastHistory.timestamp);
        }

        const now = Date.now();
        const lastRunTime = this.lastRun ? this.lastRun.getTime() : 0;
        const timeSinceLastRun = now - lastRunTime;

        if (timeSinceLastRun >= intervalMs) {
            console.log('[PepperLive] Triggering immediate run on startup (interval passed)');
            this.run('auto').catch(err => {
                console.error('[PepperLive] Startup run failed:', err);
            });

            this._autoRunTimer = setInterval(() => {
                this._triggerScheduledRun();
            }, intervalMs);
        } else {
            const waitTime = intervalMs - timeSinceLastRun;
            console.log(`[PepperLive] Next run scheduled in ${Math.round(waitTime / 60000)} minutes`);

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
            console.log('[PepperLive] Triggering scheduled run...');
            this.run('auto').catch(err => {
                console.error('[PepperLive] Scheduled run failed:', err);
            });
        } else {
            console.log('[PepperLive] Scheduled run skipped (already running)');
        }
    }

    async restartAutoRun() {
        await this.startAutoRun();
    }

    stopAutoRun() {
        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
            this._autoRunTimer = null;
            console.log('[PepperLive] Auto-run disabled');
        }
    }
}

module.exports = new PepperLiveService();
