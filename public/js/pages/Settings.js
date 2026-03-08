/**
 * Settings Page Controller
 */

class SettingsPage {
    constructor(app) {
        this.app = app;
        this.tabs = document.querySelectorAll('.tabs .tab');
        this.tabContents = document.querySelectorAll('.tab-content');

        this.init();
    }

    init() {
        // Tab switching
        this.tabs.forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Player settings
        this.initPlayerSettings();

        // Transcoding settings
        this.initTranscodingSettings();

        // User management (admin only)
        this.initUserManagement();

        // Scraper management (admin only)
        this.initScraperManagement();
    }

    initPlayerSettings() {
        const arrowKeysToggle = document.getElementById('setting-arrow-keys');
        const overlayDurationInput = document.getElementById('setting-overlay-duration');
        const defaultVolumeSlider = document.getElementById('setting-default-volume');
        const volumeValueDisplay = document.getElementById('volume-value');
        const rememberVolumeToggle = document.getElementById('setting-remember-volume');
        const autoPlayNextToggle = document.getElementById('setting-autoplay-next');

        // Load current settings
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
            overlayDurationInput.value = this.app.player.settings.overlayDuration;
            defaultVolumeSlider.value = this.app.player.settings.defaultVolume;
            volumeValueDisplay.textContent = this.app.player.settings.defaultVolume + '%';
            rememberVolumeToggle.checked = this.app.player.settings.rememberVolume;
            autoPlayNextToggle.checked = this.app.player.settings.autoPlayNextEpisode;
        }

        // Arrow keys toggle
        arrowKeysToggle.addEventListener('change', () => {
            this.app.player.settings.arrowKeysChangeChannel = arrowKeysToggle.checked;
            this.app.player.saveSettings();
        });

        // Overlay duration
        overlayDurationInput.addEventListener('change', () => {
            this.app.player.settings.overlayDuration = parseInt(overlayDurationInput.value) || 5;
            this.app.player.saveSettings();
        });

        // Default volume slider
        defaultVolumeSlider.addEventListener('input', () => {
            const value = defaultVolumeSlider.value;
            volumeValueDisplay.textContent = value + '%';
            this.app.player.settings.defaultVolume = parseInt(value);
            this.app.player.saveSettings();
        });

        // Remember volume toggle
        rememberVolumeToggle.addEventListener('change', () => {
            this.app.player.settings.rememberVolume = rememberVolumeToggle.checked;
            this.app.player.saveSettings();
        });

        // Auto-play next episode toggle
        autoPlayNextToggle.addEventListener('change', () => {
            this.app.player.settings.autoPlayNextEpisode = autoPlayNextToggle.checked;
            this.app.player.saveSettings();
        });

