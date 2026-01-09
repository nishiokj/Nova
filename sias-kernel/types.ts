export type AgentType = 'principal' | 'oncall' | 'testing' | 'coding' | 'research';

// ============================================
// CHECKPOINTS
// ============================================

export interface PrincipalUnderstanding {
  objectives: string[];
  learnedConstraints: string[];
  currentFocus: string;
  patchSummary: string;
}

export interface CheckpointPatch {
  id: string;
  objective: string;
  reasoning: string;
  status: 'applied' | 'rolled_back';
  files: string[];
}

export interface CheckpointDecision {
  iteration: number;
  agent: string;
  decision: string;
  reasoning: string;
}

export interface DecisionEmbedding {
  decisionId: string;
  embedding: number[];
}

export interface CheckpointV1 {
  version: 1;
  session_id: string;
  iteration: number;
  timestamp: number;
  principal_understanding: PrincipalUnderstanding;
  patches: CheckpointPatch[];
  decisions: CheckpointDecision[];
  decision_embeddings?: DecisionEmbedding[];
  last_upgrade_iteration?: number;
  last_iteration_result?: IterationResult;
}

export interface CheckpointV2 extends CheckpointV1 {
  version: 2;
}

export type Checkpoint = CheckpointV1 | CheckpointV2;

// ============================================
// HEALTH
// ============================================

export interface HealthMetrics {
  process: {
    pid: number;
    uptime_ms: number;
    memory_rss_bytes: number;
    memory_heap_used_bytes: number;
    cpu_percent: number;
    restart_count: number;
    last_restart_reason?: string;
  };
  iteration: {
    current: number;
    total_completed: number;
    avg_duration_ms: number;
    last_duration_ms: number;
    consecutive_failures: number;
    consecutive_no_progress: number;
  };
  agents: Record<AgentType, {
    invocations: number;
    failures: number;
    avg_tokens_in: number;
    avg_tokens_out: number;
    avg_tool_calls: number;
    context_compactions: number;
    last_error?: string;
  }>;
  benchmark: {
    last_run_at: number;
    last_score: number;
    baseline_score: number;
    improvement_percent: number;
    regression_count: number;
    tests_passing: number;
    tests_failing: number;
  };
  worktree: {
    current_version: string;
    wip_version: string;
    total_versions: number;
    rollback_count: number;
    disk_usage_bytes: number;
  };
  persistence: {
    last_checkpoint_at: number;
    checkpoint_count: number;
    patch_count: number;
    decision_count: number;
    graphd_latency_ms: number;
    graphd_available: boolean;
  };
}

export interface AnomalyThresholds {
  memory_heap_max_bytes: number;
  cpu_percent_max: number;
  iteration_max_duration_ms: number;
  max_consecutive_failures: number;
  max_consecutive_no_progress: number;
  agent_failure_rate_max: number;
  agent_tokens_max: number;
  max_regression_percent: number;
  max_consecutive_regressions: number;
  graphd_latency_max_ms: number;
  checkpoint_staleness_max_ms: number;
}

export type AnomalyType =
  | 'memory_pressure'
  | 'cpu_pressure'
  | 'iteration_timeout'
  | 'consecutive_failures'
  | 'stalled_no_progress'
  | 'agent_failure_rate'
  | 'agent_context_explosion'
  | 'benchmark_regression'
  | 'graphd_latency'
  | 'graphd_unavailable'
  | 'checkpoint_stale';

export interface Anomaly {
  type: AnomalyType;
  severity: 'warning' | 'critical';
  detected_at: number;
  metric_value: number;
  threshold_value: number;
  context: Record<string, unknown>;
}

export type RecoveryAction =
  | { type: 'gc_force' }
  | { type: 'compact_agent_context'; agent: AgentType }
  | { type: 'checkpoint_now' }
  | { type: 'restart_soft' }
  | { type: 'restart_hard_same_version' }
  | { type: 'rollback_version' }
  | { type: 'pause_iteration_loop' }
  | { type: 'escalate_to_oncall' }
  | { type: 'halt_fatal' };

export interface RecoveryPlan {
  anomalies: Anomaly[];
  actions: RecoveryAction[];
  reasoning: string;
}

// ============================================
// BENCHMARKING
// ============================================

