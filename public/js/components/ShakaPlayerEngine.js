/**
 * Shaka Player Engine Component
 * Handles MPEG-DASH (.mpd) streams with DRM support.
 * Completely isolated from VideoPlayer.js.
 */
class ShakaPlayerEngine {
    constructor() {
        this.container = document.getElementById('shaka-container');
        this.video = document.getElementById('shaka-video-player');
        this.nowPlaying = document.getElementById('shaka-now-playing');
        this.player = null;
        this.ui = null;
        this.isActive = false;
        this.currentChannel = null;
        this.overlayTimer = null;
    }

    static isSupported() {
        return typeof shaka !== 'undefined' && shaka.Player.isBrowserSupported();
    }

    async init() {
        if (!ShakaPlayerEngine.isSupported()) {
            console.warn('[ShakaPlayer] Not supported in this browser');
            return;
        }

        shaka.polyfill.installAll();

        // Configure Shaka UI
        const videoContainer = document.getElementById('shaka-container');
        this.player = new shaka.Player(this.video);

        if (shaka.ui) {
            this.ui = new shaka.ui.Overlay(this.player, videoContainer, this.video);
            this.ui.configure({
                controlPanelElements: [
                    'play_pause',
                    'mute',
                    'volume',
                    'spacer',
                    'captions',
                    'quality',
                    'overflow_menu',
                    'fullscreen'
                ],
                overflowMenuButtons: [
                    'language',
                    'quality',
                    'statistics',
                    'captions'
                ],
                addBigPlayButton: false
            });
        }

        // Apply global refined config from nodecast-tv-1.0.0
        this.player.configure({
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
                bufferingGoal: 45,
                rebufferingGoal: 4.0,
                bufferBehind: 30,
                lowLatencyMode: false,
                segmentPrefetchLimit: 5,
                stallThreshold: 6,
                safeSeekOffset: 15,
                smallGapLimit: 1.0,
                jumpLargeGaps: true,
                inaccurateManifestTolerance: 1.0,
                ignoreTextStreamFailures: true
            },
            abr: {
                enabled: true,
                defaultBandwidthEstimate: 10000000
            }
        });

        this.player.addEventListener('error', (event) => this.onError(event.detail));

        // Register request filter to handle proxying
        this.player.getNetworkingEngine().registerRequestFilter((type, request) => {
            this.handleRequestFilter(type, request);
        });

        // Register response filter to fix relative URLs in manifest
        this.player.getNetworkingEngine().registerResponseFilter((type, response) => {
            this.handleResponseFilter(type, response);
        });

