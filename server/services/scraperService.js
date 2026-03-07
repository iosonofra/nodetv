const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sources, users } = require('../db');
const syncService = require('./syncService');

class ScraperService {
    constructor() {
        this.isRunning = false;
        this.lastRun = null;
        this.currentProcess = null;
        this.logs = [];
        this.maxLogs = 500;

        this.dataDir = path.join(__dirname, '../../data/scraper');
        this.historyFile = path.join(this.dataDir, 'history.json');
        this.playlistFile = path.join(this.dataDir, 'thisnotbusiness.m3u');

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            lastRun: this.lastRun,
            history: this.getHistory()
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

    async run() {
        if (this.isRunning) {
            throw new Error('Scraper is already running');
        }

        this.isRunning = true;
        this.logs = [];
        this.addLog('[*] Starting scraper execution...');

        const scriptPath = path.join(__dirname, '../scraper/thisnotbusiness.js');

        // Use the current node executable
        this.currentProcess = spawn(process.execPath, [scriptPath], {
            env: { ...process.env, PORT: process.env.PORT || 3000 }
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
            this.currentProcess.on('close', async (code) => {
                this.isRunning = false;
                this.currentProcess = null;
                this.lastRun = new Date();

                if (code === 0) {
                    this.addLog('[*] Scraper finished successfully.');

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
                auto_sync: true
            }, admin.id);

            this.addLog(`[+] New source created (ID: ${newSource.id}).`);

            // Trigger initial sync
            await syncService.syncSource(newSource.id);
            this.addLog('[*] Initial sync triggered.');
        }
    }
}

// Singleton instance
module.exports = new ScraperService();
