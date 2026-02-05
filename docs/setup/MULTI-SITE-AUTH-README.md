# Multi-Site Authentication Setup

One-time login setup for X.com, Google AI Studio, YouTube, and GitHub. Save authentication states once, reuse for all future runs.

## Quick Start

### Step 1: Authenticate all sites (one-time setup)

```bash
./multi-site-auth-setup.sh
```

This will:
1. Open each site in a visible browser window (`--headed` mode)
2. Prompt you to manually complete login (handles 2FA, captchas, OAuth)
3. Save authentication state to `./auth-states/` directory
4. Skip any sites where auth state already exists (unless you choose to re-authenticate)

### Step 2: Use saved auth states

```bash
# Show all configured sites
./multi-site-auth-usage.sh

# Take a snapshot of GitHub homepage (authenticated)
./multi-site-auth-usage.sh github snapshot -i

# Screenshot YouTube (authenticated)
./multi-site-auth-usage.sh youtube screenshot /tmp/youtube.png

# Navigate to Google AI Studio (authenticated)
./multi-site-auth-usage.sh google-ai open https://aistudio.google.com

# Take snapshot of X.com timeline
./multi-site-auth-usage.sh x snapshot -i
```

## Manual Commands

If you prefer direct `agent-browser` commands:

```bash
# GitHub
agent-browser --session github state load ./auth-states/github-auth.json
agent-browser --session github open https://github.com/dashboard
agent-browser --session github snapshot -i

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

## Auth State Files

Authentication states are saved to:

```
auth-states/
├── github-auth.json
├── youtube-auth.json
├── google-ai-auth.json
└── x-auth.json
```

**⚠️ SECURITY WARNING:** Never commit `auth-states/` directory to version control. These files contain session tokens, cookies, and authentication credentials.

```bash
# Add to .gitignore
echo "auth-states/" >> .gitignore

# Verify it's ignored
git status
```

## Re-Authenticating a Site

If your session expires (e.g., logged out, token expired), simply run the setup script again:

```bash
./multi-site-auth-setup.sh
```

When prompted to re-authenticate a site, press `y` to overwrite the existing state.

## Adding New Sites

To add more sites to this workflow, edit both scripts:

### 1. In `multi-site-auth-setup.sh`, add to the SITES array:

```bash
declare -A SITES=(
    ["x"]="https://x.com"
    ["google-ai"]="https://aistudio.google.com"
    ["youtube"]="https://www.youtube.com"
    ["github"]="https://github.com"
    ["new-site"]="https://new-site.com"  # Add this
)
```

### 2. In `multi-site-auth-usage.sh`, add the same:

```bash
declare -A SITES=(
    ["x"]="https://x.com"
    ["google-ai"]="https://aistudio.google.com"
    ["youtube"]="https://www.youtube.com"
    ["github"]="https://github.com"
    ["new-site"]="https://new-site.com"  # Add this
)
```

Then re-run `./multi-site-auth-setup.sh` to authenticate the new site.

## Examples

### Example 1: Scrape YouTube Subscriptions (Authenticated)

```bash
#!/bin/bash
./multi-site-auth-usage.sh youtube open https://www.youtube.com/feed/subscriptions
./multi-site-auth-usage.sh youtube wait --load networkidle
./multi-site-auth-usage.sh youtube snapshot -i
```

### Example 2: GitHub Activity (Authenticated)

```bash
#!/bin/bash
./multi-site-auth-usage.sh github open https://github.com
./multi-site-auth-usage.sh github wait --load networkidle
./multi-site-auth-usage.sh github get text "#repo-list"
./multi-site-auth-usage.sh github screenshot /tmp/github-home.png
```

### Example 3: Google AI Studio Project Management

```bash
#!/bin/bash
./multi-site-auth-usage.sh google-ai open https://aistudio.google.com
./multi-site-auth-usage.sh google-ai wait --load networkidle
./multi-site-auth-usage.sh google-ai snapshot -i
# Interact with AI projects using @refs from snapshot
```

### Example 4: X.com Timeline Extraction

```bash
#!/bin/bash
./multi-site-auth-usage.sh x open https://x.com
./multi-site-auth-usage.sh x wait --load networkidle
./multi-site-auth-usage.sh x snapshot -i
./multi-site-auth-usage.sh x scroll down 500
./multi-site-auth-usage.sh x wait 1000
./multi-site-auth-usage.sh x get text "[data-testid='tweet']" > tweets.txt
```

## Session Isolation

Each site uses its own isolated browser session:
- **Separate cookies and storage**
- **Separate authentication state**
- **Can run concurrently**

```bash
# Run multiple sites concurrently
./multi-site-auth-usage.sh github snapshot -i &
./multi-site-auth-usage.sh youtube snapshot -i &
./multi-site-auth-usage.sh x snapshot -i &
wait
```

## Troubleshooting

### Session expired

If you see login pages when you shouldn't:

```bash
# Re-authenticate the affected site
./multi-site-auth-setup.sh
```

### Auth state file corrupted

```bash
# Delete the corrupted file
rm ./auth-states/affected-site-auth.json

# Re-authenticate
./multi-site-auth-usage.sh affected-site open https://...
```

### Browser not installing

```bash
# Install the bundled Chromium
agent-browser install

# On Linux, also install system dependencies
agent-browser install --with-deps
```

## Security Best Practices

1. **Never commit auth-state files**
   ```bash
   echo "auth-states/" >> .gitignore
   ```

2. **Use environment variables for credentials** (if automating)
   ```bash
   export GITHUB_TOKEN="ghp_xxx"
   ```

3. **Delete auth states after use in CI/CD**
   ```bash
   # In CI, don't persist auth states
   rm -rf ./auth-states/
   ```

4. **Keep auth states private**
   ```bash
   chmod 700 ./auth-states/
   chmod 600 ./auth-states/*.json
   ```

## Advanced Usage

### Using with CI/CD

For CI/CD where you can't use `--headed` mode:

1. Set up auth locally using `multi-site-auth-setup.sh`
2. Upload the `auth-states/` directory securely
3. In CI, use `multi-site-auth-usage.sh` to load and use states

### Persistent Profiles (Alternative to State Files)

For more durable sessions (survives multiple launches), use persistent profiles instead of state files:

```bash
# Create persistent profile directory
mkdir -p ./browser-profiles/github

# Login once with profile
agent-browser --profile ./browser-profiles/github --headed open https://github.com/login
# Complete login manually...

# All future runs use the same profile
agent-browser --profile ./browser-profiles/github open https://github.com
```

## Help

For all `agent-browser` commands:

```bash
agent-browser --help
```

For specific command help:

```bash
agent-browser snapshot --help
agent-browser state save --help
```
