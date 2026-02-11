# Rex Cockpit Specification

## Overview

The Cockpit is the orchestrator's interface for managing high-autonomy, long-running agent sessions. It prioritizes signal density over comprehensive visibility—surfacing only what requires attention while providing confidence that work is progressing.

---

## Core Principles

1. **Empty by default** — If nothing needs attention, the screen should be nearly empty
2. **Escalation-driven** — The primary interaction is responding to well-formed escalations
3. **Single-pane operation** — One central hub for all interactions, like a chat window
4. **Live presence** — For active sessions, convey "I know you're working and roughly on what"
5. **Invariants steer, tests verify** — Architectural invariants guide the Watcher; task invariants are enforced by test workflows

---

## Architectural Decision: Session IS the Workflow

**We do not introduce a separate Workflow entity.**

Rationale:
- Session already exists and is persisted in GraphD
- Orchestrator already manages goal, current work, progress at runtime
- Adding Workflow would create three layers of "container" (Session → Workflow → WorkItems)
- Temporal's model: Workflow IS the orchestrator, not a separate data structure
- We don't need multi-session workflows

**Escalation is the only genuinely new first-class entity.**

---

## Data Model

### Existing Types (Enriched)

```typescript
// packages/infra/graphd/src/types.ts - ENRICHED

type SessionStatus =
  | 'active'      // Work in progress
  | 'blocked'     // Waiting on escalation
  | 'review'      // PR created, awaiting review
  | 'completed'   // Successfully finished
  | 'failed'      // Unrecoverable failure
  | 'cancelled';  // User aborted

interface GraphDSession {
  sessionKey: string;
  clientType: string;
  workingDir: string | null;
  createdAt: number;
  lastAccessedAt: number;

  // ENRICHED: Workflow-like fields
  status: SessionStatus;
  goal?: string;                    // Original user goal
  currentWorkItemId?: string;       // What's executing now
  currentObjective?: string;        // Human-readable "working on..."

  // Metrics (stored in metadata)
  metrics?: {
    workItemsCompleted: number;
    workItemsFailed: number;
    toolCalls: number;
    llmCalls: number;
    durationMs: number;
  };

  metadata?: Record<string, unknown>;
}

// packages/core/work/src/work-item.ts - NO CHANGES
interface WorkItem {
  workId: string;
  objective: string;        // Primary field we surface
  agent: string;
  domain?: string;
  dependencies: string[];
  // ... other fields exist but are agent-internal
}

// Existing trace structure - NO CHANGES
interface TraceRecord {
  id: string;
  version: string;
  timestamp: string;
  vcs: { type: string; revision: string };
  tool: { name: string; version: string };
  files: Array<{
    path: string;
    conversations: Array<{
      url: string;
      contributor: { type: string; model_id?: string };
      ranges: Array<{ start_line: number; end_line: number }>;
    }>;
  }>;
}
```

### New Types

#### Escalation

The atomic unit of "needs human attention" — **the only genuinely new entity**:

```typescript
type EscalationType =
  | 'architectural'      // Watcher-driven design decision
  | 'uncertainty'        // Agent not confident
  | 'permission'         // Needs approval for action
  | 'conflict'           // Invariant or preference conflict
  | 'review'             // PR/code ready for review
  | 'failure'            // Unrecoverable error
  | 'resource';          // Budget/time threshold hit

type EscalationStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed';

interface EscalationOption {
  id: string;
  label: string;
  description: string;
  implications: string[];     // What happens if chosen
  recommended: boolean;
}

interface Escalation {
  id: string;                 // ULID
  type: EscalationType;
  status: EscalationStatus;

  // Context
  sessionKey: string;         // Links to Session (no separate workflow)
  workItemId?: string;        // Specific workItem if applicable

  // Content
  title: string;              // One-line summary
  context: string;            // Rich markdown context
  tradeoffs?: string[];       // For architectural decisions
  options?: EscalationOption[];

  // Evidence
  references: EscalationReference[];

  // Resolution
  resolvedAt?: number;
  resolution?: {
    optionId?: string;        // If options were provided
    freeformResponse?: string;
    resolvedBy: 'user' | 'system' | 'timeout';
  };

  createdAt: number;
  updatedAt: number;
}

interface EscalationReference {
  type: 'file' | 'diff' | 'commit' | 'decision' | 'workitem' | 'message';
  label: string;
  target: string;             // Path, SHA, ID depending on type
  preview?: string;           // Snippet for inline display
}
```

