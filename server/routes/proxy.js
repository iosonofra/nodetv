const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { getDb } = require('../db/sqlite'); // Import SQLite
const xtreamApi = require('../services/xtreamApi');
const m3uParser = require('../services/m3uParser');
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
const warpManager = require('../services/WarpManager');

// Protect all routes except /stream and /image
router.use((req, res, next) => {
    if (req.path === '/stream' || req.path === '/image') {
        return next();
    }
    return requireAuth(req, res, next);
});

// Middleware to enforce source ownership
router.param('sourceId', async (req, res, next, sourceId) => {
    if (req.user && req.user.role === 'admin') return next();

    if (req.user) {
        const source = await sources.getById(sourceId);
        if (source && (source.user_id === req.user.id || source.user_id === 0)) {
            return next();
        }
    }
    return res.status(403).json({ error: 'Access denied to this source' });
});

// Helper to get formatted category list from DB
function getCategoriesFromDb(sourceId, type, includeHidden = false) {
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
function getStreamsFromDb(sourceId, type, categoryId = null, includeHidden = false) {
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
            category_id: item.category_id
        };
    });
}


// --- Xtream Codes Proxy API --- //

// Login / Authenticate
router.get('/xtream/:sourceId', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') return res.status(404).send('Source not found');

        // Proxy auth check to upstream to ensure credentials are still valid


        const cached = cache.get('xtream', source.id, 'auth', 300 * 1000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source);
        const data = await api.authenticate();
        cache.set('xtream', source.id, 'auth', data); // 5 min cache
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
        const cats = getCategoriesFromDb(sourceId, 'live', includeHidden);
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
        const streams = getStreamsFromDb(sourceId, 'live', categoryId, includeHidden);
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
        const cats = getCategoriesFromDb(sourceId, 'movie', includeHidden);
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
        const streams = getStreamsFromDb(sourceId, 'movie', categoryId, includeHidden);
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
        const cats = getCategoriesFromDb(sourceId, 'series', includeHidden);
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
        const streams = getStreamsFromDb(sourceId, 'series', categoryId, includeHidden);
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
        const source = await sources.getById(req.params.sourceId);
        if (!source) return res.status(404).send('Source not found');

        const seriesId = req.query.series_id;
        if (!seriesId) return res.status(400).send('series_id required');

        const cacheKey = `series_info_${seriesId}`;
        const cached = cache.get('xtream', source.id, cacheKey, 3600 * 1000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source);
        const data = await api.getSeriesInfo(seriesId);
        cache.set('xtream', source.id, cacheKey, data); // 1 hour
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// VOD Info
router.get('/xtream/:sourceId/vod_info', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source) return res.status(404).send('Source not found');

        const vodId = req.query.vod_id;
        if (!vodId) return res.status(400).send('vod_id required');

        const cacheKey = `vod_info_${vodId}`;
        const cached = cache.get('xtream', source.id, cacheKey, 3600 * 1000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source);
        const data = await api.getVodInfo(vodId);
        cache.set('xtream', source.id, cacheKey, data); // 1 hour
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// Get Stream URL for playback
// Returns the direct stream URL for a given stream ID
router.get('/xtream/:sourceId/stream/:streamId/:type', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
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

// Short EPG for Xtream
router.get('/xtream/:sourceId/short_epg', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') return res.status(404).json({ error: 'Source not found' });

        const streamId = req.query.stream_id;
        if (!streamId) return res.status(400).json({ error: 'stream_id required' });

        const limit = parseInt(req.query.limit) || 10;
        const cacheKey = `short_epg_${streamId}_${limit}`;
        const cached = cache.get('xtream', source.id, cacheKey, 300 * 1000);
        if (cached) return res.json(cached);

        const api = xtreamApi.createFromSource(source);
        const data = await api.getShortEpg(streamId, limit);
        cache.set('xtream', source.id, cacheKey, data); // 5 min cache
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
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
        const channels = getStreamsFromDb(sourceId, 'live', null, includeHidden);
        const groups = getCategoriesFromDb(sourceId, 'live', includeHidden);

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
        const db = getDb();

        // Time window: 24 hours ago to 24 hours from now
        // This prevents returning millions of rows and crashing the server/browser
        const windowStart = Date.now() - (24 * 60 * 60 * 1000); // -24 hours
        const windowEnd = Date.now() + (24 * 60 * 60 * 1000);   // +24 hours

        // Fetch programs within the time window
        let programsQuery = `
            SELECT channel_id as channelId, source_id as sourceId, start_time, end_time, title, description, data 
            FROM epg_programs 
            WHERE source_id = ? AND end_time > ? AND start_time < ?
        `;
        const params = [sourceId, windowStart, windowEnd];

        const programs = db.prepare(programsQuery).all(...params);

        const formattedPrograms = programs.map(p => ({
            channelId: p.channelId,
            sourceId: p.sourceId,
            start: new Date(p.start_time).toISOString(), // EpgGuide parse this back
            stop: new Date(p.end_time).toISOString(),
            title: p.title,
            desc: p.description
        }));

        // Fetch EPG channels from playlist_items
        let epgChannels = db.prepare(`
            SELECT item_id as id, name, stream_icon as icon, data 
            FROM playlist_items 
            WHERE source_id = ? AND type = 'epg_channel'
        `).all(sourceId);

        if (epgChannels.length === 0) {
            // Fallback: Build from unique channelIds in programmes
            const uniqueChannelIds = [...new Set(programs.map(p => p.channelId))];
            epgChannels = uniqueChannelIds.map(id => ({
                id,
                name: id
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


// --- Stream Proxy (Unchanged mostly) --- //

// Helper: fetch URL with optional WARP agent, returns { statusCode, headers, body }
// Follows redirects (up to 5 hops)
function proxyFetch(targetUrl, agent = null, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const lib = targetUrl.startsWith('https') ? https : http;
        const opts = {};
        if (agent) {
            opts.agent = agent;
            opts.rejectUnauthorized = false;
        }

        const req = lib.get(targetUrl, opts, (res) => {
            // Follow redirects
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && maxRedirects > 0) {
                let redirectUrl = res.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const urlObj = new URL(targetUrl);
                    redirectUrl = urlObj.origin + redirectUrl;
                }
                res.resume(); // Consume response to free up memory
                return proxyFetch(redirectUrl, agent, maxRedirects - 1).then(resolve, reject);
            }

            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 400,
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf-8')
                });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

// Helper: create a WARP SOCKS agent if source has use_warp enabled
async function getWarpAgent(sourceId) {
    if (!sourceId) return null;
    const source = await sources.getById(sourceId);
    if (!source || !source.use_warp) return null;
    const warpStatus = warpManager.getStatus();
    if (warpStatus.status !== 'connected') return null;

    console.log(`[Proxy] Routing through WARP for source ${sourceId}`);
    return new SocksProxyAgent(`socks5h://127.0.0.1:${warpStatus.port}`, {
        rejectUnauthorized: false
    });
}

// Rewrite M3U8 for proxying
async function rewriteM3u8(m3u8Url, baseUrl, sourceId = null) {
    try {
        const agent = await getWarpAgent(sourceId);
        const response = await proxyFetch(m3u8Url, agent);
        if (!response.ok) throw new Error(`Fetch failed: ${response.statusCode}`);
        let content = response.body;

        content = content.replace(/^(?!#)(.+)$/gm, (match) => {
            let chunkUrl = match.trim();
            if (!chunkUrl) return match;

            try {
                // Use native URL parser to correctly handle absolute paths (e.g., /hls/...) 
                // and relative paths (e.g., chunk1.ts) without creating double slashes //
                chunkUrl = new URL(chunkUrl, m3u8Url).href;
            } catch (e) {
                // If the URL is completely unparseable, skip rewriting it
                return match;
            }

            return `${baseUrl}?url=${encodeURIComponent(chunkUrl)}${sourceId ? `&sourceId=${sourceId}` : ''}`;
        });

        return content;
    } catch (e) {
        console.error('M3U8 Rewrite error:', e);
        return null;
    }
}

// Pipe a stream response to the client, following redirects (up to maxRedirects hops).
// Unlike proxyFetch (which buffers), this streams data directly.
function pipeWithRedirects(targetUrl, agent, clientReq, clientRes, maxRedirects = 5) {
    const lib = targetUrl.startsWith('https') ? https : http;
    const opts = {
        headers: {}
    };

    // Forward Range header for partial content requests
    if (clientReq.headers.range) {
        opts.headers.Range = clientReq.headers.range;
    }

    if (agent) {
        opts.agent = agent;
        opts.rejectUnauthorized = false;
    }

    const proxyReq = lib.get(targetUrl, opts, (proxyRes) => {
        // Follow redirects
        const isRedirect = [301, 302, 307, 308].includes(proxyRes.statusCode);
        if (isRedirect && proxyRes.headers.location && maxRedirects > 0) {
            let redirectUrl = proxyRes.headers.location;
            if (!redirectUrl.startsWith('http')) {
                const urlObj = new URL(targetUrl);
                redirectUrl = urlObj.origin + redirectUrl;
            }
            proxyRes.resume(); // Drain the response to free memory
            return pipeWithRedirects(redirectUrl, agent, clientReq, clientRes, maxRedirects - 1);
        }

        // Forward status and headers to client
        clientRes.status(proxyRes.statusCode);
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            clientRes.setHeader(key, value);
        }
        // Pipe the stream data
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
        console.error('Stream proxy error:', err.message);
        if (!clientRes.headersSent) clientRes.status(502).end();
    });

    // Abort upstream request if client disconnects
    clientReq.on('close', () => {
        proxyReq.destroy();
    });
}

// =============================================================================
// GENERIC STREAM PROXY (used by M3U, WARP/MPD, Pluto TV, etc.)
// =============================================================================

router.get('/stream', async (req, res) => {
    const { url, sourceId } = req.query;
    if (!url) return res.status(400).send('URL required');

    try {
        const agent = await getWarpAgent(sourceId);

        // Handle M3U8 rewrite
        if (url.includes('.m3u8')) {
            const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy/stream`;
            const manifest = await rewriteM3u8(url, proxyBase, sourceId);
            if (manifest) {
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                return res.send(manifest);
            }
        }

        // Pipe stream with redirect following (Xtream servers commonly 302-redirect)
        pipeWithRedirects(url, agent, req, res);

    } catch (err) {
        console.error('Stream handler error:', err);
        if (!res.headersSent) res.status(500).end();
    }
});

// Image Proxy
router.get('/image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL required');

    // Valid check

    if (!url.startsWith('http')) return res.redirect(url); // already local or invalid

    try {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, (proxyRes) => {
            res.status(proxyRes.statusCode);
            for (const [key, value] of Object.entries(proxyRes.headers)) {
                // cors
                if (key === 'access-control-allow-origin') continue;
                res.setHeader(key, value);
            }
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            proxyRes.pipe(res);
        }).on('error', err => {
            res.status(404).end();
        });
    } catch (e) {
        res.status(500).end();
    }
});

module.exports = router;
