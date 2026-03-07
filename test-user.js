const db = require('./server/db');

(async () => {
    try {
        const user = await db.users.create({
            username: 'testuser2',
            passwordHash: 'dummy',
            role: 'viewer'
        });
        console.log('Success:', user);
    } catch (err) {
        console.error('ERROR:', err);
    }
})();
