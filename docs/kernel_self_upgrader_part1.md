# SIAS v3: Hot-Upgradeable Self-Improving Agent System

## The Problem

A frozen kernel means frozen agents, which defeats the entire purpose of self-improvement. If Principal, OnCall, and Testing agents can't improve themselves, they're stuck in their "pathetic unimproved state."

## The Real Insight

The only thing that needs to be truly frozen is a **minimal launcher** - maybe 50 lines of bash. Everything else, including the "kernel," can be upgraded.

```
┌─────────────────────────────────────────────────────────────────┐
│  LAUNCHER (truly frozen, ~50 lines)                             │
│  - Start process from path                                      │
│  - Watch for upgrade signal                                     │
│  - Kill old, start new                                          │
│  - That's it                                                    │
└─────────────────────────────────────────────────────────────────┘
         │
         │ spawns
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  KERNEL + AGENTS (upgradeable)                                  │
│  - Principal, OnCall, Testing, Coding agents                    │
│  - Orchestrator, Harness                                        │
│  - Everything improves together                                 │
└─────────────────────────────────────────────────────────────────┘
         │
         │ persists to
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  GRAPHD (external state)                                        │
│  - Session state                                                │
│  - Patch history                                                │
│  - Decisions                                                    │
│  - Checkpoint data                                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## The Launcher (`sias-launcher.sh`)

This is the ONLY frozen code. It's so simple it doesn't need improvement:

```bash
#!/bin/bash
# sias-launcher.sh - The only frozen code (~50 lines)

set -e

GRAPHD_URL="${GRAPHD_URL:-http://127.0.0.1:9444}"
UPGRADE_SIGNAL_FILE="/tmp/sias-upgrade-signal"
STATE_FILE="/tmp/sias-state.json"
CURRENT_PID=""
LAST_GOOD_PATH=""
CONSECUTIVE_FAILURES=0
MAX_FAILURES=3

cleanup() {
    echo "[launcher] Shutting down..."
    if [ -n "$CURRENT_PID" ] && kill -0 "$CURRENT_PID" 2>/dev/null; then
        kill -TERM "$CURRENT_PID"
        wait "$CURRENT_PID" 2>/dev/null || true
    fi
    rm -f "$UPGRADE_SIGNAL_FILE"
    exit 0
}

trap cleanup SIGINT SIGTERM

start_kernel() {
    local kernel_path="$1"
    echo "[launcher] Starting kernel from: $kernel_path"

    # Run kernel, capture PID
    bun run "$kernel_path/sias-kernel.ts" &
    CURRENT_PID=$!
    echo "[launcher] Kernel PID: $CURRENT_PID"

    # Wait a bit to see if it crashes immediately
    sleep 5

    if ! kill -0 "$CURRENT_PID" 2>/dev/null; then
        echo "[launcher] Kernel crashed on startup!"
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))

        if [ $CONSECUTIVE_FAILURES -ge $MAX_FAILURES ] && [ -n "$LAST_GOOD_PATH" ]; then
            echo "[launcher] Too many failures, rolling back to: $LAST_GOOD_PATH"
            kernel_path="$LAST_GOOD_PATH"
            CONSECUTIVE_FAILURES=0
            start_kernel "$kernel_path"
            return
        fi
    else
        # Successful start
        LAST_GOOD_PATH="$kernel_path"
        CONSECUTIVE_FAILURES=0
    fi
}

main() {
    local kernel_path="${1:-./sias-kernel}"

    rm -f "$UPGRADE_SIGNAL_FILE"
    start_kernel "$kernel_path"

    # Main loop: watch for upgrade signal or process death
    while true; do
        # Check if kernel died unexpectedly
        if ! kill -0 "$CURRENT_PID" 2>/dev/null; then
            echo "[launcher] Kernel died, restarting from same path..."
            sleep 2
            start_kernel "$kernel_path"
        fi

        # Check for upgrade signal
        if [ -f "$UPGRADE_SIGNAL_FILE" ]; then
            new_path=$(cat "$UPGRADE_SIGNAL_FILE")
            echo "[launcher] Upgrade signal received: $new_path"

            # Graceful shutdown of old kernel
            kill -TERM "$CURRENT_PID" 2>/dev/null || true
            wait "$CURRENT_PID" 2>/dev/null || true

            # Start new kernel from new path
            kernel_path="$new_path"
            rm -f "$UPGRADE_SIGNAL_FILE"
            start_kernel "$kernel_path"
        fi

        sleep 1
    done
}

