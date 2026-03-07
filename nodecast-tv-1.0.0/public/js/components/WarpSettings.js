/**
 * Warp Settings Component
 * Handles WARP status and controls in the Settings page
 */

class WarpSettings {
    constructor() {
        this.statusEl = document.getElementById('warp-status-text');
        this.statusDot = document.getElementById('warp-status-dot');
        this.btnSetup = document.getElementById('btn-warp-setup');
        this.btnToggle = document.getElementById('btn-warp-toggle');
        this.registeredInfo = document.getElementById('warp-registered-info');
        this.portInfo = document.getElementById('warp-port-info');

        this.init();
    }

    init() {
        if (!this.btnSetup || !this.btnToggle) return;

        this.btnSetup.addEventListener('click', () => this.handleSetup());
        this.btnToggle.addEventListener('click', () => this.handleToggle());

        // Initial status check
        this.updateStatus();

        // Poll status every 5 seconds when in settings
        this.pollInterval = setInterval(() => {
            if (document.getElementById('tab-settings').classList.contains('active')) {
                this.updateStatus();
            }
        }, 5000);
    }

    async updateStatus() {
        try {
            const status = await API.warp.getStatus();

            // Update UI
            if (this.statusEl) {
                this.statusEl.textContent = status.status.charAt(0).toUpperCase() + status.status.slice(1);
                this.statusDot.className = `status-dot status-${status.status}`;
            }

            if (this.registeredInfo) {
                this.registeredInfo.textContent = status.registered ? 'Registered' : 'Not Registered';
                this.btnSetup.disabled = status.registered;
            }

            if (this.portInfo) {
                this.portInfo.textContent = status.port;
            }

            if (this.btnToggle) {
                this.btnToggle.textContent = status.status === 'connected' ? 'Disconnect' : 'Connect';
                this.btnToggle.disabled = !status.registered;
                this.btnToggle.className = status.status === 'connected' ? 'btn btn-error' : 'btn btn-primary';
            }
        } catch (err) {
            console.error('Failed to update WARP status:', err);
        }
    }

    async handleSetup() {
        if (!confirm('This will register a new WARP account and generate a WireGuard profile. Proceed?')) return;

        try {
            this.btnSetup.disabled = true;
            this.btnSetup.textContent = 'Setting up...';
            const result = await API.warp.setup();
            alert(result.message);
            await this.updateStatus();
        } catch (err) {
            alert('Setup failed: ' + err.message);
        } finally {
            this.btnSetup.disabled = false;
            this.btnSetup.textContent = 'Setup WARP';
        }
    }

    async handleToggle() {
        try {
            const currentStatus = await API.warp.getStatus();
            const action = currentStatus.status === 'connected' ? 'disconnect' : 'connect';

            this.btnToggle.disabled = true;
            this.btnToggle.textContent = action === 'connect' ? 'Connecting...' : 'Disconnecting...';

            await API.warp.toggle(action);

            // Wait a bit and update
            setTimeout(() => this.updateStatus(), 2000);
        } catch (err) {
            alert('Toggle failed: ' + err.message);
        } finally {
            this.btnToggle.disabled = false;
        }
    }
}

window.WarpSettings = WarpSettings;
