# Agent Trace Integration

Implementation of [Cursor's agent-trace spec](https://github.com/cursor/agent-trace) for tracking AI code contributions.

## What Was Built

### 1. Types Package: `packages/types/src/agent_trace.ts`

Full TypeScript types matching the agent-trace spec:

| Type | Description |
|------|-------------|
| `TraceRecord` | Top-level record anchored to VCS revision |
| `FileAttribution` | Per-file attribution with conversations |
| `Conversation` | Session URL + contributor + line ranges |
| `Contributor` | Type (human/ai/mixed/unknown) + model_id |
| `LineRange` | start_line, end_line, content_hash |
| `PendingFileModification` | Internal: accumulates modifications before commit |
| `ConversationUrlProvider` | Swappable interface for URL generation |

Helpers:
- `formatModelId(provider, model)` → `"anthropic/claude-opus-4-5-20251101"`
- `rfc3339Timestamp()` → RFC 3339 datetime
- `generateTraceId()` → UUID v4
- `dummyUrlProvider` → placeholder returning `session://{sessionKey}`

### 2. Event System: `git_commit` Event

Added first-class `git_commit` event type:

| Location | Change |
|----------|--------|
| `packages/types/src/events.ts` | `AgentCoreEventType` includes `'git_commit'` |
| `packages/types/src/events.ts` | `GitCommitData` interface (sha, command, message?, branch?) |
| `packages/agent/src/types.ts` | `InternalHookEvent` includes `git_commit` type |
| `packages/orchestrator/src/hooks.ts` | `git_commit` in valid hook events |

### 3. Hook System: `PostGitCommit` Hook

Added user-configurable hook for git commits:

| Location | Change |
|----------|--------|
| `packages/harness-daemon/src/harness/skills_loader.ts` | `HookEvent` includes `'PostGitCommit'` |
| `packages/harness-daemon/src/harness/skills_loader.ts` | `HookContext` includes `commitSha`, `commitMessage`, `commitBranch` |
| `packages/harness-daemon/src/harness/hook_executor.ts` | Injects `COMMIT_SHA`, `COMMIT_MESSAGE`, `COMMIT_BRANCH` env vars |

### 4. TraceSubscriber: `packages/harness-daemon/src/subscribers/trace_subscriber.ts`

Two-phase pipeline with automatic git commit detection:

```
Phase A: Collect (quiet, live)
──────────────────────────────
EventBus ─── 'tool_call' ───► TraceSubscriber.handleToolCallEvent()
                                    │ filters: Write/Edit, completed, success
                                    ▼
                              pendingModifications: Map<filePath, PendingFileModification[]>


Phase B: Emit (automatic on git_commit event)
─────────────────────────────────────────────
EventBus ─── 'git_commit' ───► TraceSubscriber.handleGitCommitEvent()
                                    │
                                    ▼
                              TraceSubscriber.emitTrace(sha)
                                    │
                                    ├─ getCommittedFiles(sha)      // git diff-tree
                                    ├─ buildFileAttribution()       // per file in commit
                                    │   ├─ getFileAtRevision()      // git show sha:path
                                    │   ├─ computeLineRange()       // locate content in file
                                    │   └─ mergeRanges()            // consolidate overlapping
                                    ├─ persistTrace()               // write .agent-trace/{sha}.json
                                    └─ notifyCallbacks()            // invoke registered callbacks
```

Key methods:
- `emitTrace(revision: string)` - Finalize and persist (auto-called on git_commit event)
- `onTraceEmitted(callback)` - Register callback for when traces are emitted
- `setCurrentModel(provider, model)` - Set model for new modifications
- `getPendingCount()` / `getPendingFiles()` - Inspect accumulated state
- `clear()` - Discard pending without emitting

Utilities:
- `extractCommitSha(bashOutput)` - Parse SHA from git commit output
- `isGitCommitCommand(command)` - Check if bash command is a commit

### 5. Harness Integration: `packages/harness-daemon/src/harness/harness.ts`

The harness's `postToolUse` hook now:
1. Detects git commits from Bash tool output
2. Emits `git_commit` event via EventBus
3. Executes `PostGitCommit` user hooks

### 6. Database Storage: `packages/agent-memory`

PostgreSQL table for centralized trace storage:

| File | Description |
|------|-------------|
| `src/db/migrations/026_agent_traces.sql` | Table schema with JSONB trace column |
| `src/db/repositories/agent-traces.ts` | Repository with findByRevision, findBySession, findByModelId |
| `src/daemon/routes/agent-traces.ts` | HTTP API routes for CRUD + queries |

---

## Usage

### Basic Setup

```typescript
import { createTraceSubscriber } from './subscribers/trace_subscriber.js';

// Create subscriber - it auto-subscribes to git_commit events
const traceSubscriber = createTraceSubscriber(eventBus, {
  repoRoot: workingDirectory,
  toolName: 'harness',
  toolVersion: '1.0.0',
});

// Update model when LLM changes
traceSubscriber.setCurrentModel(provider, model);
```

### Register Callbacks

```typescript
// Get notified when traces are emitted
const unsubscribe = traceSubscriber.onTraceEmitted((trace) => {
  console.log(`Trace emitted for commit ${trace.vcs.revision}`);
  // Send to analytics, external service, etc.
});

// Later, if needed:
unsubscribe();
```

### User Hooks (PostGitCommit)

Create a hook file (e.g., `~/.claude/hooks/notify-on-commit.json`):

```json
{
  "name": "Notify on commit",
  "description": "Send notification when agent creates a commit",
  "trigger": "PostGitCommit",
  "hooks": [
    {
      "type": "command",
      "command": "echo 'Agent committed $COMMIT_SHA'"
    }
  ]
}
```

Available environment variables:
- `COMMIT_SHA` - The git commit SHA
- `COMMIT_MESSAGE` - The commit message (if extractable)
- `COMMIT_BRANCH` - The branch name (if detectable)
- `HOOK_EVENT` - Always `PostGitCommit`
- `SESSION_KEY`, `REQUEST_ID`, `WORKING_DIR` - Standard context

### Manual Commits (Git Hook)

For commits made outside the agent (manual `git commit`), use a git post-commit hook:

```bash
#!/bin/sh
# .git/hooks/post-commit
SHA=$(git rev-parse HEAD)
curl -X POST "http://localhost:PORT/emit-trace?sha=$SHA"
```

### Add to .gitignore

```gitignore
# Agent trace records (until verified no secrets)
.agent-trace/
```

### Custom URL Provider

Replace `dummyUrlProvider` with your real URL scheme:

```typescript
const traceSubscriber = createTraceSubscriber(eventBus, {
  repoRoot: workingDirectory,
  urlProvider: {
    getUrl: (sessionKey) => `https://app.example.com/sessions/${sessionKey}`,
  },
});
```

### Cleanup

```typescript
// In your cleanup code
traceSubscriber.close();
```

---

## Storage Options

### Option 1: Local Files (Default)

By default, traces are written to `.agent-trace/{sha}.json` in the repo root. This is simple and keeps traces co-located with the code.

### Option 2: PostgreSQL Database

For querying across repos, sessions, and models, persist traces to the `agent_traces` table in agent-memory:

```typescript
import { createAgentTracesRepository } from 'agent-memory';
import type { TraceRecord } from 'types';

