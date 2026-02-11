/**
 * Agentic Tasks — Type definitions
 *
 * Intent-driven, agent-executed cron jobs with semantic verification.
 * The compiled prompt is a comprehensive agent mission briefing produced
 * by the agentic-tasks skill. The VP is embedded in it as definition of done.
 */

// Keep semantic verification contracts local to core/types so core does not
// depend on plugin packages.
export interface SystemSurface {
  services: string[]
  storage: string[]
  ui_surfaces: string[]
  external_dependencies: string[]
  main_flows: string[]
}

export interface InvariantInput {
  inv_id?: string
  text: string
  context?: string
}

export interface InvariantVerdict {
  inv_id: string
  verdict: 'pass' | 'fail' | 'error' | 'skipped'
  evidence_path: string
  assumptions_used?: string[]
  counterexample?: string
  notes?: string
}

export interface VerdictReport {
  uow_id: string
  generated_at: string
  invariant_results: InvariantVerdict[]
}

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
  /** Semantic invariants — compiled into the VP by the agentic-tasks skill */
  invariants: InvariantInput[]
  /** What the agent operates on — services, storage, flows */
  systemSurface: SystemSurface
  /** Path to compiled agent prompt markdown (the mission briefing) */
  compiledPromptPath: string | null
  /** Path to compiled VerificationProgram JSON (for programmatic verdict parsing) */
  compiledVpPath: string | null
  /** Content hash for cache invalidation */
  compiledVpHash: string | null
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
  return task.status === 'active' && task.compiledPromptPath !== null
}
