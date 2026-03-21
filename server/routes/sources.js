const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { getDb } = require('../db/sqlite');
const xtreamApi = require('../services/xtreamApi');
const syncService = require('../services/syncService');
const m3uParser = require('../services/m3uParser');
const { requireAuth } = require('../auth');
const fetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');

router.use(requireAuth);

// Get all sources
router.get('/', async (req, res) => {
    try {
        const allSources = await sources.getAll(req.user.id, req.user.role);
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

// Export all user sources as a JSON backup
router.get('/backup', async (req, res) => {
    try {
        const allSources = await sources.getAll(req.user.id, req.user.role);
        // Only include sources owned by the user (admins get everything)
        const ownSources = allSources.filter(s =>
            s.user_id === req.user.id || req.user.role === 'admin'
        );
        const backup = {
            version: 1,
            exported_at: new Date().toISOString(),
            exported_by: req.user.username || String(req.user.id),
            sources: ownSources.map(s => ({
                type: s.type,
                name: s.name,
                url: s.url,
                username: s.username || null,
                password: s.password || null,
                useWarp: !!s.useWarp,
                enabled: s.enabled !== false,
                is_public: !!s.is_public,
            }))
        };
        const date = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        res.setHeader('Content-Disposition', `attachment; filename="sources-backup-${date}.json"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(backup);
    } catch (err) {
        console.error('Error creating sources backup:', err);
        res.status(500).json({ error: 'Failed to create backup' });
    }
});

// Get sources by type
router.get('/type/:type', async (req, res) => {
    try {
        const typeSources = await sources.getByType(req.params.type, req.user.id, req.user.role);
        res.json(typeSources);
    } catch (err) {
        console.error('Error getting sources by type:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get single source
router.get('/:id', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id, req.user.id, req.user.role);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // Sanitize sensitive info for non-admins/non-owners
        const isOwner = source.user_id === req.user.id;
        const isAdmin = req.user.role === 'admin';

        if (!isAdmin && !isOwner) {
            return res.json({
                ...source,
                password: source.password ? '••••••••' : null
            });
        }

        res.json(source);
    } catch (err) {
        console.error('Error getting source:', err);
        res.status(500).json({ error: 'Failed to get source' });
    }
});

// Create source
router.post('/', async (req, res) => {
    try {
        const { type, name, url, username, password, useWarp } = req.body;

        if (!type || !name || !url) {
            return res.status(400).json({ error: 'Type, name, and URL are required' });
        }

        if (!['xtream', 'm3u', 'epg'].includes(type)) {
            return res.status(400).json({ error: 'Invalid source type' });
        }

        // Sanitize path if it looks like an absolute Windows path
        let sanitizedUrl = url;
        if (sanitizedUrl && sanitizedUrl.includes('\\') && sanitizedUrl.includes('data')) {
            const parts = sanitizedUrl.split(/[\\/]/);
            const dataIndex = parts.indexOf('data');
            if (dataIndex !== -1) {
                sanitizedUrl = parts.slice(dataIndex).join('/');
                console.log(`[Sources] Sanitized absolute path to: ${sanitizedUrl}`);
            }
        }

        const source = await sources.create({ type, name, url: sanitizedUrl, username, password, useWarp: !!useWarp }, req.user.id);
        // Trigger Sync
        syncService.syncSource(source.id).catch(console.error);
        res.status(201).json(source);
    } catch (err) {
        console.error('Error creating source:', err);
        res.status(500).json({ error: 'Failed to create source' });
    }
});

// Update source
router.put('/:id', async (req, res) => {
    try {
        const existing = await sources.getById(req.params.id, req.user.id, req.user.role);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found or unauthorized' });
        }

        const { name, url, username, password, useWarp } = req.body;

        // Sanitize path if it looks like an absolute Windows path
        let sanitizedUrl = url;
        if (sanitizedUrl && sanitizedUrl.includes('\\') && sanitizedUrl.includes('data')) {
            const parts = sanitizedUrl.split(/[\\/]/);
            const dataIndex = parts.indexOf('data');
            if (dataIndex !== -1) {
                sanitizedUrl = parts.slice(dataIndex).join('/');
                console.log(`[Sources] Sanitized absolute path during update to: ${sanitizedUrl}`);
            }
        }

        const updatedData = {
            name: name || existing.name,
            url: sanitizedUrl || existing.url,
            username: username !== undefined ? username : existing.username,
            password: password !== undefined ? password : existing.password,
            useWarp: useWarp !== undefined ? !!useWarp : existing.useWarp
        };

        const updated = await sources.update(req.params.id, updatedData, req.user.id, req.user.role);
        // Trigger Sync (if critical fields changed? safely just trigger it)
        syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        res.json(updated);
    } catch (err) {
        console.error('Error updating source:', err);
        res.status(500).json({ error: 'Failed to update source' });
    }
});

// Delete source
router.delete('/:id', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.id);
        const existing = await sources.getById(sourceId, req.user.id, req.user.role);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found or unauthorized' });
        }

        // Cascade delete: Clean up SQLite data for this source
        const db = getDb();
        const deleteCategories = db.prepare('DELETE FROM categories WHERE source_id = ?');
        const deleteItems = db.prepare('DELETE FROM playlist_items WHERE source_id = ?');
        const deleteEpg = db.prepare('DELETE FROM epg_programs WHERE source_id = ?');
        const deleteSyncStatus = db.prepare('DELETE FROM sync_status WHERE source_id = ?');

        const catResult = deleteCategories.run(sourceId);
        const itemResult = deleteItems.run(sourceId);
        const epgResult = deleteEpg.run(sourceId);
        deleteSyncStatus.run(sourceId);

        console.log(`[Source] Cascade delete for source ${sourceId}: ${catResult.changes} categories, ${itemResult.changes} items, ${epgResult.changes} EPG programs`);

        // Delete source config and related hidden items (favorites handled by db.js)
        await sources.delete(sourceId, req.user.id, req.user.role);

        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting source:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// Toggle source enabled/disabled
router.post('/:id/toggle', async (req, res) => {
    try {
        const updated = await sources.toggleEnabled(req.params.id, req.user.id, req.user.role);
        if (!updated) {
            return res.status(404).json({ error: 'Source not found or unauthorized' });
        }

        // If enabled, trigger sync
        if (updated.enabled) {
            syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        }

        res.json(updated);
    } catch (err) {
        console.error('Error toggling source:', err);
        res.status(500).json({ error: 'Failed to toggle source' });
    }
});

// Manual Sync
router.post('/:id/sync', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const source = await sources.getById(id, req.user.id, req.user.role);
        if (!source) return res.status(404).json({ error: 'Source not found or unauthorized' });

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
        const source = await sources.getById(req.params.id, req.user.id, req.user.role);
        if (!source) {
            return res.status(404).json({ error: 'Source not found or unauthorized' });
        }

        const settingsData = await require('../db').settings.get();
        const proxyUrl = (source.useWarp && settingsData.warpProxyUrl) ? settingsData.warpProxyUrl : null;
        const proxyAgent = proxyUrl ? new SocksProxyAgent(proxyUrl) : null;

        if (source.type === 'xtream') {
            const api = new xtreamApi.XtreamApi(source.url, source.username, source.password, proxyUrl);
            const result = await api.authenticate();
            res.json({ success: true, data: result });
        } else if (source.type === 'm3u') {
            const response = await fetch(source.url, { agent: proxyAgent, timeout: 10000 });
            const text = await response.text();
            const isValid = text.includes('#EXTM3U');
            res.json({ success: isValid, message: isValid ? 'Valid M3U playlist' : 'Invalid M3U format' });
        } else if (source.type === 'epg') {
            const response = await fetch(source.url, { agent: proxyAgent, timeout: 10000 });
            const text = await response.text();
            const isValid = text.includes('<tv') || text.includes('<?xml');
            res.json({ success: isValid, message: isValid ? 'Valid EPG XML' : 'Invalid EPG format' });
        }
    } catch (err) {
        console.error('Error testing source:', err);
        res.json({ success: false, error: err.message });
    }
});

// Estimate M3U playlist size (for large playlist warning)
const M3U_LARGE_THRESHOLD = 50000;

// Estimate by URL (for new sources before creation)
router.post('/estimate', async (req, res) => {
    try {
        const { url, type } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Only M3U sources need estimation
        if (type !== 'm3u') {
            return res.json({ count: 0, needsWarning: false, threshold: M3U_LARGE_THRESHOLD });
        }

        console.log(`[Sources] Estimating M3U size for URL...`);
        const settingsData = await require('../db').settings.get();
        const { useWarp } = req.body;
        const proxyUrl = (useWarp && settingsData.warpProxyUrl) ? settingsData.warpProxyUrl : null;
        const proxyAgent = proxyUrl ? new SocksProxyAgent(proxyUrl) : null;

        const count = await m3uParser.countEntries(url, proxyAgent);
        console.log(`[Sources] M3U estimate: ${count} entries`);

        res.json({
            count,
            needsWarning: count > M3U_LARGE_THRESHOLD,
            threshold: M3U_LARGE_THRESHOLD
        });
    } catch (err) {
        console.error('Error estimating M3U size:', err);
        res.status(500).json({ error: 'Failed to estimate playlist size', message: err.message });
    }
});

// Estimate by source ID (for existing sources)
router.get('/:id/estimate', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id, req.user.id, req.user.role);
        if (!source) {
            return res.status(404).json({ error: 'Source not found or unauthorized' });
        }

        // Only M3U sources need estimation
        if (source.type !== 'm3u') {
            return res.json({ count: 0, needsWarning: false, threshold: M3U_LARGE_THRESHOLD });
        }

        console.log(`[Sources] Estimating M3U size for ${source.name}...`);
        const settingsData = await require('../db').settings.get();
        const proxyUrl = (source.useWarp && settingsData.warpProxyUrl) ? settingsData.warpProxyUrl : null;
        const proxyAgent = proxyUrl ? new SocksProxyAgent(proxyUrl) : null;

        if (proxyAgent) {
            console.log(`[Sources] Using Warp proxy for estimation of source ${source.id}`);
        } else {
            console.log(`[Sources] Skipping Warp proxy for estimation of source ${source.id} (useWarp: ${!!source.useWarp})`);
        }

        const count = await m3uParser.countEntries(source.url, proxyAgent);
        console.log(`[Sources] M3U estimate: ${count} entries`);

        res.json({
            count,
            needsWarning: count > M3U_LARGE_THRESHOLD,
            threshold: M3U_LARGE_THRESHOLD
        });
    } catch (err) {
        console.error('Error estimating M3U size:', err);
        res.status(500).json({ error: 'Failed to estimate playlist size', message: err.message });
    }
});

// Restore sources from a JSON backup
router.post('/restore', async (req, res) => {
    try {
        const { sources: importSources, mode = 'merge' } = req.body;

        if (!Array.isArray(importSources) || importSources.length === 0) {
            return res.status(400).json({ error: 'No sources to import' });
        }

        const validTypes = ['xtream', 'm3u', 'epg'];
        for (const s of importSources) {
            if (!s.type || !validTypes.includes(s.type)) {
                return res.status(400).json({ error: `Invalid source type: "${s.type}"` });
            }
            if (!s.name || !s.url) {
                return res.status(400).json({ error: `Source "${s.name || '(unnamed)'}" is missing required fields (name, url)` });
            }
        }

        // Load existing sources for duplicate detection
        const existing = await sources.getAll(req.user.id, req.user.role);
        const existingKeys = new Set(existing.map(s => `${s.type}::${s.name}`));

        let imported = 0;
        let skipped = 0;
        const errors = [];

        for (const s of importSources) {
            const key = `${s.type}::${s.name}`;
            if (mode === 'merge' && existingKeys.has(key)) {
                skipped++;
                continue;
            }
            try {
                // Sanitize path if it looks like an absolute Windows path
                let sanitizedUrl = s.url;
                if (sanitizedUrl && sanitizedUrl.includes('\\') && sanitizedUrl.includes('data')) {
                    const parts = sanitizedUrl.split(/[\\/]/);
                    const dataIndex = parts.indexOf('data');
                    if (dataIndex !== -1) sanitizedUrl = parts.slice(dataIndex).join('/');
                }
                const created = await sources.create({
                    type: s.type,
                    name: s.name,
                    url: sanitizedUrl,
                    username: s.username || null,
                    password: s.password || null,
                    useWarp: !!s.useWarp,
                    enabled: s.enabled !== false,
                    is_public: !!s.is_public,
                }, req.user.id);
                syncService.syncSource(created.id).catch(console.error);
                imported++;
            } catch (err) {
                errors.push(`${s.name}: ${err.message}`);
            }
        }

        console.log(`[Sources] Restore: ${imported} imported, ${skipped} skipped, ${errors.length} errors`);
        res.json({ imported, skipped, errors });
    } catch (err) {
        console.error('Error restoring sources:', err);
        res.status(500).json({ error: 'Failed to restore sources' });
    }
});

// Global Sync - sync all enabled sources
router.post('/sync-all', async (req, res) => {
    try {
        // Admin only for global sync unless we limit to their sources
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin only' });
        }
        // Trigger global sync (async - don't wait for completion)
        syncService.syncAll().catch(console.error);
        res.json({ success: true, message: 'Global sync started' });
    } catch (err) {
        console.error('Error starting global sync:', err);
        res.status(500).json({ error: 'Failed to start global sync' });
    }
});

module.exports = router;

