# SIAS Kernel Bug Fixes & Bulletproofing Requirements

## Document Purpose

This document enumerates all critical bugs, architectural vulnerabilities, and required invariants for the SIAS kernel. This system runs autonomously and modifies its own code. **Any bug that survives to production will compound through self-modification cycles.**

The kernel must be bulletproof across four dimensions:
1. OS-level failures (crashes, memory, signals)
2. Recoverability (checkpoint/restore fidelity)
3. Integration seams (agent handoffs, type contracts)
4. Dynamic updates (worktree promotion, rollback)

---

## Absolute Invariants

These conditions must ALWAYS hold. Violation of any invariant is a critical failure.

### INV-1: Checkpoint Atomicity
A checkpoint is either fully written or not written at all. Partial checkpoints corrupt recovery.

### INV-2: State-Checkpoint Consistency
`SIASState` in memory must be recoverable from the latest checkpoint. Any field in `SIASState` that affects kernel behavior MUST be persisted.

### INV-3: Contract Stability
The types `PrincipalOutput`, `OnCallOutput`, `TestingOutput`, and `IterationResult` define the kernel's integration seams. These types and their corresponding JSON schemas in `agents.ts` must remain synchronized and backward-compatible.

### INV-4: Worktree Validity
Before running code from a worktree path, that path must:
- Exist on disk
- Contain `sias-kernel.ts`
- Pass syntax validation

### INV-5: Graceful Degradation
Any recoverable failure must checkpoint before taking recovery action. The kernel must never lose more than one iteration of progress.

### INV-6: Single Source of Truth
Session metadata in GraphStore is authoritative. In-memory state is derived from it on startup.

---

## Critical Bugs

### BUG-001: Database Connection Leak [CRITICAL]

**Location:** `sias-kernel.ts:27-28, 78-84`

**Description:** GraphStore connection is never closed. The shutdown handler calls `process.exit(0)` without `store.close()`.

**Impact:**
- SQLite WAL file corruption on unclean shutdown
- File descriptor leak over long runs
- Potential data loss if transactions in flight

**Fix:**
```typescript
const handleShutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('[kernel] Shutdown requested, persisting checkpoint...');
  await persistCheckpoint(store, state);
  store.close();  // ADD THIS
  process.exit(0);
};
```

**Invariant Violated:** INV-5 (graceful degradation)

---

### BUG-002: Unhandled Exception in Main Loop [CRITICAL]

**Location:** `sias-kernel.ts:120-152`

**Description:** The `while (!shuttingDown)` loop has no try/catch. Any exception from `runIteration` crashes without checkpointing.

**Impact:** Complete state loss on any transient error (API timeout, network glitch, malformed LLM response).

**Fix:**
```typescript
while (!shuttingDown) {
  try {
    const iterationResult = await runIteration(state, { ... });
    // ... rest of loop
  } catch (error) {
    logger.error('[kernel] Iteration failed', { error });
    await persistCheckpoint(store, state);  // Emergency checkpoint

    // Decide recovery action based on error type
    if (isTransientError(error)) {
      await new Promise(r => setTimeout(r, 5000));  // Backoff
      continue;
    }

    // Fatal error - exit cleanly
    store.close();
    process.exit(1);
  }
}
```

**Invariant Violated:** INV-5 (graceful degradation)

---

### BUG-003: lastUpgradeIteration Not Restored [CRITICAL]

**Location:** `checkpoint.ts:88-99`

**Description:** When restoring state from checkpoint, `lastUpgradeIteration` is hardcoded to 0:

```typescript
function buildStateFromCheckpoint(checkpoint: Checkpoint, fallbackVersion: string): SIASState {
  return {
    // ...
    lastUpgradeIteration: 0,  // BUG: Should restore from checkpoint
  };
}
```

**Impact:** After restart, `iterationsSinceLastUpgrade` is always `currentIteration - 0`, immediately satisfying upgrade thresholds. Causes spurious upgrades on every restart.

**Fix:**
1. Add `lastUpgradeIteration` to `CheckpointV1` schema
2. Persist in `persistCheckpoint`
3. Restore in `buildStateFromCheckpoint`

