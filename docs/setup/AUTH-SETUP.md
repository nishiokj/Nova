# Multi-Site Authentication with Stealth Mode

Quick setup for logging into multiple websites once and reusing authentication sessions.

## One-Time Setup

```bash
./multi-site-auth-stealth.sh
```

This will:
1. Open a **visible Chrome browser** for each site (not headless)
2. Apply **anti-detection settings** to avoid being blocked
3. Prompt you to **complete login manually** (handles 2FA, captchas, OAuth)
4. Save authentication state to `./auth-states/<site>-auth.json`

## Using Saved Authentication

```bash
./multi-site-auth-usage.sh [site] [action] [args...]
```

### Examples:

```bash
# Open X.com with saved auth
./multi-site-auth-usage.sh x open https://x.com

# Take a screenshot of GitHub dashboard
./multi-site-auth-usage.sh github screenshot /tmp/github.png

# Get page snapshot of YouTube
./multi-site-auth-usage.sh youtube snapshot -i

# List all available sites
./multi-site-auth-usage.sh
```

## Supported Sites

| Site Name | URL |
|-----------|-----|
| `x` | https://x.com |
| `google-ai` | https://aistudio.google.com |
| `youtube` | https://www.youtube.com |
| `github` | https://github.com |

## Stealth Features

✅ **Real Chrome browser** - Not Playwright's bundled Chromium  
✅ **Anti-detection launch arguments** - Hides automation indicators  
✅ **Realistic user agent** - Matches normal browser behavior  
✅ **No automation flags** - Avoids detection by websites  

## Important Security Notes

⚠️ **Never commit** the `auth-states/` directory - it contains sensitive authentication cookies!  
📁 The `auth-states/` folder is already in `.gitignore` for your safety.  
🔒 Authentication states are stored as JSON files containing cookies and session data.

## Troubleshooting

**Daemon already running warning:**
```bash
agent-browser close
```
Then restart the authentication script.

**Chrome not found:**
The script will fall back to bundled Chromium, but this is less stealthy. For best results, ensure Chrome is installed.

**State not loading:**
Ensure you use `--state` flag when opening, not the old `state load` command. The scripts handle this correctly.
