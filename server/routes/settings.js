const express = require('express');
const router = express.Router();
const { settings, getDefaultSettings } = require('../db');
const syncService = require('../services/syncService');

/**
 * Get all settings
 * GET /api/settings
 */
router.get('/', async (req, res) => {
    try {
        const currentSettings = await settings.get();
        res.json(currentSettings);
    } catch (err) {
        console.error('Error getting settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Update settings (partial update)
 * PUT /api/settings
 */
router.put('/', async (req, res) => {
    try {
        const updates = req.body;
        const updatedSettings = await settings.update(updates);

        // If sync interval changed, restart the server-side sync timer
        if (updates.epgRefreshInterval !== undefined) {
            syncService.restartSyncTimer().catch(console.error);
        }

        res.json(updatedSettings);
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Reset settings to defaults
 * DELETE /api/settings
 */
router.delete('/', async (req, res) => {
    try {
        const defaultSettings = await settings.reset();
        res.json(defaultSettings);
    } catch (err) {
        console.error('Error resetting settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get default settings (for reference)
 * GET /api/settings/defaults
 */
router.get('/defaults', (req, res) => {
    res.json(getDefaultSettings());
});

/**
 * Get sync status (last sync time)
 * GET /api/settings/sync-status
 */
router.get('/sync-status', (req, res) => {
    const lastSyncTime = syncService.getLastSyncTime();
    res.json({
        lastSyncTime: lastSyncTime ? lastSyncTime.toISOString() : null
    });
});

/**
 * Get hardware capabilities (GPU acceleration support)
 * GET /api/settings/hw-info
 */
router.get('/hw-info', async (req, res) => {
    try {
        const hwDetect = require('../services/hwDetect');
        let capabilities = hwDetect.getCapabilities();

        // If not yet detected, run detection now
        if (!capabilities) {
            capabilities = await hwDetect.detect();
        }

        res.json(capabilities);
    } catch (err) {
        console.error('Error getting hardware info:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Refresh hardware detection (re-probe GPUs)
 * POST /api/settings/hw-info/refresh
 */
/**
 * Test Warp proxy connectivity
 * POST /api/settings/test-warp
 */
router.post('/test-warp', async (req, res) => {
    try {
        const { proxyUrl } = req.body;
        if (!proxyUrl) return res.status(400).json({ error: 'Proxy URL required' });

        const { SocksProxyAgent } = require('socks-proxy-agent');
        const https = require('https');
        const agent = new SocksProxyAgent(proxyUrl);

        // Try to fetch Cloudflare trace
        const startTime = Date.now();

        const testUrl = 'https://www.google.com'; // Simple test

        const request = https.get(testUrl, { agent, timeout: 5000 }, (testRes) => {
            const duration = Date.now() - startTime;
            if (testRes.statusCode >= 200 && testRes.statusCode < 400) {
                res.json({ success: true, duration, status: testRes.statusCode });
            } else {
                res.json({ success: false, error: `Proxy returned status ${testRes.statusCode}`, status: testRes.statusCode });
            }
        });

        request.on('error', (err) => {
            console.error('Warp test request error:', err);
            res.json({ success: false, error: err.message });
        });

        request.on('timeout', () => {
            request.destroy();
            res.json({ success: false, error: 'Connection timed out (5s)' });
        });

    } catch (err) {
        console.error('Warp test failed:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

