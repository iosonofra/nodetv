/**
 * Stream Tester Logic
 * Completely isolated from Live TV (VideoPlayer.js / App.js)
 */

document.addEventListener('DOMContentLoaded', () => {
    const video = document.getElementById('test-video');
    const btnPlay = document.getElementById('btn-play');
    const loading = document.getElementById('test-loading');
    const errorOverlay = document.getElementById('test-error');

    // Form inputs
    const inDrmClearkey = document.getElementById('drm-clearkey');
    const inDrmWidevine = document.getElementById('drm-widevine-url');
    const inDrmCert = document.getElementById('drm-cert-url');

    const inInfoName = document.getElementById('info-name');
    const inInfoTvgid = document.getElementById('info-tvgid');
    const inInfoGroup = document.getElementById('info-group');
    const inInfoLogo = document.getElementById('info-logo');
    const inInfoType = document.getElementById('info-type');
    const inInfoUrl = document.getElementById('info-url');

    // Result outputs
    const outHex = document.getElementById('res-clearkey-hex');
    const outB64 = document.getElementById('res-clearkey-b64');
    const outLink = document.getElementById('res-direct-link');
    const outM3u = document.getElementById('res-m3u');

    // Headers logic
    const headersContainer = document.getElementById('headers-container');
    const btnAddHeader = document.getElementById('btn-add-header');

    // Sidebar Toggle
    const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    const testerSidebar = document.querySelector('.tester-sidebar');
    if (btnToggleSidebar && testerSidebar) {
        btnToggleSidebar.addEventListener('click', () => {
            testerSidebar.classList.toggle('collapsed');
            btnToggleSidebar.classList.toggle('collapsed');
        });
    }

    let shakaPlayer = null;
    let hlsPlayer = null;

    function initShaka() {
        if (!window.shaka) return;
        shaka.polyfill.installAll();
        if (shaka.Player.isBrowserSupported()) {
            shakaPlayer = new shaka.Player(video);
            shakaPlayer.addEventListener('error', onShakaError);

            // Setup UI Overlay
            const videoContainer = document.getElementById('shaka-container');
            if (shaka.ui && videoContainer) {
                const ui = new shaka.ui.Overlay(shakaPlayer, videoContainer, video);
                ui.configure({
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
                    addBigPlayButton: true
                });
            }
        }
    }

    initShaka();

    function onShakaError(event) {
        console.error('Shaka Error:', event.detail || event);
        if (event.detail && event.detail.code !== 7000 /* load interrupt */) {
            showError('Errore DRM/Playback: code ' + event.detail.code);
        }
    }

    function showError(msg) {
        loading.style.display = 'none';
        errorOverlay.textContent = msg;
        errorOverlay.style.display = 'block';
    }

    function hideError() {
        errorOverlay.style.display = 'none';
    }

    // Helpers
    function hexToBase64Url(hexStr) {
        try {
            const raw = hexStr.match(/\w{2}/g).map(a => String.fromCharCode(parseInt(a, 16))).join('');
            const b64 = btoa(raw);
            return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        } catch (e) {
            return '';
        }
    }

    function updateResults() {
        const clearkey = inDrmClearkey.value.trim();
        const url = inInfoUrl.value.trim();
        const name = inInfoName.value.trim() || 'Test Channel';
        const tvgId = inInfoTvgid.value.trim();
        const group = inInfoGroup.value.trim();
        const logo = inInfoLogo.value.trim();

        let hexStr = '';
        let b64Str = '';

        if (clearkey && clearkey.includes(':')) {
            const [kidHex, keyHex] = clearkey.split(':');
            hexStr = `${kidHex}:${keyHex}`;

            const kidB64 = hexToBase64Url(kidHex);
            const keyB64 = hexToBase64Url(keyHex);
            if (kidB64 && keyB64) {
                b64Str = `{"clearkeys":{"${kidB64}":"${keyB64}"}}`;
            }
        }

        outHex.value = hexStr;
        outB64.value = b64Str;
        outLink.value = url;

        // Generate M3U
        let m3u = `#EXTM3U\n#EXTINF:-1`;
        if (tvgId) m3u += ` tvg-id="${tvgId}"`;
        if (logo) m3u += ` tvg-logo="${logo}"`;
        if (group) m3u += ` group-title="${group}"`;
        m3u += `,${name}\n`;

        if (inDrmWidevine.value.trim()) {
            m3u += `#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha\n`;
            m3u += `#KODIPROP:inputstream.adaptive.license_key=${inDrmWidevine.value.trim()}\n`;
        } else if (clearkey) {
            m3u += `#KODIPROP:inputstream.adaptive.license_type=clearkey\n`;
            m3u += `#KODIPROP:inputstream.adaptive.license_key=${b64Str}\n`;
        }

        // Add headers
        const headerElems = headersContainer.querySelectorAll('.header-row');
        let headerStr = '';
        headerElems.forEach(row => {
            const name = row.querySelector('.hdr-name').value.trim();
            const val = row.querySelector('.hdr-val').value.trim();
            if (name && val) {
                headerStr += `${name}=${val}&`;
            }
        });

        if (headerStr) {
            headerStr = headerStr.slice(0, -1); // remove last &
            m3u += `#EXTVLCOPT:http-user-agent=${headerStr}\n`; // simplistic rep
        }

        m3u += url;
        outM3u.value = m3u;
    }

    // Add header row
    function createHeaderRow(name = '', val = '') {
        const div = document.createElement('div');
        div.className = 'header-row';
        div.innerHTML = `
            <input type="text" class="input hdr-name" placeholder="Nome (es. User-Agent)" value="${name}">
            <input type="text" class="input hdr-val" placeholder="Valore" value="${val}">
            <button class="btn-icon danger remove-hdr" title="Rimuovi">×</button>
        `;
        div.querySelector('.remove-hdr').addEventListener('click', () => {
            div.remove();
            updateResults();
        });
        div.querySelectorAll('input').forEach(i => i.addEventListener('input', updateResults));
        return div;
    }

    btnAddHeader.addEventListener('click', () => {
        headersContainer.appendChild(createHeaderRow());
    });

    // Listen to changes
    const allInputs = document.querySelectorAll('.tester-sidebar input, .tester-sidebar select');
    allInputs.forEach(i => i.addEventListener('input', updateResults));

    // Copy buttons
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            const el = document.getElementById(targetId);
            if (el && el.value) {
                navigator.clipboard.writeText(el.value).then(() => {
                    const old = btn.textContent;
                    btn.textContent = '✓';
                    setTimeout(() => btn.textContent = old, 2000);
                });
            }
        });
    });

    // Decoder Logic
    const btnDecode = document.getElementById('btn-decode-b64');
    const inDecB64 = document.getElementById('dec-input-b64');
    const outDecHex = document.getElementById('dec-output-hex');

    function base64UrlToHex(b64Str) {
        try {
            // Pad base64 string
            const padLen = (4 - (b64Str.length % 4)) % 4;
            let padded = b64Str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
            const raw = atob(padded);
            let hex = '';
            for (let i = 0; i < raw.length; i++) {
                const hexChar = raw.charCodeAt(i).toString(16).padStart(2, '0');
                hex += hexChar;
            }
            return hex;
        } catch (e) {
            return null;
        }
    }

    if (btnDecode && inDecB64 && outDecHex) {
        btnDecode.addEventListener('click', () => {
            const input = inDecB64.value.trim();
            if (!input) return;

            outDecHex.value = 'Errore di decodifica...';

            try {
                // Try parsing as JSON first
                if (input.startsWith('{')) {
                    const obj = JSON.parse(input);
                    if (obj.clearkeys) {
                        const keys = Object.entries(obj.clearkeys);
                        const hexRows = keys.map(([kidB64, keyB64]) => {
                            const kidHex = base64UrlToHex(kidB64);
                            const keyHex = base64UrlToHex(keyB64);
                            return (kidHex && keyHex) ? `${kidHex}:${keyHex}` : null;
                        }).filter(Boolean);

                        if (hexRows.length > 0) {
                            outDecHex.value = hexRows.join(', ');
                            return;
                        }
                    }
                }
            } catch (e) {
                // Not a valid JSON, fallback to plain parsing
            }

            // If not JSON, try directly converting assuming format `kid_b64:key_b64` or single `key_b64`
            let resultParts = [];
            const parts = input.split(':');
            for (const part of parts) {
                const hex = base64UrlToHex(part.trim());
                if (hex) resultParts.push(hex);
            }

            if (resultParts.length > 0) {
                outDecHex.value = resultParts.join(':');
            }
        });
    }

    // Initial update
    updateResults();

    // Playback logic
    async function testVideo() {
        const url = inInfoUrl.value.trim();
        if (!url) {
            showError('Inserisci un URL del canale!');
            return;
        }

        hideError();
        loading.style.display = 'block';
        video.pause();

        // Stop previous
        if (hlsPlayer) {
            hlsPlayer.destroy();
            hlsPlayer = null;
        }

        // Shaka config
        let isMpd = inInfoType.value === 'mpd' || url.includes('.mpd');
        const clearkey = inDrmClearkey.value.trim();
        const widevineUrl = inDrmWidevine.value.trim();
        const hasDrm = clearkey || widevineUrl;

        if (isMpd || hasDrm) {
            video.controls = false; // Let Shaka UI handle it
            if (!shakaPlayer) initShaka();

            // Build DRM config
            const clearKeys = {};
            if (clearkey && clearkey.includes(':')) {
                const [k, v] = clearkey.split(':');
                clearKeys[k] = v;
            }

            // Request filters for headers
            const headerElems = headersContainer.querySelectorAll('.header-row');
            const headers = {};
            headerElems.forEach(row => {
                const n = row.querySelector('.hdr-name').value.trim();
                const v = row.querySelector('.hdr-val').value.trim();
                if (n && v) headers[n] = v;
            });

            // Setup Shaka DRM
            const drmCfg = {};
            if (Object.keys(clearKeys).length > 0) {
                drmCfg.clearKeys = clearKeys;
            }
            if (widevineUrl) {
                drmCfg.servers = { 'com.widevine.alpha': widevineUrl };
            }
            drmCfg.retryParameters = { maxAttempts: 3, baseDelay: 500, backoffFactor: 2 };

            shakaPlayer.configure({
                drm: drmCfg,
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
                    jumpLargeGaps: true,
                    ignoreTextStreamFailures: true
                }
            });

            // Setup network filters
            const networkingEngine = shakaPlayer.getNetworkingEngine();
            if (networkingEngine) {
                networkingEngine.clearAllRequestFilters();
                if (Object.keys(headers).length > 0) {
                    networkingEngine.registerRequestFilter((type, request) => {
                        for (const [key, value] of Object.entries(headers)) {
                            request.headers[key] = value;
                        }
                    });
                }
            }

            try {
                await shakaPlayer.load(url);
                video.play();
                loading.style.display = 'none';
            } catch (e) {
                onShakaError({ detail: e });
            }

        } else {
            // HLS
            video.controls = true; // Use native controls for fallback
            if (Hls.isSupported() && (inInfoType.value === 'm3u8' || url.includes('.m3u8'))) {
                hlsPlayer = new Hls();
                hlsPlayer.loadSource(url);
                hlsPlayer.attachMedia(video);
                hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.play();
                    loading.style.display = 'none';
                });
                hlsPlayer.on(Hls.Events.ERROR, (e, data) => {
                    if (data.fatal) {
                        showError('HLS Error: ' + data.type);
                    }
                });
            } else {
                // Direct
                video.src = url;
                video.play().then(() => {
                    loading.style.display = 'none';
                }).catch(e => {
                    showError('Errore di riproduzione diretta.');
                });
            }
        }
    }

    // Hide loading when video plays
    video.addEventListener('playing', () => {
        loading.style.display = 'none';
        hideError();
    });

    btnPlay.addEventListener('click', testVideo);
});
