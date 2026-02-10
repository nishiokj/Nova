# Cockpit Implementation Progress

## Overview

This document tracks the implementation of the Cockpit feature - the orchestrator's interface for managing high-autonomy agent sessions via escalations.

**Key Architectural Decision:** Session IS the Workflow. No separate Workflow entity. Escalation is the only new stateful entity.

---

## Completed Steps (1-5)

### Step 1: Enrich Session in GraphD

**Package:** `packages/graphd`

**Files Modified:**
- `src/types.ts` - Added types
- `src/schema.ts` - Added columns, bumped to v6
- `src/store.ts` - Added migration logic and methods
- `src/index.ts` - Exported new types

**Changes:**

1. **New `SessionStatus` type** (`src/types.ts:263-279`):
```typescript
export type SessionStatus =
  | 'active'      // Work in progress
  | 'blocked'     // Waiting on escalation
  | 'review'      // PR created, awaiting review
  | 'completed'   // Successfully finished
  | 'failed'      // Unrecoverable failure
  | 'cancelled'   // User aborted
  | 'inactive'    // Stale (legacy)
  | 'expired';    // Cleaned up (legacy)
```

2. **New `SessionMetrics` interface** (`src/types.ts:284-291`)

3. **Extended `GraphDSession`** with workflow fields (`src/types.ts:308-314`):
```typescript
goal?: string | null;
currentWorkItemId?: string | null;
currentObjective?: string | null;
```

4. **Schema v6** (`src/schema.ts:22`):
- Added columns to sessions table DDL
- Added `V6_MIGRATION_STATEMENTS` for ALTER TABLE

5. **New store method** `updateSessionWorkflow()` (`src/store.ts:608-645`):
- Updates status, goal, currentWorkItemId, currentObjective
- Only updates non-null fields

6. **Migration logic** (`src/store.ts:168-180`):
- Runs ALTER TABLE statements for v5→v6 upgrade
- Gracefully handles "duplicate column" errors

---

### Step 2: Create Escalation Types

**Package:** `packages/types`

**Files Created:**
- `src/escalation.ts` - All escalation types

**Files Modified:**
- `src/index.ts` - Exports

**Types Created:**

```typescript
// Classification
type EscalationType =
  | 'architectural' | 'uncertainty' | 'permission'
  | 'conflict' | 'review' | 'failure' | 'resource';

// Lifecycle
type EscalationStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed';

// Core interfaces
interface EscalationOption { id, label, description, implications[], recommended }
interface EscalationReference { type, label, target, preview? }
interface EscalationResolution { optionId?, freeformResponse?, resolvedBy }
interface Escalation { id, type, status, sessionKey, workItemId?, title, context, ... }

// API inputs
interface EscalationCreateInput { ... }
interface EscalationResolveInput { optionId?, freeformResponse? }

// Type guards
function isEscalationPending(e): boolean
function isEscalationTerminal(e): boolean
function isEscalationBlocking(e): boolean

// Constants
const ALL_ESCALATION_TYPES: readonly EscalationType[]
const ALL_ESCALATION_STATUSES: readonly EscalationStatus[]
```

---

### Step 3: Create Escalations Table

**Package:** `packages/agent-memory`

**Files Created:**
- `src/db/migrations/032_escalations.sql` - PostgreSQL migration
- `src/db/repositories/escalations.ts` - Repository

**Files Modified:**
- `src/db/repositories/index.ts` - Exports

**Migration (`032_escalations.sql`):**
```sql
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,  -- ULID
  type TEXT NOT NULL CHECK (type IN (...)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (...)),
  session_key TEXT NOT NULL,
  work_item_id TEXT,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  tradeoffs_json TEXT,
  options_json TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  resolution_json TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_escalations_status ON escalations(status);
CREATE INDEX idx_escalations_session ON escalations(session_key);
CREATE INDEX idx_escalations_pending ON escalations(created_at DESC) WHERE status = 'pending';
```

**Repository (`escalations.ts`):**
```typescript
interface EscalationsRepository {
  findById(id: string): Promise<Escalation | null>
  list(options?: EscalationListOptions): Promise<Escalation[]>
  count(options?): Promise<number>
  create(input: EscalationCreateInput): Promise<Escalation>
  updateStatus(id: string, status: EscalationStatus): Promise<Escalation | null>
  resolve(id: string, input: EscalationResolveInput): Promise<Escalation | null>
  dismiss(id: string): Promise<Escalation | null>
  countPending(sessionKey: string): Promise<number>
}
```

---

### Step 4: Extend InternalHookEvent

**Package:** `packages/agent`

**File Modified:** `src/types.ts`

