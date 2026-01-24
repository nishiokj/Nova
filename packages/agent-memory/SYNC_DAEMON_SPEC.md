# Sync Daemon Specification

## Overview

The Sync Daemon is a standalone, persistent service that orchestrates data synchronization from external sources (Gmail, GitHub, etc.) into canonical entities. It provides:

- **Durable task management**: Sync tasks persist across restarts
- **Flexible scheduling**: One-shot backfills, recurring syncs, or webhook-driven updates
- **HTTP API**: Interface for managing accounts, tasks, and querying data
- **Webhook ingestion**: Receives real-time updates from external services
- **OAuth handling**: Manages authentication flows for connectors

## Current State

### What Exists

The `agent-memory` package already has foundational components:

| Component | Location | Description |
|-----------|----------|-------------|
| `SyncEngine` | `sync/engine.ts` | Orchestrates collect → process pipeline |
| `Collector` | `sync/collector.ts` | Fetches data from connectors, stores as RawEnvelopes |
| `Processor` | `sync/processor.ts` | Transforms RawEnvelopes → canonical entities |
| `MicroQueue` | `sync/queue.ts` | PostgreSQL-backed job queue with retry/dead-letter |
| `Connector` | `connector/sdk/types.ts` | Interface for external service adapters |
| `AuthProvider` | `auth/provider.ts` | Credential encryption, storage, and refresh |
| `AccountRepository` | `db/repositories/account.ts` | Account CRUD, tracks `last_synced_at`, `sync_cursor` |
| `SyncJob` | `db/repositories/sync-job.ts` | Individual job run tracking |

### What's Missing

1. **SyncTask**: Persistent representation of "sync this account on this schedule"
2. **Scheduler**: Component that triggers jobs based on task schedules
3. **HTTP Server**: API for external interaction
4. **Webhook subscription**: Connector methods to subscribe/unsubscribe from webhooks
5. **SyncDaemon**: Top-level class that ties everything together

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           SyncDaemon                                │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  HTTP Server │  │  Scheduler   │  │      SyncEngine          │  │
│  │              │  │              │  │                          │  │
│  │ - REST API   │  │ - Poll loop  │  │  ┌─────────┐ ┌────────┐  │  │
│  │ - OAuth      │  │ - Task mgmt  │  │  │Collector│→│Process │  │  │
│  │ - Webhooks   │  │ - Webhook    │  │  └─────────┘ └────────┘  │  │
│  │              │  │   subscribe  │  │       ↓           ↓      │  │
│  └──────┬───────┘  └──────┬───────┘  │  ┌─────────────────────┐ │  │
│         │                 │          │  │    MicroQueue       │ │  │
│         │                 │          │  └─────────────────────┘ │  │
│         │                 │          └──────────────────────────┘  │
│         │                 │                      │                 │
│         └────────────────┴──────────────────────┘                 │
│                                │                                   │
└────────────────────────────────┼───────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         PostgreSQL                                  │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌───────────────────────┐│
│  │ accounts │ │sync_tasks│ │ sync_jobs  │ │ raw_envelopes         ││
│  └──────────┘ └──────────┘ └────────────┘ │ canonical_entities    ││
│                                           │ entity_source_mappings││
│                                           │ job_queue             ││
│                                           └───────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

## Data Models

### SyncTask

Represents the persistent intent to sync data. This is the "subscription" concept.

```ts
interface SyncTask {
  id: string                    // ULID
  connector: ConnectorType      // 'gmail', 'github', etc.
  account_id: string            // FK to accounts

  // What to sync
  entity_types: string[] | null // null = all types, ['issue'] = specific
  sync_type: 'backfill' | 'incremental'

  // Execution mode
  mode: 'once' | 'recurring' | 'webhook'
  interval_ms: number | null    // For recurring: milliseconds between runs

  // State
  enabled: boolean
  last_job_id: string | null    // Most recent SyncJob
  next_run_at: Date | null      // When scheduler should trigger next
  webhook_subscription_id: string | null  // External webhook ID

  // Metadata
  created_at: Date
  updated_at: Date
}
```

