# Telegram Webhook Integration Guide

## Overview

This guide explains how to integrate Telegram with the Harness system using a **dumb webhook** approach. The webhook handler simply extracts incoming messages and calls `harness.run()` with a session key. The harness's existing `SessionStore` provides automatic stateful conversation management through GraphD persistence.

---

## Architecture

### The Key Insight: `sessionKey` = Conversation ID

The harness's `run()` method already supports session-based state management:

```typescript
// harness.ts:367 - run() accepts sessionKey
run(params: {
  requestId: string;
  inputText: string;
  tier?: 'simple' | 'standard' | 'complex';
  sessionKey: string;  // ← This is the magic!
  workingDir: string;
  planMode?: boolean;
  stopHook?: StopHookHandler;
}): AgentRunHandle

// harness.ts:422 - Loads or creates SessionStore for this sessionKey
const store = this.getOrCreateSessionStore(sessionKey);
```

### Flow Diagram

```
Telegram Webhook → Your Handler
                   │
                   ├─ sessionKey = `telegram:${chatId}`
                   │
                   └─ harness.run({ sessionKey, inputText })
                            │
                            ▼
                   harness.ts:getOrCreateSessionStore()
                   │
                   ├─ If NEW session → creates ContextWindow (empty)
                   └─ If EXISTS session → loads ContextWindow from GraphD
                            │
                            ▼
                   ContextWindow has FULL conversation history
                   - All previous messages
                   - All tool calls
                   - All file content
                            │
                            ▼
                   Orchestrator.execute() with full context
                            │
                            ▼
                   Agent response
                            │
                            ▼
                   SessionStore.persistContext() → GraphD
```

---

## Implementation

### Telegram Webhook Handler

```typescript
// telegram-webhook.ts
import { AgentHarness } from 'harness';
import { v4 as uuidv4 } from 'uuid';

interface TelegramUpdate {
  update_id: number;
  message: {
    from: { id: number; username?: string; first_name: string };
    chat: { id: number; type: 'private' | 'group' };
    text: string;
  };
}

export class TelegramWebhookHandler {
  constructor(
    private harness: AgentHarness,
    private botToken: string
  ) {}

  async handleUpdate(update: TelegramUpdate) {
    const { message } = update;
    if (!message?.text) return;

    // KEY: Use Telegram chat_id as sessionKey!
    const sessionKey = `telegram:${message.chat.id}`;
    const requestId = uuidv4();

    console.log(`[${message.from.username || message.from.first_name}]: ${message.text}`);

    // Call harness - it loads full history automatically
    const handle = this.harness.run({
      requestId,
      inputText: message.text,
      sessionKey,  // ← This loads previous context!
      workingDir: process.cwd(),
    });

    // Stream events and send responses to Telegram
    for await (const event of handle.events) {
      if (event.type === 'response') {
        await this.sendTelegramMessage(
          message.chat.id,
          event.data.content
        );
      }
      if (event.type === 'error' && event.data.fatal) {
        await this.sendTelegramMessage(
          message.chat.id,
          `⚠️ ${event.data.message}`
        );
      }
    }
  }

  private async sendTelegramMessage(chatId: number, text: string) {
    await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          chat_id: chatId, 
          text: text.slice(0, 4096) // Telegram limit
        }),
      }
    );
  }
}
```

### Webhook Server

```typescript
// webhook-server.ts
import express from 'express';
import { HarnessDaemon } from 'harness-daemon';
import { TelegramWebhookHandler } from './telegram-webhook.js';

async function main() {
  // Start harness (same as TUI!)
  const daemon = new HarnessDaemon();
  await daemon.start();
  const harness = daemon.getHarness();

  // Start webhook handler
  const telegramWebhook = new TelegramWebhookHandler(
    harness,
    process.env.TELEGRAM_BOT_TOKEN!
  );

  // Set up Express/HTTP server
  const app = express();
  app.use(express.json());
  
  app.post('/webhook/telegram', async (req, res) => {
    await telegramWebhook.handleUpdate(req.body);
    res.send('OK');
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`🚀 Webhook server listening on port ${PORT}`);

    // Set Telegram webhook
    const webhookUrl = `${process.env.PUBLIC_URL}/webhook/telegram`;
    console.log(`📡 Setting Telegram webhook to: ${webhookUrl}`);
    
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
    );
    
    console.log('✅ Telegram webhook configured!');
  });
}

main().catch(console.error);
```

---

## Stateful Conversations Explained

### Session Management Features

