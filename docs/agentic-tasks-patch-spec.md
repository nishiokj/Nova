# Agentic Tasks — Patch Spec

## Overview

Intent-driven, agent-executed cron jobs with semantic verification. Instead of brittle scripts that break when a path changes, tasks are defined as natural language intents. An agent interprets the intent against current state, and a pre-compiled verification program confirms the outcome.

### Design Principles

1. **Separate intent from execution** — the task definition is declarative ("rotate API keys older than 90 days"), the agent decides how.
2. **The queue owns the contract, the agent owns the method** — scheduling, retry, timeout, circuit breaker are infrastructure concerns. The agent is a black box that succeeds or fails.
3. **Idempotency is non-negotiable** — intents are phrased as desired end-states ("ensure X"), not imperative actions ("do X"). The verification program confirms the end-state.
4. **Compilation before execution** — all invariant compilation, question resolution, and harness generation happen at task setup time. By the time the scheduler fires, everything is pre-compiled and ready to run.
5. **Observable outcomes over deterministic steps** — the agent's steps are non-deterministic, but the verification verdicts are structured and machine-readable.

### Relationship to Existing Infrastructure

Reuses the existing stack without duplication:

| Concern | Existing Component | Reused As-Is |
|---|---|---|
| Job queue | `MicroQueue` (PostgreSQL-backed) | Yes |
| Scheduling | `Scheduler.tick()` poll loop | Extended with `tickAgenticTasks()` |
| Circuit breaker | `DerivedTask` pattern (consecutive failures, exponential backoff) | Same pattern on `agentic_tasks` |
| Retry / dead letter | `MicroQueue` retry + dead job dump | Yes |
| Verification | `semantic-compiler` pipeline | Yes (stages 0-5) |
| Human-in-the-loop | Escalation system (migration 032, cockpit API) | For question resolution at setup time |
| Rate limiting | `DerivedTaskIntegration.checkRateLimit()` | Same pattern |

---

## Architecture

### Data Flow

```
                    ┌─────────────────────────────────────────────┐
                    │              SETUP TIME                      │
                    │                                              │
 POST /agentic-tasks ──► compileVerificationProgram()             │
       (invariants,  │     ├─ strategy selection per invariant     │
        system_surface)    ├─ question generation                  │
                    │      └─ compile_status per invariant         │
                    │                                              │
                    │   All compiled? ──YES──► status: 'active'    │
                    │        │                  VP cached to disk   │
                    │        NO                                    │
                    │        │                                     │
                    │   status: 'draft'                            │
                    │   pendingQuestions stored                     │
                    │        │                                     │
                    │   POST /agentic-tasks/:id/answers            │
                    │        └─ recompile ──► 'active'             │
                    └─────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────┐
                    │              RUNTIME (cron)                   │
                    │                                              │
  Scheduler.tick() ──► findDueForExecution()                      │
                    │    (status='active' only)                    │
                    │        │                                     │
                    │   Create AgenticRun (pending)                │
                    │   Enqueue on MicroQueue                      │
                    │        │                                     │
                    │   ═══ Phase 1: Agent Execution ═══           │
                    │   Load VP from compiledVpPath                │
                    │   Spawn agent CLI subprocess                 │
                    │     intent + capability scope + budget        │
                    │   Stream output, count mutations              │
                    │   Kill on budget exceeded or timeout          │
                    │        │                                     │
                    │   ═══ Phase 2: Verification ═══              │
                    │   prepareEvidenceLayout(vp)                  │
                    │   Execute harness artifacts                   │
                    │   Collect evidence per invariant              │
                    │   emitVerdictArtifacts(vp, verdicts)         │
                    │        │                                     │
                    │   Map verdicts → run verdict                  │
                    │   Update circuit breaker                      │
                    │   Schedule next_run_at if recurring           │
                    └─────────────────────────────────────────────┘
```

### Run Lifecycle

```
pending ──► running ──► verifying ──► completed (verdict: pass|partial|fail)
                │            │
                │            └──► failed (verification error)
                └──► failed (agent error, budget exceeded, timeout)
```

- `pending` — run created, queued in MicroQueue
- `running` — agent subprocess executing
- `verifying` — agent finished, harness executing, evidence collecting
- `completed` — verdicts emitted, run has a verdict
- `failed` — unrecoverable error in either phase

---

## Types

