/**
 * Guide Page Controller
 */

class GuidePage {
    constructor(app) {
        this.app = app;
    }

    async init() {
        // EPG guide will lazy load when shown
    }

    async show() {
        // Only load EPG data if not already loaded
        if (!this.app.epgGuide.programmes || this.app.epgGuide.programmes.length === 0) {
            await this.app.epgGuide.loadEpg();
        } else {
            // Just re-render with existing data (updates time position)
            this.app.epgGuide.render();
        }
    }

    hide() {
        // Page is hidden
    }
}

window.GuidePage = GuidePage;
