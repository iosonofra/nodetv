// Native fetch in Node 18+

async function testStatus() {
    try {
        console.log('Testing /api/sources/status...');
        const response = await fetch('http://localhost:3000/api/sources/status');
        console.log('Status Code:', response.status);
        const data = await response.json();
        console.log('Data:', data);
    } catch (err) {
        console.error('Error:', err.message);
    }
}

testStatus();