### `packages/types/src/agentic-task.ts`

```ts
import type { InvariantInput, SystemSurface, CompilerQuestion, VerdictReport } from '@rex/semantic-compiler'

// ── Task Definition ──

export type AgenticTaskMode = 'once' | 'recurring'

export type AgenticTaskStatus = 'draft' | 'active' | 'paused' | 'disabled'

export interface CapabilityScope {
  /** Tools the agent is allowed to invoke */
  allowedTools?: string[]
  /** Tools explicitly denied */
  deniedTools?: string[]
  /** File paths the agent can read/write (globs) */
  allowedPaths?: string[]
  /** Environment variables to expose */
  env?: Record<string, string>
}

export interface MutationBudget {
  /** Max tool calls per run */
  maxToolCalls?: number
  /** Max file writes per run */
  maxFileWrites?: number
  /** Max records modified per run */
  maxRecordMutations?: number
  /** Max cost in cents per run */
  maxCostCents?: number
}

export interface AgenticTask {
  id: string
  name: string
  /** Natural language: what the agent should accomplish */
  intent: string
  /** Natural language: what success looks like (informational, not machine-parsed) */
  successCriteria: string | null
  /** Semantic invariants compiled into a VerificationProgram at setup time */
  invariants: InvariantInput[]
  /** What the agent operates on — services, storage, flows */
  systemSurface: SystemSurface
  /** Path to cached compiled VerificationProgram (null when draft) */
  compiledVpPath: string | null
  /** Content hash of invariants + systemSurface for cache invalidation */
  compiledVpHash: string | null
  /** Unresolved questions from compilation (non-empty when draft) */
  pendingQuestions: CompilerQuestion[]
  capabilityScope: CapabilityScope
  mutationBudget: MutationBudget
  mode: AgenticTaskMode
  intervalMs: number | null
  status: AgenticTaskStatus
  // Circuit breaker
  consecutiveFailures: number
  maxFailures: number
  circuitOpenUntil: string | null
  lastError: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  // Scheduling
  nextRunAt: string | null
  lastRunId: string | null
  // Execution policy
  timeoutMs: number
  idempotent: boolean
  cooldownMs: number | null
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface AgenticTaskCreateInput {
  name: string
  intent: string
  successCriteria?: string
  invariants: InvariantInput[]
  systemSurface: SystemSurface
  capabilityScope?: CapabilityScope
  mutationBudget?: MutationBudget
  mode: AgenticTaskMode
  intervalMs?: number
  timeoutMs?: number
  idempotent?: boolean
  cooldownMs?: number
  maxFailures?: number
  metadata?: Record<string, unknown>
}

export interface AgenticTaskUpdateInput {
  intent?: string
  successCriteria?: string | null
  invariants?: InvariantInput[]
  systemSurface?: SystemSurface
  capabilityScope?: CapabilityScope
  mutationBudget?: MutationBudget
  intervalMs?: number
  timeoutMs?: number
  idempotent?: boolean
  cooldownMs?: number
  maxFailures?: number
  metadata?: Record<string, unknown>
}

// ── Run ──

export type AgenticRunStatus = 'pending' | 'running' | 'verifying' | 'completed' | 'failed'

export type AgenticRunVerdict = 'pass' | 'fail' | 'partial'

export interface MutationObservation {
  toolCalls: number
  fileWrites: number
  recordMutations: number
  costCents: number
}

export interface AgenticRun {
  id: string
  taskId: string
  status: AgenticRunStatus
  // Agent execution
  agentOutput: string | null
  agentSummary: string | null
  mutationsObserved: MutationObservation | null
  budgetExceeded: boolean
  // Verification
  verdict: AgenticRunVerdict | null
  verdictReport: VerdictReport | null
  evidencePath: string | null
  // Timing
  startedAt: string | null
  agentCompletedAt: string | null
  verificationStartedAt: string | null
  completedAt: string | null
  durationMs: number | null
  error: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface AgenticRunCreateInput {
  taskId: string
  metadata?: Record<string, unknown>
}

// ── Type Guards ──

export function isAgenticRunTerminal(status: AgenticRunStatus): boolean {
  return status === 'completed' || status === 'failed'
}

export function isAgenticTaskSchedulable(task: AgenticTask): boolean {
  return task.status === 'active' && task.compiledVpPath !== null
}
```

