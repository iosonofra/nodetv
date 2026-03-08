/**
 * M3U Playlist Parser (Streaming)
 * Parses EXTM3U format playlists and extracts channel information line-by-line
 */

const readline = require('readline');
const { Readable } = require('stream');
const fs = require('fs');

/**
 * Generate a simple stable ID from name and group
 * @param {string} name - Channel name
 * @param {string} group - Group title
 * @returns {string} Stable ID
 */
function generateStableId(name, group) {
    const str = `${name || 'unknown'}:${group || 'unknown'}`;
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return `m3u_${Math.abs(hash).toString(36)}`;
}

/**
 * Parse EXTINF line and extract attributes
 * @param {string} line - EXTINF line
 * @returns {Object} Parsed channel info
 */
function parseExtinf(line) {
    const info = {
        duration: -1,
        tvgId: null,
        tvgName: null,
        tvgLogo: null,
        groupTitle: null,
        name: null
    };

    // Extract duration and rest
    const match = line.match(/#EXTINF:(-?\d+\.?\d*)\s*(.*)/);
    if (!match) return info;

    info.duration = parseFloat(match[1]);
    const rest = match[2];

    // Extract attributes using regex
    const attrPatterns = {
        tvgId: /tvg-id="([^"]*)"/i,
        tvgName: /tvg-name="([^"]*)"/i,
        tvgLogo: /tvg-logo="([^"]*)"/i,
        groupTitle: /group-title="([^"]*)"/i
    };

    for (const [key, pattern] of Object.entries(attrPatterns)) {
        const attrMatch = rest.match(pattern);
        if (attrMatch) {
            info[key] = attrMatch[1];
        }
    }

    // Extract channel name (after the comma)
    const commaIndex = rest.lastIndexOf(',');
    if (commaIndex !== -1) {
        info.name = rest.substring(commaIndex + 1).trim();
    } else {
        // Fallback: use tvg-name or the whole rest
        info.name = info.tvgName || rest.trim();
    }

    // Generate ID if not present
    if (!info.tvgId) {
        info.tvgId = info.name ? info.name.toLowerCase().replace(/\s+/g, '_') : `channel_${Date.now()}`;
    }

    return info;
}

/**
 * Parse M3U content (Stream or String)
 * @param {Readable|string} input - M3U content as Stream or String
 * @returns {Promise<{ channels: Array, groups: Array }>}
 */
async function parse(input) {
    const channels = [];
    const groupsSet = new Set();
    let currentInfo = null;
    let currentGroup = null;
    let currentProperties = {};

    let lines;

    if (typeof input === 'string') {
        // Handle string input directly
        lines = input.split(/\r?\n/);
    } else {
        // Handle stream input
        const rl = readline.createInterface({
            input: input,
            crlfDelay: Infinity
        });
        lines = rl;
    }

    for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('#EXTINF:')) {
            // Parse EXTINF line
            currentInfo = parseExtinf(trimmed);
            if (currentInfo.groupTitle) {
                groupsSet.add(currentInfo.groupTitle);
                currentGroup = currentInfo.groupTitle;
            }
        } else if (trimmed.startsWith('#EXTGRP:')) {
            // Parse EXTGRP line (alternative group specification)
            currentGroup = trimmed.substring(8).trim();
            groupsSet.add(currentGroup);
            if (currentInfo) {
                currentInfo.groupTitle = currentGroup;
            }
        } else if (trimmed.startsWith('#KODIPROP:')) {
            // Parse KODIPROP lines to extract DRM keys and other properties
            const propString = trimmed.substring(10).trim();
            const eqIndex = propString.indexOf('=');
            if (eqIndex !== -1) {
                const key = propString.substring(0, eqIndex).trim();
                const value = propString.substring(eqIndex + 1).trim();
                currentProperties[key] = value;
            }
        } else if (!trimmed.startsWith('#')) {
            // This is a stream URL
            if (currentInfo) {
                const groupTitle = currentInfo.groupTitle || currentGroup || 'Uncategorized';
                // Generate a stable ID: use tvgId if present, otherwise hash name+group
                const stableId = currentInfo.tvgId || generateStableId(currentInfo.name, groupTitle);

                channels.push({
                    ...currentInfo,
                    id: stableId,
                    url: trimmed,
                    groupTitle: groupTitle,
                    properties: Object.keys(currentProperties).length > 0 ? { ...currentProperties } : null
                });
                currentInfo = null;
                currentProperties = {}; // Reset properties for next channel
            }
        }
    }

    // Convert groups to array of objects
    const groups = Array.from(groupsSet).map((name, index) => ({
        id: `group_${index}`,
        name,
        channelCount: channels.filter(c => c.groupTitle === name).length
    }));

    return { channels, groups };
}

