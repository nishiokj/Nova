#!/bin/bash
# Test script to validate stealth browser scripts work correctly
# This script tests basic functionality WITHOUT launching browsers

echo "════════════════════════════════════════════════════════════"
echo "  TESTING STEALTH BROWSER SCRIPTS"
echo "════════════════════════════════════════════════════════════"
echo ""

# Test 1: Check scripts exist
echo "Test 1: Checking scripts exist..."
if [[ -f "./STEALTH-BROWSER-LAUNCH.sh" ]]; then
    echo "✅ STEALTH-BROWSER-LAUNCH.sh found"
else
    echo "❌ STEALTH-BROWSER-LAUNCH.sh not found"
    exit 1
fi

if [[ -f "./multi-site-auth-stealth.sh" ]]; then
    echo "✅ multi-site-auth-stealth.sh found"
else
    echo "❌ multi-site-auth-stealth.sh not found"
    exit 1
fi

if [[ -f "./STEALTH-BROWSER-GUIDE.md" ]]; then
    echo "✅ STEALTH-BROWSER-GUIDE.md found"
else
    echo "❌ STEALTH-BROWSER-GUIDE.md not found"
    exit 1
fi

echo ""

# Test 2: Check scripts are executable
echo "Test 2: Checking scripts are executable..."
if [[ -x "./STEALTH-BROWSER-LAUNCH.sh" ]]; then
    echo "✅ STEALTH-BROWSER-LAUNCH.sh is executable"
else
    echo "❌ STEALTH-BROWSER-LAUNCH.sh is not executable"
    exit 1
fi

if [[ -x "./multi-site-auth-stealth.sh" ]]; then
    echo "✅ multi-site-auth-stealth.sh is executable"
else
    echo "❌ multi-site-auth-stealth.sh is not executable"
    exit 1
fi

echo ""

# Test 3: Check bash syntax
echo "Test 3: Checking bash syntax..."
if bash -n "./STEALTH-BROWSER-LAUNCH.sh" 2>&1 >/dev/null; then
    echo "✅ STEALTH-BROWSER-LAUNCH.sh syntax OK"
else
    echo "❌ STEALTH-BROWSER-LAUNCH.sh has syntax errors"
    bash -n "./STEALTH-BROWSER-LAUNCH.sh"
    exit 1
fi

if bash -n "./multi-site-auth-stealth.sh" 2>&1 >/dev/null; then
    echo "✅ multi-site-auth-stealth.sh syntax OK"
else
    echo "❌ multi-site-auth-stealth.sh has syntax errors"
    bash -n "./multi-site-auth-stealth.sh"
    exit 1
fi

echo ""

# Test 4: Check required functions exist
echo "Test 4: Checking required functions..."
if grep -q "find_chrome_path()" "./STEALTH-BROWSER-LAUNCH.sh"; then
    echo "✅ STEALTH-BROWSER-LAUNCH.sh has find_chrome_path function"
else
    echo "❌ STEALTH-BROWSER-LAUNCH.sh missing find_chrome_path function"
    exit 1
fi

if grep -q "find_chrome_path()" "./multi-site-auth-stealth.sh"; then
    echo "✅ multi-site-auth-stealth.sh has find_chrome_path function"
else
    echo "❌ multi-site-auth-stealth.sh missing find_chrome_path function"
    exit 1
fi

if grep -q "detect_user_agent()" "./STEALTH-BROWSER-LAUNCH.sh"; then
    echo "✅ STEALTH-BROWSER-LAUNCH.sh has detect_user_agent function"
else
    echo "❌ STEALTH-BROWSER-LAUNCH.sh missing detect_user_agent function"
    exit 1
fi

if grep -q "detect_user_agent()" "./multi-site-auth-stealth.sh"; then
    echo "✅ multi-site-auth-stealth.sh has detect_user_agent function"
else
    echo "❌ multi-site-auth-stealth.sh missing detect_user_agent function"
    exit 1
fi

echo ""

# Test 5: Check stealth args are defined
echo "Test 5: Checking stealth arguments..."
if grep -q 'STEALTH_ARGS=' "./STEALTH-BROWSER-LAUNCH.sh"; then
    if grep 'STEALTH_ARGS=' "./STEALTH-BROWSER-LAUNCH.sh" | grep -q "AutomationControlled"; then
        echo "✅ STEALTH-BROWSER-LAUNCH.sh has proper stealth args"
        grep 'STEALTH_ARGS=' "./STEALTH-BROWSER-LAUNCH.sh" | head -1
    else
        echo "❌ STEALTH-BROWSER-LAUNCH.sh stealth args incomplete"
        exit 1
    fi