Export from `packages/types/src/index.ts`.

---

## Migration

### `packages/agent-memory/src/db/migrations/038_agentic_tasks.sql`

```sql
-- Agentic tasks: intent-driven, agent-executed cron jobs
-- with semantic compiler verification

CREATE TABLE agentic_tasks (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL UNIQUE,
  intent               TEXT NOT NULL,
  success_criteria     TEXT,
  -- Semantic verification (compiled at setup time, not runtime)
  invariants           JSONB NOT NULL DEFAULT '[]',
  system_surface       JSONB NOT NULL DEFAULT '{}',
  compiled_vp_path     TEXT,
  compiled_vp_hash     TEXT,
  pending_questions    JSONB NOT NULL DEFAULT '[]',
  -- Execution scoping
  capability_scope     JSONB NOT NULL DEFAULT '{}',
  mutation_budget      JSONB NOT NULL DEFAULT '{}',
  -- Schedule
  mode                 TEXT NOT NULL DEFAULT 'once',
  interval_ms          BIGINT,
  status               TEXT NOT NULL DEFAULT 'draft',
  -- Circuit breaker
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  max_failures         INTEGER NOT NULL DEFAULT 3,
  circuit_open_until   TIMESTAMPTZ,
  last_error           TEXT,
  last_success_at      TIMESTAMPTZ,
  last_error_at        TIMESTAMPTZ,
  -- Scheduling
  next_run_at          TIMESTAMPTZ,
  last_run_id          TEXT,
  -- Execution policy
  timeout_ms           INTEGER NOT NULL DEFAULT 300000,
  idempotent           BOOLEAN NOT NULL DEFAULT true,
  cooldown_ms          INTEGER,
  -- Metadata
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Scheduler index: only active tasks with clear circuit
CREATE INDEX idx_agentic_tasks_due ON agentic_tasks (next_run_at)
  WHERE status = 'active'
    AND (circuit_open_until IS NULL OR circuit_open_until <= NOW());

-- Agentic runs: per-execution records
CREATE TABLE agentic_runs (
  id                       TEXT PRIMARY KEY,
  task_id                  TEXT NOT NULL REFERENCES agentic_tasks(id),
  status                   TEXT NOT NULL DEFAULT 'pending',
  -- Agent execution
  agent_output             TEXT,
  agent_summary            TEXT,
  mutations_observed       JSONB,
  budget_exceeded          BOOLEAN NOT NULL DEFAULT false,
  -- Verification
  verdict                  TEXT,
  verdict_report           JSONB,
  evidence_path            TEXT,
  -- Timing
  started_at               TIMESTAMPTZ,
  agent_completed_at       TIMESTAMPTZ,
  verification_started_at  TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  duration_ms              INTEGER,
  error                    TEXT,
  metadata                 JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agentic_runs_task ON agentic_runs (task_id, created_at DESC);

-- Hot index for preventing double-scheduling
CREATE INDEX idx_agentic_runs_active ON agentic_runs (task_id)
  WHERE status IN ('pending', 'running', 'verifying');
```

---

## Repositories

### `packages/agent-memory/src/db/repositories/agentic-task.ts`

Follows the `DerivedTask` repository pattern: `RepositoryContext` factory, row-to-domain mapping, circuit breaker methods.

```ts
export interface AgenticTaskRepository {
  create(input: AgenticTaskCreateInput): Promise<AgenticTask>
  findById(id: string): Promise<AgenticTask | null>
  findByName(name: string): Promise<AgenticTask | null>
  findAll(limit?: number): Promise<AgenticTask[]>
  update(id: string, updates: AgenticTaskUpdateInput): Promise<AgenticTask | null>
  delete(id: string): Promise<boolean>

  /** Scheduler entry point: active tasks with clear circuit and due next_run_at */
  findDueForExecution(limit?: number): Promise<AgenticTask[]>

  /** Transition draft → active after successful compilation */
  activate(id: string, vpPath: string, vpHash: string): Promise<AgenticTask | null>
  /** Store pending questions from failed compilation */
  setDraft(id: string, questions: CompilerQuestion[]): Promise<AgenticTask | null>

  /** Update compiled VP cache (on invariant/surface change) */
  updateCompiledVp(id: string, vpPath: string, vpHash: string): Promise<AgenticTask | null>

  // Schedule management
  markExecuted(id: string, runId: string): Promise<AgenticTask | null>
  updateNextRunAt(id: string, nextRunAt: Date): Promise<boolean>

  // Circuit breaker (same pattern as DerivedTask)
  recordFailure(id: string, error: string, options?: { openCircuit?: boolean }): Promise<AgenticTask | null>
  recordSuccess(id: string): Promise<AgenticTask | null>
  resetCircuit(id: string): Promise<AgenticTask | null>
  findCircuitOpen(): Promise<AgenticTask[]>

  // Status management
  pause(id: string, reason: string): Promise<AgenticTask | null>
  resume(id: string): Promise<AgenticTask | null>
}
```

