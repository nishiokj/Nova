#!/bin/bash
# Template: Multi-Site Authentication Setup
# Log into multiple sites once, save state, reuse for all future runs
#
# Usage:
#   ./multi-site-auth-setup.sh
#
# This script will:
# 1. Open each site in headed mode (visible browser)
# 2. Prompt you to manually complete login (handles 2FA, captchas, OAuth)
# 3. Save authentication state for each site
# 4. Create a reusable workflow script

set -euo pipefail

# ══════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════

# State files directory
STATE_DIR="./auth-states"
mkdir -p "$STATE_DIR"

# Sites to authenticate with
declare -A SITES=(
    ["x"]="https://x.com"
    ["google-ai"]="https://aistudio.google.com"
    ["youtube"]="https://www.youtube.com"
    ["github"]="https://github.com"
)

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
        if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
            echo "   Skipping $site_name (using existing state)"
            return 0
        fi
        rm -f "$state_file"
    fi

    echo "📂 Opening browser to: $login_url"
    echo "👤 Please complete login manually (handles 2FA, captcha, etc.)"
    echo ""

    # Open site in headed mode
    agent-browser --session "$site_name" --headed open "$login_url"

    # Wait for user to complete login
    echo ""
    read -p "✅ Press Enter after you've successfully logged in..."

    # Verify we're not on the login page anymore
    current_url=$(agent-browser --session "$site_name" get url)

    if [[ "$current_url" == *"login"* ]] || [[ "$current_url" == *"signin"* ]]; then
        echo "⚠️  Warning: Still appears to be on login page: $current_url"
        read -p "   Continue anyway? (y/N): " continue_anyway
        if [[ ! "$continue_anyway" =~ ^[Yy]$ ]]; then
            echo "❌ Skipping $site_name (incomplete login)"
            agent-browser --session "$site_name" close
            return 1
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
echo "  MULTI-SITE AUTHENTICATION SETUP"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "This will guide you through logging into:"
for site in "${!SITES[@]}"; do
    echo "  • $site (${SITES[$site]})"
done
echo ""
echo "Each login will be done in a visible browser window."
echo "You can complete 2FA, solve captchas, etc. manually."
echo ""
read -p "Press Enter to begin..."

# Authenticate each site
for site in "${!SITES[@]}"; do
    state_file="$STATE_DIR/${site}-auth.json"
    login_and_save_state "$site" "${SITES[$site]}" "$state_file"
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
echo "  2. Or use individual commands:"
for site in "${!SITES[@]}"; do
    state_file="$STATE_DIR/${site}-auth.json"
    echo "     agent-browser --session $site state load $state_file"
    echo "     agent-browser --session $site open ${SITES[$site]}"
done
echo ""
echo "Security reminder: Never commit auth-state files!"
