# Sync Pipeline: Task Creation to Full Execution

## Entry Points

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ENTRY POINTS                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  HTTP API (daemon/routes/tasks.ts)         Scheduler (sync/scheduler.ts)    │
│  ┌──────────────────────────┐              ┌───────────────────────────┐    │
│  │ POST /tasks/backfill     │              │ Polls every 10s           │    │
│  │ POST /tasks/subscribe    │              │ findDueForExecution()     │    │
│  │ POST /tasks/webhook      │              │   ↓                      │    │
│  │ POST /tasks/:id/trigger  │              │ executeTask(task)         │    │
│  └──────────┬───────────────┘              └────────────┬──────────────┘    │
│             │                                           │                   │
│             └──────────────┬────────────────────────────┘                   │
│                            ▼                                                │
│               ┌─── sync_tasks ───────────────────────┐                     │
│               │  TABLE: sync_tasks                   │                     │
│               │  ─────────────────                   │                     │
│               │  id: ULID                            │                     │
│               │  connector: ConnectorType             │                     │
│               │  account_id: string                  │                     │
│               │  mode: 'once' | 'recurring' | 'webhook'                    │
│               │  entity_types: string[]              │                     │
│               │  interval_ms: number                 │                     │
│               │  next_run_at: TIMESTAMPTZ            │                     │
│               │  enabled: boolean                    │                     │
│               └──────────────┬───────────────────────┘                     │
│                              │                                              │
└──────────────────────────────┼──────────────────────────────────────────────┘
                               ▼
```

## Sync Engine — Job Scheduling

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SYNC ENGINE (sync/engine.ts)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  scheduleBackfill(connector, accountId, opts)                               │
│  scheduleIncremental(connector, accountId, cursor, opts)                    │
│           │                                                                 │
│           │  1. Create SyncJob (status='pending')                           │
│           │  2. Enqueue to MicroQueue                                       │
│           ▼                                                                 │
│  ┌─── sync_jobs ─────────────────────────────────┐                         │
│  │  TABLE: sync_jobs                             │                         │
│  │  ─────────────────                            │                         │
│  │  id: ULID (PK)                                │                         │
│  │  connector: ConnectorType                      │                         │
│  │  account_id: string                           │                         │
│  │  job_type: 'backfill'|'incremental'|'webhook' │                         │
│  │  status: see state machine below              │                         │
│  │  priority: number                             │                         │
│  │  cursor_state: JSONB                          │                         │
│  │  items_fetched: number                        │                         │
│  │  items_processed: number                      │                         │
│  │  items_failed: number                         │                         │
│  │  created_at, started_at, completed_at         │                         │
│  │  last_error: text                             │                         │
│  │  retry_count: number                          │                         │
│  │  next_retry_at: TIMESTAMPTZ                   │                         │
│  │  metadata: JSONB                              │                         │
│  └───────────────────────────────────────────────┘                         │
│           │                                                                 │
│           │  Enqueue job with idempotency key                               │
│           ▼                                                                 │
│  ┌─── job_queue ─────────────────────────────────┐                         │
│  │  TABLE: job_queue                             │                         │
│  │  ─────────────────                            │                         │
│  │  id: ULID (PK)                                │                         │
│  │  type: 'sync:collect'|'sync:process'|         │                         │
│  │        'sync:reprocess'                       │                         │
│  │  payload: JSONB (CollectJobPayload or         │                         │
│  │           ProcessJobPayload)                  │                         │
│  │  status: 'pending'|'running'|'completed'|     │                         │
│  │          'failed'|'dead'                      │                         │
│  │  priority: number                             │                         │
│  │  idempotency_key: string (UNIQUE)             │                         │
│  │  visible_at: TIMESTAMPTZ                      │                         │
│  │  attempt_count: number                        │                         │
│  │  max_attempts: 3                              │                         │
│  │  last_error: text                             │                         │
│  │  created_at, started_at, completed_at         │                         │
│  └───────────────────┬───────────────────────────┘                         │
│                      │                                                      │
└──────────────────────┼──────────────────────────────────────────────────────┘
                       ▼
```