**Relationships:**
- `account_id` → `accounts.id`
- `last_job_id` → `sync_jobs.id`

**Indexes:**
- `(enabled, mode, next_run_at)` - Scheduler query
- `(account_id)` - Find tasks for account
- `(connector, account_id, entity_types, sync_type)` - Prevent duplicates

### Database Schema

```sql
CREATE TABLE sync_tasks (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  entity_types TEXT[] DEFAULT NULL,  -- NULL = all
  sync_type TEXT NOT NULL CHECK (sync_type IN ('backfill', 'incremental')),

  mode TEXT NOT NULL CHECK (mode IN ('once', 'recurring', 'webhook')),
  interval_ms BIGINT DEFAULT NULL,

  enabled BOOLEAN NOT NULL DEFAULT true,
  last_job_id TEXT REFERENCES sync_jobs(id) ON DELETE SET NULL,
  next_run_at TIMESTAMPTZ DEFAULT NULL,
  webhook_subscription_id TEXT DEFAULT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_tasks_scheduler
  ON sync_tasks (enabled, mode, next_run_at)
  WHERE enabled = true;

CREATE INDEX idx_sync_tasks_account
  ON sync_tasks (account_id);

-- Prevent duplicate tasks for same account/connector/entityTypes/syncType
CREATE UNIQUE INDEX idx_sync_tasks_unique
  ON sync_tasks (account_id, connector, sync_type, COALESCE(entity_types::text, ''))
  WHERE enabled = true;
```

## Components

### 1. SyncTaskRepository

Location: `sync/task.ts`

```ts
interface SyncTaskInput {
  connector: ConnectorType
  accountId: string
  entityTypes?: string[]
  syncType: 'backfill' | 'incremental'
  mode: 'once' | 'recurring' | 'webhook'
  intervalMs?: number
}

interface SyncTaskRepository {
  // CRUD
  create(input: SyncTaskInput): Promise<SyncTask>
  findById(id: string): Promise<SyncTask | null>
  findByAccount(accountId: string): Promise<SyncTask[]>
  update(id: string, updates: Partial<SyncTask>): Promise<SyncTask | null>
  delete(id: string): Promise<boolean>

  // Scheduler queries
  findDueForExecution(limit?: number): Promise<SyncTask[]>
  findWebhookTasks(connector: ConnectorType): Promise<SyncTask[]>

  // State updates
  markExecuted(id: string, jobId: string): Promise<SyncTask | null>
  updateNextRunAt(id: string, nextRunAt: Date): Promise<boolean>
  setWebhookSubscriptionId(id: string, subscriptionId: string): Promise<boolean>

  // Bulk operations
  disableForAccount(accountId: string): Promise<number>
}
```

### 2. Scheduler

Location: `sync/scheduler.ts`

The Scheduler runs a poll loop that:
1. Finds tasks where `mode = 'recurring'` and `next_run_at <= now`
2. Enqueues SyncJobs for each
3. Updates `next_run_at = now + interval_ms`

For webhook tasks, it ensures subscriptions are active.

```ts
interface SchedulerConfig {
  /** Poll interval for checking due tasks (default: 10000ms) */
  pollInterval?: number
  /** Maximum tasks to process per poll (default: 50) */
  batchSize?: number
  /** Base URL for webhook callbacks */
  webhookBaseUrl?: string
}

class Scheduler {
  constructor(
    private engine: SyncEngine,
    private taskRepo: SyncTaskRepository,
    private authProvider: AuthProvider,
    config?: SchedulerConfig
  )

  /** Start the scheduler loop */
  async start(): Promise<void>

  /** Stop the scheduler gracefully */
  async stop(): Promise<void>

  /** Process due tasks immediately (for testing) */
  async tick(): Promise<number>

  /** Ensure webhook subscriptions are active */
  async ensureWebhookSubscriptions(): Promise<void>

  /** Subscribe a specific task to webhooks */
  async subscribeTask(taskId: string): Promise<string>

  /** Unsubscribe a task from webhooks */
  async unsubscribeTask(taskId: string): Promise<void>
}
```

