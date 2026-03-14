const { extractStreamUrl, getLaunchOptions } = require('./server/services/dlstreamsResolver');
const puppeteer = require('puppeteer-extra');

async function testConcurrency() {
    const browser = await puppeteer.launch(getLaunchOptions());
    
    // Some known channel IDs (mix of DaddyHD and others)
    const channelsToTest = [713, 171, 40, 5005, 51];
    
    console.log(`Testing concurrency with ${channelsToTest.length} workers...`);
    
    const workers = channelsToTest.map(async (id, index) => {
        const workerId = index + 1;
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
        
        console.log(`[Worker ${workerId}] Starting resolution for ID ${id}`);
        const result = await extractStreamUrl(page, id);
        
        if (result.streamUrl) {
            console.log(`[Worker ${workerId}] SUCCESS! Found URL for ID ${id}: ${result.streamUrl}`);
        } else {
            console.log(`[Worker ${workerId}] FAILED. No URL found for ID ${id}`);
            await page.screenshot({ path: `failure_${id}.png` });
        }
        
        await page.close();
        return result;
    });
    
    const results = await Promise.all(workers);
    const successes = results.filter(r => r.streamUrl).length;
    
    console.log(`\nCompleted! ${successes}/${channelsToTest.length} channels successfully resolved.`);
    await browser.close();
}

testConcurrency().catch(console.error);