## MicroQueue Worker

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              MICRO QUEUE WORKER (sync/queue.ts)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Poll loop (every 100ms):                                                   │
│    dequeue() → SELECT ... WHERE status='pending'                            │
│                AND visible_at <= NOW()                                       │
│                ORDER BY priority DESC, created_at ASC                       │
│                FOR UPDATE SKIP LOCKED                                       │
│                LIMIT 1                                                      │
│           │                                                                 │
│           ├── type='sync:collect'  → handleCollectJob()                     │
│           ├── type='sync:process'  → handleProcessJob()                     │
│           └── type='sync:reprocess'→ handleReprocessJob()                   │
│                                                                             │
│  On failure:                                                                │
│    attempt < 3 → status='pending', visible_at += backoff                    │
│    attempt = 3 → status='dead', write to data/dead-jobs/<id>.json           │
│                                                                             │
└───────────────────────┬─────────────────────────────────────────────────────┘
                        │
          ┌─────────────┼──────────────────────┐
          ▼             │                      ▼
 PHASE 1: COLLECT       │           PHASE 2: PROCESS
```

## Phase 1: Collect

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ╔═══════════════════════════════════════════════════════════════════╗       │
│  ║  PHASE 1: COLLECT (sync/collector.ts)                            ║       │
│  ╠═══════════════════════════════════════════════════════════════════╣       │
│  ║                                                                   ║       │
│  ║  resumeJob(syncJobId)                                             ║       │
│  ║    → syncJobRepo.findById(syncJobId)                              ║       │
│  ║    → syncJobRepo.start(jobId)   [pending|failed → running]        ║       │
│  ║    → runCollect(job, method, entityTypes)                         ║       │
│  ║         │                                                         ║       │
│  ║         │  ┌──────────────────────────────────────┐               ║       │
│  ║         │  │  Auth Resolution                     │               ║       │
│  ║         │  │  ──────────────────                  │               ║       │
│  ║         │  │  local     → { accountId }           │               ║       │
│  ║         │  │  cred_ref  → authProvider.getContext()│               ║       │
│  ║         │  │  oauth2    → authProvider.getContext()│               ║       │
│  ║         │  └──────────────────────────────────────┘               ║       │
│  ║         │                                                         ║       │
│  ║         ▼                                                         ║       │
│  ║    ┌─── PAGE LOOP (max 100 pages) ────────────────────────┐       ║       │
│  ║    │                                                      │       ║       │
│  ║    │  fetchPageWithRetry() (max 3 retries, exp backoff)   │       ║       │
│  ║    │    │                                                 │       ║       │
│  ║    │    ├─ backfill    → connector.fetchPage(ctx, opts)   │       ║       │
│  ║    │    └─ incremental → connector.fetchChanges(ctx, opts)│       ║       │
│  ║    │                        │                             │       ║       │
│  ║    │                        ▼                             │       ║       │
│  ║    │            FetchPageResult {                         │       ║       │
│  ║    │              items: SourceItem[]                     │       ║       │
│  ║    │              hasMore: boolean                        │       ║       │
│  ║    │              nextCursor?: string                     │       ║       │
│  ║    │            }                                         │       ║       │
│  ║    │                        │                             │       ║       │
│  ║    │                        ▼                             │       ║       │
│  ║    │  storeItems(connector, accountId, items, jobId)      │       ║       │
│  ║    │    │                                                 │       ║       │
│  ║    │    │  For each SourceItem:                           │       ║       │
│  ║    │    │    SourceItem {                                 │       ║       │
│  ║    │    │      source_id: string                          │       ║       │
│  ║    │    │      entity_type: string                        │       ║       │
│  ║    │    │      raw_data: unknown                          │       ║       │
│  ║    │    │      source_version?: string                    │       ║       │
│  ║    │    │      source_timestamp?: string                  │       ║       │
│  ║    │    │    }                                            │       ║       │
│  ║    │    │                                                 │       ║       │
│  ║    │    │  1. Validate (source_id, entity_type, raw_data) │       ║       │
│  ║    │    │  2. computeRawDataHash(raw_data) → SHA-256      │       ║       │
│  ║    │    │  3. computeIdempotencyKeys() →                  │       ║       │
│  ║    │    │       raw_key = SHA-256(connector:acct:type:     │       ║       │
│  ║    │    │                         srcId:rawDataHash)      │       ║       │
│  ║    │    │  4. Build RawEnvelopeInput                      │       ║       │
│  ║    │    │                                                 │       ║       │
│  ║    │    ▼                                                 │       ║       │
│  ║    │  envelopeRepo.createMany(envelopes)                  │       ║       │
│  ║    │    INSERT INTO raw_envelopes (...)                    │       ║       │
│  ║    │    ON CONFLICT (idempotency_key) DO NOTHING          │       ║       │
│  ║    │                        │                             │       ║       │
│  ║    │                        ▼                             │       ║       │
│  ║    │  syncJobRepo.updateProgress(jobId, {fetched: N})     │       ║       │
│  ║    │  syncJobRepo.updateCursor(jobId, nextCursor)         │       ║       │
│  ║    │                                                      │       ║       │
│  ║    │  if (hasMore && pageCount < maxPages) → next page    │       ║       │
│  ║    │  else → break                                        │       ║       │
│  ║    │  sleep(pageDelay=100ms) between pages                │       ║       │
│  ║    └──────────────────────────────────────────────────────┘       ║       │
│  ║                     │                                             ║       │
│  ║                     ▼                                             ║       │
│  ║    syncJobRepo.complete(jobId)  [running → completed]             ║       │
│  ║    accountRepo.updateSyncState(accountId, finalCursor)            ║       │
│  ║                     │                                             ║       │
│  ║    if (autoProcess) │                                             ║       │
│  ║      → scheduleProcess(syncJobId)                                 ║       │
│  ║        → enqueue 'sync:process' to job_queue                      ║       │
│  ║                                                                   ║       │
│  ╚═══════════════════════════════════════════════════════════════════╝       │
│                                                                             │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
```

