/**
 * Warp Proxy Hook - Intercepts network requests and routes them through Warp
 * Supports dynamic configuration reloading via config.json
 * 
 * Usage: NODE_OPTIONS="--require ./scripts/warp/hook.js" npm start
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// Load SocksProxyAgent from local node_modules or global
let SocksProxyAgent;
try {
    const agentPath = path.join(__dirname, 'node_modules', 'socks-proxy-agent');
    SocksProxyAgent = require(agentPath).SocksProxyAgent;
} catch (err) {
    try {
        SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
    } catch (e) {
        console.error('[WarpHook] Error: socks-proxy-agent is missing. Run "npm install --prefix scripts/warp"');
    }
}

let config = {
    warpHost: "127.0.0.1",
    warpPort: 1080,
    proxyRules: []
};

let agent = null;

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = fs.readFileSync(CONFIG_PATH, 'utf8');
            const newConfig = JSON.parse(data);

            // Check if host or port changed to recreate agent
            if (newConfig.warpHost !== config.warpHost || newConfig.warpPort !== config.warpPort || !agent) {
                if (SocksProxyAgent) {
                    console.log(`[WarpHook] Creating SOCKS5 agent for ${newConfig.warpHost}:${newConfig.warpPort}`);
                    agent = new SocksProxyAgent(`socks5h://${newConfig.warpHost}:${newConfig.warpPort}`);
                }
            }

            config = newConfig;
            console.log(`[WarpHook] Configuration loaded: ${config.proxyRules ? config.proxyRules.length : 0} rules.`);
        }
    } catch (err) {
        console.error('[WarpHook] Error loading config:', err.message);
    }
}

// Initial load
loadConfig();

// Watch for changes (from the UI)
try {
    fs.watch(CONFIG_PATH, (eventType) => {
        if (eventType === 'change') {
            console.log('[WarpHook] config.json changed, reloading...');
            // Small delay to ensure file is fully written
            setTimeout(loadConfig, 200);
        }
    });
} catch (err) {
    console.warn('[WarpHook] Could not watch config.json:', err.message);
}

function shouldProxy(url) {
    if (!url || !config.proxyRules) return false;
    const urlStr = url.toString();
    return config.proxyRules.some(rule => {
        if (!rule) return false;
        // Support simple wildcards by converting them to Regex
        if (rule.includes('*')) {
            try {
                // Correct logic: Escape regex special chars, THEN replace escaped asterisks with .*
                // Inclusion of * in the escape set ensures it becomes \*
                const pattern = rule.replace(/[.+*^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
                const regex = new RegExp(pattern, 'i');
                return regex.test(urlStr);
            } catch (e) {
                console.warn('[WarpHook] Invalid wildcard rule:', rule);
                return false;
            }
        }
        // Fallback to simple substring match
        return urlStr.includes(rule);
    });
}

// Intercept fetch
if (global.fetch) {
    const originalFetch = global.fetch;
    global.fetch = async function (url, options = {}) {
        if (shouldProxy(url)) {
            console.log(`[WarpHook] Proxying fetch: ${url}`);
            if (agent) options.agent = agent;
        }
        return originalFetch.call(this, url, options);
    };
}

// Intercept http.request
const originalHttpRequest = http.request;
http.request = function (options, callback) {
    let url = "";
    if (typeof options === 'string') {
        url = options;
    } else {
        const protocol = options.protocol || 'http:';
        const host = options.host || options.hostname || 'localhost';
        const path = options.path || '';
        url = options.href || `${protocol}//${host}${path}`;
    }

    if (shouldProxy(url)) {
        console.log(`[WarpHook] Proxying http: ${url}`);
        if (agent) options.agent = agent;
    }
    return originalHttpRequest.call(http, options, callback);
};

// Intercept https.request
const originalHttpsRequest = https.request;
https.request = function (options, callback) {
    let url = "";
    if (typeof options === 'string') {
        url = options;
    } else {
        const protocol = options.protocol || 'https:';
        const host = options.host || options.hostname || 'localhost';
        const path = options.path || '';
        url = options.href || `${protocol}//${host}${path}`;
    }

    if (shouldProxy(url)) {
        console.log(`[WarpHook] Proxying https: ${url}`);
        if (agent) options.agent = agent;
    }
    return originalHttpsRequest.call(https, options, callback);
};

console.log('[WarpHook] Network interceptor active with dynamic reloading.');
