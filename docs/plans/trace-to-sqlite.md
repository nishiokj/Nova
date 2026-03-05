# Move Trace Persistence to SQLite (GraphD) & Always-On

## Context

The `TraceSubscriber` currently only persists traces on `git_commit` events, which never fire because commits happen outside the agent's Bash tool. Traces also write to disk (`.agent-trace/`) and PostgreSQL (agent-memory), both of which are wrong homes for this local artifact. We're moving trace storage to the GraphD SQLite DB where messages and session events already live, and persisting every Write/Edit modification immediately rather than waiting for a commit that never comes.

## Changes

### 1. Add `file_traces` table to GraphD schema (`packages/infra/graphd/src/schema.ts`)

Bump to `v7`. New table:

```sql
CREATE TABLE IF NOT EXISTS file_traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    file_path TEXT NOT NULL,        -- relative to repo root
    tool_name TEXT NOT NULL,        -- 'Write' or 'Edit'
    model_id TEXT,                  -- provider/model format
    request_id TEXT,
    old_content TEXT,               -- Edit: old_string (possibly truncated)
    old_content_size_bytes INTEGER, -- full original size before truncation
    old_content_truncated INTEGER NOT NULL DEFAULT 0,
    new_content TEXT,               -- Edit: new_string, Write: content (possibly truncated)
    new_content_size_bytes INTEGER NOT NULL, -- full original size before truncation
    new_content_truncated INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,     -- full SHA-256 hex of original new_content bytes
    created_at INTEGER NOT NULL,    -- unix epoch millis (match existing GraphD timestamp convention)
    FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_traces_session ON file_traces(session_key);
CREATE INDEX IF NOT EXISTS idx_file_traces_path ON file_traces(file_path);
CREATE INDEX IF NOT EXISTS idx_file_traces_created ON file_traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_traces_session_path_created
  ON file_traces(session_key, file_path, created_at DESC);
```

Add `V7_MIGRATION_STATEMENTS` array (same pattern as `V6_MIGRATION_STATEMENTS`) so existing DBs get the table added.

Add `'file_traces'` to `EXPORTABLE_TABLES`.

Enforce payload limits at insert time:
- max stored bytes per content field: `262144` (256 KiB)
- if content exceeds limit, store prefix up to limit and set `*_truncated = 1`
- always store original byte lengths in `*_size_bytes`
- compute `content_hash` from the full original (untruncated) `new_content`

### 2. Add store methods (`packages/infra/graphd/src/store.ts`)

Following the `addEvent`/`getEvents` pattern:

- `addFileTrace(sessionKey, trace)` — insert row, return id
- `getFileTraces(sessionKey, opts?)` — query with optional filters (filePath, toolName, limit, offset)
- `getFileTracesByPath(filePath, opts?)` — get traces for a specific file across sessions
- `getFileTraceCount(sessionKey)` — count for a session

Apply v7 migration in `ensureSchema()`.

Pagination defaults/limits (store + server):
- default `limit = 100`
- max `limit = 500`
- default `offset = 0`

### 3. Add manager methods (`packages/infra/graphd/src/manager.ts`)

- `fileTraceAdd(sessionKey, trace)` — wraps store
- `fileTracesGet(sessionKey, opts?)` — wraps store
- `fileTracesByPathGet(filePath, opts?)` — wraps store

### 4. Expose via GraphD HTTP server (`packages/infra/graphd/src/server.ts`)

Add routes (following existing event route patterns):
- `POST /sessions/:sessionKey/traces` — add trace
- `GET /sessions/:sessionKey/traces` — list traces (query: `file_path`, `tool_name`, `limit`, `offset`)
- `GET /traces/by-file` — get traces for a file across sessions (query: `file_path`, `limit`, `offset`)

Notes:
- do not use file path as a URL path param because repo-relative paths include `/`
- require URL-encoded `file_path` query parameter for by-file lookup

### 5. Rewrite `TraceSubscriber` (`packages/infra/harness-daemon/src/subscribers/trace_subscriber.ts`)

