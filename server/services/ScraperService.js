const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sources } = require('../db');

class ScraperService {
    constructor() {
        this.scrapingInProgress = false;
        this.lastRun = null;
        this.logs = [];
        this.maxLogs = 100;
        this.intervalMs = 60 * 60 * 1000; // 1 hour
        this.timer = null;
        this.scraperPath = path.join(__dirname, '..', '..', 'scraper', 'scraper.py');
        this.workDir = path.join(__dirname, '..', '..', 'scraper');
        this.m3uPath = path.join(this.workDir, 'playlist.m3u');
    }

    getStatus() {
        return {
            inProgress: this.scrapingInProgress,
            lastRun: this.lastRun,
            logs: this.logs.slice(-20) // Return last 20 lines
        };
    }

    addLog(message) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${message}`;
        this.logs.push(logEntry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        console.log(`[Scraper] ${message}`);
    }

    async init() {
        this.addLog('Initializing ScraperService...');
        await this.ensureSystemSource();
        this.startScheduler();
        // Run once on startup if the playlist doesn't exist
        if (!fs.existsSync(this.m3uPath)) {
            this.addLog('Playlist not found, triggering initial scrape...');
            this.runScraper();
        }
    }

    async ensureSystemSource() {
        try {
            const allSources = await sources.getAll();
            const exists = allSources.find(s => s.id === 0 || s.name === 'EVENTI-LIVE');

            if (!exists) {
                this.addLog('Creating system source: EVENTI-LIVE');
                // We use a manual insert into db.json via the sources object if possible
                // but since ID 0 is special, let's just use the public creator and then we might need to fix the ID
                // Actually, let's just make it a normal source owned by admin (user_id: 1) but with a special name or flag
                // User explicitly said "user_id: 0" in design, but let's check sources.create

                const m3uUrl = `file://${this.m3uPath}`;
                await sources.create({
                    id: 0, // Force ID 0 if possible
                    user_id: 0, // Special system user
                    name: 'EVENTI-LIVE',
                    type: 'm3u',
                    url: m3uUrl,
                    enabled: true
                });
            }
        } catch (err) {
            this.addLog(`Error ensuring system source: ${err.message}`);
        }
    }

    startScheduler() {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => {
            this.addLog('Hourly scheduled scrape triggered');
            this.runScraper();
        }, this.intervalMs);
        this.addLog(`Scraper scheduled every ${this.intervalMs / (60 * 60 * 1000)} hour(s)`);
    }

    runScraper() {
        if (this.scrapingInProgress) {
            this.addLog('Scraper already in progress, skipping...');
            return;
        }

        this.scrapingInProgress = true;
        this.lastRun = {
            startTime: new Date().toISOString(),
            status: 'running'
        };
        this.addLog('Starting Python scraper...');

        // Use python3 as standard for Alpine
        const pythonProcess = spawn('python3', [this.scraperPath], {
            cwd: this.workDir,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        pythonProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) this.addLog(output);
        });

        pythonProcess.stderr.on('data', (data) => {
            const error = data.toString().trim();
            if (error) this.addLog(`ERROR: ${error}`);
        });

        pythonProcess.on('close', (code) => {
            this.scrapingInProgress = false;
            const endTime = new Date().toISOString();
            const success = code === 0;

            this.lastRun = {
                ...this.lastRun,
                endTime,
                status: success ? 'success' : 'error',
                exitCode: code
            };

            this.addLog(`Scraper process exited with code ${code}. Status: ${success ? 'SUCCESS' : 'FAILED'}`);

            // Trigger a sync for the EVENTI-LIVE source to refresh channels in app
            // We need to find the source ID for EVENTI-LIVE
            this.refreshSource();
        });
    }

    async refreshSource() {
        try {
            const allSources = await sources.getAll();
            const eventiSource = allSources.find(s => s.name === 'EVENTI-LIVE');
            if (eventiSource) {
                const syncService = require('./syncService');
                this.addLog(`Triggering internal sync for source: ${eventiSource.name}`);
                await syncService.syncSource(eventiSource.id);
            }
        } catch (err) {
            this.addLog(`Error refreshing source: ${err.message}`);
        }
    }
}

module.exports = new ScraperService();