| Feature | How It Works |
|---------|---------------|
| **Conversation History** | Each `sessionKey` = one conversation. `ContextWindow` stores all messages |
| **Auto-Persistence** | `SessionStore.persistContext()` saves to GraphD after each message |
| **Auto-Loading** | `getOrCreateSessionStore()` loads from GraphD on first access |
| **Model Selection** | `setSessionSelectedModel(sessionKey, agentType, selection)` per session |
| **Context Compaction** | `ContextWindow` auto-compacts at 80% capacity with LLM-ledger |
| **Interruption** | `checkInterruption()` detects new messages during execution |

### Conversation Flow Example

#### First Message (Alice, chat_id: 12345)

```typescript
// Session doesn't exist yet
const sessionKey = 'telegram:12345';
const store = getOrCreateSessionStore(sessionKey);
// ContextWindow = [] (empty)

// Harness runs agent
// Agent: "Hello! I'm your assistant."

// Persist
store.persistContext() → GraphD saves session
```

#### Second Message (Alice, same chat)

```typescript
// Session EXISTS now!
const sessionKey = 'telegram:12345';
const store = getOrCreateSessionStore(sessionKey);
// ContextWindow = [
//   { role: 'user', content: 'Hello!' },
//   { role: 'assistant', content: "Hello! I'm your assistant." }
// ]

// Harness runs agent WITH FULL HISTORY
// Agent: "You just said hello to me. How can I help?"
```

---

## Multi-Platform Support

The same dumb webhook pattern works for ANY messaging platform:

| Platform | sessionKey Format |
|----------|------------------|
| Telegram | `telegram:${chatId}` |
| Slack | `slack:${userId}` |
| Discord | `discord:${channelId}` |
| WhatsApp | `whatsapp:${phoneNumber}` |
| Email | `email:${threadId}` |
| SMS | `sms:${phoneNumber}` |

---

## Environment Variables

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN="your-bot-token-from-botfather"

# Public URL (use ngrok/tunnelmole for local development)
PUBLIC_URL="https://your-domain.com"

# Server Port
PORT=3000
```

---

## Telegram Setup Steps

1. **Create a Telegram Bot**:
   - Open Telegram and search for **@BotFather**
   - Send `/newbot` to create a new bot
   - Follow the prompts to name your bot and choose a username
   - **Save the API token** (e.g., `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

2. **Get Your Bot's Username**:
   - Send `/mybots` to BotFather
   - Select your bot to see its `@username`

3. **Test Your Bot**:
   - Search for your bot's username in Telegram
   - Send it a message
   - It should show "is typing" and respond (once webhook is running)

---

## Local Development with ngrok

For local development, use ngrok to expose your localhost:

```bash
# Install ngrok
npm install -g ngrok

# Start ngrok (in a separate terminal)
ngrok http 3000

# Copy the HTTPS URL from ngrok output
# Example: https://abc123.ngrok-free.app

# Set environment variable
export PUBLIC_URL=https://abc123.ngrok-free.app

# Start your webhook server
npm run webhook
```

---

## Comparison: Agent Memory vs. Dumb Webhook

| Aspect | Agent Memory Approach | Dumb Webhook Approach |
|--------|----------------------|----------------------|
| **State Management** | Custom in `raw_envelopes` | Built-in `SessionStore` |
| **Persistence** | PostgreSQL only | GraphD |
| **Message Storage** | Append-only RawEnvelopes | ContextWindow (auto-compacting) |
| **Conversation History** | Query `canonical_entities` | Automatic via `sessionKey` |
| **Transformations** | Required (Layer 1→2→3) | Not needed |
| **Code Changes** | Requires new connector | Simple webhook handler |
| **Chatbot Use Case** | Over-engineered | Perfect fit |
| **Data Sync** | Good for email, issues, etc. | Not needed for chat |

---

## Summary

| Question | Answer |
|----------|--------|
| Can webhooks be dumb? | **Yes** - just extract message and call `harness.run()` |
| No harness changes needed? | **No** - `run(sessionKey)` already exists |
| Stateful conversations? | **Yes** - `sessionKey` = conversation ID, `SessionStore` loads history |
| Context management? | **Yes** - `ContextWindow` + `SessionStore.persistContext()` handle it automatically |
| Persistent across restarts? | **Yes** - `SessionStore` loads from GraphD |

You've built perfect architecture for this - just use the same API that TUI uses! The webhook handler is basically TUI's `bridge_gateway.ts:handleSendText()` but adapted for Telegram instead of terminal input.

---

## References

- **Harness Daemon**: `packages/harness-daemon/src/harness/harness.ts`
- **Bridge Gateway**: `packages/harness-daemon/src/harness/bridge_gateway.ts`
- **Session Store**: `packages/context/src/context-window.ts`
- **Telegram Bot API**: https://core.telegram.org/bots/api
