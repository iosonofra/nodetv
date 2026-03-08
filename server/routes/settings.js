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

        const fetch = require('node-fetch');
        const { SocksProxyAgent } = require('socks-proxy-agent');
        const agent = new SocksProxyAgent(proxyUrl);

        const startTime = Date.now();
        // Use icanhazip.com to get the public IP of the proxy
        const testUrl = 'https://icanhazip.com';

        const response = await fetch(testUrl, {
            agent,
            timeout: 5000,
            headers: { 'User-Agent': 'curl/7.68.0' }
        });

        const duration = Date.now() - startTime;

        if (response.ok) {
            const ip = (await response.text()).trim();
            res.json({
                success: true,
                duration,
                status: response.status,
                ip: ip,
                message: `Connection successful! Proxy IP: ${ip}`
            });
        } else {
            res.json({
                success: false,
                error: `Proxy returned status ${response.status}`,
                status: response.status
            });
        }

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

            return res.json({
                installed: true,
                method: 'warp-cli',
                status: statusLabel,
                mode: proxyMode ? 'Proxy' : 'Warp',
                port: proxyPort
            });
        } catch (e) {
            // warp-cli failed, try Docker
            try {
                const { stdout: dockerInspect } = await execPromise('docker inspect warp-proxy');
                const info = JSON.parse(dockerInspect)[0];
                const isRunning = info.State.Running;

                // Try to get port from config if possible, fallback to 40001
                const portMap = info.HostConfig.PortBindings;
                let port = '40001';
                if (portMap) {
                    const firstKey = Object.keys(portMap)[0];
                    if (firstKey) port = portMap[firstKey][0].HostPort;
                }

                return res.json({
                    installed: true,
                    method: 'docker',
                    status: isRunning ? 'Connected (Docker)' : 'Stopped (Docker)',
                    mode: 'Proxy',
                    port: port
                });
            } catch (dockerErr) {
                return res.json({ installed: false, error: 'warp-cli not found and warp-proxy container not found' });
            }
        }
    } catch (err) {
        console.error('Error getting Warp status:', err);
        res.status(500).json({ installed: true, error: err.message });
    }
});

/**
 * Get Warp / Docker logs
 * GET /api/settings/warp-logs
 */
router.get('/warp-logs', async (req, res) => {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    try {
        // Try Docker first as it's the current solution
        try {
            const { stdout } = await execPromise('docker logs --tail 100 warp-proxy');
            return res.json({ logs: stdout });
        } catch (e) {
            // Fallback to searching for logs elsewhere or error
            res.json({ logs: 'No Docker logs found for warp-proxy container.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
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

