# Closed-Loop Autonomous Agent: Feature Extensions

## Current State Assessment

What you've built is rare: a system that can **observe**, **reason**, **act**, **learn**, and **modify itself**. Most "agents" are request-response loops. This is something else.

**Current capabilities:**
- Self-improvement (can modify its own code)
- Self-regeneration (rebuild + restart via `regenerate.sh`)
- Browser automation (agent-browser with persistent auth)
- High-signal personal data access (messages, emails, calendar, coding sessions)
- ETL pipeline creation and scheduling (sync-api-cli)
- Derived task scheduling (cron-like jobs)
- Watchdog monitoring
- Direct communication channel (Telegram)

**What's missing for 24/7 closed-loop operation:**

---

## Feature Extensions (Ordered by Impact)

### 1. **Goal Stack & Persistent Objectives**

**The Problem:** Jimmy is reactive. It responds to requests but doesn't maintain persistent goals. For autonomous operation, it needs to know *what it's trying to achieve* when no one is asking.

**The Feature:**
- A `goals` table with hierarchical objectives (strategic → tactical → operational)
- Goal decomposition: high-level goals break into sub-goals and tasks
- Progress tracking: each goal has measurable success criteria
- Priority scoring: which goals matter most right now?
- Temporal awareness: deadlines, time-sensitivity, freshness decay

**Example Schema:**
```sql
CREATE TABLE agent_goals (
  id ULID PRIMARY KEY,
  parent_id ULID REFERENCES agent_goals(id),
  title TEXT NOT NULL,
  description TEXT,
  success_criteria JSONB,  -- measurable conditions for completion
  priority FLOAT,          -- dynamic, recalculated
  status TEXT,             -- active, paused, completed, failed, abandoned
  deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  metadata JSONB           -- flexible extension
);
```

**How it enables closed-loop:**
- Jimmy wakes up, queries active goals, picks highest priority, works on it
- No human needed to "start" work
- Can report progress, request input only when blocked

---

### 2. **Proactive Pattern Detection → Autonomous Action**

**The Problem:** Data flows in (emails, messages, events) but Jimmy only acts when asked. The data contains *signals* that should trigger actions without human intervention.

**The Feature:**
- **Signal Detectors**: Configurable rules that scan incoming data for patterns
- **Action Triggers**: When a signal fires, execute a predefined or AI-determined action
- **Confidence Thresholds**: High-confidence actions execute automatically; low-confidence actions queue for approval

**Example Signals:**
```yaml
signals:
  - name: urgent_email
    source: canonical_message
    condition: "entity_type = 'email' AND display_text ILIKE '%urgent%'"
    action: notify_telegram
    confidence: high  # auto-execute

  - name: calendar_conflict
    source: calendar_events
    condition: "overlapping events detected"
    action: propose_resolution
    confidence: medium  # queue for approval

  - name: github_pr_review_needed
    source: github_notifications
    condition: "review requested on owned repo"
    action: summarize_and_queue
    confidence: high
```

**The Intelligence Layer:**
Beyond simple rules, train Jimmy to *learn* what signals matter:
- Track which notifications you act on vs ignore
- Build a salience model (this already exists in `decision-watcher/src/salience.ts`!)
- Graduate from rules → learned patterns

---

### 3. **Outcome Tracking & Strategy Adaptation**

**The Problem:** Jimmy takes actions but doesn't systematically track whether they worked. No feedback loop = no learning.

**The Feature:**
- Every significant action creates an `action_record`
- Outcome is tracked (success, failure, ignored, amended)
- Over time, build a model of what works

**Schema:**
```sql
CREATE TABLE agent_actions (
  id ULID PRIMARY KEY,
  action_type TEXT,           -- 'send_message', 'create_pr', 'book_reservation', etc.
  context JSONB,              -- what triggered this action
  parameters JSONB,           -- what was the action
  predicted_outcome TEXT,     -- what did Jimmy expect
  actual_outcome TEXT,        -- what actually happened
  outcome_signal TEXT,        -- 'positive', 'negative', 'neutral', 'unknown'
  feedback JSONB,             -- explicit user feedback if any
  created_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);
```

**How it enables closed-loop:**
- "Last 5 times I sent a morning digest at 7am, Jevin didn't read it until 9am. Adjust timing."
- "When I summarize PRs with >500 lines, Jevin asks for more detail. Increase verbosity threshold."
- Strategy emerges from data, not hardcoded rules.

