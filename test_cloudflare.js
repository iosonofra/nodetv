const http = require('http');

const targetUrl = 'http://8yr1cw.hhkys.com/hls/7605c0c9404459fd91de64acb4c10afe/417100_4600.ts';
const urlObj = new URL(targetUrl);
const referer = `${urlObj.protocol}//${urlObj.host}/`;

const opts = {
    headers: {
        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        'Accept': '*/*, application/vnd.apple.mpegurl',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': referer,
        'Origin': referer.slice(0, -1)
    }
};

http.get(targetUrl, opts, (res) => {
    if (res.statusCode === 403) {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => console.log('Body:', body.toString()));
    } else {
        console.log('Success:', res.statusCode);
    }
}).on('error', console.error);
