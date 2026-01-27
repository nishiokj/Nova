#!/bin/bash
# Template: Multi-Site Authentication with Stealth Mode
# Log into multiple sites once with anti-detection settings, save state, reuse
#
# Usage:
#   ./multi-site-auth-stealth.sh
#
# This script will:
# 1. Open each site in a REAL Chrome browser (not Playwright's bundled browser)
# 2. Apply stealth settings to avoid detection
# 3. Prompt you to manually complete login (handles 2FA, captchas, OAuth)
# 4. Save authentication state for each site

set -euo pipefail

# ══════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════

# State files directory
STATE_DIR="./auth-states"
mkdir -p "$STATE_DIR"

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

# Stealth arguments for Chrome (comma-separated for --args flag)
STEALTH_ARGS="--disable-blink-features=AutomationControlled,--exclude-switches=enable-automation,--disable-infobars"

# Realistic user agent string (macOS Chrome)
USER_AGENT="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

# Detect OS and set appropriate user agent
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

# Get URL for a site
get_site_url() {
    case "$1" in
        "x") echo "https://x.com" ;;
        "google-ai") echo "https://aistudio.google.com" ;;
        "youtube") echo "https://www.youtube.com" ;;
        "github") echo "https://github.com" ;;
        *) echo "" ;;
    esac
}

# List of sites to authenticate
SITES="x google-ai youtube github"

# ══════════════════════════════════════════════════════════════
# LOGIN FUNCTIONS
# ══════════════════════════════════════════════════════════════

# Login to a specific site and save state
login_and_save_state() {
    local site_name="$1"
    local login_url="$2"
    local state_file="$3"

    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║  LOGIN: $site_name                                         ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""

    # Check if state already exists
    if [[ -f "$state_file" ]]; then
        echo "⚠️  Found existing state: $state_file"
        read -p "   Re-authenticate and overwrite? (y/N): " overwrite
        if [[ "$overwrite" != "y" ]] && [[ "$overwrite" != "Y" ]]; then
            echo "   Skipping $site_name (using existing state)"
            return 0
        fi
        rm -f "$state_file"
    fi

    echo "📂 Opening browser to: $login_url"
    echo "🛡️  Stealth mode: Using real Chrome with anti-detection settings"
    echo "👤 Please complete login manually (handles 2FA, captcha, etc.)"
    echo ""

    # Build launch command
    LAUNCH_CMD="agent-browser --session \"$site_name\" --headless=false"

    if [[ -n "$CHROME_PATH" ]]; then
        LAUNCH_CMD="$LAUNCH_CMD --executable-path \"$CHROME_PATH\""
        echo "   Chrome: $CHROME_PATH"
    else
        echo "   ⚠️  Chrome not found, using bundled Chromium (less stealth)"
    fi

    LAUNCH_CMD="$LAUNCH_CMD --user-agent \"$USER_AGENT\" --args=\"$STEALTH_ARGS\" open \"$login_url\""

    # Open site in headed mode with stealth settings
    eval "$LAUNCH_CMD"

    # Wait for user to complete login
    echo ""
    read -p "✅ Press Enter after you've successfully logged in..."

    # Verify we're not on the login page anymore
    current_url=""
    if command -v agent-browser >/dev/null 2>&1; then
        current_url=$(agent-browser --session "$site_name" get url 2>/dev/null || echo "")
    fi

    if [[ -n "$current_url" ]]; then
        if [[ "$current_url" == *"login"* ]] || [[ "$current_url" == *"signin"* ]]; then
            echo "⚠️  Warning: Still appears to be on login page: $current_url"
            read -p "   Continue anyway? (y/N): " continue_anyway
            if [[ "$continue_anyway" != "y" ]] && [[ "$continue_anyway" != "Y" ]]; then
                echo "❌ Skipping $site_name (incomplete login)"
                agent-browser --session "$site_name" close
                return 1
            fi
        fi
    fi

    # Save authentication state
    echo "💾 Saving authentication state to: $state_file"
    agent-browser --session "$site_name" state save "$state_file"

    # Close the browser
    agent-browser --session "$site_name" close

    echo "✅ Saved auth state for $site_name"
    echo ""
}

# ══════════════════════════════════════════════════════════════
# MAIN EXECUTION
# ══════════════════════════════════════════════════════════════

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  MULTI-SITE AUTHENTICATION (STEALTH MODE)"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "This will guide you through logging into:"
for site in $SITES; do
    url=$(get_site_url "$site")
    echo "  • $site ($url)"
done
echo ""
echo "Stealth features:"
if [[ -n "$CHROME_PATH" ]]; then
    echo "  ✅ Real Chrome browser (not Playwright's bundled browser)"
else
    echo "  ⚪ Chrome not found (using bundled Chromium)"
fi
echo "  ✅ Anti-detection launch arguments"
echo "  ✅ Realistic user agent string"
echo "  ✅ No automation flags"
echo ""
echo "Each login will be done in a visible browser window."
echo "You can complete 2FA, solve captchas, etc. manually."
echo ""
read -p "Press Enter to begin..."

# Authenticate each site
for site in $SITES; do
    url=$(get_site_url "$site")
    state_file="$STATE_DIR/${site}-auth.json"
    if [[ -n "$url" ]]; then
        login_and_save_state "$site" "$url" "$state_file"
    fi
done

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  SETUP COMPLETE!"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Auth states saved to:"
ls -la "$STATE_DIR"
echo ""
echo "Next steps:"
echo "  1. Use ./multi-site-auth-usage.sh to load saved states"
echo "  2. For stealth usage, use the same Chrome path and args:"
echo ""
if [[ -n "$CHROME_PATH" ]]; then
    echo "   agent-browser --session <site> \\"
    echo "     --executable-path \"$CHROME_PATH\" \\"
    echo "     --user-agent \"$USER_AGENT\" \\"
    echo "     --args=\"$STEALTH_ARGS\" \\"
    echo "     state load ./auth-states/<site>-auth.json"
else
    echo "   agent-browser --session <site> \\"
    echo "     --user-agent \"$USER_AGENT\" \\"
    echo "     --args=\"$STEALTH_ARGS\" \\"
    echo "     state load ./auth-states/<site>-auth.json"
fi
echo ""
echo "Security reminder: Never commit auth-state files!"