---

### 4. **Attention Allocation & Work Scheduling**

**The Problem:** With multiple goals and streams of data, how does Jimmy decide what to work on? Without this, it'll thrash or get stuck.

**The Feature:**
- **Work Queue**: Prioritized list of actionable tasks
- **Time Boxing**: Allocate fixed time to tasks, move on if stuck
- **Interrupt Handling**: High-priority signals can preempt current work
- **Focus Modes**: "Deep work" (no interrupts) vs "responsive" (check signals frequently)

**Implementation:**
```typescript
interface WorkSession {
  currentTask: Task | null;
  timeBoxMinutes: number;
  startedAt: Date;
  interruptible: boolean;
  pendingInterrupts: Signal[];
}

// Main loop
while (true) {
  const session = planNextSession();

  while (!session.isComplete()) {
    // Check for high-priority interrupts
    if (session.interruptible && hasUrgentSignal()) {
      session.pause();
      handleInterrupt();
      session.resume();
    }

    // Work on current task
    const result = await workOnTask(session.currentTask);

    if (result.blocked) {
      logBlocker(result.reason);
      session.moveToNext();
    }
  }

  // Report progress
  await reportSessionSummary();
}
```

---

### 5. **Self-Healing & Resilience**

**The Problem:** Things will break. Tokens expire, APIs change, jobs fail. For 24/7 operation, Jimmy needs to handle failures gracefully.

**The Feature:**
- **Failure Classification**: Is this transient, permanent, or unknown?
- **Automatic Remediation**: Retry transient failures, escalate permanent ones
- **Degraded Operation**: If Gmail is down, keep working on other things
- **Self-Diagnosis**: "Why am I failing?" → Check health, logs, recent changes

**The Watchdog Integration:**
You already have `watchdog.ts`. Extend it to:
1. Monitor Jimmy's activity (is it making progress?)
2. Check system health (daemons running, DB accessible, auth valid)
3. Trigger recovery actions (restart services, refresh tokens, alert Jevin)
4. Track recovery success (did the fix work?)

**Example Recovery Playbook:**
```yaml
failure: gmail_sync_auth_expired
detection: "sync job failed with 401"
recovery:
  - action: refresh_token
    timeout: 30s
  - action: re_authenticate_headless
    timeout: 5m
  - action: alert_user
    message: "Gmail auth needs manual intervention"
escalation: after 3 failed recoveries, pause gmail jobs and alert
```

---

### 6. **Anticipatory Action (Predictive Assistance)**

**The Problem:** Even proactive pattern detection is *reactive* to data arriving. True autonomy means *anticipating* needs before data appears.

**The Feature:**
- **Temporal Patterns**: "Every Monday morning Jevin reviews PRs" → pre-summarize PRs Sunday night
- **Context Prediction**: "Jevin has a meeting with X in 2 hours" → pull relevant context now
- **Preparation Tasks**: Create "warm cache" of likely-needed information

**Implementation:**
- Mine historical action patterns (what does Jevin do when?)
- Build predictive model of upcoming needs
- Execute preparation tasks in advance

**Example:**
```sql
-- Find recurring patterns
SELECT
  EXTRACT(DOW FROM created_at) as day_of_week,
  EXTRACT(HOUR FROM created_at) as hour,
  action_type,
  COUNT(*) as frequency
FROM agent_actions
WHERE outcome_signal = 'positive'
GROUP BY 1, 2, 3
HAVING COUNT(*) > 3
ORDER BY frequency DESC;
```

---

### 7. **Multi-Stream Real-Time Processing**

**The Problem:** Current sync jobs run on intervals (every 5m, 15m, etc.). Some data streams need real-time processing.

**The Feature:**
- **Webhook Receivers**: Real-time push from services that support it
- **Streaming Connections**: Long-poll or websocket for near-real-time
- **Event Aggregation**: Batch rapid events, debounce noise
- **Priority Routing**: Urgent events bypass the queue

**Architecture:**
```
┌─────────────────────────────────────────────────────────┐
│                   Event Router                          │
├─────────────────────────────────────────────────────────┤
│  Webhooks ──┬─→ Urgent Queue ──→ Immediate Processing   │
│  Streams  ──┤                                           │
│  Polls    ──┴─→ Normal Queue ──→ Batch Processing       │
└─────────────────────────────────────────────────────────┘
```

