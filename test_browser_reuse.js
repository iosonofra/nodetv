const { extractStreamUrl, getLaunchOptions } = require('./server/services/dlstreamsResolver.js');
const puppeteer = require('puppeteer-extra');

async function testBrowserReuse() {
    console.log("Launching shared browser...");
    console.time("launch_browser");
    const browser = await puppeteer.launch(getLaunchOptions());
    console.timeEnd("launch_browser");

    // Warm-up resolution
    console.log("\n--- Resolution 1 (Channel 40) ---");
    console.time("resolve_40");
    const page1 = await browser.newPage();
    await page1.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
    const result1 = await extractStreamUrl(page1, '40');
    console.log("Result:", result1?.streamUrl);
    await page1.close();
    console.timeEnd("resolve_40");

    // Second resolution - should be much faster because browser is already running
    console.log("\n--- Resolution 2 (Channel 713) ---");
    console.time("resolve_713");
    const page2 = await browser.newPage();
    await page2.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
    const result2 = await extractStreamUrl(page2, '713');
    console.log("Result:", result2?.streamUrl);
    await page2.close();
    console.timeEnd("resolve_713");

    await browser.close();
}

testBrowserReuse().catch(console.error);
