export type ISODateTime = string;
export type KV = Record<string, string>;

export type Environment = 'prod' | 'staging' | 'dev';

export type SessionState = 'active' | 'idle' | 'ended' | 'error';
export type RequestState = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// ============================================
// AGENT EXECUTION TYPES
// ============================================

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
export type StepPhase = 'discovery' | 'execution';

export interface PlanStep {
  stepNum: number;
  objective: string;
  status: StepStatus;
  phase: StepPhase;
  toolHint?: string;
  required: boolean;
  durationMs?: number;
  error?: string;
  /** Step numbers this step depends on (prerequisites) */
  dependsOn?: number[];
  // Nested calls for this step (assigned by mapper from flat arrays)
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

export type AgentType = 'wizard' | 'worker' | 'planner' | 'reflector' | 'synthesizer';

export interface LLMCall {
  id: string;
  agentType: AgentType;
  stepNum?: number;
  promptPreview: string;
  responsePreview: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  model: string;
  toolCallsCount: number;
  timestamp: ISODateTime;
}

// ============================================
// PLAN VERSION HISTORY
// ============================================

export interface PlanSnapshot {
  version: number;
  snapshotType: 'initial' | 'pre_patch' | 'post_patch';
  steps: PlanStep[];
  goal: string;
  trigger: string;
  timestamp: ISODateTime;
}

// ============================================
// USER INPUT (ask_user)
// ============================================

export interface UserPrompt {
  requestId: string;
  stepNum: number;
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
  contextTokens: number; // Peak prompt tokens (actual context window usage)
  outputTokens: number; // Cumulative completion tokens
  maxTokens: number;
  percentageUsed: number; // contextTokens / maxTokens
  messageCount: number;
  totalTokens: number; // Legacy: contextTokens + outputTokens
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
    steps: PlanStep[];
  };
  toolCalls: ToolCall[];
  reflection?: Reflection;
  llmCalls: LLMCall[];
  planSnapshots: PlanSnapshot[];
  userPrompts: UserPrompt[];
  contextWindow?: ContextWindowMetrics;

  // Metrics
  stepsCompleted: number;
  stepsTotal: number;
  totalToolCalls: number;
  durationMs?: number;

  // Errors
  errorMessage?: string;
}

export interface AgentRequestInsights {
  durationMs?: number;
  stepProgress: number; // 0-1
  hasErrors: boolean;
  qualityScore?: number;
}

// ============================================
// LEGACY TYPES (kept for compatibility)
// ============================================

export type LatencyPercentiles = {
  p50?: number;
  p90?: number;
  p95?: number;
  p99?: number;
};

export type RequestInsights = {
  durationMs?: number;
  latency?: LatencyPercentiles;
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
};

// Legacy HTTP request type (kept for compatibility with old data)
export type LegacyHttpRequest = {
  id: string;
  sessionId: string;
  state: RequestState;
  method: HttpMethod;
  path: string;
  createdAt: ISODateTime;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  meta: KV;
  insights: RequestInsights;
};

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
  legacyRequests: LegacyHttpRequest[];
  requests: AgentRequest[];
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

export function computeLegacyRequestInsights(r: Omit<LegacyHttpRequest, 'insights'>): RequestInsights {
  const durationMs = r.startedAt && r.endedAt ? msBetween(r.startedAt, r.endedAt) : undefined;
  return {
    durationMs,
    latency: undefined,
  };
}

export function computeAgentRequestInsights(r: AgentRequest): AgentRequestInsights {
  const durationMs = r.startedAt && r.endedAt ? msBetween(r.startedAt, r.endedAt) : undefined;
  const stepProgress = r.stepsTotal > 0 ? r.stepsCompleted / r.stepsTotal : 0;

  return {
    durationMs,
    stepProgress,
    hasErrors: r.state === 'error' || (r.plan?.steps.some(s => s.status === 'failed') ?? false),
    qualityScore: r.reflection?.qualityScore,
  };
}

export function computeSessionInsights(s: Omit<Session, 'insights'>): SessionInsights {
  const now = new Date().toISOString();
  const end = s.endedAt ?? now;
  const durationMs = msBetween(s.startedAt, end);

  const total = s.legacyRequests.length || 1;
  const errors = s.legacyRequests.filter((r) => r.state === 'error').length;
  const errorRate = clamp01(errors / total);

  const durs = s.legacyRequests
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
