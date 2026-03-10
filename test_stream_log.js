const fetch = require('node-fetch');

async function testStreamProxy() {
    const url = 'http://localhost:3000/api/proxy/stream?url=https://example.com&sourceId=2';
    try {
        const response = await fetch(url);
        const text = await response.text();
        console.log('Response status:', response.status);
    } catch (err) {
        console.error('Test failed:', err.message);
    }
}

testStreamProxy();
