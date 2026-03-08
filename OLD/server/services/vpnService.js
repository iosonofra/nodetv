const fs = require('fs/promises');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'scripts', 'warp', 'config.json');

/**
 * vpnService - Manages synchronization with the Warp Proxy Hook configuration
 */
const vpnService = {
    /**
     * Syncs application settings to the Warp hook config.json file
     * @param {Object} settings The full application settings object
     */
    async syncConfig(settings) {
        try {
            if (settings.warpHost === undefined && settings.warpPort === undefined && settings.warpProxyRules === undefined) {
                return; // Nothing to sync
            }

            // Load existing config to preserve other fields if any
            let currentConfig = {};
            try {
                const content = await fs.readFile(CONFIG_PATH, 'utf-8');
                currentConfig = JSON.parse(content);
            } catch (err) {
                console.warn('[vpnService] Could not read existing config.json, creating new one.');
            }

            // Update with new settings
            const updatedConfig = {
                ...currentConfig,
                warpHost: settings.warpHost || currentConfig.warpHost || '127.0.0.1',
                warpPort: parseInt(settings.warpPort) || currentConfig.warpPort || 1080,
                proxyRules: settings.warpProxyRules || currentConfig.proxyRules || []
            };

            await fs.writeFile(CONFIG_PATH, JSON.stringify(updatedConfig, null, 2));
            console.log('[vpnService] Warp configuration synced to config.json');
        } catch (err) {
            console.error('[vpnService] Error syncing VPN configuration:', err);
            throw err;
        }
    },

    /**
     * Tests a SOCKS5 connection
     * @param {string} host 
     * @param {number} port 
     */
    async testConnection(host, port) {
        let SocksProxyAgent;
        try {
            const agentPath = path.join(__dirname, '..', '..', 'scripts', 'warp', 'node_modules', 'socks-proxy-agent');
            SocksProxyAgent = require(agentPath).SocksProxyAgent;
        } catch (err) {
            try {
                SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
            } catch (e) {
                throw new Error('socks-proxy-agent not found. Run "npm install --prefix scripts/warp"');
            }
        }

        const agent = new SocksProxyAgent(`socks5h://${host}:${port}`);

        try {
            // For testing connectivity through SOCKS5, node-fetch is the most reliable
            // because native Node 18 fetch (undici) handles agents differently (dispatchers).
            let fetchFn;
            try {
                // Try to use node-fetch if available in the warp scripts folder or global
                const nodeFetchPath = path.join(__dirname, '..', '..', 'scripts', 'warp', 'node_modules', 'node-fetch');
                fetchFn = require(nodeFetchPath);
            } catch (e) {
                try {
                    fetchFn = require('node-fetch');
                } catch (e2) {
                    // Fallback to global fetch (direct connection if it's undici, as it ignores agent)
                    fetchFn = global.fetch;
                }
            }

            if (!fetchFn) {
                throw new Error('No fetch implementation found (node-fetch or native fetch)');
            }

            const response = await fetchFn('https://www.cloudflare.com/cdn-cgi/trace', {
                agent,
                timeout: 5000,
                // If using native fetch, this will be ignored, but it's our best shot
                signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
            });
            const text = await response.text();

            if (response.status >= 400) {
                throw new Error(`HTTP Error ${response.status}`);
            }

            return {
                success: true,
                info: text.split('\n').find(l => l.startsWith('ip=')) || 'Connected'
            };
        } catch (err) {
            throw new Error(`Connection failed: ${err.message}`);
        }
    }
};

module.exports = vpnService;