**Key query — `findDueForExecution`:**

```sql
SELECT * FROM agentic_tasks
WHERE status = 'active'
  AND compiled_vp_path IS NOT NULL
  AND mode IN ('once', 'recurring')
  AND (next_run_at IS NULL OR next_run_at <= NOW())
  AND (circuit_open_until IS NULL OR circuit_open_until <= NOW())
ORDER BY next_run_at ASC NULLS FIRST
LIMIT $1
```

### `packages/agent-memory/src/db/repositories/agentic-run.ts`

```ts
export interface AgenticRunRepository {
  create(input: AgenticRunCreateInput): Promise<AgenticRun>
  findById(id: string): Promise<AgenticRun | null>
  findByTask(taskId: string, limit?: number): Promise<AgenticRun[]>
  findLastCompleted(taskId: string): Promise<AgenticRun | null>

  /** pending → running */
  start(id: string): Promise<AgenticRun | null>
  /** running → verifying (agent finished, verification starting) */
  markVerifying(id: string, agentOutput: string, summary?: string): Promise<AgenticRun | null>
  /** verifying → completed */
  complete(id: string, verdict: AgenticRunVerdict, verdictReport: VerdictReport, evidencePath: string): Promise<AgenticRun | null>
  /** any → failed */
  fail(id: string, error: string): Promise<AgenticRun | null>

  /** Record mutation counts during agent execution */
  recordMutations(id: string, mutations: MutationObservation): Promise<AgenticRun | null>
  /** Mark budget exceeded (triggers agent kill) */
  markBudgetExceeded(id: string, mutations: MutationObservation): Promise<AgenticRun | null>

  /** Prevent double-scheduling: check for pending/running/verifying runs */
  hasActiveRun(taskId: string): Promise<boolean>
}
```

---

## Runner

### `packages/agent-memory/src/agentic/runner.ts`

Two-phase execution. No compilation — the VP is pre-compiled and loaded from disk.

```ts
import type { Sql } from 'postgres'
import type { AgenticTask, AgenticRun, AgenticRunVerdict, MutationObservation } from '@rex/types'
import type { VerificationProgram, VerdictReport } from '@rex/semantic-compiler'
import { prepareEvidenceLayout, emitVerdictArtifacts } from '@rex/semantic-compiler'

export interface AgenticRunContext {
  sql: Sql
  task: AgenticTask
  run: AgenticRun
  vp: VerificationProgram
  outputDir: string
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

export interface AgenticRunResult {
  verdict: AgenticRunVerdict
  verdictReport: VerdictReport
  evidencePath: string
  agentOutput: string
  agentSummary: string | null
  mutations: MutationObservation
  budgetExceeded: boolean
}

export async function executeAgenticRun(ctx: AgenticRunContext): Promise<AgenticRunResult> {
  const { task, run, vp, outputDir, logger } = ctx

  // ═══ Phase 1: Agent Execution ═══
  //
  // Build prompt from task.intent + task.successCriteria
  // Spawn: rex run --intent <file> --capability-scope <json> --budget <json> --timeout <ms>
  //
  // The agent is a subprocess with:
  // - stdin: intent + context (piped in)
  // - stdout/stderr: streamed and captured
  // - Structured output parsing for mutation counting
  // - SIGKILL on timeout or budget exceeded
  //
  // Returns: agentOutput (raw), agentSummary (if agent emits one), mutations counted

  const agentResult = await spawnAgent(task, run, logger)

  // Budget enforcement: if exceeded, agent was already killed
  if (agentResult.budgetExceeded) {
    return {
      verdict: 'fail',
      verdictReport: { uow_id: run.id, generated_at: new Date().toISOString(), invariant_results: [] },
      evidencePath: '',
      agentOutput: agentResult.output,
      agentSummary: null,
      mutations: agentResult.mutations,
      budgetExceeded: true,
    }
  }

  // ═══ Phase 2: Verification ═══
  //
  // The VerificationProgram is pre-compiled. We just execute it.
  //
  // 1. Prepare evidence layout (per-invariant directories)
  // 2. Execute harness artifacts against current state
  // 3. Collect evidence (traces, diffs, stdout/stderr)
  // 4. Emit verdict artifacts (invariant_results.json + summary.md)

  const evidence = await prepareEvidenceLayout(vp, {
    output_dir: outputDir,
    run_id: run.id,
  })

  const invariantVerdicts = await executeHarness(vp, evidence, logger)

  const verdictReport = await emitVerdictArtifacts(vp, invariantVerdicts, {
    output_dir: outputDir,
  })

  // Map per-invariant verdicts to overall run verdict
  const verdict = deriveRunVerdict(invariantVerdicts)

  return {
    verdict,
    verdictReport,
    evidencePath: evidence.run_manifest_path,
    agentOutput: agentResult.output,
    agentSummary: agentResult.summary,
    mutations: agentResult.mutations,
    budgetExceeded: false,
  }
}

/**
 * Map individual invariant verdicts to an overall run verdict.
 *
 * - All pass → 'pass'
 * - Any required fail → 'fail'
 * - Advisory failures only → 'partial'
 */
function deriveRunVerdict(verdicts: InvariantVerdict[]): AgenticRunVerdict {
  // ...
}
```