#### Test Report (Deferred)

```typescript
// Immutable artifact - linked to Session via sessionKey
type TestVerdict = 'pass' | 'fail' | 'error' | 'skip';

interface TestReport {
  id: string;
  sessionKey: string;
  traceId?: string;           // If tied to specific commit
  verdict: TestVerdict;
  passCount: number;
  failCount: number;
  errorCount: number;
  skipCount: number;
  cases: TestCase[];
  coverage?: { lines: number; branches: number; functions: number };
  mutationScore?: number;
  createdAt: number;
  durationMs: number;
}
```

#### PR Review (Deferred)

```typescript
// Stateful - has lifecycle similar to Escalation
type PRReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'merged' | 'closed';

interface PRReview {
  id: string;
  sessionKey: string;
  traceId: string;
  branch: string;
  baseBranch: string;
  commitSha: string;
  title: string;
  description: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  status: PRReviewStatus;
  comments: PRReviewComment[];
  externalUrl?: string;
  createdAt: number;
  updatedAt: number;
}
```

---

## Cockpit Views

### 1. Hub (Primary)

The single-pane operating surface. Resembles a chat window.

**Content:**
- **Escalation Queue** — Pending escalations, newest first. Each is an interactive card that expands inline for resolution.
- **Live Sessions** — Compact indicators of active work (just session name + current objective)
- **Input** — Free-form command/chat input at bottom

**Escalation Card (collapsed):**
```
┌─────────────────────────────────────────────────────────────┐
│ 🔶 ARCHITECTURAL  "auth-refactor"                    2m ago │
│ Should session tokens use JWT or opaque with server lookup? │
└─────────────────────────────────────────────────────────────┘
```

**Escalation Card (expanded):**
```
┌─────────────────────────────────────────────────────────────┐
│ 🔶 ARCHITECTURAL  "auth-refactor"                    2m ago │
├─────────────────────────────────────────────────────────────┤
│ Should session tokens use JWT or opaque with server lookup? │
│                                                             │
│ Context:                                                    │
│ Currently implementing session management for the new auth  │
│ system. The choice affects scalability, revocation, and     │
│ payload size.                                               │
│                                                             │
│ Trade-offs:                                                 │
│ • JWT: Stateless, larger payload, revocation is hard        │
│ • Opaque: Requires DB lookup, easy revocation, smaller      │
│                                                             │
│ References:                                                 │
│ • [auth/session.ts:42-67] current implementation            │
│ • [Decision: "prefer stateless where possible"]             │
│                                                             │
│ ┌─────────────────┐  ┌─────────────────┐                   │
│ │ JWT (recommended)│  │ Opaque tokens   │                   │
│ └─────────────────┘  └─────────────────┘                   │
│                                                             │
│ [Or type a different approach...]                           │
└─────────────────────────────────────────────────────────────┘
```

### 2. Sessions (Secondary)

Overview of all sessions, live and historical.

**Live Sessions:**
```
┌─────────────────────────────────────────────────────────────┐
│ ● auth-refactor           BLOCKED     3 items │ 12m        │
│   ↳ Waiting: architectural decision                        │
├─────────────────────────────────────────────────────────────┤
│ ● api-rate-limiting       ACTIVE      5 items │ 8m         │
│   ↳ Working: implementing sliding window counter           │
├─────────────────────────────────────────────────────────────┤
│ ● fix-login-bug           REVIEW      2 items │ 4m         │
│   ↳ PR ready: fixes null pointer in oauth callback         │
└─────────────────────────────────────────────────────────────┘
```

---

## Escalation - Detailed Specification

### 1. Where Is It Used?

**Creation Points (Producers):**

