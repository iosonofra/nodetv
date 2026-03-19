const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { getDb } = require('../db/sqlite'); // Import SQLite
const xtreamApi = require('../services/xtreamApi');
const epgParser = require('../services/epgParser');
const cache = require('../services/cache');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { Readable } = require('stream');
const { requireAuth } = require('../auth');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');
const dlstreamsService = require('../services/dlstreamsService');

// Global agents to ignore certificate errors for upstream media sources
const globalHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const globalHttpAgent = new http.Agent();

/**
 * Helper to get Proxy URL for a source
 * Ensures Warp is only used when useWarp is true and warpProxyUrl is configured
 */
async function getProxyUrl(sourceId) {
    if (!sourceId) return null;
    try {
        const source = await sources.getById(sourceId);
        const settingsData = await require('../db').settings.get();
        if (source && source.useWarp && settingsData.warpProxyUrl) {
            console.log(`[Proxy] Using Warp proxy for source ${sourceId}`);
            return settingsData.warpProxyUrl;
        } else if (source) {
            console.log(`[Proxy] Skipping Warp proxy for source ${sourceId} (useWarp: ${!!source.useWarp})`);
        }
    } catch (err) {
        console.error(`[Proxy] Error checking proxy for source ${sourceId}:`, err.message);
    }
    return null;
}

// Conditional auth middleware: allow public access for streaming/DRM used by video players
router.use((req, res, next) => {
    const publicRoutes = ['/stream', '/drm', '/image'];
    const isPublicStream = publicRoutes.includes(req.path) || req.path.startsWith('/stream/');
    if (isPublicStream) {
        return next();
    }
    return requireAuth(req, res, next);
});

// Default cache max age in hours
const DEFAULT_MAX_AGE_HOURS = 24;

// Helper to get formatted category list from DB
async function getCategoriesFromDb(sourceId, type, includeHidden, userId, role) {
    const source = await sources.getById(sourceId, userId, role);
    if (!source) return [];

    const db = getDb();
    let query = `
        SELECT category_id, name as category_name, parent_id 
        FROM categories 
        WHERE source_id = ? AND type = ?
    `;
    if (!includeHidden) {
        query += ` AND is_hidden = 0`;
    }
    query += ` ORDER BY name ASC`;
    const cats = db.prepare(query).all(sourceId, type);
    return cats;
}

// Helper to get formatted streams from DB
async function getStreamsFromDb(sourceId, type, categoryId, includeHidden, userId, role) {
    const source = await sources.getById(sourceId, userId, role);
    if (!source) return [];

    const db = getDb();
    let query = `
        SELECT item_id, name, stream_icon, added_at, rating, container_extension, year, category_id, data
        FROM playlist_items 
        WHERE source_id = ? AND type = ?
    `;
    if (!includeHidden) {
        query += ` AND is_hidden = 0`;
    }
    const params = [sourceId, type];

    if (categoryId) {
        query += ` AND category_id = ?`;
        params.push(categoryId);
    }

    // Default sorting
    // query += ` ORDER BY name ASC`; // Sorting usually handled by client

    const items = db.prepare(query).all(...params);

    // Map to Xtream format
    return items.map(item => {
        const data = JSON.parse(item.data || '{}');
        // Override with our local fields if needed, or just return the mixed object
        // We should ensure critical fields are present
        return {
            ...data,
            stream_id: item.item_id, // ensure ID matches what client expects
            series_id: type === 'series' ? item.item_id : undefined,
            name: item.name,
            stream_icon: item.stream_icon,
            cover: item.stream_icon, // series/vod often use cover
            added: item.added_at,
            rating: item.rating,
            container_extension: item.container_extension,
            category_id: item.category_id,
            // Normalize EPG channel ID: Xtream uses epg_channel_id, M3U uses tvgId
            epg_channel_id: data.epg_channel_id || data.tvgId || null,
            // Include KODIPROP properties for DRM
            properties: data.properties || null
        };
    });
}


// --- Xtream Codes Proxy API --- //

