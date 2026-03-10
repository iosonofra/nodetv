const fetch = require('node-fetch');

async function testConsolidation() {
    const baseUrl = 'http://localhost:3000/api/proxy';

    console.log('--- Testing EPG Refresh (Force Fetch) ---');
    try {
        const res = await fetch(`${baseUrl}/epg/2?refresh=1`);
        console.log('EPG Refresh status:', res.status);
    } catch (err) {
        console.error('EPG Refresh failed:', err.message);
    }

    console.log('\n--- Testing Xtream Action (Auth) ---');
    try {
        const res = await fetch(`${baseUrl}/xtream/2/auth`);
        console.log('Xtream Auth status:', res.status);
    } catch (err) {
        console.error('Xtream Auth failed:', err.message);
    }
}

testConsolidation();