/**
 * Internal helper to get a Readable stream from a URL or local path
 * @param {string} urlOrPath - M3U playlist URL or file path
 * @returns {Promise<Readable>}
 */
async function getInputStream(urlOrPath) {
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
        const response = await fetch(urlOrPath, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch M3U: ${response.status} ${response.statusText}`);
        }

        if (response.body && typeof response.body.pipe === 'function') {
            return response.body;
        } else if (response.body) {
            return Readable.fromWeb(response.body);
        } else {
            return Readable.from([]);
        }
    } else {
        // Assume local file path
        if (!fs.existsSync(urlOrPath)) {
            throw new Error(`File not found: ${urlOrPath}`);
        }
        return fs.createReadStream(urlOrPath);
    }
}

/**
 * Fetch and parse M3U from URL or local path
 * @param {string} urlOrPath - M3U playlist URL or path
 * @returns {Promise<{ channels: Array, groups: Array }>}
 */
async function fetchAndParse(urlOrPath) {
    const stream = await getInputStream(urlOrPath);
    return parse(stream);
}

/**
 * Parse M3U content as a streaming async generator (memory-efficient)
 * Yields batches of channels to avoid loading entire playlist into memory.
 * 
 * @param {Readable|string} input - M3U content as Stream or String
 * @param {number} batchSize - Number of channels per batch (default: 500)
 * @yields {{ channels: Array, groups: Set, isLast: boolean }}
 */
async function* parseStreaming(input, batchSize = 500) {
    const groupsSet = new Set();
    let currentInfo = null;
    let currentGroup = null;
    let currentProperties = {};
    let batch = [];

    let lines;
    if (typeof input === 'string') {
        lines = input.split(/\r?\n/);
    } else {
        const rl = readline.createInterface({
            input: input,
            crlfDelay: Infinity
        });
        lines = rl;
    }

    for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('#EXTINF:')) {
            currentInfo = parseExtinf(trimmed);
            if (currentInfo.groupTitle) {
                groupsSet.add(currentInfo.groupTitle);
                currentGroup = currentInfo.groupTitle;
            }
        } else if (trimmed.startsWith('#EXTGRP:')) {
            currentGroup = trimmed.substring(8).trim();
            groupsSet.add(currentGroup);
            if (currentInfo) {
                currentInfo.groupTitle = currentGroup;
            }
        } else if (trimmed.startsWith('#KODIPROP:')) {
            const propString = trimmed.substring(10).trim();
            const eqIndex = propString.indexOf('=');
            if (eqIndex !== -1) {
                const key = propString.substring(0, eqIndex).trim();
                const value = propString.substring(eqIndex + 1).trim();
                currentProperties[key] = value;
            }
        } else if (!trimmed.startsWith('#')) {
            if (currentInfo) {
                const groupTitle = currentInfo.groupTitle || currentGroup || 'Uncategorized';
                const stableId = currentInfo.tvgId || generateStableId(currentInfo.name, groupTitle);

                batch.push({
                    ...currentInfo,
                    id: stableId,
                    url: trimmed,
                    groupTitle: groupTitle,
                    properties: Object.keys(currentProperties).length > 0 ? { ...currentProperties } : null
                });
                currentInfo = null;
                currentProperties = {};

                // Yield batch when full
                if (batch.length >= batchSize) {
                    yield { channels: batch, groups: groupsSet, isLast: false };
                    batch = [];
                }
            }
        }
    }

    // Yield remaining channels
    if (batch.length > 0) {
        yield { channels: batch, groups: groupsSet, isLast: true };
    } else {
        // Yield empty final batch with isLast=true so caller knows we're done
        yield { channels: [], groups: groupsSet, isLast: true };
    }
}

/**
 * Fetch and parse M3U from URL or local path as streaming async generator (memory-efficient)
 * @param {string} urlOrPath - M3U playlist URL or path
 * @param {number} batchSize - Number of channels per batch
 * @yields {{ channels: Array, groups: Set, isLast: boolean }}
 */
async function* fetchAndParseStreaming(urlOrPath, batchSize = 500) {
    const stream = await getInputStream(urlOrPath);
    yield* parseStreaming(stream, batchSize);
}

/**
 * Fast count of entries in an M3U playlist (for size estimation)
 * Streams the file and counts #EXTINF lines without full parsing
 * @param {string} urlOrPath - URL or local path of the M3U playlist
 * @returns {Promise<number>} Number of entries
 */
async function countEntries(urlOrPath) {
    const stream = await getInputStream(urlOrPath);

    return new Promise((resolve, reject) => {
        let count = 0;
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        rl.on('line', (line) => {
            if (line.startsWith('#EXTINF:')) {
                count++;
            }
        });

        rl.on('close', () => resolve(count));
        rl.on('error', reject);
    });
}

module.exports = { parse, parseExtinf, fetchAndParse, parseStreaming, fetchAndParseStreaming, countEntries };