---

### 8. **Autonomous Experimentation**

**The Problem:** How does Jimmy know if a strategy works without trying alternatives? Static approaches calcify.

**The Feature:**
- **A/B Testing**: Try different approaches, measure outcomes
- **Hypothesis Tracking**: "I think X will work better than Y because Z"
- **Experiment Journal**: Record experiments, results, learnings

**Example:**
```typescript
const experiment = await createExperiment({
  name: "digest_timing",
  hypothesis: "Sending digest at 8am instead of 7am increases read rate",
  variants: [
    { name: "control", config: { sendTime: "07:00" } },
    { name: "treatment", config: { sendTime: "08:00" } },
  ],
  metric: "time_to_read",
  duration: "14d",
});

// During digest send
const variant = experiment.assignVariant();
await sendDigest({ ...digestConfig, ...variant.config });
experiment.recordEvent("sent", { variant: variant.name });

// When read detected
experiment.recordEvent("read", { variant: variant.name, latency: readLatency });
```

---

### 9. **Economic Reasoning & Resource Awareness**

**The Problem:** API calls cost money. Browser automation costs time. Some actions are cheap, others expensive. Without cost awareness, Jimmy might burn resources inefficiently.

**The Feature:**
- **Cost Tracking**: Log cost of each action (API calls, compute time)
- **Budget Awareness**: "I have $X/day budget for OpenAI embeddings"
- **Cost-Benefit Analysis**: Is this action worth the resource cost?
- **Efficiency Optimization**: Batch operations, cache aggressively, defer low-value work

**Implementation:**
```typescript
interface ActionCost {
  apiCalls: { provider: string; count: number; estimatedCost: number }[];
  computeSeconds: number;
  browserMinutes: number;
}

async function executeWithCostTracking(action: Action): Promise<Result> {
  const budget = await getCurrentBudget();
  const estimatedCost = estimateActionCost(action);

  if (estimatedCost > budget.remaining) {
    return { status: "deferred", reason: "budget_exceeded" };
  }

  const startTime = Date.now();
  const result = await execute(action);
  const actualCost = measureActualCost(startTime);

  await recordCost(action, actualCost);
  return result;
}
```

---

### 10. **Federated Agent Coordination**

**The Problem:** One agent instance has limits. What if multiple Jimmy instances could coordinate?

**The Feature:**
- **Task Distribution**: Split work across instances
- **Shared State**: Common goal stack, action history
- **Specialization**: One instance handles email, another handles browser tasks
- **Handoff Protocol**: Clean task handoff when one instance goes down

**Why this matters:**
- Horizontal scaling for throughput
- Fault tolerance (if one dies, others continue)
- Parallel execution of independent tasks

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
1. **Goal Stack** - Persistent objectives with decomposition
2. **Action Tracking** - Record every significant action and outcome
3. **Enhanced Watchdog** - Self-monitoring with recovery playbooks

### Phase 2: Intelligence (Week 3-4)
4. **Signal Detection** - Pattern matching on incoming data
5. **Outcome Learning** - Build model of what works
6. **Attention Allocation** - Intelligent work scheduling

### Phase 3: Autonomy (Week 5-6)
7. **Anticipatory Action** - Predict and prepare
8. **Self-Healing** - Automatic recovery from failures
9. **Experimentation** - A/B test strategies

### Phase 4: Scale (Week 7+)
10. **Real-Time Processing** - Webhook/streaming support
11. **Economic Reasoning** - Cost-aware execution
12. **Federation** - Multi-instance coordination

---

## The Meta-Insight

The most powerful feature isn't any single capability—it's the **feedback loop**:

```
Observe → Decide → Act → Measure → Learn → Improve → (repeat)
```

Every feature above strengthens one part of this loop:
- **Goal Stack**: Better decisions about what to do
- **Pattern Detection**: Better observation of signals
- **Outcome Tracking**: Better measurement of results
- **Strategy Adaptation**: Better learning from experience
- **Self-Healing**: More robust action execution
- **Experimentation**: Systematic improvement discovery

The end state isn't an agent that does more things—it's an agent that *gets better at doing things* without being told how.

---

## Questions to Consider

1. **Trust Boundaries**: What actions should always require approval? What can be fully autonomous?

