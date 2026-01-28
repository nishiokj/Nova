# Telegram Webhook Integration Guide

## Overview

This guide explains how to integrate Telegram with the Harness system using the built-in `TelegramConnector`. The webhook handler integrates directly with `HarnessDaemon` and uses the harness's existing `SessionStore` for automatic stateful conversation management.

---

## Architecture

### The Key Insight: `sessionKey` = Conversation ID

The harness's `run()` method supports session-based state management:

```typescript
// harness.ts - run() accepts sessionKey
run(params: {
  requestId: string;
  inputText: string;
  sessionKey: string;  // ← Telegram chat ID becomes this!
  workingDir: string;
  // ...
}): AgentRunHandle
```

### Flow Diagram

```
Telegram Webhook → WebhookServer → TelegramConnector
                                   │
                                   ├─ sessionKey = `telegram:${chatId}`
                                   │
                                   └─ harness.run({ sessionKey, inputText })
                                            │
                                            ▼
                                   SessionStore loads/creates context
                                   │
                                   ├─ If NEW session → creates ContextWindow
                                   └─ If EXISTS → loads from GraphD
                                            │
                                            ▼
                                   Agent processes with full history
                                            │
                                            ▼
                                   TelegramConnector.sendMessage()
```

---

## Quick Start

### Option 1: CLI with Environment Variable

```bash
# Set your bot token
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"

# Start daemon with webhook server enabled
bun run packages/harness-daemon/src/harness/daemon.ts --enable-webhooks

# Output:
# [harness-daemon] bus listening on 127.0.0.1:9555
# [harness-daemon] webhook server listening on 127.0.0.1:9556
# [harness-daemon] Registered Telegram bot: 123456789
# [harness-daemon] Webhook URL: http://127.0.0.1:9556/webhook/telegram/123456789
```

### Option 2: CLI with Explicit Arguments

```bash
bun run packages/harness-daemon/src/harness/daemon.ts \
  --telegram-bot "123456789:ABCdefGHIjklMNOpqrsTUVwxyz" \
  --webhook-port 3001
```

### Option 3: Programmatic Setup

```typescript
import { HarnessDaemon } from 'harness-daemon';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '../../../');

async function main() {
  const daemon = new HarnessDaemon({
    port: 9555,
    webhookPort: 3001,
    workingDir: PROJECT_ROOT,
  });

  // Start the bus server (for TUI connections)
  await daemon.start();

  // Start the webhook HTTP server
  await daemon.startWebhookServer();

  // Register Telegram bot with a default model
  const connector = daemon.registerTelegramBot(process.env.TELEGRAM_BOT_TOKEN!, {
    defaultModel: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  });

  // Set webhook URL with Telegram
  const publicUrl = process.env.PUBLIC_URL ?? 'https://your-domain.com';
  await connector.setWebhook(`${publicUrl}/webhook/telegram/${connector.getBotId()}`);

  console.log(`Telegram bot ready: ${connector.getBotId()}`);
}

main().catch(console.error);
```

---

## Configuration Options

### HarnessDaemon Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | 9555 | TCP bus server port |
| `webhookPort` | number | port + 1 | HTTP webhook server port |
| `webhookHost` | string | same as host | Webhook server bind address |

### TelegramConnector Options

| Option | Type | Description |
|--------|------|-------------|
| `defaultModel` | `{ provider: string; model: string }` | Default model for new sessions |
| `secretToken` | string | Telegram webhook secret for verification |
| `skipModelValidation` | boolean | Skip model/API key checks (testing only) |

---

## Stateful Conversations

Each Telegram chat gets its own session with full conversation history:

```typescript
// Session key format
const sessionKey = `telegram:${chatId}`;

// First message (Alice, chat_id: 12345)
// Session: telegram:12345 (NEW)
// ContextWindow = []
// Agent responds...
// SessionStore persists to GraphD

// Second message (same chat)
// Session: telegram:12345 (EXISTS)
// ContextWindow = [
//   { role: 'user', content: 'Hello!' },
//   { role: 'assistant', content: "Hello! I'm your assistant." }
// ]
// Agent has FULL history
```

### Session Features

| Feature | Description |
|---------|-------------|
| **Conversation History** | All messages stored in `ContextWindow` |
| **Auto-Persistence** | Saved to GraphD after each message |
| **Auto-Loading** | Loaded from GraphD on session resume |
| **Context Compaction** | Auto-compacts at 80% capacity |

---

## Webhook Security

### Secret Token Verification

```typescript
const connector = daemon.registerTelegramBot(botToken, {
  secretToken: 'your-secret-token',
});

// Set webhook with secret
await connector.setWebhook(webhookUrl, {
  secret_token: 'your-secret-token',
});
```

The webhook server validates the `X-Telegram-Bot-Api-Secret-Token` header.

---

## Multi-Platform Support

The same session pattern works for any messaging platform:

| Platform | sessionKey Format |
|----------|------------------|
| Telegram | `telegram:${chatId}` |
| Slack | `slack:${channelId}` |
| Discord | `discord:${channelId}` |
| WhatsApp | `whatsapp:${phoneNumber}` |

---

## Local Development

### Option A: Polling Mode (No Public URL Needed)

The simplest option for local development - the connector polls Telegram for updates:

```bash
export TELEGRAM_BOT_TOKEN="your-token"
bun run packages/harness-daemon/src/harness/daemon.ts --telegram-polling

# Output:
# [harness-daemon] bus listening on 127.0.0.1:9555
# [harness-daemon] Telegram bot registered: 123456789
# [harness-daemon] Telegram polling mode active (no public URL required)
```

Or programmatically:

```typescript
const connector = daemon.registerTelegramBot(token);
await connector.deleteWebhook();  // Disable any existing webhook
connector.startPolling();          // Start polling loop
```

### Option B: ngrok (For Webhook Testing)

If you need to test webhook mode specifically:

```bash
# Terminal 1: Start daemon with webhooks
export TELEGRAM_BOT_TOKEN="your-token"
bun run packages/harness-daemon/src/harness/daemon.ts --enable-webhooks

# Terminal 2: Start ngrok
ngrok http 9556

# Copy the HTTPS URL and set webhook
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=https://abc123.ngrok-free.app/webhook/telegram/YOUR_BOT_ID"
```

### Auto-Detection

If `TELEGRAM_BOT_TOKEN` is set but `PUBLIC_URL` is not, the daemon automatically uses polling mode.

---

## API Reference

### TelegramConnector Methods

```typescript
class TelegramConnector {
  // Handle incoming webhook update
  async handleUpdate(update: TelegramUpdate): Promise<boolean>;

  // Send a message to a chat
  async sendMessage(options: TelegramSendMessageOptions): Promise<boolean>;

  // Send typing indicator
  async sendChatAction(chatId: number, action: 'typing'): Promise<boolean>;

  // Configure webhook URL with Telegram
  async setWebhook(url: string, options?: { secret_token?: string }): Promise<{ success: boolean }>;

  // Remove webhook
  async deleteWebhook(): Promise<{ success: boolean }>;

  // Polling mode (for local dev without public URL)
  startPolling(intervalMs?: number): void;
  stopPolling(): void;
  isPolling(): boolean;

  // Get bot ID (first part of token)
  getBotId(): string;
}
```

### HarnessDaemon Methods

```typescript
class HarnessDaemon {
  // Start webhook HTTP server
  async startWebhookServer(): Promise<{ host: string; port: number }>;

  // Register a Telegram bot
  registerTelegramBot(
    botToken: string,
    options?: {
      secretToken?: string;
      defaultModel?: { provider: string; model: string };
    }
  ): TelegramConnector;

  // List registered bot IDs
  listTelegramBots(): string[];

  // Get connector by bot ID
  getTelegramConnector(botId: string): TelegramConnector | undefined;

  // Get harness instance (for advanced use)
  getHarness(): AgentHarness | null;
}
```

---

## Telegram Setup Steps

1. **Create a Telegram Bot**:
   - Open Telegram and search for **@BotFather**
   - Send `/newbot` to create a new bot
   - Follow the prompts to name your bot
   - **Save the API token** (e.g., `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

2. **Configure Environment**:
   ```bash
   export TELEGRAM_BOT_TOKEN="your-token"
   export PUBLIC_URL="https://your-domain.com"  # or ngrok URL
   ```

3. **Start Daemon with Webhooks**:
   ```bash
   bun run packages/harness-daemon/src/harness/daemon.ts --enable-webhooks
   ```

4. **Set Webhook URL** (automatic if using env var, or manual):
   ```bash
   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${PUBLIC_URL}/webhook/telegram/BOT_ID"
   ```

5. **Test**: Send a message to your bot in Telegram!

---

## Troubleshooting

### "No model selected for this session"

Set a default model when registering the bot:

```typescript
daemon.registerTelegramBot(token, {
  defaultModel: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
});
```

Or configure a model via TUI first (the session will persist).

### "No API key configured"

Ensure you have the provider API key configured in the harness:
1. Start the TUI: `bun run packages/tui`
2. Run `/providers` to configure API keys
3. Keys are stored in GraphD and persist across sessions

### Webhook Not Receiving Updates

1. Check ngrok is running and forwarding to correct port
2. Verify webhook URL: `curl "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"`
3. Check daemon logs for incoming requests

---

## References

- **Harness Daemon**: `packages/harness-daemon/src/harness/daemon.ts`
- **Telegram Connector**: `packages/harness-daemon/src/connectors/telegram.ts`
- **Webhook Server**: `packages/harness-daemon/src/connectors/webhook_server.ts`
- **Session Store**: `packages/harness-daemon/src/harness/session_store.ts`
- **Telegram Bot API**: https://core.telegram.org/bots/api
