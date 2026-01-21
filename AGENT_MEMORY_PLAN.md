# Implementation Spec: Agent Memory - Integrations Layer

## Goal
Build a separate project at `/agentMemory` that provides a long-term agent memory system with:
- Canonical data model (Person/Org/Account/Identity, Message, Event/Task, Notification, Transaction, Observation, Link/Reference)
- Connector SDK for building 3rd party integrations
- ETL backbone (collect → process pipeline)
- Entity resolution and normalization
- Surface layer for querying canonical data (future agent integration)

**Key insight:** This is NOT part of the jesus monorepo. It's a completely separate project. Jesus will NOT interact with it directly yet.

## Approach

### Architectural Decisions
- **Separate project:** `/agentMemory` is standalone with its own package.json, dependencies, and build process
- **SQLite storage:** Local-first, embedded database for RawEnvelope, sync state, canonical entities, merge decisions
- **MicroQueue for jobs:** Durable job execution with SQLite persistence
- **Zod schemas:** Both source schemas and canonical model use Zod with mapping functions
- **ID system:** Critical for idempotency with timestamps and provenance (version or ID)
- **No jesus integration yet:** Surface layer exists but is not consumed by jesus at this time

### Core Components

1. **Connector SDK** (boilerplate generator)
   - Auth: OAuth, API keys, session refresh, token storage
   - Discovery: list accounts/tenants, scopes, capabilities
   - Read: backfill + incremental sync (polling and/or webhooks)
   - Write: optional "actions" (send message, create task, etc.)
   - Rate limiting + retries + pagination
   - Mapping: raw → typed source schema (NOT canonical yet)
   - Standard HTTP client with retry policy, backoff + jitter, rate limit buckets, circuit breaker
   - Cursor helpers: time-based incremental sync, opaque cursor paging, "since token"
   - Webhook framework: verify signature, dedupe delivery, map to "sync hint" events
   - Capability descriptor: supports_webhook, supports_write, supports_delta, supports_attachments, etc.
   - **Deliverable:** a template that spits out a new connector skeleton in minutes

2. **Ingestion + Sync Engine (ETL backbone)**
   - Two phases: collect → process
   - **Collect phase (source-shaped):**
     - Backfill job
     - Incremental sync job
     - Webhook ingestion endpoint → enqueue "sync hint"
     - Output: RawEnvelope records (immutable, append-only)
   - **Process phase (canonical):**
     - Validate + parse raw into typed source record
     - Normalize into canonical entities
     - Dedupe + entity resolution
     - Upsert canonical store
     - Emit derived jobs (indexing/embeddings/summaries)
   - Event-driven with durable queues
   - At-least-once + idempotent handlers (exactly-once is hard)
   - Every job is replayable from raw logs

3. **Cleaning / Normalization / Entity Resolution**
   - Common cleaning: timestamp normalization (timezones), text cleanup (html → text, attachments), PII handling (redaction policies), language detection, link extraction
   - Entity resolution: merge Person across Gmail + Contacts + Calendar + Slack
   - Heuristics: email, phone, name similarity, org domain, stable IDs
   - Store merge decisions + allow overrides (human-in-the-loop)

4. **Canonical Data Model**
   - **Core entities:** Person, Org, Account, Identity
   - **Activity entities:** Message, Event/Task, Notification, Transaction, Observation
   - **Relationships:** Link/Reference
   - **ID system:** super important for idempotency along with timestamps and provenence (version or ID)

5. **Surface Layer**
   - Query methods for canonical data (getPerson, getMessages, searchEntities, getTimeline)
   - Write methods where connectors support it (createMessage, updateEvent)
   - Prepared for future agent integration (Jesus or other agents)

## Q&A Decisions

- **Q**: Where should the Integrations layer live? → **A**: Completely separate project at `/agentMemory`
- **Q**: What storage system? → **A**: SQLite for local-first
- **Q**: Which connectors to prioritize? → **A**: GitHub, Gmail, X.com, Apple iMessage (iOS)
- **Q**: What queue/job system? → **A**: Simple in-memory with persistence (MicroQueue)
- **Q**: How to handle canonical data model? → **A**: Zod schemas with mappers
- **Q**: How should agents interact with canonical model? → **A**: Jesus will NOT interact with it directly yet - surface layer exists for future use
- **Q**: Which Messages platform? → **A**: Apple iMessage (iOS)

## Initial Connectors

1. **GitHub**
   - Issues, PRs, commits, repos
   - Webhook support for real-time updates
   - Good for dev workflows
   - Auth: OAuth or PAT