main "$@"
```

**That's it.** The launcher:
1. Starts a kernel process
2. Watches for death → restart
3. Watches for upgrade signal → kill old, start new from new path
4. Rollback if too many consecutive failures
5. Nothing else

---

## Upgrade Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     UPGRADE SEQUENCE                            │
│                                                                 │
│  1. Agent makes improvements to agent-core, harness, etc.       │
│                                                                 │
│  2. Testing agent runs benchmarks                               │
│     - Compare against baseline                                  │
│     - If improvement >= threshold (e.g., 5% faster, tests pass) │
│                                                                 │
│  3. Kernel decides to checkpoint + upgrade                      │
│     a. Persist ALL state to GraphD                              │
│     b. Copy improved code to new worktree path                  │
│     c. Write upgrade signal: echo "/path/to/new" > signal_file  │
│                                                                 │
│  4. Launcher sees signal                                        │
│     a. SIGTERM to old kernel                                    │
│     b. Old kernel flushes final state, exits                    │
│     c. Launcher starts NEW kernel from new path                 │
│                                                                 │
│  5. New kernel starts                                           │
│     a. Reads state from GraphD                                  │
│     b. Rehydrates Principal context                             │
│     c. Continues iteration loop                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Worktree Management for Upgrades

```
repo/
├── sias-launcher.sh          # Frozen, never in worktree
├── worktrees/
│   ├── v001/                 # Initial version
│   │   ├── sias-kernel/
│   │   ├── packages/
│   │   └── apps/
│   ├── v002/                 # After first successful upgrade
│   │   └── ...
│   ├── v003/                 # Current running version
│   │   └── ...
│   └── v004-wip/             # Work in progress (agents editing here)
│       └── ...
```

**Upgrade creates a new versioned worktree:**

```typescript
async function prepareUpgrade(currentVersion: string): Promise<string> {
  const nextVersion = incrementVersion(currentVersion);  // v003 -> v004
  const wipPath = `worktrees/v${nextVersion}-wip`;
  const finalPath = `worktrees/v${nextVersion}`;

  // Tests passed, promote WIP to final
  await fs.rename(wipPath, finalPath);

  // Create new WIP for next iteration
  await git.worktree.add(`worktrees/v${nextVersion + 1}-wip`, 'HEAD');

  return finalPath;
}

async function triggerUpgrade(newKernelPath: string): Promise<void> {
  // Persist everything first
  await persistCheckpoint();

  // Signal launcher
  await fs.writeFile('/tmp/sias-upgrade-signal', newKernelPath);

  // We'll be killed shortly, that's fine
  console.log('[kernel] Upgrade signal sent, awaiting termination...');
}
```

---

## The Interface Stability Question

Define a **checkpoint schema** that both old and new kernels understand:

```typescript
// checkpoint-schema.ts - This interface MUST remain stable

interface CheckpointV1 {
  version: 1;
  session_id: string;
  iteration: number;
  timestamp: number;

  // Semantic state (not implementation details)
  principal_understanding: {
    objectives: string[];
    learned_constraints: string[];
    current_focus: string;
    patch_summary: string;
  };

  patches: Array<{
    id: string;
    objective: string;
    reasoning: string;
    status: "applied" | "rolled_back";
    files: string[];
  }>;

  decisions: Array<{
    iteration: number;
    agent: string;
    decision: string;
    reasoning: string;
  }>;

  // For flip-flop detection
  decision_embeddings?: Array<{
    decision_id: string;
    embedding: number[];
  }>;
}

// Future: If schema needs to change, add migration
interface CheckpointV2 extends CheckpointV1 {
  version: 2;
  // New fields...
}

type Checkpoint = CheckpointV1 | CheckpointV2;

