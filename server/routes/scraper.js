const express = require('express');
const router = express.Router();
const scraperService = require('../services/ScraperService');
const { requireAuth, requireAdmin } = require('../auth');

// Get scraper status and logs
router.get('/status', requireAuth, requireAdmin, (req, res) => {
    res.json(scraperService.getStatus());
});

// Run scraper manually
router.post('/run', requireAuth, requireAdmin, (req, res) => {
    if (scraperService.scrapingInProgress) {
        return res.status(400).json({ error: 'Scraper is already running' });
    }
    scraperService.runScraper();
    res.json({ message: 'Scraper started successfully' });
});

module.exports = router;