## Raw Envelopes Table

```
          ┌─── raw_envelopes ──────────────────────────────┐
          │  TABLE: raw_envelopes                          │
          │  ────────────────────                          │
          │  id: ULID                                      │
          │  idempotency_key: SHA-256 (UNIQUE)             │
          │  connector: ConnectorType                       │
          │  account_id: string                            │
          │  entity_type: string                           │
          │  source_id: string                             │
          │  source_version?: string                       │
          │  raw_data: JSONB (full payload from connector) │
          │  raw_data_hash: SHA-256                        │
          │  source_timestamp?: TIMESTAMPTZ                │
          │  received_at: TIMESTAMPTZ (NOW())              │
          │  processed_at: TIMESTAMPTZ (NULL until Phase 2)│
          │  processing_error?: text                       │
          │  sync_job_id: FK → sync_jobs.id                │
          │  collection_method: backfill|incremental|      │
          │                     webhook|manual             │
          └──────────────────────┬─────────────────────────┘
                                 │
                                 │  (Phase 2 picks these up)
                                 ▼
```

## Phase 2: Process

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ╔═══════════════════════════════════════════════════════════════════╗       │
│  ║  PHASE 2: PROCESS (sync/processor.ts)                            ║       │
│  ╠═══════════════════════════════════════════════════════════════════╣       │
│  ║                                                                   ║       │
│  ║  processSyncJob(syncJobId)                                        ║       │
│  ║    → envelopeRepo.findBySyncJob(syncJobId)                        ║       │
│  ║      [WHERE sync_job_id = ? AND processed_at IS NULL]             ║       │
│  ║                     │                                             ║       │
│  ║    FOR EACH unprocessed envelope:                                 ║       │
│  ║                     │                                             ║       │
│  ║    ┌────────────────▼─────────────────────────────────────┐       ║       │
│  ║    │  processOne(envelope)                                │       ║       │
│  ║    │                                                      │       ║       │
│  ║    │  1. FIND TRANSFORMATION                              │       ║       │
│  ║    │     transformRegistry.findBySource(connector,        │       ║       │
│  ║    │                                   entityType)        │       ║       │
│  ║    │     ↓                                                │       ║       │
│  ║    │     Transformation {                                 │       ║       │
│  ║    │       id, name, version                              │       ║       │
│  ║    │       source: { connector, entityType, filter? }     │       ║       │
│  ║    │       inputSchema: ZodType                           │       ║       │
│  ║    │       outputType: EntityType | EntityType[]          │       ║       │
│  ║    │       transform(input, ctx) → TransformResult        │       ║       │
│  ║    │       onError: 'skip' | 'fail' | 'quarantine'       │       ║       │
│  ║    │     }                                                │       ║       │
│  ║    │                                                      │       ║       │
│  ║    │  2. VALIDATE                                         │       ║       │
│  ║    │     transformation.inputSchema.safeParse(raw_data)   │       ║       │
│  ║    │     → ValidationError? mark processed with error     │       ║       │
│  ║    │                                                      │       ║       │
│  ║    │  3. TRANSFORM                                        │       ║       │
│  ║    │     transformation.transform(validatedData, ctx)     │       ║       │
│  ║    │     ctx = TransformContext {                          │       ║       │
│  ║    │       envelope, accountId, connector,                │       ║       │
│  ║    │       lookupEntity(sourceRefKey),                    │       ║       │
│  ║    │       lookupEntitiesByType(type, limit)              │       ║       │
│  ║    │     }                                                │       ║       │
│  ║    │     ↓                                                │       ║       │
│  ║    │     TransformResult {                                │       ║       │
│  ║    │       primary: TransformOutput {                     │       ║       │
│  ║    │         entityType: 'Person'|'Message'|'Task'|...    │       ║       │
│  ║    │         sourceRefKey: 'gmail:acct:message:msg123'    │       ║       │
│  ║    │         data: { ...canonical fields }                │       ║       │
│  ║    │         displayText?: 'search text'                  │       ║       │
│  ║    │       }                                              │       ║       │
│  ║    │       related?: TransformOutput[]                    │       ║       │
│  ║    │     }                                                │       ║       │
│  ║    │                                                      │       ║       │
│  ║    │  4. UPSERT ENTITIES (for primary + each related)     │       ║       │
│  ║    │     mappingRepo.findBySourceRefKey(sourceRefKey)      │       ║       │
│  ║    │     ├─ EXISTS → entityRepo.update(entityId, data)    │       ║       │
│  ║    │     └─ NEW    → entityRepo.create(entityType, data)  │       ║       │
│  ║    │                                                      │       ║       │
│  ║    │  5. CREATE LINEAGE MAPPING                           │       ║       │
│  ║    │     mappingRepo.create({                             │       ║       │
│  ║    │       canonical_entity_id, canonical_entity_type,    │       ║       │
│  ║    │       raw_envelope_id, source_ref_key,               │       ║       │
│  ║    │       mapping_confidence: 1.0                        │       ║       │
│  ║    │     })                                               │       ║       │
│  ║    │                                                      │       ║       │
│  ║    │  6. MARK PROCESSED                                   │       ║       │
│  ║    │     envelopeRepo.markProcessed(envelopeId)           │       ║       │
│  ║    │     [SET processed_at = NOW()]                        │       ║       │
│  ║    └──────────────────────────────────────────────────────┘       ║       │
│  ║                                                                   ║       │
│  ║  Return BatchProcessResult {                                      ║       │
│  ║    total, succeeded, failed, skipped                              ║       │
│  ║  }                                                                ║       │
│  ╚═══════════════════════════════════════════════════════════════════╝       │
│                                                                             │
└─────────────────────┬───────────────────────┬───────────────────────────────┘
                      │                       │
                      ▼                       ▼
