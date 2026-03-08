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

/**
 * Get Warp CLI status
 * GET /api/settings/warp-status
 */
router.get('/warp-status', async (req, res) => {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    try {
        // 1. Check if warp-cli exists
        try {
            await execPromise('warp-cli --version');
        } catch (e) {
            return res.json({ installed: false, error: 'warp-cli not found' });
        }

        // 2. Get status and settings
        const [statusRes, settingsRes] = await Promise.all([
            execPromise('warp-cli status'),
            execPromise('warp-cli settings')
        ]);

        const statusLabel = statusRes.stdout.match(/Status update: (.*)/)?.[1] ||
            statusRes.stdout.match(/Status: (.*)/)?.[1] ||
            statusRes.stdout.trim();

        const proxyMode = settingsRes.stdout.includes('Mode: Proxy') || settingsRes.stdout.includes('Proxy Mode');
        const proxyPort = settingsRes.stdout.match(/Proxy port: (\d+)/)?.[1] || '40001';

        res.json({
            installed: true,
            status: statusLabel,
            mode: proxyMode ? 'Proxy' : 'Warp',
            port: proxyPort
        });
    } catch (err) {
        console.error('Error getting Warp status:', err);
        res.status(500).json({ installed: true, error: err.message });
    }
});

/**
 * Configure Warp for Proxy Mode
 * POST /api/settings/warp-setup
 */
router.post('/warp-setup', async (req, res) => {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    try {
        console.log('[WarpSetup] Configuring Warp...');

        // 0. Check if warp-cli exists
        try {
            await execPromise('warp-cli --version');
        } catch (e) {
            return res.status(404).json({
                success: false,
                error: 'warp-cli not found on this server. It must be installed manually before using this tool.'
            });
        }

        // 1. Set mode to proxy
        await execPromise('warp-cli set-mode proxy');

        // 2. Set proxy port to 40001
        await execPromise('warp-cli set-proxy-port 40001');

        // 3. Connect
        await execPromise('warp-cli connect');

        res.json({ success: true, message: 'Warp configured for proxy mode on port 40001' });
    } catch (err) {
        console.error('Error during Warp setup:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

