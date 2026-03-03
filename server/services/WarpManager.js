const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const util = require('util');
const execPromise = util.promisify(exec);
const https = require('https');
const http = require('http');
const os = require('os');

// Binary download URLs (Linux amd64 — Go static builds, musl-safe)
const WGCF_VERSION = '2.2.22';
const WIREPROXY_VERSION = '1.0.9';

class WarpManager {
    constructor() {
        this.binDir = path.join(process.cwd(), 'bin');
        this.dataDir = path.join(process.cwd(), 'data', 'warp');
        this.wgcfPath = path.join(this.binDir, 'wgcf');
        this.wireproxyPath = path.join(this.binDir, 'wireproxy');
        this.proxyProcess = null;
        this.status = 'disconnected';
        this.proxyPort = 1080;
        this._ready = false;

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        if (!fs.existsSync(this.binDir)) {
            fs.mkdirSync(this.binDir, { recursive: true });
        }
    }

    /**
     * Detect the CPU architecture for download URLs
     */
    getArch() {
        const arch = os.arch();
        if (arch === 'x64' || arch === 'amd64') return 'amd64';
        if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
        return 'amd64'; // fallback
    }

    /**
     * Check if a file is a valid ELF binary (not a text placeholder like "Not Found")
     */
    isValidBinary(filePath) {
        if (!fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        if (stat.size < 1000) return false; // Real binaries are much larger than 1KB
        try {
            const fd = fs.openSync(filePath, 'r');
            const buf = Buffer.alloc(4);
            fs.readSync(fd, buf, 0, 4, 0);
            fs.closeSync(fd);
            // ELF magic: 0x7f 'E' 'L' 'F'
            return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
        } catch {
            return false;
        }
    }

    /**
     * Download a file from URL, following redirects (GitHub uses 302)
     */
    downloadFile(url, destPath) {
        return new Promise((resolve, reject) => {
            const proto = url.startsWith('https') ? https : http;
            proto.get(url, { headers: { 'User-Agent': 'nodecast-tv' } }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return this.downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url}`));
                }
                const file = fs.createWriteStream(destPath);
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
                file.on('error', (err) => {
                    try { fs.unlinkSync(destPath); } catch { }
                    reject(err);
                });
            }).on('error', reject);
        });
    }

    /**
     * Try to install wgcf via apk (Alpine) or download from GitHub
     */
    async installWgcf() {
        const arch = this.getArch();

        // Strategy 1: Try system package manager (Alpine apk — produces musl-compatible binary)
        try {
            console.log('[WARP] Trying to install wgcf via apk...');
            await execPromise('apk add --no-cache wgcf --repository=https://dl-cdn.alpinelinux.org/alpine/edge/testing', { timeout: 30000 });
            // Check if apk installed it to system path
            const { stdout } = await execPromise('which wgcf');
            const systemPath = stdout.trim();
            if (systemPath && fs.existsSync(systemPath)) {
                // Symlink to our bin dir so we don't lose track of it
                try { fs.unlinkSync(this.wgcfPath); } catch { }
                fs.symlinkSync(systemPath, this.wgcfPath);
                console.log(`[WARP] wgcf installed via apk: ${systemPath}`);
                return true;
            }
        } catch (e) {
            console.log(`[WARP] apk install failed (${e.message}), falling back to GitHub download...`);
        }

        // Strategy 2: Download from GitHub (works for glibc distros)
        const url = `https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}/wgcf_${WGCF_VERSION}_linux_${arch}`;
        console.log(`[WARP] Downloading wgcf from ${url}...`);
        await this.downloadFile(url, this.wgcfPath);
        fs.chmodSync(this.wgcfPath, 0o755);

        // Verify the downloaded binary actually works
        try {
            await execPromise(`${this.wgcfPath} --version`, { timeout: 5000 });
            console.log('[WARP] wgcf downloaded and verified successfully.');
            return true;
        } catch (verifyErr) {
            // Binary doesn't run (musl/glibc incompatibility)
            console.error(`[WARP] Downloaded wgcf binary failed to execute: ${verifyErr.message}`);
            try { fs.unlinkSync(this.wgcfPath); } catch { }
            throw new Error('wgcf binary is incompatible with this system. Install gcompat: apk add gcompat');
        }
    }

    /**
     * Install wireproxy from GitHub
     */
    async installWireproxy() {
        const arch = this.getArch();
        const url = `https://github.com/pufferffish/wireproxy/releases/download/v${WIREPROXY_VERSION}/wireproxy_linux_${arch}.tar.gz`;
        const tarPath = path.join(this.binDir, 'wireproxy.tar.gz');

        console.log(`[WARP] Downloading wireproxy from ${url}...`);
        await this.downloadFile(url, tarPath);

        // Extract the binary from the tarball
        await execPromise(`tar xzf "${tarPath}" -C "${this.binDir}"`, { cwd: this.binDir });
        fs.chmodSync(this.wireproxyPath, 0o755);

        // Clean up tarball
        try { fs.unlinkSync(tarPath); } catch { }

        // Verify
        try {
            await execPromise(`${this.wireproxyPath} --version`, { timeout: 5000 });
            console.log('[WARP] wireproxy downloaded and verified.');
        } catch (verifyErr) {
            console.error(`[WARP] wireproxy binary failed to execute: ${verifyErr.message}`);
            try { fs.unlinkSync(this.wireproxyPath); } catch { }
            throw new Error('wireproxy binary is incompatible with this system.');
        }
    }

    /**
     * Ensure binaries exist and are valid. Auto-download if corrupted/missing.
     */
    async ensureBinaries() {
        if (this._ready) return;

        // Check wgcf
        if (!this.isValidBinary(this.wgcfPath)) {
            // Also check if it's a symlink to a system binary
            const isSymlink = fs.existsSync(this.wgcfPath) && fs.lstatSync(this.wgcfPath).isSymbolicLink();
            if (!isSymlink) {
                console.log('[WARP] wgcf binary missing or corrupted, installing...');
                await this.installWgcf();
            }
        } else {
            try { fs.chmodSync(this.wgcfPath, 0o755); } catch { }
        }

        // Check wireproxy
        if (!this.isValidBinary(this.wireproxyPath)) {
            console.log('[WARP] wireproxy binary missing or corrupted, installing...');
            await this.installWireproxy();
        } else {
            try { fs.chmodSync(this.wireproxyPath, 0o755); } catch { }
        }

        this._ready = true;
        console.log('[WARP] All binaries ready.');
    }

    async register() {
        try {
            await this.ensureBinaries();
            console.log('[WARP] Registering WARP account...');

            // wgcf uses CWD for output files, so we run from dataDir
            const env = { ...process.env };

            // Register
            const { stdout: regOut, stderr: regErr } = await execPromise(
                `${this.wgcfPath} register --accept-tos`,
                { cwd: this.dataDir, env, timeout: 30000 }
            );
            if (regOut) console.log('[WARP] register stdout:', regOut.trim());
            if (regErr) console.log('[WARP] register stderr:', regErr.trim());

            // Generate WireGuard profile
            const { stdout: genOut, stderr: genErr } = await execPromise(
                `${this.wgcfPath} generate`,
                { cwd: this.dataDir, env, timeout: 15000 }
            );
            if (genOut) console.log('[WARP] generate stdout:', genOut.trim());
            if (genErr) console.log('[WARP] generate stderr:', genErr.trim());

            // Verify the profile was generated
            const profilePath = path.join(this.dataDir, 'wgcf-profile.conf');
            if (!fs.existsSync(profilePath)) {
                throw new Error('Profile file was not generated. Check wgcf output above.');
            }

            console.log('[WARP] Registration complete. Profile generated.');
            return true;
        } catch (err) {
            console.error('[WARP] Registration failed:', err.message);
            throw err;
        }
    }

    async startProxy() {
        if (this.proxyProcess) {
            console.log('[WARP] Proxy already running.');
            return;
        }

        await this.ensureBinaries();

        const confPath = path.join(this.dataDir, 'wgcf-profile.conf');
        if (!fs.existsSync(confPath)) {
            await this.register();
        }

        // Build wireproxy configuration
        const wireproxyConfPath = path.join(this.dataDir, 'wireproxy.conf');
        const privateKey = this.extractFromConf(confPath, 'PrivateKey');
        const address = this.extractFromConf(confPath, 'Address');
        const publicKey = this.extractFromConf(confPath, 'PublicKey');

        if (!privateKey || !publicKey) {
            throw new Error('Failed to extract keys from wgcf profile. Try re-registering.');
        }

        const wireproxyConf = [
            '[Interface]',
            `PrivateKey = ${privateKey}`,
            `Address = ${address}`,
            'DNS = 1.1.1.1',
            '',
            '[Peer]',
            `PublicKey = ${publicKey}`,
            'Endpoint = engage.cloudflareclient.com:2408',
            '',
            '[Socks5]',
            `BindAddress = 127.0.0.1:${this.proxyPort}`
        ].join('\n');

        fs.writeFileSync(wireproxyConfPath, wireproxyConf);

        console.log(`[WARP] Starting wireproxy on port ${this.proxyPort}...`);

        return new Promise((resolve, reject) => {
            this.proxyProcess = spawn(this.wireproxyPath, ['-c', wireproxyConfPath], {
                cwd: this.dataDir
            });

            const startTimeout = setTimeout(() => {
                // If we haven't connected after 15s, consider it started anyway
                // (wireproxy may not output the exact string we're looking for)
                if (this.status !== 'connected') {
                    this.status = 'connecting';
                    console.log('[WARP] Proxy started (status uncertain, check port manually).');
                }
                resolve();
            }, 15000);

            // wireproxy logs to BOTH stdout and stderr
            const handleOutput = (data) => {
                const text = data.toString();
                console.log(`[WARP] wireproxy: ${text.trim()}`);

                if (text.includes('Socks5') || text.includes('socks5') || text.includes('listening') || text.includes('now Up')) {
                    this.status = 'connected';
                    console.log('[WARP] Proxy connected successfully.');
                    clearTimeout(startTimeout);
                    resolve();
                }
                if (text.includes('error') || text.includes('Error') || text.includes('fatal')) {
                    console.error('[WARP] wireproxy error output:', text.trim());
                }
            };

            this.proxyProcess.stdout.on('data', handleOutput);
            this.proxyProcess.stderr.on('data', handleOutput);

            this.proxyProcess.on('exit', (code) => {
                console.log(`[WARP] Proxy exited with code ${code}`);
                this.proxyProcess = null;
                this.status = 'disconnected';
                clearTimeout(startTimeout);
                if (code !== 0 && code !== null) {
                    reject(new Error(`wireproxy exited with code ${code}`));
                }
            });

            this.proxyProcess.on('error', (err) => {
                console.error('[WARP] Proxy spawn error:', err.message);
                this.status = 'error';
                clearTimeout(startTimeout);
                reject(err);
            });
        });
    }

    stopProxy() {
        if (this.proxyProcess) {
            this.proxyProcess.kill('SIGTERM');
            this.proxyProcess = null;
            this.status = 'disconnected';
            console.log('[WARP] Proxy stopped.');
        }
    }

    getStatus() {
        const identityPath = path.join(this.dataDir, 'wgcf-account.toml');
        const identityPathAlt = path.join(this.dataDir, 'wgcf-identity.json');
        const registered = fs.existsSync(identityPath) || fs.existsSync(identityPathAlt);
        return {
            status: this.status,
            registered: registered,
            port: this.proxyPort
        };
    }

    extractFromConf(filePath, key) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const regex = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm');
            const match = content.match(regex);
            return match ? match[1].trim() : '';
        } catch (err) {
            console.error(`[WARP] Failed to read ${filePath}:`, err.message);
            return '';
        }
    }
}

module.exports = new WarpManager();
