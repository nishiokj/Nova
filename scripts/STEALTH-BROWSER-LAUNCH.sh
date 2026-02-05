#!/bin/bash
# Template: Launch Browser with Anti-Detection Settings
# Avoid being detected as an automated/test browser
#
# Usage:
#   ./STEALTH-BROWSER-LAUNCH.sh [site-name] [url]
#
# Examples:
#   ./STEALTH-BROWSER-LAUNCH.sh github
#   ./STEALTH-BROWSER-LAUNCH.sh github https://github.com

set -euo pipefail

SITE_NAME="${1:-default}"
URL="${2:-}"

# ══════════════════════════════════════════════════════════════
# STEALTH CONFIGURATION
# ══════════════════════════════════════════════════════════════

# Chrome launch arguments to avoid detection (comma-separated for --args)
STEALTH_ARGS="--disable-blink-features=AutomationControlled,--exclude-switches=enable-automation,--disable-infobars,--disable-features=IsolateOrigins,site-per-process"

# Detect OS and set user agent
detect_user_agent() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        echo "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    else
        echo "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    fi
}

USER_AGENT=$(detect_user_agent)

# Find Chrome executable path
find_chrome_path() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if [[ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
            echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        elif [[ -f "/Applications/Chromium.app/Contents/MacOS/Chromium" ]]; then
            echo "/Applications/Chromium.app/Contents/MacOS/Chromium"
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        if command -v google-chrome >/dev/null 2>&1; then
            command -v google-chrome
        elif command -v chromium-browser >/dev/null 2>&1; then
            command -v chromium-browser
        elif command -v chromium >/dev/null 2>&1; then
            command -v chromium
        fi
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        # Windows (Git Bash, MSYS2, Cygwin)
        if [[ -f "/c/Program Files/Google/Chrome/Application/chrome.exe" ]]; then
            echo "/c/Program Files/Google/Chrome/Application/chrome.exe"
        elif [[ -f "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" ]]; then
            echo "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
        fi
    fi
}

CHROME_PATH=$(find_chrome_path)

# ══════════════════════════════════════════════════════════════
# EXECUTION
# ══════════════════════════════════════════════════════════════

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  LAUNCHING STEALTH BROWSER"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Session: $SITE_NAME"
echo "User Agent: Chrome (detected OS)"

if [[ -n "$CHROME_PATH" ]]; then
    echo "Using Chrome: $CHROME_PATH"
else
    echo "⚠️  Chrome not found, using bundled Chromium"
    echo "   For better stealth, install Chrome:"
    echo "   - macOS: Already installed or download from google.com/chrome"
    echo "   - Linux: sudo apt-get install google-chrome-stable"
    echo "   - Windows: Download from google.com/chrome"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  LAUNCH COMMAND:"
echo "════════════════════════════════════════════════════════════"
echo ""

# Build and display launch command
LAUNCH_CMD="agent-browser --session \"$SITE_NAME\" --headless=false --user-agent \"$USER_AGENT\" --args=\"$STEALTH_ARGS\""

if [[ -n "$CHROME_PATH" ]]; then
    LAUNCH_CMD="$LAUNCH_CMD --executable-path \"$CHROME_PATH\""
fi

if [[ -n "$URL" ]]; then
    LAUNCH_CMD="$LAUNCH_CMD open \"$URL\""
fi

echo "$LAUNCH_CMD"
echo ""
read -p "Press Enter to launch browser..."

# Execute launch command
eval "$LAUNCH_CMD"

echo ""
echo "✅ Browser launched with stealth settings"
echo ""
echo "Stealth features enabled:"
echo "  • navigator.webdriver hidden"
echo "  • Automation infobars disabled"
echo "  • Realistic user agent"
echo "  • CDP detection minimized"