2. **Gmail**
   - Emails, contacts, threads
   - OAuth 2.0 authentication
   - High-value for personal OS
   - Sync: Polling incremental sync + Pub/Sub webhook

3. **X.com (Twitter)**
   - Tweets, mentions, timelines
   - OAuth support
   - Public API patterns
   - Auth: OAuth 2.0

4. **Apple iMessage (iOS)**
   - Messages, attachments, contacts
   - Local database access (iOS backup or device sync)
   - Personal OS cornerstone
   - Sync: Local file/database polling

## Implementation Steps

### Phase 1: Project Structure & Core Types
1. **Setup project skeleton** at `/agentMemory`
   - Initialize package.json with TypeScript, Bun, Zod, better-sqlite3 dependencies
   - Configure build system (tsconfig, build scripts)
   - Set up directory structure

2. **Define canonical data model** in `src/models/canonical.ts`
   - Zod schemas for: Person, Org, Account, Identity, Message, Event, Task, Notification, Transaction, Observation, Link
   - ID system with UUID generation (using uuid or similar)
   - Timestamps (created_at, updated_at) and provenance fields (source_id, source_version)

3. **Define RawEnvelope schema** in `src/models/raw.ts`
   - Immutable, append-only envelope for raw source data
   - Fields: id, source_connector, source_id, raw_data, received_at, processed_at, sync_job_id

### Phase 2: Database Layer
4. **Create SQLite schema** in `src/db/schema.ts`
   - Tables: raw_envelopes, canonical_entities, entity_mappings, sync_jobs, merge_decisions, provenance_log
   - Indexes for lookups by source_id, entity_type, timestamps
   - Migration support (simple versioned migrations)

5. **Database client** in `src/db/client.ts`
   - better-sqlite3 wrapper
   - Connection handling, transaction helpers
   - Query builders for common patterns (CRUD on canonical entities)

### Phase 3: Connector SDK
6. **Connector base classes** in `src/connector/sdk/base.ts`
   - Abstract BaseConnector class with strict contract
   - Auth management (OAuth, API key storage)
   - Discovery methods (listAccounts, getCapabilities)
   - Standard HTTP client with retry, backoff, circuit breaker

7. **HTTP client with resilience** in `src/connector/sdk/http.ts`
   - Retry policy (idempotent vs non-idempotent)
   - Exponential backoff + jitter
   - Rate limit buckets per endpoint
   - Circuit breaker

8. **Cursor helpers** in `src/connector/sdk/cursors.ts`
   - Time-based incremental sync
   - Opaque cursor paging
   - "Since token" pattern

9. **Webhook framework** in `src/connector/sdk/webhooks.ts`
   - Signature verification
   - Delivery deduplication
   - Map to "sync hint" events

10. **Capability descriptor** in `src/connector/sdk/types.ts`
    - Interfaces: ConnectorCapabilities, AuthConfig, SyncConfig

11. **Connector CLI / template generator** in `src/connector/sdk/generator.ts`
    - `agent-memory new-connector <name>` command
    - Generates skeleton from template

### Phase 4: Sync Engine
12. **Job queue** in `src/sync/queue.ts`
    - MicroQueue with SQLite persistence
    - Job types: backfill, incremental_sync, webhook_process, entity_resolution
    - Job status tracking (pending, running, completed, failed)

13. **Collect phase** in `src/sync/collect.ts`
    - Backfill job implementation
    - Incremental sync job with cursor support
    - Webhook ingestion handler
    - Output: creates RawEnvelope records in DB

14. **Process phase** in `src/sync/process.ts`
    - Validate raw into typed source schema using Zod
    - Normalize to canonical entities
    - Dedupe + entity resolution
    - Upsert canonical store

### Phase 5: Entity Resolution
15. **Entity resolution engine** in `src/resolution/engine.ts`
    - Heuristics: email match, phone match, name similarity, org domain, stable IDs
    - Merge decision storage
    - Human-in-the-loop override support

16. **Normalization** in `src/normalize/pipeline.ts`
    - Timestamp timezone handling
    - HTML → text cleanup
    - PII redaction policies
    - Language detection
    - Link extraction

### Phase 6: Connectors Implementation
17. **GitHub connector** in `src/connectors/github/`
    - Auth: OAuth or PAT
    - Webhook verification
    - Zod schemas for GitHub entities (Issue, PR, Commit, Repo)
    - Mapping: GitHub entities → source schemas
    - Sync jobs: backfill (repos, issues), webhook (push, PR events)

18. **Gmail connector** in `src/connectors/gmail/`
    - Auth: OAuth 2.0 with token refresh
    - Sync: Polling incremental sync + Pub/Sub webhook
    - Zod schemas for Gmail entities (Message, Thread, Contact)
    - Mapping: Gmail API → source schemas

