#!/usr/bin/env node
/**
 * Test which headers the sportsonline CDN requires.
 * Run this on the server to diagnose 403 errors.
 * 
 * Usage: node test_sportsonline_headers.js [phpUrl]
 * 
 * If no phpUrl is provided, reads from the M3U file.
 */

const fetch = require('node-fetch');
const https = require('https');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Allow self-signed certs
const agent = new https.Agent({ rejectUnauthorized: false });

async function resolveFromPhp(phpUrl) {
    console.log(`\n── Resolving from ${phpUrl} ──`);

    // Step 1: Fetch PHP page → extract iframe
    const phpRes = await fetch(phpUrl, { headers: { 'User-Agent': UA }, agent });
    const phpHtml = await phpRes.text();
    console.log(`PHP page: ${phpRes.status} (${phpHtml.length} bytes)`);

    const iframeMatch = phpHtml.match(/iframe[^>]+src=["']([^"']*dynamicsnake\.net[^"']*)/i)
        || phpHtml.match(/iframe[^>]+src=["'](https?:\/\/[^"']+\/embed\/[^"']+)/i);

    let embedUrl;
    if (!iframeMatch) {
        const srcMatch = phpHtml.match(/(?:var\s+)?src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
        if (srcMatch) return { streamUrl: srcMatch[1], embedUrl: phpUrl };
        throw new Error('No iframe/embed found');
    }
    embedUrl = iframeMatch[1];
    if (embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl;
    console.log(`Embed URL: ${embedUrl}`);

    // Step 2: Fetch embed → extract var src
    const embedRes = await fetch(embedUrl, {
        headers: { 'User-Agent': UA, 'Referer': phpUrl },
        agent
    });
    const embedHtml = await embedRes.text();
    console.log(`Embed page: ${embedRes.status} (${embedHtml.length} bytes)`);

    const srcMatch = embedHtml.match(/var\s+src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
    if (!srcMatch) throw new Error('No stream src in embed page');

    return { streamUrl: srcMatch[1], embedUrl };
}

async function testFetch(label, url, headers) {
    try {
        const res = await fetch(url, { headers, agent });
        const contentType = res.headers.get('content-type') || '';
        const body = await res.text();
        const isM3U = body.includes('#EXTM3U') || body.includes('#EXT-X-');
        console.log(`  ${label}: ${res.status} | ${contentType} | ${body.length} bytes | M3U: ${isM3U}`);
        if (res.status === 403 || res.status === 401) {
            console.log(`    Body: ${body.substring(0, 150)}`);
        }
        if (isM3U) {
            console.log(`    First lines: ${body.split('\n').slice(0, 3).join(' | ')}`);
        }
        return res.status;
    } catch (err) {
        console.log(`  ${label}: ERROR - ${err.message}`);
        return 0;
    }
}

async function testHeaderCombinations(streamUrl, embedUrl) {
    const embedOrigin = new URL(embedUrl).origin;
    console.log(`\n── Testing CDN header combinations ──`);
    console.log(`Stream URL: ${streamUrl}`);
    console.log(`Embed URL:  ${embedUrl}`);
    console.log(`Embed Origin: ${embedOrigin}\n`);

    // Test 1: No headers at all (just UA)
    await testFetch('1. UA only', streamUrl, {
        'User-Agent': UA
    });

    // Test 2: Referer only (embed URL)
    await testFetch('2. Referer=embedUrl', streamUrl, {
        'User-Agent': UA,
        'Referer': embedUrl
    });

    // Test 3: Referer only (embed origin + /)
    await testFetch('3. Referer=embedOrigin/', streamUrl, {
        'User-Agent': UA,
        'Referer': embedOrigin + '/'
    });

    // Test 4: Referer + Origin (what our proxy currently sends)
    await testFetch('4. Referer+Origin (current proxy)', streamUrl, {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': embedOrigin,
        'Referer': embedUrl
    });

    // Test 5: Origin only (no Referer)
    await testFetch('5. Origin only', streamUrl, {
        'User-Agent': UA,
        'Origin': embedOrigin
    });

    // Test 6: Referer + Origin + Sec-Fetch headers (mimicking browser XHR)
    await testFetch('6. Full browser XHR simulation', streamUrl, {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': embedOrigin,
        'Referer': embedUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site'
    });

    // Test 7: Referer=embedUrl, no Origin, Accept: application/vnd.apple.mpegurl
    await testFetch('7. Referer + HLS Accept', streamUrl, {
        'User-Agent': UA,
        'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
        'Referer': embedUrl
    });

    // Test 8: Just Referer with Origin set to null (CORS null origin)
    await testFetch('8. Referer + Origin=null', streamUrl, {
        'User-Agent': UA,
        'Referer': embedUrl,
        'Origin': 'null'
    });
}

async function getUrlFromM3U() {
    const m3uPath = path.join(__dirname, 'data', 'scraper', 'sportsonline.m3u');
    if (!fs.existsSync(m3uPath)) return null;
    const content = fs.readFileSync(m3uPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (lines.length === 0) return null;
    // Pick a URL with Kodi headers
    const withHeaders = lines.find(l => l.includes('|'));
    if (withHeaders) {
        const pipeIdx = withHeaders.indexOf('|');
        const baseUrl = withHeaders.substring(0, pipeIdx);
        const headerStr = withHeaders.substring(pipeIdx + 1);
        const headers = {};
        headerStr.split('&').forEach(h => {
            const eq = h.indexOf('=');
            if (eq > 0) headers[h.substring(0, eq)] = decodeURIComponent(h.substring(eq + 1));
        });
        return { streamUrl: baseUrl, embedUrl: headers['Referer'] || null };
    }
    return { streamUrl: lines[0], embedUrl: null };
}

(async () => {
    try {
        const phpUrl = process.argv[2];

        if (phpUrl) {
            // Resolve fresh URL from PHP page
            const { streamUrl, embedUrl } = await resolveFromPhp(phpUrl);
            await testHeaderCombinations(streamUrl, embedUrl);
        } else {
            // Try from existing M3U
            const fromM3U = await getUrlFromM3U();
            if (fromM3U && fromM3U.embedUrl) {
                console.log('Using URL from existing M3U file...');
                await testHeaderCombinations(fromM3U.streamUrl, fromM3U.embedUrl);
            } else {
                console.log('No M3U file found or no Kodi headers. Provide a PHP URL as argument.');
                console.log('Usage: node test_sportsonline_headers.js https://sportsonlin365.xyz/channel/XXX.php');
            }
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
})();