```typescript
// In types.ts - extend CheckpointV1
export interface CheckpointV1 {
  // ... existing fields
  last_upgrade_iteration: number;  // ADD
}

// In checkpoint.ts
const checkpoint: CheckpointV1 = {
  // ... existing fields
  last_upgrade_iteration: state.lastUpgradeIteration,
};

// In buildStateFromCheckpoint
return {
  // ...
  lastUpgradeIteration: checkpoint.last_upgrade_iteration ?? 0,
};
```

**Invariant Violated:** INV-2 (state-checkpoint consistency)

---

### BUG-004: lastIterationResult Not Persisted [CRITICAL]

**Location:** `checkpoint.ts:59-73`

**Description:** `state.lastIterationResult` is not included in checkpoint payload. After restore, principal agent sees "Last iteration result: none" regardless of actual history.

**Impact:** Principal loses context about what happened before restart. May repeat failed objectives or miss important signals.

**Fix:** Add to checkpoint schema and persist/restore cycle. Consider storing only a summary to avoid bloat.

**Invariant Violated:** INV-2 (state-checkpoint consistency)

---

### BUG-005: Upgrade Signal Race Condition [CRITICAL]

**Location:** `upgrade.ts:10-17`, `sias-launcher.sh:65-67`

**Description:** The kernel writes upgrade path to a file, launcher reads it. No atomicity guarantee.

**Kernel:**
```typescript
await fs.writeFile(upgradeSignalFile, newKernelPath, 'utf-8');
```

**Launcher:**
```bash
new_path=$(cat "$UPGRADE_SIGNAL_FILE")
```

**Impact:** If launcher reads during write, gets partial path. Kernel then starts from invalid/truncated path, crashes, enters failure loop.

**Fix - Atomic Write Pattern:**
```typescript
// upgrade.ts
import { rename, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';

export async function triggerUpgrade(
  newKernelPath: string,
  upgradeSignalFile: string,
  logger: Logger
): Promise<void> {
  const tempFile = `${upgradeSignalFile}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tempFile, newKernelPath, 'utf-8');
  await rename(tempFile, upgradeSignalFile);  // Atomic on POSIX
  logger.info('[kernel] Upgrade signal sent', { path: newKernelPath });
}
```

**Invariant Violated:** INV-4 (worktree validity)

---

### BUG-006: Non-Atomic Checkpoint Writes [HIGH]

**Location:** `checkpoint.ts:48-86`

**Description:** `persistCheckpoint` makes multiple independent database calls:

```typescript
store.insertSiasCheckpoint(state.sessionId, ...);
store.upsertSiasPrincipalContext({ ... });
```

If process dies between these calls, checkpoint and principal context become inconsistent.

**Fix:** Wrap in transaction. Requires adding transaction support to GraphStore or combining into single atomic operation.

**Invariant Violated:** INV-1 (checkpoint atomicity)

---

### BUG-007: Rollback Selects Wrong Target [HIGH]

**Location:** `sias-kernel.ts:104-113`

**Description:** Rollback handler picks first active non-current worktree:

```typescript
const candidates = store
  .listSiasWorktrees()
  .filter((worktree) => worktree.version !== currentVersion && worktree.status === 'active');
const target = candidates.at(0)?.version;
```

`listSiasWorktrees()` returns `ORDER BY created_at DESC`. So `.at(0)` is the **newest** alternative, which may be the bad version we're rolling back from.

**Fix:** Either:
1. Sort by `promoted_at` and pick last successfully promoted version
2. Track explicit "last_known_good" in session metadata
3. Filter out versions newer than current

```typescript
const candidates = store
  .listSiasWorktrees()
  .filter((wt) =>
    wt.version !== currentVersion &&
    wt.status === 'active' &&
    wt.promotedAt && wt.promotedAt < currentWorktree.promotedAt
  )
  .sort((a, b) => (b.promotedAt ?? 0) - (a.promotedAt ?? 0));
