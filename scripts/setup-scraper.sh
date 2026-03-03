#!/bin/sh
# Setup script for NodeCast-TV Scraper on Alpine Linux (Node.js/Puppeteer Version)

set -e

# System dependencies for Chromium on Alpine
echo "[*] Installing system dependencies via apk..."
apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    dbus-libs \
    libstdc++ \
    nodejs \
    npm

echo "[*] Installing Node.js dependencies for scraper..."
# Install the new dependencies added to package.json
npm install

echo "[*] Configuring Puppeteer environment..."
# We use system chromium to avoid musl libc issues with bundled chrome
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

echo "[*] Verifying installations..."
node --version
npm --version
chromium-browser --version

echo "[*] Verifying Puppeteer modules..."
if node -e "require('puppeteer-core'); require('puppeteer-extra'); require('puppeteer-extra-plugin-stealth'); console.log('[✓] Puppeteer modules found')" 2>/dev/null; then
    echo "[✓] Node.js setup verified successfully!"
else
    echo "[!] ERROR: Modules not found. Please try running 'npm install' manually."
    exit 1
fi

echo ""
echo "[✓] Setup complete!"
echo "[*] The scraper is now configured to use Node.js and system Chromium."
echo "[*] You can now restart the application or run the scraper from the Settings page."
