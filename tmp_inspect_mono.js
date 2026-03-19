const fetch = require('node-fetch');
(async () => {
  const u = 'https://ai.the-sunmoon.site/proxy/nfs/premium1/mono.css';
  const tries = [
    { name: 'default', h: {} },
    { name: 'dlstreams', h: { Referer: 'https://dlstreams.top/', Origin: 'https://dlstreams.top' } },
    { name: 'mediahosting', h: { Referer: 'https://mediahosting.space/', Origin: 'https://mediahosting.space', 'User-Agent': 'Mozilla/5.0' } }
  ];
  const count = (txt, rx) => { const m = txt.match(rx); return m ? m.length : 0; };
  for (const t of tries) {
    try {
      const r = await fetch(u, { headers: t.h, timeout: 12000 });
      const txt = await r.text();
      const lines = txt.split(/\r?\n/).slice(0, 35);
      const img = count(txt, /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$|&|\"|')/ig);
      const media = count(txt, /\.(ts|m2ts|m4s|m4v|m4a|cmfa|cmfv|mp4|aac|ac3|ec3|mp3|webm)(\?|$|&)/ig);
      console.log('===', t.name, 'status', r.status, 'ct', r.headers.get('content-type'), 'img', img, 'media', media, '===');
      console.log(lines.join('\n'));
    } catch (e) {
      console.log('ERR', t.name, e.message);
    }
  }
})();
