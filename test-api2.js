const http = require('http');
const auth = require('./server/auth.js');
const db = require('./server/db.js');

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
        const data = await db.loadDb();
        const adminUser = data.users.find(u => u.role === 'admin');
        if (!adminUser) throw new Error('No admin user found');

        const token = auth.generateToken(adminUser);
        console.log('Got token for admin:', adminUser.username);

        const createRes = await request({
            hostname: 'localhost', port: 3000, path: '/api/auth/users', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
        }, { username: 'apiuser3', password: 'password', role: 'viewer' });

        console.log('Create Response:', createRes.status, createRes.data);
    } catch (e) {
        console.error(e);
    }
})();