| Location | Trigger | Description |
|----------|---------|-------------|
| `packages/infra/decision-watcher/src/watcher-agent.ts` | `handlePromptUser` returning `action: 'escalate'` | Watcher decides question needs human input |
| `packages/infra/decision-watcher/src/watcher-agent.ts` | `handleCadenceAudit` detecting uncertainty | Periodic audit finds agent stuck or drifting |
| `packages/infra/decision-watcher/src/watcher-agent.ts` | `handleAgentError` unrecoverable | Error that can't be retried |
| `packages/infra/decision-watcher/src/watcher-agent.ts` | `handleWorkItemCompleted` quality gate needs human | QualityGateDecision with `verdict: 'needs_human'` |
| `packages/core/orchestrator/src/orchestrator.ts` | Resource bounds hit with no watcher resolution | Escalate to human for guidance |

**Consumption Points (Consumers):**

| Location | Operation | Description |
|----------|-----------|-------------|
| `packages/infra/control-plane/src/harness/control_plane_routes.ts` | `GET /cockpit/escalations` | Cockpit polls/streams pending escalations |
| `packages/infra/control-plane/src/harness/control_plane_routes.ts` | `POST /cockpit/escalations/:id/resolve` | Human resolves via Cockpit |
| `packages/core/orchestrator/src/orchestrator.ts` | Subscribes to `escalation_resolved` | Unblocks session and resumes work |
| `packages/infra/decision-watcher/src/watcher-agent.ts` | Resolution injected as context | Watcher uses resolution to inform future decisions |

### 2. Does It Alter State?

**YES. Escalation is a stateful entity with a lifecycle.**

| State Transition | Trigger | Side Effects |
|------------------|---------|--------------|
| `∅ → pending` | Watcher/Orchestrator creates | INSERT into `escalations` table, Session.status → `blocked`, emit `escalation_raised` event |
| `pending → acknowledged` | Cockpit UI opens card | UPDATE `escalations.status`, no session change |
| `pending → resolved` | Human provides resolution | UPDATE `escalations.status`, `resolution_json`, `resolved_at`; check if all escalations resolved → Session.status may → `active` |
| `pending → dismissed` | Human dismisses without answer | UPDATE `escalations.status`; Session.status → `failed` or `cancelled` depending on escalation type |
| `resolved` is terminal | - | Immutable after resolution |

### 3. Event System Integration

**New InternalHookEvent Variants:**

```typescript
// packages/core/agent/src/types.ts - ADD to InternalHookEvent union

| {
    type: 'escalation_raised';
    escalation: {
      id: string;
      escalationType: EscalationType;
      sessionKey: string;
      workItemId?: string;
      title: string;
      context: string;
      tradeoffs?: string[];
      options?: EscalationOption[];
      references: EscalationReference[];
    };
  }
| {
    type: 'escalation_resolved';
    escalationId: string;
    sessionKey: string;
    resolution: {
      optionId?: string;
      freeformResponse?: string;
      resolvedBy: 'user' | 'system' | 'timeout';
    };
  }
| {
    type: 'session_status_changed';
    sessionKey: string;
    previousStatus: SessionStatus;
    newStatus: SessionStatus;
    reason?: string;
    triggeringEscalationId?: string;
  }
```

**New ControlEvent for Resolution Flow:**

```typescript
// packages/core/protocol/src/domain/events.ts - ADD to ControlEvent union

export interface EscalationResolvedEvent extends ControlEventBase {
  type: 'escalation_resolved';
  escalationId: string;
  sessionKey: string;
  resolution: {
    optionId?: string;
    freeformResponse?: string;
    resolvedBy: 'user' | 'system' | 'timeout';
  };
}
```

**New Decision Type:**

```typescript
// packages/core/protocol/src/control/decisions.ts - ADD

/**
 * Decision for escalation resolution (from Cockpit).
 * This is the reverse flow: human decision → orchestrator.
 */
export type EscalationResolutionDecision =
  | { action: 'apply'; guidance: string; optionId?: string }
  | { action: 'abort'; reason: string }
  | { action: 'split'; workItems: WorkItemSpec[] };
```

### 4. Watcher Integration Seam

