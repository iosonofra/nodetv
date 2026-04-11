/**
 * Video Player Component
 * Handles HLS video playback with custom controls
 */

// Check if device is mobile
function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

class VideoPlayer {
    constructor() {
        this.video = document.getElementById('video-player');
        this.container = document.querySelector('.video-container');
        this.overlay = document.getElementById('player-overlay');
        this.nowPlaying = document.getElementById('now-playing');
        this.hls = null;
        this.currentChannel = null;
        this.overlayTimer = null;
        this.overlayDuration = 5000; // 5 seconds
        this.isUsingProxy = false;
        this.currentUrl = null;
        this.settingsLoaded = false;

        // Settings - start with defaults, load from server async
        this.settings = this.getDefaultSettings();

        // Load settings from server, then init
        this.loadSettingsFromServer().then(() => {
            this.init();
        });
    }

    /**
     * Default settings
     */
    getDefaultSettings() {
        return {
            arrowKeysChangeChannel: true,
            overlayDuration: 5,
            defaultVolume: 80,
            rememberVolume: true,
            lastVolume: 80,
            autoPlayNextEpisode: false,
            forceProxy: false,
            forceTranscode: false,
            forceRemux: false,
            autoTranscode: false,
            streamFormat: 'm3u8',
            epgRefreshInterval: '24'
        };
    }

    /**
     * Load settings from server API
     */
    async loadSettingsFromServer() {
        try {
            const serverSettings = await API.settings.get();
            this.settings = { ...this.getDefaultSettings(), ...serverSettings };
            this.settingsLoaded = true;
            console.log('[Player] Settings loaded from server');
        } catch (err) {
            console.warn('[Player] Failed to load settings from server, using defaults:', err.message);
            // Fall back to localStorage for backwards compatibility
            try {
                const saved = localStorage.getItem('nodecast_tv_player_settings');
                if (saved) {
                    this.settings = { ...this.getDefaultSettings(), ...JSON.parse(saved) };
                    console.log('[Player] Settings loaded from localStorage (fallback)');
                }
            } catch (localErr) {
                console.error('[Player] Error loading localStorage settings:', localErr);
            }
        }
    }

    /**
     * Save settings to server API
     */
    async saveSettings() {
        try {
            await API.settings.update(this.settings);
            console.log('[Player] Settings saved to server');
        } catch (err) {
            console.error('[Player] Error saving settings to server:', err);
            // Also save to localStorage as backup
            try {
                localStorage.setItem('nodecast_tv_player_settings', JSON.stringify(this.settings));
            } catch (localErr) {
                console.error('[Player] Error saving to localStorage:', localErr);
            }
        }
    }

    /**
     * Legacy sync method for compatibility - calls async version
     */
    loadSettings() {
        return this.settings;
    }

    /**
     * Get HLS.js configuration with buffer settings optimized for stable playback
     */
    getHlsConfig(opts = {}) {
        // DLStreams mono.css manifests often have only 2-3 real segments per window
        // (the rest are image placeholders stripped by the proxy). Using liveSyncDurationCount:3
        // means HLS.js never finds enough segments to start playing. Use 1 for DLStreams.
        const liveSyncCount = opts.isDlstreams ? 1 : 2;
        const liveMaxLatency = opts.isDlstreams ? 4 : 8;
        return {
            enableWorker: true,
            // Buffer settings to prevent underruns during background tab throttling
            maxBufferLength: 30,           // Buffer up to 30 seconds of content
            maxMaxBufferLength: 60,        // Absolute max buffer 60 seconds
            maxBufferSize: 60 * 1000 * 1000, // 60MB max buffer size
            maxBufferHole: 1.0,            // Allow 1s holes in buffer (helps with discontinuities)
            // Live stream settings - stay close to live edge for low latency.
            // DLStreams mono manifests only have 2-3 real segments per 12s window;
            // liveSyncDurationCount:3 would lock HLS.js at the start of the manifest
            // forever, never finding 3 segments behind live edge. Use 1 for DLStreams,
            // 2 for everything else (still safe; allows 8s latency which is fine for live TV).
            liveSyncDurationCount: liveSyncCount,
            liveMaxLatencyDurationCount: liveMaxLatency,
            liveBackBufferLength: 30,      // Keep 30s of back buffer for seeking
            // Audio discontinuity handling (fixes garbled audio during ad transitions)
            stretchShortVideoTrack: true,  // Stretch short segments to avoid gaps
            forceKeyFrameOnDiscontinuity: true, // Force keyframe sync on discontinuity
            // Audio settings - prevent glitches during stream transitions
            // Higher drift tolerance = less aggressive correction = fewer glitches
            maxAudioFramesDrift: 8,        // Allow ~185ms audio drift before correction (was 4)
            // Disable progressive/streaming mode for stability with discontinuities
            progressive: false,
            // Stall recovery settings
            nudgeOffset: 0.2,              // Larger nudge steps for recovery (default 0.1)
            nudgeMaxRetry: 6,              // More retry attempts (default 3)
            // Faster recovery from errors — DLStreams uses fewer retries to fail fast
            // when the CDN is genuinely down (spares ~10s of wasted 502 retries)
            levelLoadingMaxRetry: opts.isDlstreams ? 2 : 4,
            manifestLoadingMaxRetry: opts.isDlstreams ? 2 : 4,
            fragLoadingMaxRetry: opts.isDlstreams ? 3 : 6,
            // Low latency mode off for more stable audio
            lowLatencyMode: false,
            // Caption/Subtitle settings
            enableCEA708Captions: true,    // Enable CEA-708 closed captions
            enableWebVTT: true,            // Enable WebVTT subtitles
            renderTextTracksNatively: true // Use native browser rendering for text tracks
        };
    }

