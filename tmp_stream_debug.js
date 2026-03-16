const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.on('request', req => {
    const url = req.url();
    if (url.includes('.m3u8') || url.includes('.mpd') || url.includes('.css') || url.includes('.csv')) {
      console.log('[req]', url);
    }
  });
  page.on('response', res => {
    const url = res.url();
    if (url.includes('.m3u8') || url.includes('.mpd') || url.includes('.css') || url.includes('.csv')) {
      console.log('[res]', url, res.status());
    }
  });
  const target = 'https://dlstreams.top/stream/stream-769.php';
  console.log('goto', target);
  try {
    const r = await page.goto(target, { waitUntil: 'networkidle2', timeout: 40000 });
    console.log('navigated', r.status(), r.url());
  } catch (e) {
    console.error('goto error', e.message);
  }
  const body = await page.content();
  console.log('body len', body.length);
  const found = body.match(/https?:\/\/[^"'\s]+\.(?:m3u8|css|mpd|csv)/gi);
  console.log('found', found && found.slice(0,10));
  await browser.close();
})();