function migrateCheckpoint(cp: Checkpoint): CheckpointV2 {
  if (cp.version === 1) {
    return { ...cp, version: 2, /* new fields with defaults */ };
  }
  return cp;
}
```

**Key principle**: Checkpoints are versioned. New kernel can read old checkpoint format and migrate.

---

## Handling the "Reaching Into Worktree" Problem

**Question**: How does the long-running script reach into worktrees to get new code?

**Answer: It doesn't need to.**

The agents work in `v004-wip/`. When they're done and tests pass:

1. Kernel (running from `v003/`) creates `v004/` from `v004-wip/`
2. Kernel writes `/tmp/sias-upgrade-signal` containing `worktrees/v004`
3. Kernel is killed by launcher
4. Launcher starts NEW process: `bun run worktrees/v004/sias-kernel/sias-kernel.ts`
5. New kernel is running improved code, reads checkpoint, continues

The old kernel never needs to load new code. It just tells the launcher where to find it.

---

## Checkpoint Triggers

When to upgrade?

```typescript
interface UpgradePolicy {
  // Minimum improvement to trigger upgrade
  benchmark_improvement_threshold: 0.05;  // 5% improvement

  // OR explicit iteration count
  max_iterations_before_checkpoint: 10;

  // AND all tests must pass
  require_all_tests_pass: true;

  // AND no regressions
  max_allowed_regression: 0.02;  // 2% slower is OK if other gains

  // Safety: don't upgrade too frequently
  min_iterations_between_upgrades: 3;
}

async function shouldUpgrade(
  benchmarkBefore: BenchmarkResult,
  benchmarkAfter: BenchmarkResult,
  testResults: TestResults,
  iterationsSinceLastUpgrade: number
): Promise<boolean> {
  if (iterationsSinceLastUpgrade < policy.min_iterations_between_upgrades) {
    return false;
  }

  if (!testResults.allPassed) {
    return false;
  }

  const improvement = calculateImprovement(benchmarkBefore, benchmarkAfter);

  if (improvement >= policy.benchmark_improvement_threshold) {
    return true;
  }

  if (iterationsSinceLastUpgrade >= policy.max_iterations_before_checkpoint) {
    // Force checkpoint even without improvement, for safety
    return true;
  }

  return false;
}
```

---

## Minimal Kernel Structure

Keep the kernel light so upgrades are safe:

```
sias-kernel/
├── sias-kernel.ts       # Entry point (~200 lines)
├── checkpoint.ts        # Persist/restore (~100 lines)
├── upgrade.ts           # Trigger upgrades (~50 lines)
└── loop.ts              # Main iteration loop (~300 lines)
```

The kernel is ~650 lines. It orchestrates agents but doesn't contain agent logic. Agent logic lives in `packages/agent-core/` which gets upgraded along with everything else.

```typescript
// sias-kernel.ts - Entry point

import { restoreCheckpoint, persistCheckpoint } from './checkpoint';
import { shouldUpgrade, triggerUpgrade } from './upgrade';
import { runIteration } from './loop';

async function main() {
  console.log('[kernel] Starting...');

  // Restore state from GraphD
  const state = await restoreCheckpoint();
  console.log(`[kernel] Resumed session ${state.session_id} at iteration ${state.iteration}`);

  // Graceful shutdown handler
  let shuttingDown = false;
  process.on('SIGTERM', async () => {
    console.log('[kernel] SIGTERM received, persisting state...');
    shuttingDown = true;
    await persistCheckpoint(state);
    process.exit(0);
  });

  // Main loop
  while (!shuttingDown) {
    const result = await runIteration(state);
    state.iteration++;

    // Periodic checkpoint
    if (state.iteration % 5 === 0) {
      await persistCheckpoint(state);
    }

    // Check for upgrade
    if (await shouldUpgrade(result)) {
      const newPath = await prepareUpgrade(state.version);
      await triggerUpgrade(newPath);
      // We'll be killed, loop exits
    }
  }
}

main().catch(console.error);
```

---

## GraphD Persistence Schema

Instead of persisting raw context windows (which break on schema changes), persist **semantic state**:

```typescript
// GraphD Tables

interface SIASSession {
  session_id: string;
  started_at: number;
  last_checkpoint_at: number;
  iteration_count: number;
  status: "running" | "paused" | "crashed" | "completed";
}

