const { extractStreamUrl, getLaunchOptions } = require('./server/services/dlstreamsResolver.js');
const puppeteer = require('puppeteer-extra');

async function extractFaster(page, channelId) {
    const playerUrl = `https://dlstreams.top/watch.php?id=${channelId}`;
    let streamUrl = null;

    const MONITOR_SCRIPT = `
    (function() {
        const originalFetch = window.fetch;
        window.fetch = function() {
            const url = arguments[0];
            if (typeof url === 'string' && !url.includes('s3.dualstack') && (url.includes('.mpd') || url.includes('.m3u8') || url.includes('mono.css') || url.includes('mono.csv'))) {
                console.log('INTERCEPT_URL:' + url);
            }
            return originalFetch.apply(this, arguments);
        };
    })();
    `;

    page.on('console', msg => {
        const text = msg.text();
        if (text.startsWith('INTERCEPT_URL:') && !streamUrl) streamUrl = text.replace('INTERCEPT_URL:', '');
    });

    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(MONITOR_SCRIPT);
    await page.goto(playerUrl, { waitUntil: 'load', timeout: 45000 });

    const checkFrames = async () => {
        for (const frame of page.frames()) {
            if (frame.url().includes('mono.css')) streamUrl = frame.url();
        }
    };

    // Wait ONLY 2 seconds before clicking
    let pollAttempts = 0;
    while (!streamUrl && pollAttempts < 4) {
        await new Promise(r => setTimeout(r, 500));
        await checkFrames();
        pollAttempts++;
    }

    // Click 1
    if (!streamUrl) {
        await page.bringToFront();
        await page.mouse.click(640, 360);
        pollAttempts = 0;
        while (!streamUrl && pollAttempts < 4) {
            await new Promise(r => setTimeout(r, 500));
            await checkFrames();
            pollAttempts++;
        }
    }

    return { streamUrl };
}

async function testTiming() {
    console.time('launch');
    const browser = await puppeteer.launch(getLaunchOptions());
    console.timeEnd('launch');

    console.log("\n--- Resolution (Channel 713) ---");
    console.time("resolve_713_fast");
    const page2 = await browser.newPage();
    await page2.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
    const result2 = await extractFaster(page2, '713');
    console.log("Result:", result2?.streamUrl);
    await page2.close();
    console.timeEnd("resolve_713_fast");

    await browser.close();
}

testTiming().catch(console.error);
