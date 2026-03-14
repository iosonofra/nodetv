const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { extractStreamUrl, getLaunchOptions } = require('./server/services/dlstreamsResolver');

(async () => {
    const browser = await puppeteer.launch(getLaunchOptions());
    
    // IDs to test concurrently
    const channels = ['713', '576', '113', '714', '715', '716', '717', '718', '719', '720'];
    
    console.log(`Testing ${channels.length} channels in parallel...`);
    
    const promises = channels.map(async (id) => {
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
        const res = await extractStreamUrl(page, id);
        console.log(`Channel ${id}:`, res.streamUrl ? 'FOUND' : 'MISSING');
        await page.close();
        return res;
    });

    await Promise.all(promises);
    await browser.close();
    process.exit(0);
})();