export type BenchmarkTier = 'smoke' | 'core' | 'full' | 'chaos';
export type BenchmarkCategory = 'correctness' | 'performance' | 'regression' | 'chaos';

export interface BenchmarkDefinition {
  id: string;
  name: string;
  tier: BenchmarkTier;
  category: BenchmarkCategory;
  timeout_ms: number;
  parallel_safe: boolean;
  requires: string[];
  weight: number;
  command: string[];
  cwd?: string;
}

export interface BenchmarkResult {
  benchmark_id: string;
  passed: boolean;
  skipped: boolean;
  duration_ms: number;
  started_at: number;
  completed_at: number;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  error?: string;
}

export interface BenchmarkSuiteResult {
  tier: BenchmarkTier;
  started_at: number;
  completed_at: number;
  total_duration_ms: number;
  results: BenchmarkResult[];
  score: number;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  baseline_score: number;
  improvement_percent: number;
  regressions: Array<{
    benchmark_id: string;
    baseline_value: number;
    current_value: number;
    regression_percent: number;
  }>;
}

// ============================================
// AGENT OUTPUTS
// ============================================

export interface PrincipalOutput {
  decision: {
    type: 'continue' | 'adjust_objective' | 'escalate' | 'approve_upgrade' | 'rollback' | 'pause';
    reasoning: string;
    confidence: number;
  };
  next_objective?: {
    goal: string;
    success_criteria: string[];
    target_files?: string[];
    constraints: string[];
    delegate_to: AgentType;
  };
  new_constraints?: Array<{
    constraint: string;
    learned_from: string;
  }>;
  related_decisions?: Array<{
    decision_id: string;
    similarity: number;
    should_reverse: boolean;
    reasoning: string;
  }>;
}

export interface OnCallOutput {
  investigation_status: 'ongoing' | 'resolved' | 'escalated' | 'blocked';
  diagnosis?: {
    root_cause: string;
    confidence: number;
    evidence: string[];
    hypothesis_history: Array<{
      hypothesis: string;
      tested: boolean;
      result?: 'confirmed' | 'rejected';
    }>;
  };
  actions?: Array<
    | { type: 'logging_patch'; target_file: string; location: string; what_to_log: string }
    | { type: 'targeted_fix'; file: string; issue: string; proposed_fix: string }
    | { type: 'escalate'; reason: string; context_for_principal: string }
    | { type: 'run_benchmark'; tier: BenchmarkTier; reason: string }
  >;
  resolution?: {
    summary: string;
    patches_applied: string[];
    verification: string;
  };
}

export interface TestingOutput {
  suite_result: BenchmarkSuiteResult;
  recommendation: 'proceed' | 'block' | 'investigate';
  reasoning: string;
  regressions?: Array<{
    benchmark_id: string;
    severity: 'minor' | 'major' | 'critical';
    details: string;
  }>;
  improvements?: Array<{
    benchmark_id: string;
    improvement_percent: number;
    details: string;
  }>;
}

// ============================================
// WORKTREES & UPGRADE
// ============================================

export type WorktreeStatus = 'active' | 'wip' | 'archived' | 'failed';

export interface WorktreeState {
  version: string;
  path: string;
  status: WorktreeStatus;
  created_at: number;
  promoted_at?: number;
  archived_at?: number;
  iterations_run: number;
  benchmark_score: number;
  failure_count: number;
}

export interface UpgradePolicy {
  benchmark_improvement_threshold: number;
  max_iterations_before_checkpoint: number;
  require_all_tests_pass: boolean;
  max_allowed_regression: number;
  min_iterations_between_upgrades: number;
}

// ============================================
// KERNEL STATE
// ============================================

export interface IterationResult {
  iteration: number;
  coding_response?: string;
  coding_success?: boolean;
  benchmark_result?: BenchmarkSuiteResult;
  testing_output?: TestingOutput;
  principal_output?: PrincipalOutput;
  oncall_output?: OnCallOutput;
  status: 'success' | 'blocked' | 'paused' | 'investigated' | 'upgraded';
}

export interface SIASState {
  sessionId: string;
  iteration: number;
  version: string;
  currentFocus: string;
  patchSummary: string;
  learnedConstraints: string[];
  horizonObjectives: string[];
  lastIterationResult?: IterationResult;
  lastUpgradeIteration: number;
}