```

## Output Tables

```
┌─── canonical_entities ───────────┐  ┌─── entity_source_mappings ──────────┐
│  TABLE: canonical_entities       │  │  TABLE: entity_source_mappings      │
│  ──────────────────────          │  │  ──────────────────────────         │
│  id: ULID (PK)                   │  │  id: ULID (PK)                     │
│  entity_type: 'Person'|          │  │  canonical_entity_id: FK → above   │
│    'Message'|'Task'|'Event'      │  │  canonical_entity_type: string     │
│  data: JSONB (canonical fields)  │  │  raw_envelope_id: FK → envelopes   │
│  display_text: TEXT              │  │  source_ref_key: string (UNIQUE)    │
│  search_vector: TSVECTOR         │  │  mapping_confidence: float (0-1)   │
│  embedding: VECTOR(1536)        │  │  created_at: TIMESTAMPTZ           │
│  created_at: TIMESTAMPTZ        │  └────────────────────────────────────┘
│  updated_at: TIMESTAMPTZ        │
│  deleted_at: TIMESTAMPTZ        │
└──────────────────────────────────┘
```

## State Machines

### sync_jobs.status

```
    pending ──→ running ──→ completed
       ↑           │
       │           ▼
       └─────── failed
              (retry_count++, schedule next_retry_at)
