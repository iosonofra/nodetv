const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sources, users, settings } = require('../db');
const syncService = require('./syncService');

function getPythonLauncher() {
    if (process.env.PYTHON_BIN && process.env.PYTHON_BIN.trim()) {
        return { cmd: process.env.PYTHON_BIN.trim(), argsPrefix: [] };
    }

    if (process.platform === 'win32') {
        return { cmd: 'py', argsPrefix: ['-3'] };
    }

    return { cmd: 'python3', argsPrefix: [] };
}

class HattrickEventiService {
    constructor() {
        this.isRunning = false;
        this.lastRun = null;
        this.currentProcess = null;
        this.logs = [];
        this.maxLogs = 500;
        this._autoRunTimer = null;
        this._autoRunInterval = 60 * 60 * 1000;

        this.dataDir = path.join(__dirname, '../../data/scraper');
        this.historyFile = path.join(this.dataDir, 'hattrickeventi_history.json');
        this.playlistFile = path.join(this.dataDir, 'hattrickeventi.m3u');
        this.scriptPath = path.join(__dirname, '../../hattrickeventi.py');

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
            } catch (error) {
                fileInfo = { exists: true, error: error.message };
            }
        } else {
            fileInfo = { exists: false };
        }

        const currentSettings = await settings.get();
        const intervalHours = parseInt(currentSettings.hattrickEventiInterval, 10) || 1;
        const autoRunEnabled = currentSettings.hattrickEventiAutoRun === true;
        const timeoutSeconds = parseInt(currentSettings.hattrickEventiTimeout, 10) || 15;

        let nextRun = null;
        if (autoRunEnabled && this.lastRun) {
            nextRun = new Date(this.lastRun.getTime() + (intervalHours * 3600000));
        }

        return {
            isRunning: this.isRunning,
            lastRun: this.lastRun,
            history: this.getHistory(),
            fileInfo,
            autoRunInfo: {
                enabled: autoRunEnabled,
                intervalHours,
                timeoutSeconds,
                nextRunExpected: nextRun,
                isTimerActive: !!this._autoRunTimer
            }
        };
    }

    getLogs() {
        return this.logs;
    }

    getHistory() {
        if (!fs.existsSync(this.historyFile)) {
            return [];
        }

        try {
            return JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
        } catch (_) {
            return [];
        }
    }

    saveHistoryEntry(entry) {
        const history = this.getHistory();
        history.unshift(entry);
        fs.writeFileSync(this.historyFile, JSON.stringify(history.slice(0, 50), null, 2), 'utf8');
    }

    async run(runType = null) {
        if (this.isRunning) {
            throw new Error('Hattrick Eventi scraper is already running');
        }

        if (!fs.existsSync(this.scriptPath)) {
            throw new Error(`Hattrick Eventi script not found at ${this.scriptPath}`);
        }

        this.isRunning = true;
        this.logs = [];

        if (!runType) runType = process.env.SCRAPER_RUN_TYPE || 'manual';

        const currentSettings = await settings.get();
        const timeoutSeconds = parseInt(currentSettings.hattrickEventiTimeout, 10) || 15;

        this.addLog(`[*] Starting Hattrick Eventi scraper execution (${runType})...`);
        this.addLog(`[*] Timeout: ${timeoutSeconds}s`);

        const python = getPythonLauncher();
        const args = [...python.argsPrefix, '-u', this.scriptPath];

        this.currentProcess = spawn(python.cmd, args, {
            env: {
                ...process.env,
                SCRAPER_RUN_TYPE: runType,
                PYTHONUNBUFFERED: '1',
                PYTHONIOENCODING: 'utf-8',
                HATTRICKEVENTI_OUTPUT: this.playlistFile,
                HATTRICKEVENTI_TIMEOUT: String(timeoutSeconds)
            }
        });

        this.currentProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(line.trim());
                    console.log(`[HattrickEventi] ${line.trim()}`);
                }
            });
        });

        this.currentProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    this.addLog(`[ERROR] ${line.trim()}`);
                    console.error(`[HattrickEventi Error] ${line.trim()}`);
                }
            });
        });

        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const timeoutMs = 20 * 60 * 1000;
            const executionTimeout = setTimeout(() => {
                if (this.currentProcess && this.isRunning) {
                    this.addLog('[CRITICAL] Hattrick Eventi scraper timed out (20m). Killing process.');
                    this.currentProcess.kill('SIGKILL');
                    this.isRunning = false;
                    this.currentProcess = null;
                    reject(new Error('Hattrick Eventi scraper execution timeout'));
                }
            }, timeoutMs);

            this.currentProcess.on('exit', async (code) => {
                clearTimeout(executionTimeout);
                this.isRunning = false;
                this.currentProcess = null;
                this.lastRun = new Date();

                const durationMs = Date.now() - startedAt;

                if (code === 0) {
                    this.addLog('[v] Hattrick Eventi scraper completed successfully.');

                    let playlistBytes = 0;
                    if (fs.existsSync(this.playlistFile)) {
                        const stats = fs.statSync(this.playlistFile);
                        playlistBytes = stats.size;
                        this.addLog(`[v] Playlist file: ${stats.size} bytes.`);
                    } else {
                        this.addLog('[ERROR] Playlist file not found after successful run!');
                    }

                    this.saveHistoryEntry({
                        timestamp: new Date().toISOString(),
                        runType,
                        success: true,
                        durationMs,
                        playlistBytes
                    });

                    try {
                        await this.ensureSourceRegistered();
                    } catch (error) {
                        this.addLog(`[ERROR] Failed to register source: ${error.message}`);
                    }

                    resolve({ success: true });
                    return;
                }

                this.addLog(`[!] Hattrick Eventi scraper exited with code ${code}`);
                this.saveHistoryEntry({
                    timestamp: new Date().toISOString(),
                    runType,
                    success: false,
                    durationMs,
                    exitCode: code
                });
                resolve({ success: false, code });
            });

            this.currentProcess.on('error', (error) => {
                clearTimeout(executionTimeout);
                this.isRunning = false;
                this.currentProcess = null;
                this.addLog(`[CRITICAL] Process error: ${error.message}`);
                reject(error);
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
        const existingSource = allSources.find(source => source.name === 'Hattrick Eventi');

        if (existingSource) {
            const expectedUrl = 'data/scraper/hattrickeventi.m3u';
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
            return;
        }

        this.addLog('[*] Source not found, creating new local source...');

        const allUsers = await users.getAll();
        const admin = allUsers.find(user => user.role === 'admin') || allUsers[0];

        if (!admin) {
            this.addLog('[!] No admin user found to assign source.');
            return;
        }

        const newSource = await sources.create({
            name: 'Hattrick Eventi',
            type: 'm3u',
            url: 'data/scraper/hattrickeventi.m3u',
            auto_sync: false,
            is_public: true
        }, admin.id);

        this.addLog(`[+] New source created (ID: ${newSource.id}).`);
        await syncService.syncSource(newSource.id);
        this.addLog('[*] Initial sync triggered.');
    }

    async startAutoRun() {
        const currentSettings = await settings.get();
        const intervalHours = parseInt(currentSettings.hattrickEventiInterval, 10) || 1;
        const enabled = currentSettings.hattrickEventiAutoRun === true;

        if (!enabled) {
            console.log('[HattrickEventi] Auto-run is disabled in settings');
            this.stopAutoRun();
            return;
        }

        const intervalMs = intervalHours * 60 * 60 * 1000;
        this._autoRunInterval = intervalMs;

        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
        }

        console.log(`[HattrickEventi] Starting auto-run every ${intervalHours} hours`);

        const lastHistory = this.getHistory()[0];
        if (lastHistory) {
            this.lastRun = new Date(lastHistory.timestamp);
        }

        const now = Date.now();
        const lastRunTime = this.lastRun ? this.lastRun.getTime() : 0;
        const timeSinceLastRun = now - lastRunTime;

        if (timeSinceLastRun >= intervalMs) {
            console.log('[HattrickEventi] Triggering immediate run on startup (interval passed)');
            this.run('auto').catch(error => {
                console.error('[HattrickEventi] Startup run failed:', error);
            });

            this._autoRunTimer = setInterval(() => {
                this._triggerScheduledRun();
            }, intervalMs);
            return;
        }

        const waitTime = intervalMs - timeSinceLastRun;
        console.log(`[HattrickEventi] Next run scheduled in ${Math.round(waitTime / 60000)} minutes`);

        this._autoRunTimer = setTimeout(() => {
            this._triggerScheduledRun();
            this._autoRunTimer = setInterval(() => {
                this._triggerScheduledRun();
            }, intervalMs);
        }, waitTime);
    }

    _triggerScheduledRun() {
        if (!this.isRunning) {
            console.log('[HattrickEventi] Triggering scheduled run...');
            this.run('auto').catch(error => {
                console.error('[HattrickEventi] Scheduled run failed:', error);
            });
        } else {
            console.log('[HattrickEventi] Scheduled run skipped (already running)');
        }
    }

    async restartAutoRun() {
        await this.startAutoRun();
    }

    stopAutoRun() {
        if (this._autoRunTimer) {
            clearInterval(this._autoRunTimer);
            this._autoRunTimer = null;
            console.log('[HattrickEventi] Auto-run disabled');
        }
    }
}

module.exports = new HattrickEventiService();