// Create repository
const tracesRepo = createAgentTracesRepository({ sql });

// Register callback to persist traces
traceSubscriber.onTraceEmitted(async (trace: TraceRecord) => {
  await tracesRepo.create({
    revision: trace.vcs.revision,
    session_key: trace.files[0]?.conversations[0]?.url?.split('://')[1],
    tool_name: trace.tool.name,
    tool_version: trace.tool.version,
    trace,
  });
});
```

**Database Schema:**

```sql
CREATE TABLE agent_traces (
  id TEXT PRIMARY KEY,
  revision VARCHAR(40) UNIQUE NOT NULL,  -- git SHA
  session_key TEXT,                       -- for querying by session
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  trace JSONB NOT NULL,                   -- full TraceRecord
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
```

**HTTP API:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/traces` | GET | List traces (filter: session_key, tool_name) |
| `/traces` | POST | Create trace |
| `/traces/:id` | GET | Get trace by ID |
| `/traces/revision/:sha` | GET | Get trace by commit SHA |
| `/traces/session/:key` | GET | Get traces by session |
| `/traces/model/:modelId` | GET | Get traces by model (URL-encoded) |

**Example queries:**

```bash
# Get trace for a commit
curl http://localhost:3001/traces/revision/abc1234

# Get all traces for a session
curl http://localhost:3001/traces/session/session-key-123

# Get all traces by Claude Opus 4.5
curl http://localhost:3001/traces/model/anthropic%2Fclaude-opus-4-5-20251101

# Create a trace via API
curl -X POST http://localhost:3001/traces \
  -H 'Content-Type: application/json' \
  -d '{"revision": "abc1234", "trace": {...}}'
```

---

## Output Format

After a commit, `.agent-trace/{sha}.json`:

```json
{
  "version": "0.1",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-01-30T12:00:00.000Z",
  "vcs": {
    "type": "git",
    "revision": "abc1234def5678"
  },
  "tool": {
    "name": "harness",
    "version": "1.0.0"
  },
  "files": [
    {
      "path": "src/feature.ts",
      "conversations": [
        {
          "url": "session://session-key-123",
          "contributor": {
            "type": "ai",
            "model_id": "anthropic/claude-opus-4-5-20251101"
          },
          "ranges": [
            {
              "start_line": 42,
              "end_line": 67,
              "content_hash": "md5:9f2e8a1b"
            }
          ]
        }
      ]
    }
  ]
}
```

---

## Architecture Notes

### Event Flow

```
Bash tool completes with git commit
         │
         ▼
harness.ts postToolUse()
         │
         ├─► Emit 'git_commit' event via EventBus
         │         │
         │         ├─► TraceSubscriber.handleGitCommitEvent()
         │         │         ├─► emitTrace() → .agent-trace/{sha}.json
         │         │         └─► notifyCallbacks() → registered listeners
         │         │                   │
         │         │                   └─► (optional) AgentTracesRepository.create()
         │         │                                → PostgreSQL agent_traces table
         │         │
         │         └─► Other subscribers (GraphD, LogSubscriber, etc.)
         │
         └─► Execute PostGitCommit user hooks
```

### Why Separate From Existing Events?

| System | Purpose | Consumer |
|--------|---------|----------|
| EventBus → GraphD | Execution tracing (what happened) | Dashboard, analytics |
| EventBus → LogSubscriber | Debug logging | Developers |
| Watcher memory | Live decision context | Autonomous watcher |
| **TraceSubscriber** | **Code attribution (who wrote what)** | **Git blame, audits** |

These are complementary, not redundant. TraceSubscriber listens to the same EventBus but transforms events for a different purpose (VCS-anchored attribution vs runtime tracing).

### Commit-Level Anchoring

Trace records are keyed by commit SHA because:
- Line numbers are stable at that revision
- `git blame → commit → trace` is a natural query path
- Avoids ambiguity about file state

### Content Hashing

`content_hash` (e.g., `md5:9f2e8a1b`) enables tracking code movement across refactors. Even if lines shift, you can locate the same content by hash.

---

## References

- [cursor/agent-trace spec](https://github.com/cursor/agent-trace)
- [models.dev convention](https://models.dev) for model IDs
- MIME type: `application/vnd.agent-trace.record+json`
