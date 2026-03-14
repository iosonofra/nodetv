const puppeteer = require('puppeteer-extra');
(async () => {
    const browser = await puppeteer.launch({headless: 'new'});
    const page = await browser.newPage();
    
    // Simulate what happens in the worker
    for (let i = 0; i < 50; i++) {
        await page.evaluateOnNewDocument(`
            (function() {
                const originalFetch = window.fetch;
                window.fetch = function() {
                    return originalFetch.apply(this, arguments);
                };
            })();
        `);
    }

    try {
        await page.goto('https://example.com');
        await page.evaluate(() => fetch('https://example.com'));
        console.log("Fetch succeeded.");
    } catch(err) {
        console.error("Fetch failed:", err.message);
    }
    await browser.close();
})();
