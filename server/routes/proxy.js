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

            const getOrigin = () => {
                if (customHeaders['Origin']) return customHeaders['Origin'];
                if (customHeaders['origin']) return customHeaders['origin'];
                if (isPluto) return 'https://pluto.tv';
                if (isFancode) return 'https://fancode.com';
                return urlObj.origin;
            };

            const getReferer = () => {
                if (customHeaders['Referer']) return customHeaders['Referer'];
                if (customHeaders['referer']) return customHeaders['referer'];
                if (isPluto) return 'https://pluto.tv/';
                if (isFancode) return 'https://fancode.com/';
                return urlObj.origin + '/';
            };

            const headers = {
                'User-Agent': customHeaders['User-Agent'] || customHeaders['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': getOrigin(),
                'Referer': getReferer()
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

            const response = await fetch(finalUrl, fetchOptions);

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

            const contentType = response.headers.get('content-type') || '';
            res.set('Access-Control-Allow-Origin', '*');

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
            const textPrefix = firstChunk.subarray(0, 7).toString('utf8');
            const contentLooksLikeHls = textPrefix === '#EXTM3U';

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
                res.set('Content-Type', 'application/vnd.apple.mpegurl');

                let manifest = buffer.toString('utf-8');

                const finalUrlObj = new URL(finalUrl);
                const baseUrl = finalUrlObj.origin + finalUrlObj.pathname.substring(0, finalUrlObj.pathname.lastIndexOf('/') + 1);
                const queryStr = finalUrlObj.search;

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
                                    return `URI="${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}${sourceId ? '&sourceId=' + sourceId : ''}"`;
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
                        return `${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}${sourceId ? '&sourceId=' + sourceId : ''}`;
                    } catch (e) { return line; }
                }).join('\n');

                return res.send(manifest);
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
