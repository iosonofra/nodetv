const http = require('http');

const targetUrl = 'http://aa199.forever-youngs.top:8080/hls/1ec4e47143e0a34695c02a65deabac77/417100_5306.ts';

const opts = {
    headers: {
        'Host': 'aa199.forever-youngs.top:8080',
        'User-Agent': 'curl/8.18.0',
        'Accept': '*/* ' // Space added to defeat simple exact matching if any, or just plain
    }
};
opts.headers['Accept'] = '*/*';

http.get(targetUrl, opts, (res) => {
    console.log('Status spoofing curl perfectly:', res.statusCode);
    console.log('Headers:', res.headers);
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => console.log('Body length:', body.length));
}).on('error', console.error);
