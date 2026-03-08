const http = require('http');

const data = JSON.stringify({
    host: '127.0.0.1',
    port: 1080
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/settings',
    method: 'GET'
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
    res.setEncoding('utf8');
    let body = '';
    res.on('data', (chunk) => {
        body += chunk;
    });
    res.on('end', () => {
        console.log('BODY:');
        console.log(body);
        if (body.startsWith('<!DOCTYPE html>') || body.startsWith('<html>')) {
            console.error('❌ RECEIVED HTML INSTEAD OF JSON');
        } else {
            try {
                JSON.parse(body);
                console.log('✅ RECEIVED VALID JSON');
            } catch (e) {
                console.error('❌ BODY IS NOT VALID JSON:', e.message);
            }
        }
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.write(data);
req.end();
