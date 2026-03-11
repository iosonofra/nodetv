const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  page.on('request', req => {
      const url = req.url();
      if (url.includes('s3.dualstack')) return; // Ignore fake noise
      if (
          url.includes('.m3u8') || 
          url.includes('.mpd') || 
          url.includes('mono.css') || 
          url.includes('mono.csv')
      ) {
          console.log('[+] FOUND STREAM URL:', url);
      }
  });

  console.log('Navigating to DaddyHD channel 13 via DLStreams...');
  await page.goto('https://dlstreams.top/watch.php?id=13', { waitUntil: 'load', timeout: 45000 });
  
  await new Promise(r => setTimeout(r, 15000));
  console.log('Done.');
  await browser.close();
})();