// Login / Authenticate
router.get('/xtream/:sourceId', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId, req.user?.id, req.user?.role);
        if (!source || source.type !== 'xtream') return res.status(404).send('Source not found or unauthorized');

        const cached = cache.get('xtream', source.id, 'auth', 300000);
        if (cached) return res.json(cached);

        const proxyUrl = await getProxyUrl(source.id);
        const api = xtreamApi.createFromSource(source, proxyUrl);
        const data = await api.authenticate();
        cache.set('xtream', source.id, 'auth', data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// Live Categories
router.get('/xtream/:sourceId/live_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cats = await getCategoriesFromDb(sourceId, 'live', includeHidden, req.user?.id, req.user?.role);
        res.json(cats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Live Streams
router.get('/xtream/:sourceId/live_streams', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        const streams = await getStreamsFromDb(sourceId, 'live', categoryId, includeHidden, req.user?.id, req.user?.role);
        res.json(streams);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// VOD Categories
router.get('/xtream/:sourceId/vod_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cats = await getCategoriesFromDb(sourceId, 'movie', includeHidden, req.user?.id, req.user?.role);
        res.json(cats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// VOD Streams
router.get('/xtream/:sourceId/vod_streams', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        const streams = await getStreamsFromDb(sourceId, 'movie', categoryId, includeHidden, req.user?.id, req.user?.role);
        res.json(streams);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series Categories
router.get('/xtream/:sourceId/series_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cats = await getCategoriesFromDb(sourceId, 'series', includeHidden, req.user?.id, req.user?.role);
        res.json(cats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series
router.get('/xtream/:sourceId/series', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        const streams = await getStreamsFromDb(sourceId, 'series', categoryId, includeHidden, req.user?.id, req.user?.role);
        res.json(streams);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series Info (Episodes)
// Proxy series info request
router.get('/xtream/:sourceId/series_info', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId, req.user?.id, req.user?.role);
        if (!source) return res.status(404).send('Source not found or unauthorized');

        const seriesId = req.query.series_id;
        if (!seriesId) return res.status(400).send('series_id required');

        const cacheKey = `series_info_${seriesId}`;
        const cached = cache.get('xtream', source.id, cacheKey, 3600000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source, await getProxyUrl(source.id));
        const data = await api.getSeriesInfo(seriesId);
        cache.set('xtream', source.id, cacheKey, data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// VOD Info
router.get('/xtream/:sourceId/vod_info', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId, req.user?.id, req.user?.role);
        if (!source) return res.status(404).send('Source not found or unauthorized');

        const vodId = req.query.vod_id;
        if (!vodId) return res.status(400).send('vod_id required');

        const cacheKey = `vod_info_${vodId}`;
        const cached = cache.get('xtream', source.id, cacheKey, 3600000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source, await getProxyUrl(source.id));
        const data = await api.getVodInfo(vodId);
        cache.set('xtream', source.id, cacheKey, data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// Get Stream URL for playback
// Returns the direct stream URL for a given stream ID
router.get('/xtream/:sourceId/stream/:streamId/:type', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId, req.user?.id, req.user?.role);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found or unauthorized' });
        }

        const streamId = req.params.streamId;
        const type = req.params.type || 'live';
        const container = req.query.container || 'm3u8';

        // Construct the Xtream stream URL
        // Format: http://server:port/live/username/password/streamId.container (for live)
        // Format: http://server:port/movie/username/password/streamId.container (for movie)
        // Format: http://server:port/series/username/password/streamId.container (for series)

        let streamUrl;
        const baseUrl = source.url.replace(/\/$/, ''); // Remove trailing slash

        if (type === 'live') {
            streamUrl = `${baseUrl}/live/${source.username}/${source.password}/${streamId}.${container}`;
        } else if (type === 'movie') {
            streamUrl = `${baseUrl}/movie/${source.username}/${source.password}/${streamId}.${container}`;
        } else if (type === 'series') {
            streamUrl = `${baseUrl}/series/${source.username}/${source.password}/${streamId}.${container}`;
        } else {
            return res.status(400).json({ error: 'Invalid stream type' });
        }

        res.json({ url: streamUrl });
    } catch (err) {
        console.error('Error getting stream URL:', err);
        res.status(500).json({ error: 'Failed to get stream URL' });
    }
});


// --- Other Proxy Routes --- //

// M3U Playlist 
// (For M3U sources, we now have data in DB. We can reconstruct M3U or return JSON)
// Frontend ChannelList.js for M3U sources calls `API.proxy.m3u.get(sourceId)`
// which points here. It expects { channels, groups }.
router.get('/m3u/:sourceId', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';

        // Fetch from DB
        const channels = await getStreamsFromDb(sourceId, 'live', null, includeHidden, req.user?.id, req.user?.role);
        const groups = await getCategoriesFromDb(sourceId, 'live', includeHidden, req.user?.id, req.user?.role);

        // Format for frontend helper
        // ChannelList expects:
        // { 
        //   channels: [ { id, name, groupTitle, url, tvgLogo, ... } ], 
        //   groups: [ { id, name, channelCount } ] 
        // }
        // Note: DB `live` items from M3U sync have `category_id` as their group name usually.

        const reformattedChannels = channels.map(c => ({
            ...c,
            id: c.stream_id,
            groupTitle: c.category_id || 'Uncategorized',
            url: c.stream_url || c.url,
            tvgLogo: c.stream_icon
        }));

        const reformattedGroups = groups.map(g => ({
            id: g.category_id,
            name: g.category_name,
            channelCount: 0 // Frontend calculates this or we can
        }));

        // Add implicit groups check?
        // The frontend M3U parser generates groups from the channels if explicit groups missing.
        // Our SyncService `saveCategories` handles explicit groups.

        res.json({ channels: reformattedChannels, groups: reformattedGroups });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// EPG
router.get('/epg/:sourceId', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const source = await sources.getById(sourceId, req.user?.id, req.user?.role);
        if (!source) return res.status(404).json({ error: 'Unauthorized EPG source' });

        const forceRefresh = req.query.refresh === '1';

        // If force refresh or not an xtream/m3u source (direct EPG), we might want to fetch from URL
        // However, for the main EPGBuide, we usually prefer the DB data.
        // We only fetch from URL if requested and it's a standalone EPG source or Xtream XMLTV
        if (forceRefresh && (source.type === 'epg' || source.type === 'xtream')) {
            console.log(`[Proxy] Force refreshing EPG from URL for source ${sourceId}`);
            let url = source.url;
            if (source.type === 'xtream') {
                const api = xtreamApi.createFromSource(source); // Will use Warp in fetchAndParse if we update it
                url = api.getXmltvUrl();
            }

            const proxyUrl = await getProxyUrl(sourceId);
            const proxyAgent = proxyUrl ? new SocksProxyAgent(proxyUrl, { tls: { rejectUnauthorized: false } }) : null;

            const freshData = await epgParser.fetchAndParse(url, proxyAgent);
            // Re-map to match Guide format if needed, but fetchAndParse returns { channels, programmes }
            return res.json(freshData);
        }

        const db = getDb();

        // Time window: 24 hours ago to 24 hours from now
        // This prevents returning millions of rows and crashing the server/browser
        const windowStart = Date.now() - (24 * 60 * 60 * 1000); // -24 hours
        const windowEnd = Date.now() + (24 * 60 * 60 * 1000);   // +24 hours

        // Fetch programs within the time window
        let programsQuery = `
            SELECT channel_id as channelId, start_time, end_time, title, description, data 
            FROM epg_programs 
            WHERE source_id = ? AND end_time > ? AND start_time < ?
        `;
        const params = [sourceId, windowStart, windowEnd];

        const programs = db.prepare(programsQuery).all(...params);

        const formattedPrograms = programs.map(p => ({
            channelId: p.channelId,
            start: new Date(p.start_time).toISOString(), // EpgGuide parse this back
            stop: new Date(p.end_time).toISOString(),
            title: p.title,
            description: p.description
        }));

        // Fetch EPG channels from playlist_items (type='epg_channel')


        let epgChannels = [];

        // Try getting stored channels first
        const storedChannels = db.prepare(`
            SELECT item_id as id, name, stream_icon as icon, data 
            FROM playlist_items 
            WHERE source_id = ? AND type = 'epg_channel'
        `).all(sourceId);

        if (storedChannels.length > 0) {
            epgChannels = storedChannels;
        } else {
            // Fallback: Build from unique channelIds in programmes (Legacy behavior)
            const uniqueChannelIds = [...new Set(programs.map(p => p.channelId))];
            epgChannels = uniqueChannelIds.map(id => ({
                id: id,
                name: id // Use channelId as name (fallback)
            }));
        }

        res.json({
            channels: epgChannels,
            programmes: formattedPrograms
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Clear cache (kept for compatibility)
router.delete('/cache/:sourceId', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clearSource(sourceId);
    res.json({ success: true });
});



/**
 * Proxy Xtream API calls
 * GET /api/proxy/xtream/:sourceId/:action
 */
router.get('/xtream/:sourceId/:action', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId, req.user?.id, req.user?.role);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found or unauthorized' });
        }

        const { action } = req.params;
        const { category_id, stream_id, vod_id, series_id, limit, refresh, maxAge } = req.query;
        const forceRefresh = refresh === '1';
        const maxAgeHours = parseInt(maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Actions that should be cached
        const cacheableActions = [
            'live_categories', 'live_streams',
            'vod_categories', 'vod_streams',
            'series_categories', 'series'
        ];

        // Build cache key (include category_id if present)
        const cacheKey = category_id ? `${action}_${category_id}` : action;

        // Check cache for cacheable actions
        if (!forceRefresh && cacheableActions.includes(action)) {
            const cached = cache.get('xtream', sourceId, cacheKey, maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        // Fetch fresh data
        const proxyUrl = await getProxyUrl(sourceId);
        const api = xtreamApi.createFromSource(source, proxyUrl);
        let data;
        switch (action) {
            case 'auth':
                data = await api.authenticate();
                break;
            case 'live_categories':
                data = await api.getLiveCategories();
                break;
            case 'live_streams':
                data = await api.getLiveStreams(category_id);
                break;
            case 'vod_categories':
                data = await api.getVodCategories();
                break;
            case 'vod_streams':
                data = await api.getVodStreams(category_id);
                break;
            case 'vod_info':
                data = await api.getVodInfo(vod_id);
                break;
            case 'series_categories':
                data = await api.getSeriesCategories();
                break;
            case 'series':
                data = await api.getSeries(category_id);
                break;
            case 'series_info':
                data = await api.getSeriesInfo(series_id);
                break;
            case 'short_epg':
                data = await api.getShortEpg(stream_id, limit);
                break;
            default:
                return res.status(400).json({ error: 'Unknown action' });
        }

        // Cache the result for cacheable actions
        if (cacheableActions.includes(action)) {
            cache.set('xtream', sourceId, cacheKey, data);
        }

        res.json(data);
    } catch (err) {
        console.error('Xtream proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

// This route is a duplicate of the one at line 256, removing to avoid confusion and enforce consistency.

/**
 * Clear cache for a source
 * DELETE /api/proxy/cache/:sourceId
 */
router.delete('/cache/:sourceId', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clearSource(sourceId);
    res.json({ success: true });
});

/**
 * Clear EPG cache for a source (legacy endpoint, calls clearSource)
 * DELETE /api/proxy/epg/:sourceId/cache
 */
router.delete('/epg/:sourceId/cache', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clear('epg', sourceId, 'data');
    res.json({ success: true });
});

/**
 * Get EPG for specific channels
 * POST /api/proxy/epg/:sourceId/channels
 */
router.post('/epg/:sourceId/channels', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId, req.user?.id, req.user?.role);
        if (!source) {
            return res.status(404).json({ error: 'EPG source not found or unauthorized' });
        }

        const { channelIds } = req.body;
        if (!channelIds || !Array.isArray(channelIds)) {
            return res.status(400).json({ error: 'channelIds array required' });
        }

        const proxyUrl = await getProxyUrl(req.params.sourceId);
        const proxyAgent = proxyUrl ? new SocksProxyAgent(proxyUrl, { tls: { rejectUnauthorized: false } }) : null;
        const data = await epgParser.fetchAndParse(source.url, proxyAgent);

        // Filter programmes for requested channels
        const result = {};
        for (const channelId of channelIds) {
            result[channelId] = epgParser.getCurrentAndUpcoming(data.programmes, channelId);
        }

        res.json(result);
    } catch (err) {
        console.error('EPG channels error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Proxy DRM License Requests for Shaka Player
 * This handles CORS for DRM servers (like Widevine) that require POST requests with binary payloads
 */
router.post('/drm', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
    try {
        let { url, sourceId } = req.query;
        if (!url) return res.status(400).json({ error: 'DRM URL required' });

        // Check if this source requires Warp proxy
        let proxyAgent = null;
        if (sourceId) {
            const source = await sources.getById(sourceId);
            const settingsData = await require('../db').settings.get();
            if (source && source.useWarp && settingsData.warpProxyUrl) {
                console.log(`[Proxy] Using Warp proxy for DRM request for source ${sourceId}`);
                proxyAgent = new SocksProxyAgent(settingsData.warpProxyUrl, {
                    tls: { rejectUnauthorized: false }
                });
            } else if (source) {
                console.log(`[Proxy] Skipping Warp proxy for DRM request for source ${sourceId} (useWarp: ${!!source.useWarp})`);
            }
        }

        console.log(`[Proxy] Forwarding DRM License Request (POST) to: ${url}`);

        // 1. Handle Kodi-style headers in the URL (URL|Header1=Value1&Header2=Value2)
        let finalUrl = url;
        let customHeaders = {};

        const pipeIndex = finalUrl.indexOf('|');
        if (pipeIndex !== -1) {
            const headerStr = finalUrl.substring(pipeIndex + 1);
            finalUrl = finalUrl.substring(0, pipeIndex);

            headerStr.split('&').forEach(h => {
                const [k, v] = h.split('=');
                if (k && v) {
                    customHeaders[k.trim()] = decodeURIComponent(v.trim());
                }
            });
        }

        // 2. Handle base64 encoded JSON headers in query param or URL
        const urlObj = new URL(finalUrl);
        const headersBase64 = req.query.headers || urlObj.searchParams.get('headers');
        if (headersBase64) {
            try {
                const decoded = JSON.parse(Buffer.from(headersBase64, 'base64').toString('utf8'));
                Object.entries(decoded).forEach(([k, v]) => {
                    customHeaders[k] = v;
                });
            } catch (e) {
                console.warn('[Proxy] Failed to parse base64 headers:', e.message);
            }
        }

        const isFancode = finalUrl.includes('fancode.com');

        // Forward standard DRM headers, plus whatever headers Shaka supplied
        const headers = {
            'User-Agent': customHeaders['User-Agent'] || customHeaders['user-agent'] || req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Origin': customHeaders['Origin'] || customHeaders['origin'] || (isFancode ? 'https://fancode.com' : urlObj.origin),
            'Referer': customHeaders['Referer'] || customHeaders['referer'] || (isFancode ? 'https://fancode.com/' : urlObj.origin + '/')
        };

        // Forward ALL custom headers from the player (Authorization, Tokens, etc.)
        // Hop-by-hop and overridden headers are excluded.
        const skipHeaders = ['host', 'connection', 'content-length', 'origin', 'referer', 'user-agent', 'accept-encoding', 'cookie'];
        for (const [key, value] of Object.entries(req.headers)) {
            if (!skipHeaders.includes(key.toLowerCase())) {
                headers[key] = value;
            }
        }

        // Apply all other custom headers from URL/Query
        Object.entries(customHeaders).forEach(([k, v]) => {
            const lowerK = k.toLowerCase();
            if (!skipHeaders.includes(lowerK)) {
                headers[k] = v;
            }
        });

        // Ensure Content-Type is correct for Widevine if not provided by Shaka
        if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/octet-stream';
        }

        const fetchOptions = {
            method: 'POST',
            headers: headers,
            body: req.body, // Raw binary payload from Shaka
            agent: proxyAgent || (url.startsWith('https://') ? globalHttpsAgent : globalHttpAgent)
        };

        const response = await fetch(finalUrl, fetchOptions);

        if (!response.ok) {
            console.error(`[Proxy] DRM upstream error: ${response.status} ${response.statusText}`);
            return res.status(response.status).send(`DRM Error: ${response.statusText}`);
        }

        // Return binary DRM response back to Shaka
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        res.set('Access-Control-Allow-Origin', '*');
        res.set('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
        res.send(buffer);

    } catch (err) {
        console.error('[Proxy] DRM request failed:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Proxy stream for playback
 * This handles CORS for streams that don't allow cross-origin
 * Supports HTTP Range requests for video seeking
 */
router.get('/stream', async (req, res) => {
    const maxRetries = 2;
    let lastError = null;

    const looksLikeHtmlResponse = async (resp) => {
        if (!resp) return true;
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) return true;
        try {
            const preview = (await resp.clone().text()).trimStart().slice(0, 256).toLowerCase();
            return preview.startsWith('<!doctype html') ||
                preview.startsWith('<html') ||
                preview.startsWith('<head') ||
                preview.includes('<title>');
        } catch {
            return false;
        }
    };

    const looksLikeHlsManifest = async (resp) => {
        if (!resp) return false;
        try {
            const preview = (await resp.clone().text()).trimStart().slice(0, 32);
            return preview.startsWith('#EXTM3U');
        } catch {
            return false;
        }
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let { url, sourceId } = req.query;
            if (!url) {
                return res.status(400).json({ error: 'URL required' });
            }

            // Check if this source requires Warp proxy
            let proxyAgent = null;
            if (sourceId) {
                const source = await sources.getById(sourceId);
                const settingsData = await require('../db').settings.get();
                if (source && source.useWarp && settingsData.warpProxyUrl) {
                    console.log(`[Proxy] Using Warp proxy for source ${sourceId}: ${settingsData.warpProxyUrl}`);
                    proxyAgent = new SocksProxyAgent(settingsData.warpProxyUrl, {
                        tls: { rejectUnauthorized: false }
                    });
                } else if (source) {
                    console.log(`[Proxy] Skipping Warp proxy for source ${sourceId} (useWarp: ${!!source.useWarp})`);
                }
            }

            // 1. Handle Kodi-style headers in the URL (URL|Header1=Value1&Header2=Value2)
            let finalUrl = url;
            let customHeaders = {};

            const pipeIndex = finalUrl.indexOf('|');
            if (pipeIndex !== -1) {
                const headerStr = finalUrl.substring(pipeIndex + 1);
                finalUrl = finalUrl.substring(0, pipeIndex);

                headerStr.split('&').forEach(h => {
                    const [k, v] = h.split('=');
                    if (k && v) {
                        customHeaders[k.trim()] = decodeURIComponent(v.trim());
                    }
                });
            }

            // 2. Handle base64 encoded JSON headers in query param or URL
            const urlObj = new URL(finalUrl);
            const headersBase64 = req.query.headers || urlObj.searchParams.get('headers');
            if (headersBase64) {
                try {
                    const decoded = JSON.parse(Buffer.from(headersBase64, 'base64').toString('utf8'));
                    Object.entries(decoded).forEach(([k, v]) => {
                        customHeaders[k] = v;
                    });
                } catch (e) {
                    console.warn('[Proxy] Failed to parse base64 headers:', e.message);
                }
            }

            // Forward some headers to be more "transparent" back to the origin
            // Pluto TV uses multiple domains for content delivery
            const plutoDomains = ['pluto.tv', 'pluto.io', 'plutotv.net', 'siloh.pluto.tv', 'service-stitcher'];
            const isPluto = plutoDomains.some(domain => finalUrl.includes(domain));
            const isFancode = finalUrl.includes('fancode.com');

            // The browser's actual origin (e.g. https://itv.iosonofra.click)
            // CDNs often validate Origin against their CORS allowlist.
            // We must forward the BROWSER's origin, not the CDN's own origin,
            // otherwise the CDN may reject the request with an HTML error page.
            const browserOrigin = req.get('origin') || req.get('referer')?.replace(/\/$/, '') || null;

            const getOrigin = () => {
                if (customHeaders['Origin']) return customHeaders['Origin'];
                if (customHeaders['origin']) return customHeaders['origin'];
                if (isPluto) return 'https://pluto.tv';
                if (isFancode) return 'https://fancode.com';
                return browserOrigin || urlObj.origin;
            };

            const getReferer = () => {
                if (customHeaders['Referer']) return customHeaders['Referer'];
                if (customHeaders['referer']) return customHeaders['referer'];
                if (isPluto) return 'https://pluto.tv/';
                if (isFancode) return 'https://fancode.com/';
                return (browserOrigin || urlObj.origin) + '/';
            };

            // Match /mono.css or /mono.csv (slash-prefixed, not dot-prefixed like ".mono.css")
            // The actual URL path is /proxy/<key>/premium<id>/mono.css
            const isMonoMasquerade = /\/mono\.(css|csv)(\?|#|$)/i.test(finalUrl) || /\.(mono\.css|mono\.csv)(\?|#|$)/i.test(finalUrl);
            const isManifestRequest = /\.(m3u8|mpd)(\?|$)/i.test(finalUrl) || isMonoMasquerade;
            const isLikelyDlstreamsCdn = /(dlstreams\.top|zhdcdn\.zip|hhkys\.com|the-sunmoon\.site)/i.test(finalUrl);
            const isAiSunmoon = /ai\.the-sunmoon\.site/i.test(finalUrl);
            const isImageLikeSegmentRequest = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$|&|"|')/i.test(finalUrl) ||
                /response-content-type=image\/(png|jpe?g|gif|webp|bmp|svg\+xml)/i.test(finalUrl) ||
                /(?:filename|filename\*)[^&\n]*\.(png|jpe?g|gif|webp|bmp|svg)/i.test(finalUrl);

            if (req.query.dlChannelId && isImageLikeSegmentRequest) {
                console.warn(`[Proxy] Blocking image-like segment request for DLStreams channel ${req.query.dlChannelId}: ${finalUrl.substring(0, 140)}...`);
                return res.status(410).json({
                    error: 'Blocked non-media segment in DLStreams manifest',
                    url: finalUrl
                });
            }

            const getRefererForMono = () => {
                if (customHeaders['Referer'] || customHeaders['referer']) {
                    return customHeaders['Referer'] || customHeaders['referer'];
                }
                if (isAiSunmoon && isMonoMasquerade) {
                    // For ai.the-sunmoon.site/proxy/*/premium*/mono.css, use freestyleridesx origin
                    // so the server recognizes it as a legitimate internal request
                    const premiumMatch = finalUrl.match(/premium\d+/i);
                    if (premiumMatch) {
                        return `https://freestyleridesx.lol/premiumtv/daddyhd.php?id=${premiumMatch[0].replace(/\D/g, '')}`;
                    }
                    return 'https://freestyleridesx.lol/premiumtv/daddyhd.php';
                }
                if (isPluto) return 'https://pluto.tv/';
                if (isFancode) return 'https://fancode.com/';
                return (browserOrigin || urlObj.origin) + '/';
            };

            const headers = {
                'User-Agent': customHeaders['User-Agent'] || customHeaders['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': isMonoMasquerade 
                    ? 'application/x-mpegURL, application/vnd.apple.mpegurl, application/vnd.apple.mpegurl;version=3, application/xspf+xml, text/plain, */*'
                    : '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': isAiSunmoon ? 'cross-site' : 'none',
                'Origin': getOrigin(),
                'Referer': getRefererForMono()
            };

            // Apply all other custom headers
            Object.entries(customHeaders).forEach(([k, v]) => {
                const lowerK = k.toLowerCase();
                if (lowerK !== 'user-agent' && lowerK !== 'referer' && lowerK !== 'origin' && lowerK !== 'host') {
                    headers[k] = v;
                }
            });

            // Forward Range header for video seeking support
            const rangeHeader = req.get('range');
            if (rangeHeader) {
                headers['Range'] = rangeHeader;
            }

            const fetchOptions = {
                headers,
                agent: proxyAgent || (finalUrl.startsWith('https://') ? globalHttpsAgent : globalHttpAgent)
            };

            let response = await fetch(finalUrl, fetchOptions);

            // mono.css/mono.csv should return M3U playlist, not HTML.
            // The CDN appears to use lazy playlist generation: the first cold request triggers
            // server-side generation and returns HTML/empty while it builds the playlist.
            // Subsequent requests hit the cache and return the HLS manifest immediately.
            // Strategy: detect non-HLS response, wait for CDN to finish generating, then retry
            // with the same headers (same referer that was used to resolve the URL).
            if (isMonoMasquerade && response.ok) {
                const initialInvalid = await looksLikeHtmlResponse(response) || !(await looksLikeHlsManifest(response));
                if (initialInvalid) {
                    console.log(`[Proxy] mono.css returned non-HLS content (CDN cold-start). Waiting 1.5s for CDN to generate playlist...`);

                    // Wait for CDN lazy generation to complete before retrying.
                    await new Promise(r => setTimeout(r, 1500));

                    // Attempt 1: Retry with the same headers (same referer used to resolve the URL).
                    // The CDN should now have the playlist cached.
                    const retryResp1 = await fetch(finalUrl, fetchOptions).catch(() => null);
                    if (retryResp1 && retryResp1.ok && !(await looksLikeHtmlResponse(retryResp1)) && (await looksLikeHlsManifest(retryResp1))) {
                        console.log(`[Proxy] mono.css retry after delay succeeded`);
                        response = retryResp1;
                    } else {
                        // Attempt 2: Retry with origin referer (ai.the-sunmoon.site itself)
                        const altHeaders1 = {
                            ...headers,
                            'Referer': `https://ai.the-sunmoon.site/`,
                            'Origin': 'https://ai.the-sunmoon.site'
                        };
                        const altResp1 = await fetch(finalUrl, {
                            ...fetchOptions,
                            headers: altHeaders1
                        }).catch(() => null);

                        if (altResp1 && altResp1.ok && !(await looksLikeHtmlResponse(altResp1)) && (await looksLikeHlsManifest(altResp1))) {
                            console.log(`[Proxy] mono.css retry with origin referer succeeded`);
                            response = altResp1;
                        } else {
                            // Attempt 3: Retry without explicit Referer/Origin
                            const altHeaders2 = { ...headers };
                            delete altHeaders2.Referer;
                            delete altHeaders2.Origin;
                            const altResp2 = await fetch(finalUrl, {
                                ...fetchOptions,
                                headers: altHeaders2
                            }).catch(() => null);

                            if (altResp2 && altResp2.ok && !(await looksLikeHtmlResponse(altResp2)) && (await looksLikeHlsManifest(altResp2))) {
                                console.log(`[Proxy] mono.css retry without explicit headers succeeded`);
                                response = altResp2;
                            }
                            // If all retries fail, fall through to server-side re-resolve below
                        }
                    }
                }
            }

            // Some DLStreams CDNs return 403/404 unless Origin/Referer match dlstreams.top.
            // Retry once with forced DLStreams headers only for manifest requests.
            if (!response.ok && (response.status === 403 || response.status === 404) && isManifestRequest && isLikelyDlstreamsCdn) {
                const fallbackHeaders = {
                    ...headers,
                    'Origin': 'https://dlstreams.top',
                    'Referer': 'https://dlstreams.top/'
                };
                const fallbackOptions = {
                    ...fetchOptions,
                    headers: fallbackHeaders
                };
                console.log(`[Proxy] Retry manifest with DLStreams headers for ${finalUrl.substring(0, 120)}...`);
                response = await fetch(finalUrl, fallbackOptions);
            }

            // Some origins reject explicit Origin/Referer headers from proxies.
            // Final fallback: retry without Origin and Referer for manifest fetches.
            if (!response.ok && (response.status === 403 || response.status === 404) && isManifestRequest) {
                const noCorsHeaders = { ...headers };
                delete noCorsHeaders.Origin;
                delete noCorsHeaders.Referer;
                const fallbackNoCorsOptions = {
                    ...fetchOptions,
                    headers: noCorsHeaders
                };
                console.log(`[Proxy] Retry manifest without Origin/Referer for ${finalUrl.substring(0, 120)}...`);
                response = await fetch(finalUrl, fallbackNoCorsOptions);
            }

            // Retry on 5xx errors (transient upstream issues)
            if (response.status >= 500 && attempt < maxRetries) {
                console.log(`[Proxy] Upstream 5xx error (attempt ${attempt}/${maxRetries}), retrying in 500ms...`);
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            if (!response.ok) {
                console.error(`Upstream error for ${url.substring(0, 80)}...: ${response.status} ${response.statusText}`);
                if (response.status === 403) {
                    const errorBody = await response.text().catch(() => 'N/A');
                    console.error(`403 Response body: ${errorBody.substring(0, 200)}`);
                }
                return res.status(response.status).send(`Failed to fetch stream: ${response.statusText}`);
            }

            // Never forward HTML as a valid manifest. HLS.js should receive a hard error so
            // the client-side retry logic can re-resolve instead of attempting decoder init.
            if (isManifestRequest && await looksLikeHtmlResponse(response)) {
                // One-shot server-side recovery for DLStreams mono.css manifests.
                // If cached mono URL is stale, force-refresh the channel URL and retry fetch.
                if (isMonoMasquerade && req.query._dlAutoRefresh !== '1') {
                    const dlChannelIdRaw = req.query.dlChannelId;
                    const dlChannelId = dlChannelIdRaw && /^\d+$/.test(String(dlChannelIdRaw))
                        ? String(dlChannelIdRaw)
                        : null;

                    if (dlChannelId) {
                        try {
                            console.warn(`[Proxy] mono.css HTML response; attempting server-side DLStreams re-resolve for channel ${dlChannelId}`);
                            const resolveTimeoutMs = 7000;
                            const fresh = await Promise.race([
                                dlstreamsService.resolveStreamUrl(dlChannelId, {
                                    forceRefresh: true,
                                    validateCache: true
                                }),
                                new Promise((_, reject) => {
                                    setTimeout(() => reject(new Error(`DLStreams resolve timeout after ${resolveTimeoutMs}ms`)), resolveTimeoutMs);
                                })
                            ]);

                            const freshUrlRaw = fresh && fresh.streamUrl ? String(fresh.streamUrl) : '';
                            const freshUrl = freshUrlRaw ? freshUrlRaw.split('#')[0] : '';

                            if (freshUrl) {
                                const retryHeaders = { ...headers };
                                if (fresh.proxyHeaders && typeof fresh.proxyHeaders === 'object') {
                                    Object.entries(fresh.proxyHeaders).forEach(([k, v]) => {
                                        if (!k || v == null) return;
                                        const lk = String(k).toLowerCase();
                                        if (lk === 'host') return;
                                        retryHeaders[k] = String(v);
                                    });
                                }

                                const refreshedResponse = await fetch(freshUrl, {
                                    ...fetchOptions,
                                    headers: retryHeaders,
                                    agent: freshUrl.startsWith('https://') ? globalHttpsAgent : globalHttpAgent
                                }).catch(() => null);

                                if (refreshedResponse && refreshedResponse.ok && !(await looksLikeHtmlResponse(refreshedResponse))) {
                                    console.log(`[Proxy] Server-side DLStreams re-resolve succeeded for channel ${dlChannelId}`);
                                    response = refreshedResponse;
                                    finalUrl = freshUrl;
                                }
                            }
                        } catch (refreshErr) {
                            console.warn(`[Proxy] Server-side DLStreams re-resolve failed: ${refreshErr.message}`);
                        }
                    } else {
                        console.warn('[Proxy] mono.css HTML response but missing/invalid dlChannelId, skipping server-side DLStreams re-resolve');
                    }
                }

                if (await looksLikeHtmlResponse(response)) {
                const bodySnippet = await response.text().catch(() => 'N/A');
                console.error(`[Proxy] Invalid manifest response (HTML) for ${finalUrl.substring(0, 120)}...`);
                return res.status(502).json({
                    error: 'Upstream returned HTML instead of media manifest',
                    url: finalUrl,
                    details: bodySnippet.substring(0, 180)
                });
                }
            }

            const contentType = response.headers.get('content-type') || '';
            res.set('Access-Control-Allow-Origin', '*');

            if (isManifestRequest) {
                // Avoid replaying poisoned manifests from browser/proxy caches.
                res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
                res.set('Pragma', 'no-cache');
                res.set('Expires', '0');
            }

            // Forward range-related headers for video seeking support
            const contentLength = response.headers.get('content-length');
            const contentRange = response.headers.get('content-range');
            const acceptRanges = response.headers.get('accept-ranges');

            if (contentLength) {
                res.set('Content-Length', contentLength);
            }
            if (contentRange) {
                res.set('Content-Range', contentRange);
            }
            if (acceptRanges) {
                res.set('Accept-Ranges', acceptRanges);
            } else if (contentLength && !contentRange) {
                // If server supports content-length but didn't explicitly state accept-ranges,
                // we can safely assume it supports byte ranges
                res.set('Accept-Ranges', 'bytes');
            }

            // Set status code (206 for partial content when range request was made)
            res.status(response.status);

            // Create an async iterator for the response body
            const iterator = response.body[Symbol.asyncIterator]();
            const first = await iterator.next();

            if (first.done) {
                res.set('Content-Type', contentType || 'application/octet-stream');
                return res.end();
            }

            const firstChunk = Buffer.from(first.value);

            // Peek at first bytes to check for HLS manifest ({ #EXTM3U })
            const firstChunkText = firstChunk.toString('utf8');
            const contentLooksLikeHls =
                firstChunkText.trimStart().startsWith('#EXTM3U') ||
                (isManifestRequest && /mpegurl|vnd\.apple\.mpegurl|x-mpegurl/i.test(contentType));

            if (contentLooksLikeHls) {
                // HLS Manifest: We must read the WHOLE manifest to rewrite it
                const chunks = [firstChunk];

                // Consume the rest of the stream
                let result = await iterator.next();
                while (!result.done) {
                    chunks.push(Buffer.from(result.value));
                    result = await iterator.next();
                }

                const buffer = Buffer.concat(chunks);
                const finalUrl = response.url || url;
                console.log(`[Proxy] Processing HLS manifest from: ${finalUrl.substring(0, 80)}...`);
                let manifest = buffer.toString('utf-8');

                // Sanity-check HLS manifests. Some anti-bot endpoints return syntactically
                // valid playlists that point mostly/all segments to image assets (.png/.jpg),
                // which later crash the media pipeline.
                const manifestLines = manifest.split('\n').map(l => l.trim()).filter(Boolean);
                const uriLines = manifestLines.filter(l => !l.startsWith('#'));
                const decodeLoose = (value) => {
                    if (!value) return '';
                    try {
                        return decodeURIComponent(value);
                    } catch {
                        return String(value);
                    }
                };
                const uriMeta = uriLines.map((line) => {
                    const raw = String(line);
                    const decoded = decodeLoose(raw);
                    return { raw, decoded };
                });
                const hasExtinf = manifestLines.some(l => l.startsWith('#EXTINF'));
                const childManifestCount = uriMeta.filter(({ raw, decoded }) => /\.(m3u8|m3u|mpd)(\?|$|&)/i.test(raw) || /\.(m3u8|m3u|mpd)(\?|$|&)/i.test(decoded)).length;
                const knownPoisonSegments = uriMeta.filter(({ raw, decoded }) => {
                    const s = `${raw} ${decoded}`;
                    return /seg_[a-z0-9_\-]+\.(png|jpe?g|gif|webp|bmp|svg)(\?|$|&|\"|')/i.test(s);
                }).length;
                const imageUriCount = uriMeta.filter(({ raw, decoded }) => {
                    const s = `${raw} ${decoded}`;
                    return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$|&|\"|')/i.test(s) ||
                        /response-content-type=image\/(png|jpe?g|gif|webp|bmp|svg\+xml)/i.test(s) ||
                        /(?:filename|filename\*)[^&\n]*\.(png|jpe?g|gif|webp|bmp|svg)/i.test(s);
                }).length;
                const mediaUriCount = uriMeta.filter(({ raw, decoded }) => {
                    const s = `${raw} ${decoded}`;
                    return /\.(ts|m2ts|m4s|m4v|m4a|cmfa|cmfv|mp4|aac|ac3|ec3|mp3|webm)(\?|$|&)/i.test(s) ||
                        /response-content-type=(video|audio)\//i.test(s);
                }).length;
                const suspiciousImagePlaylist = hasExtinf && (
                    (imageUriCount > 0 && mediaUriCount === 0) ||
                    (imageUriCount >= 2 && imageUriCount > mediaUriCount)
                );
                const suspiciousNoExtinfImagePlaylist = !hasExtinf && imageUriCount > 0 && mediaUriCount === 0 && childManifestCount === 0;
                const aggressiveMonoImageBlock = isMonoMasquerade && (
                    (imageUriCount > 0 && mediaUriCount === 0) ||
                    (knownPoisonSegments >= 2 && mediaUriCount <= 1) ||
                    (imageUriCount >= 3 && imageUriCount > mediaUriCount)
                );

                if (isMonoMasquerade && imageUriCount > 0 && mediaUriCount > 0) {
                    const rawLines = manifest.split('\n');
                    const isImageLikeUri = (value) => {
                        const s = `${value} ${decodeLoose(value)}`;
                        return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$|&|"|')/i.test(s) ||
                            /response-content-type=image\/(png|jpe?g|gif|webp|bmp|svg\+xml)/i.test(s) ||
                            /(?:filename|filename\*)[^&\n]*\.(png|jpe?g|gif|webp|bmp|svg)/i.test(s);
                    };
                    const isMediaLikeUri = (value) => {
                        const s = `${value} ${decodeLoose(value)}`;
                        return /\.(ts|m2ts|m4s|m4v|m4a|cmfa|cmfv|mp4|aac|ac3|ec3|mp3|webm)(\?|$|&)/i.test(s) ||
                            /response-content-type=(video|audio)\//i.test(s);
                    };

                    const sanitizedLines = [];
                    let pendingSegmentMeta = [];
                    let removedSegments = 0;

                    for (const line of rawLines) {
                        const trimmed = line.trim();

                        if (!trimmed) {
                            continue;
                        }

                        if (trimmed.startsWith('#EXTINF') || trimmed.startsWith('#EXT-X-PROGRAM-DATE-TIME') || trimmed.startsWith('#EXT-X-BYTERANGE')) {
                            pendingSegmentMeta.push(line);
                            continue;
                        }

                        if (!trimmed.startsWith('#')) {
                            if (isImageLikeUri(trimmed)) {
                                removedSegments++;
                                pendingSegmentMeta = [];
                                continue;
                            }

                            if (pendingSegmentMeta.length > 0) {
                                sanitizedLines.push(...pendingSegmentMeta);
                                pendingSegmentMeta = [];
                            }

                            if (isMediaLikeUri(trimmed) || /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
                                sanitizedLines.push(line);
                            }
                            continue;
                        }

                        sanitizedLines.push(line);
                    }

                    if (removedSegments > 0) {
                        manifest = sanitizedLines.join('\n');
                        console.log(`[Proxy] Sanitized mixed mono manifest by removing ${removedSegments} image segment block(s) for ${finalUrl.substring(0, 120)}...`);
                    }
                }

                const sanitizedManifestLines = manifest.split('\n').map(l => l.trim()).filter(Boolean);
                const sanitizedUriLines = sanitizedManifestLines.filter(l => !l.startsWith('#'));
                const sanitizedImageUriCount = sanitizedUriLines.filter(line => {
                    const s = `${line} ${decodeLoose(line)}`;
                    return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$|&|"|')/i.test(s) ||
                        /response-content-type=image\/(png|jpe?g|gif|webp|bmp|svg\+xml)/i.test(s) ||
                        /(?:filename|filename\*)[^&\n]*\.(png|jpe?g|gif|webp|bmp|svg)/i.test(s);
                }).length;
                const sanitizedMediaUriCount = sanitizedUriLines.filter(line => {
                    const s = `${line} ${decodeLoose(line)}`;
                    return /\.(ts|m2ts|m4s|m4v|m4a|cmfa|cmfv|mp4|aac|ac3|ec3|mp3|webm)(\?|$|&)/i.test(s) ||
                        /response-content-type=(video|audio)\//i.test(s);
                }).length;
                const finalSuspiciousImagePlaylist = suspiciousImagePlaylist && sanitizedMediaUriCount === 0;
                const finalSuspiciousNoExtinfImagePlaylist = suspiciousNoExtinfImagePlaylist && sanitizedMediaUriCount === 0;
                const finalAggressiveMonoImageBlock = aggressiveMonoImageBlock && sanitizedMediaUriCount === 0;

                if (finalSuspiciousImagePlaylist || finalSuspiciousNoExtinfImagePlaylist || finalAggressiveMonoImageBlock || (isMonoMasquerade && sanitizedImageUriCount > 0 && sanitizedMediaUriCount === 0)) {
                    console.error(`[Proxy] Rejected suspicious HLS manifest (image segments) for ${finalUrl.substring(0, 120)}...`);
                    return res.status(502).json({
                        error: 'Upstream returned invalid HLS playlist',
                        reason: 'playlist contains image segments instead of media segments',
                        url: finalUrl
                    });
                }

                res.set('Content-Type', 'application/vnd.apple.mpegurl');

                const finalUrlObj = new URL(finalUrl);
                const baseUrl = finalUrlObj.origin + finalUrlObj.pathname.substring(0, finalUrlObj.pathname.lastIndexOf('/') + 1);
                const queryStr = finalUrlObj.search;
                const passthroughParams = new URLSearchParams();
                for (const [k, v] of Object.entries(req.query || {})) {
                    if (k === 'url' || v == null || v === '') continue;
                    passthroughParams.set(k, String(v));
                }
                const passthroughSuffix = passthroughParams.toString();
                const proxySuffix = passthroughSuffix ? `&${passthroughSuffix}` : '';

                manifest = manifest.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (trimmed === '' || trimmed.startsWith('#')) {
                        // Handle both URI="..." and URI='...' formats
                        if (trimmed.includes('URI=')) {
                            // Replace both double and single quoted URIs
                            return line.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
                                try {
                                    let absoluteUrl = new URL(p1, baseUrl).href;
                                    // Append query string if relative and not already present
                                    if (!p1.includes('?') && queryStr) {
                                        absoluteUrl += queryStr;
                                    }
                                    return `URI="${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}${proxySuffix}"`;
                                } catch (e) {
                                    return match;
                                }
                            });
                        }
                        return line;
                    }

                    // Stream URL handling
                    try {
                        let absoluteUrl;
                        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                            absoluteUrl = trimmed;
                        } else {
                            absoluteUrl = new URL(trimmed, baseUrl).href;
                            // Append query string if relative and not already present
                            if (!trimmed.includes('?') && queryStr) {
                                absoluteUrl += queryStr;
                            }
                        }
                        return `${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}${proxySuffix}`;
                    } catch (e) { return line; }
                }).join('\n');

                return res.send(manifest);
            }

            // DASH Manifest (MPD): Rewrite segment URLs to go through proxy
            // This ensures all DASH segments are fetched via the backend (and through Warp if configured).
            // Also handles ClearKey ContentProtection rewriting when ?ck= param is present.
            const urlForMpd = response.url || url;
            const contentLooksLikeMpd =
                contentType.includes('dash+xml') ||
                contentType.includes('application/xml') ||
                urlForMpd.includes('.mpd');

            if (contentLooksLikeMpd) {
                // Read the full manifest
                const mpdChunks = [firstChunk];
                let mpdNext = await iterator.next();
                while (!mpdNext.done) { mpdChunks.push(Buffer.from(mpdNext.value)); mpdNext = await iterator.next(); }
                let mpd = Buffer.concat(mpdChunks).toString('utf-8');

                // Verify it's actually XML/MPD (not a video segment served with wrong content-type)
                const mpdTrimmed = mpd.trimStart();
                if (!mpdTrimmed.startsWith('<?xml') && !mpdTrimmed.startsWith('<MPD')) {
                    // Not an MPD manifest, serve as binary
                    console.log(`[Proxy] Content looks like MPD by URL/headers but isn't XML, serving as binary`);
                    res.set('Content-Type', contentType || 'application/octet-stream');
                    res.send(Buffer.concat(mpdChunks));
                    return;
                }

                const proxyBase = `${req.protocol}://${req.get('host')}${req.baseUrl}/stream`;
                const sourceIdParam = sourceId ? `&sourceId=${sourceId}` : '';

                console.log(`[Proxy] Processing DASH manifest (MPD) from: ${urlForMpd.substring(0, 100)}...`);

                const extraParams = (() => {
                    try {
                        const urlObj = new URL(urlForMpd);
                        let params = '';
                        urlObj.searchParams.forEach((val, key) => {
                            if (key !== 'url' && key !== 'sourceId') {
                                params += `&${key}=${encodeURIComponent(val)}`;
                            }
                        });
                        return params;
                    } catch { return ''; }
                })();

                // Helper: Convert an absolute URL to a proxied URL
                const proxyUrl = (segUrl) => {
                    if (!segUrl || segUrl.startsWith('data:')) return segUrl;
                    let absoluteUrl;
                    try {
                        if (segUrl.startsWith('http://') || segUrl.startsWith('https://')) {
                            absoluteUrl = segUrl;
                        } else {
                            return segUrl; // Keep relative URLs as-is (client-side request filter handles them)
                        }
                    } catch (e) {
                        return segUrl; // Can't parse, return as-is
                    }
                    return `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}${sourceIdParam}${extraParams}`;
                };

                // NOTE: We do NOT rewrite <BaseURL> elements or inject proxy BaseURLs.
                // Proxy-style query-parameter URLs (/api/proxy/stream?url=...) break
                // standard URL resolution for relative segment paths. Instead, we rely on
                // the client-side ShakaPlayer request filter to intercept resolved absolute
                // URLs and proxy them through the backend.

                // 1. Rewrite SegmentTemplate initialization and media attributes (absolute URLs only)
                // Template attributes with $variables$ (like $Number$, $Time$, $Bandwidth$) are kept
                // for relative templates. For absolute URLs in templates, we rewrite them.
                mpd = mpd.replace(/<SegmentTemplate([^>]*)>/gi, (match, attrs) => {
                    let newAttrs = attrs;

                    // Rewrite initialization= attribute if it's an absolute URL
                    newAttrs = newAttrs.replace(/initialization="([^"]+)"/gi, (m, val) => {
                        if (val.startsWith('http://') || val.startsWith('https://')) {
                            return `initialization="${proxyUrl(val)}"`;
                        }
                        return m; // Keep relative templates as-is (resolved via BaseURL)
                    });

                    // Rewrite media= attribute if it's an absolute URL
                    newAttrs = newAttrs.replace(/media="([^"]+)"/gi, (m, val) => {
                        if (val.startsWith('http://') || val.startsWith('https://')) {
                            return `media="${proxyUrl(val)}"`;
                        }
                        return m; // Keep relative templates as-is
                    });

                    return `<SegmentTemplate${newAttrs}>`;
                });

                // 2. Rewrite <Initialization sourceURL="..."> elements
                mpd = mpd.replace(/<Initialization([^>]*?)sourceURL="([^"]+)"([^>]*?)\/?>/gi, (match, pre, val, post) => {
                    if (val.startsWith('http://') || val.startsWith('https://')) {
                        return `<Initialization${pre}sourceURL="${proxyUrl(val)}"${post}/>`;
                    }
                    return match;
                });

                // 3. Rewrite <SegmentURL media="..."> elements  
                mpd = mpd.replace(/<SegmentURL([^>]*?)media="([^"]+)"([^>]*?)\/?>/gi, (match, pre, val, post) => {
                    if (val.startsWith('http://') || val.startsWith('https://')) {
                        return `<SegmentURL${pre}media="${proxyUrl(val)}"${post}/>`;
                    }
                    return match;
                });

                // === ClearKey ContentProtection Rewriting ===
                // When the URL has ?ck=base64(KID:KEY), this is a ClearKey stream whose
                // manifest declares only Widevine + PlayReady. We rewrite to use ClearKey.
                const ckParam = (() => {
                    try { return new URL(urlForMpd).searchParams.get('ck'); } catch { return null; }
                })();

                if (ckParam) {
                    console.log(`[Proxy] Rewriting MPD ContentProtection for ClearKey (ck param detected)`);

                    // Decode the ck param to get KID:KEY (base64 encoded)
                    let kidForClearKey = '';
                    try {
                        const decoded = Buffer.from(ckParam, 'base64').toString('utf-8');
                        kidForClearKey = decoded.split(':')[0].trim();
                    } catch (e) {
                        console.warn('[Proxy] Could not decode ck param:', e.message);
                    }

                    // Convert KID hex (no dashes) to UUID format for cenc:default_KID
                    const kidUuid = kidForClearKey.length === 32
                        ? `${kidForClearKey.slice(0,8)}-${kidForClearKey.slice(8,12)}-${kidForClearKey.slice(12,16)}-${kidForClearKey.slice(16,20)}-${kidForClearKey.slice(20)}`
                        : '';

                    // Strip ALL existing ContentProtection elements
                    mpd = mpd
                        .replace(/<ContentProtection[^>]*\/>/gi, '')
                        .replace(/<ContentProtection[\s\S]*?<\/ContentProtection>/gi, '');

                    // Inject ClearKey ContentProtection into every AdaptationSet
                    const clearKeyBlock = kidUuid
                        ? `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="${kidUuid}"></ContentProtection>` +
                          `<ContentProtection schemeIdUri="urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b"></ContentProtection>`
                        : `<ContentProtection schemeIdUri="urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b"></ContentProtection>`;

                    mpd = mpd.replace(/(<AdaptationSet[^>]*>)/g, `$1${clearKeyBlock}`);
                }

                res.set('Content-Type', 'application/dash+xml');
                return res.send(mpd);
            }

            // Binary content (Video Segment or Key): Collect and send
            console.log(`[Proxy] Serving binary content (${contentType}) at status ${response.status}`);
            res.status(response.status);
            res.set('Content-Type', contentType || 'application/octet-stream');

            // Send the first chunk we read
            res.write(firstChunk);

            // Pipe the rest of the stream
            if (response.body) {
                const stream = Readable.from(iterator);
                stream.pipe(res);

                // Return a promise that resolves when the stream finishes piping
                await new Promise((resolve, reject) => {
                    stream.on('end', resolve);
                    stream.on('error', reject);
                    res.on('close', () => {
                        stream.destroy();
                        resolve();
                    });
                });
            } else {
                res.end();
            }
            return; // Success - exit the retry loop

        } catch (err) {
            lastError = err;
            console.error(`Stream proxy error (attempt ${attempt}/${maxRetries}):`, err?.message || err, err?.cause ? err.cause : '');
            if (attempt < maxRetries) {
                console.log('[Proxy] Retrying after error...');
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
        }
    }

    // All retries failed
    if (!res.headersSent) {
        res.status(500).json({ error: lastError?.message || 'Stream proxy failed after retries' });
    }
});

/**
 * Proxy images (channel logos, posters)
 * Fixes mixed content errors when loading HTTP images on HTTPS pages
 * GET /api/proxy/image?url=...
 */
router.get('/image', async (req, res) => {
    try {
        let { url, sourceId } = req.query;
        if (!url) return res.status(400).send('URL required');

        // Check if this source requires Warp proxy
        let proxyAgent = null;
        if (sourceId) {
            const source = await sources.getById(sourceId);
            const settingsData = await require('../db').settings.get();
            if (source && source.useWarp && settingsData.warpProxyUrl) {
                console.log(`[Proxy] Using Warp proxy for image request for source ${sourceId}`);
                // Version 8.x of socks-proxy-agent uses TLS options in constructor
                proxyAgent = new SocksProxyAgent(settingsData.warpProxyUrl, {
                    tls: { rejectUnauthorized: false }
                });
            } else if (source) {
                console.log(`[Proxy] Skipping Warp proxy for image request for source ${sourceId} (useWarp: ${!!source.useWarp})`);
            }
        }

        const origin = req.get('Origin') || new URL(url).origin;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Origin': origin,
            'Referer': origin + '/'
        };

        const fetchOptions = {
            headers,
            agent: proxyAgent || (url.startsWith('https://') ? globalHttpsAgent : globalHttpAgent)
        };

        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
            return res.status(response.status).send('Failed to fetch image');
        }

        const contentType = response.headers.get('content-type') || 'image/png';
        res.set('Content-Type', contentType);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours

        // Efficiently pipe the response body
        if (response.body) {
            // response.body is an AsyncIterable in standard fetch/undici
            // Readable.from converts it to a Node.js Readable stream
            const stream = Readable.from(response.body);
            stream.pipe(res);
        } else {
            res.end();
        }

    } catch (err) {
        console.error('Image proxy error:', err.message);
        res.status(500).send('Image proxy error');
    }
});

module.exports = router;
