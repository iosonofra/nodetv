const http = require('http');

// Get the URL from arguments
const targetUrl = process.argv[2] || 'http://8yr1cw.hhkys.com/hls/7605c0c9404459fd91de64acb4c10afe/417100_4600.ts';

// Extract hostname for Referer
const urlObj = new URL(targetUrl);
const referer = `${urlObj.protocol}//${urlObj.host}/`;
console.log(`Testing with Referer: ${referer}`);

const opts = {
    headers: {
        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        'Accept': '*/*, application/vnd.apple.mpegurl',
        'Referer': referer,
        'Origin': referer.slice(0, -1) // remove trailing slash
    }
};

http.get(targetUrl, opts, (res) => {
    console.log('Status:', res.statusCode);
    console.log('Headers:', res.headers);
    if (res.statusCode === 403) {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => console.log('Body:', body.substring(0, 300)));
    }
}).on('error', console.error);
