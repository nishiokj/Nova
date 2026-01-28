export type ISODateTime = string;
export type KV = Record<string, string>;

export type Environment = 'prod' | 'staging' | 'dev';

export type SessionState = 'active' | 'idle' | 'ended' | 'error';

// ============================================
// AGENT EXECUTION TYPES
// ============================================

export type WorkItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'awaiting_user';

export interface WorkItem {
  workId: string;
  goal: string;
  objective: string;
  delta?: string;
  dependencies: string[];
  agent: AgentType;
  status: WorkItemStatus;
  toolHint?: string;
  targetPaths?: string[];
  durationMs?: number;
  error?: string;
  // Nested calls for this work item (assigned by mapper from flat arrays)
  toolCalls?: ToolCall[];
  llmCalls?: LLMCall[];
}

export interface ToolCall {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: string;
  success: boolean;
  durationMs: number;
  timestamp: ISODateTime;
}

// ============================================
// LLM CALL TRACKING
// ============================================

export type AgentType =
  | 'routing'
  | 'explorer'
  | 'runtime_script'
  | 'standard'
  | 'linter'
  | 'tester'
  | 'context_compactor'
  | 'debugger'
  | 'web_crawler'
  | 'orchestrator';

export interface LLMCall {
  id: string;
  agentType: AgentType;
  provider: string;
  workItemId?: string;
  promptPreview: string;
  responsePreview: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  durationMs: number;
  model: string;
  toolCallsCount: number;
  timestamp: ISODateTime;
}

// ============================================
// RUNTIME SCRIPT (replaces PlanSnapshot)
// ============================================

export interface SystemContext {
  packageManagers: string[];
  frameworks: string[];
  languages: string[];
  os: string;
  artifacts: Array<{ path: string; type: string; description?: string }>;
  patterns: string[];
}

export interface RuntimeScript {
  goal: string;
  workItems: WorkItem[];
  systemContext: SystemContext;
  createdAt: ISODateTime;
}

// ============================================
// USER INPUT (ask_user)
// ============================================

export interface UserPrompt {
  requestId: string;
  workItemId: string;
  question: string;
  options: string[];
  context: string;
  timestamp: ISODateTime;
  answered: boolean;
  answer?: string;
}

// ============================================
// CONTEXT WINDOW METRICS
// ============================================

export interface ContextWindowMetrics {
  /** Current context size - tokens in window (from last API response) */
  inputTokens: number;
  /** Peak context size - highest inputTokens seen */
  peakInputTokens: number;
  /** Completion tokens from last request */
  outputTokens: number;
  /** Cumulative completion tokens across all requests */
  totalOutputTokens: number;
  /** Maximum context window size */
  maxTokens: number;
  /** inputTokens / maxTokens - current window usage */
  percentageUsed: number;
  /** Number of messages in context */
  messageCount: number;
  /** Cached tokens from prompt (if provider supports prompt caching) */
  cachedTokens?: number;
  /** Cumulative cached tokens across all requests */
  totalCachedTokens?: number;
  timestamp: ISODateTime;
}

export type ReflectionVerdict = 'accept' | 'accept_extend' | 'redo' | 'abort_step' | 'abort_goal';

export interface Reflection {
  verdict: ReflectionVerdict;
  confidence: number;
  qualityScore: number;
  reasoning?: string;
  issues: string[];
}

// Agent execution state (renamed from TaskState for clarity)
export type AgentRequestState = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

// Represents a single user request → agent execution (renamed from AgentTask)
export interface AgentRequest {
  id: string;
  sessionId: string;
  state: AgentRequestState;
  userInput: string;
  createdAt: ISODateTime;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;

  // Execution data
  plan?: {
    goal: string;
    workItems: WorkItem[];
    systemContext?: SystemContext;
  };
  toolCalls: ToolCall[];
  reflection?: Reflection;
  llmCalls: LLMCall[];
  userPrompts: UserPrompt[];
  contextWindow?: ContextWindowMetrics;

  // Metrics
  workItemsCompleted: number;
  workItemsTotal: number;
  totalToolCalls: number;
  durationMs?: number;

