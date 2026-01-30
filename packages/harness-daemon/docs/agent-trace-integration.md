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

### 2. TraceSubscriber: `packages/harness-daemon/src/subscribers/trace_subscriber.ts`

Two-phase pipeline:

```
Phase A: Collect (quiet, live)
──────────────────────────────
EventBus
    │
    ▼
TraceSubscriber.handleEvent()
    │ filters: tool_call, Write/Edit, completed, success
    ▼
pendingModifications: Map<filePath, PendingFileModification[]>


Phase B: Emit (on git commit)
─────────────────────────────
TraceSubscriber.emitTrace(sha)
    │
    ├─ getCommittedFiles(sha)      // git diff-tree
    ├─ buildFileAttribution()       // per file in commit
    │   ├─ getFileAtRevision()      // git show sha:path
    │   ├─ computeLineRange()       // locate content in file
    │   └─ mergeRanges()            // consolidate overlapping
    └─ persistTrace()               // write .agent-trace/{sha}.json
```

Key methods:
- `emitTrace(revision: string)` - Call after git commit to finalize and persist
- `setCurrentModel(provider, model)` - Set model for new modifications
- `getPendingCount()` / `getPendingFiles()` - Inspect accumulated state
- `clear()` - Discard pending without emitting

Utilities:
- `extractCommitSha(bashOutput)` - Parse SHA from git commit output
- `isGitCommitCommand(command)` - Check if bash command is a commit

### 3. Exports Added to `packages/types/src/index.ts`

All types and helpers exported from the types barrel.

---

## What's Left To Do

### Required: Wire Up in Harness

In your harness initialization (e.g., `harness.ts`):

```typescript
import {
  createTraceSubscriber,
  extractCommitSha,
  isGitCommitCommand
} from './subscribers/trace_subscriber.js';

// Create subscriber alongside other subscribers
const traceSubscriber = createTraceSubscriber(eventBus, {
  repoRoot: workingDirectory,  // or however you get repo root
  toolName: 'harness',
  toolVersion: '1.0.0',
});

// Update model when LLM changes
traceSubscriber.setCurrentModel(provider, model);
```

### Required: Hook Git Commit Detection

**Option A: Subscribe to Bash tool_call events** (primary mechanism)

```typescript
eventBus.subscribeAll((event) => {
  if (event.type !== 'tool_call') return;
  const data = event.data as ToolCallData;
  if (data.toolName !== 'Bash') return;
  if (data.phase !== 'completed' || !data.success) return;

  const cmd = data.arguments.command as string;
  if (!isGitCommitCommand(cmd)) return;

  const sha = extractCommitSha(data.result ?? '');
  if (sha) {
    traceSubscriber.emitTrace(sha);
  }
});
```

**Option B: Git post-commit hook** (backstop for manual commits)

```bash
#!/bin/sh
# .git/hooks/post-commit
SHA=$(git rev-parse HEAD)
curl -X POST "http://localhost:PORT/emit-trace?sha=$SHA"
# or call CLI: your-agent emit-trace --sha=$SHA
```

### Required: Add to .gitignore

```gitignore
# Agent trace records (until verified no secrets)
.agent-trace/
```

### Optional: Custom URL Provider

Replace `dummyUrlProvider` with your real URL scheme:

```typescript
const traceSubscriber = createTraceSubscriber(eventBus, {
  repoRoot: workingDirectory,
  urlProvider: {
    getUrl: (sessionKey) => `https://app.example.com/sessions/${sessionKey}`,
  },
});
```

### Optional: Expose via API

Add an HTTP endpoint to trigger trace emission for manual/external commits:

```typescript
// POST /emit-trace?sha=abc123
app.post('/emit-trace', (req, res) => {
  const sha = req.query.sha as string;
  const trace = traceSubscriber.emitTrace(sha);
  res.json({ success: !!trace, trace });
});
```

### Optional: Close on Shutdown

```typescript
// In your cleanup code
traceSubscriber.close();
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