### Agent Subprocess — `spawnAgent()`

```ts
interface AgentResult {
  output: string
  summary: string | null
  mutations: MutationObservation
  budgetExceeded: boolean
  exitCode: number
}

/**
 * Spawn the agent CLI as a subprocess.
 *
 * The agent receives:
 * - Intent and success criteria via stdin
 * - Capability scope as CLI flags (--allowed-tools, --allowed-paths, etc.)
 * - Mutation budget as CLI flags (--max-tool-calls, --max-file-writes, etc.)
 * - Timeout enforced by the runner (SIGTERM → SIGKILL)
 *
 * Mutation counting:
 * - Agent emits structured events on a side channel (fd 3 or structured log lines)
 * - Runner parses events and increments counters
 * - If any budget limit exceeded → SIGKILL immediately
 */
async function spawnAgent(
  task: AgenticTask,
  run: AgenticRun,
  logger: Logger,
): Promise<AgentResult> {
  // ...
}
```

### Harness Execution — `executeHarness()`

```ts
/**
 * Execute the pre-generated harness artifacts against current system state.
 *
 * For each invariant in the VP:
 * 1. Look up harness artifact (Playwright spec, Docker compose, trace checker)
 * 2. Execute it
 * 3. Collect results into the evidence directory
 * 4. Return per-invariant verdict
 */
async function executeHarness(
  vp: VerificationProgram,
  evidence: EvidenceLayoutResult,
  logger: Logger,
): Promise<InvariantVerdict[]> {
  // ...
}
```

---

## Integration

### `packages/agent-memory/src/agentic/integration.ts`

Bridges the scheduler, queue, and runner. Mirrors `DerivedTaskIntegration`.