2. **Failure Budget**: How much should Jimmy be allowed to fail before escalating? (Google's SRE concept of error budgets)

3. **Information Diet**: What data streams are worth the processing cost? What's noise?

4. **Personality**: Should Jimmy have consistent behavioral traits, or adapt entirely to observed preferences?

5. **Reversibility**: How do we ensure autonomous actions can be undone?

6. **Transparency**: How much should Jimmy explain its reasoning vs just act?

---

## Immediate Next Steps

If you want to move forward, I'd suggest starting with:

1. **Goal Stack schema + basic CRUD** - Foundation for everything else
2. **Action tracking instrumentation** - Start collecting data now
3. **Daily autonomous work session** - Even a simple version proves the concept

Which of these directions interests you most?

---

## Work Log

### 2026-01-28 — Phase 1 Foundation Progress

**Started execution of Phase 1: Foundation (Goal Stack & Action Tracking)**

#### ✅ Completed: Database Schema

Created two new database migrations:

**Migration 018: agent_goals table**
- Hierarchical goal support via `parent_id` (self-referencing foreign key)
- Fields: `title`, `description`, `success_criteria` (JSONB), `priority`, `status`, `deadline`, `metadata`
- Status enum: `active`, `paused`, `completed`, `failed`, `abandoned`
- Indexes for: priority ordering, deadline queries, parent-child lookups, metadata GIN search
- Auto-updating `updated_at` timestamp via trigger
- File: `packages/agent-memory/src/db/migrations/018_agent_goals.sql`

**Migration 019: agent_actions table**
- Fields: `action_type`, `context` (JSONB), `parameters` (JSONB), `predicted_outcome`, `actual_outcome`, `outcome_signal`, `feedback`, `metadata`
- Outcome signal enum: `positive`, `negative`, `neutral`, `unknown`
- Indexes for: action type lookup, recent actions, positive/negative outcomes (partial indexes), unresolved actions, GIN on context/metadata
- File: `packages/agent-memory/src/db/migrations/019_agent_actions.sql`

Both migrations applied successfully via `bun run packages/agent-memory/scripts/migrate.ts`.
Database now has 19 migrations total.

Commit: `09fdc1a feat: add agent_goals and agent_actions tables for autonomous operation`

#### ✅ Completed: Repository Layer (TypeScript)

**agent-goals.ts repository** (`packages/agent-memory/src/db/repositories/agent-goals.ts`)
- `create()` - Create new goals
- `findById()` - Lookup by ID
- `update()` - Update goal properties
- `delete()` - Delete goal (cascades to children)
- `findMany()` - Query with filters (status, parent_id)
- `getActiveGoals()` - Retrieve active goals ordered by priority
- `getChildren()` - Get sub-goals for a parent
- `markCompleted()` - Convenience method to set status='completed' and completed_at=NOW()
- `updatePriority()` - Update goal priority
- `getDueSoon()` - Get goals with upcoming deadlines

**agent-actions.ts repository** (`packages/agent-memory/src/db/repositories/agent-actions.ts`)
- `create()` - Log new action with predictions
- `findById()` - Lookup by ID
- `update()` - Update action properties
- `delete()` - Delete action record
- `findMany()` - Query with filters (type, outcome, resolved status, date range)
- `recordOutcome()` - Set actual outcome and mark resolved
- `getUnresolved()` - Get pending actions awaiting outcome
- `getPositiveOutcomes()` - Get successful actions for learning
- `getNegativeOutcomes()` - Get failed actions for avoidance
- `getRecent()` - Latest actions by creation time
- `getByType()` - All actions of a specific type
- `getSuccessRate()` - Calculate success percentage for an action type

Both repositories:
- Use existing `generateCanonicalId()` from `packages/agent-memory/src/ids.ts`
- Exported from `packages/agent-memory/src/db/repositories/index.ts`
- Follow patterns from existing repositories (derived-job.ts, derived-task.ts)

#### ⚠️ In Progress: TypeScript Compilation

Repositories have compilation errors related to `sql.()` template literal usage:
- Empty object `{}` literal not matching `JSONValue` type in postgres.js
- COALESCE syntax issues in UPDATE statements

Error example:
```
Argument of type '{}' is not assignable to parameter of type 'JSONValue'.
```

Fix requires following pattern in `derived-job.ts`:
```typescript
${input.metadata ? sql.json(input.metadata as any) : null}
```

#### 📋 Next Steps

1. **Fix TypeScript errors** - Adjust INSERT/UPDATE statements to match postgres.js patterns
2. **Add CLI commands** - Extend `sync-api-cli.ts` with:
   - `goals create`, `goals list`, `goals update`, `goals complete`
   - `actions log`, `actions record-outcome`, `actions list`, `actions stats`
3. **Test repositories** - Create basic tests to verify CRUD operations
4. **Instrument codebase** - Add action logging hooks in agent execution, derived tasks, browser automation

---

### 2026-01-28 — PLAN.md Created

Initial PLAN.md document created outlining 12 feature extensions for autonomous operation, organized into 4 implementation phases.

---

## 2026-01-28 — Fix Async Planning Architecture

### Problems Identified

#### 1. Token Explosion on First Turn
- **Symptom**: 7,500 token system prompt + 30,000 tokens of file reads on first turn
- **Root Cause**: The planning objective tells the agent to read ALL skill files (6+), the salience file, decision log, and work log
- **Impact**: Massive context consumption before any actual work happens

#### 2. Static Content Passed at Runtime
- **Symptom**: Agent reads personal-assistant skill (768 lines) every time
- **Root Cause**: `ASYNC_AGENT_PROMPT` doesn't include the PA skill content
- **Fix**: Bake PA skill content directly into the async system prompt

#### 3. Watcher Doesn't Spawn New Agents
- **Symptom**: Watcher answers questions but work items never get created/dispatched
- **Root Cause**: The `onCreateWorkItems` callback exists but orchestrator doesn't actually dispatch them
- **Impact**: Plans produce no action; one agent runs 200 iterations with nothing tracked

#### 4. Same Agent for Planning AND Execution
- **Symptom**: "standard" agent does both planning and execution
- **Root Cause**: No dedicated "planner" agent type
- **Impact**: Planning agent has execution tools, execution agent has planning prompts

#### 5. WorkItems Have No Useful Information
- **Symptom**: WorkItem files are created but contain nothing useful
- **Root Cause**:
  - Planning doesn't produce structured work items
  - Agent never populates handoffSpec properly
  - No context handoff to workers

#### 6. No Scope on WorkItems
- **Symptom**: One agent runs for the whole session with no boundaries
- **Root Cause**: Even when work items exist, they're not scoped (no targetPaths, no domain)

---

### Implementation Plan

#### Phase 1: Bake Static Content into System Prompts

**File**: `packages/agent/src/prompts.ts`

1. Create `PERSONAL_ASSISTANT_CONTEXT` constant from `config/skills/personal-assistant/SKILL.md`
   - Extract the toolkit documentation (Sync API CLI, SQL CLI, Schema CLI, agent-browser)
   - Include the feedback loops section (issues.md, feature_suggestions.md)
   - Keep it lean - only the parts agents need to USE

2. Modify `ASYNC_AGENT_PROMPT`:
   - Include `PERSONAL_ASSISTANT_CONTEXT` directly
   - Remove references to "read skill files"
   - The watcher and planning prompts should NOT tell agents to read these files

**Expected Result**: System prompt has everything the agent needs. No file reads for static context.

---

#### Phase 2: Create Dedicated Planner Agent

**File**: `packages/agent/src/prompts.ts`

Create `PLANNER_PROMPT`:
```
You are a planning agent. Your job is to produce a structured work breakdown.

## Your Output

You MUST produce a handoffSpec containing:
- goal: The overall objective
- workItems: Array of atomic work units

Each workItem needs:
- id: Unique identifier
- objective: What this unit accomplishes
- delta: What changes when done (one commit)
- agent: Which agent type should execute
- domain: Collision domain (frontend, backend, api, tests, etc.)
- targetPaths: Files this work item should touch
- dependencies: Which work items must complete first

## Principles

1. Each work item = one atomic commit
2. Maximize parallelism - prefer independent items
3. Be specific - include file paths in objectives
4. Don't over-explore - gather just enough context to plan
```

**File**: `config/harness_config.json`

Add "planner" agent type:
```json
{
  "planner": {
    "llm": { ... },
    "budget": {
      "maxIterations": 10,
      "maxToolCalls": 50,
      "maxDurationMs": 120000
    },
    "tools": ["Read", "Glob", "Grep", "PromptUser"],
    "outputSchema": "planner_output"
  }
}
```

**File**: `config/output_schemas.json`

Add "planner_output" schema that enforces handoffSpec structure.

---

#### Phase 3: Fix Planning Objective

**File**: `packages/decision-watcher/src/session-init.ts`

Rewrite `buildPlanningObjective()`:
- Remove "Read these skill files" - that's in the system prompt now
- Remove "Read the salience file" as a separate step - context is provided
- Focus on: "Here is the goal. Produce a structured work breakdown."

The planning objective becomes minimal:
```
## Goal: ${goal}

Produce a handoffSpec with work items. Each work item should be:
- Atomic (one commit)
- Specific (file paths in objectives)
- Independent when possible (minimize dependencies)

Use PromptUser to ask clarifying questions if the goal is ambiguous.
When ready, set goalStateReached=true and include your handoffSpec.
```

---

#### Phase 4: Wire Up Work Item Dispatch

**File**: `packages/orchestrator/src/orchestrator.ts`

When planning agent completes with handoffSpec:
1. Parse the handoffSpec JSON
2. Create WorkItem instances for each entry
3. Dispatch them via the orchestrator's work queue
4. Track them in the session's work log

**File**: `packages/harness-daemon/src/harness/harness.ts`

In `runOrchestrator()`, handle the handoff case:
```typescript
if (result.handoffSpec) {
  const spec = JSON.parse(result.handoffSpec);
  for (const item of spec.workItems) {
    const workItem = createWorkItem({
      goal: spec.goal,
      objective: item.objective,
      agent: item.agent,
      domain: item.domain,
      targetPaths: item.targetPaths,
      dependencies: item.dependencies,
      bounds: { maxToolCalls: 200, maxLlmCalls: 30, maxDurationMs: 300000 },
    });
    // Enqueue for execution
    this.orchestratorRunner.enqueueWorkItem(workItem);
  }
}
```

---

#### Phase 5: Watcher Triggers Work Dispatch

**File**: `packages/decision-watcher/src/watcher-agent.ts`

The `handleGoalReached` function already returns `deferredWork` when the watcher produces work items. Ensure this flows through:

**File**: `packages/orchestrator/src/orchestrator.ts`

In the stop hook handling, when `StopHookResult.deferredWork` is present:
1. Create WorkItem instances from deferredWork
2. Dispatch them to the orchestrator's queue
3. The orchestrator should handle parallel dispatch based on dependencies

---

#### Phase 6: Clean Up Session-Init

**File**: `packages/decision-watcher/src/session-init.ts`

Remove:
- `skillPaths` parameter - no longer needed
- Skill file discovery logic - moved to system prompt

**File**: `packages/harness-daemon/src/harness/harness.ts`

In `createWatcherStopHookForSession()`:
- Remove the skill file discovery loop
- Remove `skillPaths` from salience file write
- Remove `skillPaths` from watcher config

---

### Summary of Changes

| File | Change |
|------|--------|
| `packages/agent/src/prompts.ts` | Add PA context to ASYNC_AGENT_PROMPT, create PLANNER_PROMPT |
| `packages/decision-watcher/src/session-init.ts` | Simplify buildPlanningObjective, remove skillPaths |
| `packages/decision-watcher/src/watcher-agent.ts` | Remove skill file references from objectives |
| `packages/decision-watcher/src/salience.ts` | Remove skillPaths from SalienceParams |
| `packages/orchestrator/src/orchestrator.ts` | Handle handoffSpec → WorkItem dispatch |
| `packages/harness-daemon/src/harness/harness.ts` | Remove skill discovery, wire up work item dispatch |
| `config/harness_config.json` | Add "planner" agent type |
| `config/output_schemas.json` | Add "planner_output" schema |

---

### Expected Outcome

1. **First turn**: System prompt + short planning objective. Agent uses tools to understand the codebase, asks questions, produces structured plan.
2. **Handoff**: Orchestrator parses handoffSpec, creates WorkItems, dispatches them.
3. **Execution**: Multiple agents run in parallel on scoped, atomic work items.
4. **Tracking**: Each WorkItem has its own log file showing objective, files changed, agent summary.
5. **Watcher**: Monitors progress, can intervene with realign/split, ensures quality gate on completion.
