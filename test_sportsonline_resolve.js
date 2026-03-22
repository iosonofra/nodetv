#!/usr/bin/env node
/**
 * Test: resolve a sportsonline stream URL from this server's IP
 * and immediately try to fetch the m3u8 from the same IP.
 * This verifies whether on-demand resolution bypasses the IP-bound token issue.
 */

const fetch = require('node-fetch');
const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

(async () => {
    // Step 1: Fetch a PHP page to get iframe
    const phpUrl = process.argv[2] || 'https://w2.sportzsonline.click/channels/hd/hd2.php';
    console.log('1. Fetching PHP page:', phpUrl);
    const phpRes = await fetch(phpUrl, { headers: { 'User-Agent': UA }, agent });
    const phpHtml = await phpRes.text();
    console.log('   PHP page:', phpRes.status, phpHtml.length, 'bytes');

    const iframeMatch = phpHtml.match(/iframe[^>]+src=["']([^"']*dynamicsnake\.net[^"']*)/i);
    if (!iframeMatch) {
        console.log('No iframe found');
        // Try direct src match
        const directSrc = phpHtml.match(/(?:var\s+)?src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
        if (directSrc) console.log('Direct src:', directSrc[1]);
        return;
    }
    let embedUrl = iframeMatch[1];
    if (embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl;
    console.log('2. Embed URL:', embedUrl);

    // Step 2: Fetch embed page with Referer
    const embedRes = await fetch(embedUrl, { headers: { 'User-Agent': UA, 'Referer': phpUrl }, agent });
    const embedHtml = await embedRes.text();
    console.log('   Embed page:', embedRes.status, embedHtml.length, 'bytes');

    const srcMatch = embedHtml.match(/var\s+src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
    if (!srcMatch) {
        console.log('No stream src found in embed page');
        return;
    }
    const streamUrl = srcMatch[1];
    console.log('3. Fresh stream URL:', streamUrl);

    // Step 3: Immediately fetch the stream with Referer
    console.log('\n--- Testing stream fetch from THIS server IP ---');
    const streamRes = await fetch(streamUrl, {
        headers: { 'User-Agent': UA, 'Referer': embedUrl },
        agent
    });
    const body = await streamRes.text();
    const isM3U = body.includes('#EXT');
    console.log('4. Stream result:', streamRes.status, body.length, 'bytes', isM3U ? '✓ M3U!' : '✗ NOT M3U');
    if (isM3U) {
        console.log('   First 3 lines:', body.split('\n').slice(0, 3).join(' | '));
    } else {
        console.log('   Body:', body.substring(0, 200));
    }

    // Step 4: Also test WITHOUT Referer
    console.log('\n--- Testing WITHOUT Referer ---');
    const noRefRes = await fetch(streamUrl, {
        headers: { 'User-Agent': UA },
        agent
    });
    const noRefBody = await noRefRes.text();
    console.log('5. No Referer:', noRefRes.status, noRefBody.length, 'bytes', noRefBody.includes('#EXT') ? '✓ M3U' : '✗ NOT M3U');
})().catch(e => console.error('Error:', e.message));