```ts
export class AgenticTaskIntegration {
  constructor(private sql: Sql, private config: AgenticIntegrationConfig) {
    // Initialize repos: agenticTaskRepo, agenticRunRepo
  }

  /** Register 'agentic:run' handler on MicroQueue */
  registerHandlers(engine: SyncEngine): void {
    engine.registerDerivedJobHandler('agentic:run', async (job: Job) => {
      return this.handleRunJob(job)
    }, { timeout: this.config.maxJobRuntime })
  }

  /** Create run + enqueue. Skips if active run exists for this task. */
  async scheduleTask(engine: SyncEngine, task: AgenticTask): Promise<AgenticRun | null> {
    if (await this.runRepo.hasActiveRun(task.id)) return null

    const run = await this.runRepo.create({ taskId: task.id })
    await engine.scheduleDerivedJob('agentic:run', run.id, {
      idempotencyKey: `agentic:${task.id}:${run.id}`,
    })
    return run
  }

  /** MicroQueue handler: load task + VP, execute, record results, update circuit breaker */
  private async handleRunJob(job: Job): Promise<JobResult> {
    const { agenticRunId } = job.payload as { agenticRunId: string }

    const run = await this.runRepo.findById(agenticRunId)
    if (!run) return { success: false, error: new Error('Run not found'), noRetry: true }

    const task = await this.taskRepo.findById(run.taskId)
    if (!task) return { success: false, error: new Error('Task not found'), noRetry: true }
    if (!task.compiledVpPath) return { success: false, error: new Error('No compiled VP'), noRetry: true }

    const vp = await loadVp(task.compiledVpPath)

    try {
      await this.runRepo.start(run.id)
      const result = await executeAgenticRun({ sql: this.sql, task, run, vp, outputDir: '...', logger: '...' })

      await this.runRepo.markVerifying(run.id, result.agentOutput, result.agentSummary)
      await this.runRepo.complete(run.id, result.verdict, result.verdictReport, result.evidencePath)
      await this.taskRepo.recordSuccess(task.id)

      return { success: true }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      await this.runRepo.fail(run.id, err.message)
      await this.taskRepo.recordFailure(task.id, err.message)
      return { success: false, error: err }
    }
  }
}
```

---

## Scheduler Extension

### `packages/agent-memory/src/sync/scheduler.ts`

**Constructor** — add optional params (same pattern as derived):

```ts
constructor(
  // ... existing params ...
  private agenticTaskRepo?: AgenticTaskRepository,
  private agenticIntegration?: AgenticTaskIntegration,
)
```

**Events** — add:

```ts
| { type: 'scheduler:agentic_task_executed'; task: AgenticTask; run: AgenticRun }
| { type: 'scheduler:agentic_task_error'; task: AgenticTask; error: Error }
| { type: 'scheduler:agentic_task_disabled'; task: AgenticTask }
```

**`tick()`** — add call:

```ts
async tick(): Promise<number> {
  // ... existing sync task processing ...
  processed += await this.tickDerivedTasks()
  processed += await this.tickAgenticTasks()  // NEW
  this.emit({ type: 'scheduler:tick', processed })
  return processed
}
```

**`tickAgenticTasks()`** — mirrors `tickDerivedTasks()`:

```ts
private async tickAgenticTasks(): Promise<number> {
  if (!this.agenticTaskRepo || !this.agenticIntegration) return 0

  const tasks = await this.agenticTaskRepo.findDueForExecution(this.config.batchSize)
  let processed = 0

  for (const task of tasks) {
    try {
      const run = await this.agenticIntegration.scheduleTask(this.engine, task)
      if (!run) continue // Already has active run

      await this.agenticTaskRepo.markExecuted(task.id, run.id)

      if (task.mode === 'once') {
        await this.agenticTaskRepo.update(task.id, { status: 'disabled' })
        this.emit({ type: 'scheduler:agentic_task_disabled', task })
      } else if (task.mode === 'recurring' && task.intervalMs) {
        await this.agenticTaskRepo.updateNextRunAt(task.id, new Date(Date.now() + task.intervalMs))
      }

      this.emit({ type: 'scheduler:agentic_task_executed', task, run })
      processed++
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.emit({ type: 'scheduler:agentic_task_error', task, error: err })
    }
  }

  return processed
}
```

---

## API Routes

### `packages/agent-memory/src/daemon/routes/agentic-tasks.ts`

```
POST   /agentic-tasks                    Create task (compiles VP, returns draft or active)
GET    /agentic-tasks                    List tasks (?status=active&mode=recurring)
GET    /agentic-tasks/:id                Get task (includes pendingQuestions if draft)
PATCH  /agentic-tasks/:id                Update task (recompiles VP if invariants/surface changed)
DELETE /agentic-tasks/:id                Delete task + orphan runs

POST   /agentic-tasks/:id/answers        Resolve pending questions, recompile, promote to active
POST   /agentic-tasks/:id/trigger        Manual trigger (bypass schedule, must be active)
POST   /agentic-tasks/:id/pause          Pause (active → paused)
POST   /agentic-tasks/:id/resume         Resume (paused → active)
POST   /agentic-tasks/:id/reset-circuit  Reset circuit breaker

GET    /agentic-tasks/:id/runs           List runs for task
GET    /agentic-runs/:id                 Get run (includes verdictReport, evidencePath)
```

**`POST /agentic-tasks` handler:**

