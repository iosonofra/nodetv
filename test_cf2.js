const http = require('http');

const targetUrl = 'http://8yr1cw.hhkys.com/hls/7605c0c9404459fd91de64acb4c10afe/417100_4600.ts';

const opts = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': '*/*, application/vnd.apple.mpegurl',
        'Connection': 'keep-alive',
        'Accept-Encoding': 'gzip, deflate, br'
    }
};

http.get(targetUrl, opts, (res) => {
    console.log('Status Node HTTP:', res.statusCode);
}).on('error', console.error);
