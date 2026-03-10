const fetch = require('node-fetch');

async function testImageProxy() {
    const url = 'http://localhost:3000/api/proxy/image?url=https://example.com/logo.png&sourceId=2';
    try {
        const response = await fetch(url);
        console.log('Response status:', response.status);
    } catch (err) {
        console.error('Test failed:', err.message);
    }
}

testImageProxy();
