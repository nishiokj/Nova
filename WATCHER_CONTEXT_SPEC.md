# Watcher Context & Semantic Memory Specification

## Overview

The Watcher is a manager-agent responsible for overseeing worker agents, making architectural judgments, answering taste/preference questions, creating sub-workItems, and deciding when to continue, realign, or escalate.

**Problem**: The current workItem log provides event-level data (tool calls, timestamps, success/failure) but lacks the semantic understanding a manager needs: *where are we, what changed, why, what's the gap to objective, what are the trade-offs*.

**Solution**: Introduce a hierarchical context system with:
1. **Salience.md** - Session-level memory with workItem index and cross-cutting patterns
2. **Semantic workItem files** - High-signal, human-readable state per workItem
3. **Log files** - Immutable system of record (unchanged from current)

The Watcher's cadence audit generates the semantic layer as a non-blocking operation, amortizing context-loading cost across both the decision and the summary.

---

## Goals

1. Enable the Watcher to answer:
   - Where are we now? What has changed? Why?
   - What's the gap between current state and objective?
   - What context surrounds this preference question? What are the trade-offs?

2. Reduce hot-path LLM calls by:
   - Providing workers with semantic context after realign (no re-exploration)
   - Pre-articulating trade-offs for faster escalation resolution
   - Exposing sibling workItem context to avoid duplicate work

3. Maintain auditability:
   - Log files remain immutable system of record
   - Semantic file versions recoverable for learning/training
   - Git-diffable for understanding evolution

---

## File Structure

```
.watcher/
└── {date}/
    └── {session_id}/
        ├── salience.md                    # Session-level memory
        ├── decisions.json                 # Decision log (existing)
        ├── workItems/
        │   ├── {workId}/
        │   │   ├── semantic.md            # Current semantic state
        │   │   ├── semantic_v001.md       # Snapshot after audit 1
        │   │   ├── semantic_v002.md       # Snapshot after audit 2
        │   │   ├── semantic_v003.md       # Snapshot after audit 3
        │   │   └── log.json               # Immutable event log
        │   └── {workId2}/
        │       └── ...
        └── observability/
            └── semantic_snapshots/        # Archived for training
                ├── {workId}_v001.md
                ├── {workId}_v002.md
                └── ...
```

### Versioning Strategy

