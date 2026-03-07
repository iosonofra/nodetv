const express = require('express');
const router = express.Router();
const scraperService = require('../services/scraperService');

/**
 * Get scraper status and history
 * GET /api/scraper/status
 */
router.get('/status', async (req, res) => {
    try {
        const status = await scraperService.getStatus();
        res.json(status);
    } catch (err) {
        console.error('Error getting scraper status:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get scraper logs
 * GET /api/scraper/logs
 */
router.get('/logs', (req, res) => {
    res.json({ logs: scraperService.getLogs() });
});

/**
 * Run scraper
 * POST /api/scraper/run
 */
router.post('/run', async (req, res) => {
    try {
        if (scraperService.isRunning) {
            return res.status(400).json({ error: 'Scraper is already running' });
        }

        // Run async, don't wait for completion to respond
        scraperService.run().catch(err => {
            console.error('[Scraper Route] Run failed:', err);
        });

        res.json({ message: 'Scraper started' });
    } catch (err) {
        console.error('Error starting scraper:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Download scraper playlist
 * GET /api/scraper/download
 */
router.get('/download', (req, res) => {
    const playlistFile = scraperService.playlistFile;
    if (require('fs').existsSync(playlistFile)) {
        res.download(playlistFile, 'thisnotbusiness.m3u');
    } else {
        res.status(404).json({ error: 'Playlist file not found' });
    }
});

/**
 * Update scraper settings
 * PUT /api/scraper/settings
 */
router.put('/settings', async (req, res) => {
    try {
        const { settings: dbSettings } = require('../db');
        const updates = req.body;

        // Update DB settings
        await dbSettings.update(updates);

        // Restart scraper auto-run with new settings
        await scraperService.restartAutoRun();

        res.json({ message: 'Scraper settings updated' });
    } catch (err) {
        console.error('Error updating scraper settings:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
