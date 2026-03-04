const http = require('http');

const targetUrl = 'http://aa199.forever-youngs.top:8080/hls/1ec4e47143e0a34695c02a65deabac77/417100_5306.ts';

const opts = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': '*/*'
    }
};

http.get(targetUrl, opts, (res) => {
    console.log('Status Node HTTP on AA199:', res.statusCode);
}).on('error', console.error);