- **semantic.md**: Always the current version, overwritten each audit
- **semantic_v{NNN}.md**: Snapshot created before overwrite (NNN = audit sequence number)
- **observability/semantic_snapshots/**: Periodic archive of snapshots for training/learning (can be pruned separately from active workItems)

Git diffing between versions remains useful for understanding evolution. The snapshot files ensure recoverability independent of git.

---

## Salience.md Format (Session-Level Memory)

```markdown
# Session: {session_id}

Started: {ISO timestamp}
Agent: {agent type}
CWD: {working directory}

## Active WorkItems

| ID | Objective | Status | Last Audit |
|----|-----------|--------|------------|
| {workId1} | {truncated objective} | in_progress | {timestamp} |
| {workId2} | {truncated objective} | blocked | {timestamp} |

## Session Patterns

<!-- Cross-cutting observations that apply to multiple workItems -->

- Edit tool experiencing whitespace sensitivity issues on store.ts
- Tree-sitter integration available via entity-graph package
- TUI render pipeline: message → store.splitMarkdownIntoLines → renderLineToWidth → StyledLine

## Key Abstractions in Play

- HistoryLine: Represents a single rendered line in the TUI
- TextSegment: Inline formatting segments (bold, italic, code)
- renderLineToWidth: Normalizes lines to terminal width

## Cross-References

- Preferences: pref:tui-conventions, pref:code-hygiene
- Related sessions: {list if applicable}
```

### Update Triggers

Salience.md is updated:
1. On session init (from init event)
2. On each workItem creation (add to table)
3. On each cadence audit (update status, refresh patterns)
4. On workItem completion (mark status)

---

## Semantic WorkItem File Format

```markdown
# {workId}: {objective}

## Meta

Created: {ISO timestamp}
Last Audit: {ISO timestamp}
Audit Sequence: {N}
Log Position: event {X} of {Y}

---

## 1. State & Progress

### Objective

{Full objective text from init event}

### Current State

| Component | Status | Location |
|-----------|--------|----------|
| {component 1} | ✓ complete | {file:line or description} |
| {component 2} | ⚠ partial | {file:line or description} |
| {component 3} | ✗ not started | - |

### Changes Made

| File | Change Summary | Rationale |
|------|----------------|-----------|
| {path} | {what changed} | {why} |

### Diffs

<details>
<summary>{file path} @ event {N}</summary>

```diff
{unified diff}
```

</details>

<!-- Repeat for each modified file -->

### Gap Analysis

| Required (from objective) | Current State | Blocker |
|---------------------------|---------------|---------|
| {requirement 1} | {status} | {blocker or "None"} |
| {requirement 2} | {status} | {blocker or "None"} |

### Reasoning Trace

1. {Step 1: what agent discovered/decided}
2. {Step 2: what agent discovered/decided}
3. {Step 3: what agent discovered/decided}
...

### Blockers

- {Blocker 1}: {description, e.g., "Edit tool failing on store.ts - old_string not found (3 attempts)"}
- {Blocker 2}: {description}

---

## 2. Decision Context

### Pending Questions

<!-- Questions escalated to user/watcher, awaiting response -->

{None | List of pending questions}

### Trade-off Analysis

<!-- Pre-articulated trade-offs for likely decision points -->

#### {Trade-off 1 Title}

**Options:**
- **A: {option}** - {description}
- **B: {option}** - {description}

**Considerations:**
- Relevant preference: [{pref key}] "{preference text}"
- Session pattern: {relevant pattern from salience.md}
- Precedent: workItem/{sibling_id} chose {option} because {reason}

**Watcher Assessment:** {Watcher's lean, if any, with rationale}

---

## 3. Cross-References

- Session: salience.md#{relevant_section}
- Preferences: {list of relevant preference keys}
- Sibling WorkItems: {list of related workItem IDs with brief description}
- Decisions Index: {relevant decision keys}
```

---

## Log File Format (System of Record)

The log file (`log.json`) remains the immutable event stream. Format unchanged from current implementation:

```json
{"type":"init","timestamp":"...","workId":"...","objective":"...","agent":"...","dependencies":[],"targetPaths":[]}
{"type":"decision","timestamp":"...","trigger":"cadence_audit","action":"continue","rationale":"..."}
{"type":"tool_call","timestamp":"...","tool":"Edit","args":{...},"success":true,"resultSummary":"...","durationMs":N}
{"type":"message","timestamp":"...","role":"assistant","content":"..."}
{"type":"status","timestamp":"...","status":"in_progress|completed|failed"}
```

### Required Change: Full Diff Capture

Currently, Edit tool args may be truncated in the log. For semantic file generation, we need full diffs.

**Option A**: Store full old_string/new_string in log (increases log size)

**Option B**: Store diffs in separate file, reference from log:
```json
{"type":"tool_call","tool":"Edit","diffRef":"diffs/{eventId}.diff",...}
```

**Recommendation**: Option B - keeps log lightweight, diffs available when needed.

Diff storage location:
```
.watcher/{date}/{session_id}/workItems/{workId}/diffs/
├── event_023.diff
├── event_031.diff
└── event_045.diff
```

---

## Audit Process

### Current State

- Trigger: Every 60 seconds (cadence audit)
- Implementation: Synchronous hook via `runHooksForEvent` in orchestrator
- Hook returns: `HookOutcome<Decision>` with `decision` + optional `patches`
- Problem: Watcher frequently times out (60s hook timeout), returns nothing, worker continues without oversight

### Architectural Constraint

The hook system (`packages/orchestrator/src/hookRunner/runHooksForEvent.ts`) is designed for **synchronous decision-making**:

```typescript
// Hook returns decision that orchestrator acts on immediately
type HookOutcome<D> =
  | { kind: 'success'; decision: D; patches?: StatePatch[] }
  | { kind: 'skip' }
  | { kind: 'timeout' }
  | { kind: 'failed'; error: string }
  // ...
```

The orchestrator needs the decision (continue/realign/escalate) to proceed. We cannot make the decision-producing hook fire-and-forget because the orchestrator would have no decision to act on.

### Proposed Architecture: Extend Existing Watcher

The watcher agent already exists and makes LLM-based decisions. We extend it to also produce semantic file content.

#### Single Watcher Call, Two Outputs

The existing watcher hook remains the decision mechanism. We add semantic file generation as an additional output:

```typescript
// Existing watcher hook - modified to also output semantic content
const watcherAuditHook: Hook<CadenceAuditEvent, AuditDecision> = {
  id: 'watcher-audit',
  source: 'watcher',
  priority: 10,
  criticality: 'critical',
  idempotency: 'idempotent',
  timeoutMs: 60_000, // Existing 60s timeout
  policy: { kind: 'retry_then_degrade', maxRetries: 1, degradeTo: 'continue' },

  async run(event, ctx): Promise<HookOutcome<AuditDecision>> {
    const watcher = await createWatcherAgent();

    // Load context (existing)
    const log = await readLog(event.logPath);
    const salience = await readSalience();
    const currentSemantic = await readSemanticFile(event.workId);
    const preferences = await queryPreferences(extractTopics(log));
    const siblingContext = await loadSiblingWorkItems(event.workId);

    // Single LLM call produces BOTH decision AND semantic content
    const result = await watcher.run({
      task: 'audit_and_generate',
      inputs: { log, salience, currentSemantic, preferences, siblingContext },
    });

    // Write semantic file (fire and forget - don't block decision return)
    writeSemanticFileAsync(event.workId, result.semantic, result.auditSequence);

    return success({
      action: result.decision.action,
      rationale: result.decision.rationale,
      subWorkItems: result.decision.subWorkItems,
    });
  }
};
```

#### Semantic File Write (Non-Blocking)

The semantic file write happens after the decision is determined but doesn't block the hook return:

```typescript
function writeSemanticFileAsync(
  workId: string,
  semantic: SemanticContent,
  auditSequence: number
): void {
  // Fire and forget - don't await
  setImmediate(async () => {
    try {
      await writeSemanticFile(workId, semantic, auditSequence);
      await updateSalience(workId, semantic.salienceUpdates);
    } catch (err) {
      // Write error to the semantic file itself
      await writeSemanticError(workId, auditSequence, err);
    }
  });
}

async function writeSemanticError(
  workId: string,
  auditSequence: number,
  error: unknown
): Promise<void> {
  const dir = `workItems/${workId}`;
  const semanticPath = `${dir}/semantic.md`;

  const errorContent = `# ${workId}: GENERATION FAILED

## Error

Audit sequence: ${auditSequence}
Timestamp: ${new Date().toISOString()}

\`\`\`
${error instanceof Error ? error.stack : String(error)}
\`\`\`

## Previous State

See semantic_v${(auditSequence - 1).toString().padStart(3, '0')}.md for last successful generation.
`;

  await writeFile(semanticPath, errorContent);
}
```

#### Timeout Handling

When the watcher times out:
1. Hook returns with `degradeTo: 'continue'` - worker proceeds
2. No semantic file update (timeout occurred before LLM returned)
3. Previous semantic file remains valid
4. Next audit cycle will attempt again

### Concurrent WorkItems

When multiple workItems are active in a session:

1. Single watcher call per cadence interval receives context for ALL active workItems
2. Watcher produces decision + semantic content for each workItem
3. Semantic file writes happen sequentially (not parallel) to avoid file system races

```typescript
// Watcher output includes semantic content for each active workItem
interface WatcherOutput {
  decisions: Array<{
    workId: string;
    action: 'continue' | 'realign' | 'escalate';
    rationale: string;
  }>;
  semantics: Array<{
    workId: string;
    content: SemanticContent;
    auditSequence: number;
  }>;
  salienceUpdates: SalienceUpdates;
}

// After watcher returns, write files sequentially
async function processWatcherOutput(output: WatcherOutput): Promise<void> {
  for (const semantic of output.semantics) {
    await writeSemanticFile(semantic.workId, semantic.content, semantic.auditSequence);
  }
  await updateSalience(output.salienceUpdates);
}
```

### Write Mutex

Prevent overlapping writes if cadence interval fires while previous write is still in progress:

```typescript
const writeLocks = new Map<string, Promise<void>>();

async function writeSemanticFileWithLock(
  workId: string,
  content: SemanticContent,
  auditSequence: number
): Promise<void> {
  // Wait for any in-progress write to complete
  const existing = writeLocks.get(workId);
  if (existing) {
    await existing;
  }

  const writePromise = writeSemanticFile(workId, content, auditSequence);
  writeLocks.set(workId, writePromise);

  try {
    await writePromise;
  } finally {
    writeLocks.delete(workId);
  }
}
```

### Output Schema

The semantic generation produces:

```typescript
interface SemanticGenerationResult {
  // Semantic file content
  semantic: {
    meta: { auditSequence: number; logPosition: number; totalEvents: number };
    stateAndProgress: {
      currentState: ComponentStatus[];
      changesMade: ChangeEntry[];
      gapAnalysis: GapEntry[];
      reasoningTrace: string[];
      blockers: string[];
    };
    decisionContext: {
      pendingQuestions: string[];
      tradeoffs: TradeoffAnalysis[];
    };
    crossReferences: {
      preferences: string[];
      siblingWorkItems: string[];
      decisions: string[];
    };
  };

  // Salience updates
  salienceUpdates: {
    workItemStatus: string;
    patterns?: string[]; // New cross-cutting patterns observed
    abstractionsInPlay?: string[]; // Key abstractions discovered
  };
}
```

### Versioning on Write

Before overwriting `semantic.md`, snapshot the current version:

```typescript
async function writeSemanticFile(
  workId: string,
  content: SemanticContent,
  auditSequence: number
): Promise<void> {
  const dir = `workItems/${workId}`;
  const semanticPath = `${dir}/semantic.md`;
  const snapshotPath = `${dir}/semantic_v${auditSequence.toString().padStart(3, '0')}.md`;

  // Snapshot current version (if exists)
  if (await fileExists(semanticPath)) {
    await copyFile(semanticPath, snapshotPath);
  }

  // Write new version
  const markdown = renderSemanticMarkdown(content);
  await writeFile(semanticPath, markdown);
}
```

---

## Derivation: Automatic vs. LLM

The semantic file combines deterministically-derived facts with LLM-generated semantic understanding.

### Deterministically Derived (No LLM)

| Field | Source |
|-------|--------|
| Meta.created | init event timestamp |
| Meta.logPosition | Count of events in log |
| Objective | init event objective field |
| Files touched | Edit/Read tool call paths |
| Diffs | Stored diff files |
| Success/failure per operation | Tool call success field |
| Blockers (mechanical) | Repeated failures on same target |
| Timeline | Event timestamps |

### LLM-Generated (During Audit)

| Field | Why LLM Needed |
|-------|----------------|
| Current State (semantic) | Interpret what components exist and their completeness |
| Changes Made - Rationale | Explain *why* changes were made |
| Gap Analysis | Compare objective to current state |
| Reasoning Trace | Condense agent's decision-making from messages |
| Trade-off Analysis | Articulate options and considerations |
| Cross-references | Identify relevant preferences/siblings |
| Salience patterns | Recognize cross-cutting observations |

### Pre-processing for Watcher

Before the Watcher LLM call, a pre-processor extracts deterministic fields:

```typescript
interface PreProcessedContext {
  // Deterministic
  objective: string;
  filesTouched: string[];
  diffs: { path: string; content: string }[];
  toolCallSummary: { tool: string; target: string; success: boolean }[];
  failurePatterns: { target: string; failures: number; lastError: string }[];
  timeline: { event: string; timestamp: string }[];

  // Raw for LLM interpretation
  messageContents: string[]; // Non-empty assistant messages
  lastNToolCalls: ToolCallEvent[]; // Recent activity
}
```

This reduces the Watcher's job to semantic interpretation, not data extraction.

---

## Context Injection for Worker

After a realign or at session start, the worker receives:

1. **salience.md** - Session-level context
2. **semantic.md** for current workItem - Where we are, what's been tried
3. **Relevant preferences** - Via memory injector

This eliminates re-exploration. The worker reads the semantic file and knows:
- What's done
- What's blocked
- What's been tried and failed
- What the current hypothesis is

---

## Hot-Path Reduction Justification

### Cost: Audit LLM Call

- Frequency: Every 60 seconds (existing)
- Additional work: Generate semantic file (within same context window)
- Marginal cost: Low - context already loaded for decision

### Savings: Worker Tool Calls

| Scenario | Without Semantic | With Semantic | Savings |
|----------|------------------|---------------|---------|
| Post-realign orientation | 10-15 exploratory reads/greps | 0-2 targeted reads | 8-13 calls |
| Escalation context assembly | 5-10 reads to understand state | 0 (pre-computed) | 5-10 calls |
| Sibling workItem lookup | 3-5 reads per sibling | 0 (in cross-references) | 3-5 calls |

### Savings: LLM Turns

| Scenario | Without Semantic | With Semantic | Savings |
|----------|------------------|---------------|---------|
| Worker re-deriving context | 2-3 turns of exploration | 0 | 2-3 turns |
| Escalation back-and-forth | Multiple turns clarifying | 1 turn (trade-offs pre-articulated) | 1-2 turns |

### Break-Even Analysis

If one audit call (marginal cost ~0.5 LLM turns worth) saves 2+ worker LLM turns or 10+ tool calls over the next audit interval, the system is net positive.

Given observed post-realign exploration patterns (10+ tool calls to re-orient), this is likely to pay off within the first realign cycle.

---

## Integration Points

### 1. Audit Hook (Orchestrator/Agent)

**Current**: Synchronous hook triggers audit, blocks until complete.

**Change**: Make async. Fire audit, don't await.

**Location**: Likely `packages/orchestrator/src/hooks.ts` or `packages/decision-watcher/src/watcher-agent.ts`

### 2. WorkItem Creation Hook

**Current**: Creates workItem ID, initializes log.

**Change**: Also initialize empty semantic.md with objective and meta.

**Location**: Orchestrator workItem creation logic.

### 3. Watcher Agent

**Current**: Receives log, makes decision.

**Change**: Also receives pre-processed context, outputs semantic file content.

**Location**: `packages/decision-watcher/src/watcher-agent.ts`

### 4. Memory Injector

**Current**: Injects preferences/context into agents.

**Change**: Also inject salience.md and current workItem's semantic.md.

**Location**: `packages/memory-injector/src/injector.ts`

### 5. Diff Storage

**New**: Edit tool calls store full diffs to separate files.

**Location**: Log writer or tool execution layer.

---

## Watcher Prompt Additions

The Watcher has two distinct modes, each with different prompts:

### Prompt: Semantic Generation Task

Used when `task: 'generate_semantic'` - the async background generation:

```markdown
## Semantic File Generation

Generate a semantic summary of the workItem state. This file will be read by:
1. Future audit passes (to understand cumulative progress)
2. The worker agent after realignment (to avoid re-exploration)
3. Humans auditing the session

Your output must include:

### 1. State & Progress

- **Current State**: What components exist? What's their completion status? Be specific about file locations.
- **Changes Made**: What files were modified and why? Include rationale, not just file paths.
- **Gap Analysis**: What's required (from objective) vs. what exists? What's the delta?
- **Reasoning Trace**: Condense the agent's decision-making into numbered steps. Follow the logic.
- **Blockers**: What's preventing progress? Be specific (e.g., "Edit tool failing on store.ts - whitespace mismatch").

### 2. Decision Context

- **Pending Questions**: What's awaiting user/watcher response?
- **Trade-off Analysis**: For any architectural decisions the agent is facing or has made:
  - Articulate the options
  - List considerations (performance, maintainability, precedent)
  - Reference relevant preferences - but consider whether each preference is actually generalizable to this context
  - Reference sibling workItems if they set precedent
  - State your assessment of the best path

### 3. Cross-References

- Which preferences are relevant? (Search retrieval will provide candidates - evaluate their applicability)
- Which sibling workItems provide precedent? (Session salience.md lists them with descriptions)
- Which past decisions apply?

Be concise but complete. Avoid filler. Every line should be informative.
```

### Combined Prompt: Audit and Generate

The watcher receives a single task that produces both decision and semantic content:

```markdown
## Audit and Generate Semantic

You are the Watcher. Analyze the workItem state and produce two outputs:

### Output 1: Decision

Based on the log and current state, decide: **continue**, **realign**, or **escalate**.

- **Continue**: Agent is making progress, no intervention needed.
- **Realign**: Agent is stuck, thrashing, or off-track. Reset context and re-inject semantic file.
- **Escalate**: Agent needs human input - architectural decision, unclear requirements, or critical blocker.

Provide a one-line rationale for your decision.

### Output 2: Semantic File

Generate the semantic summary following the schema (see Semantic File Generation section above).

Both outputs are required. The decision is returned to the orchestrator. The semantic file is written to disk.
```

---

## Migration / Rollout

### Phase 1: File Structure

1. Create workItems subdirectory structure in session folders
2. Move existing logs to `workItems/{workId}/log.json`
3. Initialize empty semantic.md files for active workItems

### Phase 2: Diff Storage

1. Modify log writer to store full diffs in separate files (or ensure full diffs are already captured)
2. Add diffRef to tool_call events if storing separately
3. Backfill diffs from git history where possible

### Phase 3: Extend Watcher Output

1. Update watcher prompt to produce both decision AND semantic content
2. Add semantic content to watcher output schema
3. Implement `writeSemanticFileAsync` (non-blocking file write)
4. Add mutex/lock to prevent overlapping writes for same workItem
5. Implement semantic file writer with versioning (snapshot before overwrite)
6. Add schema validation before write
7. Implement `writeSemanticError` for failure cases

### Phase 4: Context Loading

1. Ensure preference querying is wired into watcher context
2. Ensure sibling workItem loading is wired into watcher context
3. Add pre-processor for deterministic field extraction (reduces LLM work)

### Phase 5: Context Injection

1. Update memory injector to include salience.md
2. Update memory injector to include current workItem's semantic.md
3. Verify worker receives context after realign

### Phase 6: Salience.md

1. Initialize salience.md on session start (from init event)
2. Update workItem table on workItem creation/completion
3. Update patterns section during semantic generation

---

## Open Questions

1. ~~**Observability archive retention**~~: Managed externally, not part of this spec.

2. ~~**Audit timeout**~~: Resolved. Watcher hook keeps existing 60s timeout with `retry_then_degrade` to `continue`. Semantic file write is non-blocking (fire-and-forget after decision). Mutex prevents overlapping writes for same workItem.

3. ~~**Concurrent workItems**~~: Resolved. One watcher call per cadence interval covers all active workItems. Semantic file writes happen sequentially for each workItem (within the single call's output processing).

4. ~~**Preference query scope**~~: Resolved. Search retrieval provides candidates, Watcher evaluates applicability. Prompt instructs Watcher to consider whether preferences are generalizable to current context.

5. ~~**Sibling workItem depth**~~: Resolved. Watcher's discretion based on salience.md content. Salience contains workItem IDs, descriptions, files edited, and objectives. Watcher searches if relevant.

### Remaining Open Questions

*All resolved.*

---

## Schema Validation

Semantic files must conform to a strict schema. Validation occurs before write.

### Required Sections

```typescript
interface SemanticFileSchema {
  meta: {
    workId: string;
    created: string;        // ISO timestamp
    lastAudit: string;      // ISO timestamp
    auditSequence: number;
    logPosition: number;
    totalEvents: number;
  };

  stateAndProgress: {
    objective: string;
    currentState: Array<{
      component: string;
      status: 'complete' | 'partial' | 'not_started' | 'blocked';
      location?: string;    // file:line or description
    }>;
    changesMade: Array<{
      file: string;
      summary: string;
      rationale: string;
    }>;
    gapAnalysis: Array<{
      required: string;
      current: string;
      blocker?: string;
    }>;
    reasoningTrace: string[];  // Numbered steps
    blockers: string[];
  };

  decisionContext: {
    pendingQuestions: string[];
    tradeoffs: Array<{
      title: string;
      options: Array<{ id: string; description: string }>;
      considerations: string[];
      relevantPreferences: string[];
      precedent?: string;
      assessment?: string;
    }>;
  };

  crossReferences: {
    sessionSalience?: string;        // Section anchor
    preferences: string[];           // Preference keys
    siblingWorkItems: string[];      // WorkItem IDs
    decisions: string[];             // Decision keys
  };
}
```

### Validation Function

```typescript
function validateSemanticContent(content: unknown): content is SemanticFileSchema {
  if (!content || typeof content !== 'object') return false;

  const c = content as Record<string, unknown>;

  // Required top-level sections
  if (!c.meta || !c.stateAndProgress || !c.decisionContext || !c.crossReferences) {
    return false;
  }

  // Meta required fields
  const meta = c.meta as Record<string, unknown>;
  if (!meta.workId || !meta.auditSequence || !meta.logPosition) {
    return false;
  }

  // StateAndProgress required fields
  const state = c.stateAndProgress as Record<string, unknown>;
  if (!state.objective || !Array.isArray(state.currentState)) {
    return false;
  }

  return true;
}
```

### On Validation Failure

If the watcher produces invalid output:
1. Log the validation error
2. Write error file (as shown in `writeSemanticError`)
3. Previous valid semantic file remains as `semantic_v{N}.md`
4. Orchestrator continues (non-blocking)