interface PatchRecord {
  patch_id: string;
  session_id: string;
  iteration: number;
  timestamp: number;
  objective: string;
  reasoning: string;           // Why this change
  files_changed: string[];
  diff_summary: string;        // Compressed diff
  status: "applied" | "rolled_back";
  rollback_reason?: string;
  benchmark_before: BenchmarkSnapshot;
  benchmark_after: BenchmarkSnapshot;
  test_summary: TestSummary;
}

interface DecisionRecord {
  decision_id: string;
  session_id: string;
  iteration: number;
  agent: "principal" | "oncall" | "testing";
  decision_type: string;
  reasoning: string;
  outcome: string;
  // For flip-flop detection
  related_decisions: string[];  // IDs of similar past decisions
}

interface PrincipalContext {
  session_id: string;
  // Summarized history (not raw messages)
  patch_summary: string;        // "We've made 12 patches, 2 rolled back..."
  current_focus: string;        // "Currently improving context management"
  learned_constraints: string[]; // "Async X doesn't work because Y"
  horizon_objectives: string[]; // Long-term goals
  last_updated: number;
}
```

**Key insight**: We persist *semantic understanding*, not raw context. On recovery, we rebuild context from semantic records.

---

## Rehydration Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     RECOVERY FLOW                               │
│                                                                 │
│  1. Daemon crashes / needs restart / upgrade                    │
│                                                                 │
│  2. Launcher starts new kernel process                          │
│                                                                 │
│  3. Kernel loads semantic state from GraphD:                    │
│     - PatchRecords (what changes were made)                     │
│     - DecisionRecords (what was decided and why)                │
│     - PrincipalContext (summarized understanding)               │
│                                                                 │
│  4. Generate rehydration prompt:                                │
│     "You are resuming session X. Here's what happened..."       │
│     - NOT raw context window bytes                              │
│     - Human-readable summaries                                  │
│                                                                 │
│  5. Agent continues with full understanding but fresh instance  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```typescript
async function rehydratePrincipal(session_id: string): Promise<string> {
  const patches = await graphd.query<PatchRecord>(`
    SELECT * FROM patches WHERE session_id = ? ORDER BY iteration
  `, [session_id]);

  const decisions = await graphd.query<DecisionRecord>(`
    SELECT * FROM decisions WHERE session_id = ? AND agent = 'principal'
  `, [session_id]);

  const context = await graphd.query<PrincipalContext>(`
    SELECT * FROM principal_context WHERE session_id = ?
  `, [session_id]);

  // Generate human-readable recovery prompt
  return `
# Session Recovery

You are resuming SIAS session ${session_id}.

## Session Objectives
${context.horizon_objectives.join('\n')}

## Current Focus
${context.current_focus}

## Learned Constraints (DO NOT VIOLATE)
${context.learned_constraints.map(c => `- ${c}`).join('\n')}

## Patch History (${patches.length} total)
${patches.map(p => `
### Patch ${p.patch_id}: ${p.objective}
- Status: ${p.status}
- Files: ${p.files_changed.join(', ')}
- Reasoning: ${p.reasoning}
${p.rollback_reason ? `- ROLLED BACK: ${p.rollback_reason}` : ''}
`).join('\n')}

## Key Decisions Made
${decisions.slice(-10).map(d => `
- [Iteration ${d.iteration}] ${d.decision_type}: ${d.outcome}
  Reasoning: ${d.reasoning}
`).join('\n')}

You are now at iteration ${patches.length + 1}. Continue improving the system.
  `;
}
```

---

## Summary

| Component | Location | Upgradeable? | Size |
|-----------|----------|--------------|------|
| Launcher | `sias-launcher.sh` | NO (frozen) | ~70 lines |
| Kernel | `worktrees/vN/sias-kernel/` | YES | ~650 lines |
| Agents | `worktrees/vN/packages/agent-core/` | YES | Full codebase |
| Harness | `worktrees/vN/apps/harness-daemon/` | YES | Full codebase |
| State | GraphD | N/A | Persisted externally |

**The only frozen code is ~70 lines of bash that starts/stops processes.**

Everything else improves together. When improvements hit threshold, the whole system hot-swaps to the new version while preserving semantic state.

---

## Next Steps

See `kernel_self_upgrader_part2.md` for:
- Agent configurations (Principal, OnCall, Testing)
- Structured output schemas
- Anti-flip-flop mechanisms
- Context window protection policies
- Benchmark suite design
- OnCall logging patch requests