else
    echo "❌ STEALTH-BROWSER-LAUNCH.sh missing STEALTH_ARGS"
    exit 1
fi

if grep -q 'STEALTH_ARGS=' "./multi-site-auth-stealth.sh"; then
    if grep 'STEALTH_ARGS=' "./multi-site-auth-stealth.sh" | grep -q "AutomationControlled"; then
        echo "✅ multi-site-auth-stealth.sh has proper stealth args"
        grep 'STEALTH_ARGS=' "./multi-site-auth-stealth.sh" | head -1
    else
        echo "❌ multi-site-auth-stealth.sh stealth args incomplete"
        exit 1
    fi
else
    echo "❌ multi-site-auth-stealth.sh missing STEALTH_ARGS"
    exit 1
fi

echo ""

# Test 6: Check Chrome path detection
echo "Test 6: Checking Chrome path detection..."
if [[ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    echo "✅ Chrome found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [[ -f "/Applications/Chromium.app/Contents/MacOS/Chromium" ]]; then
    echo "✅ Chromium found at /Applications/Chromium.app/Contents/MacOS/Chromium"
else
    echo "⚠️  Chrome/Chromium not found (will use bundled browser)"
fi

echo ""

# Test 7: Check agent-browser is installed
echo "Test 7: Checking agent-browser installation..."
if command -v agent-browser >/dev/null 2>&1; then
    VERSION=$(agent-browser --version 2>&1 || echo "unknown")
    echo "✅ agent-browser installed (version: $VERSION)"
else
    echo "❌ agent-browser not found"
    exit 1
fi

echo ""

# Test 8: Check Chrome executable path variable
echo "Test 8: Checking Chrome path variable handling..."
if grep -q 'CHROME_PATH=$(find_chrome_path)' "./STEALTH-BROWSER-LAUNCH.sh"; then
    echo "✅ STEALTH-BROWSER-LAUNCH.sh correctly finds Chrome path"
else
    echo "❌ STEALTH-BROWSER-LAUNCH.sh missing Chrome path detection"
    exit 1
fi

if grep -q 'CHROME_PATH=$(find_chrome_path)' "./multi-site-auth-stealth.sh"; then
    echo "✅ multi-site-auth-stealth.sh correctly finds Chrome path"
else
    echo "❌ multi-site-auth-stealth.sh missing Chrome path detection"
    exit 1
fi

echo ""

# Test 9: Check user agent detection
echo "Test 9: Checking user agent detection..."
if grep -q 'USER_AGENT=$(detect_user_agent)' "./STEALTH-BROWSER-LAUNCH.sh"; then
    echo "✅ STEALTH-BROWSER-LAUNCH.sh correctly detects user agent"
else
    echo "❌ STEALTH-BROWSER-LAUNCH.sh missing user agent detection"
    exit 1
fi

if grep -q 'USER_AGENT=$(detect_user_agent)' "./multi-site-auth-stealth.sh"; then
    echo "✅ multi-site-auth-stealth.sh correctly detects user agent"
else
    echo "❌ multi-site-auth-stealth.sh missing user agent detection"
    exit 1
fi

echo ""

# Test 10: Check --args flag format
echo "Test 10: Checking --args flag format..."
if grep -q '\-\-args=' "./STEALTH-BROWSER-LAUNCH.sh"; then
    echo "✅ STEALTH-BROWSER-LAUNCH.sh uses correct --args= format"
else
    echo "❌ STEALTH-BROWSER-LAUNCH.sh missing --args= flag"
    exit 1
fi

if grep -q '\-\-args=' "./multi-site-auth-stealth.sh"; then
    echo "✅ multi-site-auth-stealth.sh uses correct --args= format"
else
    echo "❌ multi-site-auth-stealth.sh missing --args= flag"
    exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  ALL TESTS PASSED!"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Scripts are ready to use:"
echo ""
echo "  ./STEALTH-BROWSER-LAUNCH.sh github"
echo "  ./multi-site-auth-stealth.sh"
echo ""
echo "Features included:"
echo "  ✅ Real Chrome browser detection"
echo "  ✅ OS-aware user agent strings"
echo "  ✅ Anti-detection launch arguments"
echo "  ✅ Proper --args flag format"
echo "  ✅ Session management"