**Added to `InternalHookEvent` union** (lines 453-497):

```typescript
| {
    type: 'escalation_raised';
    escalation: {
      id: string;
      escalationType: string;
      sessionKey: string;
      workItemId?: string;
      title: string;
      context: string;
      tradeoffs?: string[];
      options?: Array<{ id, label, description, implications[], recommended }>;
      references: Array<{ type, label, target, preview? }>;
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
    previousStatus: string;
    newStatus: string;
    reason?: string;
    triggeringEscalationId?: string;
  }
```

---

### Step 5: Extend ControlEvent

**Package:** `packages/protocol`

**Files Modified:**
- `src/domain/events.ts` - Added event type
- `src/control/gates.ts` - Added to pass-through events

**Added `EscalationResolvedEvent`** (`events.ts:137-149`):
```typescript
export interface EscalationResolvedEvent extends ControlEventBase {
  type: 'escalation_resolved';
  escalationId: string;
  resolution: {
    optionId?: string;
    freeformResponse?: string;
    resolvedBy: 'user' | 'system' | 'timeout';
  };
}
```

**Updated `ControlEvent` union** - Added `| EscalationResolvedEvent`

**Updated `ALL_EVENT_TYPES`** - Added `'escalation_resolved'`

**Added type guard** (`events.ts:293-295`):
```typescript
export function isEscalationResolved(evt: ControlEvent): evt is EscalationResolvedEvent {
  return evt.type === 'escalation_resolved';
}
```

**Added factory** (`events.ts:423-441`):
```typescript
export function createEscalationResolvedEvent(
  sessionKey: string,
  workId: string,
  escalationId: string,
  resolution: { optionId?, freeformResponse?, resolvedBy }
): EscalationResolvedEvent
```

**Marked as pass-through** (`gates.ts`):
- Added `'escalation_resolved': never` to `EventDecisionMap`
- Added to `PassThroughEvent` type
- Added case to `requiresDecision()` returning `false`

---

## Remaining Steps (6-9)

### Step 6: Watcher Escalation Flow (CRITICAL)

**Package:** `packages/decision-watcher`
**File:** `src/watcher-agent.ts`

**What needs to happen:**
1. When `handlePromptUser` returns `action: 'escalate'`, create an escalation
2. When `handleCadenceAudit` detects uncertainty, create an escalation
3. When `handleAgentError` is unrecoverable, create an escalation
4. When `handleWorkItemCompleted` quality gate needs human, create an escalation

**Integration points:**
```typescript
// In watcher decision handlers:
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

### Step 7: Orchestrator Integration (CRITICAL)

**Package:** `packages/orchestrator`
**File:** `src/orchestrator.ts`

**What needs to happen:**
1. Subscribe to `escalation_resolved` ControlEvent
2. When received, check if all pending escalations are resolved
3. If session was blocked and all escalations resolved → transition to 'active'
4. Inject resolution as context for next agent run
5. Resume work item execution

**Integration points:**
```typescript
async function handleEscalationResolved(
  event: EscalationResolvedEvent,
  state: OrchestratorState
): Promise<OrchestratorCommand[]> {
  const session = await getSession(event.sessionKey);
  const pendingCount = await countPendingEscalations(event.sessionKey);

  if (pendingCount === 0 && session.status === 'blocked') {
    await updateSessionStatus(event.sessionKey, 'active', 'all escalations resolved');
    const guidance = buildGuidanceFromResolution(event.resolution);
    return [
      { type: 'inject_context', content: guidance },
      { type: 'resume_work_item', workItemId: session.currentWorkItemId },
    ];
  }
  return [];
}
```

### Step 8: Cockpit API Routes

**Package:** `packages/control-plane`
**File:** `src/harness/control_plane_routes.ts`

**Endpoints to add:**
```
GET  /cockpit/escalations?status=pending&limit=20
POST /cockpit/escalations/:id/resolve
POST /cockpit/escalations/:id/dismiss
GET  /cockpit/sessions?status=active,blocked,review
GET  /cockpit/sessions/:sessionKey
```

**Note:** Requires postgres connection to agent-memory for escalations table.

### Step 9: Cockpit UI

**Package:** `packages/dashboard-control`

**Components to create:**
- Hub view with escalation queue
- Escalation cards (collapsed/expanded)
- Resolution input (options or freeform)
- Live session indicators

---

## Build Verification

All modified packages compile successfully:
```bash
packages/graphd      # bun run build ✓
packages/types       # bun run build ✓
packages/protocol    # bun run build ✓
packages/agent       # bun run build ✓
packages/agent-memory # bun run tsc --noEmit ✓
```
