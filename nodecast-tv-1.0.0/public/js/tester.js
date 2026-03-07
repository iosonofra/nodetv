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
        }
    }

    initShaka();

    function onShakaError(event) {
        console.error('Shaka Error:', event.detail || event);
        showError('Errore DRM/Playback: ' + (event.detail ? event.detail.code : 'Sconosciuto'));
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

    // --- Custom Controls Logic ---
    const btnPlayCtrl = document.getElementById('btn-play-ctrl');
    const btnMute = document.getElementById('btn-mute');
    const btnPip = document.getElementById('btn-pip');
    const btnFullscreen = document.getElementById('btn-fullscreen');
    const btnBack10 = document.getElementById('btn-back-10');
    const btnForward10 = document.getElementById('btn-forward-10');
    const volumeSlider = document.getElementById('control-volume-slider');
    const progressContainer = document.getElementById('progress-container');
    const progressCurrent = document.getElementById('progress-current');
    const progressBuffer = document.getElementById('progress-buffer');
    const progressHandle = document.getElementById('progress-handle');
    const currentTimeEl = document.getElementById('current-time');
    const durationTimeEl = document.getElementById('duration-time');
    const liveIndicator = document.getElementById('live-indicator');
    const centerFeedback = document.getElementById('player-center-feedback');
    const controlsContainer = document.getElementById('video-controls-container');

    const showCenterFeedback = (action) => {
        if (!centerFeedback) return;
        const iconContainer = centerFeedback.querySelector('.feedback-icon');
        let svg = '';
        switch (action) {
            case 'play': svg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; break;
            case 'pause': svg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'; break;
            case 'forward': svg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>'; break;
            case 'back': svg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg>'; break;
        }
        iconContainer.innerHTML = svg;
        centerFeedback.classList.remove('animate');
        void centerFeedback.offsetWidth;
        centerFeedback.classList.add('animate');
        setTimeout(() => centerFeedback.classList.remove('animate'), 500);
    };

    if (btnPlayCtrl) {
        btnPlayCtrl.addEventListener('click', () => {
            if (video.paused) { video.play(); showCenterFeedback('play'); }
            else { video.pause(); showCenterFeedback('pause'); }
        });
        const updatePlayIcon = () => {
            const icon = btnPlayCtrl.querySelector('.icon');
            if (video.paused) {
                icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
                btnPlayCtrl.title = 'Play';
            } else {
                icon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
                btnPlayCtrl.title = 'Pause';
            }
        };
        video.addEventListener('play', updatePlayIcon);
        video.addEventListener('pause', updatePlayIcon);
    }

    if (btnBack10) {
        btnBack10.addEventListener('click', () => {
            video.currentTime = Math.max(0, video.currentTime - 10);
            showCenterFeedback('back');
        });
    }

    if (btnForward10) {
        btnForward10.addEventListener('click', () => {
            if (video.duration) {
                video.currentTime = Math.min(video.duration, video.currentTime + 10);
                showCenterFeedback('forward');
            }
        });
    }

    if (btnMute && volumeSlider) {
        btnMute.addEventListener('click', () => { video.muted = !video.muted; });
        const updateMuteState = () => {
            btnMute.classList.toggle('muted', video.muted);
            const icon = btnMute.querySelector('.icon');
            if (video.muted || video.volume === 0) {
                icon.innerHTML = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
                volumeSlider.value = 0;
            } else {
                icon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
                volumeSlider.value = video.volume * 100;
            }
        };
        video.addEventListener('volumechange', updateMuteState);
        volumeSlider.addEventListener('input', () => {
            const val = parseInt(volumeSlider.value);
            video.volume = val / 100;
            if (val > 0) video.muted = false;
        });
    }

    if (btnPip) {
        if (document.pictureInPictureEnabled) {
            btnPip.addEventListener('click', async () => {
                try {
                    if (document.pictureInPictureElement) await document.exitPictureInPicture();
                    else await video.requestPictureInPicture();
                } catch (e) { }
            });
        } else btnPip.style.display = 'none';
    }

    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', () => {
            const container = document.querySelector('.tester-player-container');
            if (document.fullscreenElement) document.exitFullscreen();
            else container.requestFullscreen().catch(() => { });
        });
    }

    if (progressContainer) {
        const currentTimeEl = document.getElementById('current-time');
        const durationTimeEl = document.getElementById('duration-time');
        const liveIndicator = document.getElementById('live-indicator');
        const btnGoLive = document.getElementById('btn-go-live');

        const formatTime = (seconds) => {
            if (isNaN(seconds)) return '0:00';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            return `${m}:${s.toString().padStart(2, '0')}`;
        };

        const getSeekableRange = () => {
            if (shakaPlayer && shakaPlayer.isLive()) {
                const range = shakaPlayer.seekRange();
                return { start: range.start, end: range.end, isLive: true };
            }
            if (hlsPlayer && video.duration === Infinity) {
                const liveSync = hlsPlayer.liveSyncPosition || video.duration;
                if (video.seekable.length > 0) {
                    return { start: video.seekable.start(0), end: video.seekable.end(video.seekable.length - 1), isLive: true };
                }
            }
            if (!isFinite(video.duration) || video.duration > 86400) {
                if (video.seekable.length > 0) {
                    return { start: video.seekable.start(0), end: video.seekable.end(video.seekable.length - 1), isLive: true };
                }
            }
            return { start: 0, end: video.duration, isLive: false };
        };

        const updateProgress = () => {
            const range = getSeekableRange();
            const duration = range.end - range.start;
            const currentTime = video.currentTime;

            if (duration > 0 && isFinite(duration) && (!range.isLive || duration > 30)) {
                let percent = 0;
                if (range.isLive) {
                    percent = ((currentTime - range.start) / duration) * 100;
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

                percent = Math.max(0, Math.min(100, percent));
                progressCurrent.style.width = `${percent}%`;
                progressHandle.style.left = `${percent}%`;
                progressContainer.classList.remove('hidden');
                liveIndicator.classList.add('hidden');

                if (video.buffered.length > 0) {
                    const bufferedEnd = video.buffered.end(video.buffered.length - 1);
                    const bufferPercent = ((bufferedEnd - range.start) / duration) * 100;
                    progressBuffer.style.width = `${Math.max(0, Math.min(100, bufferPercent))}%`;
                }
            } else {
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
                    video.currentTime = range.end;
                    if (typeof showCenterFeedback === 'function') showCenterFeedback('forward');
                }
            });
        }

        video.addEventListener('timeupdate', updateProgress);
        video.addEventListener('loadedmetadata', updateProgress);

        progressContainer.addEventListener('click', (e) => {
            const rect = progressContainer.getBoundingClientRect();
            const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const range = getSeekableRange();
            if (isFinite(range.end)) {
                if (range.isLive) {
                    video.currentTime = range.start + (pos * (range.end - range.start));
                } else {
                    video.currentTime = pos * range.end;
                }
            }
        });

        progressContainer.addEventListener('mousemove', (e) => {
            const rect = progressContainer.getBoundingClientRect();
            const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const range = getSeekableRange();
            const progressTooltip = document.getElementById('progress-time-tooltip');

            if (progressTooltip) {
                progressTooltip.style.left = `${pos * 100}%`;
                if (range.isLive) {
                    const targetTime = range.start + (pos * (range.end - range.start));
                    const offset = range.end - targetTime;
                    progressTooltip.textContent = offset > 10 ? `-${formatTime(offset)}` : 'Live';
                } else {
                    progressTooltip.textContent = formatTime(pos * range.end);
                }
            }
        });
    }

    let controlsTimeout;
    const showControls = () => {
        controlsContainer.classList.remove('inactive');
        document.body.style.cursor = 'default';
        clearTimeout(controlsTimeout);
        if (!video.paused) controlsTimeout = setTimeout(hideControls, 3000);
    };
    const hideControls = () => {
        if (!video.paused) {
            controlsContainer.classList.add('inactive');
            document.body.style.cursor = 'none';
        }
    };
    const playerSection = document.querySelector('.tester-player-container');
    playerSection.addEventListener('mousemove', showControls);
    playerSection.addEventListener('click', showControls);
    video.addEventListener('pause', showControls);
    video.addEventListener('play', () => { clearTimeout(controlsTimeout); controlsTimeout = setTimeout(hideControls, 3000); });

    // --- Audio, Quality, Info, Debug Logic ---
    const btnInfo = document.getElementById('btn-info');
    const btnAudio = document.getElementById('btn-audio');
    const btnQuality = document.getElementById('btn-quality');
    const audioMenu = document.getElementById('audio-menu');
    const qualityMenu = document.getElementById('quality-menu');
    const nowPlaying = document.getElementById('now-playing');

    let showDebug = false;
    let debugTimer = null;
    let lastFpsUpdate = performance.now();
    let lastDecodedFrames = 0;
    let lastDroppedFrames = 0;

    // Menus
    if (btnQuality && qualityMenu) {
        btnQuality.addEventListener('click', (e) => {
            e.stopPropagation();
            if (audioMenu) audioMenu.classList.add('hidden');
            qualityMenu.classList.toggle('hidden');
            if (!qualityMenu.classList.contains('hidden')) updateQualityMenu();
        });
    }

    if (btnAudio && audioMenu) {
        btnAudio.addEventListener('click', (e) => {
            e.stopPropagation();
            if (qualityMenu) qualityMenu.classList.add('hidden');
            audioMenu.classList.toggle('hidden');
            if (!audioMenu.classList.contains('hidden')) updateAudioMenu();
        });
    }

    document.addEventListener('click', () => {
        if (qualityMenu) qualityMenu.classList.add('hidden');
        if (audioMenu) audioMenu.classList.add('hidden');
    });

    // OSD / Info
    let overlayTimer = null;
    if (btnInfo && nowPlaying) {
        btnInfo.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('osd-channel-name').textContent = document.getElementById('info-name').value || 'Tester Stream';
            nowPlaying.classList.remove('hidden');
            clearTimeout(overlayTimer);
            overlayTimer = setTimeout(() => { nowPlaying.classList.add('hidden'); }, 4000);
        });
    }

    // Audio Logic
    const updateAudioMenu = () => {
        const audioList = document.getElementById('audio-list');
        if (!audioList) return;
        audioList.innerHTML = '';
        let tracks = [];
        if (shakaPlayer) {
            const audioTracks = shakaPlayer.getLanguagesAndRoles('audio');
            const currentTrack = shakaPlayer.getVariantTracks().find(t => t.active);
            tracks = audioTracks.map((t, index) => ({
                id: index,
                language: t.language,
                role: t.role,
                label: `${t.language}${t.role ? ` (${t.role})` : ''}`,
                active: currentTrack && currentTrack.language === t.language && (currentTrack.roles || []).includes(t.role)
            }));
            if (currentTrack && !tracks.some(t => t.active)) {
                tracks.forEach(t => { if (t.language === currentTrack.language) t.active = true; });
            }
        } else if (hlsPlayer) {
            tracks = hlsPlayer.audioTracks.map((track, index) => ({
                id: index,
                label: track.name || track.lang || `Track ${index}`,
                active: hlsPlayer.audioTrack === index
            }));
        }
        if (tracks.length === 0) {
            audioList.innerHTML = '<li class="hint">No alternative tracks</li>';
            return;
        }
        tracks.forEach(track => {
            const li = document.createElement('li');
            li.dataset.id = track.id;
            if (track.active) li.classList.add('active');
            li.textContent = track.label;
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                if (shakaPlayer) {
                    try { shakaPlayer.selectAudioLanguage(track.language, track.role); } catch (ex) { }
                } else if (hlsPlayer) {
                    hlsPlayer.audioTrack = track.id;
                }
                audioMenu.classList.add('hidden');
            });
            audioList.appendChild(li);
        });
    };

    // Quality Logic
    const updateQualityMenu = () => {
        const qualityList = document.getElementById('quality-list');
        if (!qualityList) return;
        // Check if Auto is currently selected somehow - for tester, we just assume Auto if abr is enabled
        const isAuto = shakaPlayer ? shakaPlayer.getConfiguration().abr.enabled : (hlsPlayer ? hlsPlayer.currentLevel === -1 : true);
        qualityList.innerHTML = `<li data-level="-1" class="${isAuto ? 'active' : ''}">Auto</li>`;
        let tracks = [];
        if (shakaPlayer) {
            const allTracks = shakaPlayer.getVariantTracks();
            const seenRes = new Set();
            tracks = allTracks.filter(t => {
                const res = `${t.width}x${t.height}`;
                if (seenRes.has(res)) return false;
                seenRes.add(res);
                return true;
            }).sort((a, b) => b.height - a.height).map(t => ({
                id: t.id,
                label: t.height ? `${t.height}p` : `${t.bandwidth}bps`,
                height: t.height,
                active: !isAuto && t.active
            }));
        } else if (hlsPlayer) {
            tracks = hlsPlayer.levels.map((level, index) => ({
                id: index,
                label: level.height ? `${level.height}p` : `${level.name || index}`,
                height: level.height,
                active: !isAuto && hlsPlayer.currentLevel === index
            }));
        }
        tracks.forEach(track => {
            const li = document.createElement('li');
            li.dataset.level = track.id;
            if (track.active) li.classList.add('active');
            li.textContent = track.label;
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                if (shakaPlayer) {
                    shakaPlayer.configure({ abr: { enabled: false } });
                    const variantTracks = shakaPlayer.getVariantTracks();
                    const selectedTrack = variantTracks.find(t => t.id === track.id);
                    if (selectedTrack) shakaPlayer.selectVariantTrack(selectedTrack, true);
                } else if (hlsPlayer) {
                    hlsPlayer.currentLevel = track.id;
                }
                qualityMenu.classList.add('hidden');
            });
            qualityList.appendChild(li);
        });
        const autoOption = qualityList.querySelector('li[data-level="-1"]');
        if (autoOption) {
            autoOption.addEventListener('click', (e) => {
                e.stopPropagation();
                if (shakaPlayer) shakaPlayer.configure({ abr: { enabled: true } });
                else if (hlsPlayer) hlsPlayer.currentLevel = -1;
                qualityMenu.classList.add('hidden');
            });
        }
    };

    // Debug Stats Logic
    const toggleDebug = () => {
        showDebug = !showDebug;
        const debugEl = document.getElementById('debug-stats');
        if (!debugEl) return;
        if (showDebug) {
            debugEl.classList.remove('hidden');
            updateDebugInfo();
            debugTimer = setInterval(updateDebugInfo, 2000);
        } else {
            debugEl.classList.add('hidden');
            if (debugTimer) { clearInterval(debugTimer); debugTimer = null; }
        }
    };

    const updateDebugInfo = () => {
        const debugEl = document.getElementById('debug-stats');
        if (!debugEl || !showDebug) return;
        try {
            let memory = 'N/A';
            if (performance.memory) {
                const used = performance.memory.usedJSHeapSize / 1048576;
                const total = performance.memory.jsHeapSizeLimit / 1048576;
                memory = `${used.toFixed(1)} / ${total.toFixed(0)} MB`;
            }

            let videoCodec = 'Unknown', audioCodec = 'Unknown', liveLatency = 'N/A';
            if (shakaPlayer) {
                try {
                    const variant = (shakaPlayer.getVariantTracks() || []).find(t => t.active);
                    if (variant) { videoCodec = variant.videoCodec || 'Unknown'; audioCodec = variant.audioCodec || 'Unknown'; }
                    const latency = shakaPlayer.getLiveLatency();
                    if (latency != null && !isNaN(latency)) liveLatency = `${latency.toFixed(2)}s`;
                } catch (e) { }
            } else if (hlsPlayer) {
                videoCodec = 'H.264'; audioCodec = 'AAC';
                if (hlsPlayer.latency != null && !isNaN(hlsPlayer.latency)) liveLatency = `${hlsPlayer.latency.toFixed(2)}s`;
            }

            let fps = 0, stressScore = 0;
            if (video.getVideoPlaybackQuality) {
                const q = video.getVideoPlaybackQuality();
                const currentFrames = q.totalVideoFrames;
                const currentDropped = q.droppedVideoFrames || 0;
                const currentTime = performance.now();
                if (lastFpsUpdate > 0) {
                    const dt = (currentTime - lastFpsUpdate) / 1000;
                    if (dt > 0.1) {
                        fps = (currentFrames - lastDecodedFrames) / dt;
                        stressScore = (currentDropped - lastDroppedFrames) / dt;
                    }
                }
                lastDecodedFrames = currentFrames;
                lastDroppedFrames = currentDropped;
                lastFpsUpdate = currentTime;
            }

            let bandwidth = 0, netEfficiency = '100%';
            if (shakaPlayer) {
                try {
                    const stats = shakaPlayer.getStats();
                    bandwidth = (stats.estimatedBandwidth || 0) / 1e6;
                    const variantBitrate = (stats.variantBandwidth || 0) / 1e6;
                    if (variantBitrate > 0) netEfficiency = `${((bandwidth / variantBitrate) * 100).toFixed(0)}%`;
                } catch (e) { }
            } else if (hlsPlayer && hlsPlayer.levels) {
                const current = (hlsPlayer.currentLevel >= 0) ? hlsPlayer.currentLevel : hlsPlayer.loadLevel;
                if (current >= 0 && hlsPlayer.levels[current]) bandwidth = (hlsPlayer.levels[current].bitrate || 0) / 1e6;
            }

            let output = `[TESTER NERD STATS]\n\n`;
            output += `[SYSTEM]\nMemory: ${memory}\nEngine: ${shakaPlayer ? 'Shaka' : (hlsPlayer ? 'HLS.js' : 'Native')}\n\n`;
            output += `[VIDEO/AUDIO]\nRes: ${video.videoWidth || 0}x${video.videoHeight || 0}\nFPS: ${fps > 0 ? fps.toFixed(1) : '...'}\nDrops/s: ${stressScore.toFixed(1)}\nLatency: ${liveLatency}\n`;
            output += `V-Codec: ${videoCodec}\nA-Codec: ${audioCodec}\n\n`;
            output += `[NETWORK]\nEst. Bandwidth: ${bandwidth.toFixed(2)} Mbps\nEfficiency: ${netEfficiency}\n`;
            debugEl.textContent = output.trim();
        } catch (err) {
            debugEl.textContent = "Debug module error: " + err.message;
        }
    };

    document.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 'd' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
            toggleDebug();
        }
    });

});
