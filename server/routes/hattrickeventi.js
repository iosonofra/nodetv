const express = require('express');
const router = express.Router();
const hattrickEventiService = require('../services/hattrickEventiService');

router.get('/status', async (req, res) => {
    try {
        const status = await hattrickEventiService.getStatus();
        res.json(status);
    } catch (error) {
        console.error('Error getting Hattrick Eventi status:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/logs', (req, res) => {
    res.json({ logs: hattrickEventiService.getLogs() });
});

router.post('/run', async (req, res) => {
    try {
        if (hattrickEventiService.isRunning) {
            return res.status(400).json({ error: 'Hattrick Eventi scraper is already running' });
        }

        hattrickEventiService.run().catch(error => {
            console.error('[HattrickEventi Route] Run failed:', error);
        });

        res.json({ message: 'Hattrick Eventi scraper started' });
    } catch (error) {
        console.error('Error starting Hattrick Eventi scraper:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/download', (req, res) => {
    const playlistFile = hattrickEventiService.playlistFile;
    if (require('fs').existsSync(playlistFile)) {
        res.download(playlistFile, 'hattrickeventi.m3u');
    } else {
        res.status(404).json({ error: 'Playlist file not found' });
    }
});

router.put('/settings', async (req, res) => {
    try {
        const { settings: dbSettings } = require('../db');
        const updates = req.body;

        await dbSettings.update(updates);
        await hattrickEventiService.restartAutoRun();

        res.json({ message: 'Hattrick Eventi scraper settings updated' });
    } catch (error) {
        console.error('Error updating Hattrick Eventi settings:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;