        // Setup clicking to show Now Playing
        if (this.video) {
            this.video.addEventListener('click', () => this.showNowPlaying());
        }
    }

    handleResponseFilter(type, response) {
        // We only care about restoring the base URL for the manifest itself
        if (type !== shaka.net.NetworkingEngine.RequestType.MANIFEST) return;

        // If the manifest was loaded through our proxy, we need to instruct Shaka
        // that its real base URL is the original upstream URL.
        // Otherwise, Shaka will resolve relative segment URLs (e.g. `segment1.m4s`) 
        // against `/api/proxy/stream`, resulting in `/api/proxy/segment1.m4s` (404 Error 1002).
        if (response.uri && response.uri.includes('/api/proxy/stream')) {
            try {
                const urlParams = new URLSearchParams(response.uri.split('?')[1]);
                const originalUrl = urlParams.get('url');

                if (originalUrl) {
                    console.log(`[ShakaPlayer] Restoring manifest base URI to: ${originalUrl}`);
                    response.uri = originalUrl;
                }
            } catch (err) {
                console.warn('[ShakaPlayer] Could not parse original manifest URL from proxy URI', err);
            }
        }
    }

    handleRequestFilter(type, request) {
        if (!request.uris || request.uris.length === 0) return;

        // Apply custom DRM headers if they exist
        if (this.currentDrmHeaders) {
            for (const [k, v] of Object.entries(this.currentDrmHeaders)) {
                request.headers[k] = v;
            }
        }

        // Proxy if channel explicitly uses WARP OR if we're forcing proxy for Mixed Content / CORS
        const shouldProxy = (this.currentChannel && this.currentChannel.useWarp) || this.isUsingProxy;

        if (shouldProxy) {
            const RequestType = shaka.net.NetworkingEngine.RequestType;
            if (type === RequestType.MANIFEST ||
                type === RequestType.SEGMENT ||
                type === RequestType.LICENSE) {
                const originalUrl = request.uris[0];
                // Don't proxy internal APIs or data URIs
                if (originalUrl && !originalUrl.startsWith('/api/') && !originalUrl.startsWith('data:')) {
                    const sourceId = this.currentChannel ? this.currentChannel.sourceId : '';
                    request.uris[0] = `/api/proxy/stream?url=${encodeURIComponent(originalUrl)}&sourceId=${sourceId}`;
                }
            }
        }
    }

    canPlay(url) {
        if (!url) return false;
        return url.toLowerCase().includes('.mpd');
    }

    async play(channel, streamUrl, forceProxy = false) {
        this.isActive = true;
        this.currentChannel = channel;

        // Auto-detect Mixed Content (HTTPS page, HTTP stream)
        const isPageHttps = window.location.protocol === 'https:';
        const isUrlHttp = streamUrl.startsWith('http:');
        if (isPageHttps && isUrlHttp && !forceProxy) {
            console.log('[ShakaPlayer] Mixed Content detected (HTTPS app, HTTP stream). Proactively enabling proxy.');
            forceProxy = true;
        }

        this.isUsingProxy = forceProxy; // Track if we're currently forcing the proxy


        // Stop the main VideoPlayer if it's running
        if (window.app && window.app.player && typeof window.app.player.stop === 'function') {
            window.app.player.stop();
        }

        // Hide the main container
        const mainContainer = document.getElementById('video-container');
        if (mainContainer) mainContainer.style.display = 'none';

        // Show Shaka container
        if (this.container) this.container.style.display = 'block';

        // Reset previous DRM configuration before setting new one to prevent Error 6012 / bleed-over
        this.player.configure({
            drm: {
                clearKeys: {},
                servers: {}
            }
        });

        // Configure DRM if properties are present
        if (channel.properties) {
            const licenseType = channel.properties['inputstream.adaptive.license_type'];
            const licenseKey = channel.properties['inputstream.adaptive.license_key'];
            const streamHeaders = channel.properties['inputstream.adaptive.stream_headers'];

            if (licenseType && licenseKey) {
                console.log(`[ShakaPlayer] Found DRM configuration: ${licenseType}`);

                // Load custom stream_headers from KODIPROP, exactly like 1.0.0
                this.currentDrmHeaders = null;
                if (streamHeaders) {
                    const headersArray = streamHeaders.split('&');
                    const headersObj = {};
                    headersArray.forEach(h => {
                        const [k, v] = h.split('=');
                        if (k && v) {
                            headersObj[k.trim()] = decodeURIComponent(v.trim());
                        }
                    });
                    this.currentDrmHeaders = headersObj;
                    console.log('[ShakaPlayer] Loaded custom stream headers:', headersObj);
                }

                const normalizedLicenseType = licenseType.toLowerCase();
                if (normalizedLicenseType === 'clearkey' || normalizedLicenseType === 'org.w3.clearkey') {
                    // Extract KID:KEY or KID=KEY format (e.g. 1234:5678 or {"kid":"key"})
                    let clearKeysConfig = {};

                    try {
                        if (licenseKey.startsWith('http')) {
                            // Remote ClearKey server
                            this.player.configure({
                                drm: {
                                    servers: {
                                        'org.w3.clearkey': licenseKey
                                    }
                                }
                            });
                            console.log(`[ShakaPlayer] ClearKey remote server configured: ${licenseKey}`);
                        } else {
                            if (licenseKey.startsWith('{')) {
                                clearKeysConfig = JSON.parse(licenseKey);
                            } else {
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

                                // Can be multiple keys separated by comma
                                const keyPairs = licenseKey.split(',');
                                for (const pair of keyPairs) {
                                    // Format: kid:key (strip quotes and spaces)
                                    let [kid, key] = pair.trim().replace(/['"]/g, '').split(':');
                                    if (kid && key) {
                                        // Shaka Player requires Hex format for kid/key
                                        if (!isHex(kid)) kid = base64ToHex(kid);
                                        if (!isHex(key)) key = base64ToHex(key);
                                        clearKeysConfig[kid] = key;
                                    }
                                }
                            }

                            this.player.configure({
                                drm: {
                                    clearKeys: clearKeysConfig
                                }
                            });
                            console.log('[ShakaPlayer] clearKeys configured:', clearKeysConfig);
                        }

                    } catch (err) {
                        console.error('[ShakaPlayer] Error parsing clearkey:', err);
                    }
                } else if (licenseType === 'com.widevine.alpha' || licenseType === 'widevine') {
                    // It's a license server URL
                    // Sometimes KODIPROP URLs have additional headers separated by |
                    let serverUrl = licenseKey;
                    const headersIndex = serverUrl.indexOf('|');
                    let headers = {};

                    if (headersIndex !== -1) {
                        // Advanced: parse Kodi-style headers here if strictly necessary
                        // format: URL|Header1=Value1&Header2=Value2
                        const headersStr = serverUrl.substring(headersIndex + 1);
                        serverUrl = serverUrl.substring(0, headersIndex);

                        const headersObj = this.currentDrmHeaders || {};
                        headersStr.split('&').forEach(h => {
                            const [k, v] = h.split('=');
                            if (k && v) {
                                headersObj[k.trim()] = decodeURIComponent(v.trim());
                            }
                        });
                        this.currentDrmHeaders = headersObj;
                    }

                    this.player.configure({
                        drm: {
                            servers: {
                                'com.widevine.alpha': serverUrl
                            }
                        }
                    });
                    console.log(`[ShakaPlayer] Widevine server configured: ${serverUrl}`);
                }
            }
        }

        try {
            await this.player.load(streamUrl);
            this.video.play().catch(e => console.log('[ShakaPlayer] Autoplay prevented:', e));

            // Show EPG details
            this.fetchEpgData(channel);
            this.showNowPlaying();

            // Dispatch event for UI sync
            window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
        } catch (e) {
            // 1001 = RESTRICTED_CROSS_ORIGIN (CORS), 1002 = BAD_HTTP_STATUS (e.g. 403 Forbidden)
            if ((e.code === 1001 || e.code === 1002) && !this.isUsingProxy) {
                console.log(`[ShakaPlayer] Network Error ${e.code} detected. Retrying with backend proxy...`);
                return this.play(channel, streamUrl, true);
            }
            this.onError(e);
            this.showError('Failed to play DASH stream: Shaka Error ' + e.code);
        }
    }

    stop() {
        this.isActive = false;
        this.currentChannel = null;

        if (this.player) {
            this.player.unload();
        }
        if (this.video) {
            this.video.pause();
        }

        this.hideNowPlaying();

        if (this.container) {
            this.container.style.display = 'none';
        }

        const mainContainer = document.getElementById('video-container');
        if (mainContainer) {
            mainContainer.style.display = 'block';
        }
    }

    onError(error) {
        console.error('[ShakaPlayer Error] Code:', error.code, error);
    }

    showError(message) {
        console.error(message);
        // We can display a simple error toast or text over the video
        alert(message); // fallback for simplicity in the isolated player context
    }

    // --- EPG / UI logic ported from VideoPlayer for independence ---
    showNowPlaying() {
        if (!this.currentChannel || !this.nowPlaying) return;

        if (this.overlayTimer) clearTimeout(this.overlayTimer);
        this.nowPlaying.classList.remove('hidden');

        const duration = window.app?.player?.settings?.overlayDuration || 5;
        this.overlayTimer = setTimeout(() => {
            if (this.nowPlaying) this.nowPlaying.classList.add('hidden');
        }, duration * 1000);
    }

    hideNowPlaying() {
        if (this.overlayTimer) clearTimeout(this.overlayTimer);
        if (this.nowPlaying) this.nowPlaying.classList.add('hidden');
    }

    async fetchEpgData(channel) {
        if (!channel || (!channel.tvgId && !channel.epg_id)) {
            this.updateNowPlaying(channel, null);
            return;
        }
        // Use the centralized EpgGuide logic exactly as VideoPlayer does
        try {
            if (window.app && window.app.epgGuide && window.app.epgGuide.programmes) {
                const epgGuide = window.app.epgGuide;
                const currentProgram = epgGuide.getCurrentProgram(channel.tvgId, channel.name);

                if (currentProgram) {
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
                                stop: new Date(p.stop)
                            }));
                    }
                    this.updateNowPlaying(channel, {
                        current: {
                            title: currentProgram.title,
                            start: new Date(currentProgram.start),
                            stop: new Date(currentProgram.stop)
                        },
                        upcoming
                    });
                    return;
                }
            }
        } catch (err) {
            console.log('[ShakaPlayer] EPG data error:', err.message);
        }
        this.updateNowPlaying(channel, null);
    }

    updateNowPlaying(channel, epgData = null) {
        if (!this.nowPlaying) return;
        const channelName = this.nowPlaying.querySelector('.channel-name');
        const programTitle = this.nowPlaying.querySelector('.program-title');
        const programTime = this.nowPlaying.querySelector('.program-time');
        const upNextList = this.nowPlaying.querySelector('#shaka-up-next-list');

        if (channelName) channelName.textContent = channel.name || channel.tvgName || 'Unknown Channel';

        if (epgData && epgData.current && programTitle && programTime) {
            programTitle.textContent = epgData.current.title;
            const start = new Date(epgData.current.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(epgData.current.stop).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            programTime.textContent = `${start} - ${end}`;
        } else {
            if (programTitle) programTitle.textContent = '';
            if (programTime) programTime.textContent = '';
        }

        if (upNextList) {
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
    }
}

window.ShakaPlayerEngine = ShakaPlayerEngine;