**Scheduler Loop:**

```
while running:
  tasks = taskRepo.findDueForExecution(batchSize)

  for task in tasks:
    if task.mode == 'once':
      job = engine.scheduleBackfill/Incremental(...)
      taskRepo.update(task.id, { enabled: false, last_job_id: job.id })

    else if task.mode == 'recurring':
      job = engine.scheduleBackfill/Incremental(...)
      nextRun = now + task.interval_ms
      taskRepo.markExecuted(task.id, job.id)
      taskRepo.updateNextRunAt(task.id, nextRun)

  await sleep(pollInterval)
```

### 3. Connector Webhook Methods

Location: `connector/sdk/types.ts` (additions)

```ts
interface Connector {
  // ... existing methods ...

  /**
   * Subscribe to webhooks for real-time updates.
   * Returns a subscription ID that can be used to unsubscribe.
   *
   * @param ctx - Connector context with credentials
   * @param callbackUrl - URL where webhooks should be sent
   * @param options - Subscription options (event types, etc.)
   */
  subscribe?(
    ctx: ConnectorContext,
    callbackUrl: string,
    options?: WebhookSubscribeOptions
  ): Promise<WebhookSubscription>

  /**
   * Unsubscribe from webhooks.
   *
   * @param ctx - Connector context with credentials
   * @param subscriptionId - ID returned from subscribe()
   */
  unsubscribe?(
    ctx: ConnectorContext,
    subscriptionId: string
  ): Promise<void>

  /**
   * Renew a webhook subscription (if required by the service).
   * Some services require periodic renewal (e.g., Google Push).
   */
  renewSubscription?(
    ctx: ConnectorContext,
    subscriptionId: string
  ): Promise<WebhookSubscription>
}

interface WebhookSubscribeOptions {
  /** Entity types to receive updates for */
  entityTypes?: string[]
  /** Additional service-specific options */
  options?: Record<string, unknown>
}

interface WebhookSubscription {
  /** Subscription ID (from external service) */
  subscriptionId: string
  /** When the subscription expires (if applicable) */
  expiresAt?: Date
  /** Resource URI being watched (service-specific) */
  resourceUri?: string
}
```

### 4. HTTP Server

Location: `daemon/server.ts`

Built on `node:http` with a lightweight router. JSON request/response.

```ts
interface ServerConfig {
  /** Port to listen on */
  port: number
  /** Host to bind to (default: '0.0.0.0') */
  host?: string
  /** Base path for API routes (default: '/api') */
  basePath?: string
}

class HttpServer {
  constructor(
    private daemon: SyncDaemon,
    config: ServerConfig
  )

  async start(): Promise<void>
  async stop(): Promise<void>

  // Route registration (internal)
  get(path: string, handler: RouteHandler): void
  post(path: string, handler: RouteHandler): void
  delete(path: string, handler: RouteHandler): void
}

type RouteHandler = (req: ParsedRequest) => Promise<Response>

interface ParsedRequest {
  method: string
  path: string
  params: Record<string, string>  // URL params like :id
  query: Record<string, string>   // Query string
  body: unknown                   // Parsed JSON body
  headers: Record<string, string>
}
```

### 5. SyncDaemon

Location: `daemon/index.ts`

Top-level class that composes all components.

