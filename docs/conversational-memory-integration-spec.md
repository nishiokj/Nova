# Conversational Memory Integration - Full Implementation Spec

Status: proposal

## Scope

Implement the conversational memory design from `packages/agent-memory/docs/conversational-memory-design.md` in the existing `agent-memory` system with strict type safety, explicit state surfacing, and patch-plan-driven state handling. Do **not** link to `packages/entity-graph` by default.

## Non-Goals

- No default linkage between conversational memory entities and `entity_graph` code symbol entities.
- No cross-domain resolution between memory entities and code symbols unless explicitly added in a future patch.
- No change to the canonical entity schema shape beyond new tables for conversational memory.

## Requirements

### Functional

1. **Tiered memory retrieval**
   - Recent activity summary (by project/goal)
   - Topic drill-down (by entity name or concept search)
   - Entity history (project or goal timeline)
   - Concept resolution (unresolved concept promoted to goal/project)

2. **Deterministic drill-down**
   - Every summary or decision must be traceable to canonical conversations and message IDs.

3. **Temporal salience**
   - Timestamps must be preserved and bucketed at query time (e.g., today, yesterday, this_week).

4. **Explicit state**
   - Every API response must surface a typed `MemoryState` for digest/mention availability.

5. **Idempotent derived processing**
   - Derived tasks must use `derived_processing_log` to avoid reprocessing.

### Type Safety

- All schemas must be defined in Zod and exported as TypeScript types.
- DB row <-> domain model conversions must be centralized and typed.
- All external API responses must have typed client definitions.

### Operational

- Derived tasks must be schedulable via existing derived task infrastructure.
- Derived tasks must record model and processor versions for reprocessing safety.
- All tables must be in the primary `agent-memory` schema (not `entity_graph`).

## Data Model

### New Entity Types (conversational memory domain)

These are **not** part of `CanonicalEntity` in `packages/agent-memory/src/models/canonical.ts`. They are separate, purpose-built tables and types.

#### Project

```
Project {
  id: ULID
  name: string
  description: string | null
  status: 'active' | 'paused' | 'completed' | 'abandoned'
  repo_url?: string
  parent_project_id?: ULID
  conversation_count: number
  last_discussed_at: datetime | null
  created_at: datetime
  updated_at: datetime
}
```

#### Goal

```
Goal {
  id: ULID
  title: string
  description: string | null
  status: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
  parent_goal_id?: ULID
  project_id?: ULID
  progress_notes: string[]
  target_date?: datetime
  completed_at?: datetime
  conversation_count: number
  last_discussed_at: datetime | null
  created_at: datetime
  updated_at: datetime
}
```

#### ConversationDigest

```
ConversationDigest {
  id: ULID
  conversation_id: ULID
  summary: string
  decisions: Array<{
    description: string
    message_id: ULID
    confidence: number
  }>
  outcome?: 'resolved' | 'ongoing' | 'blocked' | 'abandoned'
  processor_version: string
  model_version: string
  created_at: datetime
  updated_at: datetime
}
```

#### EntityMention

```
EntityMention {
  id: ULID
  conversation_id: ULID
  entity_type: 'project' | 'goal' | 'person' | 'issue' | 'concept'
  entity_id: ULID | null
  surface_form: string
  message_ids: ULID[]
  confidence: number
  embedding?: vector
  created_at: datetime
}
```

### Memory State Model

All query responses that return digests or mentions must surface a state:

```
MemoryState = 'missing' | 'queued' | 'processing' | 'ready' | 'stale' | 'failed'
```

State is derived from:
- `derived_processing_log` (processed or not)
- `derived_jobs` (latest job status + errors)
- `canonical_conversation.source_timestamp` vs last processed time

## Schema & Migrations

### New tables

Add a migration file:

- `packages/agent-memory/src/db/migrations/0xx_conversational_memory.sql`

SQL outline:

- `projects`
- `goals`
- `conversation_digests`
- `entity_mentions`

Constraints:
- `entity_mentions.entity_type` CHECK enum
- `entity_mentions.entity_id` nullable only for `concept`
- `conversation_digests.conversation_id` FK to `canonical_conversation`

Indexes:
- `conversation_digests (conversation_id)`
- `entity_mentions (conversation_id)`
- `entity_mentions (entity_type, entity_id)`
- `projects (name)`
- `goals (title)`

## Types & Schemas

### New model file

Create:

- `packages/agent-memory/src/models/conversation-memory.ts`

This file defines:
- Zod schemas for `Project`, `Goal`, `ConversationDigest`, `EntityMention`
- Zod enum for `MemoryEntityType`
- Zod enum for `MemoryState`
- Type exports

Export from:
- `packages/agent-memory/src/models/index.ts`
- `packages/agent-memory/src/index.ts`

## Repositories

Add repositories with typed row conversions:

- `packages/agent-memory/src/db/repositories/projects.ts`
- `packages/agent-memory/src/db/repositories/goals.ts`
- `packages/agent-memory/src/db/repositories/conversation-digests.ts`
- `packages/agent-memory/src/db/repositories/entity-mentions.ts`

