const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const util = require('util');
const execPromise = util.promisify(exec);

class WarpManager {
    constructor() {
        this.binDir = path.join(process.cwd(), 'bin');
        this.dataDir = path.join(process.cwd(), 'data', 'warp');
        this.wgcfPath = path.join(this.binDir, 'wgcf');
        this.wireproxyPath = path.join(this.binDir, 'wireproxy');
        this.proxyProcess = null;
        this.status = 'disconnected';
        this.proxyPort = 1080;

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    async register() {
        try {
            console.log('Registering WARP account...');
            // Set workdir for wgcf
            const env = { ...process.env, WGCF_CONFIG: path.join(this.dataDir, 'wgcf-config.toml') };

            // Register
            await execPromise(`${this.wgcfPath} register --accept-tos`, { cwd: this.dataDir, env });

            // Generate profile
            await execPromise(`${this.wgcfPath} generate`, { cwd: this.dataDir, env });

            console.log('WARP alignment complete. Profile generated.');
            return true;
        } catch (err) {
            console.error('WARP registration failed:', err);
            throw err;
        }
    }

    async startProxy() {
        if (this.proxyProcess) {
            console.log('WARP proxy already running.');
            return;
        }

        const confPath = path.join(this.dataDir, 'wgcf-profile.conf');
        if (!fs.existsSync(confPath)) {
            await this.register();
        }

        // Create wireproxy config
        const wireproxyConfPath = path.join(this.dataDir, 'wireproxy.conf');
        const wireproxyConf = `
[Interface]
PrivateKey = ${this.extractFromConf(confPath, 'PrivateKey')}
Address = ${this.extractFromConf(confPath, 'Address')}
DNS = 1.1.1.1

[Peer]
PublicKey = ${this.extractFromConf(confPath, 'PublicKey')}
Endpoint = engage.cloudflareclient.com:2408

[Socks5]
BindAddress = 127.0.0.1:${this.proxyPort}
        `.trim();

        fs.writeFileSync(wireproxyConfPath, wireproxyConf);

        console.log(`Starting wireproxy on port ${this.proxyPort}...`);
        this.proxyProcess = spawn(this.wireproxyPath, ['-c', wireproxyConfPath], {
            cwd: this.dataDir
        });

        this.proxyProcess.stdout.on('data', (data) => {
            if (data.toString().includes('Socks5 server started')) {
                this.status = 'connected';
                console.log('WARP Proxy connected.');
            }
        });

        this.proxyProcess.on('exit', (code) => {
            console.log(`WARP Proxy exited with code ${code}`);
            this.proxyProcess = null;
            this.status = 'disconnected';
        });

        this.proxyProcess.on('error', (err) => {
            console.error('WARP Proxy error:', err);
            this.status = 'error';
        });
    }

    stopProxy() {
        if (this.proxyProcess) {
            this.proxyProcess.kill();
            this.proxyProcess = null;
            this.status = 'disconnected';
            console.log('WARP Proxy stopped.');
        }
    }

    getStatus() {
        const registered = fs.existsSync(path.join(this.dataDir, 'wgcf-identity.json'));
        return {
            status: this.status,
            registered: registered,
            port: this.proxyPort
        };
    }

    extractFromConf(filePath, key) {
        const content = fs.readFileSync(filePath, 'utf8');
        const regex = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm');
        const match = content.match(regex);
        return match ? match[1].trim() : '';
    }
}

module.exports = new WarpManager();
