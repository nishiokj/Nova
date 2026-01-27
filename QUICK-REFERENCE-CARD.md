# Quick Reference: Multi-Site Authentication

## 🚀 One-Time Setup

```bash
# Run this once to log into all sites
./multi-site-auth-setup.sh
```

**What it does:**
- Opens X.com, Google AI Studio, YouTube, GitHub in visible browser
- Waits for you to complete login (handles 2FA, captchas, OAuth)
- Saves authentication state to `./auth-states/` directory

## 💡 Daily Usage

```bash
# Check available sites
./multi-site-auth-usage.sh

# GitHub examples
./multi-site-auth-usage.sh github snapshot -i
./multi-site-auth-usage.sh github screenshot /tmp/github.png
./multi-site-auth-usage.sh github open https://github.com/dashboard

# YouTube examples
./multi-site-auth-usage.sh youtube snapshot -i
./multi-site-auth-usage.sh youtube screenshot /tmp/youtube.png

# Google AI Studio examples
./multi-site-auth-usage.sh google-ai open https://aistudio.google.com
./multi-site-auth-usage.sh google-ai snapshot -i

# X.com examples
./multi-site-auth-usage.sh x snapshot -i
./multi-site-auth-usage.sh x screenshot /tmp/x.png
```

## 🔄 Re-Authenticate a Site

If session expires:

```bash
./multi-site-auth-setup.sh
# Press 'y' when asked to re-authenticate
```

## 🛡️ Security

```bash
# Auth states are already .gitignored
# Never commit auth-states/ directory
```

## 📁 File Locations

```
templates/
├── multi-site-auth-setup.sh      # Run once to set up logins
├── multi-site-auth-usage.sh      # Use this for daily operations
├── MULTI-SITE-AUTH-README.md     # Full documentation
└── auth-states/                  # Saved authentication (gitignored)
    ├── github-auth.json
    ├── youtube-auth.json
    ├── google-ai-auth.json
    └── x-auth.json
```

## 🔧 Manual Commands (Alternative)

```bash
# GitHub
agent-browser --session github state load ./auth-states/github-auth.json
agent-browser --session github open https://github.com

# YouTube
agent-browser --session youtube state load ./auth-states/youtube-auth.json
agent-browser --session youtube open https://www.youtube.com

# Google AI Studio
agent-browser --session google-ai state load ./auth-states/google-ai-auth.json
agent-browser --session google-ai open https://aistudio.google.com

# X.com
agent-browser --session x state load ./auth-states/x-auth.json
agent-browser --session x open https://x.com
```

## ❓ Help

```bash
# Full documentation
cat MULTI-SITE-AUTH-README.md

# agent-browser commands
agent-browser --help

# Specific command help
agent-browser snapshot --help
agent-browser state save --help
```