        // EPG refresh interval
        const epgRefreshSelect = document.getElementById('epg-refresh-interval');
        if (epgRefreshSelect && this.app.player?.settings) {
            // Load saved value from player settings
            epgRefreshSelect.value = this.app.player.settings.epgRefreshInterval || '24';

            // Save on change - server will restart its sync timer via PUT /api/settings
            epgRefreshSelect.addEventListener('change', () => {
                this.app.player.settings.epgRefreshInterval = epgRefreshSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Update last refreshed display
        this.updateEpgLastRefreshed();
    }

    async initTranscodingSettings() {
        // Encoder settings
        const hwEncoderSelect = document.getElementById('setting-hw-encoder');
        const maxResolutionSelect = document.getElementById('setting-max-resolution');
        const qualitySelect = document.getElementById('setting-quality');

        // Stream processing (use -tc suffix IDs from Transcoding tab)
        const forceProxyToggle = document.getElementById('setting-force-proxy-tc');
        const autoTranscodeToggle = document.getElementById('setting-auto-transcode-tc');
        const forceTranscodeToggle = document.getElementById('setting-force-transcode-tc');
        const forceVideoTranscodeToggle = document.getElementById('setting-force-video-transcode-tc');
        const forceRemuxToggle = document.getElementById('setting-force-remux-tc');
        const streamFormatSelect = document.getElementById('setting-stream-format-tc');
        const warpProxyUrlInput = document.getElementById('setting-warp-proxy-url');
        const testWarpBtn = document.getElementById('test-warp-btn');
        const setupWarpBtn = document.getElementById('setup-warp-btn');
        const viewWarpLogsBtn = document.getElementById('view-warp-logs-btn');
        const closeWarpLogsBtn = document.getElementById('close-warp-logs');
        const warpLogsWrapper = document.getElementById('warp-logs-wrapper');
        const warpLogsContainer = document.getElementById('warp-logs');

        // User-Agent (Transcoding tab versions)
        const userAgentSelect = document.getElementById('setting-user-agent-tc');
        const userAgentCustomInput = document.getElementById('setting-user-agent-custom-tc');
        const customUaContainer = document.getElementById('custom-user-agent-container-tc');

        // Fetch settings directly from API to avoid race condition with VideoPlayer
        let s;
        try {
            s = await API.settings.get();
        } catch (err) {
            console.warn('[Settings] Failed to load settings from API, using player defaults:', err);
            s = this.app.player?.settings || {};
        }

        if (hwEncoderSelect) hwEncoderSelect.value = s.hwEncoder || 'auto';
        if (maxResolutionSelect) maxResolutionSelect.value = s.maxResolution || '1080p';
        if (qualitySelect) qualitySelect.value = s.quality || 'medium';
        if (forceProxyToggle) forceProxyToggle.checked = s.forceProxy === true;
        if (autoTranscodeToggle) autoTranscodeToggle.checked = s.autoTranscode !== false;
        if (forceTranscodeToggle) forceTranscodeToggle.checked = s.forceTranscode === true;
        if (forceVideoTranscodeToggle) forceVideoTranscodeToggle.checked = s.forceVideoTranscode === true;
        if (forceRemuxToggle) forceRemuxToggle.checked = s.forceRemux || false;
        if (streamFormatSelect) streamFormatSelect.value = s.streamFormat || 'm3u8';
        if (userAgentSelect) userAgentSelect.value = s.userAgentPreset || 'chrome';
        if (userAgentCustomInput) userAgentCustomInput.value = s.userAgentCustom || '';
        if (customUaContainer) {
            customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
        }
        if (warpProxyUrlInput) warpProxyUrlInput.value = s.warpProxyUrl || '';

        // Event listeners for encoder settings
        hwEncoderSelect?.addEventListener('change', () => {
            this.app.player.settings.hwEncoder = hwEncoderSelect.value;
            this.app.player.saveSettings();
        });

        maxResolutionSelect?.addEventListener('change', () => {
            this.app.player.settings.maxResolution = maxResolutionSelect.value;
            this.app.player.saveSettings();
        });

        qualitySelect?.addEventListener('change', () => {
            this.app.player.settings.quality = qualitySelect.value;
            this.app.player.saveSettings();
        });

        // Audio Mix Preset
        const audioMixSelect = document.getElementById('setting-audio-mix');
        if (audioMixSelect) {
            audioMixSelect.value = s.audioMixPreset || 'auto';
            audioMixSelect.addEventListener('change', () => {
                this.app.player.settings.audioMixPreset = audioMixSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Upscaling Settings
        const upscaleEnabledToggle = document.getElementById('setting-upscale-enabled');
        const upscaleMethodSelect = document.getElementById('setting-upscale-method');
        const upscaleTargetSelect = document.getElementById('setting-upscale-target');
        const upscaleMethodContainer = document.getElementById('upscale-method-container');
        const upscaleTargetContainer = document.getElementById('upscale-target-container');

        // Helper to toggle upscale options visibility
        const toggleUpscaleOptions = (enabled) => {
            if (upscaleMethodContainer) upscaleMethodContainer.style.display = enabled ? 'flex' : 'none';
            if (upscaleTargetContainer) upscaleTargetContainer.style.display = enabled ? 'flex' : 'none';
        };

        // Load upscaling settings
        if (upscaleEnabledToggle) {
            upscaleEnabledToggle.checked = s.upscaleEnabled || false;
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        }
        if (upscaleMethodSelect) upscaleMethodSelect.value = s.upscaleMethod || 'hardware';
        if (upscaleTargetSelect) upscaleTargetSelect.value = s.upscaleTarget || '1080p';

        // Upscaling event handlers
        upscaleEnabledToggle?.addEventListener('change', () => {
            this.app.player.settings.upscaleEnabled = upscaleEnabledToggle.checked;
            this.app.player.saveSettings();
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        });

        upscaleMethodSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleMethod = upscaleMethodSelect.value;
            this.app.player.saveSettings();
        });

        upscaleTargetSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleTarget = upscaleTargetSelect.value;
            this.app.player.saveSettings();
        });

        // Stream processing toggles
        forceProxyToggle?.addEventListener('change', () => {
            this.app.player.settings.forceProxy = forceProxyToggle.checked;
            this.app.player.saveSettings();
        });

        autoTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.autoTranscode = autoTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.forceTranscode = forceTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceVideoTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.forceVideoTranscode = forceVideoTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceRemuxToggle?.addEventListener('change', () => {
            this.app.player.settings.forceRemux = forceRemuxToggle.checked;
            this.app.player.saveSettings();
        });

        streamFormatSelect?.addEventListener('change', () => {
            this.app.player.settings.streamFormat = streamFormatSelect.value;
            this.app.player.saveSettings();
        });

        warpProxyUrlInput?.addEventListener('change', () => {
            this.app.player.settings.warpProxyUrl = warpProxyUrlInput.value;
            this.app.player.saveSettings();
        });

        testWarpBtn?.addEventListener('click', async () => {
            const url = warpProxyUrlInput?.value;
            if (!url) {
                alert('Please enter a proxy URL first');
                return;
            }

            testWarpBtn.disabled = true;
            testWarpBtn.textContent = 'Testing...';

            try {
                const result = await API.settings.testWarp(url);
                if (result.success) {
                    alert(`Warp connection successful!\nStatus: ${result.status}\nDuration: ${result.duration}ms`);
                } else {
                    alert(`Warp connection failed: ${result.error}`);
                }
            } catch (err) {
                alert(`Error testing Warp: ${err.message}`);
            } finally {
                testWarpBtn.disabled = false;
                testWarpBtn.textContent = 'Test';
                this.updateWarpStatus();
            }
        });

        setupWarpBtn?.addEventListener('click', async () => {
            if (!confirm('This will attempt to configure Warp for Proxy Mode on port 40001. Proceed?')) {
                return;
            }

            setupWarpBtn.disabled = true;
            setupWarpBtn.textContent = 'Configuring...';

            try {
                const result = await API.settings.setupWarp();
                if (result.success) {
                    alert('Warp setup successful!\n\n' + result.message);
                    // Update the URL input if it was empty
                    if (!warpProxyUrlInput.value) {
                        warpProxyUrlInput.value = 'socks5://127.0.0.1:40001';
                        this.app.player.settings.warpProxyUrl = 'socks5://127.0.0.1:40001';
                        this.app.player.saveSettings();
                    }
                } else {
                    alert('Warp setup failed: ' + result.error);
                }
            } catch (err) {
                alert('Error during Warp setup: ' + err.message);
            } finally {
                setupWarpBtn.disabled = false;
                setupWarpBtn.textContent = 'Setup / Fix Warp';
                this.updateWarpStatus();
            }
        });

        viewWarpLogsBtn?.addEventListener('click', async () => {
            if (warpLogsWrapper) {
                warpLogsWrapper.style.display = 'block';
                if (warpLogsContainer) warpLogsContainer.textContent = 'Fetching logs...';

                try {
                    const result = await API.settings.getWarpLogs();
                    if (warpLogsContainer) {
                        warpLogsContainer.textContent = result.logs || 'No logs available.';
                        // Scroll to bottom
                        warpLogsContainer.scrollTop = warpLogsContainer.scrollHeight;
                    }
                } catch (err) {
                    if (warpLogsContainer) warpLogsContainer.textContent = 'Error fetching logs: ' + err.message;
                }
            }
        });

        closeWarpLogsBtn?.addEventListener('click', () => {
            if (warpLogsWrapper) warpLogsWrapper.style.display = 'none';
        });

        // Initialize status check
        this.updateWarpStatus();

        // User-Agent handlers
        const toggleCustomInput = () => {
            if (customUaContainer) {
                customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
            }
        };

        userAgentSelect?.addEventListener('change', () => {
            this.app.player.settings.userAgentPreset = userAgentSelect.value;
            this.app.player.saveSettings();
            toggleCustomInput();
        });

        userAgentCustomInput?.addEventListener('change', () => {
            this.app.player.settings.userAgentCustom = userAgentCustomInput.value;
            this.app.player.saveSettings();
        });
    }

    /**
     * Check local Warp service status
     */
    async updateWarpStatus() {
        const container = document.getElementById('warp-status-container');
        const text = document.getElementById('warp-status-text');
        const badge = document.getElementById('warp-status-badge');

        if (!container || !text || !badge) return;

        try {
            const status = await API.settings.getWarpStatus();
            container.style.display = 'flex';

            if (!status.installed) {
                text.textContent = 'Warp not detected (neither CLI nor Docker).';
                badge.textContent = 'NOT FOUND';
                badge.className = 'badge badge-error';
                return;
            }

            const methodStr = status.method === 'docker' ? '[Docker]' : '[CLI]';
            text.textContent = `${methodStr} Mode: ${status.mode} | Port: ${status.port} | Status: ${status.status}`;

            const isOk = status.status.includes('Connected') || status.status.includes('Running');
            badge.textContent = status.status.toUpperCase();
            badge.className = isOk ? 'badge badge-success' : 'badge badge-warning';

        } catch (err) {
            console.warn('[Settings] Failed to fetch Warp status:', err);
            container.style.display = 'none';
        }
    }

    /**
     * Load and display hardware info in Transcoding tab
     */
    async loadHardwareInfo() {
        const container = document.getElementById('hw-info-container');
        if (!container) return;

        try {
            const response = await fetch('/api/settings/hw-info');
            if (!response.ok) throw new Error('Failed to fetch hardware info');
            const hwInfo = await response.json();

            const detected = [];

            // Only show detected hardware
            if (hwInfo.nvidia?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ NVIDIA</span>
                    <span class="hw-name">${hwInfo.nvidia.name}</span>
                </div>`);
            }

            if (hwInfo.amf?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ AMD</span>
                    <span class="hw-name">${hwInfo.amf.name || 'Available'}</span>
                </div>`);
            }

            if (hwInfo.qsv?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ Intel QSV</span>
                    <span class="hw-name">Available</span>
                </div>`);
            }

            if (hwInfo.vaapi?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ VAAPI</span>
                    <span class="hw-name">${hwInfo.vaapi.device || 'Available'}</span>
                </div>`);
            }

            let html;
            if (detected.length > 0) {
                html = `<div class="hw-info-grid">${detected.join('')}</div>`;
                html += `<p class="hint" style="margin-top: var(--space-sm);">Recommended encoder: <strong>${hwInfo.recommended}</strong></p>`;
            } else {
                html = `<p class="hint">No GPU acceleration detected. Using software encoding.</p>`;
            }

            container.innerHTML = html;
        } catch (err) {
            console.error('Error loading hardware info:', err);
            container.innerHTML = '<p class="hint error">Failed to load hardware info</p>';
        }
    }

    initUserManagement() {
        // User tab visibility is handled in show() method
        // when currentUser is available

        // Handle add user form
        const addUserForm = document.getElementById('add-user-form');
        if (addUserForm) {
            addUserForm.addEventListener('submit', async (e) => {
                e.preventDefault();

                const username = document.getElementById('new-username').value;
                const password = document.getElementById('new-password').value;
                const role = document.getElementById('new-role').value;

                try {
                    await API.users.create({ username, password, role });
                    alert('User created successfully!');
                    addUserForm.reset();
                    this.loadUsers();
                } catch (err) {
                    alert('Error creating user: ' + err.message);
                }
            });
        }
    }

    async loadUsers() {
        const userList = document.getElementById('user-list');
        if (!userList) return;

        try {
            const users = await API.users.getAll();
            // Store users in memory for easy access during edit
            this.users = users;

            if (users.length === 0) {
                userList.innerHTML = '<tr><td colspan="5" class="hint">No users found</td></tr>';
                return;
            }

            userList.innerHTML = users.map(user => {
                const isSSO = !!user.oidcId;
                const typeBadge = isSSO
                    ? '<span class="user-badge user-badge-sso">SSO</span>'
                    : '<span class="user-badge user-badge-local">Local</span>';

                const roleBadge = user.role === 'admin'
                    ? '<span class="user-badge user-badge-admin">Admin</span>'
                    : '<span class="user-badge user-badge-viewer">Viewer</span>';

                return `
                <tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <strong>${user.username}</strong>
                            ${typeBadge}
                        </div>
                    </td>
                    <td>${user.email || '<span class="hint">-</span>'}</td>
                    <td>${roleBadge}</td>
                    <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" onclick="window.app.pages.settings.openEditUserModal(${user.id})">Edit</button>
                        <button class="btn btn-sm btn-error" onclick="window.app.pages.settings.deleteUser(${user.id}, '${user.username}')">Delete</button>
                    </td>
                </tr>
            `}).join('');
        } catch (err) {
            console.error('Error loading users:', err);
            userList.innerHTML = '<tr><td colspan="5" class="hint">Error loading users</td></tr>';
        }
    }

    openEditUserModal(userId) {
        console.log('openEditUserModal called with ID:', userId, 'Type:', typeof userId);
        console.log('Current users list:', this.users);

        const user = this.users.find(u => u.id === userId);
        if (!user) {
            console.error('User not found in this.users cache!');
            console.log('Available IDs:', this.users.map(u => u.id));
            return;
        }
        console.log('User found:', user);

        const modal = document.getElementById('edit-user-modal');
        console.log('Modal element:', modal);
        if (!modal) {
            console.error('CRITICAL: Modal element #edit-user-modal not found in DOM!');
            alert('Error: Modal not found. Please refresh the page.');
            return;
        }

        const isSSO = !!user.oidcId;
        console.log('Is SSO user:', isSSO);

        // Populate form with null checks
        try {
            const editId = document.getElementById('edit-user-id');
            const editUsername = document.getElementById('edit-username');
            const editEmail = document.getElementById('edit-email');
            const editRole = document.getElementById('edit-role');
            const editPassword = document.getElementById('edit-password');

            console.log('Form elements found:', { editId, editUsername, editEmail, editRole, editPassword });

            if (editId) editId.value = user.id;
            if (editUsername) editUsername.value = user.username;
            if (editEmail) editEmail.value = user.email || '';
            if (editRole) editRole.value = user.role;
            if (editPassword) editPassword.value = '';

            // Handle SSO specific UI
            const passwordHint = document.getElementById('edit-password-hint');
            const oidcGroup = document.getElementById('oidc-info-group');
            const oidcIdDisplay = document.getElementById('edit-oidc-id');

            if (isSSO) {
                if (editPassword) {
                    editPassword.disabled = true;
                    editPassword.placeholder = "Managed by SSO Provider";
                }
                if (passwordHint) passwordHint.textContent = "Password cannot be changed for SSO users.";
                if (oidcGroup) oidcGroup.classList.remove('hidden');
                if (oidcIdDisplay) oidcIdDisplay.textContent = user.oidcId;
            } else {
                if (editPassword) {
                    editPassword.disabled = false;
                    editPassword.placeholder = "Leave blank to keep current";
                }
                if (passwordHint) passwordHint.textContent = "Optional. Leave blank to keep unchanged.";
                if (oidcGroup) oidcGroup.classList.add('hidden');
            }

            // Show modal
            console.log('Adding active class to modal...');
            modal.classList.add('active');
            console.log('Modal classes after add:', modal.classList.toString());

            // Setup Close/Cancel handlers (once)
            this.setupModalHandlers(modal);
            console.log('Modal should now be visible!');
        } catch (err) {
            console.error('Error populating modal:', err);
            alert('Error opening edit modal: ' + err.message);
        }
    }

    setupModalHandlers(modal) {
        if (this.modalHandlersSetup) return;

        const closeBtn = document.getElementById('edit-user-close');
        const cancelBtn = document.getElementById('edit-user-cancel');
        const saveBtn = document.getElementById('edit-user-save');

        const closeModal = () => modal.classList.remove('active');

        closeBtn.onclick = closeModal;
        cancelBtn.onclick = closeModal;

        // Click outside to close
        modal.onclick = (e) => {
            if (e.target === modal) closeModal();
        };

        // Save Handler
        saveBtn.onclick = async () => {
            const userId = document.getElementById('edit-user-id').value;
            const updates = {
                username: document.getElementById('edit-username').value,
                role: document.getElementById('edit-role').value
            };

            const newPassword = document.getElementById('edit-password').value;
            if (newPassword && !document.getElementById('edit-password').disabled) {
                updates.password = newPassword;
            }

            try {
                await API.users.update(userId, updates);
                // alert('User updated successfully!'); // Optional: Replace with toast?
                closeModal();
                this.loadUsers();
            } catch (err) {
                alert('Error updating user: ' + err.message);
            }
        };

        this.modalHandlersSetup = true;
    }


    async deleteUser(userId, username) {
        if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
            return;
        }

        try {
            await API.users.delete(userId);
            this.loadUsers();
        } catch (err) {
            alert('Error deleting user: ' + err.message);
        }
    }

    initScraperManagement() {
        const runBtn = document.getElementById('run-scraper');
        const clearLogsBtn = document.getElementById('clear-scraper-logs');
        const saveSettingsBtn = document.getElementById('save-scraper-settings');
        const autoRunToggle = document.getElementById('setting-scraper-auto-run');
        const intervalContainer = document.getElementById('scraper-interval-container');

        if (runBtn) {
            runBtn.addEventListener('click', () => this.runScraper());
        }

        if (clearLogsBtn) {
            clearLogsBtn.addEventListener('click', () => this.clearLogs());
        }

        if (saveSettingsBtn) {
            saveSettingsBtn.addEventListener('click', () => this.saveScraperSettings());
        }

        if (autoRunToggle && intervalContainer) {
            autoRunToggle.addEventListener('change', () => {
                intervalContainer.style.display = autoRunToggle.checked ? 'flex' : 'none';
            });
        }
    }

    async saveScraperSettings() {
        const autoRunToggle = document.getElementById('setting-scraper-auto-run');
        const intervalSelect = document.getElementById('setting-scraper-interval');
        const saveBtn = document.getElementById('save-scraper-settings');

        if (!autoRunToggle || !intervalSelect) return;

        if (saveBtn) saveBtn.disabled = true;

        try {
            await API.scraper.updateSettings({
                scraperAutoRun: autoRunToggle.checked,
                scraperInterval: intervalSelect.value
            });
            this.appendLog('Scraper settings updated successfully.');
            // Refresh status to show updated auto-run info
            this.loadScraperStatus();
        } catch (err) {
            this.appendLog('Error saving scraper settings: ' + err.message);
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    async runScraper() {
        const runBtn = document.getElementById('run-scraper');
        if (runBtn) runBtn.disabled = true;

        try {
            await API.scraper.run();
            this.appendLog('Scraper started...');
            this.loadScraperStatus();
        } catch (err) {
            this.appendLog('Error starting scraper: ' + err.message);
            if (runBtn) runBtn.disabled = false;
        }
    }

    async loadScraperStatus() {
        try {
            const status = await API.scraper.getStatus();
            const statusText = document.getElementById('scraper-status-text');
            const spinner = document.getElementById('scraper-loading-spinner');
            const runBtn = document.getElementById('run-scraper');
            const fileInfoContainer = document.getElementById('scraper-file-info');

            if (statusText) {
                statusText.textContent = status.isRunning ? 'Running' : 'Idle';
                statusText.style.color = status.isRunning ? 'var(--color-accent)' : 'var(--color-text-secondary)';
            }

            if (spinner) {
                spinner.style.display = status.isRunning ? 'block' : 'none';
            }

            if (runBtn) {
                runBtn.disabled = status.isRunning;
            }

            // Display file info
            const fileDetails = document.getElementById('scraper-file-details');
            if (fileDetails && status.fileInfo) {
                if (status.fileInfo.exists) {
                    const sizeKB = (status.fileInfo.size / 1024).toFixed(1);
                    const lastUpdated = new Date(status.fileInfo.mtime).toLocaleString();
                    fileDetails.innerHTML = `
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                            <div style="display: flex; justify-content: space-between;">
                                <span class="hint">Output File:</span>
                                <span style="font-weight: 500; font-family: monospace;">thisnotbusiness.m3u</span>
                            </div>
                            <div style="display: flex; justify-content: space-between;">
                                <span class="hint">File Size:</span>
                                <span style="font-weight: 500;">${sizeKB} KB</span>
                            </div>
                            <div style="display: flex; justify-content: space-between;">
                                <span class="hint">Last Modified:</span>
                                <span style="font-weight: 500;">${lastUpdated}</span>
                            </div>
                        </div>
                    `;
                    fileInfoContainer.style.display = 'block';
                } else {
                    fileDetails.innerHTML = '<p class="hint">Output file does not exist yet.</p>';
                    fileInfoContainer.style.display = 'block';
                    const actions = document.getElementById('scraper-file-actions');
                    if (actions) actions.style.display = 'none';
                }
            }

            // Display Cron/Auto-run info
            const cronInfo = document.getElementById('scraper-cron-info');
            if (cronInfo && status.autoRunInfo) {
                const info = status.autoRunInfo;

                // Update settings UI if not already initialized
                const autoRunToggle = document.getElementById('setting-scraper-auto-run');
                const intervalSelect = document.getElementById('setting-scraper-interval');
                const intervalContainer = document.getElementById('scraper-interval-container');

                if (autoRunToggle && !this._scraperSettingsInitialized) {
                    autoRunToggle.checked = info.enabled;
                    if (intervalSelect) intervalSelect.value = String(info.intervalHours);
                    if (intervalContainer) intervalContainer.style.display = info.enabled ? 'flex' : 'none';
                    this._scraperSettingsInitialized = true;
                }

                if (info.enabled) {
                    const nextRun = info.nextRunExpected ? new Date(info.nextRunExpected).toLocaleString() : 'Pending';
                    const hours = info.intervalHours;
                    cronInfo.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div class="status-badge status-online" style="width: 8px; height: 8px; padding: 0; border-radius: 50%;"></div>
                                <span style="color: var(--color-text-secondary);">Auto-run active: every ${hours}h</span>
                            </div>
                            <div style="text-align: right;">
                                <span class="hint">Next run:</span>
                                <span style="font-weight: 500; margin-left: 4px; color: var(--color-accent);">${nextRun}</span>
                            </div>
                        </div>
                    `;
                    cronInfo.style.display = 'block';
                } else {
                    cronInfo.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem;">
                            <div class="status-badge status-offline" style="width: 8px; height: 8px; padding: 0; border-radius: 50%;"></div>
                            <span class="hint">Auto-run is currently disabled.</span>
                        </div>
                    `;
                    cronInfo.style.display = 'block';
                }
            }

            // Update history if status changed from running to idle
            const statusString = status.isRunning ? 'running' : 'idle';
            if (this._lastScraperStatus === 'running' && statusString === 'idle') {
                this.loadScraperHistory();
                if (this.app.sourceManager) {
                    this.app.sourceManager.loadSources();
                }
            }

            this._lastScraperStatus = statusString;
        } catch (err) {
            console.warn('Failed to load scraper status:', err);
        }
    }

    async loadScraperLogs() {
        try {
            const data = await API.scraper.getLogs();
            if (data.logs) {
                const logsContainer = document.getElementById('scraper-logs');
                if (logsContainer) {
                    // Update logs only if changed
                    if (this._lastLogsLength !== data.logs.length) {
                        logsContainer.innerHTML = data.logs.map(log =>
                            `<div class="log-entry">${this.escapeHtml(log)}</div>`
                        ).join('');
                        logsContainer.scrollTop = logsContainer.scrollHeight;
                        this._lastLogsLength = data.logs.length;
                    }
                }
            }
        } catch (err) {
            console.warn('Failed to load scraper logs:', err);
        }
    }

    async loadScraperHistory() {
        const historyList = document.getElementById('scraper-history-list');
        if (!historyList) return;

        try {
            const data = await API.scraper.getStatus();
            const history = data.history || [];

            if (history.length === 0) {
                historyList.innerHTML = '<p class="hint">No history available yet.</p>';
                return;
            }

            historyList.innerHTML = history.slice(0, 10).map(item => `
                <div class="source-item" style="padding: var(--space-sm); border-bottom: 1px solid var(--color-border); background: ${item.success !== false ? 'transparent' : 'rgba(239, 68, 68, 0.05)'}">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <div style="font-weight: 500; display: flex; align-items: center; gap: 8px;">
                                ${new Date(item.timestamp).toLocaleString()}
                                ${item.type === 'auto' ? '<span class="version-badge" style="background: var(--color-bg-tertiary); color: var(--color-text-secondary); border: 1px solid var(--color-border); font-size: 0.6rem; padding: 1px 4px; border-radius: 4px;">AUTO</span>' : ''}
                            </div>
                            <div class="hint" style="font-size: 0.75rem;">Duration: ${item.duration || 0}s | Channels: ${item.channelsCount || 0}</div>
                        </div>
                        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
                            <span class="status-badge ${item.success !== false ? 'status-online' : 'status-offline'}">
                                ${item.success !== false ? 'Success' : 'Failed'}
                            </span>
                            ${item.error ? `<div class="hint" style="font-size: 0.65rem; color: var(--color-error); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${this.escapeHtml(item.error)}">${this.escapeHtml(item.error)}</div>` : ''}
                        </div>
                    </div>
                </div>
            `).join('');
        } catch (err) {
            console.error('Error loading scraper history:', err);
        }
    }

    startScraperStatusPolling() {
        if (this._scraperInterval) return;

        this.loadScraperStatus();
        this.loadScraperHistory();
        this.loadScraperLogs();

        this._scraperInterval = setInterval(() => {
            this.loadScraperStatus();
            this.loadScraperLogs();
        }, 5000);
    }

    stopScraperStatusPolling() {
        if (this._scraperInterval) {
            clearInterval(this._scraperInterval);
            this._scraperInterval = null;
        }
    }

    appendLog(message) {
        const logsContainer = document.getElementById('scraper-logs');
        if (!logsContainer) return;

        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logsContainer.appendChild(entry);
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    clearLogs() {
        const logsContainer = document.getElementById('scraper-logs');
        if (logsContainer) {
            logsContainer.innerHTML = '<div class="log-entry" style="color: var(--color-text-muted);">Logs cleared.</div>';
        }
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    switchTab(tabName) {
        this.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        this.tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));

        // Load content browser when switching to that tab
        if (tabName === 'content') {
            this.app.sourceManager.loadContentSources();
        }

        // Load users when switching to users tab
        if (tabName === 'users') {
            this.loadUsers();
        }

        // Load hardware info when switching to transcode tab
        if (tabName === 'transcode') {
            this.loadHardwareInfo();
        }
    }

    async show() {
        console.log('[Settings] Showing settings page...');
        const user = this.app.currentUser;
        console.log('[Settings] Current user state:', user);

        const isAdmin = user && user.role === 'admin';
        console.log('[Settings] User role:', user?.role, '| isAdmin:', isAdmin);

        // Tab visibility based on role
        const transcodeTab = document.querySelector('.tab[data-tab="transcode"]');
        const usersTab = document.getElementById('users-tab');
        const scraperTab = document.getElementById('scraper-tab');

        if (usersTab) usersTab.style.display = isAdmin ? 'block' : 'none';
        if (transcodeTab) transcodeTab.style.display = 'block';
        if (scraperTab) scraperTab.style.display = isAdmin ? 'block' : 'none';

        // Hide global EPG settings for non-admins (it's the last source-section in tab-sources)
        const epgDataSettings = document.querySelector('#tab-sources .source-section:last-child');
        if (epgDataSettings && epgDataSettings.querySelector('h3')?.textContent.includes('EPG Data Settings')) {
            epgDataSettings.style.display = isAdmin ? 'block' : 'none';
        }

        // Initialize User Profile section
        this.initUserProfile(user);

        // Load sources when page is shown
        await this.app.sourceManager.loadSources();
        await this.app.sourceManager.loadContentSources();

        // Start scraper status polling if admin
        if (isAdmin) {
            this.startScraperStatusPolling();
        }

        // Refresh ALL player settings from server
        if (this.app.player?.settings) {
            const s = this.app.player.settings;

            // Player settings
            const arrowKeysToggle = document.getElementById('setting-arrow-keys');
            const overlayDurationInput = document.getElementById('setting-overlay-duration');
            const defaultVolumeSlider = document.getElementById('setting-default-volume');
            const volumeValueDisplay = document.getElementById('volume-value');
            const rememberVolumeToggle = document.getElementById('setting-remember-volume');
            const autoPlayNextToggle = document.getElementById('setting-autoplay-next');
            const forceProxyToggle = document.getElementById('setting-force-proxy');
            const forceTranscodeToggle = document.getElementById('setting-force-transcode');
            const forceRemuxToggle = document.getElementById('setting-force-remux');
            const autoTranscodeToggle = document.getElementById('setting-auto-transcode');
            const epgRefreshSelect = document.getElementById('epg-refresh-interval');
            const streamFormatSelect = document.getElementById('setting-stream-format');

            if (arrowKeysToggle) arrowKeysToggle.checked = s.arrowKeysChangeChannel;
            if (overlayDurationInput) overlayDurationInput.value = s.overlayDuration;
            if (defaultVolumeSlider) defaultVolumeSlider.value = s.defaultVolume;
            if (volumeValueDisplay) volumeValueDisplay.textContent = s.defaultVolume + '%';
            if (rememberVolumeToggle) rememberVolumeToggle.checked = s.rememberVolume;
            if (autoPlayNextToggle) autoPlayNextToggle.checked = s.autoPlayNextEpisode;
            if (forceProxyToggle) forceProxyToggle.checked = s.forceProxy || false;
            if (forceTranscodeToggle) forceTranscodeToggle.checked = s.forceTranscode || false;
            if (forceRemuxToggle) forceRemuxToggle.checked = s.forceRemux || false;
            if (autoTranscodeToggle) autoTranscodeToggle.checked = s.autoTranscode || false;
            if (epgRefreshSelect) epgRefreshSelect.value = s.epgRefreshInterval || '24';
            if (streamFormatSelect) streamFormatSelect.value = s.streamFormat || 'm3u8';

            // User-Agent settings
            const userAgentSelect = document.getElementById('setting-user-agent');
            const userAgentCustomInput = document.getElementById('setting-user-agent-custom');
            const customUaContainer = document.getElementById('custom-user-agent-container');
            if (userAgentSelect) {
                userAgentSelect.value = s.userAgentPreset || 'chrome';
                if (customUaContainer) {
                    customUaContainer.style.display = userAgentSelect.value === 'custom' ? 'flex' : 'none';
                }
            }
            if (userAgentCustomInput) userAgentCustomInput.value = s.userAgentCustom || '';
        }

        // Update EPG last refreshed display
        this.updateEpgLastRefreshed();
    }

    /**
     * Update the EPG last refreshed display
     */
    async updateEpgLastRefreshed() {
        const display = document.getElementById('epg-last-refreshed');
        if (!display) return;

        try {
            // Fetch last sync time from server
            const response = await fetch('/api/settings/sync-status');
            if (!response.ok) throw new Error('Failed to fetch sync status');
            const data = await response.json();

            if (data.lastSyncTime) {
                const lastRefreshTime = new Date(data.lastSyncTime);
                const now = new Date();
                const diffMs = now - lastRefreshTime;
                const diffMins = Math.floor(diffMs / 60000);
                const diffHours = Math.floor(diffMins / 60);

                let text;
                if (diffMins < 1) {
                    text = 'Just now';
                } else if (diffMins < 60) {
                    text = `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
                } else if (diffHours < 24) {
                    text = `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
                } else {
                    text = lastRefreshTime.toLocaleString();
                }

                display.textContent = text;
                display.title = lastRefreshTime.toLocaleString();
            } else {
                display.textContent = 'Never';
                display.title = 'Sync has not run yet since server started';
            }
        } catch (err) {
            console.error('Error fetching sync status:', err);
            display.textContent = 'Unknown';
            display.title = 'Could not fetch sync status';
        }
    }

    /**
     * Initialize and display User Profile information
     */
    initUserProfile(user) {
        const section = document.getElementById('user-profile-section');
        const roleDisplay = document.getElementById('user-role-display');
        const usernameDisplay = document.getElementById('user-username-display');

        if (!section || !user) return;

        section.style.display = 'block';

        if (roleDisplay) {
            roleDisplay.textContent = `Role: ${user.role || 'unknown'}`;
            roleDisplay.style.padding = '2px 8px';
            roleDisplay.style.borderRadius = '4px';
            roleDisplay.style.fontSize = '0.75rem';
            roleDisplay.style.fontWeight = 'bold';
            roleDisplay.style.textTransform = 'uppercase';

            if (user.role === 'admin') {
                roleDisplay.style.background = 'rgba(16, 185, 129, 0.2)';
                roleDisplay.style.color = '#10b981';
            } else {
                roleDisplay.style.background = 'rgba(245, 158, 11, 0.2)';
                roleDisplay.style.color = '#f59e0b';
            }
        }

        if (usernameDisplay) {
            usernameDisplay.textContent = user.username || 'Unknown User';
        }
    }

    hide() {
        // Stop scraper status polling
        this.stopScraperStatusPolling();
        // Reset initialization flag so settings are re-loaded next time
        this._scraperSettingsInitialized = false;
    }
}

window.SettingsPage = SettingsPage;
