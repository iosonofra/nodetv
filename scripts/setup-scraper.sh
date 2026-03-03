#!/bin/sh
# Setup script for NodeCast-TV Scraper on Alpine Linux (Virtualenv Version)

set -e

SCRAPER_DIR="$(dirname "$0")/../scraper"
cd "$SCRAPER_DIR"

echo "[*] Installing system dependencies via apk..."
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

echo "[*] Creating Python Virtualenv..."
python3 -m venv venv

echo "[*] Installing Python dependencies into venv..."
# No need for --break-system-packages inside a venv
./venv/bin/pip install --no-cache-dir playwright playwright-stealth

echo "[*] Configuring Playwright..."
# We use system chromium, so skip the big heavy downloads
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

echo "[*] Verifying installations..."
./venv/bin/python3 --version
chromium-browser --version

echo "[*] Verifying Python modules in venv..."
if ./venv/bin/python3 -c "import playwright; import playwright_stealth; print('[✓] Playwright modules found in venv')" 2>/dev/null; then
    echo "[✓] Virtualenv setup verified successfully!"
else
    echo "[!] ERROR: Modules not found in venv. Please check the logs above."
    exit 1
fi

echo ""
echo "[✓] Virtualenv setup complete!"
echo "[*] The scraper will now use the private environment in: $SCRAPER_DIR/venv"
echo "[*] You can now restart the application or run the scraper from the Settings page."
