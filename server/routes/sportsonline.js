const express = require('express');
const router = express.Router();
const sportsonlineService = require('../services/sportsonlineService');

/**
 * Get SportsOnline scraper status and history
 * GET /api/sportsonline/status
 */
router.get('/status', async (req, res) => {
    try {
        const status = await sportsonlineService.getStatus();
        res.json(status);
    } catch (err) {
        console.error('Error getting SportsOnline status:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get SportsOnline scraper logs
 * GET /api/sportsonline/logs
 */
router.get('/logs', (req, res) => {
    res.json({ logs: sportsonlineService.getLogs() });
});

/**
 * Run SportsOnline scraper
 * POST /api/sportsonline/run
 */
router.post('/run', async (req, res) => {
    try {
        if (sportsonlineService.isRunning) {
            return res.status(400).json({ error: 'SportsOnline scraper is already running' });
        }

        sportsonlineService.run().catch(err => {
            console.error('[SportsOnline Route] Run failed:', err);
        });

        res.json({ message: 'SportsOnline scraper started' });
    } catch (err) {
        console.error('Error starting SportsOnline scraper:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Download SportsOnline playlist
 * GET /api/sportsonline/download
 */
router.get('/download', (req, res) => {
    const playlistFile = sportsonlineService.playlistFile;
    if (require('fs').existsSync(playlistFile)) {
        res.download(playlistFile, 'sportsonline.m3u');
    } else {
        res.status(404).json({ error: 'Playlist file not found' });
    }
});

/**
 * Update SportsOnline scraper settings
 * PUT /api/sportsonline/settings
 */
router.put('/settings', async (req, res) => {
    try {
        const { settings: dbSettings } = require('../db');
        const updates = req.body;

        await dbSettings.update(updates);
        await sportsonlineService.restartAutoRun();

        res.json({ message: 'SportsOnline scraper settings updated' });
    } catch (err) {
        console.error('Error updating SportsOnline settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Resolve a fresh stream URL for a SportsOnline channel on-demand
 * POST /api/sportsonline/resolve
 * Body: { url: "https://...php page URL" }
 */
router.post('/resolve', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'Valid url required in request body' });
        }

        const result = await sportsonlineService.resolveAndCache(url);

        if (!result.streamUrl) {
            return res.status(404).json({ error: 'Could not resolve stream URL' });
        }

        res.json(result);
    } catch (err) {
        console.error('[SportsOnline Resolve] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
