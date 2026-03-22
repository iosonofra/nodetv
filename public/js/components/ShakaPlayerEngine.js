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
                    autoCorrectDrift: true
                },
                retryParameters: { maxAttempts: 4, baseDelay: 300, backoffFactor: 2 }
            },
            streaming: {
                bufferingGoal: 30,
                rebufferingGoal: 1.0,
                bufferBehind: 20,
                lowLatencyMode: false,
                segmentPrefetchLimit: 2,
                stallThreshold: 6,
                safeSeekOffset: 15,
                smallGapLimit: 1.0,
                jumpLargeGaps: true,
                inaccurateManifestTolerance: 1.0,
                ignoreTextStreamFailures: true,
                retryParameters: { maxAttempts: 4, baseDelay: 300, backoffFactor: 2 }
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

        // If the manifest was loaded through our proxy, restore the actual
        // upstream URL so Shaka can resolve relative segment URLs correctly.
        // Prefer X-Upstream-Url header (post-redirect, set by proxy) over
        // extracting from query string (pre-redirect, may be wrong).
        if (response.uri && response.uri.includes('/api/proxy/stream')) {
            try {
                // Prefer the actual upstream URL from the proxy (includes redirects)
                const upstreamUrl = response.headers && response.headers['x-upstream-url'];
                if (upstreamUrl) {
                    console.log(`[ShakaPlayer] Restoring manifest base URI to (upstream): ${upstreamUrl}`);
                    response.uri = upstreamUrl;
                    return;
                }
                // Fallback: extract from proxy query string
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

        // Apply custom DRM headers ONLY when proxying — setting them on direct
        // cross-origin requests causes CORS preflight failures because CDNs
        // typically don't whitelist custom headers like User-Agent in their
        // Access-Control-Allow-Headers response.
        const shouldProxy = (this.currentChannel && this.currentChannel.useWarp) || this.isUsingProxy;

        if (this.currentDrmHeaders && shouldProxy) {
            for (const [k, v] of Object.entries(this.currentDrmHeaders)) {
                request.headers[k] = v;
            }
        }

        // Proxy if channel explicitly uses WARP OR if we're forcing proxy for Mixed Content / CORS
        if (shouldProxy) {
            const RequestType = shaka.net.NetworkingEngine.RequestType;
            if (type === RequestType.MANIFEST ||
                type === RequestType.SEGMENT ||
                type === RequestType.LICENSE) {
                const originalUrl = request.uris[0];
                // Don't proxy internal APIs or data URIs
                if (originalUrl && !originalUrl.startsWith('/api/') && !originalUrl.startsWith('data:')) {
                    const sourceId = this.currentChannel ? this.currentChannel.sourceId : '';
                    if (type === RequestType.LICENSE) {
                        // With clearKeys, Shaka handles decryption locally — no license server needed.
                        // Do NOT proxy the LICENSE request; intercepting it would break
                        // Shaka's internal ClearKey session initialization.
                        if (this.hasClearKeys) return;
                        const headersParam = this.currentStreamHeaders ? `&headers=${encodeURIComponent(this.currentStreamHeaders)}` : '';
                        const proxyUrl = `/api/proxy/drm?url=${encodeURIComponent(originalUrl)}&sourceId=${sourceId || ''}${headersParam}`;
                        request.uris = [proxyUrl];
                        console.log(`[ShakaPlayer] Licensing request proxied: ${proxyUrl}`);
                    } else {
                        const headersParam = this.currentStreamHeaders ? `&headers=${encodeURIComponent(this.currentStreamHeaders)}` : '';
                        const dlChannelIdParam = this.currentChannel?.tvgId && String(this.currentChannel.tvgId).startsWith('dl_')
                            ? `&dlChannelId=${encodeURIComponent(String(this.currentChannel.tvgId).replace('dl_', ''))}`
                            : '';
                        
                        // Propagate additional query parameters from manifest URL (like ?ck= for PlusCDN)
                        let extraParams = '';
                        if (this.currentUrlParams) {
                            for (const [k, v] of Object.entries(this.currentUrlParams)) {
                                // Only append if not already in URL to avoid duplication
                                if (!originalUrl.includes(`${k}=`)) {
                                    extraParams += `&${k}=${encodeURIComponent(v)}`;
                                }
                            }
                        }

                        const proxyUrl = `/api/proxy/stream?url=${encodeURIComponent(originalUrl)}&sourceId=${sourceId || ''}${headersParam}${dlChannelIdParam}${extraParams}`;
                        request.uris = [proxyUrl];
                    }
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

        // MPD/DRM streams on external CDNs virtually never support CORS.
        // Proactively route through our backend proxy to avoid the failed
        // direct attempt + retry delay (~3-5s wasted).
        const isMpd = streamUrl && streamUrl.toLowerCase().includes('.mpd');
        const isExternal = streamUrl && streamUrl.startsWith('http') && !streamUrl.includes(window.location.host);
        if (!forceProxy && isExternal && isMpd) {
            console.log('[ShakaPlayer] External MPD detected — proactively enabling proxy to avoid CORS delays.');
            forceProxy = true;
        }

        this.isUsingProxy = forceProxy;
        this.hasClearKeys = false; // reset — set to true below when clearKeys are configured

        // Extract auth headers & query params from stream URL to forward on all segment proxy requests
        // - headers= param: DAZN and similar services encode auth tokens (dazn-token) here
        // - other params (e.g. ?ck=): PlusCDN and others use query params directly on manifest/segments
        this.currentUrlParams = null;
        try {
            const streamUrlObj = new URL(streamUrl, window.location.origin);
            
            // 1. Specific headers param (legacy DAZN fix)
            const headersParam = streamUrlObj.searchParams.get('headers');
            if (headersParam) {
                this.currentStreamHeaders = headersParam;
                console.log('[ShakaPlayer] Extracted stream headers for segment auth forwarding');
            }

            // 2. Generic query parameters to propagate (PlusCDN fix)
            const params = {};
            streamUrlObj.searchParams.forEach((value, key) => {
                if (key !== 'headers' && key !== 'url' && key !== 'sourceId') {
                    params[key] = value;
                }
            });
            if (Object.keys(params).length > 0) {
                this.currentUrlParams = params;
                console.log('[ShakaPlayer] Extracted query parameters for propagation:', Object.keys(params));
            }
        } catch (e) {
            // URL parsing failed
        }


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
                            let keyData = licenseKey;
                            const pipeIndex = keyData.indexOf('|');
                            if (pipeIndex !== -1) {
                                // Extract headers from ClearKey if present (Kodi style)
                                const headersStr = keyData.substring(pipeIndex + 1);
                                keyData = keyData.substring(0, pipeIndex);

                                const headersObj = this.currentDrmHeaders || {};
                                headersStr.split('&').forEach(h => {
                                    const [k, v] = h.split('=');
                                    if (k && v) {
                                        headersObj[k.trim()] = decodeURIComponent(v.trim());
                                    }
                                });
                                this.currentDrmHeaders = headersObj;
                            }

                            keyData = keyData.trim();

                            // Try to base64 decode if it doesn't look like JSON or colon-separated pairs
                            if (!keyData.startsWith('{') && !keyData.includes(':')) {
                                try {
                                    const decoded = atob(keyData);
                                    if (decoded.includes(':') || decoded.trim().startsWith('{')) {
                                        keyData = decoded.trim();
                                        console.log('[ShakaPlayer] Decoded base64 clearKey string');
                                    }
                                } catch (e) {
                                    // Not base64, proceed as is
                                }
                            }

                            if (keyData.startsWith('{')) {
                                try {
                                    // Try to extract JSON if there's trailing junk not caught by pipe
                                    let jsonStr = keyData;
                                    const lastBrace = jsonStr.lastIndexOf('}');
                                    if (lastBrace !== -1) {
                                        jsonStr = jsonStr.substring(0, lastBrace + 1);
                                    }
                                    clearKeysConfig = JSON.parse(jsonStr);
                                } catch (e) {
                                    console.error('[ShakaPlayer] JSON.parse failed even after cleaning:', e);
                                    throw e;
                                }
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
                                const keyPairs = keyData.split(',');
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
                                    clearKeys: clearKeysConfig,
                                    keySystemsMapping: {
                                        'com.widevine.alpha': 'org.w3.clearkey',
                                        'com.microsoft.playready': 'org.w3.clearkey',
                                        'com.microsoft.playready.recommendation': 'org.w3.clearkey'
                                    }
                                }
                            });
                            this.hasClearKeys = true; // stops LICENSE requests from being proxied
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
            // If we haven't tried the proxy yet, retry for a broad set of error types:
            // - 1001 = RESTRICTED_CROSS_ORIGIN (CORS), 1002 = BAD_HTTP_STATUS
            // - 4001/4003 = DRM/Manifest failures (e.g. URL returns 200 text/html instead of MPD)
            // - Any other first-attempt failure where the proxy might help
            if (!this.isUsingProxy) {
                const category = e.category || 0;
                const shouldRetry =
                    e.code === 1001 || e.code === 1002 || // Network/CORS errors
                    category === 1 ||  // NETWORK category
                    category === 4 ||  // DRM category (e.g. 4003 from bad manifest content)
                    category === 5;    // MANIFEST category (e.g. 4001 invalid XML from HTML response)

                if (shouldRetry) {
                    console.log(`[ShakaPlayer] Error ${e.code} (category ${category}) on direct load. Retrying via backend proxy...`);
                    await this.player.unload();
                    return this.play(channel, streamUrl, true);
                }
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
