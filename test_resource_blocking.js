const { extractStreamUrl, getLaunchOptions } = require('./server/services/dlstreamsResolver.js');
const puppeteer = require('puppeteer-extra');

async function testTiming() {
    console.log("Launching browser...");
    const browser = await puppeteer.launch(getLaunchOptions());
    
    // TEST 1: No resource blocking (Baseline)
    console.log("\n--- TEST 1: Baseline (No resource blocking) ---");
    let page1 = await browser.newPage();
    await page1.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
    
    console.time('resolve_40_baseline');
    const result1 = await extractStreamUrl(page1, '40');
    console.timeEnd('resolve_40_baseline');
    console.log("Result:", result1?.streamUrl?.substring(0, 80));
    await page1.close();

    // TEST 2: With resource blocking
    console.log("\n--- TEST 2: With Resource Blocking ---");
    let page2 = await browser.newPage();
    await page2.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
    
    await page2.setRequestInterception(true);
    page2.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url();
        // Allow ONLY document, script, xhr, fetch. Block everything else (image, font, media, websocket, etc.)
        // IMPORTANT: DaddyHD disguised streams are often .css, so we MUST allow stylesheet if it has 'mono.css' or 'premium' or 'proxy'
        // Actually, to be safe, maybe just block image, media, font.
        if (['image', 'media', 'font'].includes(type)) {
            req.abort();
        } else if (type === 'stylesheet' && !url.includes('mono') && !url.includes('proxy')) {
            req.abort();
        } else {
            req.continue();
        }
    });

    console.time('resolve_713_blocked');
    const result2 = await extractStreamUrl(page2, '713');
    console.timeEnd('resolve_713_blocked');
    console.log("Result:", result2?.streamUrl?.substring(0, 80));
    await page2.close();

    await browser.close();
}

testTiming().catch(console.error);
