const { settings } = require('./server/db');
const vpnService = require('./server/services/vpnService');
const fs = require('fs/promises');
const path = require('path');

async function verify() {
    console.log('--- Starting VPN Settings Verification ---');

    // 1. Test data update
    const newSettings = {
        warpHost: '1.2.3.4',
        warpPort: 9999,
        warpProxyRules: ['test.com', 'proxy-me.mpd']
    };

    console.log('Updating settings in DB...');
    await settings.update(newSettings);

    const dbSettings = await settings.get();
    if (dbSettings.warpHost === '1.2.3.4' && dbSettings.warpPort === 9999) {
        console.log('✅ DB update success');
    } else {
        console.error('❌ DB update failed');
    }

    // 2. Test vpnService sync
    console.log('Syncing to config.json...');
    await vpnService.syncConfig(dbSettings);

    const configPath = path.join(__dirname, 'scripts', 'warp', 'config.json');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    if (config.warpHost === '1.2.3.4' && config.warpPort === 9999 && config.proxyRules.includes('test.com')) {
        console.log('✅ config.json sync success');
    } else {
        console.error('❌ config.json sync failed');
    }

    // 3. Test vpnService testConnection (this might fail if no proxy is running, but shouldn't throw syntax errors)
    console.log('Testing testConnection (expecting failure if no proxy is running, but checking for syntax/runtime errors)...');
    try {
        const result = await vpnService.testConnection('127.0.0.1', 1080);
        console.log('✅ testConnection executed, result:', result);
    } catch (err) {
        console.log('❌ testConnection threw (expected if no proxy):', err.message);
    }

    console.log('--- Verification Complete ---');
}

verify().catch(console.error);