The existing `PromptAnswerDecision` has `action: 'escalate'` but it's underspecified. Make it explicit:

```typescript
// packages/infra/decision-watcher/src/watcher-agent.ts

if (shouldEscalate(action, trigger, evidenceSummary)) {
  const escalation = buildEscalation({
    type: mapTriggerToEscalationType(trigger),
    sessionKey: ctx.event.sessionKey,
    workItemId: ctx.event.workId,
    title: action.reason.slice(0, 120),
    context: buildEscalationContext(ctx, workItemLogContent),
    tradeoffs: action.tradeoffs,
    options: action.options?.map(toEscalationOption),
    references: extractReferences(ctx),
  });

  // Emit event (async, non-blocking)
  config.internalHookQueue?.enqueue({
    type: 'escalation_raised',
    escalation,
  }, hookContext);

  // Return decision that blocks session
  return {
    decision: { action: 'block_for_escalation', escalationId: escalation.id },
  };
}
```

### 5. Orchestrator Integration Seam

```typescript
// packages/core/orchestrator/src/orchestrator.ts

// On receiving escalation_resolved event:
async function handleEscalationResolved(
  event: EscalationResolvedEvent,
  state: OrchestratorState
): Promise<OrchestratorCommand[]> {
  const session = await getSession(event.sessionKey);

  // Check if all pending escalations are resolved
  const pendingCount = await countPendingEscalations(event.sessionKey);

  if (pendingCount === 0 && session.status === 'blocked') {
    // Transition session back to active
    await updateSessionStatus(event.sessionKey, 'active', 'all escalations resolved');

    // Inject resolution as context for next agent run
    const guidance = buildGuidanceFromResolution(event.resolution);

    return [
      { type: 'inject_context', content: guidance },
      { type: 'resume_work_item', workItemId: session.currentWorkItemId },
    ];
  }

  return [];
}
```

---

## Database Schema

```sql
-- Escalations (in agent-memory PostgreSQL)
CREATE TABLE escalations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  session_key TEXT NOT NULL,
  work_item_id TEXT,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  tradeoffs_json TEXT,
  options_json TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  resolution_json TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_escalations_status ON escalations(status);
CREATE INDEX idx_escalations_session ON escalations(session_key);
CREATE INDEX idx_escalations_created ON escalations(created_at DESC);
```

**Session enrichment (in GraphD SQLite):**
```sql
-- Add columns to existing sessions table
ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE sessions ADD COLUMN goal TEXT;
ALTER TABLE sessions ADD COLUMN current_work_item_id TEXT;
ALTER TABLE sessions ADD COLUMN current_objective TEXT;
```

---

## API Surface (Cockpit Routes)

```typescript
// GET /cockpit/escalations?status=pending&limit=20
// Returns: { escalations: Escalation[] }

// POST /cockpit/escalations/:id/resolve
// Body: { optionId?: string, freeformResponse?: string }
// Returns: { escalation: Escalation }

// GET /cockpit/sessions?status=active,blocked,review&limit=50
// Returns: { sessions: GraphDSession[] }

// GET /cockpit/sessions/:sessionKey
// Returns: { session: GraphDSession, workItems: WorkItem[], traces: TraceRecord[], escalations: Escalation[] }

// WebSocket /cockpit/stream
// Emits: InternalHookEvent (filtered for cockpit-relevant events)
```

---

## Invariants

1. **Every Escalation belongs to exactly one Session** (via sessionKey)
2. **Escalations in 'pending' status block their Session** (status becomes 'blocked')
3. **Resolving all pending escalations on a blocked Session transitions it to 'active'**
4. **Session status transitions are valid:**
   ```
   active → blocked (escalation raised)
   active → review (PR created)
   active → completed (goal achieved)
   active → failed (unrecoverable)
   active → cancelled (user abort)
   blocked → active (escalations resolved)
   review → active (changes requested)
   review → completed (approved + merged)
   ```

---

## Type Placement Summary