```ts
interface DaemonConfig {
  /** PostgreSQL connection */
  sql: Sql
  /** Encryption key for credentials (32 bytes) */
  encryptionKey: Buffer
  /** HTTP server port */
  port: number
  /** Base URL for webhook callbacks (e.g., 'https://api.example.com') */
  webhookBaseUrl: string
  /** Scheduler config */
  scheduler?: SchedulerConfig
  /** Engine config */
  engine?: SyncEngineConfig
}

class SyncDaemon {
  readonly engine: SyncEngine
  readonly scheduler: Scheduler
  readonly authProvider: AuthProvider

  private constructor(/* internal */)

  /**
   * Create a new daemon instance.
   * Does not start any background processes.
   */
  static async create(config: DaemonConfig): Promise<SyncDaemon>

  /**
   * Register a connector.
   * Must be called before start().
   */
  registerConnector(connector: Connector): this

  /**
   * Start all daemon components:
   * - HTTP server
   * - SyncEngine (queue worker)
   * - Scheduler
   */
  async start(): Promise<void>

  /**
   * Stop all components gracefully.
   */
  async stop(): Promise<void>

  /**
   * Check if daemon is running.
   */
  get running(): boolean

  // ============ Convenience Methods ============

  /**
   * Create a one-shot backfill task.
   */
  async backfill(
    accountId: string,
    options?: { entityTypes?: string[] }
  ): Promise<SyncTask>

  /**
   * Create a recurring sync task.
   */
  async subscribe(
    accountId: string,
    options: {
      syncType: 'backfill' | 'incremental'
      entityTypes?: string[]
      intervalMs: number
    }
  ): Promise<SyncTask>

  /**
   * Create a webhook-driven sync task.
   */
  async subscribeWebhook(
    accountId: string,
    options?: { entityTypes?: string[] }
  ): Promise<SyncTask>

  /**
   * Cancel a task.
   */
  async cancelTask(taskId: string): Promise<boolean>

  /**
   * Get OAuth URL for a connector.
   */
  getAuthUrl(connector: ConnectorType, redirectUri: string): string

  /**
   * Handle OAuth callback.
   */
  async handleAuthCallback(
    connector: ConnectorType,
    code: string,
    redirectUri: string
  ): Promise<Account>
}
```

## HTTP API

### Accounts

```
POST /api/accounts
  Create account after OAuth callback.
  Body: { connector: string, code: string, redirectUri: string }
  Response: { account: Account }

GET /api/accounts
  List all accounts.
  Query: ?connector=gmail&active=true
  Response: { accounts: Account[] }

GET /api/accounts/:id
  Get account details.
  Response: { account: Account }

DELETE /api/accounts/:id
  Deactivate account (soft delete).
  Response: { success: true }
```

### Tasks

```
POST /api/tasks/backfill
  Create one-shot backfill task.
  Body: { accountId: string, entityTypes?: string[] }
  Response: { task: SyncTask, job: SyncJob }

POST /api/tasks/subscribe
  Create recurring sync task.
  Body: {
    accountId: string,
    syncType: 'backfill' | 'incremental',
    entityTypes?: string[],
    intervalMs: number
  }
  Response: { task: SyncTask }

POST /api/tasks/webhook
  Create webhook-driven sync task.
  Body: { accountId: string, entityTypes?: string[] }
  Response: { task: SyncTask, subscriptionId: string }

GET /api/tasks
  List tasks.
  Query: ?accountId=xxx&enabled=true
  Response: { tasks: SyncTask[] }

GET /api/tasks/:id
  Get task details.
  Response: { task: SyncTask, recentJobs: SyncJob[] }

DELETE /api/tasks/:id
  Cancel/disable task.
  Response: { success: true }

POST /api/tasks/:id/trigger
  Manually trigger a task (skip schedule).
  Response: { job: SyncJob }
```

### Jobs

```
GET /api/jobs
  List recent jobs.
  Query: ?accountId=xxx&status=completed&limit=50
  Response: { jobs: SyncJob[] }

GET /api/jobs/:id
  Get job details including progress.
  Response: { job: SyncJob, stats: SyncStats }

POST /api/jobs/:id/cancel
  Cancel a running job.
  Response: { success: true }

POST /api/jobs/:id/retry
  Retry a failed job.
  Response: { job: SyncJob }
```

### Auth

```
GET /api/auth/:connector/url
  Get OAuth authorization URL.
  Query: ?redirectUri=https://...
  Response: { url: string, state: string }

POST /api/auth/:connector/callback
  Handle OAuth callback.
  Body: { code: string, state: string, redirectUri: string }
  Response: { account: Account }
```

### Webhooks

