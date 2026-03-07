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

// Download the generated playlist
router.get('/playlist', (req, res) => {
    const fs = require('fs');
    const path = require('path');

    // Path should match where scraperService saves it
    const m3uPath = path.join(__dirname, '..', '..', 'scraper', 'playlist.m3u');

    if (fs.existsSync(m3uPath)) {
        res.download(m3uPath, 'eventi-live.m3u');
    } else {
        res.status(404).json({ error: 'Playlist file not found. Run the scraper first.' });
    }
});

module.exports = router;
