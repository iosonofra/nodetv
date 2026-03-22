const express = require('express');
const router = express.Router();
const pepperLiveService = require('../services/pepperLiveService');

/**
 * Get PepperLive scraper status and history
 * GET /api/pepperlive/status
 */
router.get('/status', async (req, res) => {
    try {
        const status = await pepperLiveService.getStatus();
        res.json(status);
    } catch (err) {
        console.error('Error getting PepperLive status:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get PepperLive scraper logs
 * GET /api/pepperlive/logs
 */
router.get('/logs', (req, res) => {
    res.json({ logs: pepperLiveService.getLogs() });
});

/**
 * Run PepperLive scraper
 * POST /api/pepperlive/run
 */
router.post('/run', async (req, res) => {
    try {
        if (pepperLiveService.isRunning) {
            return res.status(400).json({ error: 'PepperLive scraper is already running' });
        }

        pepperLiveService.run().catch(err => {
            console.error('[PepperLive Route] Run failed:', err);
        });

        res.json({ message: 'PepperLive scraper started' });
    } catch (err) {
        console.error('Error starting PepperLive scraper:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Download PepperLive playlist
 * GET /api/pepperlive/download
 */
router.get('/download', (req, res) => {
    const playlistFile = pepperLiveService.playlistFile;
    if (require('fs').existsSync(playlistFile)) {
        res.download(playlistFile, 'pepperlive.m3u');
    } else {
        res.status(404).json({ error: 'Playlist file not found' });
    }
});

/**
 * Update PepperLive scraper settings
 * PUT /api/pepperlive/settings
 */
router.put('/settings', async (req, res) => {
    try {
        const { settings: dbSettings } = require('../db');
        const updates = req.body;

        await dbSettings.update(updates);
        await pepperLiveService.restartAutoRun();

        res.json({ message: 'PepperLive scraper settings updated' });
    } catch (err) {
        console.error('Error updating PepperLive settings:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