- Remove `persistTrace()` (disk write to `.agent-trace/`)
- Remove `emitTrace()`, the git-commit-based pipeline, `getCommittedFiles()`, `buildFileAttribution()`, `computeLineRange()`, `mergeRanges()`, `getFileAtRevision()`, `buildFallbackAttribution()` — all the commit-triggered emission logic
- Remove `git_commit` event subscription
- Keep `tool_call` subscription but instead of accumulating in-memory, persist each modification to GraphD immediately via the manager
- Constructor takes `GraphDManager` reference instead of `TraceSubscriberConfig` (keep `repoRoot` for path resolution)
- Remove `onTraceEmitted` callback system — no longer needed since persistence is immediate
- Remove `pendingModifications` map — no longer accumulating
- On GraphD write failure, enqueue into a bounded in-memory retry queue (`max 1000`) and retry with exponential backoff (failures are logged; newest writes are dropped only when queue is full)

### 6. Update harness wiring (`packages/infra/harness-daemon/src/harness/harness.ts`)

- Pass `this.graphd` to `createTraceSubscriber()` instead of the current config
- Remove `this.memoryClient` / `TraceClient` type and all its wiring (lines ~444, ~526-535, ~1064-1078)
- Remove `onTraceEmitted` callback registration
- Remove `shouldInitTracePersistence` logic

### 7. Remove postgres artifacts

- Delete `packages/plugins/agent-memory/src/db/migrations/026_agent_traces.sql`
- Delete `packages/plugins/agent-memory/src/db/repositories/agent-traces.ts`
- Delete `packages/plugins/agent-memory/src/daemon/routes/agent-traces.ts`
- Remove trace-related exports from `agent-memory` index files
- Remove `traces` namespace from `SyncClient` (`agent-memory/src/client/index.ts`)
- Remove `TraceResponse`/`TracesResponse`/`AgentTrace` from client types
- Run repo-wide search to remove any remaining trace imports/usages under `packages/plugins/agent-memory`

## Files to modify

- `packages/infra/graphd/src/schema.ts` — v7 table + migration
- `packages/infra/graphd/src/store.ts` — CRUD methods
- `packages/infra/graphd/src/manager.ts` — manager wrappers
- `packages/infra/graphd/src/server.ts` — HTTP routes
- `packages/infra/harness-daemon/src/subscribers/trace_subscriber.ts` — rewrite
- `packages/infra/harness-daemon/src/harness/harness.ts` — rewire

## Files to delete/clean

- `packages/plugins/agent-memory/src/db/migrations/026_agent_traces.sql`
- `packages/plugins/agent-memory/src/db/repositories/agent-traces.ts`
- `packages/plugins/agent-memory/src/daemon/routes/agent-traces.ts`
- `packages/plugins/agent-memory/src/client/index.ts` — remove traces namespace
- `packages/plugins/agent-memory/src/client/types.ts` — remove trace types
- `packages/plugins/agent-memory/src/db/repositories/index.ts` — remove trace repo export
- `packages/plugins/agent-memory/src/daemon/routes/index.ts` — remove trace route registration

## Verification

1. Build: `bun run build` in graphd and harness-daemon packages
2. Start a session, make a Write/Edit tool call, verify row appears in `file_traces` table
3. Query `GET /sessions/:key/traces` and `GET /traces/by-file?file_path=...` and confirm pagination defaults and filters
4. Verify nested paths (e.g. `src/a/b.ts`) are queryable via `file_path` and are not route-fragmented
5. Verify truncation behavior with a payload larger than 256 KiB (`*_truncated`, `*_size_bytes`, and `content_hash` populated correctly)
6. Simulate GraphD write failure and confirm retry queue behavior + logs
7. Verify no `.agent-trace/` directory is created
8. Run tests in affected packages (`bun test`) and add/extend tests for:
   - v7 migration + indexes
   - store query defaults/limits
   - server trace route validation and pagination
   - `TraceSubscriber` immediate persistence + retry queue
