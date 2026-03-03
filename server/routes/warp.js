const express = require('express');
const router = express.Router();
const warpManager = require('../services/WarpManager');
const { requireAuth } = require('../auth');

// Get WARP status
router.get('/status', requireAuth, (req, res) => {
    try {
        const status = warpManager.getStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get WARP status' });
    }
});

// Setup WARP (Register and Generate Profile)
router.post('/setup', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
    }

    try {
        await warpManager.register();
        res.json({ message: 'WARP setup successful' });
    } catch (err) {
        res.status(500).json({ error: 'WARP setup failed: ' + err.message });
    }
});

// Toggle WARP Proxy
router.post('/toggle', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
    }

    try {
        const { action } = req.body; // 'connect' or 'disconnect'
        if (action === 'connect') {
            await warpManager.startProxy();
            res.json({ message: 'WARP Proxy starting' });
        } else {
            warpManager.stopProxy();
            res.json({ message: 'WARP Proxy stopping' });
        }
    } catch (err) {
        res.status(500).json({ error: 'WARP toggle failed: ' + err.message });
    }
});

module.exports = router;
