# Stealth Browser Launch Guide

Avoid being detected as an automated/test browser when using agent-browser.

## 🚨 The Problem

When you use the default agent-browser launch, it's easily detected as an automation tool by websites. Common detection methods include:

- **`navigator.webdriver` flag** - Set to `true` when browser is controlled by automation
- **Automation infobars** - "Chrome is being controlled by automated test software" banner
- **User Agent strings** - May contain automation-related strings
- **CDP (Chrome DevTools Protocol) detection** - Detects CDP connection patterns
- **Fingerprinting** - Detects non-standard browser properties

## ✅ Solutions

### Option 1: Use Your Installed Chrome (Recommended)

The best way to avoid detection is to use your actual Chrome/Chromium browser instead of the bundled Playwright browser.

```bash
# macOS
agent-browser \
  --session mysession \
  --executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=false

# Linux
agent-browser \
  --session mysession \
  --executable-path "$(which google-chrome)" \
  --headless=false

# Windows (Git Bash/MSYS2)
agent-browser \
  --session mysession \
  --executable-path "/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=false
```

**Why this works:** Your real Chrome has a legitimate user profile, extensions, and browsing history that make it indistinguishable from manual browsing.

### Option 2: Use Stealth Launch Arguments

Add Chrome launch arguments that hide automation indicators:

```bash
agent-browser \
  --session mysession \
  --headless=false \
  --args="--disable-blink-features=AutomationControlled" \
  --args="--exclude-switches=enable-automation" \
  --args="--disable-infobars"
```

**What these do:**
- `--disable-blink-features=AutomationControlled` - Disables the automation-controlled flag that sets `navigator.webdriver`
- `--exclude-switches=enable-automation` - Prevents automation-related switches from being added
- `--disable-infobars` - Removes the "Chrome is being controlled..." infobar

### Option 3: Custom User Agent

Spoof a real user agent string:

```bash
# macOS Chrome
agent-browser \
  --session mysession \
  --headless=false \
  --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

# Windows Chrome
agent-browser \
  --session mysession \
  --headless=false \
  --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
```

### Option 4: Use Cloud Provider with Stealth

**Kernel** is a cloud browser provider that has built-in stealth mode:

```bash
# Set up Kernel
export KERNEL_API_KEY="your-api-key"

# Launch with stealth enabled (default)
agent-browser \
  --session mysession \
  -p kernel \
  open https://example.com

# Explicitly enable stealth
KERNEL_STEALTH=true agent-browser \
  --session mysession \
  -p kernel \
  open https://example.com
```

Kernel's stealth features:
- Real browser fingerprints
- Rotating IP addresses
- Anti-bot detection
- Persistent profiles

Get API key: https://dashboard.onkernel.com

### Option 5: Connect to Your Running Chrome (CDP)

Launch Chrome manually, then connect via CDP:

```bash
# Step 1: Launch Chrome with remote debugging
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-profile

# Step 2: Connect to it with agent-browser
agent-browser \
  --session mysession \
  --cdp 9222
```

**Advantages:**
- Uses your actual Chrome profile
- Extensions and cookies are preserved
- No automation flags
- Works with browser extensions (password managers, etc.)

### Option 6: Use the Pre-Built Script

Run the stealth launch script:

```bash
./STEALTH-BROWSER-LAUNCH.sh github
```

This script:
- Detects your Chrome installation
- Applies stealth launch arguments
- Sets a realistic user agent
- Launches in visible (headed) mode

## 📊 Comparison of Options

| Option | Effectiveness | Difficulty | Notes |
|--------|-------------|-----------|-------|
| **Real Chrome (Option 1)** | ⭐⭐⭐⭐⭐ | Easy | Best option - uses your actual browser |
| **Stealth Args (Option 2)** | ⭐⭐⭐ | Easy | Quick fix, but still detectable |
| **Custom User Agent (Option 3)** | ⭐⭐ | Easy | Basic spoofing only |
| **Kernel Cloud (Option 4)** | ⭐⭐⭐⭐ | Medium | Good stealth, requires API key |
| **CDP Connection (Option 5)** | ⭐⭐⭐⭐⭐ | Medium | Best if you have Chrome extensions |
| **Stealth Script (Option 6)** | ⭐⭐⭐ | Easy | Convenient wrapper |

## 🛡️ Complete Stealth Configuration

Combine multiple techniques for maximum stealth:

```bash
agent-browser \
  --session mysession \
  --executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=false \
  --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  --args="--disable-blink-features=AutomationControlled" \
  --args="--exclude-switches=enable-automation" \
  --args="--disable-infobars" \
  open https://example.com
```

## 🔍 Testing Your Stealth

Check if your browser is being detected:

```bash
# Launch stealth browser
agent-browser --session test --executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=false open https://bot.sannysoft.com

# Or use a dedicated testing site
agent-browser --session test --executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=false open https://arh.antoinevastel.com/bots/areyouheadless
```

Look for:
- ✅ `navigator.webdriver` should be `undefined` or `false`
- ✅ No "Chrome is being controlled..." infobar
- ✅ Realistic user agent
- ✅ No CDP detection

## 🚫 What to Avoid

- ❌ Don't use the bundled Chromium for production scraping
- ❌ Don't use headless mode if you need stealth (most sites detect it)
- ❌ Don't ignore cookies/storage (makes behavior unnatural)
- ❌ Don't use default Playwright settings without modifications

## 📚 Additional Resources

- [ZenRows: Avoid Playwright Bot Detection](https://www.zenrows.com/blog/avoid-playwright-bot-detection)
- [ScrapeOps: Make Playwright Undetectable](https://scrapeops.io/playwright-web-scraping-playbook/nodejs-playwright-make-playwright-undetectable/)
- [StackOverflow: Hide navigator.webdriver](https://stackoverflow.com/questions/53039551/selenium-webdriver-modifying-navigator-webdriver-flag-to-prevent-selenium-detec)

## 🎯 Quick Start

```bash
# Best practice: Use your real Chrome
agent-browser \
  --session github \
  --executable-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=false \
  open https://github.com

# Or use the convenience script
./STEALTH-BROWSER-LAUNCH.sh github
```
