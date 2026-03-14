const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { extractStreamUrl, getLaunchOptions } = require('./server/services/dlstreamsResolver');

(async () => {
    const browser = await puppeteer.launch(getLaunchOptions());
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");

    console.log("Testing channel 713...");
    const res = await extractStreamUrl(page, '713');
    console.log(res);

    console.log("Testing channel 576...");
    const res2 = await extractStreamUrl(page, '576');
    console.log(res2);

    await browser.close();
    process.exit(0);
})();
