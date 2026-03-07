const express = require('express');
const router = express.Router();
const scraperService = require('../services/scraperService');

/**
 * Get scraper status and history
 * GET /api/scraper/status
 */
router.get('/status', (req, res) => {
    res.json(scraperService.getStatus());
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

module.exports = router;
