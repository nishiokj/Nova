# Connector Development Guide

A Connector bridges an external data source into the agent-memory system. This guide covers implementation from scratch through production use.

---

## Table of Contents

1. [Overview](#overview)
2. [Part 1: Implementing a New Connector](#part-1-implementing-a-new-connector)
3. [Part 2: Defining Transformations](#part-2-defining-transformations)
4. [Part 3: Account Registration](#part-3-account-registration-runtime)
5. [Part 4: Creating Sync Tasks](#part-4-creating-sync-tasks)
6. [Part 5: Testing](#part-5-testing)
7. [Checklists](#checklists)

---

## Overview

### Architecture

```
External API → Connector → Raw Envelopes → Transformations → Canonical Entities
                  ↓
              Auth Provider
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Connector** | Interface to an external service (Gmail, GitHub, etc.) |
| **Source Schema** | Zod schema defining the external API response shape |
| **Raw Envelope** | Immutable record of data exactly as received |
| **Transformation** | Deterministic mapping from raw → canonical |
| **Canonical Entity** | Normalized entity in our standard schema |
| **Sync Task** | Scheduled or webhook-triggered sync configuration |

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Raw Layer     │     │ Canonical Layer │     │  Derived Layer  │
│    (Bronze)     │ ──► │    (Silver)     │ ──► │     (Gold)      │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ raw_envelopes   │     │canonical_entities│    │ derived_entities│
│ - Immutable     │     │ - Normalized    │     │ - LLM-processed │
│ - Source truth  │     │ - Deterministic │     │ - Enriched      │
│ - Per-connector │     │ - Queryable     │     │ - Versioned     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

---

## Part 1: Implementing a New Connector

### 1.1 Prerequisites

Before starting:

- [ ] External API documentation reviewed
- [ ] Auth method identified (OAuth2, API Key, Local)
- [ ] Entity types identified (what data will you sync?)
- [ ] Rate limits documented
- [ ] Webhook support checked (if real-time sync needed)

### 1.2 File Structure

```
src/connectors/{name}/
├── index.ts       # Connector class (implements Connector interface)
├── schemas.ts     # Zod schemas for external API responses
├── transforms.ts  # Transformations to canonical types
└── README.md      # Connector-specific setup instructions
```

### 1.3 Source Schemas (`schemas.ts`)

Define Zod schemas for **every external API response shape** you'll handle:

```typescript
import { z } from 'zod'

// Raw API response for a message
export const ExternalMessageSchema = z.object({
  id: z.string(),
  sender: z.object({
    email: z.string(),
    name: z.string().optional(),
  }),
  recipients: z.array(z.object({
    email: z.string(),
    type: z.enum(['to', 'cc', 'bcc']),
  })),
  subject: z.string(),
  body: z.string(),
  timestamp: z.number(),  // Unix ms
  threadId: z.string().optional(),
  attachments: z.array(z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
  })).optional(),
})

export type ExternalMessage = z.infer<typeof ExternalMessageSchema>

// Webhook payload schema
export const WebhookPayloadSchema = z.object({
  type: z.string(),
  data: z.unknown(),
  timestamp: z.number(),
})
```

**Guidelines:**
- Use `.optional()` for fields that may be absent
- Use `.nullable()` for fields that may be explicitly null
- Use `.unknown()` for polymorphic/dynamic fields you'll handle at runtime
- Export both the schema and the inferred type

### 1.4 Connector Interface (`index.ts`)

#### Required Properties and Methods

| Property/Method | Type | Purpose |
|-----------------|------|---------|
| `type` | `ConnectorType` | Unique identifier (e.g., `'gmail'`) |
| `name` | `string` | Human-readable name |
| `capabilities` | `ConnectorCapabilities` | Feature flags |
| `getAuthConfig()` | `AuthConfig` | Auth configuration |
| `getSourceSchema(entityType)` | `ZodSchema` | Schema for entity type |
| `fetchPage(ctx, entityType, options)` | `FetchPageResult` | Paginated data fetch |

#### Optional Methods (Based on Capabilities)

| Method | Required When | Purpose |
|--------|---------------|---------|
| `fetchChanges(ctx, entityType, options)` | `incrementalSync: true` | Delta sync from cursor |
| `parseWebhookPayload(payload, headers)` | `webhooks: true` | Parse incoming webhook |
| `verifyWebhook(payload, headers)` | `webhooks: true` | Verify webhook signature |
| `subscribe(ctx, callbackUrl, options)` | `webhooks: true` | Register webhook |
| `unsubscribe(ctx, subscriptionId)` | `webhooks: true` | Unregister webhook |
| `renewSubscription(ctx, subscriptionId)` | `webhooks: true` | Extend webhook expiry |
| `getAuthorizationUrl(state, redirectUri)` | OAuth2 | Generate OAuth URL |
| `exchangeCodeForTokens(code, redirectUri)` | OAuth2 | Exchange code for tokens |
| `refreshAccessToken(refreshToken)` | OAuth2 | Refresh expired token |
| `listAccounts(ctx)` | Multi-account | Discover linked accounts |

#### Minimal Implementation

```typescript
import { z } from 'zod'
import type {
  Connector,
  ConnectorContext,
  ConnectorCapabilities,
  AuthConfig,
  FetchPageResult,
} from '../../connector/sdk/types.js'
import { BaseConnector } from '../../connector/sdk/base.js'
import { ExternalMessageSchema, type ExternalMessage } from './schemas.js'

export class MyConnector extends BaseConnector implements Connector {
  readonly type = 'myservice' as const
  readonly name = 'My Service'

  readonly capabilities: ConnectorCapabilities = {
    supportedEntityTypes: ['message', 'user'],
    incrementalSync: true,
    webhooks: false,
    batchOperations: true,
    rateLimitInfo: true,
  }

  getAuthConfig(): AuthConfig {
    return {
      type: 'api_key',
      apiKey: {
        header: 'Authorization',
        prefix: 'Bearer',
      },
    }
  }

  getSourceSchema(entityType: string): z.ZodType | undefined {
    switch (entityType) {
      case 'message':
        return ExternalMessageSchema
      default:
        return undefined
    }
  }

  async fetchPage(
    ctx: ConnectorContext,
    entityType: string,
    options: FetchPageOptions
  ): Promise<FetchPageResult> {
    const response = await this.http.get('/messages', {
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
      params: {
        limit: options.limit ?? 100,
        cursor: options.cursor,
      },
    })

    return {
      items: response.data.messages.map((msg: ExternalMessage) => ({
        id: msg.id,
        data: msg,
        timestamp: new Date(msg.timestamp),
      })),
      cursor: response.data.nextCursor,
      hasMore: !!response.data.nextCursor,
      rateLimitInfo: this.extractRateLimitHeaders(response.headers),
    }
  }
}
```

### 1.5 Auth Configuration

#### OAuth2 (Most Common)

```typescript
getAuthConfig(): AuthConfig {
  return {
    type: 'oauth2',
    oauth2: {
      authorizationUrl: 'https://accounts.example.com/oauth/authorize',
      tokenUrl: 'https://accounts.example.com/oauth/token',
      scopes: ['read:messages', 'read:profile'],
      clientId: process.env.MYSERVICE_CLIENT_ID!,
      clientSecret: process.env.MYSERVICE_CLIENT_SECRET!,
    },
  }
}

getAuthorizationUrl(state: string, redirectUri: string): string {
  const config = this.getAuthConfig().oauth2!
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    access_type: 'offline',  // Request refresh token
  })
  return `${config.authorizationUrl}?${params}`
}

async exchangeCodeForTokens(code: string, redirectUri: string): Promise<AuthTokens> {
  const config = this.getAuthConfig().oauth2!
  const response = await this.http.post(config.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token,
    expiresAt: new Date(Date.now() + response.data.expires_in * 1000),
  }
}

async refreshAccessToken(refreshToken: string): Promise<AuthTokens> {
  const config = this.getAuthConfig().oauth2!
  const response = await this.http.post(config.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + response.data.expires_in * 1000),
  }
}
```

**User Flow:**
1. Client calls `GET /auth/{connector}/url?redirect_uri=...`
2. User redirected to external OAuth consent screen
3. User approves, redirected back with `code`
4. Client calls `POST /auth/{connector}/callback` with code
5. Tokens stored encrypted, account created

#### API Key

```typescript
getAuthConfig(): AuthConfig {
  return {
    type: 'api_key',
    apiKey: {
      header: 'Authorization',    // or 'X-API-Key'
      prefix: 'Bearer',           // or '' for no prefix
    },
  }
}
```

**User Flow:**
1. User obtains API key from external service settings
2. Client calls `POST /accounts` with `{ credentials: { apiKey: "..." } }`
3. Key stored encrypted, account created

#### Local (Filesystem, Local Services)

```typescript
getAuthConfig(): AuthConfig {
  return {
    type: 'local',
    local: {
      requiresSetup: true,
      setupInstructions: `
1. Install imessage-export: brew install imessage-export
2. Grant Full Disk Access in System Preferences
3. Run: imessage-export init
4. Validate: imessage-export test
      `,
      validateCommand: 'imessage-export test',
    },
  }
}
```

**User Flow:**
1. User follows setup instructions
2. Client calls `POST /accounts` with `{ credentials: { validated: true } }`
3. Account created (no stored credentials needed)

### 1.6 Webhook Support (Optional)

If the external service supports push notifications:

```typescript
readonly capabilities: ConnectorCapabilities = {
  // ...
  webhooks: true,
}

async subscribe(
  ctx: ConnectorContext,
  callbackUrl: string,
  options?: WebhookSubscribeOptions
): Promise<WebhookSubscription> {
  const response = await this.http.post('/webhooks', {
    url: callbackUrl,
    events: options?.entityTypes ?? ['message'],
  }, {
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
  })

  return {
    subscriptionId: response.data.id,
    expiresAt: response.data.expiresAt
      ? new Date(response.data.expiresAt)
      : undefined,
  }
}

async unsubscribe(
  ctx: ConnectorContext,
  subscriptionId: string
): Promise<void> {
  await this.http.delete(`/webhooks/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
  })
}

verifyWebhook(
  payload: unknown,
  headers: Record<string, string>
): WebhookVerificationResult {
  const signature = headers['x-webhook-signature']
  const expected = this.computeSignature(payload)

  return {
    valid: signature === expected,
    error: signature !== expected ? 'Invalid signature' : undefined,
  }
}

parseWebhookPayload(
  payload: unknown,
  headers: Record<string, string>
): SourceItem[] {
  const parsed = WebhookPayloadSchema.parse(payload)

  return [{
    id: parsed.data.id,
    data: parsed.data,
    timestamp: new Date(parsed.timestamp),
  }]
}
```

---

## Part 2: Defining Transformations

Transformations convert raw external data into canonical entities. They are:
- **Deterministic**: Same input always produces same output
- **Idempotent**: Can be re-run safely
- **Versioned**: Schema changes tracked
- **Auditable**: Full lineage preserved

### 2.1 Transformation Structure

```typescript
// transforms.ts
import { z } from 'zod'
import type { Transformation, TransformContext, TransformResult } from '../../transform/types.js'
import { ExternalMessageSchema, type ExternalMessage } from './schemas.js'

export const messageTransform: Transformation<ExternalMessage> = {
  // Unique identifier
  id: 'myservice_message_to_message',

  // Human-readable name
  name: 'MyService Message → Message',

  // Source identification (matches raw envelope metadata)
  source: {
    connector: 'myservice',
    entityType: 'message',
  },

  // Input validation schema
  inputSchema: ExternalMessageSchema,

  // Output canonical type(s)
  outputType: 'message',  // Single type
  // outputType: ['message', 'attachment'],  // Multiple types

  // Field-by-field mapping function
  transform: (input: ExternalMessage, ctx: TransformContext): TransformResult => {
    return {
      entityType: 'message',

      // Platform identification
      platform: {
        type: 'myservice',
        id: 'myservice',
      },

      // Content mapping
      content: input.body,
      subject: input.subject,

      // Sender as source reference (will be resolved)
      sender: {
        connector: 'myservice',
        entityType: 'user',
        externalId: input.sender.email,
      },

      // Recipients
      recipients: input.recipients.map(r => ({
        connector: 'myservice',
        entityType: 'user',
        externalId: r.email,
      })),

      // Timestamps (normalize to ISO8601)
      sentAt: new Date(input.timestamp).toISOString(),

      // Threading
      threadId: input.threadId,

      // Source reference (for lineage)
      sourceRef: {
        connector: 'myservice',
        entityType: 'message',
        externalId: input.id,
      },
    }
  },

  // Error handling policy
  onError: 'skip',  // 'fail' | 'skip' | 'quarantine'

  // Enable/disable
  enabled: true,

  // Schema version (increment when transform logic changes)
  version: 1,
}
```

### 2.2 Multi-Output Transformations

When one source record produces multiple canonical entities:

```typescript
export const messageWithAttachmentsTransform: Transformation<ExternalMessage> = {
  id: 'myservice_message_to_message_and_attachments',
  name: 'MyService Message → Message + Attachments',
  source: { connector: 'myservice', entityType: 'message' },
  inputSchema: ExternalMessageSchema,
  outputType: ['message', 'attachment'],

  transform: (input, ctx): TransformResult[] => {
    const messageId = ctx.generateId()

    const results: TransformResult[] = [
      {
        entityType: 'message',
        id: messageId,
        content: input.body,
        // ... other fields
      },
    ]

    // Add attachment entities
    for (const att of input.attachments ?? []) {
      results.push({
        entityType: 'attachment',
        parentId: messageId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        sourceRef: {
          connector: 'myservice',
          entityType: 'attachment',
          externalId: att.id,
        },
      })
    }

    return results
  },

  onError: 'skip',
  enabled: true,
  version: 1,
}
```

### 2.3 Conversation Transformation Example

For connectors that sync conversation/session data:

```typescript
export const sessionToConversationTransform: Transformation<ExternalSession> = {
  id: 'myservice_session_to_conversation',
  name: 'MyService Session → Conversation + Messages',
  source: { connector: 'myservice', entityType: 'session' },
  inputSchema: ExternalSessionSchema,
  outputType: ['conversation', 'message'],

  transform: (input, ctx): TransformResult[] => {
    const conversationId = ctx.generateId()
    const messageIds: string[] = []

    // Create message entities
    const messages: TransformResult[] = input.turns.map((turn, index) => {
      const msgId = ctx.generateId()
      messageIds.push(msgId)

      return {
        entityType: 'message',
        id: msgId,
        conversationId,
        content: turn.content,
        sender: {
          connector: 'myservice',
          entityType: 'participant',
          externalId: turn.role,  // 'user' or 'assistant'
        },
        sentAt: turn.timestamp,
        sequenceNumber: index,
      }
    })

    // Create conversation entity
    const conversation: TransformResult = {
      entityType: 'conversation',
      id: conversationId,
      platform: { type: 'myservice', id: 'myservice' },
      messageIds,
      messageCount: messages.length,
      startedAt: input.turns[0]?.timestamp,
      endedAt: input.turns[input.turns.length - 1]?.timestamp,
      participants: [...new Set(input.turns.map(t => t.role))].map(role => ({
        connector: 'myservice',
        entityType: 'participant',
        externalId: role,
      })),
      sourceRef: {
        connector: 'myservice',
        entityType: 'session',
        externalId: input.id,
      },
    }

    return [conversation, ...messages]
  },

  onError: 'fail',  // Conversations should fail atomically
  enabled: true,
  version: 1,
}
```

### 2.4 Adding a New Canonical Type

If your connector needs a canonical type that doesn't exist:

#### Step 1: Add to EntityType enum

```typescript
// src/models/canonical.ts
export const EntityTypeSchema = z.enum([
  'person',
  'identity',
  'org',
  'account',
  'message',
  'conversation',  // ← Add new type
  'event',
  'task',
  'notification',
  'observation',
  'link',
  'attachment',
])
```

#### Step 2: Define the schema

```typescript
// src/models/canonical.ts
export const ConversationSchema = BaseEntitySchema.extend({
  entityType: z.literal('conversation'),
  platform: PlatformSchema,
  messageIds: z.array(z.string()),  // Ordered list of message IDs
  messageCount: z.number(),
  participants: z.array(CanonicalSourceRefSchema),
  startedAt: z.string(),  // ISO8601
  endedAt: z.string().optional(),
  topic: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

export type Conversation = z.infer<typeof ConversationSchema>
```

#### Step 3: Add to EntitySchemas registry

```typescript
// src/models/canonical.ts
export const EntitySchemas: Record<EntityType, z.ZodType> = {
  // ... existing
  conversation: ConversationSchema,
}
```

#### Step 4: Create migration

```sql
-- src/db/migrations/00X_add_conversation.sql

-- No schema changes needed if using JSONB storage
-- Just document the new entity type

COMMENT ON TABLE canonical_entities IS
  'Stores all canonical entities including: person, identity, org, account,
   message, conversation, event, task, notification, observation, link, attachment';
```

#### Step 5: Register transformation

```typescript
// src/connectors/myservice/index.ts
import { transformRegistry } from '../../transform/registry.js'
import { sessionToConversationTransform } from './transforms.js'

// In connector initialization or registration
transformRegistry.register(sessionToConversationTransform)
```

### 2.5 Transformation Registration

```typescript
// transforms.ts - export all transforms
export const transforms = [
  messageTransform,
  userTransform,
  sessionToConversationTransform,
]

// index.ts - register on connector init
import { transforms } from './transforms.js'

export class MyConnector extends BaseConnector {
  constructor(options?: BaseConnectorOptions) {
    super(options)

    // Register all transforms
    for (const transform of transforms) {
      this.transformRegistry.register(transform)
    }
  }
}
```

---

## Part 3: Account Registration (Runtime)

### 3.1 OAuth2 Flow

```
┌─────────┐     ┌─────────┐     ┌──────────────┐     ┌─────────┐
│  Client │     │  Daemon │     │ External API │     │  Client │
└────┬────┘     └────┬────┘     └──────┬───────┘     └────┬────┘
     │               │                  │                  │
     │ GET /auth/{connector}/url        │                  │
     │ ?redirect_uri=...                │                  │
     │──────────────>│                  │                  │
     │               │                  │                  │
     │ { url: "https://..." }           │                  │
     │<──────────────│                  │                  │
     │               │                  │                  │
     │ Redirect user to URL             │                  │
     │─────────────────────────────────>│                  │
     │               │                  │                  │
     │               │    User approves │                  │
     │               │                  │                  │
     │               │  Redirect with code                 │
     │<─────────────────────────────────│                  │
     │               │                  │                  │
     │ POST /auth/{connector}/callback  │                  │
     │ { code, redirect_uri }           │                  │
     │──────────────>│                  │                  │
     │               │                  │                  │
     │               │ Exchange code    │                  │
     │               │─────────────────>│                  │
     │               │                  │                  │
     │               │ Tokens           │                  │
     │               │<─────────────────│                  │
     │               │                  │                  │
     │ { account: { id, email, ... } }  │                  │
     │<──────────────│                  │                  │
```

**API Calls:**

```bash
# Step 1: Get authorization URL
curl -X GET "http://localhost:3001/api/auth/gmail/url?redirect_uri=http://localhost:3000/callback"
# → { "url": "https://accounts.google.com/oauth/authorize?..." }

# Step 2: User completes OAuth in browser, gets redirected with code

# Step 3: Exchange code for account
curl -X POST "http://localhost:3001/api/auth/gmail/callback" \
  -H "Content-Type: application/json" \
  -d '{"code": "4/0AX4XfWh...", "redirect_uri": "http://localhost:3000/callback"}'
# → { "account": { "id": "01HXY...", "email": "user@gmail.com", ... } }
```

### 3.2 API Key Flow

```bash
curl -X POST "http://localhost:3001/api/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "connector": "github",
    "credentials": {
      "apiKey": "ghp_xxxxxxxxxxxx"
    }
  }'
# → { "account": { "id": "01HXY...", ... } }
```

### 3.3 Local Auth Flow

```bash
# User has completed local setup (e.g., installed CLI tool, granted permissions)

curl -X POST "http://localhost:3001/api/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "connector": "imessage",
    "credentials": {
      "validated": true
    }
  }'
# → { "account": { "id": "01HXY...", ... } }
```

### 3.4 Listing Accounts

```bash
curl -X GET "http://localhost:3001/api/accounts"
# → { "accounts": [{ "id": "01HXY...", "connector": "gmail", ... }] }

curl -X GET "http://localhost:3001/api/accounts?connector=gmail"
# → { "accounts": [{ "id": "01HXY...", ... }] }
```

### 3.5 Deleting Accounts

```bash
curl -X DELETE "http://localhost:3001/api/accounts/01HXY..."
# → { "success": true }
```

---

## Part 4: Creating Sync Tasks

### 4.1 One-Time Backfill

Fetch all historical data once:

```bash
curl -X POST "http://localhost:3001/api/tasks/backfill" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "01HXY...",
    "entityTypes": ["message"]
  }'
# → {
#     "task": { "id": "01HXZ...", "mode": "once", "enabled": false },
#     "job": { "id": "01HXZ...", "status": "pending" }
#   }
```

The task is immediately disabled after creating the job (one-shot).

### 4.2 Recurring Sync

Poll for changes on a schedule:

```bash
curl -X POST "http://localhost:3001/api/tasks/subscribe" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "01HXY...",
    "syncType": "incremental",
    "mode": "recurring",
    "intervalMs": 300000,
    "entityTypes": ["message"]
  }'
# → { "task": { "id": "01HXZ...", "mode": "recurring", "intervalMs": 300000 } }
```

| Field | Description |
|-------|-------------|
| `syncType` | `"backfill"` (full) or `"incremental"` (delta) |
| `mode` | `"recurring"` for scheduled polling |
| `intervalMs` | Milliseconds between syncs |
| `entityTypes` | Optional filter for specific types |

### 4.3 Webhook Subscription

Real-time push notifications:

```bash
curl -X POST "http://localhost:3001/api/tasks/subscribe" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "01HXY...",
    "syncType": "incremental",
    "mode": "webhook",
    "entityTypes": ["message"]
  }'
# → {
#     "task": {
#       "id": "01HXZ...",
#       "mode": "webhook",
#       "webhookSubscriptionId": "sub_123..."
#     }
#   }
```

The daemon will:
1. Call `connector.subscribe()` to register webhook with external service
2. Store the subscription ID
3. Handle incoming webhooks at `POST /webhooks/{connector}/{accountId}`

### 4.4 Viewing Tasks

```bash
# Get specific task
curl -X GET "http://localhost:3001/api/tasks/01HXZ..."
# → { "task": { "id": "01HXZ...", ... } }

# List tasks for account
curl -X GET "http://localhost:3001/api/tasks?accountId=01HXY..."
# → { "tasks": [...] }
```

### 4.5 Canceling Tasks

```bash
curl -X DELETE "http://localhost:3001/api/tasks/01HXZ..."
# → { "success": true }
```

For webhook tasks, this will also call `connector.unsubscribe()`.

### 4.6 Viewing Jobs

```bash
# Get job status
curl -X GET "http://localhost:3001/api/jobs/01HXZ..."
# → { "job": { "id": "01HXZ...", "status": "completed", ... } }

# List recent jobs
curl -X GET "http://localhost:3001/api/jobs?limit=10"
# → { "jobs": [...] }

# List jobs for account
curl -X GET "http://localhost:3001/api/jobs?accountId=01HXY..."
# → { "jobs": [...] }
```

---

## Part 5: Testing

### 5.1 Test Structure

```
src/connectors/{name}/
├── __tests__/
│   ├── schemas.test.ts      # Schema validation tests
│   ├── transforms.test.ts   # Transformation tests
│   ├── connector.test.ts    # Connector method tests
│   └── integration.test.ts  # Full flow tests
├── __fixtures__/
│   ├── message.json         # Sample API response
│   ├── message_minimal.json # Minimal valid response
│   ├── message_full.json    # Response with all optional fields
│   └── webhook.json         # Sample webhook payload
```

### 5.2 Schema Tests

```typescript
// __tests__/schemas.test.ts
import { describe, it, expect } from 'vitest'
import { ExternalMessageSchema } from '../schemas.js'
import messageFixture from '../__fixtures__/message.json'

describe('ExternalMessageSchema', () => {
  it('parses valid message', () => {
    const result = ExternalMessageSchema.safeParse(messageFixture)
    expect(result.success).toBe(true)
  })

  it('fails on missing required fields', () => {
    const result = ExternalMessageSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('handles optional fields', () => {
    const minimal = { id: '1', sender: { email: 'a@b.com' }, body: '', timestamp: 0 }
    const result = ExternalMessageSchema.safeParse(minimal)
    expect(result.success).toBe(true)
  })
})
```

### 5.3 Transformation Tests

```typescript
// __tests__/transforms.test.ts
import { describe, it, expect } from 'vitest'
import { messageTransform } from '../transforms.js'
import messageFixture from '../__fixtures__/message.json'

describe('messageTransform', () => {
  const mockContext = {
    generateId: () => '01TEST...',
    now: () => new Date('2024-01-01'),
  }

  it('transforms message correctly', () => {
    const result = messageTransform.transform(messageFixture, mockContext)

    expect(result.entityType).toBe('message')
    expect(result.content).toBe(messageFixture.body)
    expect(result.sender.externalId).toBe(messageFixture.sender.email)
  })

  it('normalizes timestamps to ISO8601', () => {
    const result = messageTransform.transform(messageFixture, mockContext)

    expect(result.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('handles missing optional fields', () => {
    const minimal = { id: '1', sender: { email: 'a@b.com' }, body: 'hi', timestamp: 0 }
    const result = messageTransform.transform(minimal, mockContext)

    expect(result.threadId).toBeUndefined()
  })
})
```

### 5.4 Connector Tests (with Mocks)

```typescript
// __tests__/connector.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MyConnector } from '../index.js'

describe('MyConnector', () => {
  let connector: MyConnector

  beforeEach(() => {
    connector = new MyConnector()
  })

  describe('fetchPage', () => {
    it('fetches and parses messages', async () => {
      // Mock HTTP client
      vi.spyOn(connector['http'], 'get').mockResolvedValue({
        data: {
          messages: [{ id: '1', body: 'test', timestamp: Date.now() }],
          nextCursor: 'cursor123',
        },
        headers: {},
      })

      const result = await connector.fetchPage(
        { accountId: 'acc1', accessToken: 'token' },
        'message',
        { limit: 10 }
      )

      expect(result.items).toHaveLength(1)
      expect(result.hasMore).toBe(true)
      expect(result.cursor).toBe('cursor123')
    })
  })

  describe('OAuth', () => {
    it('generates authorization URL', () => {
      const url = connector.getAuthorizationUrl('state123', 'http://localhost/callback')

      expect(url).toContain('client_id=')
      expect(url).toContain('state=state123')
      expect(url).toContain('redirect_uri=')
    })
  })
})
```

### 5.5 Integration Tests

```typescript
// __tests__/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SyncDaemon } from '../../../daemon/index.js'
import { MyConnector } from '../index.js'
import { createDatabase } from '../../../db/connection.js'

describe('MyConnector Integration', () => {
  let daemon: SyncDaemon
  let accountId: string

  beforeAll(async () => {
    const sql = await createDatabase({ connectionString: process.env.TEST_DATABASE_URL })
    daemon = await SyncDaemon.create({
      sql,
      encryptionKey: Buffer.alloc(32),
      port: 0,  // Random port
      webhookBaseUrl: 'http://localhost',
    })
    daemon.registerConnector(new MyConnector())
    await daemon.start()
  })

  afterAll(async () => {
    await daemon.stop()
  })

  it('completes full sync flow', async () => {
    // Create account
    const account = await daemon.accountRepo.create({
      connector: 'myservice',
      external_account_id: 'test@example.com',
      auth_type: 'api_key',
    })
    accountId = account.id

    // Store credentials
    await daemon.authProvider.storeCredentials(accountId, {
      accessToken: process.env.TEST_API_KEY!,
    })

    // Run backfill
    const { job } = await daemon.backfill(accountId, { entityTypes: ['message'] })

    // Wait for completion
    // ... polling or event-based waiting

    // Verify entities created
    const entities = await daemon.entityRepo.findByType('message', { limit: 10 })
    expect(entities.items.length).toBeGreaterThan(0)
  })
})
```

---

## Checklists

### New Connector Checklist

#### Phase 1: Implementation

- [ ] Create folder structure: `src/connectors/{name}/`
- [ ] Define source schemas in `schemas.ts`
- [ ] Implement connector class in `index.ts`
  - [ ] `type` and `name` properties
  - [ ] `capabilities` object
  - [ ] `getAuthConfig()` method
  - [ ] `getSourceSchema()` method
  - [ ] `fetchPage()` method
  - [ ] `fetchChanges()` if incremental sync supported
  - [ ] OAuth methods if using OAuth2
  - [ ] Webhook methods if webhooks supported
- [ ] Create connector-specific `README.md` with setup instructions

#### Phase 2: Transformations

- [ ] Define transformations in `transforms.ts`
- [ ] One transformation per source entity type
- [ ] Field-by-field mapping documented
- [ ] Error policy defined (skip/fail/quarantine)
- [ ] If new canonical type needed:
  - [ ] Add to `EntityType` enum
  - [ ] Define schema
  - [ ] Add to `EntitySchemas`
  - [ ] Create migration

#### Phase 3: Testing

- [ ] Create `__fixtures__/` with sample data
- [ ] Schema validation tests
- [ ] Transformation tests
- [ ] Connector method tests (mocked)
- [ ] Integration test with real API (optional, CI-gated)

#### Phase 4: Registration

- [ ] Export connector from `src/connectors/index.ts`
- [ ] Document required environment variables
- [ ] Add to main README connector list

---

### New Sync Task Checklist

#### Prerequisites

- [ ] Account registered for connector
- [ ] Credentials stored and valid
- [ ] Transformations registered for desired entity types

#### For Backfill Task

- [ ] Determine entity types to sync
- [ ] Estimate data volume (for timeout configuration)
- [ ] Call `POST /tasks/backfill`
- [ ] Monitor job status

#### For Recurring Task

- [ ] Determine sync interval (balance freshness vs rate limits)
- [ ] Determine sync type (backfill vs incremental)
- [ ] Call `POST /tasks/subscribe` with `mode: "recurring"`
- [ ] Verify first execution

#### For Webhook Task

- [ ] Verify connector supports webhooks
- [ ] Ensure webhook callback URL is publicly accessible
- [ ] Call `POST /tasks/subscribe` with `mode: "webhook"`
- [ ] Verify subscription created with external service
- [ ] Test with sample webhook payload

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| OAuth callback fails | Redirect URI mismatch | Ensure exact URI match in external app config |
| Token refresh fails | Refresh token expired | Re-authenticate user |
| Webhook not received | Firewall/NAT | Ensure callback URL publicly accessible |
| Rate limited | Too many requests | Reduce sync interval, enable backoff |
| Schema validation fails | API response changed | Update source schema, increment version |
| Transformation fails | Missing required field | Check input data, update transform |

### Debug Logging

```typescript
import { createLogger } from '../../observability/index.js'

const logger = createLogger({ level: 'debug', component: 'myconnector' })

// In connector methods
logger.debug('Fetching page', { entityType, cursor, limit })
```

### Inspecting Raw Data

```sql
-- Find raw envelopes for debugging
SELECT id, connector, entity_type, data
FROM raw_envelopes
WHERE connector = 'myservice'
ORDER BY collected_at DESC
LIMIT 10;

-- Check transformation results
SELECT id, entity_type, data
FROM canonical_entities
WHERE data->>'sourceRef'->>'connector' = 'myservice'
ORDER BY created_at DESC
LIMIT 10;
```
