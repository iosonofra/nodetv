const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const xtreamApi = require('../services/xtreamApi');
const syncService = require('../services/syncService');
const { requireAuth } = require('../auth');

// Get all sources
router.get('/', requireAuth, async (req, res) => {
    try {
        let allSources = await sources.getAll();

        // Filter by ownership unless it's admin asking for all
        if (req.user.role === 'admin' && req.query.all === 'true') {
            // keep all
        } else {
            // Keep user's own sources OR special shared system sources (user_id: 0)
            allSources = allSources.filter(s => s.user_id === req.user.id || s.user_id === 0);
        }

        // Don't expose passwords in list view
        const sanitized = allSources.map(s => ({
            ...s,
            password: s.password ? '••••••••' : null
        }));
        res.json(sanitized);
    } catch (err) {
        console.error('Error getting sources:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get sync status for all sources
router.get('/status', async (req, res) => {
    try {
        const { getDb } = require('../db/sqlite');
        const db = getDb();
        const statuses = db.prepare('SELECT * FROM sync_status').all();
        res.json(statuses);
    } catch (err) {
        console.error('Error getting sync status:', err);
        res.status(500).json({ error: 'Failed to get sync status' });
    }
});

// Get sources by type
router.get('/type/:type', async (req, res) => {
    try {
        const typeSources = await sources.getByType(req.params.type);
        res.json(typeSources);
    } catch (err) {
        console.error('Error getting sources by type:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get single source
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        if (source.user_id !== req.user.id && source.user_id !== 0 && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied to this source' });
        }

        res.json(source);
    } catch (err) {
        console.error('Error getting source:', err);
        res.status(500).json({ error: 'Failed to get source' });
    }
});

// Create source
router.post('/', requireAuth, async (req, res) => {
    try {
        let { type, name, url, username, password, use_warp } = req.body;

        if (!type || !name || !url) {
            return res.status(400).json({ error: 'Type, name, and URL are required' });
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'http://' + url;
        }

        if (!['xtream', 'm3u', 'epg'].includes(type)) {
            return res.status(400).json({ error: 'Invalid source type' });
        }

        let ownerId = req.user.id;
        if (req.user.role === 'admin' && req.body.user_id) {
            ownerId = parseInt(req.body.user_id);
        }

        const source = await sources.create({ type, name, url, username, password, use_warp: !!use_warp, user_id: ownerId });
        // Trigger Sync
        syncService.syncSource(source.id).catch(console.error);
        res.status(201).json(source);
    } catch (err) {
        console.error('Error creating source:', err);
        res.status(500).json({ error: 'Failed to create source' });
    }
});

// Update source
router.put('/:id', requireAuth, async (req, res) => {
    try {
        const existing = await sources.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        if (existing.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied to this source' });
        }

        let { name, url, username, password, use_warp } = req.body;

        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'http://' + url;
        }

        const updateData = {
            name: name || existing.name,
            url: url || existing.url,
            username: username !== undefined ? username : existing.username,
            password: password !== undefined ? password : existing.password,
            use_warp: use_warp !== undefined ? !!use_warp : existing.use_warp
        };

        if (req.user.role === 'admin' && req.body.user_id) {
            updateData.user_id = parseInt(req.body.user_id);
        }

        const updated = await sources.update(req.params.id, updateData);
        // Trigger Sync (if critical fields changed? safely just trigger it)
        syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        res.json(updated);
    } catch (err) {
        console.error('Error updating source:', err);
        res.status(500).json({ error: 'Failed to update source' });
    }
});

// Delete source
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const existing = await sources.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        if (existing.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied to this source' });
        }

        await sources.delete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting source:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// Toggle source enabled/disabled
router.post('/:id/toggle', requireAuth, async (req, res) => {
    try {
        const existing = await sources.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        if (existing.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied to this source' });
        }

        const updated = await sources.toggleEnabled(req.params.id);

        // If enabled, trigger sync
        if (updated && updated.enabled) {
            syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        }

        res.json(updated);
    } catch (err) {
        console.error('Error toggling source:', err);
        res.status(500).json({ error: 'Failed to toggle source' });
    }
});

// Manual Sync
router.post('/:id/sync', requireAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const source = await sources.getById(id);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        if (source.user_id !== req.user.id && source.user_id !== 0 && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied to this source' });
        }

        // Trigger sync (async)
        syncService.syncSource(id).catch(console.error);

        res.json({ success: true, message: 'Sync started' });
    } catch (err) {
        console.error('Error starting sync:', err);
        res.status(500).json({ error: 'Failed to start sync' });
    }
});

// Test source connection
router.post('/:id/test', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        if (source.type === 'xtream') {
            const result = await xtreamApi.authenticate(source.url, source.username, source.password);
            res.json({ success: true, data: result });
        } else if (source.type === 'm3u') {
            const response = await fetch(source.url);
            const text = await response.text();
            const isValid = text.includes('#EXTM3U');
            res.json({ success: isValid, message: isValid ? 'Valid M3U playlist' : 'Invalid M3U format' });
        } else if (source.type === 'epg') {
            const response = await fetch(source.url);
            const text = await response.text();
            const isValid = text.includes('<tv') || text.includes('<?xml');
            res.json({ success: isValid, message: isValid ? 'Valid EPG XML' : 'Invalid EPG format' });
        }
    } catch (err) {
        console.error('Error testing source:', err);
        res.json({ success: false, error: err.message });
    }
});

// Global Sync - sync all enabled sources
router.post('/sync-all', async (req, res) => {
    try {
        // Trigger global sync (async - don't wait for completion)
        syncService.syncAll().catch(console.error);
        res.json({ success: true, message: 'Global sync started' });
    } catch (err) {
        console.error('Error starting global sync:', err);
        res.status(500).json({ error: 'Failed to start global sync' });
    }
});

module.exports = router;

