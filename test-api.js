const http = require('http');

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

(async () => {
    try {
        const loginRes = await request({
            hostname: 'localhost', port: 3000, path: '/api/auth/login', method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { username: 'admin', password: 'password' }); // Replace with actual default admin password if needed, but assuming standard dev setup

        const loginData = JSON.parse(loginRes.data);
        if (!loginData.token) throw new Error('Login failed: ' + loginRes.data);
        console.log('Got token');

        const createRes = await request({
            hostname: 'localhost', port: 3000, path: '/api/auth/users', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + loginData.token }
        }, { username: 'apiuser', password: 'password', role: 'viewer' });

        console.log('Create Response:', createRes.status, createRes.data);
    } catch (e) {
        console.error(e);
    }
})();