```
POST /api/webhooks/:connector/:accountId
  Receive webhook from external service.
  Headers: X-Webhook-Signature, etc. (service-specific)
  Body: (service-specific payload)
  Response: 200 OK

  Internal flow:
  1. Look up connector
  2. Verify signature via connector.verifyWebhookSignature()
  3. Parse payload via connector.parseWebhookPayload()
  4. Ingest via collector.ingestWebhook()
```

### Data

```
GET /api/schemas/:connector
  Get entity schemas for a connector.
  Response: {
    schemas: {
      [entityType: string]: {
        source: JSONSchema,
        canonical: JSONSchema
      }
    }
  }

GET /api/entities
  Query canonical entities.
  Query: ?type=email&accountId=xxx&limit=100&cursor=xxx
  Response: { entities: CanonicalEntity[], nextCursor?: string }

GET /api/entities/:id
  Get entity with full lineage.
  Response: {
    entity: CanonicalEntity,
    sources: RawEnvelope[],
    mappings: EntitySourceMapping[]
  }
```

## Flows

### 1. Initial Setup

```
1. Start daemon:
   const daemon = await SyncDaemon.create({
     sql,
     encryptionKey: Buffer.from(process.env.ENCRYPTION_KEY, 'hex'),
     port: 3001,
     webhookBaseUrl: 'https://api.example.com'
   })

   daemon.registerConnector(new GmailConnector())
   daemon.registerConnector(new GitHubConnector())

   await daemon.start()

2. User connects Gmail:
   GET /api/auth/gmail/url?redirectUri=https://app.example.com/callback
   → { url: 'https://accounts.google.com/...', state: 'abc123' }

   User visits URL, authorizes, redirected to app with ?code=xxx&state=abc123

   POST /api/auth/gmail/callback
   { code: 'xxx', state: 'abc123', redirectUri: 'https://app.example.com/callback' }
   → { account: { id: 'acct_01H...', connector: 'gmail', ... } }

3. Start syncing:
   POST /api/tasks/backfill
   { accountId: 'acct_01H...' }
   → { task: { id: 'task_01H...', mode: 'once', ... }, job: { id: 'job_01H...' } }
```

### 2. Recurring Sync

```
1. Create subscription:
   POST /api/tasks/subscribe
   {
     accountId: 'acct_01H...',
     syncType: 'incremental',
     intervalMs: 3600000  // 1 hour
   }
   → { task: { id: 'task_01H...', mode: 'recurring', next_run_at: '...' } }

2. Scheduler loop (internal):
   - Every 10s, query: SELECT * FROM sync_tasks
                       WHERE enabled AND mode = 'recurring' AND next_run_at <= NOW()
   - For each task:
     - engine.scheduleIncremental(connector, accountId, cursor, { entityTypes })
     - UPDATE sync_tasks SET next_run_at = NOW() + interval_ms, last_job_id = ...

3. Monitor:
   GET /api/tasks/task_01H...
   → { task: {...}, recentJobs: [...] }
```

### 3. Webhook-Driven Sync

```
1. Create webhook subscription:
   POST /api/tasks/webhook
   { accountId: 'acct_01H...' }

   Internal:
   - connector.subscribe(ctx, 'https://api.example.com/api/webhooks/gmail/acct_01H...')
   - Store subscriptionId in task

   → { task: { id: 'task_01H...', mode: 'webhook', webhook_subscription_id: 'sub_xxx' } }

2. External service sends webhook:
   POST /api/webhooks/gmail/acct_01H...
   Headers: X-Goog-Resource-ID: sub_xxx
   Body: { ... gmail push notification ... }

   Internal:
   - connector.verifyWebhookSignature(event, secret)
   - items = connector.parseWebhookPayload(event)
   - collector.ingestWebhook('gmail', 'acct_01H...', items)

   → 200 OK

3. Envelopes processed by engine automatically
```

### 4. Error Handling

```
Auth failure during sync:
  - Collector catches AuthError
  - Emits 'auth:failed' event
  - Account deactivated
  - All tasks for account disabled
  - Daemon can notify user (via event handler)

Rate limit:
  - Collector catches RateLimitError
  - Job rescheduled with retry_after delay
  - Emits 'collect:rate_limited' event

Webhook subscription expired:
  - Scheduler detects missing/expired subscription
  - Calls connector.renewSubscription() or connector.subscribe()
  - Updates task with new subscriptionId
```