19. **X.com connector** in `src/connectors/xcom/`
    - Auth: OAuth 2.0 (Twitter API v2)
    - Sync: Streaming API or polling
    - Zod schemas for X.com entities (Tweet, User, Mention)
    - Mapping: Twitter API → source schemas

20. **Apple iMessage connector** in `src/connectors/imessage/`
    - Auth: Local database access (iOS backup or device sync)
    - Sync: Local file/database polling
    - Zod schemas for iMessage entities (Message, Attachment, Chat, Contact)
    - Mapping: iMessage database → source schemas
    - **Note:** May require libimobiledevice or similar for iOS device access

### Phase 7: Surface Layer (Future Agent Integration)
21. **Query API** in `src/surface/api.ts`
    - Query methods: getPerson, getMessages, searchEntities, getTimeline
    - Write methods (optional): createMessage, updateEvent (if connector supports write)
    - Prepared for future HTTP API or library integration

22. **CLI tools** (optional) in `src/cli/`
    - `agent-memory sync <connector>` - trigger sync
    - `agent-memory query <entity> <id>` - query canonical entities
    - `agent-memory status` - show sync job status

## Key Files Reference (Target Structure)

```
/agentMemory/
├── package.json
├── tsconfig.json
├── src/
│   ├── models/
│   │   ├── canonical.ts      # Zod schemas for canonical entities
│   │   └── raw.ts            # RawEnvelope and source schemas
│   ├── db/
│   │   ├── schema.ts         # SQLite schema + migrations
│   │   └── client.ts         # DB client + query builders
│   ├── connector/
│   │   ├── sdk/
│   │   │   ├── base.ts       # BaseConnector abstract class
│   │   │   ├── types.ts      # ConnectorCapabilities, AuthConfig
│   │   │   ├── http.ts       # Standard HTTP client with retry/circuit-breaker
│   │   │   ├── cursors.ts    # Cursor helpers (time-based, opaque)
│   │   │   ├── webhooks.ts   # Webhook verification + dedupe
│   │   │   └── generator.ts  # CLI: new-connector template
│   │   ├── github/
│   │   │   └── index.ts      # GitHub connector implementation
│   │   ├── gmail/
│   │   │   └── index.ts      # Gmail connector implementation
│   │   ├── xcom/
│   │   │   └── index.ts      # X.com connector implementation
│   │   └── imessage/
│   │       └── index.ts      # Apple iMessage connector implementation
│   ├── sync/
│   │   ├── queue.ts          # MicroQueue + SQLite persistence
│   │   ├── collect.ts        # Backfill, incremental sync, webhooks
│   │   ├── process.ts        # Validate, normalize, upsert
│   │   └── jobs.ts           # Job type definitions
│   ├── resolution/
│   │   ├── engine.ts         # Entity resolution heuristics
│   │   └── merge.ts          # Merge decision storage
│   ├── normalize/
│   │   └── pipeline.ts       # Timestamp, text, PII, link handling
│   ├── surface/
│   │   └── api.ts            # Query API (future agent integration)
│   ├── cli/
│   │   └── index.ts          # CLI tools
│   └── index.ts
└── README.md
```

## Constraints & Gotchas

**DO NOT:**
- Don't build exactly-once semantics - use at-least-once + idempotency
- Don't mix source and canonical schemas in same layer - keep separation clear
- Don't ignore provenance - every entity must track source_id, source_version, timestamps
- Don't skip webhook deduplication - duplicate events will break idempotency
- Don't assume connector compatibility - use capability descriptors

**MUST MAINTAIN:**
- RawEnvelope must be immutable and append-only (for replayability)
- ID system must guarantee uniqueness across all sources for idempotency
- Entity resolution decisions must be stored and overridable (human-in-the-loop)
- Connectors must remain "small and boring" - strict contract, baked-in defaults
- All sync jobs must be replayable from raw logs
- Surface layer exists but is NOT consumed by jesus yet

**iMessage Connector Considerations:**
- iOS device access requires libimobiledevice or similar
- May need to work with iTunes backups as alternative
- Database schema is not officially documented - reverse engineering required
- Consider macOS alternative (easier to access local messages.db)

## Next Steps

1. Set up the /agentMemory project skeleton
2. Build Phase 1-3 (core types, database, connector SDK)
3. Implement first connector (GitHub) to validate the design
4. Build sync engine with queue system
5. Implement entity resolution and normalization
6. Build remaining connectors (Gmail, X.com, iMessage)
7. Surface layer is built but not integrated with jesus yet