    /**
     * Initialize custom video controls for mobile
     */
    /**
     * Initialize custom video controls
     */
    initCustomControls() {
        // Elements
        this.controlsOverlay = document.getElementById('player-controls-overlay');
        this.loadingSpinner = document.getElementById('player-loading');

        const btnPlay = document.getElementById('btn-play');
        const btnMute = document.getElementById('btn-mute');
        const btnFullscreen = document.getElementById('btn-fullscreen');
        const volumeSlider = document.getElementById('player-volume');
        const channelNameEl = document.getElementById('player-channel-name');

        if (!this.controlsOverlay) return;

        // Disable native controls
        this.video.controls = false;

        // Initial State: Hide all overlay elements until content is loaded
        this.loadingSpinner?.classList.remove('show');
        this.controlsOverlay?.classList.add('hidden');

        // Play/Pause toggle
        const togglePlay = () => {
            if (this.video.paused) {
                this.video.play();
            } else {
                this.video.pause();
            }
        };

        btnPlay?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Update play/pause UI
        const updatePlayUI = () => {
            const isPaused = this.video.paused;

            // Bottom bar button
            const iconPlay = btnPlay?.querySelector('.icon-play');
            const iconPause = btnPlay?.querySelector('.icon-pause');

            if (iconPlay && iconPause) {
                iconPlay.classList.toggle('hidden', !isPaused);
                iconPause.classList.toggle('hidden', isPaused);
            }
        };

        this.video.addEventListener('play', updatePlayUI);
        this.video.addEventListener('pause', updatePlayUI);

        // Loading spinner
        this.video.addEventListener('waiting', () => {
            this.loadingSpinner?.classList.add('show');
        });

        this.video.addEventListener('canplay', () => {
            this.loadingSpinner?.classList.remove('show');
        });

        // Mute/Volume
        const updateVolumeUI = () => {
            const isMuted = this.video.muted || this.video.volume === 0;
            const iconVol = btnMute?.querySelector('.icon-vol');
            const iconMuted = btnMute?.querySelector('.icon-muted');

            if (iconVol && iconMuted) {
                iconVol.classList.toggle('hidden', isMuted);
                iconMuted.classList.toggle('hidden', !isMuted);
            }

            if (volumeSlider) {
                volumeSlider.value = this.video.muted ? 0 : Math.round(this.video.volume * 100);
            }
        };

        btnMute?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.video.muted) {
                this.video.muted = false;
                this.video.volume = (parseInt(volumeSlider?.value || 80) / 100) || 0.8;
            } else {
                this.video.muted = true;
            }
            updateVolumeUI();
        });

        volumeSlider?.addEventListener('input', (e) => {
            e.stopPropagation();
            const val = parseInt(e.target.value);
            this.video.volume = val / 100;
            this.video.muted = val === 0;
            updateVolumeUI();
        });

        this.video.addEventListener('volumechange', updateVolumeUI);

        // Captions
        this.captionsBtn = document.getElementById('player-captions-btn');
        this.captionsMenu = document.getElementById('player-captions-menu');
        this.captionsList = document.getElementById('player-captions-list');
        this.captionsMenuOpen = false;

        this.captionsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCaptionsMenu();
        });

        // Close captions menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.captionsMenuOpen &&
                !this.captionsMenu.contains(e.target) &&
                !this.captionsBtn.contains(e.target)) {
                this.closeCaptionsMenu();
            }
        });

        // Fullscreen
        btnFullscreen?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleFullscreen();
        });

        // Picture-in-Picture
        const btnPip = document.getElementById('btn-pip');
        btnPip?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePictureInPicture();
        });

        // Info / Now Playing toggle
        const btnInfo = document.getElementById('btn-info');
        btnInfo?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.nowPlaying.classList.contains('hidden')) {
                this.showNowPlayingOverlay();
            } else {
                this.hideNowPlayingOverlay();
            }
        });

        // Overflow Menu
        const btnOverflow = document.getElementById('btn-overflow');
        const overflowMenu = document.getElementById('player-overflow-menu');

        btnOverflow?.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowMenu?.classList.toggle('hidden');
        });

        // Copy Stream URL
        const btnCopyUrl = document.getElementById('btn-copy-url');
        btnCopyUrl?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyStreamUrl();
            overflowMenu?.classList.add('hidden');
        });

        // Stats for Nerds
        const btnStats = document.getElementById('btn-stats');
        const btnCloseStats = document.getElementById('btn-close-stats');

        btnStats?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleStatsOverlay();
            overflowMenu?.classList.add('hidden');
        });

        btnCloseStats?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleStatsOverlay(false);
        });

        // Close overflow menu when clicking outside
        document.addEventListener('click', (e) => {
            if (overflowMenu && !overflowMenu.classList.contains('hidden') &&
                !overflowMenu.contains(e.target) && e.target !== btnOverflow) {
                overflowMenu.classList.add('hidden');
            }
        });

        this.container.addEventListener('dblclick', () => this.toggleFullscreen());

        // Overlay Auto-hide Logic
        let overlayTimeout;
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');

        const showOverlay = () => {
            this.controlsOverlay.classList.remove('hidden');
            this.container.style.cursor = 'default';
            sidebarExpandBtn?.classList.add('visible');
            resetOverlayTimer();
        };

        const hideOverlay = () => {
            if (!this.video.paused) {
                this.controlsOverlay.classList.add('hidden');
                this.container.style.cursor = 'none';
                sidebarExpandBtn?.classList.remove('visible');
            }
        };

        const resetOverlayTimer = () => {
            clearTimeout(overlayTimeout);
            if (!this.video.paused) {
                overlayTimeout = setTimeout(hideOverlay, 3000);
            }
        };

        this.container.addEventListener('mousemove', showOverlay);
        this.container.addEventListener('click', showOverlay);
        this.container.addEventListener('touchstart', showOverlay);

        this.video.addEventListener('play', resetOverlayTimer);
        this.video.addEventListener('pause', showOverlay);

        // Update Title when channel changes
        window.addEventListener('channelChanged', (e) => {
            if (channelNameEl && e.detail) {
                channelNameEl.textContent = e.detail.name || e.detail.tvgName || 'Live TV';
            }
            showOverlay();
        });

        // Initial state
        updatePlayUI();
        updateVolumeUI();

        // DVR Seekbar
        const dvrSeekbar = document.getElementById('player-dvr-seekbar');
        const liveBadge = document.getElementById('player-live-badge');

        if (dvrSeekbar && liveBadge) {
            // Seek within the HLS back-buffer when user drags the seekbar
            dvrSeekbar.addEventListener('input', (e) => {
                e.stopPropagation();
                const percent = parseFloat(e.target.value);
                const seekable = this.video.seekable;
                if (seekable && seekable.length > 0) {
                    const start = seekable.start(0);
                    const end = seekable.end(seekable.length - 1);
                    this.video.currentTime = start + (percent / 100) * (end - start);
                }
            });

            // Click LIVE badge to jump to live edge
            liveBadge.addEventListener('click', (e) => {
                e.stopPropagation();
                const seekable = this.video.seekable;
                if (seekable && seekable.length > 0) {
                    this.video.currentTime = seekable.end(seekable.length - 1);
                }
            });

            // Update seekbar position and LIVE badge state on timeupdate
            this.video.addEventListener('timeupdate', () => {
                const seekable = this.video.seekable;
                if (!seekable || seekable.length === 0) return;

                const start = seekable.start(0);
                const end = seekable.end(seekable.length - 1);
                const range = end - start;
                if (range <= 0) return;

                const percent = ((this.video.currentTime - start) / range) * 100;
                dvrSeekbar.value = Math.min(100, Math.max(0, percent));

                // Live if within ~1.5 seconds of the live edge
                const isLive = (end - this.video.currentTime) < 1.5;
                liveBadge.classList.toggle('live', isLive);
            });
        }
    }

    /**
     * Toggle fullscreen mode
     */
    toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            this.container.requestFullscreen().catch(err => {
                console.error('Fullscreen error:', err);
            });
        }
    }

    /**
     * Toggle Picture-in-Picture mode
     */
    async togglePictureInPicture() {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && this.video.readyState >= 2) {
                await this.video.requestPictureInPicture();
            }
        } catch (err) {
            // Silently fail - Firefox users can use native PiP button
            if (err.name !== 'NotAllowedError') {
                console.error('Picture-in-Picture error:', err);
            }
        }
    }

    /**
     * Copy current stream URL to clipboard
     */
    copyStreamUrl() {
        if (!this.currentUrl) {
            console.warn('[Player] No stream URL to copy');
            return;
        }

        let streamUrl = this.currentUrl;

        // If it's a relative URL, make it absolute
        if (streamUrl.startsWith('/')) {
            streamUrl = window.location.origin + streamUrl;
        }

        navigator.clipboard.writeText(streamUrl).then(() => {
            // Show brief feedback
            const btn = document.getElementById('btn-copy-url');
            if (btn) {
                const originalText = btn.textContent;
                btn.textContent = '✓ Copied!';
                setTimeout(() => {
                    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Stream URL`;
                }, 1500);
            }
            console.log('[Player] Stream URL copied:', streamUrl);
        }).catch(() => {
            prompt('Copy this URL:', streamUrl);
        });
    }


    /**
     * Toggle captions menu visibility
     */
    toggleCaptionsMenu() {
        if (!this.captionsMenu) return;

        this.captionsMenuOpen = !this.captionsMenuOpen;

        if (this.captionsMenuOpen) {
            this.updateCaptionsTracks();
            this.captionsMenu.classList.remove('hidden');
        } else {
            this.captionsMenu.classList.add('hidden');
        }
    }

    /**
     * Close captions menu
     */
    closeCaptionsMenu() {
        if (!this.captionsMenu) return;
        this.captionsMenuOpen = false;
        this.captionsMenu.classList.add('hidden');
    }

    /**
     * Update available caption tracks in the menu
     */
    updateCaptionsTracks() {
        if (!this.captionsList) return;

        // Clear existing list (keep only Off option)
        this.captionsList.innerHTML = '<button class="captions-option" data-index="-1">Off</button>';

        // Add tracks
        if (this.video.textTracks && this.video.textTracks.length > 0) {
            let hasActiveTrack = false;

            for (let i = 0; i < this.video.textTracks.length; i++) {
                const track = this.video.textTracks[i];
                const btn = document.createElement('button');
                btn.className = 'captions-option';
                btn.textContent = track.label || `Track ${i + 1} (${track.language || 'unknown'})`;
                btn.dataset.index = i;

                if (track.mode === 'showing') {
                    btn.classList.add('active');
                    // Add checkmark
                    btn.innerHTML += ' <span style="float: right;">✓</span>';
                    hasActiveTrack = true;
                }

                btn.onclick = (e) => {
                    e.stopPropagation();
                    this.selectCaptionTrack(i);
                };

                this.captionsList.appendChild(btn);
            }

            // Handle "Off" button state
            const offBtn = this.captionsList.querySelector('[data-index="-1"]');
            if (offBtn) {
                if (!hasActiveTrack) {
                    offBtn.classList.add('active');
                    offBtn.innerHTML += ' <span style="float: right;">✓</span>';
                }
                offBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.selectCaptionTrack(-1);
                };
            }
        }
    }

    /**
     * Select a caption track
     */
    selectCaptionTrack(index) {
        if (!this.video.textTracks) return;

        // Turn off all tracks
        for (let i = 0; i < this.video.textTracks.length; i++) {
            this.video.textTracks[i].mode = 'hidden'; // or 'disabled'
        }

        // Turn on selected track
        if (index >= 0 && index < this.video.textTracks.length) {
            this.video.textTracks[index].mode = 'showing';
        }

        this.closeCaptionsMenu();
    }

    init() {
        // Apply default/remembered volume
        const volume = this.settings.rememberVolume ? this.settings.lastVolume : this.settings.defaultVolume;
        this.video.volume = volume / 100;

        // Save volume changes
        this.video.addEventListener('volumechange', () => {
            if (this.settings.rememberVolume) {
                this.settings.lastVolume = Math.round(this.video.volume * 100);
                this.saveSettings();
            }
        });

        // Setup custom video controls
        this.initCustomControls();

        // Detect video resolution when metadata loads (works for all streams)
        this.video.addEventListener('loadedmetadata', () => {
            if (this.video.videoHeight > 0) {
                this.currentStreamInfo = {
                    width: this.video.videoWidth,
                    height: this.video.videoHeight
                };
                this.updateQualityBadge();
            }
        });

        // Initialize HLS.js if supported
        if (Hls.isSupported()) {
            this.hls = new Hls(this.getHlsConfig());
            this.lastDiscontinuity = -1; // Track discontinuity changes

            this.hls.on(Hls.Events.ERROR, (event, data) => {
                console.error('HLS error:', data.type, data.details);
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            // Track network retry attempts
                            this.networkRetryCount = (this.networkRetryCount || 0) + 1;
                            const now = Date.now();
                            const timeSinceLastNetworkError = now - (this.lastNetworkErrorTime || 0);
                            this.lastNetworkErrorTime = now;

                            // Reset retry count if it's been more than 30 seconds since last error
                            if (timeSinceLastNetworkError > 30000) {
                                this.networkRetryCount = 1;
                            }

                            console.log(`Network error (attempt ${this.networkRetryCount}/3):`, data.details);

                            if (this.networkRetryCount <= 3 && !this.isUsingProxy) {
                                // Retry with increasing delay (1s, 2s, 3s)
                                const retryDelay = this.networkRetryCount * 1000;
                                console.log(`[HLS] Retrying in ${retryDelay}ms...`);
                                setTimeout(() => {
                                    if (this.hls) {
                                        this.hls.startLoad();
                                    }
                                }, retryDelay);
                            } else if (!this.isUsingProxy) {
                                // After 3 retries, try proxy
                                console.log('[HLS] Max retries reached, switching to proxy...');
                                this.networkRetryCount = 0;
                                this.isUsingProxy = true;
                                const proxiedUrl = this.getProxiedUrl(this.currentUrl, this.currentChannel?.sourceId, this.currentChannel?.proxyHeaders, this.currentChannel);
                                this.hls.loadSource(proxiedUrl);
                                this.hls.startLoad();
                            } else {
                                // Already using proxy, just retry
                                console.log('[HLS] Network error on proxy, retrying...');
                                this.hls.startLoad();
                            }
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('Media error, attempting recovery...');
                            this.hls.recoverMediaError();
                            break;
                        default:
                            this.stop();
                            break;
                    }
                } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    // Non-fatal media error - try to recover with cooldown to prevent loops
                    const now = Date.now();
                    const timeSinceLastRecovery = now - (this.lastRecoveryAttempt || 0);

                    // Track consecutive media errors for escalated recovery
                    if (timeSinceLastRecovery < 5000) {
                        this.mediaErrorCount = (this.mediaErrorCount || 0) + 1;
                    } else {
                        this.mediaErrorCount = 1;
                    }
                    this._totalMediaErrorCount = (this._totalMediaErrorCount || 0) + 1;

                    // Hard cap: if too many non-fatal media errors, stop trying to recover
                    if (this._totalMediaErrorCount > 10) {
                        console.error(`[HLS] Too many non-fatal media errors (${this._totalMediaErrorCount}). Stopping recovery.`);
                        return;
                    }

                    // Only attempt recovery if more than 2 seconds since last attempt
                    if (timeSinceLastRecovery > 2000) {
                        console.log(`Non-fatal media error (${this.mediaErrorCount}x):`, data.details, '- attempting recovery');
                        this.lastRecoveryAttempt = now;

                        // If repeated errors, try swapAudioCodec which can fix audio glitches
                        if (this.mediaErrorCount >= 3) {
                            console.log('[HLS] Multiple errors detected, trying swapAudioCodec...');
                            this.hls.swapAudioCodec();
                            this.mediaErrorCount = 0;
                        }

                        this.hls.recoverMediaError();

                        // If fragParsingError, also seek forward slightly to skip corrupted segment
                        if (data.details === 'fragParsingError' && !this.video.paused && this.video.currentTime > 0) {
                            console.log('[HLS] Seeking past corrupted segment...');
                            setTimeout(() => {
                                if (this.video && !this.video.paused) {
                                    this.video.currentTime += 1;
                                }
                            }, 200);
                        }
                    } else {
                        // Too many errors in quick succession - log but don't spam recovery
                        console.log('Non-fatal media error (cooldown):', data.details);
                    }
                } else if (data.details === 'bufferAppendError') {
                    // Buffer errors during ad transitions - try recovery
                    console.log('Buffer append error, recovering...');
                    this.hls.recoverMediaError();
                }
            });

            // Detect audio track switches (can cause audio glitches on some streams)
            this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
                console.log('Audio track switched:', data);
            });

            // Detect buffer stalls which may indicate codec issues
            this.hls.on(Hls.Events.BUFFER_STALLED_ERROR, () => {
                console.log('Buffer stalled, attempting recovery...');
                this.hls.recoverMediaError();
            });

            // Detect discontinuity changes (ad transitions) and help decoder reset
            this.hls.on(Hls.Events.FRAG_CHANGED, (event, data) => {
                const frag = data.frag;
                // Debug: log every fragment change
                console.log(`[HLS] FRAG_CHANGED: sn=${frag?.sn}, cc=${frag?.cc}, level=${frag?.level}`);

                if (frag && frag.sn !== 'initSegment') {
                    // Check if we crossed a discontinuity boundary using CC (Continuity Counter)
                    if (frag.cc !== undefined && frag.cc !== this.lastDiscontinuity) {
                        console.log(`[HLS] Discontinuity detected: CC ${this.lastDiscontinuity} -> ${frag.cc}`);
                        this.lastDiscontinuity = frag.cc;

                        // Small nudge to help decoder sync (only if playing)
                        if (!this.video.paused && this.video.currentTime > 0) {
                            const nudgeAmount = 0.01;
                            this.video.currentTime += nudgeAmount;
                        }
                    }
                }
            });

            // Listen for subtitle track updates
            this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
                console.log('Subtitle tracks updated:', data.subtitleTracks);
                // Wait a moment for native text tracks to populate
                setTimeout(() => this.updateCaptionsTracks(), 100);
            });

            this.hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (event, data) => {
                console.log('Subtitle track switched:', data);
            });

            this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.video.play().catch(e => console.log('Autoplay prevented:', e));
            });
        }

        // Keyboard controls
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Click on video shows overlay
        this.video.addEventListener('click', () => this.showNowPlayingOverlay());
    }

    /**
     * Show the now playing overlay briefly
     */
    showNowPlayingOverlay() {
        if (!this.currentChannel) return;

        // Clear existing timer
        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
        }

        // Show overlay
        this.nowPlaying.classList.remove('hidden');

        // Hide after duration
        this.overlayTimer = setTimeout(() => {
            this.nowPlaying.classList.add('hidden');
        }, this.settings.overlayDuration * 1000);
    }

    /**
     * Hide the now playing overlay
     */
    hideNowPlayingOverlay() {
        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
        }
        this.nowPlaying.classList.add('hidden');
    }

    /**
     * Stats for Nerds Logic
     */
    toggleStatsOverlay(forceState) {
        if (!this.statsOverlay) {
            this.statsOverlay = document.getElementById('player-stats-overlay');
        }
        if (!this.statsOverlay) return;

        const isHidden = this.statsOverlay.classList.contains('hidden');
        const show = forceState !== undefined ? forceState : isHidden;

        if (show) {
            this.statsOverlay.classList.remove('hidden');
            this.startStatsTimer();
        } else {
            this.statsOverlay.classList.add('hidden');
            this.stopStatsTimer();
        }
    }

    startStatsTimer() {
        if (this.statsTimer) clearInterval(this.statsTimer);
        this.lastFrameTime = performance.now();
        this.lastDecodedFrames = this.video && this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality().totalVideoFrames : 0;
        this.measuredFps = 0;
        this.updateStats();
        this.statsTimer = setInterval(() => this.updateStats(), 1000);
    }

    stopStatsTimer() {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        this.lastFrameTime = null;
        this.lastDecodedFrames = null;
        this.measuredFps = 0;
    }

    updateStats() {
        if (!this.video || !this.hls) return;

        // Viewport
        const viewport = `${this.video.clientWidth}x${this.video.clientHeight}`;

        // Frames
        const vq = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
        let frames = '';
        if (vq) {
            frames = `${vq.droppedVideoFrames} dropped / ${vq.totalVideoFrames} total`;
        } else {
            frames = 'N/A';
        }

        // Resolution
        const width = this.video.videoWidth || 0;
        const height = this.video.videoHeight || 0;
        const optimalRes = this.hls.levels ? (this.hls.levels[this.hls.currentLevel] ? `${this.hls.levels[this.hls.currentLevel].width}x${this.hls.levels[this.hls.currentLevel].height}` : `${width}x${height}`) : `${width}x${height}`;
        const resStats = `${width}x${height} / ${optimalRes}`;

        // Volume
        const volume = `${Math.round(this.video.volume * 100)}%`;

        // Codecs & Frame Rate
        let codecs = 'unknown';
        let manifestFps = null;
        if (this.hls.currentLevel >= 0 && this.hls.levels && this.hls.levels[this.hls.currentLevel]) {
            const level = this.hls.levels[this.hls.currentLevel];
            codecs = level.codecSet || (level.attrs && level.attrs.CODECS) || level.videoCodec || codecs;

            // Extract Frame Rate
            if (level.frameRate) {
                manifestFps = level.frameRate;
            } else if (level.attrs && level.attrs['FRAME-RATE']) {
                manifestFps = level.attrs['FRAME-RATE'];
            }
        }

        // Measure real-time FPS
        const now = performance.now();
        const currentFrames = vq ? vq.totalVideoFrames : 0;
        let displayFps = manifestFps ? `${manifestFps}` : 'N/A';

        if (this.lastFrameTime && this.lastDecodedFrames !== undefined) {
            const timeDiff = (now - this.lastFrameTime) / 1000;
            const frameDiff = currentFrames - this.lastDecodedFrames;

            if (timeDiff > 0 && frameDiff >= 0 && !this.video.paused) {
                const currentFps = Math.round(frameDiff / timeDiff);
                // Simple smoothing
                this.measuredFps = this.measuredFps ? Math.round((this.measuredFps * 0.8) + (currentFps * 0.2)) : currentFps;

                if (manifestFps) {
                    displayFps = `${manifestFps} (~${this.measuredFps} real)`;
                } else if (this.measuredFps > 0) {
                    displayFps = `~${this.measuredFps} (measured)`;
                }
            } else if (this.video.paused) {
                displayFps = manifestFps ? `${manifestFps}` : `0 (paused)`;
            }
        }

        this.lastFrameTime = now;
        this.lastDecodedFrames = currentFrames;

        // Connection Speed / Bandwidth
        let bandwidth = '0 Kbps';
        if (this.hls.bandwidthEstimate) {
            bandwidth = `${Math.round(this.hls.bandwidthEstimate / 1000)} Kbps`;
        }

        // Buffer
        const bufferLen = this.video.buffered && this.video.buffered.length > 0 ? this.video.buffered.end(this.video.buffered.length - 1) - this.video.currentTime : 0;
        const bufferHealth = `${bufferLen.toFixed(2)} s`;

        // Live Latency
        let latency = 'N/A';
        if (this.hls.liveSyncPosition) {
            latency = `${(this.video.currentTime - this.hls.liveSyncPosition).toFixed(2)} s`;
        }

        // Video ID
        const videoId = this.currentChannel ? (this.currentChannel.id || this.currentChannel.tvgName || 'live') : '-';

        // Update DOM
        const q = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        q('stat-video-id', videoId);
        q('stat-viewport-frames', `${viewport} * ${frames}`);
        q('stat-resolution', resStats);
        q('stat-fps', displayFps);
        q('stat-volume', volume);
        q('stat-codecs', codecs);
        q('stat-connection-speed', bandwidth);
        q('stat-network-activity', `${this.networkRetryCount || 0} retries / ${this.mediaErrorCount || 0} media errs`);
        q('stat-buffer-health', bufferHealth);
        q('stat-live-latency', latency);
    }

    /**
     * Start a HLS transcode session
     */
    async startTranscodeSession(url, options = {}) {
        try {
            console.log('[Player] Starting HLS transcode session...', options);
            const res = await fetch('/api/transcode/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, ...options })
            });
            if (!res.ok) throw new Error('Failed to start session');
            const session = await res.json();
            this.currentSessionId = session.sessionId;
            return session.playlistUrl;
        } catch (err) {
            console.error('[Player] Session start failed:', err);
            // Fallback to direct transcode if session fails
            return `/api/transcode?url=${encodeURIComponent(url)}`;
        }
    }

    /**
     * Stop and cleanup current transcode session
     */
    async stopTranscodeSession() {
        if (this.currentSessionId) {
            console.log('[Player] Stopping transcode session:', this.currentSessionId);
            try {
                // Fire and forget cleanup
                fetch(`/api/transcode/${this.currentSessionId}`, { method: 'DELETE' });
            } catch (err) {
                console.error('Failed to stop session:', err);
            }
            this.currentSessionId = null;
        }
    }

    /**
     * Play a channel
     */
    async play(channel, streamUrl) {
        this.currentChannel = channel;
        this._dlstreamsRefreshAttempted = false;
        this._dlstreamsColdStartRetried = false;
        this._fatalMediaRecoveryCount = 0;
        this._dlstreamsMediaErrorRefreshAttempted = false;
        this._dlstreamsFragErrorRefreshAttempted = false;
        this._totalMediaErrorCount = 0;
        this._nativeDecodeErrorCount = 0;

        // Remove previous native error listener if any
        if (this._nativeErrorHandler) {
            this.video.removeEventListener('error', this._nativeErrorHandler);
            this._nativeErrorHandler = null;
        }

        try {
            // Stop any WatchPage playback (movies/series) before starting Live TV
            window.app?.pages?.watch?.stop?.();

            // Stop ShakaPlayer (MPD streams) if it's running
            if (window.app?.shakaPlayer?.stop) {
                window.app.shakaPlayer.stop();
            }

            // Stop current playback
            this.stop();
            this.updateTranscodeStatus('hidden');

            // Hide "select a channel" overlay
            this.overlay.classList.add('hidden');

            // Show custom controls overlay
            this.controlsOverlay?.classList.remove('hidden');
            this.loadingSpinner?.classList.add('show');

            // Determine if HLS or direct stream
            this.currentUrl = streamUrl;

            // CHECK: Auto Transcode (Smart) - probe first, then decide
            if (this.settings.autoTranscode) {
                console.log('[Player] Auto Transcode enabled. Probing stream...');
                try {
                    const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(streamUrl)}`);
                    const info = await probeRes.json();
                    console.log(`[Player] Probe result: video=${info.video}, audio=${info.audio}, ${info.width}x${info.height}, compatible=${info.compatible}`);

                    // Store probe result for quality badge display
                    this.currentStreamInfo = info;
                    this.updateQualityBadge();

                    // Handle subtitles from probe result
                    // Clear existing remote tracks (from previous streams)
                    const oldTracks = this.video.querySelectorAll('track');
                    oldTracks.forEach(t => t.remove());

                    if (info.subtitles && info.subtitles.length > 0) {
                        console.log(`[Player] Found ${info.subtitles.length} subtitle tracks`);
                        info.subtitles.forEach(sub => {
                            const track = document.createElement('track');
                            track.kind = 'subtitles';
                            track.label = sub.title;
                            track.srclang = sub.language;
                            track.src = `/api/subtitle?url=${encodeURIComponent(streamUrl)}&index=${sub.index}`;
                            this.video.appendChild(track);
                        });

                        // Force update of captions menu if it's open
                        if (this.captionsMenuOpen) {
                            this.updateCaptionsTracks();
                        }
                    }

                    if (info.needsTranscode || this.settings.upscaleEnabled) {
                        // Incompatible audio (AC3/EAC3/DTS) or Upscaling enabled - use transcode session
                        console.log(`[Player] Auto: Using HLS transcode session (${this.settings.upscaleEnabled ? 'Upscaling' : 'Incompatible audio/video'})`);

                        // Heuristic: If video is h264, it's likely compatible, so only copy video (audio transcode only)
                        // BUT: If upscaling is enabled, we MUST encode.
                        const videoMode = (info.video && info.video.includes('h264') && !this.settings.upscaleEnabled) ? 'copy' : 'encode';
                        const statusText = videoMode === 'copy' ? 'Transcoding (Audio)' : (this.settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)');
                        const statusMode = this.settings.upscaleEnabled ? 'upscaling' : 'transcoding';

                        this.updateTranscodeStatus(statusMode, statusText);
                        const playlistUrl = await this.startTranscodeSession(streamUrl, {
                            videoMode,
                            videoCodec: info.video,
                            audioCodec: info.audio,
                            audioChannels: info.audioChannels
                        });
                        this.currentUrl = playlistUrl; // Update currentUrl for HLS reload

                        this.playHls(playlistUrl);

                        this.updateNowPlaying(channel);
                        this.showNowPlayingOverlay();
                        this.fetchEpgData(channel);
                        window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                        return;
                    } else if (info.needsRemux) {
                        // Raw .ts container - use remux
                        console.log('[Player] Auto: Using remux (.ts container)');
                        this.updateTranscodeStatus('remuxing', 'Remux (Auto)');
                        const remuxUrl = `/api/remux?url=${encodeURIComponent(streamUrl)}`;
                        this.currentUrl = remuxUrl;
                        this.video.src = remuxUrl;
                        this.video.play().catch(e => {
                            if (e.name !== 'AbortError') console.log('[Player] Autoplay prevented:', e);
                        });
                        this.updateNowPlaying(channel);
                        this.showNowPlayingOverlay();
                        this.fetchEpgData(channel);
                        window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                        return;
                    }
                    // Compatible - fall through to normal HLS.js path
                    console.log('[Player] Auto: Using HLS.js (compatible)');
                } catch (err) {
                    console.warn('[Player] Probe failed, using normal playback:', err.message);
                    // Continue with normal playback on probe failure
                }
            }

            // CHECK: Force Video Transcode (Full) or Upscaling
            if (this.settings.forceVideoTranscode || this.settings.upscaleEnabled) {
                const statusText = this.settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)';
                const statusMode = this.settings.upscaleEnabled ? 'upscaling' : 'transcoding';
                console.log(`[Player] ${statusText} enabled. Starting session (encode)...`);
                this.updateTranscodeStatus(statusMode, statusText);
                const playlistUrl = await this.startTranscodeSession(streamUrl, { videoMode: 'encode' });
                this.currentUrl = playlistUrl;

                // Load HLS
                this.updateNowPlaying(channel, 'Transcoding (Video)');
                // ... (rest is same logic flow, simplified by just falling through to playHls call if I refactored)
                // But for minimize drift, I'll copy the block logic for HLS playback init
                // Actually, I can just fall through if I set looksLikeHls = true?
                // No, play logic is sequential.
                if (Hls.isSupported()) {
                    // Start HLS
                    // ... this repeats code. I should probably just set currentUrl and let HLS block handle?
                    // But HLS block is lower down.
                    // I will just execute the HLS init here as before.

                    // Actually, easiest way is to re-assign streamUrl and goto start? No.
                    // Copy existing forceTranscode block logic
                    if (this.hls) {
                        this.hls.destroy();
                    }
                    this.hls = new Hls();
                    this.hls.loadSource(playlistUrl);
                    this.hls.attachMedia(this.video);
                    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        this.video.play().catch(console.error);
                    });
                    // Handle errors
                    this.hls.on(Hls.Events.ERROR, (event, data) => {
                        if (data.fatal) {
                            console.log('[Player] HLS fatal error');
                            this.hls.destroy();
                        }
                    });

                    return; // Exit
                }
            }

            // CHECK: Force Audio Transcode (Copy Video) - legacy forceTranscode setting
            if (this.settings.forceTranscode) {
                console.log('[Player] Force Audio Transcode enabled. Starting session (copy)...');
                this.updateTranscodeStatus('transcoding', 'Transcoding (Audio)');

                // Probe to get video codec for HEVC tag handling
                let videoCodec = 'unknown';
                try {
                    const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(streamUrl)}`);
                    const info = await probeRes.json();
                    videoCodec = info.video;
                } catch (e) { console.warn('Probe failed for force audio, assuming h264'); }

                const playlistUrl = await this.startTranscodeSession(streamUrl, { videoMode: 'copy', videoCodec });
                this.currentUrl = playlistUrl;

                console.log('[Player] Playing transcoded HLS stream:', playlistUrl);
                this.playHls(playlistUrl);

                // Update UI and dispatch events
                this.updateNowPlaying(channel);
                this.showNowPlayingOverlay();
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return; // Exit early
            }

            // Proactively use proxy for:
            // 1. User enabled "Force Proxy" in settings
            // 2. Protocol mismatch (Mixed Content): App on HTTPS, Stream on HTTP
            // 3. Known CORS-restricted domains (like Pluto TV)
            // Note: Xtream sources are NOT auto-proxied because many providers IP-lock streams
            const proxyRequiredDomains = [
                'pluto.tv',
                'dlstreams.top',
                'zhdcdn.zip',
                'hhkys.com',
                'sportzsonline.click',
                'sportsonline.st'
            ];
            const isPageHttps = window.location.protocol === 'https:';
            const isUrlHttp = streamUrl.startsWith('http:');
            const isDlstreamsChannel = !!(channel && channel.tvgId && String(channel.tvgId).startsWith('dl_'));
            const hasKodiHeaders = streamUrl.includes('|');
            const needsProxy = this.settings.forceProxy ||
                (channel && channel.useWarp) ||
                isDlstreamsChannel ||
                hasKodiHeaders ||
                proxyRequiredDomains.some(domain => streamUrl.includes(domain));

            this.isUsingProxy = needsProxy;
            const finalUrl = needsProxy ? this.getProxiedUrl(streamUrl, channel.sourceId, channel?.proxyHeaders, channel) : streamUrl;
            console.log('[Player] Playing:', { streamUrl, needsProxy, isPageHttps, isUrlHttp, sourceId: channel.sourceId });


            // Detect stream type from the original URL first.
            // Proxied URLs (`/api/proxy/stream?...`) can hide `/mono.css` as `%2Fmono.css`.
            const originalUrlForType = String(streamUrl || '');
            const lowerOriginalUrlForType = originalUrlForType.toLowerCase();

            const looksLikeHls =
                lowerOriginalUrlForType.includes('.m3u8') ||
                lowerOriginalUrlForType.includes('m3u8') ||
                /\/mono\.(css|csv)(\?|$|%23|#)/i.test(originalUrlForType) ||
                /(?:%2f|\/)mono\.(css|csv)(?:%3f|\?|$|%23|#)/i.test(finalUrl) ||
                /sportzsonline\.click\/.*\.php|sportsonline\.st\/.*\.php/i.test(originalUrlForType);

            // Check if this looks like a raw stream (no HLS manifest, no common video extensions)
            // This includes .ts files AND extension-less URLs that might be TS streams
            const isRawTs = lowerOriginalUrlForType.includes('.ts') && !lowerOriginalUrlForType.includes('.m3u8');

            // Detect HLS segment URLs: .ts files with /hls/ in the path are HLS segments,
            // not standalone streams. Derive the manifest URL and play as HLS.
            const hlsSegmentMatch = isRawTs && /\/hls\//i.test(originalUrlForType)
                ? originalUrlForType.replace(/\/[^/?]+\.ts(?=\?|$)/i, '/index.m3u8')
                : null;
            if (hlsSegmentMatch) {
                console.log('[Player] Detected HLS segment URL, deriving manifest:', hlsSegmentMatch);
                // Re-invoke play() with the corrected manifest URL
                return this.play(channel, hlsSegmentMatch);
            }

            const isExtensionless = !lowerOriginalUrlForType.includes('.m3u8') &&
                !lowerOriginalUrlForType.includes('.mp4') &&
                !lowerOriginalUrlForType.includes('.mkv') &&
                !lowerOriginalUrlForType.includes('.avi') &&
                !lowerOriginalUrlForType.includes('.ts');

            // Force Remux: Route through FFmpeg for container conversion
            // Applies to: 1) .ts streams when detected, or 2) ALL non-HLS streams when enabled
            if (this.settings.forceRemux && (isRawTs || isExtensionless)) {
                console.log('[Player] Force Remux enabled. Routing through FFmpeg remux...');
                console.log('[Player] Stream type:', isRawTs ? 'Raw TS' : 'Extension-less (assumed TS)');
                this.updateTranscodeStatus('remuxing', 'Remux (Force)');
                const remuxUrl = this.getRemuxUrl(streamUrl, channel.sourceId);
                this.video.src = remuxUrl;
                this.video.play().catch(e => {
                    if (e.name === 'AbortError') return;
                    if (e.name === 'NotSupportedError') {
                        console.error('[Player] Force Remux media error:', e.message);
                        this.showError(
                            'Stream remux failed — the server could not process this stream.<br><br>' +
                            'The stream URL may have expired or the format is not supported.'
                        );
                    } else {
                        console.log('[Player] Force remux play interrupted:', e);
                    }
                });

                // Update UI and dispatch events
                this.updateNowPlaying(channel);
                this.showNowPlayingOverlay();
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return;
            }

            // If raw TS detected without Force Remux enabled, auto-remux instead of erroring
            if (isRawTs && !this.settings.forceRemux) {
                console.warn('[Player] Raw MPEG-TS stream detected. Auto-routing through FFmpeg remux.');
                this.updateTranscodeStatus('remuxing', 'Remux (Auto)');
                const remuxUrl = this.getRemuxUrl(streamUrl, channel.sourceId);
                this.video.src = remuxUrl;
                this.video.play().catch(e => {
                    if (e.name === 'AbortError') return;
                    if (e.name === 'NotSupportedError' || e.name === 'NotAllowedError') {
                        if (e.name === 'NotSupportedError') {
                            console.error('[Player] Remux media error:', e.message);
                            this.showError(
                                'Stream remux failed — the server could not process this stream.<br><br>' +
                                'The stream URL may have expired or the format is not supported.<br>' +
                                'Try refreshing the channel.'
                            );
                        }
                    } else {
                        console.log('[Player] Remux play interrupted:', e);
                    }
                });

                this.updateNowPlaying(channel);
                this.showNowPlayingOverlay();
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return;
            }

            // Priority 1: Use HLS.js for HLS streams on browsers that support it
            if (looksLikeHls && Hls.isSupported()) {
                this.updateTranscodeStatus('direct', 'Direct HLS');

                // Use playHls helper logic here (or extract it)
                // For now, let's just use existing logic but wrapped/modularized if possible?
                // The HLS init logic is quite complex with error handling
                // I'll inline the Hls init here as per original but mindful of proxy vs local

                this.hls = new Hls(this.getHlsConfig({ isDlstreams: isDlstreamsChannel }));
                this.hls.loadSource(finalUrl);
                this.hls.attachMedia(this.video);

                // Native video error listener: catches decode failures that HLS.js misses.
                // When segments pass HLS.js parsing but the browser decoder rejects them
                // (e.g. HTML content disguised as .ts), the <video> fires error code 4
                // (MEDIA_ERR_SRC_NOT_SUPPORTED) while HLS.js keeps refreshing the live
                // playlist forever. Cap consecutive native decode errors and stop.
                this._nativeErrorHandler = () => {
                    const err = this.video?.error;
                    if (!err || !err.code) return;
                    // Code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED (includes decoder init failures)
                    // Code 3 = MEDIA_ERR_DECODE
                    if (err.code === 4 || err.code === 3) {
                        this._nativeDecodeErrorCount = (this._nativeDecodeErrorCount || 0) + 1;
                        console.warn(`[Player] Native decode error #${this._nativeDecodeErrorCount}: code=${err.code} ${err.message || ''}`);
                        if (this._nativeDecodeErrorCount >= 2 && this.hls) {
                            console.error(`[Player] Repeated native decode errors (${this._nativeDecodeErrorCount}). Stopping HLS.js.`);
                            clearTimeout(this._playbackStartTimeout);
                            try { this.hls.stopLoad(); } catch (_) { }
                            try { this.hls.destroy(); } catch (_) { }
                            this.hls = null;
                            this.showError(
                                isDlstreamsChannel
                                    ? 'DLStreams stream is currently unavailable.<br><br>' +
                                      'The video decoder failed — the stream segments contain invalid data.<br>' +
                                      'Try again in a minute or switch channel.'
                                    : 'Stream playback failed — the video decoder could not process the stream data.<br><br>' +
                                      'The stream may be corrupted or in an unsupported format.'
                            );
                        }
                    }
                };
                this.video.addEventListener('error', this._nativeErrorHandler);

                // Cancel playback timeout once video actually starts rendering
                this._onPlaybackStarted = () => {
                    clearTimeout(this._playbackStartTimeout);
                    this.video.removeEventListener('playing', this._onPlaybackStarted);
                };
                this.video.addEventListener('playing', this._onPlaybackStarted);

                this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    this.video.play().catch(e => {
                        if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
                    });

                    // Playback-start timeout: if no video frame is rendered within 15s
                    // after the manifest is parsed, the segments are likely undecodable
                    // (e.g. HTML/image data disguised as .ts). HLS.js won't fire errors
                    // in this case — it just keeps refreshing the live playlist forever.
                    clearTimeout(this._playbackStartTimeout);
                    this._playbackStartTimeout = setTimeout(() => {
                        if (!this.hls) return;
                        // readyState < 3 = HAVE_FUTURE_DATA means no frame rendered yet
                        if (this.video.readyState < 3 && this.video.currentTime === 0) {
                            console.error('[Player] Playback timeout: no video rendered 15s after manifest parsed. Stopping.');
                            try { this.hls.stopLoad(); } catch (_) { }
                            try { this.hls.destroy(); } catch (_) { }
                            this.hls = null;
                            this.showError(
                                isDlstreamsChannel
                                    ? 'DLStreams stream is currently unavailable.<br><br>' +
                                      'No video data was received after loading the manifest.<br>' +
                                      'The stream segments may contain invalid data.<br>' +
                                      'Try again in a minute or switch channel.'
                                    : 'Stream playback failed — no video was rendered.<br><br>' +
                                      'The stream segments may be corrupted or in an unsupported format.'
                            );
                        }
                    }, 15000);
                });

                // Re-attach error handler for the new Hls instance
                this.hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        const isCorsLikely = data.type === Hls.ErrorTypes.NETWORK_ERROR ||
                            (data.type === Hls.ErrorTypes.MEDIA_ERROR && data.details === 'fragParsingError');
                        const manifestCode = Number(data?.response?.code || data?.response?.status || 0);
                        const isManifestLoadFailure = data.type === Hls.ErrorTypes.NETWORK_ERROR &&
                            data.details === 'manifestLoadError' &&
                            [401, 403, 404, 410, 429, 500, 502, 503, 504].includes(manifestCode);
                        const isDlstreamsChannel = !!(channel && channel.tvgId && String(channel.tvgId).startsWith('dl_'));

                        // Don't proxy if it's already a local API URL
                        const isLocalApi = this.currentUrl.startsWith('/api/');

                        if (isCorsLikely && !this.isUsingProxy && !isLocalApi) {
                            console.log('CORS/Network error detected, retrying via proxy...', data.details);
                            this.isUsingProxy = true;
                            this.hls.loadSource(this.getProxiedUrl(this.currentUrl, channel.sourceId, channel?.proxyHeaders, channel));
                            this.hls.startLoad();
                        } else if (manifestCode === 502 && isDlstreamsChannel && this.isUsingProxy && !this._dlstreamsColdStartRetried) {
                            // 502 = genuine CDN cold-start (transient). Wait a moment and retry.
                            this._dlstreamsColdStartRetried = true;
                            console.log(`[Player] DLStreams 502 cold-start detected for channel. Retrying manifest in 3s...`);
                            setTimeout(() => {
                                if (!this.hls) return;
                                const coldRetryUrl = this.getProxiedUrl(this.currentUrl, channel.sourceId, channel?.proxyHeaders, channel);
                                this.hls.loadSource(coldRetryUrl);
                                this.hls.startLoad();
                            }, 3000);
                        } else if (manifestCode === 503 && isDlstreamsChannel && this.isUsingProxy && !this._dlstreamsRefreshAttempted) {
                            // 503 = CDN down or poisoned manifest. Skip cold-start wait,
                            // go straight to force re-resolve to get a fresh URL.
                            this._dlstreamsRefreshAttempted = true;
                            this._dlstreamsColdStartRetried = true; // skip cold-start if re-resolve returns same code
                            const dlChannelId = String(channel.tvgId).replace('dl_', '');
                            console.log(`[Player] DLStreams 503 (CDN down/poisoned) for channel ${dlChannelId}. Force re-resolving...`);
                            this._dlstreamsForceReResolve(channel, dlChannelId);
                        } else if (isManifestLoadFailure && isDlstreamsChannel && this.isUsingProxy && !this._dlstreamsRefreshAttempted) {
                            this._dlstreamsRefreshAttempted = true;
                            const dlChannelId = String(channel.tvgId).replace('dl_', '');
                            console.log(`[Player] DLStreams manifest load failed (${manifestCode}) on proxied URL. Forcing re-resolve for channel ${dlChannelId}...`);
                            this._dlstreamsForceReResolve(channel, dlChannelId);
                        } else if (isManifestLoadFailure && isDlstreamsChannel && this._dlstreamsRefreshAttempted) {
                            console.error(`[Player] DLStreams manifest still failing after refresh (${manifestCode}). Stopping retries.`);
                            try { this.hls.stopLoad(); } catch (_) { }
                            try { this.hls.destroy(); } catch (_) { }
                            this.hls = null;
                            this.showError(
                                'DLStreams stream is currently unavailable.<br><br>' +
                                'The upstream server is returning an invalid manifest or HTML block page.<br>' +
                                'Try again in a minute or switch channel.'
                            );
                            return;
                        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                            // Fatal media error - try recovery with cooldown and max attempts
                            this._fatalMediaRecoveryCount = (this._fatalMediaRecoveryCount || 0) + 1;
                            const now = Date.now();

                            if (this._fatalMediaRecoveryCount > 4) {
                                // Too many fatal media errors — the stream is undecodable
                                console.error(`[Player] Fatal media error persists after ${this._fatalMediaRecoveryCount} recovery attempts. Giving up.`);
                                try { this.hls.stopLoad(); } catch (_) { }
                                try { this.hls.destroy(); } catch (_) { }
                                this.hls = null;

                                if (isDlstreamsChannel && !this._dlstreamsMediaErrorRefreshAttempted) {
                                    this._dlstreamsMediaErrorRefreshAttempted = true;
                                    const dlChId = String(channel.tvgId).replace('dl_', '');
                                    console.log(`[Player] DLStreams media decode failure — forcing re-resolve for channel ${dlChId}...`);
                                    this._dlstreamsForceReResolve(channel, dlChId);
                                } else {
                                    this.showError(
                                        isDlstreamsChannel
                                            ? 'DLStreams stream is currently unavailable.<br><br>' +
                                              'The stream segments could not be decoded after multiple attempts.<br>' +
                                              'Try again in a minute or switch channel.'
                                            : 'Stream playback failed — the media could not be decoded.<br><br>' +
                                              'The stream may be corrupted or in an unsupported format.'
                                    );
                                }
                                return;
                            }

                            if (now - (this.lastRecoveryAttempt || 0) > 2000) {
                                console.log(`Fatal media error (attempt ${this._fatalMediaRecoveryCount}/4), attempting recovery...`);
                                this.lastRecoveryAttempt = now;
                                this.hls.recoverMediaError();
                            }
                        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && data.details === 'fragLoadError' && isDlstreamsChannel) {
                            // Fatal segment load error on DLStreams — likely a poisoned manifest
                            console.error(`[Player] DLStreams fatal fragLoadError — segments unplayable. Forcing re-resolve...`);
                            try { this.hls.stopLoad(); } catch (_) { }
                            try { this.hls.destroy(); } catch (_) { }
                            this.hls = null;
                            if (!this._dlstreamsFragErrorRefreshAttempted) {
                                this._dlstreamsFragErrorRefreshAttempted = true;
                                const dlChId = String(channel.tvgId).replace('dl_', '');
                                this._dlstreamsForceReResolve(channel, dlChId);
                            } else {
                                this.showError(
                                    'DLStreams stream is currently unavailable.<br><br>' +
                                    'The stream segments are invalid or blocked after re-resolve.<br>' +
                                    'Try again in a minute or switch channel.'
                                );
                            }
                        } else {
                            console.error('Fatal HLS error:', data);
                        }
                    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        // Non-fatal media error - already handled in init(), skip duplicate handling
                    }
                });

                // Detect discontinuity changes (ad transitions) for logging only
                this.lastDiscontinuity = -1;
                this.hls.on(Hls.Events.FRAG_CHANGED, (event, data) => {
                    const frag = data.frag;
                    if (frag && frag.sn !== 'initSegment') {
                        // Log discontinuity changes for debugging
                        if (frag.cc !== undefined && frag.cc !== this.lastDiscontinuity) {
                            console.log(`[HLS] Discontinuity detected: CC ${this.lastDiscontinuity} -> ${frag.cc}`);
                            this.lastDiscontinuity = frag.cc;
                            // Note: maxAudioFramesDrift: 4 handles audio sync naturally
                            // No manual seeking needed - it can cause more issues than it solves
                        }
                    }
                });
            } else if (!isDlstreamsChannel && (
                this.video.canPlayType('application/vnd.apple.mpegurl') === 'probably' ||
                this.video.canPlayType('application/vnd.apple.mpegurl') === 'maybe'
            )) {
                // Priority 2: Native HLS support (Safari on iOS/macOS where HLS.js may not work)
                this.updateTranscodeStatus('direct', 'Direct Native');
                this.video.src = finalUrl;
                this.video.play().catch(e => {
                    if (e.name === 'AbortError') return; // Ignore interruption by new load
                    console.log('Autoplay prevented, trying proxy if CORS error:', e);
                    if (!this.isUsingProxy) {
                        this.isUsingProxy = true;
                        this.video.src = this.getProxiedUrl(streamUrl, channel.sourceId, channel?.proxyHeaders, channel);
                        this.video.play().catch(err => {
                            if (err.name !== 'AbortError') console.error('Proxy play failed:', err);
                        });
                    }
                });
            } else {
                if (isDlstreamsChannel && looksLikeHls) {
                    this.updateTranscodeStatus('error', 'HLS Unsupported');
                    this.showError('DLStreams HLS stream requires HLS.js support in this browser.');
                    return;
                }
                // Priority 3: Try direct playback for non-HLS streams
                this.updateTranscodeStatus('direct', 'Direct Play');
                this.video.src = finalUrl;
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
                });
            }

            // Update now playing info
            this.updateNowPlaying(channel);

            // Show the now playing overlay
            this.showNowPlayingOverlay();

            // Fetch EPG data for this channel
            this.fetchEpgData(channel);

            // Dispatch event
            window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));

        } catch (err) {
            console.error('Error playing channel:', err);
            this.showError('Failed to play channel');
        }
    }

    /**
     * DLStreams: force re-resolve and retry with fresh URL.
     * Shared by 503 handler and generic manifest-load-failure handler.
     */
    _dlstreamsForceReResolve(channel, dlChannelId) {
        fetch(`/api/scraper/dlstreams/resolve/${encodeURIComponent(dlChannelId)}?forceRefresh=true`, { cache: 'no-store' })
            .then(async (r) => {
                if (!r.ok) {
                    const e = await r.json().catch(() => ({}));
                    throw new Error(e.error || `Resolve failed (${r.status})`);
                }
                return r.json();
            })
            .then((resolved) => {
                if (!resolved || !resolved.streamUrl) {
                    throw new Error('Empty streamUrl from force resolve');
                }
                // If resolver returned the same dead URL, don't retry
                if (resolved.streamUrl === this.currentUrl) {
                    console.warn('[Player] DLStreams re-resolve returned same URL. CDN path is dead.');
                    throw new Error('CDN path is dead (same URL returned)');
                }
                if (resolved.proxyHeaders) {
                    channel.proxyHeaders = resolved.proxyHeaders;
                }
                this.currentUrl = resolved.streamUrl;
                const refreshedProxyUrl = this.getProxiedUrl(this.currentUrl, channel.sourceId, channel?.proxyHeaders, channel);
                console.log('[Player] DLStreams re-resolved. Retrying manifest via proxy...');
                if (!this.hls) return;
                this.hls.loadSource(refreshedProxyUrl);
                this.hls.startLoad();
            })
            .catch((err) => {
                console.error('[Player] DLStreams force re-resolve failed:', err.message || err);
                try { this.hls?.stopLoad(); } catch (_) { }
                try { this.hls?.destroy(); } catch (_) { }
                this.hls = null;
                this.showError(
                    'DLStreams stream is currently unavailable.<br><br>' +
                    'The CDN path for this channel is down or serving poisoned content.<br>' +
                    'Try again in a minute or switch channel.'
                );
            });
    }

    /**
     * Helper to play HLS stream (reduces duplication)
     */
    playHls(url, opts = {}) {
        if (this.hls) {
            this.hls.destroy();
        }

        this.hls = new Hls(this.getHlsConfig(opts));
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);

        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
            });
        });

        this.hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                // Simple error handling for forced HLS/transcode modes
                console.error('Fatal HLS error in transcode mode:', data);
                this.hls.destroy();
            }
        });
    }

    async updateTranscodeStatus(mode, text) {
        const el = document.getElementById('player-transcode-status');
        if (!el) return;

        el.className = 'transcode-status'; // Reset classes

        if (mode === 'hidden') {
            el.classList.add('hidden');
            return;
        }

        el.textContent = text || mode;
        el.classList.add(mode);

        // Ensure it's visible
        el.classList.remove('hidden');
    }

    /**
     * Get quality label from video height
     */
    getQualityLabel(height) {
        if (height >= 2160) return '4K';
        if (height >= 1440) return '1440p';
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height > 0) return `${height}p`;
        return null;
    }

    /**
     * Update quality badge display
     */
    updateQualityBadge() {
        const badge = document.getElementById('player-quality-badge');
        if (badge) {
            if (this.currentStreamInfo?.height > 0) {
                badge.textContent = this.getQualityLabel(this.currentStreamInfo.height);
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        const fpsBadge = document.getElementById('player-fps-badge');
        if (fpsBadge) {
            const fps = this.currentStreamInfo?.fps;
            if (fps > 0) {
                fpsBadge.textContent = `${fps} fps`;
                fpsBadge.classList.remove('hidden');
            } else {
                fpsBadge.classList.add('hidden');
            }
        }
    }

    /**
     * Fetch EPG data for current channel
     */
    async fetchEpgData(channel) {
        if (!channel || (!channel.tvgId && !channel.epg_id)) {
            this.updateNowPlaying(channel, null);
            return;
        }
        try {
            // First, try to use the centralized EpgGuide data (already loaded)
            if (window.app && window.app.epgGuide && window.app.epgGuide.programmes) {
                const epgGuide = window.app.epgGuide;

                // Get current program from EpgGuide
                const currentProgram = epgGuide.getCurrentProgram(channel.tvgId, channel.name);

                if (currentProgram) {
                    // Find upcoming programs from the guide's data
                    const epgChannel = epgGuide.channelMap?.get(channel.tvgId) ||
                        epgGuide.channelMap?.get(channel.name?.toLowerCase());

                    let upcoming = [];
                    if (epgChannel) {
                        const now = Date.now();
                        upcoming = epgGuide.programmes
                            .filter(p => p.channelId === epgChannel.id && new Date(p.start).getTime() > now)
                            .slice(0, 5)
                            .map(p => ({
                                title: p.title,
                                start: new Date(p.start),
                                stop: new Date(p.stop),
                                description: p.desc || ''
                            }));
                    }

                    this.updateNowPlaying(channel, {
                        current: {
                            title: currentProgram.title,
                            start: new Date(currentProgram.start),
                            stop: new Date(currentProgram.stop),
                            description: currentProgram.desc || ''
                        },
                        upcoming
                    });
                    return; // Success, exit early
                }
            }

            // Fallback: Try to get EPG from Xtream API if available
            if (channel.sourceType === 'xtream' && channel.streamId) {
                const epgData = await API.proxy.xtream.shortEpg(channel.sourceId, channel.streamId);
                if (epgData && epgData.epg_listings && epgData.epg_listings.length > 0) {
                    const listings = epgData.epg_listings;
                    const now = Math.floor(Date.now() / 1000);

                    // Find current program
                    const current = listings.find(p => {
                        const start = parseInt(p.start_timestamp);
                        const end = parseInt(p.stop_timestamp);
                        return start <= now && end > now;
                    });

                    // Get upcoming programs
                    const upcoming = listings
                        .filter(p => parseInt(p.start_timestamp) > now)
                        .slice(0, 5)
                        .map(p => ({
                            title: this.decodeBase64(p.title),
                            start: new Date(parseInt(p.start_timestamp) * 1000),
                            stop: new Date(parseInt(p.stop_timestamp) * 1000),
                            description: this.decodeBase64(p.description)
                        }));

                    if (current) {
                        this.updateNowPlaying(channel, {
                            current: {
                                title: this.decodeBase64(current.title),
                                start: new Date(parseInt(current.start_timestamp) * 1000),
                                stop: new Date(parseInt(current.stop_timestamp) * 1000),
                                description: this.decodeBase64(current.description)
                            },
                            upcoming
                        });
                    }
                }
            }
        } catch (err) {
            console.log('EPG data not available:', err.message);
        }
    }

    /**
     * Get proxied URL for a stream
     */
    getProxiedUrl(url, sourceId, extraHeaders, channel) {
        let proxiedUrl = `/api/proxy/stream?url=${encodeURIComponent(url)}`;
        if (sourceId) proxiedUrl += `&sourceId=${sourceId}`;
        const dlChannelId = channel?.tvgId && String(channel.tvgId).startsWith('dl_')
            ? String(channel.tvgId).replace('dl_', '')
            : null;
        if (dlChannelId) proxiedUrl += `&dlChannelId=${encodeURIComponent(dlChannelId)}`;
        if (extraHeaders && typeof extraHeaders === 'object') {
            try {
                proxiedUrl += `&headers=${encodeURIComponent(btoa(JSON.stringify(extraHeaders)))}`;
            } catch (e) {
                console.warn('[Player] Failed to encode proxy headers:', e.message);
            }
        }
        return proxiedUrl;
    }

    /**
     * Get transcoded URL for a stream (audio transcoding for browser compatibility)
     */
    getTranscodeUrl(url, sourceId) {
        let transcodeUrl = `/api/transcode?url=${encodeURIComponent(url)}`;
        if (sourceId) transcodeUrl += `&sourceId=${sourceId}`;
        return transcodeUrl;
    }

    /**
     * Get remuxed URL for a stream (container conversion only, no re-encoding)
     * Used for raw .ts streams that browsers can't play directly
     */
    getRemuxUrl(url, sourceId) {
        let remuxUrl = `/api/remux?url=${encodeURIComponent(url)}`;
        if (sourceId) remuxUrl += `&sourceId=${sourceId}`;
        return remuxUrl;
    }

    /**
     * Decode base64 EPG data
     */
    decodeBase64(str) {
        if (!str) return '';
        try {
            return decodeURIComponent(escape(atob(str)));
        } catch {
            return str;
        }
    }

    /**
     * Stop playback
     */
    stop() {
        // Stop any running transcode session first
        this.stopTranscodeSession();

        // Clear playback-start timeout
        clearTimeout(this._playbackStartTimeout);

        // Remove native error listener
        if (this._nativeErrorHandler) {
            this.video.removeEventListener('error', this._nativeErrorHandler);
            this._nativeErrorHandler = null;
        }
        if (this._onPlaybackStarted) {
            this.video.removeEventListener('playing', this._onPlaybackStarted);
            this._onPlaybackStarted = null;
        }

        if (this.hls) {
            this.video.pause();
            this.hls.destroy(); // internally calls detachMedia() which resets video.src
            this.hls = null;
            // Do NOT set video.src = '' here: hls.destroy() already cleaned up the media
            // element. A second src='' assignment resolves to the app root URL and fires
            // MEDIA_ERR_SRC_NOT_SUPPORTED, causing a spurious "Video error: 4" before the
            // next channel even starts loading.
        } else {
            this.video.pause();
            // Use removeAttribute rather than src='' to avoid the browser resolving '' as
            // the page URL and firing a media error.
            this.video.removeAttribute('src');
            this.video.load();
        }

        // Reset UI to idle state
        this.overlay.classList.remove('hidden'); // Show "Select a channel"
        this.controlsOverlay?.classList.add('hidden'); // Hide controls
        this.loadingSpinner?.classList.remove('show');
        this.nowPlaying.classList.add('hidden');

        // Hide quality badge
        this.currentStreamInfo = null;
        const badge = document.getElementById('player-quality-badge');
        if (badge) badge.classList.add('hidden');
        const fpsBadge = document.getElementById('player-fps-badge');
        if (fpsBadge) fpsBadge.classList.add('hidden');
    }

    /**
     * Update now playing display
     */
    updateNowPlaying(channel, epgData = null) {
        const channelName = this.nowPlaying.querySelector('.channel-name');
        const programTitle = this.nowPlaying.querySelector('.program-title');
        const programTime = this.nowPlaying.querySelector('.program-time');
        const upNextList = document.getElementById('up-next-list');

        channelName.textContent = channel.name || channel.tvgName || 'Unknown Channel';

        if (epgData && epgData.current) {
            programTitle.textContent = epgData.current.title;
            const start = new Date(epgData.current.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(epgData.current.stop).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            programTime.textContent = `${start} - ${end}`;
        } else {
            programTitle.textContent = '';
            programTime.textContent = '';
        }

        // Update up next
        upNextList.innerHTML = '';
        if (epgData && epgData.upcoming) {
            epgData.upcoming.slice(0, 3).forEach(prog => {
                const li = document.createElement('li');
                const time = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                li.textContent = `${time} - ${prog.title}`;
                upNextList.appendChild(li);
            });
        }
    }

    /**
     * Show error overlay
     */
    showError(message) {
        this.overlay.classList.remove('hidden');
        this.overlay.querySelector('.overlay-content').innerHTML = `<p style="color: var(--color-error);">${message}</p>`;
    }

    /**
     * Handle keyboard shortcuts
     */
    handleKeyboard(e) {
        if (document.activeElement.tagName === 'INPUT') return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                this.video.paused ? this.video.play() : this.video.pause();
                break;
            case 'f':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'm':
                e.preventDefault();
                this.video.muted = !this.video.muted;
                break;
            case 'ArrowUp':
                if (!this.settings.arrowKeysChangeChannel) {
                    e.preventDefault();
                    this.video.volume = Math.min(1, this.video.volume + 0.1);
                }
                // If arrowKeysChangeChannel is true, let HomePage handle it
                break;
            case 'ArrowDown':
                if (!this.settings.arrowKeysChangeChannel) {
                    e.preventDefault();
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                // If arrowKeysChangeChannel is true, let HomePage handle it
                break;
            case 'ArrowLeft':
                e.preventDefault();
                // Volume down when arrow keys are for channels
                if (this.settings.arrowKeysChangeChannel) {
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                // Volume up when arrow keys are for channels
                if (this.settings.arrowKeysChangeChannel) {
                    this.video.volume = Math.min(1, this.video.volume + 0.1);
                }
                break;
            case 'PageUp':
            case 'ChannelUp':
                e.preventDefault();
                this.channelUp();
                break;
            case 'PageDown':
            case 'ChannelDown':
                e.preventDefault();
                this.channelDown();
                break;
            case 'i':
                // Show/hide info overlay
                e.preventDefault();
                if (this.nowPlaying.classList.contains('hidden')) {
                    this.showNowPlayingOverlay();
                } else {
                    this.hideNowPlayingOverlay();
                }
                break;
        }
    }

    /**
     * Go to previous channel
     */
    channelUp() {
        if (!window.app?.channelList) return;
        const channels = window.app.channelList.getVisibleChannels();
        if (channels.length === 0) return;

        const currentIdx = this.currentChannel
            ? channels.findIndex(c => c.id === this.currentChannel.id)
            : -1;

        const prevIdx = currentIdx <= 0 ? channels.length - 1 : currentIdx - 1;
        window.app.channelList.selectChannel({ channelId: channels[prevIdx].id });
    }

    /**
     * Go to next channel
     */
    channelDown() {
        if (!window.app?.channelList) return;
        const channels = window.app.channelList.getVisibleChannels();
        if (channels.length === 0) return;

        const currentIdx = this.currentChannel
            ? channels.findIndex(c => c.id === this.currentChannel.id)
            : -1;

        const nextIdx = currentIdx >= channels.length - 1 ? 0 : currentIdx + 1;
        window.app.channelList.selectChannel({ channelId: channels[nextIdx].id });
    }

    /**
     * Toggle fullscreen
     */
    toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else if (this.container) {
            this.container.requestFullscreen();
        }
    }
}

// Export
window.VideoPlayer = VideoPlayer;