```

### job_queue.status

```
    pending ──→ running ──→ completed
       ↑           │
       │           ▼
       │        failed
       │           │
       │    attempt < 3?
       │     ├─ yes → pending (visible_at += exponential backoff)
       │     └─ no  → dead (written to data/dead-jobs/<id>.json)
       │           │
       └───────────┘
```

## Idempotency / Dedup Strategy

### Tier 1 — Raw Data Dedup (raw_envelopes)

```
raw_key = SHA-256(connector:accountId:entityType:sourceId:rawDataHash)
→ UNIQUE constraint on idempotency_key
→ INSERT ... ON CONFLICT DO NOTHING
→ Same data twice = silently skipped
```

### Tier 2 — Entity Dedup (entity_source_mappings)

```
source_ref_key = 'connector:accountId:entityType:sourceId'
→ UNIQUE constraint on source_ref_key
→ Existing mapping? → UPDATE canonical entity
→ No mapping?       → CREATE canonical entity + mapping
```

### Example

```
Gmail message from user@gmail.com arrives twice (same messageId, same raw JSON):
1. First receive: raw_key = hash1, created RawEnvelope A, Canonical Person X
2. Second receive: raw_key = hash1, INSERT rejected (idempotency_key exists)
   → No duplicate RawEnvelope created
   → Person X unchanged

Same message updated by Gmail (different raw JSON, higher timestamp):
1. First version: raw_key = hash1, source_ref_key = 'gmail:account:message:msg123'
2. Updated version: raw_key = hash2, same source_ref_key
   → New RawEnvelope B created (different hash)
   → Person X updated with new data
   → Mapping now links both B and A to X
```

## Supporting Tables

```
┌─── accounts ─────────────────────────────┐
│  id: ULID                                │
│  connector: ConnectorType                 │
│  external_account_id: string             │
│  display_name, email                     │
│  auth_type: oauth2|api_key|basic|token   │
│  credentials_encrypted: BYTEA (AES-GCM)  │
│  refresh_token_encrypted: BYTEA          │
│  token_expires_at: TIMESTAMPTZ           │
│  sync_cursor: TEXT (e.g. Gmail historyId)│
│  is_active: boolean                      │
│  UNIQUE(connector, external_account_id)  │
└──────────────────────────────────────────┘

┌─── registered_connectors ────────────────┐
│  type: ConnectorType (PK)                 │
│  enabled: boolean                        │
│  config: JSONB                           │
└──────────────────────────────────────────┘
```

## Daemon Composition

```
SyncDaemon (daemon/index.ts)
├── HttpServer
│   ├── /tasks     → CRUD sync_tasks + trigger
│   ├── /jobs      → monitor sync_jobs + cancel/retry
│   ├── /connectors→ list registered + sanity check
│   └── /auth      → OAuth flows
│
├── SyncEngine
│   ├── MicroQueue ←→ job_queue table
│   │   ├── handler: 'sync:collect'   → Collector
│   │   ├── handler: 'sync:process'   → Processor
│   │   └── handler: 'sync:reprocess' → Processor
│   ├── Collector ←→ raw_envelopes table
│   ├── Processor ←→ canonical_entities + entity_source_mappings
│   └── TransformationRegistry
│
├── Scheduler ←→ sync_tasks table
│   └── tick() every pollInterval → engine.schedule*()
│
├── AuthProvider ←→ accounts table (credentials)
│
└── Connectors Map
    ├── gmail        → Google API
    ├── github       → GitHub REST API
    ├── claude_sessions → local JSONL files
    ├── telegram     → Telegram API
    └── imessage     → local iMessage DB
```

## Table Reference Summary

| Table | Written By | Read By |
|---|---|---|
| `sync_tasks` | HTTP routes, Scheduler | Scheduler |
| `sync_jobs` | Engine, Collector | Engine, Collector, HTTP routes |
| `job_queue` | Engine (enqueue) | MicroQueue (dequeue/update) |
| `raw_envelopes` | Collector (createMany) | Processor (findBySyncJob) |
| `canonical_entities` | Processor (create/update) | Processor (lookupEntity) |
| `entity_source_mappings` | Processor (create) | Processor (findBySourceRefKey) |
| `accounts` | HTTP/Auth routes | Collector (sync_cursor), AuthProvider |
| `registered_connectors` | Daemon startup | Daemon, HTTP routes |
