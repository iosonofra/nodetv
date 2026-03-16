const express = require('express');
const router = express.Router();
const scraperService = require('../services/scraperService');
const dlstreamsService = require('../services/dlstreamsService');
const { fetchCategories } = require('../services/dlstreamsResolver');

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

// ========================================
// DLStreams Scraper Routes
// ========================================

/**
 * Get DLStreams scraper status and history
 * GET /api/scraper/dlstreams/status
 */
router.get('/dlstreams/status', async (req, res) => {
    try {
        const status = await dlstreamsService.getStatus();
        res.json(status);
    } catch (err) {
        console.error('Error getting DLStreams status:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get DLStreams scraper logs
 * GET /api/scraper/dlstreams/logs
 */
router.get('/dlstreams/logs', (req, res) => {
    res.json({ logs: dlstreamsService.getLogs() });
});

/**
 * Run DLStreams scraper
 * POST /api/scraper/dlstreams/run
 */
router.post('/dlstreams/run', async (req, res) => {
    try {
        if (dlstreamsService.isRunning) {
            return res.status(400).json({ error: 'DLStreams scraper is already running' });
        }

        dlstreamsService.run().catch(err => {
            console.error('[DLStreams Route] Run failed:', err);
        });

        res.json({ message: 'DLStreams scraper started' });
    } catch (err) {
        console.error('Error starting DLStreams scraper:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Download DLStreams playlist
 * GET /api/scraper/dlstreams/download
 */
router.get('/dlstreams/download', (req, res) => {
    const playlistFile = dlstreamsService.playlistFile;
    if (require('fs').existsSync(playlistFile)) {
        res.download(playlistFile, 'dlstreams.m3u');
    } else {
        res.status(404).json({ error: 'Playlist file not found' });
    }
});

/**
 * Update DLStreams scraper settings
 * PUT /api/scraper/dlstreams/settings
 */
router.put('/dlstreams/settings', async (req, res) => {
    try {
        const { settings: dbSettings } = require('../db');
        const updates = req.body;

        await dbSettings.update(updates);
        await dlstreamsService.restartAutoRun();

        res.json({ message: 'DLStreams scraper settings updated' });
    } catch (err) {
        console.error('Error updating DLStreams settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Fetch available categories from DLStreams
 * GET /api/scraper/dlstreams/categories
 */
router.get('/dlstreams/categories', async (req, res) => {
    try {
        const { settings: dbSettings } = require('../db');
        const currentSettings = await dbSettings.get();
        const saved = currentSettings.dlstreamsSelectedCategories || [];

        const available = await fetchCategories();

        res.json({ available, selected: saved });
    } catch (err) {
        console.error('Error fetching DLStreams categories:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Save selected DLStreams categories
 * PUT /api/scraper/dlstreams/categories
 */
router.put('/dlstreams/categories', async (req, res) => {
    try {
        const { settings: dbSettings } = require('../db');
        const { categories } = req.body;

        if (!Array.isArray(categories)) {
            return res.status(400).json({ error: 'categories must be an array' });
        }

        await dbSettings.update({ dlstreamsSelectedCategories: categories });
        res.json({ message: 'Categories saved', categories });
    } catch (err) {
        console.error('Error saving DLStreams categories:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Resolve a fresh stream URL for a DLStreams channel on-demand
 * GET /api/scraper/dlstreams/resolve/:channelId
 * 
 * This endpoint uses Puppeteer to visit the DLStreams watch page
 * and intercept the fresh stream URL with a valid token.
 */
router.get('/dlstreams/resolve/:channelId', async (req, res) => {
    try {
        const { channelId } = req.params;
        const forceRefresh = req.query.force === '1' || req.query.force === 'true';

        if (!channelId || !/^\d+$/.test(channelId)) {
            return res.status(400).json({ error: 'Valid numeric channelId required' });
        }

        const result = await dlstreamsService.resolveStreamUrl(channelId, { forceRefresh });

        if (!result.streamUrl) {
            return res.status(404).json({ error: 'Could not resolve stream URL', channelId });
        }

        res.json(result);
    } catch (err) {
        console.error(`[DLStreams Resolve] Error resolving channel ${req.params.channelId}:`, err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