```ts
async function handleCreate(body: AgenticTaskCreateInput): Promise<Response> {
  // 1. Compile invariants
  const vp = compileVerificationProgram({
    uow_id: generateCanonicalId(),
    invariants: body.invariants,
    system_surface: body.systemSurface,
  })

  const needsAnswers = vp.invariants.some(i => i.compile_status === 'needs_user_answer')
  const questions = vp.invariants.flatMap(i => i.questions ?? [])

  // 2. Create task
  const task = await repo.create(body)

  if (needsAnswers) {
    // 3a. Draft: store questions, don't activate
    await repo.setDraft(task.id, questions)
    return { statusCode: 201, body: { ...task, status: 'draft', pendingQuestions: questions } }
  }

  // 3b. Active: cache VP, set schedule
  const vpHash = computeVpHash(body.invariants, body.systemSurface)
  const vpPath = await writeVpToDisk(vp, task.id)
  await repo.activate(task.id, vpPath, vpHash)

  // Generate harness artifacts upfront
  await generateHarnessArtifacts(vp, { output_dir: harnessDir(task.id), write_files: true })

  return { statusCode: 201, body: { ...task, status: 'active' } }
}
```

**`PATCH /agentic-tasks/:id` handler:**

```ts
async function handleUpdate(id: string, body: AgenticTaskUpdateInput): Promise<Response> {
  const task = await repo.findById(id)
  if (!task) return notFound()

  // If invariants or system_surface changed, recompile
  const invariantsChanged = body.invariants !== undefined
  const surfaceChanged = body.systemSurface !== undefined

  if (invariantsChanged || surfaceChanged) {
    const newInvariants = body.invariants ?? task.invariants
    const newSurface = body.systemSurface ?? task.systemSurface
    const newHash = computeVpHash(newInvariants, newSurface)

    if (newHash !== task.compiledVpHash) {
      const vp = compileVerificationProgram({
        uow_id: task.id,
        invariants: newInvariants,
        system_surface: newSurface,
      })

      const needsAnswers = vp.invariants.some(i => i.compile_status === 'needs_user_answer')

      if (needsAnswers) {
        const questions = vp.invariants.flatMap(i => i.questions ?? [])
        await repo.setDraft(task.id, questions)
        // Task drops to draft until questions resolved
      } else {
        const vpPath = await writeVpToDisk(vp, task.id)
        await repo.updateCompiledVp(task.id, vpPath, newHash)
        await generateHarnessArtifacts(vp, { output_dir: harnessDir(task.id), write_files: true })
      }
    }
  }

  const updated = await repo.update(id, body)
  return { body: updated }
}
```

---

## Exports

### `packages/agent-memory/src/index.ts`

Add section:

```ts
// ── Agentic Tasks ──
export { createAgenticTaskRepository, type AgenticTaskRepository } from './db/repositories/agentic-task.js'
export { createAgenticRunRepository, type AgenticRunRepository } from './db/repositories/agentic-run.js'
export { executeAgenticRun, type AgenticRunContext, type AgenticRunResult } from './agentic/runner.js'
export { AgenticTaskIntegration, type AgenticIntegrationConfig } from './agentic/integration.js'
```

### `packages/agent-memory/package.json`

Add workspace dependency:

```json
"@rex/semantic-compiler": "workspace:*"
```

---

## File Manifest

### New Files (7)

| File | Purpose |
|---|---|
| `packages/types/src/agentic-task.ts` | Type definitions |
| `packages/agent-memory/src/db/migrations/038_agentic_tasks.sql` | Schema |
| `packages/agent-memory/src/db/repositories/agentic-task.ts` | Task CRUD + scheduling + circuit breaker |
| `packages/agent-memory/src/db/repositories/agentic-run.ts` | Run lifecycle |
| `packages/agent-memory/src/agentic/runner.ts` | Two-phase execution (agent + verification) |
| `packages/agent-memory/src/agentic/integration.ts` | Queue bridge |
| `packages/agent-memory/src/daemon/routes/agentic-tasks.ts` | HTTP API |

### Modified Files (3)

| File | Change |
|---|---|
| `packages/types/src/index.ts` | Export agentic-task types |
| `packages/agent-memory/src/sync/scheduler.ts` | Add `tickAgenticTasks()`, constructor params, events |
| `packages/agent-memory/src/index.ts` | Export agentic modules |