  // Errors
  errorMessage?: string;
}

export interface AgentRequestInsights {
  durationMs?: number;
  workItemProgress: number; // 0-1
  hasErrors: boolean;
  qualityScore?: number;
}

// ============================================
// SESSION INSIGHTS
// ============================================

export type LatencyPercentiles = {
  p50?: number;
  p90?: number;
  p95?: number;
  p99?: number;
};

export type SessionInsights = {
  durationMs: number;
  errorRate: number;
  latency: LatencyPercentiles;
  // Request-based metrics
  requestCount: number;
  requestsRunning: number;
  requestsFailed: number;
  requestsCompleted: number;
  avgQuality?: number;
  // Token metrics
  totalInputTokens: number;
  totalOutputTokens: number;
};

export interface WatcherDecision {
  timestamp: ISODateTime;
  trigger: string;
  action: string;
  question?: string;
  answer?: string;
  rationale: string;
  workItemId?: string;
  qualityGate?: { passed: boolean; issues?: string[] };
}

export type Session = {
  id: string;
  userId: string;
  state: SessionState;
  env: Environment;
  createdAt: ISODateTime;
  startedAt: ISODateTime;
  endedAt?: ISODateTime;
  tags: string[];
  meta: KV;
  requests: AgentRequest[];
  watcherDecisions: WatcherDecision[];
  insights: SessionInsights;
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

export function msBetween(a: ISODateTime, b: ISODateTime): number {
  return new Date(b).getTime() - new Date(a).getTime();
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function computeAgentRequestInsights(r: AgentRequest): AgentRequestInsights {
  const durationMs = r.startedAt && r.endedAt ? msBetween(r.startedAt, r.endedAt) : undefined;
  const workItemProgress = r.workItemsTotal > 0 ? r.workItemsCompleted / r.workItemsTotal : 0;

  return {
    durationMs,
    workItemProgress,
    hasErrors: r.state === 'error' || (r.plan?.workItems.some(w => w.status === 'failed') ?? false),
    qualityScore: r.reflection?.qualityScore,
  };
}

export function computeSessionInsights(s: Omit<Session, 'insights'>): SessionInsights {
  const now = new Date().toISOString();
  const end = s.endedAt ?? now;
  const durationMs = msBetween(s.startedAt, end);

  const total = s.requests.length || 1;
  const errors = s.requests.filter((r) => r.state === 'error').length;
  const errorRate = clamp01(errors / total);

  const durs = s.requests
    .map((r) => (r.startedAt && r.endedAt ? msBetween(r.startedAt, r.endedAt) : undefined))
    .filter((x): x is number => typeof x === 'number')
    .sort((a, b) => a - b);

  const percentile = (p: number): number | undefined => {
    if (!durs.length) return undefined;
    const idx = Math.min(durs.length - 1, Math.max(0, Math.floor((p / 100) * durs.length)));
    return durs[idx];
  };

  // Request metrics (from agent requests)
  const requestCount = s.requests.length;
  const requestsRunning = s.requests.filter(r => r.state === 'running').length;
  const requestsFailed = s.requests.filter(r => r.state === 'error').length;
  const requestsCompleted = s.requests.filter(r => r.state === 'success').length;

  const qualityScores = s.requests
    .map(r => r.reflection?.qualityScore)
    .filter((q): q is number => typeof q === 'number');
  const avgQuality = qualityScores.length > 0
    ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
    : undefined;

  // Compute total token counts across all requests
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const r of s.requests) {
    for (const call of r.llmCalls) {
      totalInputTokens += call.promptTokens;
      totalOutputTokens += call.completionTokens;
    }
  }

  return {
    durationMs,
    errorRate,
    latency: {
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
    },
    requestCount,
    requestsRunning,
    requestsFailed,
    requestsCompleted,
    avgQuality,
    totalInputTokens,
    totalOutputTokens,
  };
}

// ============================================
// FILTER TYPES
// ============================================

export type FilterType = 'all' | 'errors' | 'running' | 'completed';

export interface FilterCounts {
  all: number;
  errors: number;
  running: number;
  completed: number;
}
