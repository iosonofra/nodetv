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
        this.spinner = document.getElementById('player-loading-spinner');
        this.hls = null;
        this.shaka = null;
        this.currentChannel = null;
        this.overlayTimer = null;
        this.overlayDuration = 5000; // 5 seconds
        this.isUsingProxy = false;
        this.currentUrl = null;
        this.settingsLoaded = false;
        this.selectedQuality = -1; // -1 means Auto
        this.selectedAudioTrack = -1; // Current audio track ID
        this.showDebug = false;
        this.debugTimer = null;
        this.playbackStartTime = null;
        this.firstFrameTime = null;
        this.lastDecodedFrames = 0;
        this.lastFpsUpdate = performance.now();
        this.stallCount = 0;
        this.lastSegmentLoadTime = 0;
        this.lastManifestUpdate = 0;
        this.manifestUpdatePeriod = 0;
        this.licenseLatencies = [];
        this.lastDroppedFrames = 0;
        this.refreshRate = 0;
        this.gopSize = 0;

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
    getHlsConfig() {
        return {
            enableWorker: true,
            // Smooth & Fast buffer settings
            maxBufferLength: 20,           // Increased from 10s for better resilience
            maxMaxBufferLength: 40,
            maxBufferSize: 60 * 1024 * 1024,
            maxBufferHole: 0.5,
            // Stable Live stream settings
            liveSyncDurationCount: 3,    // Industry standard (was 1.5)
            liveMaxLatencyDurationCount: 6,
            liveBackBufferLength: 0,
            // Discovery/Loading speed
            manifestLoadingTimeOut: 10000,
            manifestLoadingMaxRetry: 3,
            levelLoadingTimeOut: 10000,
            levelLoadingMaxRetry: 3,
            // Low latency optimizations
            lowLatencyMode: true,
            // Audio stability
            maxAudioFramesDrift: 8,
            stretchShortVideoTrack: true,
            forceKeyFrameOnDiscontinuity: true,
            progressive: false
        };
    }

    /**
     * Initialize custom video controls
     */
    initCustomControls() {
        // Elements for custom controls
        const btnPlay = document.getElementById('btn-play');
        const btnMute = document.getElementById('btn-mute');
        const btnPip = document.getElementById('btn-pip');
        const btnFullscreen = document.getElementById('btn-fullscreen');
        const btnQuality = document.getElementById('btn-quality');
        const qualityMenu = document.getElementById('quality-menu');
        const btnAudio = document.getElementById('btn-audio');
        const audioMenu = document.getElementById('audio-menu');
        const controls = document.getElementById('video-controls-container');
        const btnBack10 = document.getElementById('btn-back-10');
        const btnForward10 = document.getElementById('btn-forward-10');
        const btnInfo = document.getElementById('btn-info');
        this.centerFeedback = document.getElementById('player-center-feedback');

        // Progress Bar Elements
        const progressContainer = document.getElementById('progress-container');
        const progressCurrent = document.getElementById('progress-current');
        const progressBuffer = document.getElementById('progress-buffer');
        const progressHandle = document.getElementById('progress-handle');
        const progressTooltip = document.getElementById('progress-time-tooltip');

        // Volume Elements
        const volumeSlider = document.getElementById('control-volume-slider');
        const currentTimeEl = document.getElementById('current-time');
        const durationTimeEl = document.getElementById('duration-time');
        const liveIndicator = document.getElementById('live-indicator');
        const btnGoLive = document.getElementById('btn-go-live');

        if (!btnPlay || !btnMute || !btnPip || !btnFullscreen || !controls || !btnQuality || !qualityMenu || !btnAudio || !audioMenu) return;

        // Hide native controls
        this.video.controls = false;

        // Play/Pause button
        btnPlay.addEventListener('click', () => {
            if (this.video.paused) {
                this.video.play();
                this.showCenterFeedback('play');
            } else {
                this.video.pause();
                this.showCenterFeedback('pause');
            }
        });

        // Skip buttons
        if (btnBack10) {
            btnBack10.addEventListener('click', () => {
                this.video.currentTime = Math.max(0, this.video.currentTime - 10);
                this.showCenterFeedback('back');
            });
        }

        if (btnForward10) {
            btnForward10.addEventListener('click', () => {
                if (this.video.duration) {
                    this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 10);
                    this.showCenterFeedback('forward');
                }
            });
        }

        // Double Click to Seek Logic
        this.video.addEventListener('dblclick', (e) => {
            const rect = this.video.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const w = rect.width;

            if (x < w / 2) {
                // Left side - back 10s
                this.video.currentTime = Math.max(0, this.video.currentTime - 10);
                this.showCenterFeedback('back');
            } else {
                // Right side - forward 10s
                if (this.video.duration) {
                    this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 10);
                    this.showCenterFeedback('forward');
                }
            }
        });

        // Update play/pause icon
        const updatePlayIcon = () => {
            const icon = btnPlay.querySelector('.icon');
            if (this.video.paused) {
                icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
                btnPlay.title = 'Play';
            } else {
                icon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
                btnPlay.title = 'Pause';
            }
        };

        this.video.addEventListener('play', updatePlayIcon);
        this.video.addEventListener('pause', updatePlayIcon);

        // Mute/Unmute button
        btnMute.addEventListener('click', () => {
            this.video.muted = !this.video.muted;
        });

        // Update mute icon and volume slider
        const updateMuteState = () => {
            btnMute.classList.toggle('muted', this.video.muted);
            const icon = btnMute.querySelector('.icon');
            if (this.video.muted || this.video.volume === 0) {
                icon.innerHTML = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
                volumeSlider.value = 0;
            } else {
                icon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
                volumeSlider.value = this.video.volume * 100;
            }
        };

        this.video.addEventListener('volumechange', updateMuteState);
        volumeSlider.addEventListener('input', () => {
            const val = parseInt(volumeSlider.value);
            this.video.volume = val / 100;
            if (val > 0) this.video.muted = false;
        });

        // Picture-in-Picture button
        if (document.pictureInPictureEnabled) {
            btnPip.addEventListener('click', async () => {
                try {
                    if (document.pictureInPictureElement) {
                        await document.exitPictureInPicture();
                    } else {
                        await this.video.requestPictureInPicture();
                    }
                } catch (err) {
                    console.error('PiP error:', err);
                }
            });
        } else {
            btnPip.style.display = 'none';
        }

        // Fullscreen button
        btnFullscreen.addEventListener('click', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                this.container.requestFullscreen().catch(err => {
                    console.error('Fullscreen error:', err);
                });
            }
        });

        // Quality selection button
        btnQuality.addEventListener('click', (e) => {
            e.stopPropagation();
            audioMenu.classList.add('hidden'); // Close other menu
            qualityMenu.classList.toggle('hidden');
            if (!qualityMenu.classList.contains('hidden')) {
                this.updateQualityMenu();
            }
        });

        // Audio selection button
        btnAudio.addEventListener('click', (e) => {
            e.stopPropagation();
            qualityMenu.classList.add('hidden'); // Close other menu
            audioMenu.classList.toggle('hidden');
            if (!audioMenu.classList.contains('hidden')) {
                this.updateAudioMenu();
            }
        });

        // Info button to show OSD
        if (btnInfo) {
            btnInfo.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showNowPlayingOverlay();
            });
        }

        // Close menus when clicking outside
        document.addEventListener('click', () => {
            qualityMenu.classList.add('hidden');
            audioMenu.classList.add('hidden');
        });

        // Progress Bar Logic
        const formatTime = (seconds) => {
            if (isNaN(seconds)) return '0:00';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            if (h > 0) {
                return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            }
            return `${m}:${s.toString().padStart(2, '0')}`;
        };

        const getSeekableRange = () => {
            if (this.shaka && this.shaka.isLive()) {
                const range = this.shaka.seekRange();
                return { start: range.start, end: range.end, isLive: true };
            }
            if (this.hls && this.video.duration === Infinity) {
                // HLS.js live logic
                const liveSync = this.hls.liveSyncPosition || this.video.duration;
                if (this.video.seekable.length > 0) {
                    return { start: this.video.seekable.start(0), end: this.video.seekable.end(this.video.seekable.length - 1), isLive: true };
                }
            }
            if (!isFinite(this.video.duration) || this.video.duration > 86400) {
                if (this.video.seekable.length > 0) {
                    return { start: this.video.seekable.start(0), end: this.video.seekable.end(this.video.seekable.length - 1), isLive: true };
                }
            }

            return { start: 0, end: this.video.duration, isLive: false };
        };

        const updateProgress = () => {
            const range = getSeekableRange();
            const duration = range.end - range.start;
            const currentTime = this.video.currentTime;

            if (duration > 0 && isFinite(duration) && (!range.isLive || duration > 30)) {
                // If VOD, or Live stream with a DVR window > 30s
                let percent = 0;
                if (range.isLive) {
                    percent = ((currentTime - range.start) / duration) * 100;
                    // Format time as negative offset from live edge, e.g. -00:05:00
                    const offset = range.end - currentTime;
                    if (offset > 10) {
                        currentTimeEl.textContent = `-${formatTime(offset)}`;
                        if (btnGoLive) btnGoLive.classList.remove('hidden');
                    } else {
                        currentTimeEl.textContent = 'Live';
                        if (btnGoLive) btnGoLive.classList.add('hidden');
                    }
                    durationTimeEl.textContent = '';
                } else {
                    percent = (currentTime / range.end) * 100;
                    currentTimeEl.textContent = formatTime(currentTime);
                    durationTimeEl.textContent = formatTime(range.end);
                    if (btnGoLive) btnGoLive.classList.add('hidden');
                }

                // Clamp percent
                percent = Math.max(0, Math.min(100, percent));

                progressCurrent.style.width = `${percent}%`;
                progressHandle.style.left = `${percent}%`;
                progressContainer.classList.remove('hidden');
                liveIndicator.classList.add('hidden');

                // Buffer
                if (this.video.buffered.length > 0) {
                    const bufferedEnd = this.video.buffered.end(this.video.buffered.length - 1);
                    const bufferPercent = ((bufferedEnd - range.start) / duration) * 100;
                    progressBuffer.style.width = `${Math.max(0, Math.min(100, bufferPercent))}%`;
                }

            } else {
                // Truly live without DVR, or starting up
                progressContainer.classList.add('hidden');
                liveIndicator.classList.remove('hidden');
                if (btnGoLive) btnGoLive.classList.add('hidden');
                currentTimeEl.textContent = formatTime(currentTime);
                durationTimeEl.textContent = 'Live';
            }
        };

        if (btnGoLive) {
            btnGoLive.addEventListener('click', (e) => {
                e.stopPropagation();
                const range = getSeekableRange();
                if (range.isLive && isFinite(range.end)) {
                    this.video.currentTime = range.end;
                    this.showCenterFeedback('forward');
                }
            });
        }

        this.video.addEventListener('timeupdate', updateProgress);
        this.video.addEventListener('loadedmetadata', updateProgress);

        // Seek on click
        progressContainer.addEventListener('click', (e) => {
            const rect = progressContainer.getBoundingClientRect();
            const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const range = getSeekableRange();
            if (isFinite(range.end)) {
                if (range.isLive) {
                    this.video.currentTime = range.start + (pos * (range.end - range.start));
                } else {
                    this.video.currentTime = pos * range.end;
                }
            }
        });

        // Tooltip on hover
        progressContainer.addEventListener('mousemove', (e) => {
            const rect = progressContainer.getBoundingClientRect();
            const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const range = getSeekableRange();

            progressTooltip.style.left = `${pos * 100}%`;

            if (range.isLive) {
                const targetTime = range.start + (pos * (range.end - range.start));
                const offset = range.end - targetTime;
                progressTooltip.textContent = offset > 10 ? `-${formatTime(offset)}` : 'Live';
            } else {
                progressTooltip.textContent = formatTime(pos * range.end);
            }
        });

        // Show/Hide controls
        let controlsTimeout;
        const showControls = () => {
            controls.classList.add('show');
            this.container.style.cursor = 'default';
            clearTimeout(controlsTimeout);

            // Don't auto-hide if a menu is open or video is paused
            const isMenuOpen = !qualityMenu.classList.contains('hidden') || !audioMenu.classList.contains('hidden');

            if (!this.video.paused && !isMenuOpen) {
                controlsTimeout = setTimeout(() => {
                    controls.classList.remove('show');
                    this.container.style.cursor = 'none';
                }, 3000);
            }
        };

        this.video.addEventListener('mousemove', showControls);
        this.video.addEventListener('mousedown', showControls);
        this.video.addEventListener('touchstart', showControls);
        this.video.addEventListener('play', showControls);
        this.video.addEventListener('pause', () => {
            controls.classList.add('show');
            this.container.style.cursor = 'default';
            clearTimeout(controlsTimeout);
        });

        // Update fullscreen icon
        document.addEventListener('fullscreenchange', () => {
            const icon = btnFullscreen.querySelector('.icon');
            if (document.fullscreenElement) {
                icon.innerHTML = '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>';
            } else {
                icon.innerHTML = '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>';
            }
        });
    }

    async initShaka() {
        if (!window.shaka) return;
        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) return;

        // Create player once and keep it alive for reuse
        this.shaka = new shaka.Player(this.video);

        // Apply global refined config
        this.shaka.configure({
            manifest: {
                dash: {
                    ignoreMinBufferTime: true,
                    ignoreSuggestedPresentationDelay: true,
                    autoCorrectDrift: true,
                    xhrWithCredentials: true
                },
                retryParameters: { maxAttempts: 5, baseDelay: 1000, backoffFactor: 2 }
            },
            streaming: {
                bufferingGoal: 45,           // Solid 45s buffer for deep stability
                rebufferingGoal: 4.0,        // Secure 4s cushion at start/recovery
                bufferBehind: 30,
                lowLatencyMode: false,       // Priority to STABILITY over latency for IPTV
                segmentPrefetchLimit: 5,     // Balanced prefetching
                stallThreshold: 6,           // More patient with network hiccups
                safeSeekOffset: 15,          // Safer distance from the live edge
                smallGapLimit: 1.0,          // Skip gaps up to 1s
                jumpLargeGaps: true,         // Never let the player get stuck
                inaccurateManifestTolerance: 1.0,
                ignoreTextStreamFailures: true
            },
            abr: {
                enabled: true,
                defaultBandwidthEstimate: 10000000
            }
        });

        this.shaka.addEventListener('error', (event) => {
            if (event.detail && event.detail.severity === 2) {
                console.error('[Shaka] Critical error:', event.detail.code);
            }
        });

        console.log('[Player] Shaka Player ready (reusable instance)');
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

        // Estimate refresh rate
        this.estimateRefreshRate();

        // Initialize HLS.js if supported
        if (Hls.isSupported()) {
            this.hls = new Hls(this.getHlsConfig());
            this.lastDiscontinuity = -1; // Track discontinuity changes

            // Global stall detection
            this.video.addEventListener('waiting', () => {
                if (this.showDebug) {
                    this.stallCount++;
                    console.log('[Debug] Stall detected, total:', this.stallCount);
                }
            });

            this.hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
                if (data.stats) {
                    this.lastSegmentLoadTime = Math.round(data.stats.loading.end - data.stats.loading.start);
                    if (data.frag && data.frag.duration) {
                        this.gopSize = data.frag.duration;
                    }
                }
            });

            this.hls.on(Hls.Events.MANIFEST_LOADED, (event, data) => {
                const now = Date.now();
                if (this.lastManifestUpdate > 0) {
                    this.manifestUpdatePeriod = (now - this.lastManifestUpdate) / 1000;
                }
                this.lastManifestUpdate = now;
            });

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
                                const proxiedUrl = this.getProxiedUrl(this.currentUrl, this.currentChannel?.sourceId);
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

            this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.video.play().catch(e => console.log('Autoplay prevented:', e));
            });
        }

        // Keyboard controls
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Click on video shows overlay
        this.video.addEventListener('click', () => this.showNowPlayingOverlay());

        // Ambient Mode
        this.initAmbientMode();
    }

    /**
     * Ambient Mode - Draws a blurred version of the video behind the player
     */
    initAmbientMode() {
        const canvas = document.getElementById('ambient-canvas');
        const container = document.querySelector('.ambient-glow-container');
        if (!canvas || !container) return;

        const ctx = canvas.getContext('2d', { alpha: false });
        let animationId = null;

        // Small offscreen canvas for sampling
        const sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = 16;
        sampleCanvas.height = 9;
        const sampleCtx = sampleCanvas.getContext('2d', { alpha: false });

        const updateAmbient = () => {
            if (this.video.paused || this.video.ended) {
                container.style.opacity = '0';
                animationId = requestAnimationFrame(updateAmbient);
                return;
            }

            container.style.opacity = '0.6';

            // Draw video to small sample canvas first (fast)
            sampleCtx.drawImage(this.video, 0, 0, sampleCanvas.width, sampleCanvas.height);

            // Draw sample canvas to main canvas (will be blurred by CSS)
            ctx.drawImage(sampleCanvas, 0, 0, canvas.width, canvas.height);

            // Run at ~10fps to save resources while keeping it smooth enough
            setTimeout(() => {
                animationId = requestAnimationFrame(updateAmbient);
            }, 100);
        };

        // Initialize canvas size
        const resize = () => {
            canvas.width = 64; // Low res is enough since CSS blurs it anyway
            canvas.height = 36;
        };

        window.addEventListener('resize', resize);
        resize();
        updateAmbient();
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

        // Note: The player controls also have their own show/hide logic
        // in initCustomControls to hide when the mouse stops moving.

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
     * Play a channel
     */
    async play(channel, streamUrl) {
        this.currentChannel = channel;

        try {
            // Stop current playback
            await this.stop();

            this.playbackStartTime = Date.now();
            this.firstFrameTime = null;

            if (this.spinner) {
                this.spinner.classList.remove('hidden');
            }

            if (this.offlineTimer) clearTimeout(this.offlineTimer);
            this.offlineTimer = setTimeout(() => {
                this.stop();
                this.showError('Il canale è offline');
            }, 45000);

            // Listen for first frame
            this.video.onevent_playing = (e) => {
                if (this.offlineTimer) clearTimeout(this.offlineTimer);
                if (this.spinner) {
                    this.spinner.classList.add('hidden');
                }
                if (!this.firstFrameTime) {
                    this.firstFrameTime = Date.now();
                }
            };
            this.video.addEventListener('playing', this.video.onevent_playing, { once: true });

            // Hide "select a channel" overlay
            this.overlay.classList.add('hidden');

            // Toggle sidebar visibility based on VOD status (movies/series)
            const homeLayout = document.querySelector('.home-layout');
            if (homeLayout) {
                if (channel.isVod) {
                    homeLayout.classList.add('no-sidebar');
                } else {
                    homeLayout.classList.remove('no-sidebar');
                }
            }

            // Determine if HLS or direct stream
            this.currentUrl = streamUrl;

            // CHECK: Force Transcode Priority - transcoded streams bypass HLS.js
            if (this.settings.forceTranscode) {
                console.log('[Player] Force Transcode enabled. Routing through ffmpeg...');
                const transcodeUrl = this.getTranscodeUrl(streamUrl);
                this.currentUrl = transcodeUrl;

                // Transcoded streams are fragmented MP4 - play directly with <video> element
                console.log('[Player] Playing transcoded stream directly:', transcodeUrl);
                this.video.src = transcodeUrl;
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.log('[Player] Autoplay prevented:', e);
                });

                // Update UI and dispatch events
                this.updateNowPlaying(channel);
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return; // Exit early - don't use HLS.js path
            }

            // DRM / Adaptive Metadata detection from channel data
            let drmConfig = channel.drmConfig;
            if (!drmConfig && channel.data) {
                try {
                    const dataObj = typeof channel.data === 'string' ? JSON.parse(channel.data) : channel.data;
                    drmConfig = dataObj.drmConfig;
                } catch (e) {
                    console.warn('[Player] Failed to parse channel.data for DRM config');
                }
            }
            const isMpd = streamUrl.includes('.mpd') || (drmConfig && drmConfig.manifestType === 'mpd');
            const hasDrm = drmConfig && (drmConfig.licenseKey || drmConfig.licenseType);

            if (isMpd || hasDrm) {
                console.log('[Player] Managed adaptive stream detected (MPD/DRM). Using Shaka Player...');
                await this.playShaka(channel, streamUrl, drmConfig);
                return;
            }

            // HTTPS Upgrade: Bypass Mixed Content on Alpine
            // If the app is served via HTTPS (via Cloudflared), the browser blocks direct HTTP streams.
            // Upgrading the stream URL to HTTPS prevents Mixed Content and avoids routing through our 
            // backend proxy, bypassing Cloudflare's strict Node.js HTTP 403 blocks.
            if (window.location.protocol === 'https:' && streamUrl.startsWith('http://') && !streamUrl.startsWith(window.location.origin)) {
                console.log('[Player] Upgrading HTTP stream to HTTPS to avoid Mixed Content...');
                streamUrl = streamUrl.replace('http://', 'https://');
                this.currentUrl = streamUrl; // Ensure fallback proxy uses the HTTPS version
            }

            // Proactively use proxy for:
            // 1. User enabled "Force Proxy" in settings
            // 2. Known CORS-restricted domains (like Pluto TV)
            const proxyRequiredDomains = ['pluto.tv'];
            const alreadyProxied = streamUrl.startsWith('/api/');
            const isXtream = channel && channel.sourceType === 'xtream';

            // CRITICAL: NEVER proactively proxy Xtream streams locally. Cloudflare always 403 blocks our Node.js proxy.
            // We must let it fail with CORS so it triggers the external proxy fallback (corsproxy.io)
            const needsProxy = !alreadyProxied && !isXtream && (this.settings.forceProxy || proxyRequiredDomains.some(domain => streamUrl.includes(domain)));

            this.isUsingProxy = needsProxy;
            const finalUrl = needsProxy ? this.getProxiedUrl(streamUrl, channel.sourceId) : streamUrl;

            // Detect if this is likely an HLS stream (has .m3u8 in URL)
            const looksLikeHls = finalUrl.includes('.m3u8') || finalUrl.includes('m3u8');

            // Check if this looks like a raw stream (no HLS manifest, no common video extensions)
            // This includes .ts files AND extension-less URLs that might be TS streams
            const isRawTs = finalUrl.includes('.ts') && !finalUrl.includes('.m3u8');
            const isExtensionless = !finalUrl.includes('.m3u8') &&
                !finalUrl.includes('.mp4') &&
                !finalUrl.includes('.mkv') &&
                !finalUrl.includes('.avi') &&
                !finalUrl.includes('.ts');

            // Force Remux: Route through FFmpeg for container conversion
            // Applies to: 1) .ts streams when detected, or 2) ALL non-HLS streams when enabled
            if (this.settings.forceRemux && (isRawTs || isExtensionless)) {
                console.log('[Player] Force Remux enabled. Routing through FFmpeg remux...');
                console.log('[Player] Stream type:', isRawTs ? 'Raw TS' : 'Extension-less (assumed TS)');
                const remuxUrl = this.getRemuxUrl(streamUrl);
                this.video.src = remuxUrl;
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.log('[Player] Autoplay prevented:', e);
                });

                // Update UI and dispatch events
                this.updateNowPlaying(channel);
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return;
            }

            // If raw TS detected without Force Remux enabled, show error
            if (isRawTs && !this.settings.forceRemux) {
                console.warn('[Player] Raw MPEG-TS stream detected. Browsers cannot play .ts files directly.');
                this.showError(
                    'This stream uses raw MPEG-TS format (.ts) which browsers cannot play directly.<br><br>' +
                    '<strong>To fix this:</strong><br>' +
                    '1. Enable <strong>"Force Remux"</strong> in Settings → Streaming<br>' +
                    '2. Or configure your source to output HLS (.m3u8) format'
                );
                return;
            }

            // Priority 1: Use HLS.js for HLS streams on browsers that support it
            if (looksLikeHls && Hls.isSupported()) {
                this.hls = new Hls(this.getHlsConfig());
                this.hls.loadSource(finalUrl);
                this.hls.attachMedia(this.video);

                this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    this.video.play().catch(e => {
                        if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
                    });
                });

                // Re-attach error handler for the new Hls instance
                this.hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        // CORS issues can manifest as NETWORK_ERROR or MEDIA_ERROR with fragParsingError
                        const isCorsLikely = data.type === Hls.ErrorTypes.NETWORK_ERROR ||
                            (data.type === Hls.ErrorTypes.MEDIA_ERROR && data.details === 'fragParsingError');

                        if (isCorsLikely && !this.isUsingProxy) {
                            console.log('CORS/Network error detected, retrying via proxy...', data.details);
                            this.isUsingProxy = true;

                            if (channel && channel.sourceType === 'xtream') {
                                // Fallback to external CORS proxy to bypass Cloudflare Node.js blocks
                                // allorigins supports raw proxying including binary streams
                                const corsProxy = 'https://api.allorigins.win/raw?url=';
                                console.log('[Player] Using external CORS proxy for Xtream stream to evade Cloudflare WAF...');
                                this.hls.loadSource(corsProxy + encodeURIComponent(this.currentUrl));
                            } else {
                                this.hls.loadSource(this.getProxiedUrl(this.currentUrl, channel?.sourceId));
                            }

                            this.hls.startLoad();
                        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                            // Fatal media error - try recovery with cooldown
                            const now = Date.now();
                            if (now - (this.lastRecoveryAttempt || 0) > 2000) {
                                console.log('Fatal media error, attempting recovery...');
                                this.lastRecoveryAttempt = now;
                                this.hls.recoverMediaError();
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
            } else if (this.video.canPlayType('application/vnd.apple.mpegurl') === 'probably' ||
                this.video.canPlayType('application/vnd.apple.mpegurl') === 'maybe') {
                // Priority 2: Native HLS support (Safari on iOS/macOS where HLS.js may not work)
                this.video.src = finalUrl;
                this.video.play().catch(e => {
                    if (e.name === 'AbortError') return; // Ignore interruption by new load
                    console.log('Autoplay prevented, trying proxy if CORS error:', e);
                    if (!this.isUsingProxy) {
                        this.isUsingProxy = true;
                        this.video.src = this.getProxiedUrl(streamUrl, channel.sourceId);
                        this.video.play().catch(err => {
                            if (err.name !== 'AbortError') console.error('Proxy play failed:', err);
                        });
                    }
                });
            } else {
                // Priority 3: Try direct playback for non-HLS streams
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
     * Fetch EPG data for current channel
     */
    async fetchEpgData(channel) {
        try {
            // Ensure EPG guide is loaded or loading
            if (window.app && window.app.epgGuide) {
                const epgGuide = window.app.epgGuide;

                // If no data yet, trigger a background load (don't await it to avoid blocking UI)
                if (!epgGuide.programmes || epgGuide.programmes.length === 0) {
                    if (!this.epgLoadAttempted) {
                        this.epgLoadAttempted = true;
                        console.log('[Player] EPG data empty, triggering background load');
                        epgGuide.loadEpg().finally(() => {
                            // Re-fetch once loaded to update the UI
                            this.fetchEpgData(channel);
                        });
                    }
                    // Immediately try Xtream API fallback while EpgGuide loads in background
                } else {
                    // Try to get current program from central EpgGuide
                    const currentProgram = epgGuide.getCurrentProgram(channel.tvgId, channel.name);

                    if (currentProgram) {
                        // Try to find the exact EPG channel to get upcoming programs
                        const epgChannel = epgGuide.channelMap?.get(channel.tvgId) ||
                            epgGuide.channelMap?.get(channel.name?.toLowerCase());

                        let upcoming = [];
                        if (epgChannel) {
                            const now = Date.now();
                            upcoming = epgGuide.programmes
                                .filter(p => p.channelId === epgChannel.id && new Date(p.start).getTime() > now)
                                .sort((a, b) => new Date(a.start) - new Date(b.start))
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
            }

            // Fallback: Try to get EPG from Xtream API if available
            if (channel.sourceType === 'xtream' && channel.streamId) {
                console.log('[Player] Central EPG miss, falling back to Xtream short_epg');
                // Use the route we just added to proxy.js
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
                        .sort((a, b) => parseInt(a.start_timestamp) - parseInt(b.start_timestamp))
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
                        return; // Success
                    }
                }
            }

            // If we reach here, no EPG was found
            this.updateNowPlaying(channel, null);
        } catch (err) {
            console.log('EPG data fetch error:', err.message);
            this.updateNowPlaying(channel, null);
        }
    }

    /**
     * Get proxied URL for a stream
     */
    getProxiedUrl(url, sourceId = null) {
        let proxiedUrl = `/api/proxy/stream?url=${encodeURIComponent(url)}`;
        if (sourceId) proxiedUrl += `&sourceId=${sourceId}`;
        return proxiedUrl;
    }

    /**
     * Get transcoded URL for a stream (audio transcoding for browser compatibility)
     */
    getTranscodeUrl(url) {
        return `/api/transcode?url=${encodeURIComponent(url)}`;
    }

    /**
     * Get remuxed URL for a stream (container conversion only, no re-encoding)
     * Used for raw .ts streams that browsers can't play directly
     */
    getRemuxUrl(url) {
        return `/api/remux?url=${encodeURIComponent(url)}`;
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
     * Play a stream using Shaka Player (DASH/Widevine/ClearKey)
     */
    async playShaka(channel, streamUrl, drmConfig) {
        if (!window.shaka) {
            this.showError('Shaka Player library not loaded');
            return;
        }

        if (!this.shaka) {
            await this.initShaka();
        }

        try {
            // Reset filters to avoid accumulation on reuse
            this.shaka.getNetworkingEngine().clearAllRequestFilters();
            this.shaka.getNetworkingEngine().clearAllResponseFilters();

            // WARP Proxy: Route all manifest/segment requests through server-side WARP proxy
            if (channel.useWarp) {
                console.log('[Shaka] WARP enabled for source', channel.sourceId, '- proxying all requests through server');
                this.shaka.getNetworkingEngine().registerRequestFilter((type, request) => {
                    if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST ||
                        type === shaka.net.NetworkingEngine.RequestType.SEGMENT) {
                        const originalUrl = request.uris[0];
                        if (originalUrl && !originalUrl.startsWith('/api/')) {
                            request.uris[0] = `/api/proxy/stream?url=${encodeURIComponent(originalUrl)}&sourceId=${channel.sourceId}`;
                        }
                    }
                });
            }

            // Configure DRM if needed
            if (drmConfig) {
                const servers = {};
                const clearKeys = {};

                // Normalize "clearkey" to "org.w3.clearkey"
                let licenseType = drmConfig.licenseType || 'com.widevine.alpha';
                if (licenseType.toLowerCase() === 'clearkey') {
                    licenseType = 'org.w3.clearkey';
                }

                const licenseKey = drmConfig.licenseKey;

                // Helper to decode Base64Url to Hex
                const base64ToHex = (str) => {
                    try {
                        let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
                        while (b64.length % 4 !== 0) b64 += '=';
                        const raw = atob(b64);
                        let hex = '';
                        for (let i = 0; i < raw.length; i++) {
                            const h = raw.charCodeAt(i).toString(16);
                            hex += (h.length === 2 ? h : '0' + h);
                        }
                        return hex.toLowerCase();
                    } catch (e) {
                        return str; // Return original if not valid base64
                    }
                };

                const isHex = (str) => /^[0-9a-fA-F]+$/.test(str) && str.length % 2 === 0;

                if (licenseKey) {
                    if (licenseKey.startsWith('http')) {
                        servers[licenseType] = licenseKey;
                    } else if (licenseKey.includes(':')) {
                        // Handle comma-separated multiple keys (e.g. kid1:key1,kid2:key2)
                        const keyPairs = licenseKey.split(',');
                        keyPairs.forEach(pair => {
                            let [kid, key] = pair.trim().split(':');
                            if (kid && key) {
                                // Shaka Player requires Hex format for kid/key
                                if (!isHex(kid)) kid = base64ToHex(kid);
                                if (!isHex(key)) key = base64ToHex(key);
                                clearKeys[kid] = key;
                            }
                        });
                        console.log(`[Player] Loaded ${Object.keys(clearKeys).length} ClearKey(s)`);
                    }
                }

                this.shaka.configure({
                    drm: {
                        servers: servers,
                        clearKeys: clearKeys,
                        retryParameters: { maxAttempts: 3, baseDelay: 500, backoffFactor: 2 }
                    }
                });

                // RESTORE: Handle custom User-Agent or other headers (Crucial for DRM)
                if (drmConfig.headers) {
                    const headersArray = drmConfig.headers.split('&');
                    const headersObj = {};
                    headersArray.forEach(h => {
                        const [k, v] = h.split('=');
                        if (k && v) {
                            headersObj[k.trim()] = decodeURIComponent(v.trim());
                        }
                    });

                    this.shaka.getNetworkingEngine().registerRequestFilter((type, request) => {
                        for (const [k, v] of Object.entries(headersObj)) {
                            request.headers[k] = v;
                        }
                    });
                }
            }

            // RESTORE: Nerd Stats filters
            this.shaka.getNetworkingEngine().registerResponseFilter((type, response) => {
                const now = Date.now();
                if (type === shaka.net.NetworkingEngine.RequestType.SEGMENT) {
                    this.lastSegmentLoadTime = Math.round(response.timeMs);
                } else if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
                    this.licenseLatencies.push(response.timeMs);
                    if (this.licenseLatencies.length > 5) this.licenseLatencies.shift();
                } else if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
                    if (this.lastManifestUpdate > 0) {
                        this.manifestUpdatePeriod = (now - this.lastManifestUpdate) / 1000;
                    }
                    this.lastManifestUpdate = now;
                }
            });

            // Load and play
            await this.shaka.load(streamUrl);

            this.updateNowPlaying(channel);
            this.fetchEpgData(channel);
            window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));

            this.video.play().catch(() => { });
        } catch (err) {
            console.error('[Shaka] Load failed:', err);
            let errMsg = 'DRM Playback failed';

            // Check for insecure context (HTTP over network) which blocks EME
            if (drmConfig && !window.isSecureContext) {
                errMsg = 'DRM (Error 6001): Requires HTTPS or localhost. Browser blocked keys on insecure HTTP network IP.';
            } else if (err.code) {
                errMsg += ` (Error ${err.code})`;
            } else if (err.message) {
                errMsg += `: ${err.message}`;
            } else {
                errMsg += ': Check connection';
            }
            this.showError(errMsg);
        }
    }

    /**
     * Update the quality selection menu with available tracks
     */
    updateQualityMenu() {
        const qualityList = document.getElementById('quality-list');
        if (!qualityList) return;

        // Clear existing list except "Auto"
        qualityList.innerHTML = `<li data-level="-1" class="${this.selectedQuality === -1 ? 'active' : ''}">Auto</li>`;

        let tracks = [];

        if (this.shaka) {
            // Shaka Player: Get all variant tracks
            const allTracks = this.shaka.getVariantTracks();
            // Filter out duplicate resolutions and sort by height
            const seenRes = new Set();
            tracks = allTracks
                .filter(t => {
                    const res = `${t.width}x${t.height}`;
                    if (seenRes.has(res)) return false;
                    seenRes.add(res);
                    return true;
                })
                .sort((a, b) => b.height - a.height)
                .map(t => ({
                    id: t.id,
                    label: t.height ? `${t.height}p` : `${t.bandwidth}bps`,
                    height: t.height,
                    active: t.active
                }));
        } else if (this.hls) {
            // HLS.js: Get levels
            tracks = this.hls.levels.map((level, index) => ({
                id: index,
                label: level.height ? `${level.height}p` : `${level.name || index}`,
                height: level.height,
                active: this.hls.currentLevel === index
            }));
        }

        // Add tracks to UI
        tracks.forEach(track => {
            const li = document.createElement('li');
            li.dataset.level = track.id;
            if (track.active && this.selectedQuality !== -1) {
                li.classList.add('active');
            }
            li.textContent = track.label;

            li.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setQuality(track.id);
                document.getElementById('quality-menu').classList.add('hidden');
            });

            qualityList.appendChild(li);
        });

        // Handle "Auto" click
        const autoOption = qualityList.querySelector('li[data-level="-1"]');
        if (autoOption) {
            autoOption.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setQuality(-1);
                document.getElementById('quality-menu').classList.add('hidden');
            });
        }
    }

    /**
     * Set playback quality
     * @param {number|string} levelId - Track ID or level index, -1 for Auto
     */
    setQuality(levelId) {
        this.selectedQuality = levelId;
        console.log('[Player] Setting quality to:', levelId);

        if (this.shaka) {
            if (levelId === -1) {
                // Set to Auto (Enable ABR)
                this.shaka.configure({ abr: { enabled: true } });
            } else {
                // Disable ABR and select specific track
                this.shaka.configure({ abr: { enabled: false } });
                const tracks = this.shaka.getVariantTracks();
                const selected = tracks.find(t => t.id == levelId);
                if (selected) {
                    this.shaka.selectVariantTrack(selected, true);
                }
            }
        } else if (this.hls) {
            // HLS.js handles Auto with -1
            this.hls.currentLevel = parseInt(levelId);
        }

        this.updateQualityMenu();
    }

    /**
     * Update audio selection menu
     */
    updateAudioMenu() {
        const audioList = document.getElementById('audio-list');
        if (!audioList) return;

        audioList.innerHTML = '';
        let tracks = [];

        if (this.shaka) {
            // Shaka Player: Get audio languages and roles
            const audioTracks = this.shaka.getLanguagesAndRoles('audio');
            const currentTrack = this.shaka.getVariantTracks().find(t => t.active);

            tracks = audioTracks.map((t, index) => ({
                id: index,
                language: t.language,
                role: t.role,
                label: `${t.language}${t.role ? ` (${t.role})` : ''}`,
                active: currentTrack && currentTrack.language === t.language && (currentTrack.roles || []).includes(t.role)
            }));

            // If no match found by language+role, try just language as fallback
            if (currentTrack && !tracks.some(t => t.active)) {
                tracks.forEach(t => {
                    if (t.language === currentTrack.language) {
                        t.active = true;
                    }
                });
            }
        } else if (this.hls) {
            // HLS.js: Get audio tracks
            tracks = this.hls.audioTracks.map((track, index) => ({
                id: index,
                label: track.name || track.lang || `Track ${index}`,
                active: this.hls.audioTrack === index
            }));
        }

        if (tracks.length === 0) {
            audioList.innerHTML = '<li class="hint">No alternative tracks</li>';
            return;
        }

        // Add tracks to UI
        tracks.forEach(track => {
            const li = document.createElement('li');
            li.dataset.id = track.id;
            if (track.active) {
                li.classList.add('active');
            }
            li.textContent = track.label;

            li.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.shaka) {
                    this.setAudioTrack(track.language, track.role);
                } else {
                    this.setAudioTrack(track.id);
                }
                document.getElementById('audio-menu').classList.add('hidden');
            });

            audioList.appendChild(li);
        });
    }

    /**
     * Set audio track
     */
    setAudioTrack(idOrLang, role = null) {
        console.log('[Player] Setting audio track:', idOrLang, role);
        if (this.shaka) {
            this.shaka.selectAudioLanguage(idOrLang, role);
            this.selectedAudioTrack = `${idOrLang}:${role}`;
        } else if (this.hls) {
            this.hls.audioTrack = parseInt(idOrLang);
            this.selectedAudioTrack = idOrLang;
        }
        this.updateAudioMenu();
    }

    /**
     * Stop playback
     */
    async stop() {
        if (this.video.onevent_playing) {
            this.video.removeEventListener('playing', this.video.onevent_playing);
            this.video.onevent_playing = null;
        }

        this.video.pause();

        if (this.hls) {
            try {
                this.hls.stopLoad();
                this.hls.detachMedia();
                this.hls.destroy();
            } catch (e) { }
            this.hls = null;
        }

        if (this.shaka) {
            try {
                await this.shaka.unload(); // Use unload instead of destroy to avoid hanging
            } catch (e) {
                console.warn('[Shaka] Unload failed:', e);
            }
            // We keep the shaka instance alive for reuse
        } else {
            this.video.removeAttribute('src');
            this.video.load();
        }

        if (this.spinner) {
            this.spinner.classList.add('hidden');
        }

        if (this.offlineTimer) {
            clearTimeout(this.offlineTimer);
            this.offlineTimer = null;
        }

        this.playbackStartTime = null;
        this.firstFrameTime = null;
    }

    /**
     * Show center feedback icon briefly
     */
    showCenterFeedback(type) {
        if (!this.centerFeedback) return;

        const iconContainer = this.centerFeedback.querySelector('.feedback-icon');
        if (!iconContainer) return;

        let svg = '';
        switch (type) {
            case 'play':
                svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>';
                break;
            case 'pause':
                svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
                break;
            case 'forward':
                svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>';
                break;
            case 'back':
                svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg>';
                break;
        }

        iconContainer.innerHTML = svg;
        this.centerFeedback.classList.remove('animate');
        void this.centerFeedback.offsetWidth; // Trigger reflow
        this.centerFeedback.classList.add('animate');

        setTimeout(() => {
            this.centerFeedback.classList.remove('animate');
        }, 500);
    }

    /**
     * Update now playing display
     */
    updateNowPlaying(channel, epgData = null) {
        const channelName = this.nowPlaying.querySelector('.channel-name');
        const programTitle = this.nowPlaying.querySelector('.program-title');
        const programTime = this.nowPlaying.querySelector('.program-time');
        const upNextList = document.getElementById('up-next-list');
        const liveBadge = this.nowPlaying.querySelector('.osd-live-badge');

        if (channelName) channelName.textContent = channel.name || channel.tvgName || 'Unknown Channel';

        if (programTitle) {
            if (epgData && epgData.current) {
                programTitle.textContent = epgData.current.title;
                const start = new Date(epgData.current.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const end = new Date(epgData.current.stop).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                if (programTime) {
                    programTime.textContent = `${start} - ${end}`;
                    programTime.style.display = 'block';
                }
                if (liveBadge) liveBadge.style.display = 'flex';
            } else {
                programTitle.textContent = channel.isVod ? 'VOD Content' : 'Live Stream';
                if (programTime) programTime.style.display = 'none';
                if (liveBadge) liveBadge.style.display = channel.isVod ? 'none' : 'flex';
            }
        }

        // Update up next
        if (upNextList) {
            upNextList.innerHTML = '';
            const upNextSection = this.nowPlaying.querySelector('.osd-up-next');

            if (epgData && epgData.upcoming && epgData.upcoming.length > 0) {
                if (upNextSection) upNextSection.style.display = 'block';
                epgData.upcoming.slice(0, 3).forEach(prog => {
                    const li = document.createElement('li');
                    const time = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    li.textContent = `${time} - ${prog.title}`;
                    upNextList.appendChild(li);
                });
            } else {
                if (upNextSection) upNextSection.style.display = 'none';
            }
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
                break;
            case 'ArrowDown':
                if (!this.settings.arrowKeysChangeChannel) {
                    e.preventDefault();
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (this.settings.arrowKeysChangeChannel) {
                    this.video.currentTime = Math.max(0, this.video.currentTime - 10);
                    this.showCenterFeedback('back');
                } else {
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (this.settings.arrowKeysChangeChannel) {
                    if (this.video.duration) {
                        this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 10);
                        this.showCenterFeedback('forward');
                    }
                } else {
                    this.video.volume = Math.min(1, this.video.volume + 0.1);
                }
                break;
            case 'j':
                e.preventDefault();
                this.video.currentTime = Math.max(0, this.video.currentTime - 10);
                this.showCenterFeedback('back');
                break;
            case 'l':
                e.preventDefault();
                if (this.video.duration) {
                    this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 10);
                    this.showCenterFeedback('forward');
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
            case 'd':
                e.preventDefault();
                this.toggleDebug();
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

    /**
     * Toggle debug technical info
     */
    toggleDebug() {
        this.showDebug = !this.showDebug;
        const debugEl = document.getElementById('debug-stats');

        if (this.showDebug) {
            debugEl.classList.remove('hidden');
            this.updateDebugInfo();
            // Reduce frequency to 2s to save CPU
            this.debugTimer = setInterval(() => this.updateDebugInfo(), 2000);
        } else {
            debugEl.classList.add('hidden');
            if (this.debugTimer) {
                clearInterval(this.debugTimer);
                this.debugTimer = null;
            }
        }
    }

    /**
     * Update technical debug info
     */
    updateDebugInfo() {
        const debugEl = document.getElementById('debug-stats');
        if (!debugEl || !this.showDebug) return;

        try {
            const video = this.video;
            const now = Date.now();
            const getBar = (value, max, size = 8) => {
                if (!max || max <= 0) return '[' + '-'.repeat(size) + ']';
                const filled = Math.round((Math.min(value || 0, max) / max) * size);
                const empty = size - filled;
                return '[' + '='.repeat(Math.max(0, filled)) + '-'.repeat(Math.max(0, empty)) + ']';
            };

            let sections = {};

            // [SYSTEM]
            let memory = 'N/A';
            if (performance.memory) {
                const used = performance.memory.usedJSHeapSize / 1048576;
                const total = performance.memory.jsHeapSizeLimit / 1048576;
                memory = `${used.toFixed(1)} / ${total.toFixed(0)} MB`;
            }

            sections['SYSTEM'] = {
                'Engine': this.shaka ? 'Shaka (DASH)' : (this.hls ? 'HLS.js' : 'Native'),
                'TTI': (this.playbackStartTime && this.firstFrameTime) ? `${((this.firstFrameTime - this.playbackStartTime) / 1000).toFixed(2)}s` : 'Loading...',
                'Uptime': this.playbackStartTime ? `${((now - this.playbackStartTime) / 1000).toFixed(0)}s` : '0s',
                'Memory': memory
            };

            // [VIDEO & AUDIO]
            let videoCodec = 'Unknown';
            let audioCodec = 'Unknown';
            let liveLatency = 'N/A';

            if (this.shaka) {
                try {
                    const tracks = this.shaka.getVariantTracks();
                    const variant = (tracks || []).find(t => t.active);
                    if (variant) {
                        videoCodec = variant.videoCodec || 'Unknown';
                        audioCodec = variant.audioCodec || 'Unknown';
                    }
                    const latency = this.shaka.getLiveLatency();
                    if (latency != null && !isNaN(latency)) liveLatency = `${latency.toFixed(2)}s`;
                } catch (e) { console.warn('[Debug] Shaka info error:', e); }
            } else if (this.hls) {
                videoCodec = 'H.264 (est.)';
                audioCodec = 'AAC (est.)';
                if (this.hls.latency != null && !isNaN(this.hls.latency)) liveLatency = `${this.hls.latency.toFixed(2)}s`;
            }

            // Manifest Health
            let manifestAge = 'N/A';
            if (this.lastManifestUpdate > 0) {
                manifestAge = `${((now - this.lastManifestUpdate) / 1000).toFixed(1)}s`;
            }

            sections['STREAM INFO'] = {
                'Engine': sections['SYSTEM']['Engine'], // Move engine here
                'Manifest': manifestAge + (this.manifestUpdatePeriod > 0 ? ` (upd: ${this.manifestUpdatePeriod.toFixed(1)}s)` : ''),
                'GOP Size': this.gopSize > 0 ? `${this.gopSize.toFixed(1)}s` : 'Detecting...'
            };
            delete sections['SYSTEM']['Engine'];

            // Calculate FPS & Stress Score
            let fps = 0;
            let stressScore = 0;
            if (video.getVideoPlaybackQuality) {
                const quality = video.getVideoPlaybackQuality();
                const currentFrames = quality.totalVideoFrames;
                const currentDropped = quality.droppedVideoFrames || 0;
                const currentTime = performance.now();

                if (this.lastFpsUpdate > 0) {
                    const dt = (currentTime - this.lastFpsUpdate) / 1000;
                    if (dt > 0.1) {
                        fps = (currentFrames - this.lastDecodedFrames) / dt;
                        stressScore = (currentDropped - this.lastDroppedFrames) / dt;
                    }
                }

                this.lastDecodedFrames = currentFrames;
                this.lastDroppedFrames = currentDropped;
                this.lastFpsUpdate = currentTime;
            }

            sections['VIDEO/AUDIO'] = {
                'Res': `${video.videoWidth || 0}x${video.videoHeight || 0}`,
                'FPS': fps > 0 ? fps.toFixed(1) : 'Calculating...',
                'Latency': liveLatency,
                'V-Codec': videoCodec,
                'A-Codec': audioCodec
            };

            // [NETWORK]
            let bandwidth = 0;
            if (this.shaka) {
                try {
                    const stats = this.shaka.getStats();
                    bandwidth = (stats.estimatedBandwidth || 0) / 1e6;
                } catch (e) { }
            } else if (this.hls && this.hls.levels) {
                const current = (this.hls.currentLevel >= 0) ? this.hls.currentLevel : this.hls.loadLevel;
                if (current >= 0 && this.hls.levels[current]) {
                    bandwidth = (this.hls.levels[current].bitrate || 0) / 1e6;
                }
            }

            let netEfficiency = '100%';
            if (bandwidth > 0 && this.shaka) {
                try {
                    const stats = this.shaka.getStats();
                    const variantBitrate = (stats.variantBandwidth || 0) / 1e6;
                    if (variantBitrate > 0) {
                        netEfficiency = `${((bandwidth / variantBitrate) * 100).toFixed(0)}%`;
                    }
                } catch (e) { }
            } else if (bandwidth > 0 && this.hls && this.hls.levels) {
                const current = (this.hls.currentLevel >= 0) ? this.hls.currentLevel : this.hls.loadLevel;
                if (current >= 0 && this.hls.levels[current]) {
                    const levelBitrate = (this.hls.levels[current].bitrate || 0) / 1e6;
                    if (levelBitrate > 0) {
                        netEfficiency = `${((bandwidth / levelBitrate) * 100).toFixed(0)}%`;
                    }
                }
            }

            sections['NETWORK'] = {
                'Estimate': `${bandwidth.toFixed(2)} Mbps`,
                'Efficiency': netEfficiency,
                'LoadTime': `${this.lastSegmentLoadTime}ms`
            };

            // [BUFFER & PERFORMANCE]
            let bufferLen = 0;
            if (video.buffered && video.buffered.length > 0) {
                try {
                    const bufferedEnd = video.buffered.end(video.buffered.length - 1);
                    bufferLen = Math.max(0, bufferedEnd - video.currentTime);
                } catch (e) { }
            }

            let dropped = 0;
            let total = 0;
            if (video.getVideoPlaybackQuality) {
                try {
                    const q = video.getVideoPlaybackQuality();
                    dropped = q.droppedVideoFrames || 0;
                    total = q.totalVideoFrames || 0;
                } catch (e) { }
            }

            let dropPct = '0.0%';
            if (total > 0) {
                dropPct = `${((dropped / total) * 100).toFixed(2)}%`;
            }

            sections['PERFORMANCE'] = {
                'Screen': this.refreshRate > 0 ? `${this.refreshRate}Hz` : 'Detecting...',
                'Stress': stressScore.toFixed(2) + ' drop/s',
                'Memory': memory,
                'Dropped': `${dropped} (${dropPct})`,
                'Stalls': this.stallCount,
                'Buffer': `${bufferLen.toFixed(2)}s ${getBar(bufferLen, 30)}`
            };

            // [DRM & SECURITY]
            let isEncrypted = false;
            if (this.shaka) {
                try {
                    isEncrypted = this.shaka.getVariantTracks().some(t => t.encrypted);
                } catch (e) { }
            }

            let avgLicenseLatency = 'N/A';
            if (this.licenseLatencies.length > 0) {
                const sum = this.licenseLatencies.reduce((a, b) => a + b, 0);
                avgLicenseLatency = `${(sum / this.licenseLatencies.length).toFixed(0)}ms`;
            }

            sections['DRM/SECURITY'] = {
                'Status': isEncrypted ? 'Widevine (Active)' : 'Clear',
                'Avg Latency': avgLicenseLatency
            };

            // Format output
            let output = '';
            for (const [title, data] of Object.entries(sections)) {
                output += `[${title}]\n`;
                for (const [key, val] of Object.entries(data)) {
                    output += `${String(key).padEnd(10)}: ${val}\n`;
                }
                output += '\n';
            }

            debugEl.textContent = output.trim();
        } catch (err) {
            console.error('[Debug] Fatal update error:', err);
            debugEl.textContent = "Debug module error: " + err.message;
        }
    }
    /**
     * Estimate refresh rate of the screen
     */
    estimateRefreshRate() {
        let frames = 0;
        let start = performance.now();
        const check = (now) => {
            frames++;
            if (now - start >= 1000) {
                this.refreshRate = Math.round((frames * 1000) / (now - start));
                return;
            }
            requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
    }

    /**
     * Show animated feedback in the center of the player
     */
    showCenterFeedback(type) {
        if (!this.centerFeedback) return;

        const iconContainer = this.centerFeedback.querySelector('.feedback-icon');
        if (!iconContainer) return;

        let iconSvg = '';
        switch (type) {
            case 'play':
                iconSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
                break;
            case 'pause':
                iconSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
                break;
            case 'forward':
                iconSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>';
                break;
            case 'back':
                iconSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg>';
                break;
        }

        iconContainer.innerHTML = iconSvg;

        // Reset animation state
        this.centerFeedback.classList.remove('animate');

        // Trigger reflow to restart animation
        void this.centerFeedback.offsetWidth;

        this.centerFeedback.classList.add('animate');

        // Automatic cleanup after animation duration
        if (this._feedbackTimeout) clearTimeout(this._feedbackTimeout);
        this._feedbackTimeout = setTimeout(() => {
            this.centerFeedback.classList.remove('animate');
        }, 800);
    }
}


// Export
window.VideoPlayer = VideoPlayer;

