class ScraperSettings {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('tab-connectivity');
        this.init();
    }

    init() {
        this.render();
        this.bindEvents();
        this.updateStatus();
    }

    render() {
        const scraperSection = document.createElement('div');
        scraperSection.className = 'settings-section';
        scraperSection.style.marginTop = 'var(--space-2xl)';
        scraperSection.innerHTML = `
            <h3>EVENTI-LIVE Scraper</h3>
            <p class="hint">Automatic event scraping via Playwright (Python)</p>
            
            <div class="warp-status-card">
                <div class="warp-status-main">
                    <div class="status-indicator">
                        <span id="scraper-status-dot" class="status-dot status-disconnected"></span>
                        <span id="scraper-status-text">Checking status...</span>
                    </div>
                    <div class="warp-actions">
                        <button id="btn-scraper-run" class="btn btn-primary">Run Now</button>
                        <a href="/api/scraper/playlist" class="btn btn-secondary" target="_blank" download="eventi-live.m3u" style="margin-left: 10px;">Download M3U</a>
                    </div>
                </div>
                <div id="scraper-last-run" style="font-size: 0.82rem; color: var(--color-text-secondary); margin-top: 8px; padding: 0 4px;"></div>
                
                <div class="scraper-logs-container" style="background: #000; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 0.8rem; color: #0f0; height: 150px; overflow-y: auto; margin-top: 10px; border: 1px solid var(--color-border);">
                    <div id="scraper-logs">Checking scraper status...</div>
                </div>
            </div>

            <div class="warp-info-box">
                <h4>Scraper Details</h4>
                <ul>
                    <li><strong>Schedule:</strong> Runs automatically every 60 minutes.</li>
                    <li><strong>Output:</strong> Generates a shared playlist accessible to all users.</li>
                </ul>
            </div>
        `;
        this.container.appendChild(scraperSection);

        this.statusDot = document.getElementById('scraper-status-dot');
        this.statusText = document.getElementById('scraper-status-text');
        this.logsContainer = document.getElementById('scraper-logs');
        this.runBtn = document.getElementById('btn-scraper-run');
        this.lastRunEl = document.getElementById('scraper-last-run');
    }

    bindEvents() {
        this.runBtn.addEventListener('click', () => this.runScraper());
    }

    async updateStatus() {
        try {
            const status = await API.scraper.getStatus();

            if (status.inProgress) {
                this.statusDot.className = 'status-dot status-connecting';
                this.statusText.textContent = 'Scraping in progress...';
                this.runBtn.disabled = true;
            } else {
                this.statusDot.className = 'status-dot status-connected';
                this.statusText.textContent = 'Idle';
                this.runBtn.disabled = false;
            }

            // Show last run timestamp
            this.updateLastRunInfo(status.lastRun);

            if (status.logs && status.logs.length > 0) {
                this.logsContainer.innerHTML = status.logs.join('<br>');
                const parent = this.logsContainer.parentElement;
                parent.scrollTop = parent.scrollHeight;
            }
        } catch (err) {
            console.error('Failed to update scraper status:', err);
            if (this.statusText) this.statusText.textContent = 'Error: ' + err.message;
        }
    }

    updateLastRunInfo(lastRun) {
        if (!this.lastRunEl) return;

        if (!lastRun || !lastRun.endTime) {
            this.lastRunEl.textContent = 'No runs recorded yet.';
            return;
        }

        const endDate = new Date(lastRun.endTime);
        const timeStr = endDate.toLocaleString();
        const ago = this.timeAgo(endDate);
        const icon = lastRun.status === 'success' ? '✅' : '❌';
        this.lastRunEl.innerHTML = `${icon} Last run: <strong>${timeStr}</strong> (${ago})`;
    }

    timeAgo(date) {
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    async runScraper() {
        try {
            this.runBtn.disabled = true;
            await API.scraper.run();
            this.updateStatus();
            // Poll for updates while running
            this.pollStatus();
        } catch (err) {
            console.error('Failed to run scraper:', err);
            alert('Failed to run scraper: ' + err.message);
            this.runBtn.disabled = false;
        }
    }

    pollStatus() {
        const interval = setInterval(async () => {
            try {
                await this.updateStatus();
                const status = await API.scraper.getStatus();
                if (!status.inProgress) {
                    clearInterval(interval);
                }
            } catch (err) {
                clearInterval(interval);
            }
        }, 2000);
    }
}

window.ScraperSettings = ScraperSettings;
