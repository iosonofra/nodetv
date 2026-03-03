const { getDb } = require('./server/db/sqlite');
const { sources } = require('./server/db');
const syncService = require('./server/services/syncService');

async function debugM3u() {
    const db = getDb();

    console.log('[1] Check DB.JSON Sources');
    const allSources = await sources.getAll();
    const targetSource = allSources.find(s => s.id === 0);
    console.log('Source 0:', targetSource);

    if (!targetSource) {
        console.log('Target source not found natively.');
        return;
    }

    console.log('\n[2] Triggering Sync...');
    await syncService.syncSource(0);

    console.log('\n[3] Checking SQLite Items');
    const ct = db.prepare('SELECT COUNT(*) as count FROM playlist_items WHERE source_id=0').get();
    console.log('Items for Source 0: ', ct.count);

    const check = db.prepare('SELECT * FROM playlist_items WHERE source_id=0 LIMIT 2').all();
    console.log(check);
}

debugM3u().catch(e => console.error(e));
