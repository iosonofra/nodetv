const fetch = require('node-fetch');

async function testDrmProxy() {
    const url = 'http://localhost:3000/api/proxy/drm?url=https://example.com/drm&sourceId=2';
    try {
        const response = await fetch(url, {
            method: 'POST',
            body: Buffer.from('test'),
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        const data = await response.json();
        console.log('Response:', data);
    } catch (err) {
        console.error('Test failed as expected:', err.message);
    }
}

testDrmProxy();