| Type | Package | File |
|------|---------|------|
| `SessionStatus` (enriched) | `packages/infra/graphd` | `src/types.ts` |
| `Escalation`, `EscalationType`, `EscalationStatus`, `EscalationOption`, `EscalationReference` | `packages/core/types` | `src/escalation.ts` (NEW) |
| `EscalationRaisedEvent`, `EscalationResolvedEvent`, `SessionStatusChangedEvent` (InternalHookEvent) | `packages/core/agent` | `src/types.ts` |
| `EscalationResolvedEvent` (ControlEvent) | `packages/core/protocol` | `src/domain/events.ts` |
| `EscalationResolutionDecision` | `packages/core/protocol` | `src/control/decisions.ts` |
| Zod schemas | `packages/core/types` | `src/schemas/escalation.ts` (NEW) |

---

## Implementation Order

1. **Enrich Session in GraphD** — Add status, goal, currentWorkItemId, currentObjective columns
2. **Create Escalation types** — Add to `packages/core/types/`
3. **Create escalations table** — Migration in `packages/plugins/agent-memory/`
4. **Extend InternalHookEvent** — Add escalation events to `packages/core/agent/src/types.ts`
5. **Extend ControlEvent** — Add `EscalationResolvedEvent` to `packages/core/protocol/`
6. **Watcher escalation flow** — Modify watcher-agent.ts to create escalations
7. **Orchestrator integration** — Handle escalation_resolved, update session status
8. **Cockpit API routes** — CRUD for escalations, enriched session queries
9. **Cockpit UI** — Hub with escalation cards

---

## Deferred (Phase 2)

### Test Reports

**What it is:** Immutable artifacts produced when tests run.

**Key points:**
- Linked to Session via `sessionKey` (not a separate workflow)
- Created by post-processing Bash tool output (detect `npm test`, `pytest`, etc.)
- No lifecycle — immutable once created, re-runs create new reports
- May trigger escalation if verdict is `fail` or `error`

**Storage:** PostgreSQL (agent-memory) — handles large case arrays, JSONB queries.

---

### PR Review

**What it is:** A user-initiated review interface that reassembles context from traces/workItems.

**Critical: PR Review is NOT part of Session lifecycle.**

```
Session lifecycle:        [workItems] → [commits] → [tests] → DONE ✓
                                │
                                │ (traces recorded along the way)
                                ▼
PR Review (separate):     User clicks "Review branch" → Reassemble context → Chat
```

**Key principles:**
1. **Git does the heavy lifting** — We don't reimplement GitHub, we wrap `git diff`, `git log`
2. **Reassembly, not tracking** — Assemble context from traces/workItems on-demand
3. **Chat interface** — User asks questions about the PR, agent responds with full context
4. **Decoupled** — Session can complete without PR; PR can exist without active session

**What PR Review provides:**

| Component | Source | Description |
|-----------|--------|-------------|
| Diff | `git diff main..branch` | Computed on-demand, not stored |
| Commit history | `git log` | Shows what changed and when |
| **Context summary** | Our traces + workItems | "What was the agent trying to do?" |
| **Chat** | New mini-session | User can ask questions about the code |

**Context assembly:**
```
1. Get commit range: git log main..feature/branch
2. For each SHA, query agent_traces WHERE revision = SHA
3. For each session_key found, get related workItems
4. Synthesize: "Agent implemented X via 3 work items: A, B, C"
5. Present assembled context + diff + chat interface
```

**Minimal storage:**
```sql
-- Only persist chat history (git handles everything else)
CREATE TABLE pr_chat_sessions (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  project_path TEXT NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  session_key TEXT,  -- Optional correlation, NOT a required FK
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Frontend focus:** Since backend is minimal, the UI carries more weight:
- Summary panel: "Agent did X, Y, Z"
- File tree with diff stats
- Unified diff view
- Chat input for asking questions

**External PR integration:** If branch is pushed to GitHub:
- Show "View on GitHub" link
- Display PR state badge (open/merged/closed)
- Don't duplicate GitHub's comment system — our chat is for local review

---

### External PR Sync (Phase 3)

- Push local branches to GitHub
- Create GitHub PR from Cockpit
- Bidirectional comment sync (complex, defer further)