## File Structure

```
packages/agent-memory/src/
├── sync/
│   ├── index.ts              # Re-exports
│   ├── engine.ts             # SyncEngine (existing)
│   ├── collector.ts          # Collector (existing)
│   ├── processor.ts          # Processor (existing)
│   ├── queue.ts              # MicroQueue (existing)
│   ├── types.ts              # Shared types (existing)
│   ├── task.ts               # NEW: SyncTask model + repository
│   └── scheduler.ts          # NEW: Scheduler component
├── connector/
│   └── sdk/
│       ├── types.ts          # MODIFY: Add webhook methods
│       └── index.ts
├── daemon/
│   ├── index.ts              # NEW: SyncDaemon class
│   ├── server.ts             # NEW: HTTP server
│   └── routes/
│       ├── accounts.ts       # NEW: Account routes
│       ├── tasks.ts          # NEW: Task routes
│       ├── jobs.ts           # NEW: Job routes
│       ├── auth.ts           # NEW: OAuth routes
│       ├── webhooks.ts       # NEW: Webhook ingestion
│       └── data.ts           # NEW: Schema/entity queries
├── db/
│   ├── repositories/
│   │   ├── sync-task.ts      # NEW: SyncTask repository
│   │   └── ... (existing)
│   └── migrations/
│       └── 00X_sync_tasks.sql # NEW: Migration
└── index.ts                  # MODIFY: Export daemon
```

## Usage Example

```ts
// daemon.ts - Entry point script
import postgres from 'postgres'
import { SyncDaemon } from '@agent-memory/daemon'
import { GmailConnector } from '@agent-memory/connectors/gmail'
import { GitHubConnector } from '@agent-memory/connectors/github'

async function main() {
  const sql = postgres(process.env.DATABASE_URL!)

  const daemon = await SyncDaemon.create({
    sql,
    encryptionKey: Buffer.from(process.env.ENCRYPTION_KEY!, 'hex'),
    port: parseInt(process.env.PORT || '3001'),
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL!,
    scheduler: {
      pollInterval: 10000,  // Check for due tasks every 10s
    },
    engine: {
      autoProcess: true,    // Process envelopes after collection
    },
  })

  // Register connectors
  daemon
    .registerConnector(new GmailConnector({
      clientId: process.env.GMAIL_CLIENT_ID!,
      clientSecret: process.env.GMAIL_CLIENT_SECRET!,
    }))
    .registerConnector(new GitHubConnector({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }))

  // Event handlers
  daemon.engine.onEvent((event) => {
    console.log(`[Sync] ${event.type}`, event)
  })

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down...')
    await daemon.stop()
    await sql.end()
    process.exit(0)
  })

  // Start
  await daemon.start()
  console.log(`Daemon running on port ${daemon.port}`)
}

main().catch(console.error)
```

## Implementation Order

1. **SyncTask model + repository** (`sync/task.ts`, `db/repositories/sync-task.ts`)
   - Database migration
   - Repository CRUD + scheduler queries

2. **Connector webhook methods** (`connector/sdk/types.ts`)
   - Add interface methods
   - Update existing connectors (Gmail, etc.)

3. **Scheduler** (`sync/scheduler.ts`)
   - Poll loop for recurring tasks
   - Webhook subscription management

4. **HTTP Server** (`daemon/server.ts`)
   - Basic router
   - JSON parsing
   - Error handling

5. **Route handlers** (`daemon/routes/*.ts`)
   - Account management
   - Task management
   - OAuth flow
   - Webhook ingestion
   - Data queries

6. **SyncDaemon** (`daemon/index.ts`)
   - Compose all components
   - Lifecycle management
   - Convenience methods

7. **Tests**
   - Unit tests for Scheduler
   - Integration tests for HTTP API
   - End-to-end test with mock connector