Update registry:

- `packages/agent-memory/src/db/repositories/index.ts`

Repository patterns must follow:
- `row -> domain` conversion functions
- `domain -> db` input interfaces
- explicit `string` timestamps to avoid `Date` leakage

## Derived Tasks

### 1) Conversation digest extraction

File:
- `packages/agent-memory/scripts/derive-conversation-digests.ts`

Behavior:
- Input: canonical conversations since last run (by `source_timestamp` or `updated_at`)
- Output: insert/update `conversation_digests`
- Write processing log entries to `derived_processing_log`
- Record `processor_version` + `model_version`

### 2) Entity mention extraction

File:
- `packages/agent-memory/scripts/derive-entity-mentions.ts`

Behavior:
- Input: canonical conversations + messages
- Extract surface forms + message IDs
- Resolve to existing Projects/Goals/People/Issues where confident
- Else create unresolved `concept` mentions (embedding stored)
- Write processing log entries

### 3) Optional concept resolution

File:
- `packages/agent-memory/scripts/resolve-memory-entities.ts`

Behavior:
- Find high-frequency `concept` mentions
- Promote to `project` or `goal` via explicit command or rule
- Backfill `entity_id` on mentions

## API Endpoints (Daemon)

Add `packages/agent-memory/src/daemon/routes/memory.ts` and register in:

- `packages/agent-memory/src/daemon/routes/index.ts`

### Endpoints

1. `GET /memory/recent?days=7`
   - Returns recent digests grouped by project/goal
   - Includes `MemoryState` and relative time buckets

2. `GET /memory/conversation/:id`
   - Returns digest, mentions, and state

3. `GET /memory/entity/:id`
   - Returns project/goal metadata + timeline of digests + decisions

4. `GET /memory/search?q=...&type=project|goal|concept`
   - Searches entity mentions; concept uses embeddings

5. `POST /memory/concepts/promote`
   - Promote concept -> project/goal
   - Backfill `entity_id` for matched mentions

All responses must include:
- `state: MemoryState`
- `last_processed_at`
- `last_job_id`
- `last_error`
- `last_source_timestamp`

## Client Types

Update client:

- `packages/agent-memory/src/client/types.ts`
- `packages/agent-memory/src/client/index.ts`

Add:
- `MemoryState` type
- Response shapes for `/memory/*`
- Methods under a `memory` namespace

## State Calculation Logic

State should be derived by a shared helper:

- `packages/agent-memory/src/memory/state.ts`

Inputs:
- `conversation_id`
- last `derived_processing_log` entry
- last `derived_job` for relevant derived task
- `canonical_conversation.source_timestamp`

Rules:
- `missing`: no digest, no processing log
- `queued`: task scheduled but not started
- `processing`: job in `running`
- `ready`: digest present and up to date
- `stale`: digest present but source timestamp newer than processed time
- `failed`: last job failed and no newer success

## Patch Plan (Explicit)

### Patch 1 - Types & Schemas

- Add `packages/agent-memory/src/models/conversation-memory.ts`
- Export from `packages/agent-memory/src/models/index.ts`
- Export from `packages/agent-memory/src/index.ts`
- Define `MemoryState` and `MemoryEntityType` enums

### Patch 2 - Database Schema

- Create migration `packages/agent-memory/src/db/migrations/0xx_conversational_memory.sql`
- Add tables and indexes
- Ensure idempotent DDL

### Patch 3 - Repositories

- Add `projects.ts`, `goals.ts`, `conversation-digests.ts`, `entity-mentions.ts`
- Update repository index exports
- Provide row <-> model conversion functions

### Patch 4 - Derived Tasks

- Add derived scripts for digests + mentions
- Register via derived task CLI / API
- Ensure `derived_processing_log` is used
- Record `processor_version` and `model_version`

### Patch 5 - Memory State Helper

- Add `packages/agent-memory/src/memory/state.ts`
- Add unit tests for state transitions

### Patch 6 - API & Client

- Add `packages/agent-memory/src/daemon/routes/memory.ts`
- Register routes
- Add client types + methods
- Ensure `MemoryState` is surfaced in responses

### Patch 7 - Optional Promotions

- Add `/memory/concepts/promote` route
- Add repository update helpers
- No linkage to entity_graph

## Tests

- Repository tests for new tables
- State helper tests for all transitions
- API route tests for response shapes + state
- Derived task integration tests to confirm idempotence

## Future Extensions (Explicitly Deferred)

- Bridge table to `entity_graph` (e.g., `memory_code_refs`) only if product needs it
- Automatic code symbol linking based on diffs or patch outputs
- UI or TUI support for conversational memory panels

## Implementation Notes

- Keep conversational memory tables separate from canonical entities to avoid schema drift.
- Do not reuse `agent_goals` table for conversational goals.
- Use existing derived task infrastructure to ensure consistent scheduling and logging.
- All new types must be exported through `packages/agent-memory/src/index.ts` for external consumers.

