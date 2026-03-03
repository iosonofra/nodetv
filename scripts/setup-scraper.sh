#!/bin/sh
# Setup script for NodeCast-TV Scraper on Alpine Linux

echo "[*] Installing system dependencies for Playwright/Chromium..."
apk add --no-cache \
    python3 \
    py3-pip \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    dbus-libs \
    libstdc++

echo "[*] Installing Python dependencies..."
# Use --break-system-packages for newer Alpine/Python versions if needed, 
# or use a venv (recommended but for simplicity we assume direct install for LXC)
pip3 install --no-cache-dir playwright playwright-stealth

echo "[*] Configuring Playwright..."
# We don't need to run 'playwright install' because we use system chromium
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

echo "[*] Verifying installations..."
python3 --version
pip3 list | grep playwright
chromium-browser --version

echo "[✓] Setup complete! You can now run the scraper from the Settings page."
