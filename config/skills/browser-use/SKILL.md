---
name: browser-use
description: Use Browser Use cloud API to spin up cloud browsers and run autonomous browser tasks. Primary use is creating browser sessions with profiles (persisted logins/cookies). Secondary use is running task subagents for fast autonomous browser automation. Docs at docs.browser-use.com and docs.cloud.browser-use.com.
---

# Browser Use

Browser Use provides cloud browsers and autonomous browser automation via API.

**Docs:**
- Open source library: https://docs.browser-use.com
- Cloud API: https://docs.cloud.browser-use.com

## Setup

**API Key** should be set as the environment variable `BROWSER_USE_API_KEY`.

If not configured, tell the user:
> To use Browser Use, you need an API key. Get one at https://cloud.browser-use.com (new signups get $10 free credit). Then set it:
> ```
> export BROWSER_USE_API_KEY="bu_your_key_here"
> ```

Base URL: `https://api.browser-use.com/api/v2`

All requests need header: `X-Browser-Use-API-Key: <apiKey>`

---

## 1. Browser Sessions (Primary)

Spin up cloud browsers to control directly. Use profiles to persist logins and cookies.

### Create browser session

```bash
# With profile (recommended - keeps you logged in)
curl -X POST "https://api.browser-use.com/api/v2/browsers" \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"profileId": "<profile-uuid>", "timeout": 60}'

# Without profile (fresh browser)
curl -X POST "https://api.browser-use.com/api/v2/browsers" \
  -H "X-Browser-Use-API-KEY: $BROWSER_USE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"timeout": 60}'
```

**Response:**
```json
{
  "id": "session-uuid",
  "cdpUrl": "https://<id>.cdp2.browser-use.com",
  "liveUrl": "https://...",
  "status": "active"
}
```

### Connect to the browser

Use the `cdpUrl` from the response to connect via CDP (Chrome DevTools Protocol). This can be used with Playwright, Puppeteer, or any CDP-compatible client.

### List/stop browser sessions

```bash
# List active sessions
curl "https://api.browser-use.com/api/v2/browsers" -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY"

# Get session status
curl "https://api.browser-use.com/api/v2/browsers/<session-id>" -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY"

# Stop session (unused time is refunded)
curl -X PATCH "https://api.browser-use.com/api/v2/browsers/<session-id>" \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "stopped"}'
```

**Pricing:** $0.06/hour (Pay As You Go) or $0.03/hour (Business). Max 4 hours per session. Billed per minute, refunded for unused time.

---

## 2. Profiles

Profiles persist cookies and login state across browser sessions. Create one, log into your accounts in the browser, and reuse it.

```bash
# List profiles
curl "https://api.browser-use.com/api/v2/profiles" -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY"

# Create profile
curl -X POST "https://api.browser-use.com/api/v2/profiles" \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Profile"}'

# Delete profile
curl -X DELETE "https://api.browser-use.com/api/v2/profiles/<profile-id>" \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY"
```

**Tip:** You can also sync cookies from your local Chrome using the Browser Use Chrome extension.

---

## 3. Tasks (Subagent)

Run autonomous browser tasks - like a subagent that handles browser interactions. Give it a prompt and it completes the task.

**Always use `browser-use-llm`** - optimized for browser tasks, 3-5x faster than other models.

```bash
curl -X POST "https://api.browser-use.com/api/v2/tasks" \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Go to amazon.com and find the price of the MacBook Air M3",
    "llm": "browser-use-llm"
  }'
```

### Poll for completion

```bash
curl "https://api.browser-use.com/api/v2/tasks/<task-id>" -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY"
```

**Response:**
```json
{
  "status": "finished",
  "output": "The MacBook Air M3 is priced at $1,099",
  "isSuccess": true,
  "cost": "0.02"
}
```

Status values: `pending`, `running`, `finished`, `failed`, `stopped`

### Task options

| Option | Description |
|--------|-------------|
| `task` | Your prompt (required) |
| `llm` | Always use `browser-use-llm` |
| `startUrl` | Starting page |
| `maxSteps` | Max actions (default 100) |
| `sessionId` | Reuse existing session |
| `profileId` | Use a profile for auth |
| `flashMode` | Even faster execution |
| `vision` | Visual understanding |

---

## Full API Reference

See [references/api.md](references/api.md) for all endpoints including Sessions, Files, Skills, and Skills Marketplace.
