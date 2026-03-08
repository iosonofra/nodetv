const express = require('express');
const router = express.Router();
const { settings, getDefaultSettings } = require('../db');
const syncService = require('../services/syncService');
const vpnService = require('../services/vpnService');

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

        // Sync VPN configuration if any VPN settings changed
        if (updates.warpHost !== undefined || updates.warpPort !== undefined || updates.warpProxyRules !== undefined) {
            vpnService.syncConfig(updatedSettings).catch(err => {
                console.error('[Settings] Failed to sync VPN config:', err);
            });
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
router.post('/hw-info/refresh', async (req, res) => {
    try {
        const hwDetect = require('../services/hwDetect');
        const capabilities = await hwDetect.refresh();
        res.json(capabilities);
    } catch (err) {
        console.error('Error refreshing hardware info:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Test VPN connection
 * POST /api/settings/test-vpn
 */
router.post('/test-vpn', async (req, res) => {
    try {
        const { host, port } = req.body;
        if (!host || !port) {
            return res.status(400).json({ error: 'Host and port are required' });
        }
        const result = await vpnService.testConnection(host, port);
        res.json(result);
    } catch (err) {
        console.error('VPN test failed:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get internal server IP (for VPN configuration)
 * GET /api/settings/ip
 */
router.get('/ip', (req, res) => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let ip = '';

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal (loopback) and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                ip = iface.address;
                break;
            }
        }
        if (ip) break;
    }

    res.json({ ip: ip || '127.0.0.1' });
});

module.exports = router;

