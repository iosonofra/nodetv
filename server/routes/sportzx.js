const express = require('express');
const router = express.Router();
const sportzxService = require('../services/sportzxService');

/**
 * Get Sportzx scraper status and history
 * GET /api/sportzx/status
 */
router.get('/status', async (req, res) => {
    try {
        const status = await sportzxService.getStatus();
        res.json(status);
    } catch (err) {
        console.error('Error getting Sportzx status:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get Sportzx scraper logs
 * GET /api/sportzx/logs
 */
router.get('/logs', (req, res) => {
    res.json({ logs: sportzxService.getLogs() });
});

/**
 * Run Sportzx scraper
 * POST /api/sportzx/run
 */
router.post('/run', async (req, res) => {
    try {
        if (sportzxService.isRunning) {
            return res.status(400).json({ error: 'Sportzx scraper is already running' });
        }

        sportzxService.run().catch(err => {
            console.error('[Sportzx Route] Run failed:', err);
        });

        res.json({ message: 'Sportzx scraper started' });
    } catch (err) {
        console.error('Error starting Sportzx scraper:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Download Sportzx playlist
 * GET /api/sportzx/download
 */
router.get('/download', (req, res) => {
    const playlistFile = sportzxService.playlistFile;
    if (require('fs').existsSync(playlistFile)) {
        res.download(playlistFile, 'sportzx.m3u');
    } else {
        res.status(404).json({ error: 'Playlist file not found' });
    }
});

/**
 * Update Sportzx scraper settings
 * PUT /api/sportzx/settings
 */
router.put('/settings', async (req, res) => {
    try {
        const { settings: dbSettings } = require('../db');
        const updates = req.body;

        await dbSettings.update(updates);
        await sportzxService.restartAutoRun();

        res.json({ message: 'Sportzx scraper settings updated' });
    } catch (err) {
        console.error('Error updating Sportzx settings:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
