#!/bin/bash
# Template: Multi-Site Authenticated Usage
# Load saved authentication states and perform actions
#
# Usage:
#   ./multi-site-auth-usage.sh [site] [action] [url-or-args]
#
# Examples:
#   ./multi-site-auth-usage.sh github open https://github.com/dashboard
#   ./multi-site-auth-usage.sh youtube snapshot -i
#   ./multi-site-auth-usage.sh google-ai screenshot /tmp/google-ai.png
#
# Without arguments: Show all available sites and their URLs

set -euo pipefail

# ══════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════

STATE_DIR="./auth-states"
mkdir -p "$STATE_DIR"

declare -A SITES=(
    ["x"]="https://x.com"
    ["google-ai"]="https://aistudio.google.com"
    ["youtube"]="https://www.youtube.com"
    ["github"]="https://github.com"
)

# ══════════════════════════════════════════════════════════════
# FUNCTIONS
# ══════════════════════════════════════════════════════════════

# Load auth state for a site
load_auth_state() {
    local site_name="$1"
    local state_file="$STATE_DIR/${site_name}-auth.json"

    if [[ ! -f "$state_file" ]]; then
        echo "❌ No auth state found for: $site_name"
        echo "   Run ./multi-site-auth-setup.sh first"
        exit 1
    fi

    echo "📂 Loading auth state: $state_file"
    agent-browser --session "$site_name" state load "$state_file"
}

# Show all available sites
show_sites() {
    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  AVAILABLE AUTHENTICATED SITES"
    echo "════════════════════════════════════════════════════════════"
    echo ""

    for site in "${!SITES[@]}"; do
        state_file="$STATE_DIR/${site}-auth.json"
        if [[ -f "$state_file" ]]; then
            echo "✅ $site - Auth state saved"
            echo "   URL: ${SITES[$site]}"
            echo "   State: $state_file"
        else
            echo "⚪ $site - Not configured"
            echo "   URL: ${SITES[$site]}"
        fi
        echo ""
    done

    echo "Usage:"
    echo "  ./multi-site-auth-usage.sh [site] [action] [args...]"
    echo ""
    echo "Examples:"
    for site in "${!SITES[@]}"; do
        state_file="$STATE_DIR/${site}-auth.json"
        if [[ -f "$state_file" ]]; then
            echo "  ./multi-site-auth-usage.sh $site snapshot -i"
        fi
    done
    echo ""
}

# ══════════════════════════════════════════════════════════════
# MAIN EXECUTION
# ══════════════════════════════════════════════════════════════

if [[ $# -eq 0 ]]; then
    show_sites
    exit 0
fi

site_name="$1"
action="$2"
shift 2 || true

# Validate site name
if [[ -z "${SITES[$site_name]+isset}" ]]; then
    echo "❌ Unknown site: $site_name"
    echo ""
    echo "Available sites:"
    for site in "${!SITES[@]}"; do
        echo "  • $site"
    done
    echo ""
    echo "Usage: ./multi-site-auth-usage.sh [site] [action] [args...]"
    exit 1
fi

# Load auth state
load_auth_state "$site_name"

# Execute command
echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║  SITE: $site_name                                            ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
echo "🔵 Executing: agent-browser --session $site_name $action $*"
echo ""

agent-browser --session "$site_name" "$action" "$@"

echo ""
echo "✅ Command completed"
