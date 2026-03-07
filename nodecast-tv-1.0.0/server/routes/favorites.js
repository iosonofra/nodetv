const express = require('express');
const router = express.Router();
const { favorites, sources } = require('../db');
const { requireAuth } = require('../auth');

// Check ownership helper
async function checkOwnership(req, sourceId) {
    if (req.user.role === 'admin') return true;
    const source = await sources.getById(sourceId);
    return source && (source.user_id === req.user.id || source.user_id === 0);
}

// Get all favorites
router.get('/', requireAuth, async (req, res) => {
    try {
        const { sourceId, itemType } = req.query;

        // Ownership verified implicitly because they shouldn't even know other Source IDs
        // But let's be strict if they try to fetch favorites for a specific Source ID they don't own
        if (sourceId && !(await checkOwnership(req, sourceId))) {
            return res.status(403).json({ error: 'Access denied to this source' });
        }

        const items = await favorites.getAll(sourceId, itemType);

        // If no sourceId is provided, we must filter out favorites for sources they don't own
        if (!sourceId && req.user.role !== 'admin') {
            const allSources = await sources.getAll();
            const allowedSourceIds = allSources.filter(s => s.user_id === req.user.id || s.user_id === 0).map(s => s.id);
            const filteredItems = items.filter(item => allowedSourceIds.includes(parseInt(item.source_id)));
            return res.json(filteredItems);
        }

        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add favorite
router.post('/', requireAuth, async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        if (!(await checkOwnership(req, sourceId))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await favorites.add(sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove favorite
router.delete('/', requireAuth, async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        if (!(await checkOwnership(req, sourceId))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await favorites.remove(sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check if item is favorited
router.get('/check', requireAuth, async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.query;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        if (!(await checkOwnership(req, sourceId))) {
            return res.json({ isFavorite: false });
        }

        const isFav = await favorites.isFavorite(sourceId, itemId, itemType);
        res.json({ isFavorite: isFav });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