```

**Invariant Violated:** INV-4 (worktree validity)

---

### BUG-008: WIP Promotion Without Existence Check [HIGH]

**Location:** `worktree.ts:86-92`

**Description:** `promoteWip` assumes WIP directory exists:

```typescript
async promoteWip(): Promise<string> {
  const wipVersion = await this.getWipVersion();
  const wipPath = path.join(this.baseDir, wipVersion);
  await fs.rename(wipPath, finalPath);  // Throws ENOENT if wipPath doesn't exist
```

`getWipVersion()` computes a version string, doesn't verify directory exists.

**Fix:**
```typescript
async promoteWip(): Promise<string> {
  const wipVersion = await this.getWipVersion();
  const wipPath = path.join(this.baseDir, wipVersion);

  // Verify WIP exists before promotion
  try {
    await fs.access(wipPath);
  } catch {
    throw new Error(`WIP directory does not exist: ${wipPath}. Call createWip() first.`);
  }

  // ... rest of promotion
}
```

**Invariant Violated:** INV-4 (worktree validity)

---

### BUG-009: Agent Output Type Coercion [HIGH]

**Location:** `loop.ts:228, 263, 294`

**Description:** Agent outputs are cast without validation:

```typescript
return (result.structuredOutput as TestingOutput) ?? null;
```

If LLM returns subtly malformed output (wrong types, missing nested fields), downstream code fails unpredictably.

**Fix:** Add runtime validation:

```typescript
import { validatePrincipalOutput } from './validators.js';  // New file

const output = result.structuredOutput;
if (!validatePrincipalOutput(output)) {
  logger.error('[kernel] Invalid principal output', { output });
  return null;
}
return output as PrincipalOutput;
```

**Invariant Violated:** INV-3 (contract stability)

---

### BUG-010: FlipFlop Detection Never Called [HIGH]

**Location:** `loop.ts:127-129`

**Description:** The FlipFlopDetector stores embeddings but `checkForFlipFlop` is never called:

```typescript
// Only stores embedding, never checks
if (decisionId && principalOutput) {
  deps.flipFlopDetector.storeEmbedding(decisionId, principalOutput.decision.reasoning);
}
```

**Impact:** Flip-flop detection is dead code. Principal can reverse decisions freely.

**Fix:**
```typescript
if (principalOutput) {
  const recentDecisions = deps.store.listSiasDecisions(state.sessionId).slice(-20);
  const flipFlopResult = await deps.flipFlopDetector.checkForFlipFlop(
    principalOutput.decision.reasoning,
    recentDecisions
  );

  if (flipFlopResult.is_flip_flop) {
    logger.warn('[kernel] Flip-flop detected, blocking decision', {
      similar: flipFlopResult.similar_decisions
    });
    // Either block or require higher confidence threshold
    if (principalOutput.decision.confidence < 0.9) {
      principalOutput.decision.type = 'pause';
      principalOutput.decision.reasoning =
        `Blocked: ${flipFlopResult.recommendation}. Original: ${principalOutput.decision.reasoning}`;
    }
  }

  const decisionId = recordDecision(deps.store, state, principalOutput, iterationNumber);
  if (decisionId) {
    deps.flipFlopDetector.storeEmbedding(decisionId, principalOutput.decision.reasoning);
  }
}
```

---

### BUG-011: API Key Provider Mismatch [HIGH]

**Location:** `sias-kernel.ts:61-68`

**Description:** API key assignment assumes provider groupings that don't match config:

```typescript
const openaiKey = config.agents.coding.apiKey ?? config.agents.principal.apiKey;
const anthropicKey = config.agents.testing.apiKey ?? config.agents.oncall.apiKey;
```

But default config has ALL agents using OpenAI (gpt-5 series). This means `anthropicKey` gets an OpenAI key if both envvars are set.

**Fix:** Key assignment should be per-provider, not per-agent:

```typescript
const apiKeys: Record<string, string> = {};
if (process.env.OPENAI_API_KEY) {
  apiKeys.openai = process.env.OPENAI_API_KEY;
}
if (process.env.ANTHROPIC_API_KEY) {
  apiKeys.anthropic = process.env.ANTHROPIC_API_KEY;
}
// Let adapter resolve per-request based on agent's provider config
```

---

### BUG-012: State Mutation Before Commit [MEDIUM]

**Location:** `loop.ts:88-97`

**Description:** State is mutated mid-iteration:

```typescript
if (principalOutput?.new_constraints) {
  state.learnedConstraints.push(...);  // Mutates
}
if (principalOutput?.next_objective) {
  state.currentFocus = principalOutput.next_objective.goal;  // Mutates
}
```

If iteration fails later, state is corrupted but never persisted.

**Fix:** Copy-on-write pattern:

```typescript
// Create pending changes, apply only on success
const pendingChanges = {
  learnedConstraints: [...state.learnedConstraints],
  currentFocus: state.currentFocus,
  horizonObjectives: [...state.horizonObjectives],
};

if (principalOutput?.new_constraints) {
  pendingChanges.learnedConstraints.push(
    ...principalOutput.new_constraints.map((c) => c.constraint)
  );
}
// ...

// Only apply after successful iteration
Object.assign(state, pendingChanges);
```

---

### BUG-013: No Agent Timeout Enforcement [MEDIUM]

**Location:** `loop.ts:211, 246, 277`

**Description:** Agent runs have no timeout wrapper despite `AgentBudget.maxDurationMs`:

```typescript
const result = await agent.run({ context, workItem });  // Can hang forever
```

**Fix:**
```typescript
async function runAgentWithTimeout<T>(
  agent: Agent,
  params: AgentRunParams,
  timeoutMs: number
): Promise<T | null> {
  const timeoutPromise = new Promise<null>((_, reject) =>
    setTimeout(() => reject(new Error('Agent timeout')), timeoutMs)
  );

  try {
    return await Promise.race([agent.run(params), timeoutPromise]) as T;
  } catch (error) {
    if (error.message === 'Agent timeout') {
      return null;
    }
    throw error;
  }
}
```

---

### BUG-014: Launcher Doesn't Validate Kernel Path [MEDIUM]

**Location:** `sias-launcher.sh:25-31`

**Description:** Launcher starts kernel without validating path exists:

```bash
start_kernel() {
  local kernel_path="$1"
  GRAPHD_URL="$GRAPHD_URL" bun run "$kernel_path/sias-kernel.ts" &
```

**Fix:**
```bash
start_kernel() {
  local kernel_path="$1"

  # Validate kernel path
  if [ ! -d "$kernel_path" ]; then
    echo "[launcher] ERROR: Kernel path does not exist: $kernel_path"
    return 1
  fi

  if [ ! -f "$kernel_path/sias-kernel.ts" ]; then
    echo "[launcher] ERROR: sias-kernel.ts not found in: $kernel_path"
    return 1
  fi

  # Syntax check
  if ! bun check "$kernel_path/sias-kernel.ts" 2>/dev/null; then
    echo "[launcher] ERROR: Kernel failed syntax check"
    return 1
  fi

  echo "[launcher] Starting kernel from: $kernel_path"
  GRAPHD_URL="$GRAPHD_URL" bun run "$kernel_path/sias-kernel.ts" &
  CURRENT_PID=$!
}
```

---

### BUG-015: GC Force Silently Fails [LOW]

**Location:** `health.ts:339-342`

**Description:** `global.gc` only exists with `--expose-gc` flag:

```typescript
case 'gc_force':
  if (global.gc) {
    global.gc();
  }
  break;
```

Silently does nothing if flag not set.

**Fix:** Either:
1. Add `--expose-gc` to launcher
2. Log warning when gc unavailable
3. Use alternative memory pressure response (context compaction)

---

## Schema Evolution & Contract Stability

### Key Insight: Schemas ARE Evolvable

Agent output schemas (`PrincipalOutput`, `OnCallOutput`, etc.) are **not frozen**. They can and should evolve as the agent improves. The constraint is **atomic co-evolution**: related files must change together.

### What's Actually Frozen vs Evolvable

| Category | Files | Status | Reason |
|----------|-------|--------|--------|
| Agent output schemas | `types.ts` (PrincipalOutput, etc.), `agents.ts` (JSON schemas), `loop.ts` (field access) | **Evolvable together** | Can change if all three change atomically |
| Checkpoint format | `types.ts` (CheckpointV1), `checkpoint.ts` | **Additive only** | Rollback compatibility requires reading old checkpoints |
| Agent core | `packages/agent-core/src/agent/agent.ts` | **Stable interface** | Returns `Record<string, unknown>`, doesn't parse specific fields |

### Why Agent Output Schemas Can Evolve

```
Agent output schema ≠ Checkpoint format

PrincipalOutput → what LLM returns at runtime → stored in CODE
CheckpointV1 → what gets persisted to disk → stored in DATABASE
```

These are orthogonal. Changing `PrincipalOutput` doesn't affect checkpoint compatibility.

**Evolution flow:**
1. Agent proposes changes to `types.ts`, `agents.ts`, `loop.ts` in WIP worktree
2. Hook validates atomic co-evolution (all three files updated consistently)
3. Benchmarks pass in WIP
4. Promote WIP → checkpoint → upgrade signal → respawn
5. New kernel uses new schema, loads same checkpoint format

**Rollback safety:**
- Old kernel loads same checkpoint (format unchanged)
- Old kernel uses old schema (in its code)
- New decision types proposed by new kernel are simply not present in history

### The Atomic Co-Evolution Hook

```typescript
// hooks/validate-schema-evolution.ts
interface SchemaChangeSet {
  typesChanged: boolean;
  agentsChanged: boolean;
  loopChanged: boolean;
}

export async function validateSchemaEvolution(changedFiles: string[]): Promise<{
  valid: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  const changes: SchemaChangeSet = {
    typesChanged: changedFiles.some(f => f.includes('types.ts')),
    agentsChanged: changedFiles.some(f => f.includes('agents.ts')),
    loopChanged: changedFiles.some(f => f.includes('loop.ts')),
  };

  // Rule 1: If any schema file changes, validate consistency
  if (changes.typesChanged || changes.agentsChanged) {
    // Parse TypeScript types and JSON schemas, compare
    const typeEnums = extractEnumsFromTypes('sias-kernel/types.ts');
    const schemaEnums = extractEnumsFromSchemas('sias-kernel/agents.ts');

    for (const [name, values] of Object.entries(typeEnums)) {
      const schemaValues = schemaEnums[name];
      if (!schemaValues) {
        errors.push(`Type ${name} has no corresponding JSON schema`);
        continue;
      }

      const missingInSchema = values.filter(v => !schemaValues.includes(v));
      const missingInType = schemaValues.filter(v => !values.includes(v));

      if (missingInSchema.length > 0) {
        errors.push(`Schema missing values for ${name}: ${missingInSchema.join(', ')}`);
      }
      if (missingInType.length > 0) {
        errors.push(`Type missing values for ${name}: ${missingInType.join(', ')}`);
      }
    }
  }

  // Rule 2: If new enum values added, loop.ts should handle them
  if (changes.typesChanged && !changes.loopChanged) {
    const newEnumValues = detectNewEnumValues('types.ts');
    if (newEnumValues.length > 0) {
      errors.push(
        `New enum values added but loop.ts not updated: ${newEnumValues.join(', ')}. ` +
        `Either add handling in loop.ts or confirm these are optional/ignored.`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
```

### Runtime Schema Validation (Required)

Every agent output MUST be validated before use. This catches LLM schema violations.

```typescript
// sias-kernel/validators.ts
import Ajv from 'ajv';
import { buildPrincipalSchema, buildOnCallSchema, buildTestingSchema } from './agents.js';
import type { PrincipalOutput, OnCallOutput, TestingOutput } from './types.js';

const ajv = new Ajv({ strict: true, allErrors: true });

// Compile schemas once at startup
const validators = {
  principal: ajv.compile(buildPrincipalSchema().schema),
  oncall: ajv.compile(buildOnCallSchema().schema),
  testing: ajv.compile(buildTestingSchema().schema),
};

export function validatePrincipalOutput(output: unknown): output is PrincipalOutput {
  const valid = validators.principal(output);
  if (!valid) {
    console.error('[validator] Principal output invalid:', validators.principal.errors);
  }
  return valid;
}

export function validateOnCallOutput(output: unknown): output is OnCallOutput {
  const valid = validators.oncall(output);
  if (!valid) {
    console.error('[validator] OnCall output invalid:', validators.oncall.errors);
  }
  return valid;
}

export function validateTestingOutput(output: unknown): output is TestingOutput {
  const valid = validators.testing(output);
  if (!valid) {
    console.error('[validator] Testing output invalid:', validators.testing.errors);
  }
  return valid;
}
```

**Usage in loop.ts:**
```typescript
async function runPrincipal(...): Promise<PrincipalOutput | null> {
  // ... agent.run() ...

  const output = result.structuredOutput;
  if (!output) return null;

  // RUNTIME VALIDATION - catches LLM schema violations
  if (!validatePrincipalOutput(output)) {
    deps.logger.error('[kernel] Principal returned invalid output', { output });
    return null;
  }

  return output;
}
```

### Checkpoint Format: Additive Only

The checkpoint format (`CheckpointV1`) must remain **backward compatible** for rollback safety.

**Allowed changes:**
- Add new optional fields
- Add new enum values to existing fields (if old kernel ignores unknown values)

**Forbidden changes:**
- Remove fields
- Change field types
- Rename fields
- Make optional fields required

```typescript
// SAFE: Adding optional field
interface CheckpointV1 {
  version: 1;
  session_id: string;
  iteration: number;
  // ... existing fields ...

  // NEW: Optional field, old kernel ignores
  last_upgrade_iteration?: number;
  performance_metrics?: PerformanceSnapshot;
}

// UNSAFE: Would break rollback
interface CheckpointV1 {
  version: 1;
  sessionId: string;  // RENAMED from session_id - breaks old kernel
  iteration: number;
  last_upgrade_iteration: number;  // REQUIRED now - old checkpoint missing it
}
```

**If breaking checkpoint changes are needed:**
1. Create `CheckpointV2`
2. Update `migrateCheckpoint()` to convert v1 → v2
3. Accept that rollback to pre-v2 kernel is impossible
4. This is a **major version boundary** - requires explicit approval

### Bash Mutex Clarification

A mutex controls **concurrent access**, not **immutability**. You cannot use a mutex to "freeze" files. What you CAN do:

1. **Flock for atomic upgrade signal:**
```bash
# In launcher
(
  flock -x 200
  if [ -f "$UPGRADE_SIGNAL_FILE" ]; then
    new_path=$(cat "$UPGRADE_SIGNAL_FILE")
    rm -f "$UPGRADE_SIGNAL_FILE"
  fi
) 200>/tmp/sias-upgrade.lock
```

2. **Lockfile to prevent concurrent kernel instances:**
```bash
LOCKFILE="/tmp/sias-kernel.lock"
exec 200>"$LOCKFILE"
flock -n 200 || { echo "Kernel already running"; exit 1; }
```

---

## Non-Negotiable Bulletproofing Checklist

Before any autonomous run, verify:

- [ ] All BUG-00X fixes applied
- [ ] Frozen file manifest created and verified
- [ ] Pre-commit hook installed
- [ ] `--expose-gc` flag added to launcher
- [ ] Transaction wrapper added to persistCheckpoint
- [ ] Atomic write pattern for upgrade signal
- [ ] Runtime validators for all agent outputs
- [ ] Timeout wrappers on all agent.run() calls
- [ ] FlipFlop detection enabled
- [ ] Launcher path validation added
- [ ] Database close() in shutdown handler

---

## Recommended Patch Scope Constraints

For self-improvement iterations, patches are categorized by **coordination requirements**, not by blanket prohibition.

### SAFE (Agent can modify freely):
- Prompt text in `agents.ts` system prompts
- Threshold values in `config.ts`
- Benchmark definitions in `benchmark.ts`
- Logging statements
- Performance optimizations (pure refactors, no interface changes)
- New utility functions that don't affect seams

### ATOMIC CO-EVOLUTION (Must change together):
These files define agent output contracts. Changing one requires changing all:

| File | What It Defines | Co-Evolution Requirement |
|------|-----------------|-------------------------|
| `types.ts` (agent outputs) | TypeScript interfaces | Must match `agents.ts` schemas |
| `agents.ts` (schemas) | JSON Schemas sent to LLM | Must match `types.ts` interfaces |
| `loop.ts` (field access) | How kernel uses outputs | Must handle all schema cases |

**Hook enforces**: If any of these files changes, validate the others are consistent.

### ADDITIVE ONLY (Checkpoint format):
These files affect rollback compatibility:

| File | Constraint | Why |
|------|------------|-----|
| `types.ts` (CheckpointV1, etc.) | Add optional fields only | Old kernel must read new checkpoints |
| `checkpoint.ts` | Add optional fields only | Rollback loads checkpoint from future |

**Allowed**: `last_upgrade_iteration?: number` (optional, old kernel ignores)
**Forbidden**: Removing fields, renaming, changing types

### REQUIRES ESCALATION (Major version boundary):
- Breaking checkpoint format changes (v1 → v2)
- Changes to `packages/agent-core/src/agent/agent.ts` return interface
- Changes to `OrchestratorResult` interface

These require:
1. `decision.type = 'escalate'` with detailed migration plan
2. Explicit acknowledgment that rollback past this point is impossible
3. Human approval before applying

### Enforcement via Hooks

```typescript
// hooks/validate-patch-scope.ts
export async function validatePatchScope(changedFiles: string[]): Promise<{
  allowed: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check atomic co-evolution files
  const schemaFiles = ['types.ts', 'agents.ts', 'loop.ts'].map(f => `sias-kernel/${f}`);
  const changedSchemaFiles = changedFiles.filter(f => schemaFiles.some(sf => f.endsWith(sf)));

  if (changedSchemaFiles.length > 0 && changedSchemaFiles.length < 3) {
    // Partial schema change - validate consistency
    const validation = await validateSchemaEvolution(changedFiles);
    if (!validation.valid) {
      errors.push(
        `Partial schema change detected. Changed: ${changedSchemaFiles.join(', ')}. ` +
        `Errors: ${validation.errors.join('; ')}`
      );
    }
  }

  // Check checkpoint format changes
  const checkpointFiles = changedFiles.filter(f =>
    f.includes('checkpoint.ts') ||
    (f.includes('types.ts') && containsCheckpointChanges(f))
  );

  if (checkpointFiles.length > 0) {
    const checkpointValidation = await validateCheckpointChanges(checkpointFiles);
    if (!checkpointValidation.valid) {
      errors.push(`Checkpoint format change: ${checkpointValidation.errors.join('; ')}`);
    }
    if (checkpointValidation.isBreaking) {
      errors.push(
        `BREAKING checkpoint change requires escalation. ` +
        `Rollback past this point will be impossible. ` +
        `Set decision.type = 'escalate' with migration plan.`
      );
    }
  }

  // Check agent-core changes (stable interface)
  const agentCoreChanges = changedFiles.filter(f => f.includes('packages/agent-core/src/agent/'));
  if (agentCoreChanges.length > 0) {
    warnings.push(
      `Agent core files modified: ${agentCoreChanges.join(', ')}. ` +
      `Ensure AgentResult interface remains stable.`
    );
  }

  return {
    allowed: errors.length === 0,
    errors,
    warnings,
  };
}
```

### Principal Prompt Guidance

```
PATCH SCOPE RULES:

1. SAFE modifications (no coordination needed):
   - Prompts, thresholds, benchmarks, logging, pure refactors

2. ATOMIC CO-EVOLUTION (types.ts + agents.ts + loop.ts):
   - If you change PrincipalOutput/OnCallOutput/TestingOutput, you MUST:
     a. Update the TypeScript interface in types.ts
     b. Update the JSON Schema in agents.ts
     c. Update field access in loop.ts to handle new cases
   - Hook will validate consistency before allowing commit

3. CHECKPOINT FORMAT (additive only):
   - You MAY add optional fields to CheckpointV1
   - You MUST NOT remove, rename, or change types of existing fields
   - Reason: Old kernel must be able to read checkpoints written by new kernel

4. BREAKING CHANGES (require escalation):
   - If you need to break checkpoint format: decision.type = 'escalate'
   - Provide migration plan in decision.reasoning
   - Acknowledge: "Rollback past this point will be impossible"
```

### Coding Agent Constraints

```
BEFORE WRITING TO FILES:

1. Check if file is in atomic co-evolution set (types.ts, agents.ts, loop.ts):
   - If yes, ensure ALL THREE are being modified consistently
   - Run schema validation before committing

2. Check if file affects checkpoint format:
   - If yes, ensure changes are ADDITIVE ONLY
   - New fields must be optional with sensible defaults

3. If you encounter a constraint you cannot satisfy:
   - STOP and report the constraint violation
   - Do not attempt partial modifications
   - Output: "Cannot complete: {reason}. Requires escalation."
```
